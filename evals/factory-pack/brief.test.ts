// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FactoryArtifact, FactoryReceipt } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import type { AgentResult } from "../../apps/server/src/workflows/WorkflowAgents.ts";
import * as WorkflowForge from "../../apps/server/src/workflows/WorkflowForge.ts";
import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Service = Workflows.Workflows["Service"];
const TASK_ID = "20000000-0000-4000-8000-000000000001";
const PROJECT = "project-1";
const AT = "2026-01-01T00:00:00.000Z";
const ISSUE_URL = "https://github.com/acme/repo/issues/191";
const ISSUE_BODY = "The issue asks for a one page brief.";
const VIEWER = "factory-bot";
const MODEL = { instanceId: "codex", model: "test-worker" };
const CRITIC = { instanceId: "codex", model: "test-critic" };
const SESSION = { label: "Person", sessionId: "trusted-session" };
const TITLE = "Brief the findings";
const DESCRIPTION = "Summarise what we learned.";
const SUMMARY = "A short brief on the findings.";
const NOTES = "Two claims lack a source.";
const REASON = "Tighten the opening paragraph.";
const DRAFT = "# Findings\n\nThe first draft of the brief.\n";
const REVISED = "# Findings\n\nThe revised brief, with a tighter opening.\n";
const TAMPERED = "# Findings\n\nSomeone rewrote this after review.\n";

const sha256Of = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;
const DRAFT_SHA = sha256Of(DRAFT);
const REVISED_SHA = sha256Of(REVISED);
const TAMPERED_SHA = sha256Of(TAMPERED);
const MARKER = `<!-- t3factory:delivery task=${TASK_ID} attempt=1 sha256=${DRAFT_SHA} -->`;

const decodeArtifact = Schema.decodeUnknownEffect(FactoryArtifact);
const decodeReceipt = Schema.decodeUnknownEffect(FactoryReceipt);
const decodeIssueDetail = Schema.decodeSync(WorkflowForge.IssueDetail);

const TASK = {
  v: 1,
  id: TASK_ID,
  number: 9,
  rev: 1,
  projectId: PROJECT,
  kind: "knowledge",
  title: TITLE,
  description: DESCRIPTION,
  lane: "ready",
  laneSetAt: AT,
  parentId: null,
  blockedBy: [],
  assignee: null,
  model: MODEL,
  source: { _tag: "local" },
  createdAt: AT,
  updatedAt: AT,
};

interface StoredComment {
  readonly id: string;
  readonly author: { readonly login: string; readonly name: null; readonly avatarUrl: null } | null;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
}

interface Conversation {
  comments: Array<StoredComment>;
  cursor: string | null;
}

const commentBy = (login: string, id: string, body: string, createdAt: string): StoredComment => ({
  id,
  author: { login, name: null, avatarUrl: null },
  body,
  createdAt,
  url: `${ISSUE_URL}#issuecomment-${id}`,
});

const issueDetail = (conversation: Conversation) =>
  decodeIssueDetail({
    tracker: "github",
    host: "github.com",
    scope: "acme/repo",
    key: "191",
    displayKey: "#191",
    title: TITLE,
    url: ISSUE_URL,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: AT,
    updatedAt: AT,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: conversation.comments.length,
    projectId: PROJECT,
    projectTitle: "Factory",
    writable: true,
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: false,
    },
    viewerPermissions: {
      setState: true,
      comment: true,
      edit: true,
      labels: true,
      assignees: true,
    },
    states: [],
    viewer: VIEWER,
    body: ISSUE_BODY,
    comments: conversation.comments,
    commentsCursor: conversation.cursor,
    events: [],
    linkedPullRequests: [],
  });

interface BriefOptions {
  readonly critiques?: ReadonlyArray<"pass" | "revise">;
}

