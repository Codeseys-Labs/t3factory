// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  FactoryReviewRound,
  type FactoryReviewFinding,
  type PullRequestDetail,
  type WorkflowRun,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import type { AgentResult } from "../../apps/server/src/workflows/WorkflowAgents.ts";
import * as WorkflowApi from "../../apps/server/src/workflows/api.ts";
import * as WorkflowForge from "../../apps/server/src/workflows/WorkflowForge.ts";
import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import type * as Ledger from "../../factory/workflows/lib/ledger.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Service = Workflows.Workflows["Service"];
type Severity = "blocker" | "major" | "minor" | "nit";
type Category = "correctness" | "scope" | "test" | "security" | "other";
type Reported = {
  readonly severity: Severity;
  readonly category: Category;
  readonly path: string;
  readonly line: number | null;
  readonly claim: string;
  readonly evidence: string;
};
type Disproof = { readonly outcome: "survived" | "refuted" | "not-run"; readonly tried: string };
type Stats = {
  readonly tier: "low" | "standard" | "high" | null;
  readonly fixRounds: number;
  readonly noOpFixRounds: number;
  readonly continued: boolean;
  readonly asks: number;
  readonly rulings: number;
  readonly mergedAnyway: boolean;
  readonly reviewRounds: number;
  readonly findingsRaised: number;
  readonly findingsRefuted: number;
};

// Imported at run time: the module is written separately, so its absence fails these cases and not
// the engine cases below; and a lib helper may read the globals a workflow file is given.
const loadLedger = (): Promise<typeof Ledger> => {
  if (!("T3" in globalThis)) {
    const { Duration, Effect: effect, Option, Schedule, Schema: schema, ...t3 } = WorkflowApi;
    Object.assign(globalThis, {
      T3: t3,
      Effect: effect,
      Schema: schema,
      Option,
      Duration,
      Schedule,
    });
  }
  return import("../../factory/workflows/lib/ledger.ts");
};

// L2, computed independently: the first 16 hex characters of SHA-256 over the UTF-8 bytes.
const sha16 = (text: string) =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
// For a finding whose path is already normal and whose claim has single spaces only.
const plainId = (reported: Reported) =>
  sha16(`${reported.path}\n${reported.category}\n${reported.claim.toLowerCase()}`);
const NOT_RUN: Disproof = { outcome: "not-run", tried: "" };
const stored = (
  reported: Reported,
  options: {
    readonly lens?: "brief" | "defects";
    readonly status?: "open" | "refuted";
    readonly disproof?: Disproof;
  } = {},
): FactoryReviewFinding => ({
  id: plainId(reported),
  lens: options.lens ?? "brief",
  ...reported,
  status: options.status ?? "open",
  disproof: options.disproof ?? NOT_RUN,
});
// L7: a finding as a question carries it.
const view = ({ severity, category, path, line, claim }: Reported) => ({
  id: plainId({ severity, category, path, line, claim, evidence: "" }),
  severity,
  category,
  path,
  line,
  claim,
});

const MAJOR: Reported = {
  severity: "major",
  category: "correctness",
  path: "src/parse.ts",
  line: 7,
  claim: "Throws on empty input.",
  evidence: 'parse("") throws',
};
const MAJOR_TEXT = '- [major] src/parse.ts:7: Throws on empty input.\n  Evidence: parse("") throws';
const BLOCKER: Reported = {
  severity: "blocker",
  category: "security",
  path: "src/auth.ts",
  line: 12,
  claim: "Skips the token check.",
  evidence: "if (token) return next();",
};
const BLOCKER_TEXT =
  "- [blocker] src/auth.ts:12: Skips the token check.\n  Evidence: if (token) return next();";
const MINOR: Reported = {
  severity: "minor",
  category: "test",
  path: "src/parse.test.ts",
  line: null,
  claim: "No test covers empty input.",
  evidence: "",
};
const MINOR_TEXT = "- [minor] src/parse.test.ts: No test covers empty input.";
const NIT: Reported = {
  severity: "nit",
  category: "other",
  path: "",
  line: null,
  claim: "The summary has a typo.",
  evidence: "",
};

it("L2 boundFinding trims path, claim and evidence before cutting them to 500, 500 and 2000", async () => {
  const { boundFinding } = await loadLedger();
  const padded = (letter: string, length: number) =>
    `${" ".repeat(10)}${letter.repeat(length)}${" ".repeat(10)}`;
  // Trimmed first, every letter stays (495 + 20 spaces); cut first, 10 spaces would take 10 letters.
  expect(
    boundFinding({
      severity: "major",
      category: "scope",
      path: padded("p", 495),
      line: 4,
      claim: padded("c", 495),
      evidence: padded("e", 1995),
    }),
  ).toMatchObject({
    severity: "major",
    category: "scope",
    path: "p".repeat(495),
    line: 4,
    claim: "c".repeat(495),
    evidence: "e".repeat(1995),
  });
  // 600 characters after trimming keep the first 500 (3000 keep the first 2000 of evidence).
  expect(
    boundFinding({
      severity: "minor",
      category: "test",
      path: `\t${"a".repeat(300)}${"b".repeat(300)}\n`,
      line: null,
      claim: ` ${"c".repeat(300)}${"d".repeat(300)} `,
      evidence: `${"x".repeat(1500)}${"y".repeat(1500)}`,
    }),
  ).toMatchObject({
    path: `${"a".repeat(300)}${"b".repeat(200)}`,
    line: null,
    claim: `${"c".repeat(300)}${"d".repeat(200)}`,
    evidence: `${"x".repeat(1500)}${"y".repeat(500)}`,
  });
  // Bounding is not the id's normalization: backslashes, a leading ./, case and runs stay.
  expect(
    boundFinding({
      severity: "nit",
      category: "other",
      path: "  .\\Src\\Part.ts\n",
      line: 0,
      claim: "\tMissing  NULL guard ",
      evidence: "   ",
    }),
  ).toMatchObject({
    path: ".\\Src\\Part.ts",
    line: 0,
    claim: "Missing  NULL guard",
    evidence: "",
  });
});

