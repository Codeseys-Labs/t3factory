import { it } from "@effect/vitest";
import type { PullRequestDetail } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import type { AgentResult } from "../../apps/server/src/workflows/WorkflowAgents.ts";
import * as WorkflowForge from "../../apps/server/src/workflows/WorkflowForge.ts";
import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Service = Workflows.Workflows["Service"];
const AT = "2026-01-01T00:00:00.000Z";
const PROJECT = "project-1";
const TASK_ID = "90000000-0000-4000-8000-000000000001";
const PR_URL = "https://github.com/factory/pack/pull/30";
const OPEN_URL = "https://github.com/factory/pack/pull/21";
const CLOSED_URL = "https://github.com/factory/pack/pull/22";
const MERGED_URL = "https://github.com/factory/pack/pull/23";
const CURRENT_URL = "https://github.com/factory/pack/pull/24";
const HEAD = "aaa111";
const FIXED_HEAD = "bbb222";
const PROTECTED = "apps/server/src/ws.ts";
const PART = { title: "Implement the change", brief: "Handle the requested input." };
const MERGE_ACT = [{ project: PROJECT, url: PR_URL }, "merge", { mergeMethod: "squash" }];
const decodePullRequest = Schema.decodeSync(WorkflowForge.PullRequest);
const pullRequest = decodePullRequest({
  provider: "github",
  host: "github.com",
  repository: "factory/pack",
  projectId: PROJECT,
  projectTitle: "Factory",
  number: 30,
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

const script = ({
  file = "src/part.ts",
  reportedHead = HEAD,
  changedFiles = 1,
  fix = false,
} = {}) => {
  let headSha = HEAD;
  return {
    pullRequests: [pullRequest],
    standing: (address: WorkflowForge.PullRequestAddress): WorkflowForge.PullRequestStanding => {
      if (!("url" in address)) throw new Error("Expected the pull request URL");
      const { url } = address;
      return {
        url,
        state: url === CLOSED_URL ? "closed" : url === MERGED_URL ? "merged" : "open",
        checks: "passing",
        mergeability: "mergeable",
      };
    },
    readPullRequest: (_address: WorkflowForge.PullRequestAddress, detail: PullRequestDetail) =>
      Effect.succeed({ ...detail, headSha, changedFiles }),
    agent: ({ origin }: AgentTurnInput): Partial<AgentResult> => {
      switch (origin.step) {
        case "plan":
          return { output: { summary: PART.title, parts: [PART] } };
        case "do":
          return { output: { summary: PART.title, prUrl: PR_URL } };
        case "scope/0":
          return { output: { report: { headSha: reportedHead, files: [file] } } };
        // r9 L1: a reviewer reports its head and findings; an open major blocks (L3).
        case "review/0":
          return {
            output: {
              reviewedHead: headSha,
              findings: fix
                ? [
                    {
                      severity: "major",
                      category: "correctness",
                      path: file,
                      line: 1,
                      claim: "Check the example.",
                      evidence: "",
                    },
                  ]
                : [],
            },
          };
        // r9 L4: a high tier adds the defects lens.
        case "review/0/defects":
        case "review/1/defects":
          return { output: { reviewedHead: headSha, findings: [] } };
        // r9 L4: the blocking finding is not refuted, so it still blocks.
        case "disprove/0":
          return { output: { results: [] } };
        case "fix/0":
          headSha = FIXED_HEAD;
          return { reply: "Replaced the implementation with a documentation change." };
        case "scope/1":
          return { output: { report: { headSha: FIXED_HEAD, files: ["README.md"] } } };
        case "review/1":
          return { output: { reviewedHead: headSha, findings: [] } };
        default:
          throw new Error(`Unexpected agent step ${origin.step}`);
      }
    },
  };
};

const start = Effect.fn("factoryPack.riskRouting.start")(function* (
  workflows: Service,
  attempt = 1,
  config: Schema.JsonObject = {},
) {
  const task = {
    number: 1,
    title: PART.title,
    description: PART.brief,
    projectId: PROJECT,
    model: null,
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

const approveHighRisk = Effect.fn("factoryPack.riskRouting.approveHighRisk")(function* (
  world: World,
  workflows: Service,
  runId: string,
) {
  const child = yield* world.child(workflows, runId, 0);
  const first = yield* world.question(workflows, child.runId);
  expect(first).toMatchObject({
    name: "approve-merge",
    request: {
      data: { riskTier: "high", riskReasons: expect.arrayContaining([expect.any(String)]) },
    },
  });
  expect(world.acts).toEqual([]);
  yield* workflows.answer(child.runId, first.name, { choice: "Merge" });
  const person = yield* world.question(workflows, child.runId);
  expect(person.name).toBe("approve-merge/person");
  expect(world.acts).toEqual([]);
  yield* workflows.answer(
    child.runId,
    person.name,
    { choice: "Merge" },
    { label: "Reviewer", sessionId: "trusted-session" },
  );
  expect(yield* world.ended(workflows, runId, true)).toMatchObject({
    status: "completed",
    result: { parts: [{ outcome: "merged", prUrl: PR_URL }] },
  });
  expect(world.acts).toEqual([MERGE_ACT]);
  return child.runId;
});

it.effect.each([
  { reason: "a built-in protected path", file: PROTECTED },
  { reason: "a configured protected path", file: "private/a.ts" },
  { reason: "a scope SHA mismatch", file: "src/a.ts", reportedHead: "wrong-head" },
  { reason: "a scope count mismatch", file: "src/a.ts", changedFiles: 2 },
])("$reason requires a person even with automatic merge enabled", (scenario) =>
  Effect.promise(() =>
    withWorld(script(scenario), (world) =>
      world.server(
        Effect.fn("factoryPack.riskRouting.high")(function* (workflows) {
          const { runId } = yield* start(workflows, 1, { protectedPaths: ["private/**"] });
          yield* approveHighRisk(world, workflows, runId);
        }),
      ),
    ),
  ),
);

it.effect(
  "a protected change still requires a person after a fix touches only a low-risk path",
  () =>
    Effect.promise(() =>
      withWorld(script({ file: PROTECTED, fix: true }), (world) =>
        world.server(
          Effect.fn("factoryPack.riskRouting.ratchet")(function* (workflows) {
            const { runId } = yield* start(workflows, 1, {
              lowRiskPaths: ["README.md"],
              fixRounds: 2,
            });
            const childId = yield* approveHighRisk(world, workflows, runId);
            const turns = world.turns.filter((turn) => turn.origin.runId === childId);
            // r9 L4: the high tier runs the defects lens each round, and the blocking
            // finding of round 0 is put to the disprove step.
            expect(turns.map((turn) => turn.origin.step)).toEqual([
              "do",
              "scope/0",
              "review/0",
              "review/0/defects",
              "disprove/0",
              "fix/0",
              "scope/1",
              "review/1",
              "review/1/defects",
            ]);
          }),
        ),
      ),
    ),
);

it.effect("a standard change with passing checks merges without questions", () =>
  Effect.promise(() =>
    withWorld(script(), (world) =>
      world.server(
        Effect.fn("factoryPack.riskRouting.standard")(function* (workflows) {
          const { runId } = yield* start(workflows);
          expect(yield* world.ended(workflows, runId, true)).toMatchObject({
            status: "completed",
            result: { parts: [{ outcome: "merged", prUrl: PR_URL }] },
          });
          expect(world.questions).toEqual([]);
          expect(world.acts).toEqual([MERGE_ACT]);
        }),
      ),
    ),
  ),
);

it.effect(
  "a second attempt's worker brief names only open pull requests from earlier attempts",
  () =>
    Effect.promise(() =>
      withWorld(script(), (world) =>
        world.server(
          Effect.fn("factoryPack.riskRouting.prContinuity")(function* (workflows) {
            for (const { n, runId, prUrls } of [
              { n: 1, runId: "previous-run", prUrls: [OPEN_URL, CLOSED_URL, MERGED_URL] },
              { n: 2, runId: null, prUrls: [CURRENT_URL] },
            ]) {
              const attemptKey = `factory/v1/attempt/${TASK_ID}/${String(n).padStart(4, "0")}`;
              yield* workflows.storeSet(attemptKey, {
                v: 1,
                taskId: TASK_ID,
                n,
                key: `task/${TASK_ID}/a${n}`,
                workflow: "factory-task",
                runId,
                requestedBy: "test",
                startedAt: AT,
                prUrls,
              });
            }
            const { runId } = yield* start(workflows, 2);
            yield* world.ended(workflows, runId, true);
            const child = yield* world.child(workflows, runId, 0);
            const work = world.turns.find(
              ({ origin }) => origin.runId === child.runId && origin.step === "do",
            );
            expect(work?.prompt).toContain(OPEN_URL);
            expect(work?.prompt).not.toContain(CLOSED_URL);
            expect(work?.prompt).not.toContain(MERGED_URL);
            expect(work?.prompt).not.toContain(CURRENT_URL);
            const [current] = yield* workflows.stored(`factory/v1/attempt/${TASK_ID}/0002`);
            expect(current?.value).toMatchObject({
              prUrls: expect.arrayContaining([CURRENT_URL, PR_URL]),
            });
          }),
        ),
      ),
    ),
);