interface Brief {
  readonly dir: string;
  readonly file: string;
  readonly conversation: Conversation;
  readonly posted: Array<string>;
  readonly script: {
    readonly agent: (turn: AgentTurnInput) => Partial<AgentResult>;
    readonly standing: () => WorkflowForge.PullRequestStanding;
    readonly readIssue: () => Effect.Effect<WorkflowForge.IssueDetail>;
    readonly commentIssue: (issue: WorkflowForge.IssueAddress, body: string) => Effect.Effect<void>;
  };
}

// The scripted agents write the brief file themselves, as a real draft agent would, and the
// scripted tracker keeps the comments the brief posts so a later read sees them.
const makeBrief = (dir: string, options: BriefOptions): Brief => {
  const file = NodePath.join(dir, "brief.md");
  const conversation: Conversation = { comments: [], cursor: null };
  const posted: Array<string> = [];
  const script = {
    agent: (turn: AgentTurnInput): Partial<AgentResult> => {
      const step = turn.origin.step;
      if (step === "draft") {
        NodeFS.writeFileSync(file, DRAFT);
        return { output: { path: file, summary: SUMMARY, citations: [] } };
      }
      const critique = /^critique\/(\d+)$/.exec(step);
      if (critique !== null) {
        const verdict = options.critiques?.[Number(critique[1])] ?? "pass";
        return { output: { verdict, unsupported: [], notes: NOTES } };
      }
      if (/^revise\/x?\d+$/.test(step)) {
        NodeFS.writeFileSync(file, REVISED);
        return {
          reply: "Revised the brief.",
          output: { path: file, summary: SUMMARY, citations: [] },
        };
      }
      throw new Error(`Unexpected agent step ${step}`);
    },
    standing: (): WorkflowForge.PullRequestStanding => {
      throw new Error("A brief reads no pull request.");
    },
    readIssue: () => Effect.sync(() => issueDetail(conversation)),
    commentIssue: (_issue: WorkflowForge.IssueAddress, body: string) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        posted.push(body);
        conversation.comments.push(
          commentBy(VIEWER, `comment-${conversation.comments.length + 1}`, body, at),
        );
      }),
  };
  return { dir, file, conversation, posted, script };
};