// Each `hashed` is L2's `normPath + "\n" + category + "\n" + normClaim`, written out by hand.
it.each([
  {
    label: "a plain path and claim",
    path: "src/part.ts",
    category: "correctness",
    claim: "Missing null guard",
    hashed: "src/part.ts\ncorrectness\nmissing null guard",
  },
  {
    label: "backslashes into slashes",
    path: "src\\lib\\part.ts",
    category: "test",
    claim: "No test",
    hashed: "src/lib/part.ts\ntest\nno test",
  },
  {
    label: "a leading ./ that backslashes spelled",
    path: ".\\src\\part.ts",
    category: "correctness",
    claim: "x",
    hashed: "src/part.ts\ncorrectness\nx",
  },
  {
    label: "every leading ./",
    path: "././src/part.ts",
    category: "scope",
    claim: "Out of scope",
    hashed: "src/part.ts\nscope\nout of scope",
  },
  {
    label: "surrounding whitespace before the ./",
    path: " \t./src/part.ts \n",
    category: "security",
    claim: "Leaks a token",
    hashed: "src/part.ts\nsecurity\nleaks a token",
  },
  {
    label: "an inner ./ and a leading ../, which stay",
    path: "../src/./part.ts",
    category: "other",
    claim: "y",
    hashed: "../src/./part.ts\nother\ny",
  },
  {
    label: "path letter case, which stays",
    path: "SRC/Part.ts",
    category: "other",
    claim: "z",
    hashed: "SRC/Part.ts\nother\nz",
  },
  {
    label: "case and whitespace runs in the claim",
    path: "src/part.ts",
    category: "correctness",
    claim: "  Missing\tNULL \n\n guard  ",
    hashed: "src/part.ts\ncorrectness\nmissing null guard",
  },
  {
    label: "a non-ASCII claim, hashed as UTF-8",
    path: "src/parse.ts",
    category: "correctness",
    claim: "Ändert die GRÖSSE",
    hashed: "src/parse.ts\ncorrectness\nändert die grösse",
  },
  {
    label: "an empty path",
    path: "",
    category: "other",
    claim: "The summary has a typo.",
    hashed: "\nother\nthe summary has a typo.",
  },
  {
    label: "a whitespace-only path",
    path: "   ",
    category: "other",
    claim: "The summary has a typo.",
    hashed: "\nother\nthe summary has a typo.",
  },
] as const)("L2 findingId normalizes $label", async ({ path, category, claim, hashed }) => {
  const { findingId } = await loadLedger();
  expect(findingId(path, category, claim)).toBe(sha16(hashed));
});

it("L2 findingId is 16 lowercase hex characters, and two reports of one finding share it", async () => {
  const { findingId } = await loadLedger();
  const id = findingId("src/part.ts", "correctness", "Missing null guard");
  expect(id).toMatch(/^[0-9a-f]{16}$/);
  // A repeat within a round has this id and is dropped (the high-tier engine test below).
  expect(findingId(" .\\src\\part.ts", "correctness", "  missing\nNULL   guard")).toBe(id);
  expect(findingId("src/part.ts", "test", "Missing null guard")).not.toBe(id);
  expect(findingId("src/part.ts", "correctness", "Missing null guards")).not.toBe(id);
});

const finding = (reported: Reported, status: "open" | "refuted" = "open"): FactoryReviewFinding =>
  stored(reported, {
    status,
    disproof: status === "refuted" ? { outcome: "refuted", tried: "Shown false." } : NOT_RUN,
  });

it.each([
  { label: "an empty list approves", findings: [], verdict: "approve" },
  {
    label: "open minor and nit findings approve",
    findings: [finding(MINOR), finding(NIT)],
    verdict: "approve",
  },
  { label: "an open major asks for changes", findings: [finding(MAJOR)], verdict: "changes" },
  { label: "an open blocker asks for changes", findings: [finding(BLOCKER)], verdict: "changes" },
  {
    label: "refuted blocking findings approve",
    findings: [finding(BLOCKER, "refuted"), finding(MAJOR, "refuted")],
    verdict: "approve",
  },
  {
    label: "a refuted blocker beside an open minor approves",
    findings: [finding(BLOCKER, "refuted"), finding(MINOR)],
    verdict: "approve",
  },
  {
    label: "one open blocker among refuted ones asks for changes",
    findings: [finding(MAJOR, "refuted"), finding(MINOR), finding(BLOCKER)],
    verdict: "changes",
  },
] as const)("L3 deriveVerdict: $label", async ({ findings, verdict }) => {
  const { deriveVerdict } = await loadLedger();
  expect(deriveVerdict([...findings])).toBe(verdict);
});

it("L4 renderFindings lists open findings, blocking first, in the exact line format", async () => {
  const { renderFindings } = await loadLedger();
  const findings = [
    finding({
      severity: "minor",
      category: "test",
      path: "src/a.ts",
      line: 0,
      claim: "Line zero is still a line.",
      evidence: "",
    }),
    finding({
      severity: "major",
      category: "correctness",
      path: "src/b.ts",
      line: null,
      claim: "Throws on empty input.",
      evidence: 'parse("")',
    }),
    finding(
      {
        severity: "blocker",
        category: "security",
        path: "src/c.ts",
        line: 9,
        claim: "Deletes user data.",
        evidence: "rm -rf",
      },
      "refuted",
    ),
    finding({
      severity: "nit",
      category: "other",
      path: "",
      line: 7,
      claim: "Typo in the summary.",
      evidence: "",
    }),
    finding({
      severity: "blocker",
      category: "correctness",
      path: "src/d.ts",
      line: 12,
      claim: "Null dereference.",
      evidence: "",
    }),
    finding({
      severity: "major",
      category: "scope",
      path: "",
      line: null,
      claim: "Changes an unrelated file.",
      evidence: "git diff --stat",
    }),
    finding({
      severity: "minor",
      category: "other",
      path: "src/e.ts",
      line: 3,
      claim: "Unclear name.",
      evidence: "let x",
    }),
  ];
  // blocker, major, minor, nit; reported order within a severity; the refuted blocker is left out;
  // an empty path drops `<path>:<line>: ` even with a line; a null line drops `:<line>`.
  // AMBIGUOUS: read as lines joined by "\n" with no trailing newline; the other reading ends in "\n".
  expect(renderFindings(findings)).toBe(
    [
      "- [blocker] src/d.ts:12: Null dereference.",
      "- [major] src/b.ts: Throws on empty input.",
      '  Evidence: parse("")',
      "- [major] Changes an unrelated file.",
      "  Evidence: git diff --stat",
      "- [minor] src/a.ts:0: Line zero is still a line.",
      "- [minor] src/e.ts:3: Unclear name.",
      "  Evidence: let x",
      "- [nit] Typo in the summary.",
    ].join("\n"),
  );
  // Nothing open lists nothing.
  expect(renderFindings([])).toBe("");
  expect(renderFindings([finding(BLOCKER, "refuted")])).toBe("");
});

const AT = "2026-01-01T00:00:00.000Z";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROJECT = "project-1";
const TASK_ID = "a0000000-0000-4000-8000-000000000009";
const PR_URL = "https://github.com/factory/pack/pull/40";
const PART = { title: "Guard the parser", brief: "Make the parser reject empty input." };
const MODEL = { instanceId: "codex", model: "task-model" };
const REVIEW_MODEL = { instanceId: "claude", model: "review-model" };
const PLAN_MODEL = { instanceId: "codex", model: "plan-model" };
const PERSON = { label: "Person", sessionId: "person-session" };
const RULING = "Keep the public parser API; only reject empty input.";
const KEPT_CHANGING = "The pull request's head kept changing while it was reviewed.";
const STUCK_CHOICES = ["Merge anyway", "Fix again", "Stop"];
// The pull request's head after `pushes` pushes: full 40-character SHAs.
const headAt = (pushes: number) => String(pushes + 1).repeat(40);
const HEAD_1 = headAt(0);
const HEAD_2 = headAt(1);
const HEAD_8 = "8".repeat(40);
const HEAD_9 = "9".repeat(40);
const STATS: Stats = {
  tier: "standard",
  fixRounds: 0,
  noOpFixRounds: 0,
  continued: false,
  asks: 0,
  rulings: 0,
  mergedAnyway: false,
  reviewRounds: 1,
  findingsRaised: 0,
  findingsRefuted: 0,
};

const decodePullRequest = Schema.decodeSync(WorkflowForge.PullRequest);
const pullRequest = decodePullRequest({
  provider: "github",
  host: "github.com",
  repository: "factory/pack",
  projectId: PROJECT,
  projectTitle: "Factory",
  number: 40,
  title: PART.title,
  url: PR_URL,
  author: null,
  headBranch: "factory-part",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  createdAt: AT,
  updatedAt: AT,
  viewerReviewRequested: false,
  labels: [],
});
const decodeQuestionData = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Json }));
const decodeEvidence = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      findings: Schema.Json,
      refuted: Schema.Json,
      lastReviewNotes: Schema.Json,
    }),
  }),
);
const decodeRound = Schema.decodeUnknownSync(FactoryReviewRound);

type HeadState = {
  pushes: number;
  lastRead: number;
  mergeFrom: number | undefined;
  readonly headless: boolean;
};
type Respond = (
  step: string,
  turn: AgentTurnInput,
  head: HeadState,
) => Partial<AgentResult> | undefined;

const report = (
  findings: ReadonlyArray<Reported>,
  reviewedHead: string | null = null,
): Partial<AgentResult> => ({ output: { reviewedHead, findings } });
const disproved = (
  results: ReadonlyArray<{
    readonly id: string;
    readonly outcome: "survived" | "refuted";
    readonly tried: string;
  }>,
): Partial<AgentResult> => ({ output: { results } });
// A push lands on the pull request, as a fix or a concurrent commit would.
const push = (head: HeadState) => {
  head.pushes++;
};

const scenario = (
  respond: Respond = () => undefined,
  options: {
    readonly headless?: boolean;
    readonly noPullRequest?: boolean;
    readonly mergeAfterFix?: string;
    readonly startError?: (turn: AgentTurnInput) => string | undefined;
  } = {},
) => {
  const head: HeadState = {
    pushes: 0,
    lastRead: -1,
    mergeFrom: undefined,
    headless: options.headless === true,
  };
  return {
    head,
    pullRequests: [pullRequest],
    standing: (
      address: WorkflowForge.PullRequestAddress,
      read: number,
    ): WorkflowForge.PullRequestStanding => {
      head.lastRead = read;
      return {
        url: "url" in address ? address.url : PR_URL,
        state: head.mergeFrom !== undefined && read >= head.mergeFrom ? "merged" : "open",
        checks: "passing",
        mergeability: "mergeable",
      };
    },
    readPullRequest: (_address: WorkflowForge.PullRequestAddress, detail: PullRequestDetail) =>
      Effect.succeed({ ...detail, headSha: head.headless ? undefined : headAt(head.pushes) }),
    ...(options.startError === undefined ? {} : { startError: options.startError }),
    agent: (turn: AgentTurnInput): Partial<AgentResult> => {
      const step = turn.origin.step;
      const answer = respond(step, turn, head);
      if (answer !== undefined) return answer;
      if (step === "plan") return { output: { summary: PART.title, parts: [PART] } };
      if (/^do(?:\/continue|\/again)?$/.test(step)) {
        return {
          output: {
            summary: "Guarded the parser.",
            prUrl: options.noPullRequest === true ? null : PR_URL,
          },
        };
      }
      if (step.startsWith("scope/")) return {};
      if (step.startsWith("review/")) return report([]);
      if (step.startsWith("disprove/")) return disproved([]);
      if (step.startsWith("fix/")) {
        push(head);
        // The fix-after read comes next; the pull request reads as merged from the one after it.
        if (step === options.mergeAfterFix) head.mergeFrom = head.lastRead + 2;
        return { reply: "Pushed a fix." };
      }
      throw new Error(`Unexpected agent step ${step}`);
    },
  };
};

const start = Effect.fn("factoryPack.ledger.start")(function* (
  workflows: Service,
  config: Schema.JsonObject = {},
  options: { readonly attempt?: number; readonly model?: typeof MODEL | null } = {},
) {
  const attempt = options.attempt ?? 1;
  const task = {
    number: 9,
    title: PART.title,
    description: PART.brief,
    projectId: PROJECT,
    model: options.model === undefined ? MODEL : options.model,
  };
  yield* workflows.storeSet(`factory/v1/task/${TASK_ID}`, {
    v: 1,
    id: TASK_ID,
    ...task,
    rev: 1,
    lane: "ready",
    laneSetAt: AT,
    parentId: null,
    blockedBy: [],
    assignee: null,
    source: { _tag: "local" },
    createdAt: AT,
    updatedAt: AT,
  });
  yield* workflows.storeSet("factory/v1/config", {
    v: 1,
    askPlan: false,
    askMerge: false,
    mergeNeedsPerson: false,
    ...config,
  });
  return yield* workflows.start(
    "factory-task",
    { ...task, taskId: TASK_ID, attempt, issueUrl: null },
    { idempotencyKey: `task/${TASK_ID}/a${attempt}` },
  );
});

const turnsOf = (world: World, runId: string) =>
  world.turns.filter((turn) => turn.origin.runId === runId);
const turnSteps = (world: World, runId: string) =>
  turnsOf(world, runId).map((turn) => turn.origin.step);
const turnAt = (world: World, runId: string, step: string) => {
  const turn = turnsOf(world, runId).find((entry) => entry.origin.step === step);
  if (turn === undefined) throw new Error(`Expected a ${step} turn`);
  return turn;
};
const propertiesOf = (turn: AgentTurnInput) =>
  Object.keys((turn.outputSchema?.properties ?? {}) as Record<string, unknown>).toSorted();