const withBrief = <A, E>(
  options: BriefOptions,
  check: (brief: Brief, world: World, workflows: Service) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-brief-"))),
    (dir) => {
      const brief = makeBrief(dir, options);
      return Effect.promise(() =>
        withWorld(brief.script, (world) =>
          world.server((workflows) => check(brief, world, workflows)),
        ),
      );
    },
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const begin = Effect.fn("factoryPack.test.begin")(function* (
  workflows: Service,
  brief: Brief,
  options: {
    readonly config?: Readonly<Record<string, Schema.Json>>;
    readonly issueUrl?: string;
  } = {},
) {
  yield* workflows.storeSet("factory/v1/seq", TASK.number);
  yield* workflows.storeSet(`factory/v1/task/${TASK_ID}`, TASK);
  yield* workflows.storeSet(`factory/v1/target/${PROJECT}`, {
    v: 1,
    projectId: PROJECT,
    workspace: "root",
    workspaceRoot: brief.dir,
    problem: null,
    checkedAt: AT,
  });
  if (options.config !== undefined) {
    yield* workflows.storeSet("factory/v1/config", { v: 1, ...options.config });
  }
  return yield* workflows.start(
    "factory-brief",
    {
      taskId: TASK_ID,
      number: TASK.number,
      attempt: 1,
      title: TITLE,
      description: DESCRIPTION,
      projectId: PROJECT,
      model: MODEL,
      issueUrl: options.issueUrl ?? null,
    },
    { idempotencyKey: `task/${TASK_ID}/a1` },
  );
});

const askAccept = Effect.fn("factoryPack.test.askAccept")(function* (
  world: World,
  workflows: Service,
  runId: string,
  name = "accept",
) {
  const question = yield* world.question(workflows, runId);
  expect(question.name).toBe(name);
  expect(question.request).toMatchObject({
    choices: ["Accept", "Revise", "Drop"],
    choiceDetails: expect.arrayContaining([
      expect.objectContaining({ value: "Revise", requireReason: true }),
    ]),
  });
  return question;
});

const receiptsOf = Effect.fn("factoryPack.test.receipts")(function* (workflows: Service) {
  const rows = yield* workflows.stored("factory/v1/receipt/");
  return yield* Effect.forEach(rows, (row) => decodeReceipt(row.value).pipe(Effect.orDie));
});

const artifactsOf = Effect.fn("factoryPack.test.artifacts")(function* (workflows: Service) {
  const rows = yield* workflows.stored("factory/v1/artifact/");
  return yield* Effect.forEach(rows, (row) => decodeArtifact(row.value).pipe(Effect.orDie));
});

const kindsOf = (entries: ReadonlyArray<{ readonly kind: string }>) =>
  entries.map((entry) => entry.kind).toSorted();

const noteCount = Effect.fn("factoryPack.test.noteCount")(function* (workflows: Service) {
  return (yield* workflows.stored(`factory/v1/note/${TASK_ID}/`)).length;
});

effectIt.effect("an accepted brief is stored, accepted by a person, and finishes with a note", () =>
  withBrief(
    {},
    Effect.fn("factoryPack.test.briefHappy")(function* (brief, world, workflows) {
      const { runId } = yield* begin(workflows, brief);
      const question = yield* askAccept(world, workflows, runId);
      expect(question.request).toMatchObject({
        data: { path: brief.file, sha256: DRAFT_SHA, bytes: bytesOf(DRAFT), summary: SUMMARY },
      });
      expect(world.turns.map((turn) => turn.origin.step)).toEqual(["draft"]);
      const draft = world.turns[0];
      expect(draft?.project).toBe(PROJECT);
      expect(draft?.launch).toMatchObject({
        workspace: { type: "root" },
        runtimeMode: "full-access",
      });

      const artifacts = yield* artifactsOf(workflows);
      expect(kindsOf(artifacts)).toEqual(["brief", "deliverable"]);
      const frozen = artifacts.find((artifact) => artifact.kind === "brief");
      expect(frozen).toMatchObject({ taskId: TASK_ID, attempt: 1, location: { _tag: "inline" } });
      const text = frozen?.location._tag === "inline" ? frozen.location.text : undefined;
      expect(text).toContain(TITLE);
      expect(text).toContain(DESCRIPTION);
      expect(frozen?.sha256).toBe(sha256Of(text ?? ""));
      expect(frozen?.bytes).toBe(bytesOf(text ?? ""));
      expect(draft?.prompt).toContain(frozen?.sha256);
      expect(artifacts.filter((artifact) => artifact.kind === "deliverable")).toMatchObject([
        {
          taskId: TASK_ID,
          attempt: 1,
          sha256: DRAFT_SHA,
          bytes: bytesOf(DRAFT),
          location: { _tag: "file", path: brief.file },
        },
      ]);
      expect(yield* receiptsOf(workflows)).toEqual([]);

      yield* workflows.answer(runId, "accept", { choice: "Accept" }, SESSION);
      const done = yield* world.ended(workflows, runId);
      expect(done).toMatchObject({
        status: "completed",
        result: { outcome: "accepted", sha256: DRAFT_SHA, path: brief.file },
      });
      expect(yield* receiptsOf(workflows)).toMatchObject([
        { kind: "accepted", by: "person", taskId: TASK_ID, attempt: 1, sha256: DRAFT_SHA, runId },
      ]);
      expect(yield* noteCount(workflows)).toBe(1);
      expect(world.questions.map(({ name }) => name)).toEqual(["accept"]);
      expect(world.turns.map((turn) => turn.origin.step)).toEqual(["draft"]);
      expect(brief.posted).toEqual([]);
      expect(world.acts).toEqual([]);
    }),
  ),
);

effectIt.effect("a file changed after the question is not accepted on the old answer", () =>
  withBrief(
    {},
    Effect.fn("factoryPack.test.briefTampered")(function* (brief, world, workflows) {
      const { runId } = yield* begin(workflows, brief);
      yield* askAccept(world, workflows, runId);
      NodeFS.writeFileSync(brief.file, TAMPERED);
      yield* workflows.answer(runId, "accept", { choice: "Accept" }, SESSION);

      const again = yield* askAccept(world, workflows, runId, "accept/x1");
      expect(again.request).toMatchObject({
        data: { path: brief.file, sha256: TAMPERED_SHA, bytes: bytesOf(TAMPERED) },
      });
      const held = yield* receiptsOf(workflows);
      expect(kindsOf(held)).toEqual(["rejected"]);
      expect(held[0]).toMatchObject({ taskId: TASK_ID, attempt: 1, runId });
      expect([DRAFT_SHA, TAMPERED_SHA]).toContain(held[0]?.sha256);

      yield* workflows.answer(runId, "accept/x1", { choice: "Accept" }, SESSION);
      const done = yield* world.ended(workflows, runId);
      expect(done).toMatchObject({
        status: "completed",
        result: { outcome: "accepted", sha256: TAMPERED_SHA, path: brief.file },
      });
      const accepted = (yield* receiptsOf(workflows)).filter(({ kind }) => kind === "accepted");
      expect(accepted).toMatchObject([{ by: "person", sha256: TAMPERED_SHA }]);
      expect(world.turns.map((turn) => turn.origin.step)).toEqual(["draft"]);
    }),
  ),
);

effectIt.effect("a revision continues the draft thread, is hashed again, and is asked again", () =>
  withBrief(
    {},
    Effect.fn("factoryPack.test.briefRevise")(function* (brief, world, workflows) {
      const { runId } = yield* begin(workflows, brief);
      yield* askAccept(world, workflows, runId);
      yield* workflows.answer(runId, "accept", { choice: "Revise", reason: REASON }, SESSION);

      const again = yield* askAccept(world, workflows, runId, "accept/x1");
      expect(again.request).toMatchObject({
        data: { path: brief.file, sha256: REVISED_SHA, bytes: bytesOf(REVISED) },
      });
      expect(world.turns.map((turn) => turn.origin.step)).toEqual(["draft", "revise/x1"]);
      const [draft, revise] = world.turns;
      expect(revise?.thread).toBe(draft?.thread ?? `thread-${draft?.key}`);
      expect(revise?.prompt).toContain(REASON);
      const deliverables = (yield* artifactsOf(workflows)).filter(
        ({ kind }) => kind === "deliverable",
      );
      expect(deliverables.map(({ sha256 }) => sha256).toSorted()).toEqual(
        [DRAFT_SHA, REVISED_SHA].toSorted(),
      );
      expect(kindsOf(yield* receiptsOf(workflows))).not.toContain("accepted");

      yield* workflows.answer(runId, "accept/x1", { choice: "Accept" }, SESSION);
      const done = yield* world.ended(workflows, runId);
      expect(done).toMatchObject({
        status: "completed",
        result: { outcome: "accepted", sha256: REVISED_SHA, path: brief.file },
      });
      const accepted = (yield* receiptsOf(workflows)).filter(({ kind }) => kind === "accepted");
      expect(accepted).toMatchObject([{ by: "person", sha256: REVISED_SHA }]);
    }),
  ),
);

effectIt.effect.each(["Drop", "timeout"] as const)(
  "a brief left unaccepted by %s stops without an accepted receipt",
  (how) =>
    withBrief(
      {},
      Effect.fn("factoryPack.test.briefUnaccepted")(function* (brief, world, workflows) {
        const { runId } = yield* begin(workflows, brief);
        yield* askAccept(world, workflows, runId);
        if (how === "Drop") {
          yield* workflows.answer(runId, "accept", { choice: "Drop" }, SESSION);
        } else {
          yield* world.expireQuestion(workflows, runId, "accept");
        }
        const done = yield* world.ended(workflows, runId);
        expect(done).toMatchObject({
          status: "stopped",
          detail: "brief not accepted",
          result: null,
        });
        expect(kindsOf(yield* receiptsOf(workflows))).not.toContain("accepted");
        expect(world.turns.map((turn) => turn.origin.step)).toEqual(["draft"]);
        expect(yield* noteCount(workflows)).toBe(0);
        expect(brief.posted).toEqual([]);
      }),
    ),
);

effectIt.effect(
  "a critique that asks for a revision runs on the draft thread until it passes",
  () =>
    withBrief(
      { critiques: ["revise", "pass"] },
      Effect.fn("factoryPack.test.briefCritique")(function* (brief, world, workflows) {
        const { runId } = yield* begin(workflows, brief, { config: { critiqueModel: CRITIC } });
        const question = yield* askAccept(world, workflows, runId);
        expect(world.turns.map((turn) => turn.origin.step)).toEqual([
          "draft",
          "critique/0",
          "revise/0",
          "critique/1",
        ]);
        const [draft, first, revise, second] = world.turns;
        for (const critique of [first, second]) {
          expect(critique?.model).toEqual(CRITIC);
          expect(critique?.thread).toBeUndefined();
          expect(critique?.launch?.interactionMode).toBe("plan");
          expect(critique?.prompt).toContain(brief.file);
        }
        expect(first?.prompt).toContain(DRAFT_SHA);
        expect(second?.prompt).toContain(REVISED_SHA);
        expect(revise?.thread).toBe(draft?.thread ?? `thread-${draft?.key}`);
        expect(revise?.prompt).toContain(NOTES);
        expect(question.request).toMatchObject({
          data: { path: brief.file, sha256: REVISED_SHA, bytes: bytesOf(REVISED) },
        });
        const critiqued = (yield* receiptsOf(workflows)).filter(({ kind }) => kind === "critiqued");
        expect(critiqued.map(({ sha256 }) => sha256).toSorted()).toEqual(
          [DRAFT_SHA, REVISED_SHA].toSorted(),
        );
        expect(critiqued).toMatchObject([
          { taskId: TASK_ID, attempt: 1 },
          { taskId: TASK_ID, attempt: 1 },
        ]);

        yield* workflows.answer(runId, "accept", { choice: "Accept" }, SESSION);
        const done = yield* world.ended(workflows, runId);
        expect(done).toMatchObject({
          status: "completed",
          result: { outcome: "accepted", sha256: REVISED_SHA, path: brief.file },
        });
        expect(world.questions.map(({ name }) => name)).toEqual(["accept"]);
      }),
    ),
);

const DELIVERY = { briefDelivery: "issue-comment" } as const;

interface DeliveryCase {
  readonly label: string;
  readonly cursor: string | null;
  readonly comments: (recent: string) => ReadonlyArray<StoredComment>;
  readonly posts: number;
}

const delivering: ReadonlyArray<DeliveryCase> = [
  {
    label: "a clean window posts one comment",
    cursor: null,
    comments: () => [],
    posts: 1,
  },
  {
    label: "a window reaching back past the intent posts one comment",
    cursor: "older",
    comments: () => [commentBy("reviewer", "earlier", "An earlier remark.", AT)],
    posts: 1,
  },
  {
    label: "a comment with the marker is found and nothing is posted",
    cursor: null,
    comments: (at: string) => [commentBy(VIEWER, "marked", `${DRAFT}\n${MARKER}`, at)],
    posts: 0,
  },
  {
    label: "a comment with the marker is found beyond a truncated window",
    cursor: "older",
    comments: (at: string) => [commentBy(VIEWER, "marked", `${DRAFT}\n${MARKER}`, at)],
    posts: 0,
  },
];

effectIt.effect.each(delivering)("delivery: $label", (entry) =>
  withBrief(
    {},
    Effect.fn("factoryPack.test.briefDelivered")(function* (brief, world, workflows) {
      const recent = DateTime.formatIso(yield* DateTime.now);
      brief.conversation.comments.push(...entry.comments(recent));
      brief.conversation.cursor = entry.cursor;
      const { runId } = yield* begin(workflows, brief, {
        config: DELIVERY,
        issueUrl: ISSUE_URL,
      });
      yield* askAccept(world, workflows, runId);
      yield* workflows.answer(runId, "accept", { choice: "Accept" }, SESSION);
      const done = yield* world.ended(workflows, runId);
      expect(done).toMatchObject({
        status: "completed",
        result: { outcome: "delivered", sha256: DRAFT_SHA, path: brief.file },
      });

      expect(brief.posted).toHaveLength(entry.posts);
      for (const body of brief.posted) {
        expect(body).toContain(DRAFT.trim());
        expect(body).toContain(MARKER);
      }
      const receipts = yield* receiptsOf(workflows);
      expect(kindsOf(receipts)).toEqual(["accepted", "delivered"]);
      const delivered = receipts.find(({ kind }) => kind === "delivered");
      const comment = brief.conversation.comments.at(-1);
      expect(delivered).toMatchObject({
        taskId: TASK_ID,
        attempt: 1,
        sha256: DRAFT_SHA,
        detail: { commentId: comment?.id, url: comment?.url },
      });
      const intents = yield* workflows.stored(`factory/v1/delivery/${TASK_ID}/${DRAFT_SHA}`);
      expect(intents).toMatchObject([
        { value: { v: 1, marker: expect.stringContaining(DRAFT_SHA) } },
      ]);
      expect(world.questions.map(({ name }) => name)).toEqual(["accept"]);
    }),
  ),
);

effectIt.effect.each(["Skip", "It is posted", "Post again"] as const)(
  "delivery: a truncated window with a recent comment asks before posting, and %s",
  (choice) =>
    withBrief(
      {},
      Effect.fn("factoryPack.test.briefUnknown")(function* (brief, world, workflows) {
        const recent = DateTime.formatIso(yield* DateTime.now);
        brief.conversation.comments.push(
          commentBy("reviewer", "recent", "Looks good to me.", recent),
        );
        brief.conversation.cursor = "older";
        const { runId } = yield* begin(workflows, brief, {
          config: DELIVERY,
          issueUrl: ISSUE_URL,
        });
        yield* askAccept(world, workflows, runId);
        yield* workflows.answer(runId, "accept", { choice: "Accept" }, SESSION);

        const check = yield* world.question(workflows, runId);
        expect(check.name).toBe("deliver-check");
        expect(check.request).toMatchObject({ choices: ["Post again", "It is posted", "Skip"] });
        expect(brief.posted).toEqual([]);

        yield* workflows.answer(runId, "deliver-check", { choice }, SESSION);
        const done = yield* world.ended(workflows, runId);
        const receipts = yield* receiptsOf(workflows);
        if (choice === "Skip") {
          expect(done).toMatchObject({
            status: "completed",
            result: { outcome: "uncertain", sha256: DRAFT_SHA, path: brief.file },
          });
          expect(kindsOf(receipts)).toEqual(["accepted", "uncertain"]);
          expect(brief.posted).toEqual([]);
        } else {
          expect(done).toMatchObject({
            status: "completed",
            result: { outcome: "delivered", sha256: DRAFT_SHA, path: brief.file },
          });
          expect(kindsOf(receipts)).toEqual(["accepted", "delivered", "uncertain"]);
          expect(receipts.find(({ kind }) => kind === "delivered")).toMatchObject({
            sha256: DRAFT_SHA,
          });
        }
        if (choice === "It is posted") {
          expect(receipts.find(({ kind }) => kind === "delivered")?.by).toBe("person");
          expect(brief.posted).toEqual([]);
        }
        if (choice === "Post again") {
          expect(brief.posted).toHaveLength(1);
          expect(brief.posted[0]).toContain(MARKER);
        }
        expect(world.questions.map(({ name }) => name)).toEqual(["accept", "deliver-check"]);
      }),
    ),
);