const CHANGES_NOTHING =
  /(?:change|edit|modify) nothing|(?:do not|don't|never|must not) (?:change|edit|modify)/i;

const stepsOf = Effect.fn("factoryPack.ledger.steps")(function* (
  workflows: Service,
  runId: string,
) {
  return (yield* workflows.get(runId)).steps;
});
const roundKey = (at: string, attempt = 1) => `factory/v1/ledger/${TASK_ID}/a${attempt}/p0/${at}`;
const roundAt = Effect.fn("factoryPack.ledger.round")(function* (
  workflows: Service,
  at: string,
  attempt = 1,
) {
  const key = roundKey(at, attempt);
  const row = (yield* workflows.stored(key)).find((entry) => entry.key === key);
  expect(row, key).toBeDefined();
  return row?.value;
});
const ledgerKeys = Effect.fn("factoryPack.ledger.keys")(function* (workflows: Service) {
  return (yield* workflows.stored(`factory/v1/ledger/${TASK_ID}/`))
    .map((row) => row.key)
    .toSorted();
});
const asked = Effect.fn("factoryPack.ledger.asked")(function* (
  world: World,
  workflows: Service,
  runId: string,
  name: string,
) {
  const question = yield* world.question(workflows, runId);
  expect(question.name).toBe(name);
  if (question.kind === "stuck") expect(question.request).toMatchObject({ choices: STUCK_CHOICES });
  return question;
});
const expectMerged = (part: WorkflowRun, done: WorkflowRun, stats: Stats) => {
  expect(part.status).toBe("completed");
  expect(part.result).toEqual({ outcome: "merged", prUrl: PR_URL, stats });
  expect(done.status).toBe("completed");
  expect(done.result).toEqual({
    parts: [{ title: PART.title, outcome: "merged", prUrl: PR_URL, stats }],
  });
};
// M1: a part that did not complete is listed with `stats: null`.
const expectStopped = (part: WorkflowRun, done: WorkflowRun, detail: string) => {
  expect(part).toMatchObject({ status: "stopped", detail, result: null });
  expect(done.status).toBe("completed");
  expect(done.result).toEqual({
    parts: [{ title: PART.title, outcome: "stopped", prUrl: null, stats: null }],
  });
};

it("L1 L3 L4 M1 a review with no findings approves, is recorded, and merges a clean part", () =>
  withWorld(
    scenario((step, _turn, head) =>
      step === "review/0" ? report([], headAt(head.pushes)) : undefined,
    ),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.clean")(function* (workflows) {
          const { runId } = yield* start(workflows, {}, { model: null });
          const child = yield* world.child(workflows, runId, 0);
          const part = yield* world.ended(workflows, child.runId, true);
          const done = yield* world.ended(workflows, runId, true);
          // r10 X9: both task workflows are version 3, and version 2 is gone.
          for (const name of ["factory-task", "factory-task-part"]) {
            expect(
              world.definitions
                .filter((definition) => definition.name === name)
                .map((definition) => definition.version),
            ).toEqual([3]);
          }
          // L4.4: a standard tier runs the brief lens only; L4.5: nothing blocks, no disprove.
          expect(turnSteps(world, child.runId)).toEqual(["do", "scope/0", "review/0"]);
          const review = turnAt(world, child.runId, "review/0");
          expect(review.prompt).toContain(`Review commit \`${HEAD_1}\`.`);
          const asking = review.prompt.trimEnd().split("\n").at(-1) ?? "";
          for (const word of ["reviewedHead", "findings"]) expect(asking).toContain(word);
          // A severity may open a sentence, so its letter case is not fixed.
          for (const severity of ["blocker", "major", "minor", "nit"]) {
            expect(asking).toMatch(new RegExp(`\\b${severity}\\b`, "i"));
          }
          expect(asking).toMatch(/\bempty\b/i);
          expect(asking).toMatch(/\bmerge/i);
          // L1: ReviewReport and nothing else.
          expect(propertiesOf(review)).toEqual(["findings", "reviewedHead"]);
          // L4.4: neither reviewModel nor the task's model is set, so no model option.
          expect(review.model).toBeUndefined();
          const steps = yield* stepsOf(workflows, child.runId);
          const names = steps.map((step) => step.name);
          expect(names).not.toContain("review/0/defects");
          expect(names).not.toContain("disprove/0");
          // L4.6 reads the head again; L4.7 records the round after it.
          expect(steps.find((step) => step.name === "head/0")?.result).toBe(HEAD_1);
          expect(steps.find((step) => step.name === "ledger/0")?.status).toBe("completed");
          expect(names.indexOf("review/0")).toBeLessThan(names.indexOf("head/0"));
          expect(names.indexOf("head/0")).toBeLessThan(names.indexOf("ledger/0"));
          expect(yield* roundAt(workflows, "0")).toMatchObject({
            at: "0",
            head: HEAD_1,
            lenses: ["brief"],
            verdict: "approve",
            findings: [],
          });
          expectMerged(part, done, STATS);
        }),
      ),
  ));

it("L3 L4 an open major blocks, its rendered notes reach the fix brief, and the next round approves", () => {
  const tried = 'parse("") threw a TypeError.';
  return withWorld(
    scenario((step) => {
      if (step === "review/0") return report([MINOR, MAJOR], HEAD_1);
      if (step === "disprove/0") {
        return disproved([{ id: plainId(MAJOR), outcome: "survived", tried }]);
      }
      if (step === "review/1") return report([], HEAD_2);
      return undefined;
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.openMajor")(function* (workflows) {
          const { runId } = yield* start(workflows, {
            fixRounds: 2,
            reviewModel: REVIEW_MODEL,
            planModel: PLAN_MODEL,
          });
          const child = yield* world.child(workflows, runId, 0);
          const part = yield* world.ended(workflows, child.runId, true);
          const done = yield* world.ended(workflows, runId, true);
          expect(turnSteps(world, child.runId)).toEqual([
            "do",
            "scope/0",
            "review/0",
            "disprove/0",
            "fix/0",
            "scope/1",
            "review/1",
          ]);
          // L4.8: notes = renderFindings: the open major first, then the open minor.
          expect(turnAt(world, child.runId, "fix/0").prompt).toContain(
            `${MAJOR_TEXT}\n${MINOR_TEXT}`,
          );
          // L4.4: reviewModel; L4.5: planModel, on a new thread.
          expect(turnAt(world, child.runId, "review/0").model).toEqual(REVIEW_MODEL);
          expect(turnAt(world, child.runId, "review/1").model).toEqual(REVIEW_MODEL);
          const disprove = turnAt(world, child.runId, "disprove/0");
          expect(disprove.model).toEqual(PLAN_MODEL);
          expect(disprove.thread).toBeUndefined();
          expect(propertiesOf(disprove)).toEqual(["results"]);
          expect(yield* roundAt(workflows, "0")).toMatchObject({
            head: HEAD_1,
            verdict: "changes",
            findings: [stored(MINOR), stored(MAJOR, { disproof: { outcome: "survived", tried } })],
          });
          expect(yield* roundAt(workflows, "1")).toMatchObject({
            head: HEAD_2,
            verdict: "approve",
            findings: [],
          });
          expectMerged(part, done, {
            ...STATS,
            fixRounds: 1,
            reviewRounds: 2,
            findingsRaised: 1,
          });
        }),
      ),
  );
});

it("L4 L7 a refuted blocker approves; the first result for an id wins and tried is cut", () =>
  withWorld(
    scenario((step) => {
      if (step === "review/0") return report([BLOCKER, MINOR], HEAD_1);
      if (step === "disprove/0") {
        return disproved([
          { id: "ffffffffffffffff", outcome: "survived", tried: "Not a finding of this round." },
          { id: plainId(BLOCKER), outcome: "refuted", tried: "R".repeat(1200) },
          { id: plainId(BLOCKER), outcome: "survived", tried: "A later answer." },
        ]);
      }
      return undefined;
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.refuted")(function* (workflows) {
          const { runId } = yield* start(workflows, { askMerge: true });
          const child = yield* world.child(workflows, runId, 0);
          const merge = yield* asked(world, workflows, child.runId, "approve-merge");
          // L7: the open findings (the minor), how many were refuted, and the rendered notes.
          expect(decodeEvidence(merge.request).data).toEqual({
            findings: [view(MINOR)],
            refuted: 1,
            lastReviewNotes: MINOR_TEXT,
          });
          expect(turnSteps(world, child.runId)).toEqual([
            "do",
            "scope/0",
            "review/0",
            "disprove/0",
          ]);
          const disprove = turnAt(world, child.runId, "disprove/0");
          // L4.5: planModel is null, so the task's model; the brief lists the blocking finding.
          expect(disprove.model).toEqual(MODEL);
          for (const part of [
            plainId(BLOCKER),
            BLOCKER.path,
            "12",
            BLOCKER.claim,
            BLOCKER.evidence,
          ]) {
            expect(disprove.prompt).toContain(part);
          }
          expect(disprove.prompt).toMatch(CHANGES_NOTHING);
          expect(disprove.prompt).toMatch(/reproduc/i);
          expect(disprove.prompt).toMatch(/counter-?example/i);
          expect(disprove.prompt).toContain("refuted");
          expect(yield* roundAt(workflows, "0")).toMatchObject({
            verdict: "approve",
            findings: [
              stored(BLOCKER, {
                status: "refuted",
                disproof: { outcome: "refuted", tried: "R".repeat(1000) },
              }),
              stored(MINOR),
            ],
          });
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" }, PERSON);
          const part = yield* world.ended(workflows, child.runId);
          const done = yield* world.ended(workflows, runId);
          expectMerged(part, done, { ...STATS, asks: 1, findingsRaised: 1, findingsRefuted: 1 });
        }),
      ),
  ));

it.each([
  { label: "omits an id", fails: false },
  { label: "does not end done", fails: true },
])("L4 L7 a disprove that $label leaves that finding open and not-run", ({ fails }) => {
  const tried = "Called it with an empty string; it threw.";
  return withWorld(
    scenario(
      (step) => {
        if (step === "review/0") return report([BLOCKER, MAJOR]);
        if (step === "disprove/0") {
          return disproved([{ id: plainId(MAJOR), outcome: "survived", tried }]);
        }
        return undefined;
      },
      {
        startError: (turn) =>
          fails && turn.origin.step === "disprove/0"
            ? "The provider could not create the thread."
            : undefined,
      },
    ),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.disproveGaps")(function* (workflows) {
          const { runId } = yield* start(workflows, { fixRounds: 0 });
          const child = yield* world.child(workflows, runId, 0);
          const stuck = yield* asked(world, workflows, child.runId, "stuck");
          // L7: both blocking findings stay open; blocking first keeps their reported order.
          expect(decodeEvidence(stuck.request).data).toEqual({
            findings: [view(BLOCKER), view(MAJOR)],
            refuted: 0,
            lastReviewNotes: `${BLOCKER_TEXT}\n${MAJOR_TEXT}`,
          });
          expect(yield* roundAt(workflows, "0")).toMatchObject({
            verdict: "changes",
            findings: [
              stored(BLOCKER),
              stored(MAJOR, { disproof: fails ? NOT_RUN : { outcome: "survived", tried } }),
            ],
          });
          const attempts = world.startAttempts.filter(
            (turn) => turn.origin.runId === child.runId && turn.origin.step === "disprove/0",
          );
          expect(attempts).toHaveLength(1);
          if (fails) {
            expect(turnSteps(world, child.runId)).not.toContain("disprove/0");
          } else {
            // L4.5: the brief lists every blocking finding with its id, path, line, claim and
            // evidence, as text or as JSON (whose quotes are escaped); the format is not fixed.
            const prompt = turnAt(world, child.runId, "disprove/0").prompt;
            for (const reported of [BLOCKER, MAJOR]) {
              for (const part of [
                plainId(reported),
                reported.path,
                String(reported.line),
                reported.claim,
                reported.evidence,
              ]) {
                const listed =
                  prompt.includes(part) || prompt.includes(JSON.stringify(part).slice(1, -1));
                expect(listed, part).toBe(true);
              }
            }
          }
          yield* workflows.answer(child.runId, "stuck", { choice: "Stop" });
          const part = yield* world.ended(workflows, child.runId);
          expectStopped(part, yield* world.ended(workflows, runId), "review did not pass");
        }),
      ),
  );
});

it("L4 no disprove step runs when no finding is blocking", () =>
  withWorld(
    scenario((step) => (step === "review/0" ? report([NIT, MINOR], HEAD_1) : undefined)),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.noBlocking")(function* (workflows) {
          const { runId } = yield* start(workflows);
          const child = yield* world.child(workflows, runId, 0);
          const part = yield* world.ended(workflows, child.runId, true);
          const done = yield* world.ended(workflows, runId, true);
          expect(turnSteps(world, child.runId)).toEqual(["do", "scope/0", "review/0"]);
          expect((yield* stepsOf(workflows, child.runId)).map((step) => step.name)).not.toContain(
            "disprove/0",
          );
          expect(yield* roundAt(workflows, "0")).toMatchObject({
            verdict: "approve",
            findings: [stored(NIT), stored(MINOR)],
          });
          // M1: open minor and nit findings are not raised blocking findings.
          expectMerged(part, done, STATS);
        }),
      ),
  ));

it("L2 L4 L5 a high tier adds the defects lens, keeps the first of each id and stores bounded findings", () => {
  const longClaim = `Overflows the buffer ${"x".repeat(600)}`;
  const brief: ReadonlyArray<Reported> = [
    {
      severity: "minor",
      category: "correctness",
      path: "src/part.ts",
      line: 3,
      claim: "Missing null guard",
      evidence: "  if (input.value) {  ",
    },
    // The first finding's id again: dropped, so its blocking severity never reaches the gate.
    {
      severity: "blocker",
      category: "correctness",
      path: ".\\src\\part.ts",
      line: 99,
      claim: "  missing   NULL guard ",
      evidence: "",
    },
    {
      severity: "nit",
      category: "other",
      path: "  docs\\guide.md ",
      line: null,
      claim: longClaim,
      evidence: "e".repeat(2500),
    },
  ];
  const defects: ReadonlyArray<Reported> = [
    // The brief lens's first id once more: the brief lens is taken first, so this is dropped.
    {
      severity: "blocker",
      category: "correctness",
      path: "./src/part.ts",
      line: 3,
      claim: "MISSING NULL GUARD",
      evidence: "",
    },
    {
      severity: "minor",
      category: "security",
      path: "src/part.ts",
      line: 8,
      claim: "Input is not escaped",
      evidence: "",
    },
    // Another category is another id.
    {
      severity: "nit",
      category: "test",
      path: "src/part.ts",
      line: 3,
      claim: "Missing null guard",
      evidence: "",
    },
  ];
  return withWorld(
    scenario((step) => {
      if (step === "review/0") return report(brief, HEAD_1);
      if (step === "review/0/defects") return report(defects);
      return undefined;
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.highTier")(function* (workflows) {
          const { runId } = yield* start(workflows, {
            protectedPaths: ["src/**"],
            reviewModel: REVIEW_MODEL,
          });
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "approve-merge");
          expect(turnSteps(world, child.runId).toSorted()).toEqual(
            ["do", "scope/0", "review/0", "review/0/defects"].toSorted(),
          );
          const lens = turnAt(world, child.runId, "review/0/defects");
          expect(lens.model).toEqual(REVIEW_MODEL);
          expect(propertiesOf(lens)).toEqual(["findings", "reviewedHead"]);
          expect(lens.prompt).toMatch(/\binput\b/i);
          expect(lens.prompt).toMatch(/\bstate\b/i);
          expect(lens.prompt).toMatch(/\bbreaks?\b/i);
          expect(lens.prompt).toMatch(/\bquot(?:e|es|ing)\b/i);
          expect(lens.prompt).toMatch(CHANGES_NOTHING);
          expect((yield* stepsOf(workflows, child.runId)).map((step) => step.name)).not.toContain(
            "disprove/0",
          );
          expect(yield* roundAt(workflows, "0")).toMatchObject({
            lenses: ["brief", "defects"],
            verdict: "approve",
            findings: [
              {
                id: sha16("src/part.ts\ncorrectness\nmissing null guard"),
                lens: "brief",
                severity: "minor",
                category: "correctness",
                path: "src/part.ts",
                line: 3,
                claim: "Missing null guard",
                evidence: "if (input.value) {",
                status: "open",
                disproof: NOT_RUN,
              },
              // Bounded, not normalized: the path keeps its backslash (L2, L5). The id is
              // computed from the first 500 characters of the claim.
              {
                id: sha16(`docs/guide.md\nother\noverflows the buffer ${"x".repeat(479)}`),
                lens: "brief",
                severity: "nit",
                category: "other",
                path: "docs\\guide.md",
                line: null,
                claim: longClaim.slice(0, 500),
                evidence: "e".repeat(2000),
                status: "open",
                disproof: NOT_RUN,
              },
              {
                id: sha16("src/part.ts\nsecurity\ninput is not escaped"),
                lens: "defects",
                severity: "minor",
                category: "security",
                path: "src/part.ts",
                line: 8,
                claim: "Input is not escaped",
                evidence: "",
                status: "open",
                disproof: NOT_RUN,
              },
              {
                id: sha16("src/part.ts\ntest\nmissing null guard"),
                lens: "defects",
                severity: "nit",
                category: "test",
                path: "src/part.ts",
                line: 3,
                claim: "Missing null guard",
                evidence: "",
                status: "open",
                disproof: NOT_RUN,
              },
            ],
          });
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" }, PERSON);
          const part = yield* world.ended(workflows, child.runId);
          const done = yield* world.ended(workflows, runId);
          expectMerged(part, done, { ...STATS, tier: "high", asks: 1 });
        }),
      ),
  );
});

it("L5 the stored round has its exact key and fields and decodes under FactoryReviewRound", () => {
  const tried = "Called parse with an empty string.";
  return withWorld(
    scenario((step) => {
      if (step === "review/0") return report([MAJOR, NIT], HEAD_1);
      if (step === "disprove/0") {
        return disproved([{ id: plainId(MAJOR), outcome: "survived", tried }]);
      }
      return undefined;
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.record")(function* (workflows) {
          const { runId } = yield* start(workflows, { fixRounds: 0 }, { attempt: 2 });
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "stuck");
          // `<part>` is the zero-based part index.
          expect(yield* ledgerKeys(workflows)).toEqual([roundKey("0", 2)]);
          const value = yield* roundAt(workflows, "0", 2);
          // AMBIGUOUS: `runId` read as the part's run, which writes the record; the other
          // reading is the task's run (`runId` below).
          expect(value).toEqual({
            v: 1,
            taskId: TASK_ID,
            attempt: 2,
            part: 0,
            at: "0",
            runId: child.runId,
            head: HEAD_1,
            lenses: ["brief"],
            verdict: "changes",
            findings: [stored(MAJOR, { disproof: { outcome: "survived", tried } }), stored(NIT)],
            createdAt: expect.stringMatching(ISO),
          });
          expect(decodeRound(value)).toEqual(value);
          yield* workflows.answer(child.runId, "stuck", { choice: "Stop" });
          yield* world.ended(workflows, runId);
        }),
      ),
  );
});

it("L5 a round whose key already holds a record writes nothing", () => {
  const earlier = {
    v: 1,
    taskId: TASK_ID,
    attempt: 1,
    part: 0,
    at: "0",
    runId: "earlier-run",
    head: null,
    lenses: ["brief"],
    verdict: "approve",
    findings: [],
    createdAt: AT,
  };
  return withWorld(
    scenario((step) => (step === "review/0" ? report([MINOR], HEAD_1) : undefined)),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.writeOnce")(function* (workflows) {
          yield* workflows.storeSet(roundKey("0"), earlier);
          const { runId } = yield* start(workflows);
          const child = yield* world.child(workflows, runId, 0);
          yield* world.ended(workflows, runId, true);
          expect(
            (yield* stepsOf(workflows, child.runId)).find((step) => step.name === "ledger/0")
              ?.status,
          ).toBe("completed");
          expect(yield* ledgerKeys(workflows)).toEqual([roundKey("0")]);
          expect(yield* roundAt(workflows, "0")).toEqual(earlier);
        }),
      ),
  );
});

it("L6 L7 a head that moves during review marks the round stale and reviews once more as 0/again", () =>
  withWorld(
    scenario((step, _turn, head) => {
      if (step === "review/0") {
        // The reviewer read HEAD_1; a push lands before the head is read again.
        push(head);
        return report([BLOCKER], HEAD_1);
      }
      if (step === "review/0/again") return report([], HEAD_2);
      return undefined;
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.staleOnce")(function* (workflows) {
          const { runId } = yield* start(workflows, { askMerge: true, fixRounds: 2 });
          const child = yield* world.child(workflows, runId, 0);
          const merge = yield* asked(world, workflows, child.runId, "approve-merge");
          // L7: evidence of the latest round that was not stale. AMBIGUOUS: renderFindings of no
          // finding read as "" (a review ran, so not null).
          expect(decodeEvidence(merge.request).data).toEqual({
            findings: [],
            refuted: 0,
            lastReviewNotes: "",
          });
          const names = (yield* stepsOf(workflows, child.runId)).map((step) => step.name);
          for (const name of [
            "checks/0/again",
            "risk-pr/0/again",
            "review/0/again",
            "head/0/again",
            "ledger/0/again",
          ]) {
            expect(names).toContain(name);
          }
          // The stale round's blocker decides nothing: no fix round, no disprove of the retry.
          expect(names.filter((name) => name.startsWith("fix"))).toEqual([]);
          expect(names).not.toContain("disprove/0/again");
          expect(turnAt(world, child.runId, "review/0/again").prompt).toContain(
            `Review commit \`${HEAD_2}\`.`,
          );
          // AMBIGUOUS: whether disprove/0 runs before the head read shows the round stale is not
          // asserted; either way the finding is stored open with no disproof run.
          expect(yield* roundAt(workflows, "0")).toMatchObject({
            at: "0",
            head: HEAD_1,
            verdict: "stale",
            findings: [stored(BLOCKER)],
          });
          expect(yield* roundAt(workflows, "0/again")).toMatchObject({
            at: "0/again",
            head: HEAD_2,
            verdict: "approve",
            findings: [],
          });
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" }, PERSON);
          const part = yield* world.ended(workflows, child.runId);
          // M1: a stale round is no review round, and its blocker is not raised.
          expect(part.result).toMatchObject({
            outcome: "merged",
            prUrl: PR_URL,
            stats: { fixRounds: 0, reviewRounds: 1, findingsRaised: 0, findingsRefuted: 0 },
          });
          yield* world.ended(workflows, runId);
        }),
      ),
  ));

it("L6 L7 two stale rounds go straight to the stuck question and spend no fix round", () =>
  withWorld(
    scenario((step, _turn, head) => {
      if (step === "review/0" || step === "review/0/again") {
        push(head);
        return report([MAJOR]);
      }
      return undefined;
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.staleTwice")(function* (workflows) {
          const { runId } = yield* start(workflows, { fixRounds: 2 });
          const child = yield* world.child(workflows, runId, 0);
          const stuck = yield* asked(world, workflows, child.runId, "stuck");
          expect(JSON.stringify(stuck.request)).toContain(KEPT_CHANGING);
          // L7: no round that was not stale, so nothing to show and no notes.
          expect(decodeEvidence(stuck.request).data).toEqual({
            findings: [],
            refuted: 0,
            lastReviewNotes: null,
          });
          expect(decodeQuestionData(stuck.request).data).toMatchObject({ fixRoundsUsed: 0 });
          expect(turnSteps(world, child.runId).filter((step) => step.startsWith("fix"))).toEqual(
            [],
          );
          expect(
            (yield* stepsOf(workflows, child.runId))
              .map((step) => step.name)
              .filter((name) => name.startsWith("fix")),
          ).toEqual([]);
          expect(yield* roundAt(workflows, "0")).toMatchObject({ head: HEAD_1, verdict: "stale" });
          expect(yield* roundAt(workflows, "0/again")).toMatchObject({
            head: HEAD_2,
            verdict: "stale",
          });
          yield* workflows.answer(child.runId, "stuck", { choice: "Stop" });
          const part = yield* world.ended(workflows, child.runId);
          expectStopped(part, yield* world.ended(workflows, runId), "review did not pass");
        }),
      ),
  ));

it("L6 L7 the stuck question after two stale rounds carries the last round that was not stale", () =>
  withWorld(
    scenario((step, _turn, head) => {
      if (step === "review/0") return report([MAJOR]);
      if (step === "review/1" || step === "review/1/again") {
        push(head);
        return report([]);
      }
      return undefined;
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.staleAfterFix")(function* (workflows) {
          const { runId } = yield* start(workflows, { fixRounds: 2 });
          const child = yield* world.child(workflows, runId, 0);
          const stuck = yield* asked(world, workflows, child.runId, "stuck");
          expect(JSON.stringify(stuck.request)).toContain(KEPT_CHANGING);
          expect(decodeEvidence(stuck.request).data).toEqual({
            findings: [view(MAJOR)],
            refuted: 0,
            lastReviewNotes: MAJOR_TEXT,
          });
          // fixRounds 2 would allow fix/1; the kept-changing failure spends none.
          expect(turnSteps(world, child.runId).filter((step) => step.startsWith("fix/"))).toEqual([
            "fix/0",
          ]);
          expect(yield* roundAt(workflows, "0")).toMatchObject({ verdict: "changes" });
          expect(yield* roundAt(workflows, "1")).toMatchObject({ verdict: "stale" });
          expect(yield* roundAt(workflows, "1/again")).toMatchObject({ verdict: "stale" });
          yield* workflows.answer(child.runId, "stuck", { choice: "Stop" });
          const part = yield* world.ended(workflows, child.runId);
          expectStopped(part, yield* world.ended(workflows, runId), "review did not pass");
        }),
      ),
  ));

it.each([
  {
    label: "a brief lens that read another head makes the round stale",
    high: false,
    headless: false,
    brief: HEAD_9,
    defects: null,
    stale: true,
  },
  {
    label: "a defects lens that read another head makes the round stale",
    high: true,
    headless: false,
    brief: HEAD_1,
    defects: HEAD_9,
    stale: true,
  },
  {
    label: "a null reviewedHead has no effect",
    high: true,
    headless: false,
    brief: null,
    defects: null,
    stale: false,
  },
  {
    label: "a null pinned head is never stale",
    high: true,
    headless: true,
    brief: HEAD_9,
    defects: HEAD_8,
    stale: false,
  },
])("L6 $label", ({ high, headless, brief, defects, stale }) =>
  withWorld(
    scenario(
      (step) => {
        if (step === "review/0") return report([], brief);
        if (step === "review/0/defects") return report([], defects);
        return undefined;
      },
      { headless },
    ),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.reviewedHead")(function* (workflows) {
          // A missing head is a high tier on its own (revision 8's risk rules).
          const { runId } = yield* start(workflows, {
            askMerge: true,
            protectedPaths: high && !headless ? ["src/**"] : [],
          });
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "approve-merge");
          const lenses = high ? ["brief", "defects"] : ["brief"];
          const names = (yield* stepsOf(workflows, child.runId)).map((step) => step.name);
          if (stale) {
            for (const name of [
              "checks/0/again",
              "risk-pr/0/again",
              "review/0/again",
              "head/0/again",
              "ledger/0/again",
              ...(high ? ["review/0/again/defects"] : []),
            ]) {
              expect(names).toContain(name);
            }
            expect(yield* roundAt(workflows, "0")).toMatchObject({
              head: HEAD_1,
              lenses,
              verdict: "stale",
            });
            expect(yield* roundAt(workflows, "0/again")).toMatchObject({
              head: HEAD_1,
              lenses,
              verdict: "approve",
            });
          } else {
            expect(names.filter((name) => name.includes("/again"))).toEqual([]);
            expect(yield* ledgerKeys(workflows)).toEqual([roundKey("0")]);
            expect(yield* roundAt(workflows, "0")).toMatchObject({
              head: headless ? null : HEAD_1,
              lenses,
              verdict: "approve",
            });
          }
          // L4.4: the commit is named only when the pinned head is not null.
          const prompt = turnAt(world, child.runId, "review/0").prompt;
          if (headless) expect(prompt).not.toContain("Review commit");
          else expect(prompt).toContain(`Review commit \`${HEAD_1}\`.`);
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Hold" }, PERSON);
          const part = yield* world.ended(workflows, child.runId);
          expectStopped(part, yield* world.ended(workflows, runId), "merge held");
        }),
      ),
  ),
);

it("L7 the stuck question lists at most 20 open findings, blocking first", () => {
  const minors: ReadonlyArray<Reported> = Array.from({ length: 20 }, (_, index) => ({
    severity: "minor",
    category: "test",
    path: "src/part.test.ts",
    line: index + 1,
    claim: `Case ${index} is untested.`,
    evidence: "",
  }));
  const majors: ReadonlyArray<Reported> = Array.from({ length: 3 }, (_, index) => ({
    severity: "major",
    category: "correctness",
    path: "src/part.ts",
    line: 40 + index,
    claim: `Branch ${index} returns early.`,
    evidence: `if (flag${index}) return;`,
  }));
  return withWorld(
    scenario((step) => {
      if (step === "review/0") return report(minors);
      if (step === "review/0/defects") return report(majors);
      return undefined;
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.cap")(function* (workflows) {
          const { runId } = yield* start(workflows, { fixRounds: 0, protectedPaths: ["src/**"] });
          const child = yield* world.child(workflows, runId, 0);
          const stuck = yield* asked(world, workflows, child.runId, "stuck");
          // AMBIGUOUS: the cap read as applied after ordering blocking first; the other reading
          // (the first 20 kept, then ordered) would show the 20 minors only.
          expect(decodeEvidence(stuck.request).data).toEqual({
            findings: [...majors.map(view), ...minors.slice(0, 17).map(view)],
            refuted: 0,
            // renderFindings itself is not capped.
            lastReviewNotes: [
              ...majors.map(
                (major) =>
                  `- [major] src/part.ts:${major.line}: ${major.claim}\n  Evidence: ${major.evidence}`,
              ),
              ...minors.map((minor) => `- [minor] src/part.test.ts:${minor.line}: ${minor.claim}`),
            ].join("\n"),
          });
          expect(yield* roundAt(workflows, "0")).toMatchObject({
            lenses: ["brief", "defects"],
            verdict: "changes",
            findings: [
              ...minors.map((minor) => stored(minor)),
              ...majors.map((major) => stored(major, { lens: "defects" })),
            ],
          });
          yield* workflows.answer(child.runId, "stuck", { choice: "Stop" });
          yield* world.ended(workflows, runId);
        }),
      ),
  );
});

it("M1 an accepted part whose do had to start again reports its statistics", () =>
  withWorld(
    scenario(undefined, {
      noPullRequest: true,
      startError: (turn) =>
        turn.origin.step === "do" ? "The provider could not create the thread." : undefined,
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.acceptedStats")(function* (workflows) {
          const { runId } = yield* start(workflows);
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "accept");
          yield* workflows.answer(child.runId, "accept", { choice: "Accept" });
          const part = yield* world.ended(workflows, child.runId);
          const done = yield* world.ended(workflows, runId);
          expect(turnSteps(world, child.runId)).toEqual(["do/again"]);
          const stats: Stats = {
            ...STATS,
            tier: null,
            continued: true,
            asks: 1,
            reviewRounds: 0,
          };
          expect(part.result).toEqual({ outcome: "accepted", prUrl: null, stats });
          expect(done.result).toEqual({
            parts: [{ title: PART.title, outcome: "accepted", prUrl: null, stats }],
          });
          expect(yield* ledgerKeys(workflows)).toEqual([]);
        }),
      ),
  ));

it("M1 a person-only merge gate counts as one ask", () =>
  withWorld(scenario(), (world) =>
    world.server(
      Effect.fn("factoryPack.ledger.gateStats")(function* (workflows) {
        const { runId } = yield* start(workflows, { askMerge: true, mergeNeedsPerson: true });
        const child = yield* world.child(workflows, runId, 0);
        yield* asked(world, workflows, child.runId, "approve-merge");
        yield* workflows.answer(
          child.runId,
          "approve-merge",
          { choice: "Merge" },
          { label: "Agent without a session" },
        );
        yield* asked(world, workflows, child.runId, "approve-merge/person");
        yield* workflows.answer(child.runId, "approve-merge/person", { choice: "Merge" }, PERSON);
        const part = yield* world.ended(workflows, child.runId);
        expectMerged(part, yield* world.ended(workflows, runId), { ...STATS, asks: 1 });
      }),
    ),
  ));

it("M1 a part with a fix round, a ruling and Merge anyway reports its statistics", () =>
  withWorld(
    scenario((step) => {
      if (step === "review/0") return report([BLOCKER, MAJOR]);
      if (step === "disprove/0") {
        return disproved([
          { id: plainId(BLOCKER), outcome: "refuted", tried: "The middleware checks first." },
          { id: plainId(MAJOR), outcome: "survived", tried: "It threw." },
        ]);
      }
      if (step === "review/1" || step === "review/x1") return report([MAJOR]);
      return undefined;
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.ruledStats")(function* (workflows) {
          const { runId } = yield* start(workflows, { fixRounds: 1, protectedPaths: ["src/**"] });
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "stuck");
          yield* workflows.answer(child.runId, "stuck", { choice: "Fix again", reason: RULING });
          yield* asked(world, workflows, child.runId, "stuck/x1");
          yield* workflows.answer(child.runId, "stuck/x1", { choice: "Merge anyway" });
          // A high tier always asks a person before merging.
          yield* asked(world, workflows, child.runId, "approve-merge");
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" }, PERSON);
          const part = yield* world.ended(workflows, child.runId);
          expect(turnSteps(world, child.runId).filter((step) => step.startsWith("fix/"))).toEqual([
            "fix/0",
            "fix/x1",
          ]);
          // Rounds 0, 1 and x1 each wrote a record that is not stale; blocking findings per
          // round: 2 + 1 + 1, of which the round 0 blocker was refuted.
          // AMBIGUOUS: fixRounds read as every fix round that moved the head, fix/x1 included
          // (2); the other reading counts only the base rounds (1).
          expectMerged(part, yield* world.ended(workflows, runId), {
            tier: "high",
            fixRounds: 2,
            noOpFixRounds: 0,
            continued: false,
            asks: 3,
            rulings: 1,
            mergedAnyway: true,
            reviewRounds: 3,
            findingsRaised: 4,
            findingsRefuted: 1,
          });
        }),
      ),
  ));

it("M1 a fix round that adds no commit is a no-op fix round", () =>
  withWorld(
    scenario((step) => {
      if (step === "review/0") return report([MAJOR]);
      if (step === "fix/0") return { reply: "Nothing needed changing." };
      return undefined;
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.noOpStats")(function* (workflows) {
          const { runId } = yield* start(workflows, { fixRounds: 1 });
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "stuck");
          yield* workflows.answer(child.runId, "stuck", { choice: "Merge anyway" });
          const part = yield* world.ended(workflows, child.runId);
          expectMerged(part, yield* world.ended(workflows, runId), {
            ...STATS,
            noOpFixRounds: 1,
            asks: 1,
            mergedAnyway: true,
            findingsRaised: 1,
          });
        }),
      ),
  ));

it("M1 a pull request found merged after a ruled fix keeps the tier so far", () =>
  withWorld(
    scenario((step) => (step === "review/0" ? report([MAJOR]) : undefined), {
      mergeAfterFix: "fix/x1",
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.ledger.mergedEarlierStats")(function* (workflows) {
          const { runId } = yield* start(workflows, { fixRounds: 0 });
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "stuck");
          yield* workflows.answer(child.runId, "stuck", { choice: "Fix again", reason: RULING });
          const part = yield* world.ended(workflows, child.runId);
          // AMBIGUOUS: fixRounds counts fix/x1, which moved the head (see the test above).
          expectMerged(part, yield* world.ended(workflows, runId), {
            ...STATS,
            fixRounds: 1,
            asks: 1,
            rulings: 1,
            findingsRaised: 1,
          });
        }),
      ),
  ));
