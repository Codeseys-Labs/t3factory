// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  FactoryArtifact,
  FactoryAttempt,
  FactoryReceipt,
  FactoryTask,
  type PullRequestDetail,
  type WorkflowRun,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import * as WorkflowForge from "../../apps/server/src/workflows/WorkflowForge.ts";
import type { AgentResult } from "../../apps/server/src/workflows/WorkflowAgents.ts";
import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Service = Workflows.Workflows["Service"];
const TASK_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT = "project-1";
const AT = "2026-01-01T00:00:00.000Z";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MODEL = { instanceId: "codex", model: "test-worker" };
const PART = {
  title: "Implement the change",
  brief: "Implement the requested behavior and its tests.",
};
const DEFAULT_CONFIG = {
  v: 1,
  concurrency: 2,
  askPlan: true,
  askMerge: true,
  mergeNeedsPerson: false,
  planModel: null,
  workerModel: null,
  reviewModel: null,
  baseRef: null,
  stepTimeout: "2 hours",
  checksTimeout: "1 hour",
  fixRounds: 2,
  mergeMethod: "squash",
  protectedPaths: [],
  lowRiskPaths: [],
};
const TaskRecord = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  number: Schema.Number,
  rev: Schema.Number,
  projectId: Schema.NullOr(Schema.String),
  title: Schema.String,
  description: Schema.String,
  lane: Schema.Literals(["backlog", "ready", "doing", "review", "done", "dropped"]),
  laneSetAt: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  blockedBy: Schema.Array(Schema.String),
  assignee: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.Struct({ instanceId: Schema.String, model: Schema.String })),
  source: Schema.Union([
    Schema.TaggedStruct("local", {}),
    Schema.TaggedStruct("issue", { url: Schema.String, displayKey: Schema.String }),
  ]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const CaptureResult = Schema.Struct({
  taskId: Schema.String,
  number: Schema.Number,
  runId: Schema.NullOr(Schema.String),
});
const StartResult = Schema.Struct({
  taskId: Schema.String,
  attempt: Schema.Number,
  runId: Schema.String,
});
const Note = Schema.Struct({
  v: Schema.Literal(1),
  taskId: Schema.String,
  id: Schema.String,
  text: Schema.String,
  by: Schema.String,
  at: Schema.String,
});
const decodeTask = Schema.decodeUnknownEffect(TaskRecord);
const decodeTaskSync = Schema.decodeUnknownSync(TaskRecord);
const decodeCapture = Schema.decodeUnknownEffect(CaptureResult);
const decodeStart = Schema.decodeUnknownEffect(StartResult);
const decodeNote = Schema.decodeUnknownEffect(Note);
const decodeIssue = Schema.decodeSync(WorkflowForge.Issue);
const decodePullRequest = Schema.decodeSync(WorkflowForge.PullRequest);
const decodeAttempt = Schema.decodeUnknownEffect(FactoryAttempt);
const Problem = Schema.Struct({ problem: Schema.String });
const decodeProblem = Schema.decodeUnknownEffect(Problem);
const PR_URL = "https://github.com/factory/pack/pull/17";
const ISSUE_URL = "https://github.com/acme/repo/issues/191";
const decodeQuestionData = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Json }));
const decodeFactoryTask = Schema.decodeUnknownEffect(FactoryTask);
const decodeArtifact = Schema.decodeUnknownEffect(FactoryArtifact);
const decodeReceipt = Schema.decodeUnknownEffect(FactoryReceipt);

const pullRequestAt = (number: number, projectId = PROJECT) =>
  decodePullRequest({
    provider: "github",
    host: "github.com",
    projectId,
    projectTitle: "Factory",
    repository: "factory/pack",
    number,
    title: `Part ${number}`,
    url: `https://github.com/factory/pack/pull/${number}`,
    author: null,
    headBranch: `part-${number}`,
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

const issueAt = (key: string, projectId = PROJECT, title = `Issue ${key}`) =>
  decodeIssue({
    projectId,
    projectTitle: "Factory",
    tracker: "github",
    host: "github.com",
    scope: "factory/pack",
    key,
    displayKey: `#${key}`,
    title,
    url: `https://github.com/factory/pack/issues/${key}`,
    author: null,
    state: { name: "open", category: "open" },
    createdAt: AT,
    updatedAt: AT,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
  });
const TASK = {
  v: 1,
  id: TASK_ID,
  number: 7,
  rev: 1,
  projectId: PROJECT,
  title: "Build the factory",
  description: "Make task execution durable.",
  lane: "ready",
  laneSetAt: AT,
  parentId: null,
  blockedBy: [],
  assignee: null,
  model: MODEL,
  source: { _tag: "local" },
  createdAt: AT,
  updatedAt: AT,
} satisfies typeof TaskRecord.Type;

// r9 L1: what a scripted reviewer reports; each claim is one open major, which blocks (L3).
const reviewReport = (claims: ReadonlyArray<string>) => ({
  output: {
    reviewedHead: null,
    findings: claims.map((claim) => ({
      severity: "major",
      category: "correctness",
      path: "src/part.ts",
      line: 3,
      claim,
      evidence: "",
    })),
  },
});
// r9 L4: renderFindings of that one open major, which becomes the review's notes.
const reviewNotes = (claim: string) => `- [major] src/part.ts:3: ${claim}`;

const script = (
  options: {
    readonly parts?: ReadonlyArray<typeof PART>;
    readonly noPullRequest?: boolean;
    readonly changes?: boolean;
    readonly checks?: ReadonlyArray<WorkflowForge.PullRequestStanding["checks"]>;
    readonly issues?: ReadonlyArray<WorkflowForge.Issue>;
  } = {},
) => {
  const plan = { summary: "A small implementation plan.", parts: [...(options.parts ?? [PART])] };
  const urls = new Map<string, string | null>();
  return {
    plan,
    urls,
    issues: options.issues ?? [],
    pullRequests: Array.from({ length: 6 }, (_, index) => pullRequestAt(17 + index)),
    agent: (turn: AgentTurnInput): Partial<AgentResult> => {
      const step = turn.origin.step;
      if (step === "plan") return { output: plan };
      if (step === "do" || step === "do/continue" || step === "do/again") {
        const prUrl = options.noPullRequest
          ? null
          : `https://github.com/factory/pack/pull/${17 + urls.size}`;
        urls.set(turn.origin.runId, prUrl);
        return { output: { summary: "Implemented the requested part.", prUrl } };
      }
      if (step.startsWith("scope/")) return {};
      // r9 L4: the defects lens of a high tier reports nothing, and disprove refutes nothing.
      if (/^review\/x?\d+$/.test(step)) {
        return reviewReport(options.changes ? ["Review feedback."] : []);
      }
      if (/^review\/x?\d+\/defects$/.test(step)) return reviewReport([]);
      if (/^disprove\/x?\d+$/.test(step)) return { output: { results: [] } };
      if (/^fix\/x?\d+$/.test(step)) return { reply: "Fixed the reported problem." };
      throw new Error(`Unexpected agent step ${step}`);
    },
    standing: (pullRequest: WorkflowForge.PullRequestAddress, read: number) => ({
      state: "open" as const,
      checks: options.checks?.[read] ?? "passing",
      mergeability: "mergeable" as const,
      url:
        "url" in pullRequest
          ? pullRequest.url
          : `https://${pullRequest.host}/${pullRequest.repository}/pull/${pullRequest.number}`,
    }),
  };
};

// A finished fix turn moves the scripted head, as a real push would.
const pushingFixes = <
  T extends {
    readonly agent: (turn: AgentTurnInput) => Partial<AgentResult>;
    readonly urls: ReadonlyMap<string, string | null>;
  },
>(
  answers: T,
) => {
  const pushes = new Map<string, number>();
  return {
    ...answers,
    agent: (turn: AgentTurnInput) => {
      if (/^fix\/x?\d+$/.test(turn.origin.step)) {
        const url = answers.urls.get(turn.origin.runId);
        if (typeof url !== "string") throw new Error("Expected the fix turn's pull request");
        pushes.set(url, (pushes.get(url) ?? 0) + 1);
      }
      return answers.agent(turn);
    },
    readPullRequest: (_address: WorkflowForge.PullRequestAddress, detail: PullRequestDetail) =>
      Effect.succeed({ ...detail, headSha: `sha-${pushes.get(detail.url) ?? 0}` }),
  };
};

const startTask = Effect.fn("factoryPack.test.startTask")(function* (
  workflows: Service,
  issueUrl: string | null = null,
  projectId: string | null = PROJECT,
) {
  yield* workflows.storeSet("factory/v1/seq", TASK.number);
  yield* workflows.storeSet(`factory/v1/task/${TASK_ID}`, { ...TASK, projectId });
  return yield* workflows.start(
    "factory-task",
    {
      taskId: TASK_ID,
      number: TASK.number,
      attempt: 1,
      title: TASK.title,
      description: TASK.description,
      projectId,
      model: MODEL,
      issueUrl,
    },
    { idempotencyKey: `task/${TASK_ID}/a1` },
  );
});

const ask = Effect.fn("factoryPack.test.ask")(function* (
  world: World,
  workflows: Service,
  runId: string,
  name: string,
  kind: string,
  choices: ReadonlyArray<string>,
) {
  const question = yield* world.question(workflows, runId);
  expect({ name: question.name, kind: question.kind }).toEqual({ name, kind });
  expect(question.request).toMatchObject({ choices });
  return question;
});
const askStuck = Effect.fn("factoryPack.test.askStuck")(function* (
  world: World,
  workflows: Service,
  runId: string,
  name = "stuck",
) {
  const question = yield* ask(world, workflows, runId, name, "stuck", [
    "Merge anyway",
    "Fix again",
    "Stop",
  ]);
  expect(question.request).toMatchObject({
    choiceDetails: expect.arrayContaining([
      expect.objectContaining({ value: "Fix again", requireReason: true }),
    ]),
  });
  return question;
});
const approvePlan = Effect.fn("factoryPack.test.approvePlan")(function* (
  world: World,
  workflows: Service,
  runId: string,
) {
  yield* ask(world, workflows, runId, "approve-plan", "plan", ["Start", "Drop"]);
  yield* workflows.answer(runId, "approve-plan", { choice: "Start" });
});
const merge = Effect.fn("factoryPack.test.merge")(function* (
  world: World,
  workflows: Service,
  runId: string,
) {
  yield* ask(world, workflows, runId, "approve-merge", "merge", ["Merge", "Hold"]);
  expect((yield* workflows.get(runId)).run.tags).toEqual(tags("review"));
  yield* workflows.answer(
    runId,
    "approve-merge",
    { choice: "Merge" },
    { label: "Test person", sessionId: "test-person" },
  );
});
const tags = (stage: string, taskId = TASK_ID) => [
  `task:${taskId}`,
  `project:${PROJECT}`,
  `stage:${stage}`,
];
const expectTurns = (world: World, runId: string, steps: ReadonlyArray<string>) => {
  const turns = world.turns.filter((turn) => turn.origin.runId === runId);
  expect(turns.map((turn) => turn.origin.step)).toEqual(steps);
  const initial = turns.findLast((turn) => turn.origin.step === "do");
  const work = turns.findLast((turn) => /^do(?:\/continue|\/again)?$/.test(turn.origin.step));
  for (const turn of turns) {
    if (turn.origin.step.startsWith("fix/")) {
      expect(work).toBeDefined();
      expect(turn.thread).toBe(work?.thread ?? `thread-${work?.key}`);
    } else if (turn.origin.step === "do/continue") {
      expect(initial).toBeDefined();
      expect(turn.thread).toBe(initial?.thread ?? `thread-${initial?.key}`);
      expect(turn.launch).toBeUndefined();
      expect(turn.project).toBeUndefined();
      expect(turn.model).toBeUndefined();
      expect(turn.outputSchema).toEqual(initial?.outputSchema);
    } else {
      // r9 L4: the defects lens and disprove also start new threads with the task's model here.
      // AMBIGUOUS: L4.5 does not name disprove's project; read as the project, which it must
      // read to reproduce a claim. The other reading leaves `project` unset.
      expect(turn.thread).toBeUndefined();
      expect(turn.project).toBe(PROJECT);
      expect(turn.model).toEqual(MODEL);
    }
    expect(turn.origin.workflow).toBe(
      turn.origin.step === "plan" ? "factory-task" : "factory-task-part",
    );
    if (turn.origin.step === "plan") expect(turn.launch?.interactionMode).toBe("plan");
    if (turn.origin.step === "do") {
      expect(turn.launch?.runtimeMode).toBe("full-access");
      expect(turn.launch?.workspace?.type).toBe("worktree");
    }
  }
};
const expectQuestions = (
  world: World,
  expected: ReadonlyArray<readonly [string, string, string]>,
) => {
  expect(world.questions.map(({ runId, name, kind }) => [runId, name, kind])).toEqual(expected);
};
const expectTags = (world: World, run: WorkflowRun, stage: string, taskId = TASK_ID) => {
  expect(run.tags).toEqual(tags(stage, taskId));
  const observed = world.tagHistory.filter((entry) => entry.runId === run.runId);
  expect(observed.length).toBeGreaterThan(0);
  for (const entry of observed) {
    expect(entry.tags.slice(0, -1)).toEqual([`task:${taskId}`, `project:${PROJECT}`]);
    expect(["stage:planning", "stage:doing", "stage:review", "stage:done"]).toContain(
      entry.tags.at(-1),
    );
  }
};
// r9 M1: what a completed part reports; a test names only what differs from a clean merge.
type PartStats = {
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
const partStats = (stats: Partial<PartStats> = {}): PartStats => ({
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
  ...stats,
});
// r9 M1: no pull request, so no tier and no review; the accept question is the one ask.
const ACCEPTED_STATS = partStats({ tier: null, asks: 1, reviewRounds: 0 });
const expectMerged = (
  world: World,
  parent: WorkflowRun,
  child: WorkflowRun,
  prUrl: string,
  stats: PartStats,
) => {
  expect(child.status).toBe("completed");
  // r9 M1: the part returns its statistics, and the task lists them with the part.
  expect(child.result).toEqual({ outcome: "merged", prUrl, stats });
  expect(child.parentRunId).toBe(parent.runId);
  expect(child.parentStep).toBe("part-0");
  expectTags(world, child, "review");
  expect(parent.status).toBe("completed");
  expect(parent.result).toEqual({
    parts: [{ title: PART.title, outcome: "merged", prUrl, stats }],
  });
  expectTags(world, parent, "done");
  expect(world.acts).toEqual([
    [{ project: PROJECT, url: prUrl }, "merge", { mergeMethod: "squash" }],
  ]);
  expect(world.issueQueries).toEqual([]);
};
const taskAt = Effect.fn("factoryPack.test.taskAt")(function* (workflows: Service, id: string) {
  const rows = yield* workflows.stored(`factory/v1/task/${id}`);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.key).toBe(`factory/v1/task/${id}`);
  const task = yield* decodeTask(rows[0]?.value).pipe(Effect.orDie);
  expect(rows[0]?.value).toEqual(task);
  expect(task.id).toMatch(UUID);
  for (const stamp of [task.createdAt, task.updatedAt, task.laneSetAt]) {
    expect(stamp).toMatch(ISO);
    expect(DateTime.formatIso(DateTime.makeUnsafe(stamp))).toBe(stamp);
  }
  return task;
});
const expectNote = Effect.fn("factoryPack.test.expectNote")(function* (
  workflows: Service,
  taskId: string,
  outcomes: ReadonlyArray<{ title: string; outcome: string }>,
) {
  const rows = yield* workflows.stored(`factory/v1/note/${taskId}/`);
  expect(rows).toHaveLength(1);
  const note = yield* decodeNote(rows[0]?.value).pipe(Effect.orDie);
  expect(rows[0]?.value).toEqual(note);
  expect(rows[0]?.key).toMatch(
    new RegExp(`^factory/v1/note/${taskId}/\\d{4}-\\d{2}-\\d{2}T.*Z-[0-9a-f]{8}$`),
  );
  expect(note.taskId).toBe(taskId);
  expect(note.id.length).toBeGreaterThan(0);
  expect(note.by.length).toBeGreaterThan(0);
  expect(note.at).toMatch(ISO);
  expect(note.text.length).toBeLessThanOrEqual(4000);
  for (const part of outcomes) {
    // AMBIGUOUS: identify each part in the finish note by title rather than only its index.
    expect(note.text).toContain(part.title);
    expect(note.text).toContain(part.outcome);
  }
});

it("one approved part merges once, completes its task, and appends a note", () => {
  const answers = script();
  return withWorld(answers, (world) =>
    world.server(
      Effect.fn("factoryPack.test.happy")(function* (workflows) {
        const { runId } = yield* startTask(workflows);
        const question = yield* ask(world, workflows, runId, "approve-plan", "plan", [
          "Start",
          "Drop",
        ]);
        expect(question.request).toMatchObject({ data: answers.plan });
        expect((yield* workflows.get(runId)).run).toMatchObject({
          title: "T-7 Build the factory",
          tags: tags("planning"),
        });
        expect(
          world.definitions.find((definition) => definition.name === "factory-task")?.asks.plan,
        ).toBe("Approve the plan?");
        expect(
          world.definitions.find((definition) => definition.name === "factory-task-part")?.asks,
        ).toMatchObject({
          accept: "Accept the result?",
          stuck: "Review did not pass",
          merge: "Merge?",
        });
        yield* workflows.answer(runId, "approve-plan", { choice: "Start" });
        const child = yield* world.child(workflows, runId, 0);
        yield* merge(world, workflows, child.runId);
        const done = yield* world.ended(workflows, runId);
        const part = yield* world.ended(workflows, child.runId);
        expectMerged(
          world,
          done,
          part,
          "https://github.com/factory/pack/pull/17",
          partStats({ asks: 1 }),
        );
        expectTurns(world, runId, ["plan"]);
        expectTurns(world, child.runId, ["do", "scope/0", "review/0"]);
        expect(world.turns).toHaveLength(4);
        expect(
          (yield* workflows.get(child.runId)).steps.filter(
            (step) => step.name === "do/continue" || step.name === "do/again",
          ),
        ).toEqual([]);
        expectQuestions(world, [
          [runId, "approve-plan", "plan"],
          [child.runId, "approve-merge", "merge"],
        ]);
        expect(
          (yield* workflows.get(runId)).steps.find((step) => step.name === "config")?.result,
        ).toEqual(DEFAULT_CONFIG);
        yield* expectNote(workflows, TASK_ID, [{ title: PART.title, outcome: "merged" }]);
        expect(yield* taskAt(workflows, TASK_ID)).toEqual(TASK);
      }),
    ),
  );
});

it("dropping the plan stops before any do turn", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.drop")(function* (workflows) {
        const { runId } = yield* startTask(workflows);
        yield* ask(world, workflows, runId, "approve-plan", "plan", ["Start", "Drop"]);
        yield* workflows.answer(runId, "approve-plan", { choice: "Drop" });
        const done = yield* world.ended(workflows, runId);
        expect(done).toMatchObject({
          status: "stopped",
          detail: "plan not approved",
          result: null,
        });
        expectTags(world, done, "planning");
        expectTurns(world, runId, ["plan"]);
        expect(world.turns).toHaveLength(1);
        expectQuestions(world, [[runId, "approve-plan", "plan"]]);
        expect(world.acts).toEqual([]);
        expect(world.reads).toEqual([]);
        expect(world.issueQueries).toEqual([]);
        expect((yield* workflows.list()).filter((run) => run.parentRunId === runId)).toEqual([]);
        expect(yield* workflows.stored(`factory/v1/note/${TASK_ID}/`)).toEqual([]);
      }),
    ),
  ));

it("askPlan false and askMerge false complete without questions", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.unattended")(function* (workflows) {
        yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false, askMerge: false });
        const { runId } = yield* startTask(workflows);
        const done = yield* world.ended(workflows, runId, true);
        const child = yield* world.child(workflows, runId, 0);
        expectMerged(world, done, child, "https://github.com/factory/pack/pull/17", partStats());
        expectTurns(world, runId, ["plan"]);
        expectTurns(world, child.runId, ["do", "scope/0", "review/0"]);
        expect(world.turns).toHaveLength(4);
        expectQuestions(world, []);
        expect(yield* workflows.questions).toEqual([]);
      }),
    ),
  ));

it("failing checks continue the do thread in fix/0 before review and merge", () =>
  withWorld(pushingFixes(script({ checks: ["failing", "passing"] })), (world) =>
    world.server(
      Effect.fn("factoryPack.test.checkFix")(function* (workflows) {
        const { runId } = yield* startTask(workflows);
        yield* approvePlan(world, workflows, runId);
        const child = yield* world.child(workflows, runId, 0);
        yield* merge(world, workflows, child.runId);
        expectMerged(
          world,
          yield* world.ended(workflows, runId),
          yield* world.ended(workflows, child.runId),
          "https://github.com/factory/pack/pull/17",
          // r9 M1: the fix moved the head; only round 1 had a review. AMBIGUOUS: a round whose
          // checks failed is read as writing no ledger record (reviewRounds 1, not 2).
          partStats({ fixRounds: 1, asks: 1 }),
        );
        expectTurns(world, runId, ["plan"]);
        expectTurns(world, child.runId, ["do", "fix/0", "scope/1", "review/1"]);
        expect(world.turns).toHaveLength(5);
        // checks/0, the two fix reads, checks/1, risk-pr/1, head/1 (r9 L4.6), head-sha, merge.
        // AMBIGUOUS: a round whose checks failed is read as having no head/0 step (no review).
        expect(world.reads.map(({ standing }) => standing.checks)).toEqual([
          "failing",
          "passing",
          "passing",
          "passing",
          "passing",
          "passing",
          "passing",
          "passing",
        ]);
        const names = (yield* workflows.get(child.runId)).steps.map((step) => step.name);
        expect(names.filter((name) => name.startsWith("checks/"))).toEqual([
          "checks/0",
          "checks/1",
        ]);
        expect(names.filter((name) => name.startsWith("fix"))).toEqual([
          "fix-before/0",
          "fix/0",
          "fix-after/0",
        ]);
        expect(names.indexOf("checks/1")).toBeGreaterThan(names.indexOf("fix-after/0"));
        expectQuestions(world, [
          [runId, "approve-plan", "plan"],
          [child.runId, "approve-merge", "merge"],
        ]);
      }),
    ),
  ));

it("fixRounds one asks stuck after two changes reviews and Stop ends only the part", () => {
  const answers = {
    ...script({ changes: true }),
    readPullRequest: (_address: WorkflowForge.PullRequestAddress, detail: PullRequestDetail) =>
      Effect.succeed({ ...detail, headSha: undefined }),
  };
  return withWorld(answers, (world) =>
    world.server(
      Effect.fn("factoryPack.test.stuck")(function* (workflows) {
        yield* workflows.storeSet("factory/v1/config", { v: 1, fixRounds: 1 });
        const { runId } = yield* startTask(workflows);
        yield* approvePlan(world, workflows, runId);
        const child = yield* world.child(workflows, runId, 0);
        yield* askStuck(world, workflows, child.runId);
        yield* workflows.answer(child.runId, "stuck", { choice: "Stop" });
        const part = yield* world.ended(workflows, child.runId);
        const done = yield* world.ended(workflows, runId);
        expect(part).toMatchObject({
          status: "stopped",
          detail: "review did not pass",
          result: null,
        });
        expectTags(world, part, "review");
        expect(done.status).toBe("completed");
        // r9 M1: a part that did not complete is listed with no statistics.
        expect(done.result).toEqual({
          parts: [{ title: PART.title, outcome: "stopped", prUrl: null, stats: null }],
        });
        expectTags(world, done, "done");
        expectTurns(world, runId, ["plan"]);
        // r9 L4: the missing head makes the tier high, so each round adds the defects lens, and
        // each round's open major is put to the disprove step.
        expectTurns(world, child.runId, [
          "do",
          "scope/0",
          "review/0",
          "review/0/defects",
          "disprove/0",
          "fix/0",
          "review/1",
          "review/1/defects",
          "disprove/1",
        ]);
        expect(world.turns).toHaveLength(10);
        expectQuestions(world, [
          [runId, "approve-plan", "plan"],
          [child.runId, "stuck", "stuck"],
        ]);
        expect(world.acts).toEqual([]);
        // Both rounds read risk metadata and the head again after review (r9 L4.6), but the
        // unreported head does not change.
        expect(world.reads.map(({ standing }) => standing.checks)).toEqual([
          "passing",
          "passing",
          "passing",
          "passing",
          "passing",
          "passing",
          "passing",
          "passing",
        ]);
        expect(world.issueQueries).toEqual([]);
        yield* expectNote(workflows, TASK_ID, [{ title: PART.title, outcome: "stopped" }]);
      }),
    ),
  );
});

it("a part without a pull request asks accept and completes without a forge act", () =>
  withWorld(script({ noPullRequest: true }), (world) =>
    world.server(
      Effect.fn("factoryPack.test.accept")(function* (workflows) {
        const { runId } = yield* startTask(workflows);
        yield* approvePlan(world, workflows, runId);
        const child = yield* world.child(workflows, runId, 0);
        const question = yield* ask(world, workflows, child.runId, "accept", "accept", [
          "Accept",
          "Redo",
        ]);
        expect(question.request).toMatchObject({
          data: { summary: "Implemented the requested part." },
        });
        yield* workflows.answer(child.runId, "accept", { choice: "Accept" });
        const part = yield* world.ended(workflows, child.runId);
        const done = yield* world.ended(workflows, runId);
        expect(part).toMatchObject({
          status: "completed",
          result: { outcome: "accepted", prUrl: null },
        });
        expectTags(world, part, "doing");
        expect(done.status).toBe("completed");
        expect(done.result).toEqual({
          parts: [{ title: PART.title, outcome: "accepted", prUrl: null, stats: ACCEPTED_STATS }],
        });
        expectTags(world, done, "done");
        expectTurns(world, runId, ["plan"]);
        expectTurns(world, child.runId, ["do"]);
        expect(world.turns).toHaveLength(2);
        expectQuestions(world, [
          [runId, "approve-plan", "plan"],
          [child.runId, "accept", "accept"],
        ]);
        expect(world.acts).toEqual([]);
        expect(world.reads).toEqual([]);
        expect(world.issueQueries).toEqual([]);
      }),
    ),
  ));

it("concurrency two runs two children of the task before either merge is answered", () => {
  const parts = [PART, { title: "Document the change", brief: "Document the requested behavior." }];
  const answers = script({ parts });
  return withWorld(answers, (world) =>
    world.server(
      Effect.fn("factoryPack.test.parallel")(function* (workflows) {
        yield* workflows.storeSet("factory/v1/config", { v: 1, concurrency: 2 });
        const { runId } = yield* startTask(workflows);
        yield* approvePlan(world, workflows, runId);
        const first = yield* world.child(workflows, runId, 0);
        const second = yield* world.child(workflows, runId, 1);
        yield* ask(world, workflows, first.runId, "approve-merge", "merge", ["Merge", "Hold"]);
        yield* ask(world, workflows, second.runId, "approve-merge", "merge", ["Merge", "Hold"]);
        expect(world.acts).toEqual([]);
        expect(first.runId).not.toBe(second.runId);
        expect(
          (yield* workflows.questions).filter((question) => question.kind === "merge"),
        ).toHaveLength(2);
        for (const child of [first, second])
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" });
        const done = yield* world.ended(workflows, runId);
        const children = (yield* workflows.list())
          .filter((run) => run.parentRunId === runId)
          .toSorted((a, b) => (a.parentStep ?? "").localeCompare(b.parentStep ?? ""));
        expect(children).toHaveLength(2);
        expect(done.status).toBe("completed");
        // r9 M1: each part answered its own merge question.
        expect(done.result).toEqual({
          parts: parts.map((part, index) => ({
            title: part.title,
            outcome: "merged",
            prUrl: answers.urls.get(children[index]?.runId ?? ""),
            stats: partStats({ asks: 1 }),
          })),
        });
        expectTags(world, done, "done");
        for (const [index, child] of children.entries()) {
          expect(child.parentStep).toBe(`part-${index}`);
          expect(child.status).toBe("completed");
          expect(child.result).toEqual({
            outcome: "merged",
            prUrl: answers.urls.get(child.runId),
            stats: partStats({ asks: 1 }),
          });
          expectTags(world, child, "review");
          expectTurns(world, child.runId, ["do", "scope/0", "review/0"]);
        }
        expectTurns(world, runId, ["plan"]);
        expect(world.turns).toHaveLength(7);
        expect(
          world.questions.map(({ runId: id, name, kind }) => [id, name, kind]).toSorted(),
        ).toEqual(
          [
            [runId, "approve-plan", "plan"],
            [first.runId, "approve-merge", "merge"],
            [second.runId, "approve-merge", "merge"],
          ].toSorted(),
        );
        expect(world.acts).toHaveLength(2);
        for (const url of answers.urls.values())
          expect(world.acts).toContainEqual([
            { project: PROJECT, url },
            "merge",
            { mergeMethod: "squash" },
          ]);
        expect(world.issueQueries).toEqual([]);
      }),
    ),
  );
});

it("project config overrides global fields without discarding the other global fields", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.config")(function* (workflows) {
        yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false });
        yield* workflows.storeSet(`factory/v1/config/${PROJECT}`, { v: 1, askMerge: false });
        const { runId } = yield* startTask(workflows);
        const done = yield* world.ended(workflows, runId, true);
        const child = yield* world.child(workflows, runId, 0);
        expectMerged(world, done, child, "https://github.com/factory/pack/pull/17", partStats());
        expect(
          (yield* workflows.get(runId)).steps.find((step) => step.name === "config")?.result,
        ).toEqual({ ...DEFAULT_CONFIG, askPlan: false, askMerge: false });
        expectTurns(world, runId, ["plan"]);
        expectTurns(world, child.runId, ["do", "scope/0", "review/0"]);
        expect(world.turns).toHaveLength(4);
        expectQuestions(world, []);
      }),
    ),
  ));

it("capture allocates consecutive task numbers and start records attempt one and its run", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.capture")(function* (workflows) {
        yield* workflows.storeSet("factory/v1/seq", 40);
        const input = {
          title: "Captured task",
          description: "Captured description",
          projectId: PROJECT,
          parentId: null,
          blockedBy: [],
          lane: "ready",
          assignee: "developer",
          model: MODEL,
        };
        const first = yield* workflows.start("factory-capture", input, {
          idempotencyKey: "capture-1",
        });
        const firstDone = yield* world.ended(workflows, first.runId);
        expect(firstDone.status).toBe("completed");
        const captured = yield* decodeCapture(firstDone.result).pipe(Effect.orDie);
        expect(firstDone.result).toEqual({
          taskId: expect.stringMatching(UUID),
          number: 41,
          runId: null,
        });
        const task = yield* taskAt(workflows, captured.taskId);
        expect(task).toEqual({
          ...input,
          v: 1,
          id: captured.taskId,
          number: 41,
          rev: 1,
          source: { _tag: "local" },
          createdAt: task.createdAt,
          updatedAt: task.createdAt,
          laneSetAt: task.createdAt,
        });
        expect(yield* workflows.stored(`factory/v1/attempt/${captured.taskId}/`)).toEqual([]);
        const second = yield* workflows.start(
          "factory-capture",
          { ...input, title: "Started capture", start: true },
          { idempotencyKey: "capture-2" },
        );
        const secondDone = yield* world.ended(workflows, second.runId);
        expect(secondDone.status).toBe("completed");
        const started = yield* decodeCapture(secondDone.result).pipe(Effect.orDie);
        expect(secondDone.result).toEqual({
          taskId: expect.stringMatching(UUID),
          number: 42,
          runId: expect.any(String),
        });
        expect(started.taskId).not.toBe(captured.taskId);
        if (started.runId === null) throw new Error("capture did not start factory-task");
        const startedTask = yield* taskAt(workflows, started.taskId);
        expect(startedTask).toEqual({
          ...input,
          title: "Started capture",
          lane: "doing",
          v: 1,
          id: started.taskId,
          number: 42,
          rev: 2,
          source: { _tag: "local" },
          createdAt: startedTask.createdAt,
          updatedAt: startedTask.updatedAt,
          laneSetAt: startedTask.updatedAt,
        });
        expect(startedTask.updatedAt >= startedTask.createdAt).toBe(true);
        expect(yield* workflows.stored("factory/v1/seq")).toEqual([
          { key: "factory/v1/seq", value: 42 },
        ]);
        const attempts = yield* workflows.stored(`factory/v1/attempt/${started.taskId}/`);
        expect(attempts).toEqual([
          {
            key: `factory/v1/attempt/${started.taskId}/0001`,
            value: {
              v: 1,
              taskId: started.taskId,
              n: 1,
              key: `task/${started.taskId}/a1`,
              workflow: "factory-task",
              runId: started.runId,
              requestedBy: expect.any(String),
              startedAt: expect.stringMatching(ISO),
            },
          },
        ]);
        yield* ask(world, workflows, started.runId, "approve-plan", "plan", ["Start", "Drop"]);
        const taskRun = (yield* workflows.get(started.runId)).run;
        expect(taskRun.workflow).toBe("factory-task");
        expectTags(world, taskRun, "planning", started.taskId);
        expect(
          (yield* workflows.start(
            "factory-task",
            {
              taskId: started.taskId,
              number: 42,
              attempt: 1,
              title: startedTask.title,
              description: input.description,
              projectId: PROJECT,
              model: MODEL,
              issueUrl: null,
            },
            { idempotencyKey: `task/${started.taskId}/a1` },
          )).runId,
        ).toBe(started.runId);
        expectTurns(world, started.runId, ["plan"]);
        expect(world.turns).toHaveLength(1);
        expectQuestions(world, [[started.runId, "approve-plan", "plan"]]);
        expect(
          (yield* workflows.get(second.runId)).steps
            .filter((step) => step.kind === "step")
            .map((step) => step.name),
        ).toEqual(["capture", "start"]);
        // AMBIGUOUS: capture, intake and start prescribe no tag calls; their wrapper runs stay untagged.
        expect(firstDone.tags ?? []).toEqual([]);
        expect(secondDone.tags ?? []).toEqual([]);
        expect(world.acts).toEqual([]);
        expect(world.reads).toEqual([]);
        expect(world.issueQueries).toEqual([]);
        yield* workflows.answer(started.runId, "approve-plan", { choice: "Drop" });
        expect((yield* world.ended(workflows, started.runId)).status).toBe("stopped");
      }),
    ),
  ));

it("intake captures two open issues once and skips the next tick", () => {
  const issues = ["11", "12"].map((key) =>
    decodeIssue({
      projectId: PROJECT,
      projectTitle: "Factory",
      tracker: "github",
      host: "github.com",
      scope: "factory/pack",
      key,
      displayKey: `#${key}`,
      title: `Issue ${key}`,
      url: `https://github.com/factory/pack/issues/${key}`,
      author: null,
      state: { name: "open", category: "open" },
      createdAt: AT,
      updatedAt: AT,
      closedAt: null,
      assignees: [],
      labels: [{ name: "factory", color: null }],
      commentCount: 0,
    }),
  );
  return withWorld(script({ issues }), (world) =>
    world.server(
      Effect.fn("factoryPack.test.intake")(function* (workflows) {
        yield* workflows.storeSet(`factory/v1/intake/${PROJECT}`, {
          v: 1,
          enabled: true,
          labels: ["factory"],
          autoStart: false,
        });
        const definition = world.definitions.find((entry) => entry.name === "factory-intake");
        expect(definition?.version).toBe(1);
        expect(
          definition?.triggers.map((trigger) =>
            trigger.kind === "schedule" ? trigger.schedule : trigger.kind,
          ),
        ).toEqual([{ type: "interval", everyMs: 300000 }]);
        const first = yield* workflows.start(
          "factory-intake",
          { scheduledAt: AT },
          { idempotencyKey: "tick-1" },
        );
        const done = yield* world.ended(workflows, first.runId, true);
        expect(done.status).toBe("completed");
        const rows = yield* workflows.stored("factory/v1/task/");
        expect(rows).toHaveLength(2);
        const tasks = rows
          .map((row) => decodeTaskSync(row.value))
          .toSorted((a, b) => a.number - b.number);
        for (const [index, task] of tasks.entries()) {
          const issue = issues[index];
          if (issue === undefined) throw new Error("Unexpected captured issue");
          expect(yield* taskAt(workflows, task.id)).toEqual({
            v: 1,
            id: task.id,
            number: index + 1,
            rev: 1,
            projectId: PROJECT,
            title: issue.title,
            description: issue.url,
            lane: "ready",
            laneSetAt: task.createdAt,
            parentId: null,
            blockedBy: [],
            assignee: null,
            model: null,
            source: { _tag: "issue", url: issue.url, displayKey: issue.displayKey },
            createdAt: task.createdAt,
            updatedAt: task.createdAt,
          });
          expect(yield* workflows.stored(`factory/v1/intake-seen/${PROJECT}/${issue.key}`)).toEqual(
            [
              {
                key: `factory/v1/intake-seen/${PROJECT}/${issue.key}`,
                value: { v: 1, taskId: task.id },
              },
            ],
          );
        }
        expect(done.result).toEqual({
          captured: tasks.map((task, index) => ({
            taskId: task.id,
            number: index + 1,
            projectId: PROJECT,
            issueKey: issues[index]?.key,
          })),
          failed: [],
        });
        const second = yield* workflows.start(
          "factory-intake",
          { scheduledAt: "2026-01-01T00:05:00.000Z" },
          { idempotencyKey: "tick-2" },
        );
        const skipped = yield* world.ended(workflows, second.runId, true);
        expect(skipped).toMatchObject({ status: "skipped", detail: "no new issues", result: null });
        expect(yield* workflows.stored("factory/v1/task/")).toEqual(rows);
        expect(yield* workflows.stored("factory/v1/seq")).toEqual([
          { key: "factory/v1/seq", value: 2 },
        ]);
        expect(yield* workflows.stored("factory/v1/attempt/")).toEqual([]);
        expect(world.issueQueries).toHaveLength(2);
        for (const query of world.issueQueries)
          expect({ ...query, state: query.state ?? "open" }).toEqual({
            project: PROJECT,
            state: "open",
            labels: ["factory"],
            limit: 50,
          });
        expect(done.tags ?? []).toEqual([]);
        expect(skipped.tags ?? []).toEqual([]);
        expect(world.turns).toEqual([]);
        expectQuestions(world, []);
        expect(world.acts).toEqual([]);
        expect(world.reads).toEqual([]);
      }),
    ),
  );
});

it("intake reports a failed binding and still captures the next project's issue", () => {
  const nextProject = "project-2";
  const failureReason = "First project's issue tracker is unavailable";
  const issue = decodeIssue({
    projectId: nextProject,
    projectTitle: "Second project",
    tracker: "github",
    host: "github.com",
    scope: "factory/second",
    key: "42",
    displayKey: "#42",
    title: "Second project's issue",
    url: "https://github.com/factory/second/issues/42",
    author: null,
    state: { name: "open", category: "open" },
    createdAt: AT,
    updatedAt: AT,
    closedAt: null,
    assignees: [],
    labels: [{ name: "factory", color: null }],
    commentCount: 0,
  });
  return withWorld(
    {
      ...script(),
      listIssues: Effect.fn("factoryPack.test.listIssues")(function* (
        query: WorkflowForge.IssueQuery,
      ) {
        if (query.project === PROJECT) {
          return yield* new WorkflowForge.WorkflowForgeError({ reason: failureReason });
        }
        expect(query.project).toBe(nextProject);
        return yield* Effect.succeed([issue]);
      }),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.test.intakeFailure")(function* (workflows) {
          for (const projectId of [PROJECT, nextProject]) {
            yield* workflows.storeSet(`factory/v1/intake/${projectId}`, {
              v: 1,
              enabled: true,
              labels: ["factory"],
              autoStart: false,
            });
          }
          const { runId } = yield* workflows.start(
            "factory-intake",
            { scheduledAt: AT },
            { idempotencyKey: "tick-with-failed-binding" },
          );
          const done = yield* world.ended(workflows, runId, true);
          expect(done.status).toBe("completed");
          const rows = yield* workflows.stored("factory/v1/task/");
          expect(rows).toHaveLength(1);
          const task = yield* decodeTask(rows[0]?.value).pipe(Effect.orDie);
          expect(yield* taskAt(workflows, task.id)).toEqual({
            v: 1,
            id: task.id,
            number: 1,
            rev: 1,
            projectId: nextProject,
            title: issue.title,
            description: issue.url,
            lane: "ready",
            laneSetAt: task.createdAt,
            parentId: null,
            blockedBy: [],
            assignee: null,
            model: null,
            source: { _tag: "issue", url: issue.url, displayKey: issue.displayKey },
            createdAt: task.createdAt,
            updatedAt: task.createdAt,
          });
          expect([task].filter((entry) => entry.projectId === PROJECT)).toEqual([]);
          expect(done.result).toEqual({
            captured: [{ taskId: task.id, number: 1, projectId: nextProject, issueKey: issue.key }],
            failed: [{ projectId: PROJECT, reason: expect.stringContaining(failureReason) }],
          });
          expect(yield* workflows.stored(`factory/v1/intake-seen/${PROJECT}/`)).toEqual([]);
          expect(
            yield* workflows.stored(`factory/v1/intake-seen/${nextProject}/${issue.key}`),
          ).toEqual([
            {
              key: `factory/v1/intake-seen/${nextProject}/${issue.key}`,
              value: { v: 1, taskId: task.id },
            },
          ]);
          expect(yield* workflows.stored("factory/v1/seq")).toEqual([
            { key: "factory/v1/seq", value: 1 },
          ]);
          expect(yield* workflows.stored("factory/v1/attempt/")).toEqual([]);
          expect(
            world.issueQueries.map((query) => ({ ...query, state: query.state ?? "open" })),
          ).toEqual([
            { project: PROJECT, state: "open", labels: ["factory"], limit: 50 },
            { project: nextProject, state: "open", labels: ["factory"], limit: 50 },
          ]);
          expect(done.tags ?? []).toEqual([]);
          expect(world.turns).toEqual([]);
          expectQuestions(world, []);
          expect(world.acts).toEqual([]);
          expect(world.reads).toEqual([]);
        }),
      ),
  );
});

it("capture stores its task marker and an idempotent start creates no second task", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.captureMarker")(function* (workflows) {
        const input = {
          title: "Idempotent capture",
          description: "Keep the task across retries.",
          projectId: PROJECT,
          parentId: null,
          blockedBy: [],
          lane: "ready",
          assignee: null,
          model: MODEL,
        };
        const options = { idempotencyKey: "capture-marker" };
        const first = yield* workflows.start("factory-capture", input, options);
        const done = yield* world.ended(workflows, first.runId, true);
        expect(done.status).toBe("completed");
        const captured = yield* decodeCapture(done.result).pipe(Effect.orDie);
        expect(done.result).toEqual({
          taskId: expect.stringMatching(UUID),
          number: 1,
          runId: null,
        });
        const marker = {
          key: `factory/v1/captured/${first.runId}/capture`,
          value: { v: 1, taskId: captured.taskId },
        };
        expect(yield* workflows.stored(`factory/v1/captured/${first.runId}/`)).toEqual([marker]);
        const task = yield* taskAt(workflows, captured.taskId);
        expect(task).toEqual({
          ...input,
          v: 1,
          id: captured.taskId,
          number: 1,
          rev: 1,
          source: { _tag: "local" },
          createdAt: task.createdAt,
          updatedAt: task.createdAt,
          laneSetAt: task.createdAt,
        });
        const again = yield* workflows.start("factory-capture", input, options);
        expect(again.runId).toBe(first.runId);
        expect((yield* world.ended(workflows, again.runId, true)).result).toEqual(done.result);
        expect(yield* workflows.stored("factory/v1/task/")).toEqual([
          {
            key: `factory/v1/task/${captured.taskId}`,
            value: task,
          },
        ]);
        expect(yield* workflows.stored("factory/v1/captured/")).toEqual([marker]);
        expect(yield* workflows.stored("factory/v1/seq")).toEqual([
          { key: "factory/v1/seq", value: 1 },
        ]);
        expect(yield* workflows.stored("factory/v1/attempt/")).toEqual([]);
        expect(done.tags ?? []).toEqual([]);
        expect(world.turns).toEqual([]);
        expectQuestions(world, []);
        expect(world.issueQueries).toEqual([]);
        expect(world.acts).toEqual([]);
        expect(world.reads).toEqual([]);
      }),
    ),
  ));

it("restart at the merge question replays no agent turn and merges exactly once", () =>
  withWorld(
    script(),
    Effect.fn("factoryPack.test.restart")(function* (world) {
      const waiting = yield* world.server(
        Effect.fn("factoryPack.test.beforeRestart")(function* (workflows) {
          const { runId } = yield* startTask(workflows);
          yield* approvePlan(world, workflows, runId);
          const child = yield* world.child(workflows, runId, 0);
          yield* ask(world, workflows, child.runId, "approve-merge", "merge", ["Merge", "Hold"]);
          expectTurns(world, runId, ["plan"]);
          expectTurns(world, child.runId, ["do", "scope/0", "review/0"]);
          expect(world.acts).toEqual([]);
          expectTags(world, (yield* workflows.get(child.runId)).run, "review");
          return { runId, childId: child.runId, keys: world.turns.map((turn) => turn.key) };
        }),
      );
      yield* world.server(
        Effect.fn("factoryPack.test.afterRestart")(function* (workflows) {
          yield* merge(world, workflows, waiting.childId);
          const done = yield* world.ended(workflows, waiting.runId);
          const child = yield* world.ended(workflows, waiting.childId);
          expectMerged(
            world,
            done,
            child,
            "https://github.com/factory/pack/pull/17",
            partStats({ asks: 1 }),
          );
          expect(world.turns.map((turn) => turn.key)).toEqual(waiting.keys);
          expect(world.turns).toHaveLength(4);
          expectQuestions(world, [
            [waiting.runId, "approve-plan", "plan"],
            [waiting.childId, "approve-merge", "merge"],
          ]);
          yield* expectNote(workflows, TASK_ID, [{ title: PART.title, outcome: "merged" }]);
        }),
      );
    }),
  ));

it("factory-start records attempts and refuses another start while the task run is active", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.start")(function* (workflows) {
        yield* workflows.storeSet("factory/v1/seq", TASK.number);
        yield* workflows.storeSet(`factory/v1/task/${TASK_ID}`, TASK);
        const first = yield* workflows.start(
          "factory-start",
          { taskId: TASK_ID },
          { idempotencyKey: "start-1" },
        );
        const firstDone = yield* world.ended(workflows, first.runId);
        expect(firstDone.status).toBe("completed");
        const started = yield* decodeStart(firstDone.result).pipe(Effect.orDie);
        expect(firstDone.result).toEqual({
          taskId: TASK_ID,
          attempt: 1,
          runId: expect.any(String),
        });
        yield* ask(world, workflows, started.runId, "approve-plan", "plan", ["Start", "Drop"]);
        const before = yield* taskAt(workflows, TASK_ID);
        const payload = {
          taskId: TASK_ID,
          number: TASK.number,
          attempt: 1,
          title: TASK.title,
          description: TASK.description,
          projectId: PROJECT,
          model: MODEL,
          issueUrl: null,
        };
        expect(
          (yield* workflows.start("factory-task", payload, {
            idempotencyKey: `task/${TASK_ID}/a1`,
          })).runId,
        ).toBe(started.runId);
        expect(before).toEqual({
          ...TASK,
          lane: "doing",
          rev: 2,
          updatedAt: before.updatedAt,
          laneSetAt: before.updatedAt,
        });
        expectTags(world, (yield* workflows.get(started.runId)).run, "planning");
        const attempts = yield* workflows.stored(`factory/v1/attempt/${TASK_ID}/`);
        expect(attempts).toEqual([
          {
            key: `factory/v1/attempt/${TASK_ID}/0001`,
            value: {
              v: 1,
              taskId: TASK_ID,
              n: 1,
              key: `task/${TASK_ID}/a1`,
              workflow: "factory-task",
              runId: started.runId,
              requestedBy: expect.any(String),
              startedAt: expect.stringMatching(ISO),
            },
          },
        ]);
        const second = yield* workflows.start(
          "factory-start",
          { taskId: TASK_ID },
          { idempotencyKey: "start-2" },
        );
        const refused = yield* world.ended(workflows, second.runId);
        expect(refused).toMatchObject({
          status: "stopped",
          detail: "already running",
          result: null,
        });
        expect(yield* taskAt(workflows, TASK_ID)).toEqual(before);
        expect(yield* workflows.stored(`factory/v1/attempt/${TASK_ID}/`)).toEqual(attempts);
        expect(
          (yield* workflows.list())
            .filter((run) => run.workflow === "factory-task")
            .map((run) => run.runId),
        ).toEqual([started.runId]);
        yield* workflows.answer(started.runId, "approve-plan", { choice: "Drop" });
        expect((yield* world.ended(workflows, started.runId)).status).toBe("stopped");
        const third = yield* workflows.start(
          "factory-start",
          { taskId: TASK_ID },
          { idempotencyKey: "start-3" },
        );
        const thirdDone = yield* world.ended(workflows, third.runId);
        expect(thirdDone.status).toBe("completed");
        const next = yield* decodeStart(thirdDone.result).pipe(Effect.orDie);
        expect(thirdDone.result).toEqual({
          taskId: TASK_ID,
          attempt: 2,
          runId: expect.any(String),
        });
        expect(next.runId).not.toBe(started.runId);
        yield* ask(world, workflows, next.runId, "approve-plan", "plan", ["Start", "Drop"]);
        const after = yield* taskAt(workflows, TASK_ID);
        expect(
          (yield* workflows.start(
            "factory-task",
            { ...payload, attempt: 2 },
            {
              idempotencyKey: `task/${TASK_ID}/a2`,
            },
          )).runId,
        ).toBe(next.runId);
        expect(after).toEqual({
          ...before,
          rev: 3,
          updatedAt: after.updatedAt,
          laneSetAt: after.updatedAt,
        });
        expect(yield* workflows.stored(`factory/v1/attempt/${TASK_ID}/0002`)).toEqual([
          {
            key: `factory/v1/attempt/${TASK_ID}/0002`,
            value: {
              v: 1,
              taskId: TASK_ID,
              n: 2,
              key: `task/${TASK_ID}/a2`,
              workflow: "factory-task",
              runId: next.runId,
              requestedBy: expect.any(String),
              startedAt: expect.stringMatching(ISO),
            },
          },
        ]);
        expectTurns(world, started.runId, ["plan"]);
        expectTurns(world, next.runId, ["plan"]);
        expect(world.turns).toHaveLength(2);
        expectQuestions(world, [
          [started.runId, "approve-plan", "plan"],
          [next.runId, "approve-plan", "plan"],
        ]);
        expectTags(world, (yield* workflows.get(next.runId)).run, "planning");
        expect(firstDone.tags ?? []).toEqual([]);
        expect(refused.tags ?? []).toEqual([]);
        expect(thirdDone.tags ?? []).toEqual([]);
        expect(world.acts).toEqual([]);
        expect(world.reads).toEqual([]);
        expect(world.issueQueries).toEqual([]);
        yield* workflows.answer(next.runId, "approve-plan", { choice: "Drop" });
        expect((yield* world.ended(workflows, next.runId)).status).toBe("stopped");
      }),
    ),
  ));

const decodeMergeQuestion = Schema.decodeUnknownEffect(
  Schema.Struct({
    title: Schema.String,
    choices: Schema.Array(Schema.String),
    kind: Schema.String,
  }),
);

effectIt.effect.each([
  {
    label: "signal then person",
    needsPerson: true,
    askMerge: true,
    first: "signal",
    second: "session",
    merged: true,
  },
  {
    label: "askMerge false still asks",
    needsPerson: true,
    askMerge: false,
    first: "answer",
    second: "session",
    merged: true,
  },
  {
    label: "second signal cannot approve",
    needsPerson: true,
    askMerge: true,
    first: "signal",
    second: "signal",
    merged: false,
  },
  {
    label: "second Hold stops",
    needsPerson: true,
    askMerge: true,
    first: "signal",
    second: "hold",
    merged: false,
  },
  {
    label: "second timeout stops",
    needsPerson: true,
    askMerge: true,
    first: "signal",
    second: "timeout",
    merged: false,
  },
  {
    label: "first person needs no second question",
    needsPerson: true,
    askMerge: false,
    first: "session",
    second: null,
    merged: true,
  },
  {
    label: "ordinary merge accepts a signal",
    needsPerson: false,
    askMerge: true,
    first: "signal",
    second: null,
    merged: true,
  },
] as const)("P1 $label", (entry) =>
  Effect.promise(() =>
    withWorld(script(), (world) =>
      world.server(
        Effect.fn("factoryPack.test.personOnly")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", {
            v: 1,
            askPlan: false,
            askMerge: entry.askMerge,
            mergeNeedsPerson: entry.needsPerson,
          });
          const { runId } = yield* startTask(workflows);
          const child = yield* world.child(workflows, runId, 0);
          const first = yield* ask(world, workflows, child.runId, "approve-merge", "merge", [
            "Merge",
            "Hold",
          ]);
          expect(world.acts).toEqual([]);
          if (entry.first === "signal") {
            yield* workflows.signal(
              { runId: child.runId, wait: first.name },
              { choice: "Merge" },
              {
                id: "agent-first-answer",
                answeredBy: "t3 workflow signal",
              },
            );
          } else {
            yield* workflows.answer(
              child.runId,
              first.name,
              { choice: "Merge" },
              entry.first === "session"
                ? { label: "Person", sessionId: "trusted-session" }
                : { label: "Agent without a session" },
            );
          }
          if (entry.second !== null) {
            const second = yield* ask(
              world,
              workflows,
              child.runId,
              "approve-merge/person",
              "merge",
              ["Merge", "Hold"],
            );
            expect(yield* decodeMergeQuestion(second.request).pipe(Effect.orDie)).toEqual(
              yield* decodeMergeQuestion(first.request).pipe(Effect.orDie),
            );
            expect(world.acts).toEqual([]);
            const previous = (yield* workflows.get(child.runId)).steps.find(
              (step) => step.name === first.name,
            );
            expect(previous?.result).not.toHaveProperty("answeredBySession");
            if (entry.second === "timeout") {
              yield* world.expireQuestion(workflows, child.runId, second.name);
            } else if (entry.second === "signal") {
              yield* workflows.signal(
                { runId: child.runId, wait: second.name },
                { choice: "Merge" },
                {
                  id: "agent-second-answer",
                  answeredBy: "t3 workflow signal",
                },
              );
            } else {
              yield* workflows.answer(
                child.runId,
                second.name,
                {
                  choice: entry.second === "hold" ? "Hold" : "Merge",
                },
                { label: "Person", sessionId: "trusted-session" },
              );
            }
          }
          const part = yield* world.ended(workflows, child.runId);
          const done = yield* world.ended(workflows, runId);
          expect(done.status).toBe("completed");
          // r9 M1: the merge gate is one ask however many questions it took; a part that did
          // not complete is listed with no statistics.
          expect(done.result).toEqual({
            parts: [
              {
                title: PART.title,
                outcome: entry.merged ? "merged" : "stopped",
                prUrl: entry.merged ? PR_URL : null,
                stats: entry.merged ? partStats({ asks: 1 }) : null,
              },
            ],
          });
          if (entry.merged) {
            expect(part).toMatchObject({
              status: "completed",
              result: { outcome: "merged", prUrl: PR_URL },
            });
            expect(world.acts).toEqual([
              [{ project: PROJECT, url: PR_URL }, "merge", { mergeMethod: "squash" }],
            ]);
            if (entry.needsPerson) {
              const name = entry.second === null ? first.name : "approve-merge/person";
              expect(
                (yield* workflows.get(child.runId)).steps.find((step) => step.name === name)
                  ?.result,
              ).toHaveProperty("answeredBySession", "trusted-session");
            }
          } else {
            expect(part).toMatchObject({ status: "stopped", detail: "merge held", result: null });
            expect(world.acts).toEqual([]);
          }
          expectQuestions(
            world,
            entry.second === null
              ? [[child.runId, "approve-merge", "merge"]]
              : [
                  [child.runId, "approve-merge", "merge"],
                  [child.runId, "approve-merge/person", "merge"],
                ],
          );
          expectTurns(world, runId, ["plan"]);
          expectTurns(world, child.runId, ["do", "scope/0", "review/0"]);
          expectTags(world, done, "done");
        }),
      ),
    ),
  ),
);

effectIt.effect.each(["own", "foreign", "unreadable"] as const)(
  "P2a reads an unlisted pull request: %s",
  (ownership) =>
    Effect.promise(() => {
      const answers = script();
      const foreignUrl = "https://github.com/other/repository/pull/17";
      const reportedUrl = ownership === "foreign" ? foreignUrl : PR_URL;
      const canonicalUrl = "https://github.com/Factory/Pack/pull/17";
      return withWorld(
        {
          ...answers,
          pullRequests: [pullRequestAt(99)],
          agent: (turn) =>
            turn.origin.step === "do"
              ? { output: { summary: "Implemented.", prUrl: reportedUrl } }
              : answers.agent(turn),
          readPullRequest: Effect.fn("factoryPack.test.readUnlisted")(function* (_address, detail) {
            if (ownership === "unreadable") {
              return yield* new WorkflowForge.WorkflowForgeError({
                reason: "Pull request read failed",
              });
            }
            return {
              ...detail,
              number: 17,
              repository: ownership === "foreign" ? "other/repository" : "factory/pack",
              url: ownership === "foreign" ? foreignUrl : canonicalUrl,
            };
          }),
        },
        (world) =>
          world.server(
            Effect.fn("factoryPack.test.unlistedPullRequest")(function* (workflows) {
              yield* workflows.storeSet("factory/v1/config", {
                v: 1,
                askPlan: false,
                askMerge: false,
              });
              const { runId } = yield* startTask(workflows);
              const child = yield* world.child(workflows, runId, 0);
              const part = yield* world.ended(workflows, child.runId, true);
              const done = yield* world.ended(workflows, runId, true);
              const { steps } = yield* workflows.get(child.runId);
              expect(world.pullRequestQueries).toHaveLength(1);
              expect(world.pullRequestQueries[0]).toMatchObject({ project: PROJECT, state: "all" });
              expect(steps.find((step) => step.name === "pull-request")?.status).toBe("completed");
              expectTurns(world, runId, ["plan"]);
              expectQuestions(world, []);
              if (ownership === "own") {
                expectMerged(world, done, part, canonicalUrl, partStats());
                expectTurns(world, child.runId, ["do", "scope/0", "review/0"]);
                // checks/0, risk-pr/0, head/0 (r9 L4.6), head-sha, merge.
                expect(world.readCalls).toEqual([
                  { project: PROJECT, url: reportedUrl },
                  { project: PROJECT, url: canonicalUrl },
                  { project: PROJECT, url: canonicalUrl },
                  { project: PROJECT, url: canonicalUrl },
                  { project: PROJECT, url: canonicalUrl },
                  { project: PROJECT, url: canonicalUrl },
                ]);
                expect(steps.find((step) => step.name === "checks/0")?.result).toMatchObject({
                  url: canonicalUrl,
                  checks: "passing",
                });
                expect(
                  world.turns.find((turn) => turn.origin.step === "review/0")?.prompt,
                ).toContain(canonicalUrl);
              } else {
                expect(part).toMatchObject({
                  status: "stopped",
                  detail: "pull request is not this project's",
                  result: null,
                });
                expect(done.status).toBe("completed");
                expect(done.result).toEqual({
                  parts: [{ title: PART.title, outcome: "stopped", prUrl: null, stats: null }],
                });
                expectTags(world, done, "done");
                expect(steps.filter((step) => step.kind === "wait")).toEqual([]);
                expectTurns(world, child.runId, ["do"]);
                expect(world.readCalls).toEqual([{ project: PROJECT, url: reportedUrl }]);
                expect(world.acts).toEqual([]);
              }
            }),
          ),
      );
    }),
);

effectIt.effect.each([
  { label: "case", url: PR_URL.toUpperCase(), accepted: true },
  { label: "trailing slash", url: `${PR_URL}/`, accepted: true },
  { label: "surrounding whitespace", url: `  ${PR_URL}/  `, accepted: true },
  { label: "blank", url: " \t ", accepted: false },
])("P2 handles $label in the reported URL", ({ url, accepted }) =>
  Effect.promise(() => {
    const answers = script();
    return withWorld(
      {
        ...answers,
        agent: (turn) =>
          turn.origin.step === "do"
            ? { output: { summary: "Implemented.", prUrl: url } }
            : answers.agent(turn),
      },
      (world) =>
        world.server(
          Effect.fn("factoryPack.test.pullRequestNormalization")(function* (workflows) {
            yield* workflows.storeSet("factory/v1/config", {
              v: 1,
              askPlan: false,
              askMerge: false,
            });
            const { runId } = yield* startTask(workflows);
            const done = yield* world.ended(workflows, runId, true);
            const child = yield* world.child(workflows, runId, 0);
            expect(done.status).toBe("completed");
            if (!accepted) {
              expect(child).toMatchObject({
                status: "stopped",
                detail: "pull request is not this project's",
                result: null,
              });
              expect(done.result).toEqual({
                parts: [{ title: PART.title, outcome: "stopped", prUrl: null, stats: null }],
              });
              expectTurns(world, child.runId, ["do"]);
              expect(
                (yield* workflows.get(child.runId)).steps.filter((step) => step.kind === "wait"),
              ).toEqual([]);
              expect(world.reads).toEqual([]);
              expect(world.acts).toEqual([]);
              return;
            }
            // r9 M1: the part's statistics, listed with it.
            expect(done.result).toEqual({
              parts: [{ title: PART.title, outcome: "merged", prUrl: PR_URL, stats: partStats() }],
            });
            expect(child.result).toEqual({ outcome: "merged", prUrl: PR_URL, stats: partStats() });
            expectTurns(world, child.runId, ["do", "scope/0", "review/0"]);
            expect(world.pullRequestQueries[0]).toMatchObject({ project: PROJECT, state: "all" });
            expect(world.reads.length).toBeGreaterThan(0);
            for (const read of world.reads) {
              expect(read.pullRequest).toEqual({ project: PROJECT, url: PR_URL });
            }
            expect(
              (yield* workflows.get(child.runId)).steps.find((step) => step.name === "checks/0")
                ?.result,
            ).toMatchObject({ url: PR_URL });
            const review = world.turns.find(
              (turn) => turn.origin.runId === child.runId && turn.origin.step === "review/0",
            );
            expect(review?.prompt).toContain(PR_URL);
            expect(review?.prompt).not.toContain(url);
            expect(world.acts).toEqual([
              [{ project: PROJECT, url: PR_URL }, "merge", { mergeMethod: "squash" }],
            ]);
          }),
        ),
    );
  }),
);

it("P2a reads an unlisted pull request through a lowercase GitHub URL", () => {
  const answers = script();
  const reportedUrl = PR_URL.toUpperCase();
  const canonicalUrl = "https://github.com/Factory/Pack/pull/17";
  return withWorld(
    {
      ...answers,
      pullRequests: [pullRequestAt(99)],
      agent: (turn) =>
        turn.origin.step === "do"
          ? { output: { summary: "Implemented.", prUrl: reportedUrl } }
          : answers.agent(turn),
      readPullRequest: (_address, detail) =>
        Effect.succeed({ ...detail, number: 17, repository: "factory/pack", url: canonicalUrl }),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.test.uppercaseUnlisted")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false, askMerge: false });
          const { runId } = yield* startTask(workflows);
          const child = yield* world.child(workflows, runId, 0);
          const part = yield* world.ended(workflows, child.runId, true);
          const done = yield* world.ended(workflows, runId, true);
          expectMerged(world, done, part, canonicalUrl, partStats());
          const [fallback, ...rest] = world.readCalls;
          expect(fallback).toMatchObject({
            project: PROJECT,
            url: expect.stringMatching(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/17$/),
          });
          expect(rest.length).toBeGreaterThan(0);
          expect(rest).toEqual(rest.map(() => ({ project: PROJECT, url: canonicalUrl })));
        }),
      ),
  );
});

effectIt.effect.each([
  { label: "global", key: "factory/v1/config" },
  { label: "project", key: `factory/v1/config/${PROJECT}` },
  { label: "absent", key: null },
])("P3 $label config row", ({ key }) =>
  Effect.promise(() =>
    withWorld(script(), (world) =>
      world.server(
        Effect.fn("factoryPack.test.invalidConfig")(function* (workflows) {
          if (key !== null) yield* workflows.storeSet(key, { v: 1, askPlan: "yes" });
          const { runId } = yield* startTask(workflows);
          if (key === null) {
            yield* ask(world, workflows, runId, "approve-plan", "plan", ["Start", "Drop"]);
            yield* workflows.answer(runId, "approve-plan", { choice: "Drop" });
            expect((yield* world.ended(workflows, runId)).status).toBe("stopped");
            expect(
              (yield* workflows.get(runId)).steps.find((step) => step.name === "config")?.result,
            ).toEqual(DEFAULT_CONFIG);
          } else {
            const paused = yield* workflows.waitFor(
              runId,
              (run) => run.status === "paused" || run.endedAt !== null,
            );
            expect(paused.status).toBe("paused");
            expect(paused.detail).toContain(key);
            const config = (yield* workflows.get(runId)).steps.find(
              (step) => step.name === "config",
            );
            expect(config?.status).toBe("failed");
            expect(config?.detail).toContain(key);
            expect(world.turns).toEqual([]);
            expectQuestions(world, []);
          }
          expect(world.acts).toEqual([]);
        }),
      ),
    ),
  ),
);

it("P4 does not start a dropped task", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.droppedStart")(function* (workflows) {
        const dropped = { ...TASK, lane: "dropped" };
        yield* workflows.storeSet(`factory/v1/task/${TASK_ID}`, dropped);
        const { runId } = yield* workflows.start(
          "factory-start",
          { taskId: TASK_ID },
          { idempotencyKey: "dropped" },
        );
        const done = yield* world.ended(workflows, runId, true);
        expect(done).toMatchObject({ status: "stopped", detail: "task is dropped", result: null });
        expect(yield* taskAt(workflows, TASK_ID)).toEqual(dropped);
        expect(yield* workflows.stored(`factory/v1/attempt/${TASK_ID}/`)).toEqual([]);
        expect((yield* workflows.list()).filter((run) => run.workflow === "factory-task")).toEqual(
          [],
        );
        expect(world.turns).toEqual([]);
      }),
    ),
  ));

it("P4 a null-run attempt above a live run cannot start twice and is reused after that run ends", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.pendingAttempt")(function* (workflows) {
        yield* workflows.storeSet(`factory/v1/task/${TASK_ID}`, TASK);
        const first = yield* workflows.start(
          "factory-start",
          { taskId: TASK_ID },
          { idempotencyKey: "pending-first" },
        );
        const started = yield* decodeStart(
          (yield* world.ended(workflows, first.runId)).result,
        ).pipe(Effect.orDie);
        yield* ask(world, workflows, started.runId, "approve-plan", "plan", ["Start", "Drop"]);
        const pending = {
          v: 1,
          taskId: TASK_ID,
          n: 2,
          key: `task/${TASK_ID}/a2`,
          workflow: "factory-task",
          runId: null,
          requestedBy: "test",
          startedAt: AT,
        };
        yield* workflows.storeSet(`factory/v1/attempt/${TASK_ID}/0002`, pending);
        const denied = yield* workflows.start(
          "factory-start",
          { taskId: TASK_ID },
          { idempotencyKey: "pending-denied" },
        );
        expect(yield* world.ended(workflows, denied.runId)).toMatchObject({
          status: "stopped",
          detail: "already running",
          result: null,
        });
        expect(yield* workflows.stored(`factory/v1/attempt/${TASK_ID}/0002`)).toEqual([
          {
            key: `factory/v1/attempt/${TASK_ID}/0002`,
            value: pending,
          },
        ]);
        expect(
          (yield* workflows.list()).filter((run) => run.workflow === "factory-task"),
        ).toHaveLength(1);
        yield* workflows.answer(started.runId, "approve-plan", { choice: "Drop" });
        yield* world.ended(workflows, started.runId);
        const resumed = yield* workflows.start(
          "factory-start",
          { taskId: TASK_ID },
          { idempotencyKey: "pending-reuse" },
        );
        const next = yield* decodeStart((yield* world.ended(workflows, resumed.runId)).result).pipe(
          Effect.orDie,
        );
        expect(next).toEqual({ taskId: TASK_ID, attempt: 2, runId: expect.any(String) });
        expect(next.runId).not.toBe(started.runId);
        const attempts = yield* workflows.stored(`factory/v1/attempt/${TASK_ID}/`);
        expect(attempts.map((row) => row.key)).toEqual([
          `factory/v1/attempt/${TASK_ID}/0001`,
          `factory/v1/attempt/${TASK_ID}/0002`,
        ]);
        expect(attempts[1]?.value).toMatchObject({ n: 2, key: pending.key, runId: next.runId });
        yield* ask(world, workflows, next.runId, "approve-plan", "plan", ["Start", "Drop"]);
        yield* workflows.answer(next.runId, "approve-plan", { choice: "Drop" });
        yield* world.ended(workflows, next.runId);
      }),
    ),
  ));

it("P4 concurrent starts with distinct keys serialize one task start", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.concurrentStart")(function* (workflows) {
        yield* workflows.storeSet(`factory/v1/task/${TASK_ID}`, TASK);
        const starts = yield* Effect.forEach(
          ["left", "right"],
          (key) => workflows.start("factory-start", { taskId: TASK_ID }, { idempotencyKey: key }),
          { concurrency: "unbounded" },
        );
        const ends = yield* Effect.forEach(starts, ({ runId }) => world.ended(workflows, runId), {
          concurrency: "unbounded",
        });
        expect(ends.map((run) => run.status).toSorted()).toEqual(["completed", "stopped"]);
        expect(ends.find((run) => run.status === "stopped")).toMatchObject({
          detail: "already running",
          result: null,
        });
        const completed = ends.find((run) => run.status === "completed");
        const started = yield* decodeStart(completed?.result).pipe(Effect.orDie);
        expect(started).toEqual({ taskId: TASK_ID, attempt: 1, runId: expect.any(String) });
        expect(
          (yield* workflows.list())
            .filter((run) => run.workflow === "factory-task")
            .map((run) => run.runId),
        ).toEqual([started.runId]);
        expect(yield* workflows.stored(`factory/v1/attempt/${TASK_ID}/`)).toHaveLength(1);
        expect(yield* taskAt(workflows, TASK_ID)).toMatchObject({ lane: "doing", rev: 2 });
        yield* ask(world, workflows, started.runId, "approve-plan", "plan", ["Start", "Drop"]);
        yield* workflows.answer(started.runId, "approve-plan", { choice: "Drop" });
        yield* world.ended(workflows, started.runId);
      }),
    ),
  ));

it("P4 intake autoStart writes the attempt and starts its task", () =>
  withWorld(script({ issues: [issueAt("31")] }), (world) =>
    world.server(
      Effect.fn("factoryPack.test.autoStart")(function* (workflows) {
        yield* workflows.storeSet(`factory/v1/intake/${PROJECT}`, {
          v: 1,
          enabled: true,
          labels: [],
          autoStart: true,
        });
        const { runId } = yield* workflows.start(
          "factory-intake",
          { scheduledAt: AT },
          { idempotencyKey: "auto-start" },
        );
        const done = yield* world.ended(workflows, runId);
        expect(done.status).toBe("completed");
        const attempts = yield* workflows.stored("factory/v1/attempt/");
        expect(attempts).toHaveLength(1);
        const attempt = yield* decodeAttempt(attempts[0]?.value).pipe(Effect.orDie);
        expect(attempt).toMatchObject({
          n: 1,
          key: `task/${attempt.taskId}/a1`,
          workflow: "factory-task",
        });
        if (attempt.runId === null) throw new Error("autoStart did not start the task");
        expect(done.result).toEqual({
          captured: [{ taskId: attempt.taskId, number: 1, projectId: PROJECT, issueKey: "31" }],
          failed: [],
        });
        expect(yield* taskAt(workflows, attempt.taskId)).toMatchObject({ lane: "doing", rev: 2 });
        yield* ask(world, workflows, attempt.runId, "approve-plan", "plan", ["Start", "Drop"]);
        expect((yield* workflows.get(attempt.runId)).run.workflow).toBe("factory-task");
        yield* workflows.answer(attempt.runId, "approve-plan", { choice: "Drop" });
        yield* world.ended(workflows, attempt.runId);
      }),
    ),
  ));

const invalidCaptures: ReadonlyArray<{ label: string; input: Schema.JsonObject }> = [
  { label: "blank title", input: { title: " \t " } },
  { label: "blank project id", input: { title: "Task", projectId: " \t " } },
  {
    label: "blank instance id",
    input: { title: "Task", model: { instanceId: " ", model: "worker" } },
  },
  {
    label: "malformed instance id",
    input: { title: "Task", model: { instanceId: "bad.instance", model: "worker" } },
  },
  {
    label: "instance id starts with a number",
    input: { title: "Task", model: { instanceId: "1bad", model: "worker" } },
  },
  {
    label: "overlong instance id",
    input: { title: "Task", model: { instanceId: "x".repeat(65), model: "worker" } },
  },
  { label: "blank model", input: { title: "Task", model: { instanceId: "codex", model: " " } } },
  {
    label: "blank option id",
    input: { title: "Task", model: { ...MODEL, options: [{ id: " ", value: "high" }] } },
  },
  {
    label: "blank option value",
    input: { title: "Task", model: { ...MODEL, options: [{ id: "effort", value: " " }] } },
  },
  { label: "overlong title", input: { title: "x".repeat(201) } },
  { label: "overlong description", input: { title: "Task", description: "x".repeat(8001) } },
  { label: "overlong assignee", input: { title: "Task", assignee: "x".repeat(101) } },
  { label: "unknown kind", input: { title: "Task", kind: "poem" } },
];

effectIt.effect.each(invalidCaptures)(
  "P5 $label returns a problem and writes nothing",
  ({ input }) =>
    Effect.promise(() =>
      withWorld(script(), (world) =>
        world.server(
          Effect.fn("factoryPack.test.invalidCapture")(function* (workflows) {
            const { runId } = yield* workflows.start("factory-capture", input, {
              idempotencyKey: "invalid-capture",
            });
            const done = yield* world.ended(workflows, runId, true);
            expect(done.status).toBe("completed");
            const problem = yield* decodeProblem(done.result).pipe(Effect.orDie);
            expect(done.result).toEqual(problem);
            expect(problem.problem.trim().length).toBeGreaterThan(0);
            expect(yield* workflows.stored("factory/v1/")).toEqual([]);
            expect(world.turns).toEqual([]);
            expect(world.acts).toEqual([]);
          }),
        ),
      ),
    ),
);

const BAD_TASK_ID = "30000000-0000-4000-8000-000000000001";
const damagedReferences: ReadonlyArray<{ label: string; input: Schema.JsonObject }> = [
  { label: "parent", input: { title: "Child task", parentId: BAD_TASK_ID } },
  { label: "blocker", input: { title: "Blocked task", blockedBy: [BAD_TASK_ID] } },
];

effectIt.effect.each(damagedReferences)(
  "H4 a damaged $label task returns a problem and writes no task",
  ({ input }) =>
    Effect.promise(() =>
      withWorld(script(), (world) =>
        world.server(
          Effect.fn("factoryPack.test.damagedReference")(function* (workflows) {
            const damaged = {
              key: `factory/v1/task/${BAD_TASK_ID}`,
              value: { v: 1, broken: true },
            };
            yield* workflows.storeSet(damaged.key, damaged.value);
            const { runId } = yield* workflows.start("factory-capture", input, {
              idempotencyKey: "damaged-reference",
            });
            const done = yield* world.ended(workflows, runId, true);
            expect(done.status).toBe("completed");
            const problem = yield* decodeProblem(done.result).pipe(Effect.orDie);
            expect(done.result).toEqual(problem);
            expect(problem.problem.trim().length).toBeGreaterThan(0);
            expect(yield* workflows.stored("factory/v1/task/")).toEqual([damaged]);
            expect(world.turns).toEqual([]);
            yield* workflows.storeDelete(damaged.key);
          }),
        ),
      ),
    ),
);

effectIt.effect.each([
  { label: "negative", seq: -1 },
  { label: "fraction", seq: 1.5 },
  { label: "string", seq: "2" },
  { label: "null", seq: null },
])("P6 repairs a $label counter using stored tasks", ({ seq }) =>
  Effect.promise(() =>
    withWorld(script(), (world) =>
      world.server(
        Effect.fn("factoryPack.test.counter")(function* (workflows) {
          for (const number of [1, 2]) {
            const id = `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
            yield* workflows.storeSet(`factory/v1/task/${id}`, { ...TASK, id, number });
          }
          yield* workflows.storeSet("factory/v1/seq", seq);
          const { runId } = yield* workflows.start(
            "factory-capture",
            { title: "Third task" },
            { idempotencyKey: "repair-counter" },
          );
          const done = yield* world.ended(workflows, runId, true);
          expect(done.status).toBe("completed");
          expect(done.result).toEqual({
            taskId: expect.stringMatching(UUID),
            number: 3,
            runId: null,
          });
          expect(yield* workflows.stored("factory/v1/seq")).toEqual([
            { key: "factory/v1/seq", value: 3 },
          ]);
          expect(yield* workflows.stored("factory/v1/task/")).toHaveLength(3);
        }),
      ),
    ),
  ),
);

it("P7 a blank issue title falls back to its display key", () => {
  const issue = { ...issueAt("51"), title: " \t " };
  return withWorld(script({ issues: [issue] }), (world) =>
    world.server(
      Effect.fn("factoryPack.test.blankIssueTitle")(function* (workflows) {
        yield* workflows.storeSet(`factory/v1/intake/${PROJECT}`, {
          v: 1,
          enabled: true,
          labels: [],
          autoStart: false,
        });
        const { runId } = yield* workflows.start(
          "factory-intake",
          { scheduledAt: AT },
          { idempotencyKey: "blank-title" },
        );
        const done = yield* world.ended(workflows, runId, true);
        expect(done.status).toBe("completed");
        const rows = yield* workflows.stored("factory/v1/task/");
        expect(rows).toHaveLength(1);
        const task = yield* decodeTask(rows[0]?.value).pipe(Effect.orDie);
        expect(task.title).toBe(issue.displayKey);
        expect(task.source).toEqual({
          _tag: "issue",
          url: issue.url,
          displayKey: issue.displayKey,
        });
        expect(done.result).toEqual({
          captured: [{ taskId: task.id, number: 1, projectId: PROJECT, issueKey: issue.key }],
          failed: [],
        });
      }),
    ),
  );
});

it("P7 captures the first 200 characters of an overlong issue title", () => {
  const title = `${"x".repeat(200)}z`;
  const issue = issueAt("52", PROJECT, title);
  return withWorld(script({ issues: [issue] }), (world) =>
    world.server(
      Effect.fn("factoryPack.test.longIssueTitle")(function* (workflows) {
        yield* workflows.storeSet(`factory/v1/intake/${PROJECT}`, {
          v: 1,
          enabled: true,
          labels: [],
          autoStart: false,
        });
        const { runId } = yield* workflows.start(
          "factory-intake",
          { scheduledAt: AT },
          { idempotencyKey: "long-issue-title" },
        );
        const done = yield* world.ended(workflows, runId, true);
        expect(done.status).toBe("completed");
        const rows = yield* workflows.stored("factory/v1/task/");
        expect(rows).toHaveLength(1);
        const task = yield* decodeTask(rows[0]?.value).pipe(Effect.orDie);
        expect(task.title).toBe(title.slice(0, 200));
        expect(done.result).toEqual({
          captured: [{ taskId: task.id, number: 1, projectId: PROJECT, issueKey: issue.key }],
          failed: [],
        });
      }),
    ),
  );
});

it("P7 a failed issue capture leaves the next issue and next binding runnable", () => {
  const broken = issueAt("61");
  const sameBinding = issueAt("62");
  const nextBinding = issueAt("63", "project-2");
  return withWorld(
    {
      ...script(),
      failIssueCapture: { projectId: PROJECT, issueKey: broken.key },
      listIssues: (query) =>
        Effect.succeed(query.project === PROJECT ? [broken, sameBinding] : [nextBinding]),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.test.failedIssue")(function* (workflows) {
          for (const projectId of [PROJECT, "project-2"]) {
            yield* workflows.storeSet(`factory/v1/intake/${projectId}`, {
              v: 1,
              enabled: true,
              labels: [],
              autoStart: false,
            });
          }
          const { runId } = yield* workflows.start(
            "factory-intake",
            { scheduledAt: AT },
            { idempotencyKey: "failed-issue" },
          );
          const done = yield* world.ended(workflows, runId, true);
          expect(done.status).toBe("completed");
          const rows = yield* workflows.stored("factory/v1/task/");
          const tasks = rows
            .map((row) => decodeTaskSync(row.value))
            .toSorted((a, b) => a.number - b.number);
          expect(tasks).toHaveLength(2);
          expect(tasks.map((task) => [task.projectId, task.title, task.number])).toEqual([
            [PROJECT, sameBinding.title, 1],
            ["project-2", nextBinding.title, 2],
          ]);
          expect(done.result).toEqual({
            captured: tasks.map((task, index) => ({
              taskId: task.id,
              number: index + 1,
              projectId: task.projectId,
              issueKey: index === 0 ? sameBinding.key : nextBinding.key,
            })),
            failed: [{ projectId: PROJECT, reason: expect.stringMatching(/\S/) }],
          });
          expect(
            yield* workflows.stored(`factory/v1/intake-seen/${PROJECT}/${broken.key}`),
          ).toEqual([]);
          expect(yield* workflows.stored("factory/v1/intake-seen/")).toHaveLength(2);
          expect(world.issueQueries.map((query) => query.project)).toEqual([PROJECT, "project-2"]);
        }),
      ),
  );
});

const SIX_PARTS = Array.from({ length: 6 }, (_, index) => ({
  title: `Part ${index}`,
  brief: `Implement independent part ${index}.`,
}));

const heldPair = Effect.fn("factoryPack.test.heldPair")(function* (
  world: World,
  workflows: Service,
  children: ReadonlyArray<WorkflowRun>,
  step: string,
) {
  const settled = yield* Effect.forEach(
    children,
    (child) =>
      workflows.waitFor(
        child.runId,
        (run) =>
          run.detail === `agent ${step}` ||
          run.detail === `queue factory-task:${TASK_ID}` ||
          run.status === "paused" ||
          run.endedAt !== null,
      ),
    { concurrency: "unbounded" },
  );
  expect(settled.map((run) => run.status)).toEqual(Array.from({ length: 6 }, () => "waiting"));
  const first = yield* world.nextTurn;
  const second = yield* world.nextTurn;
  expect([first.origin.step, second.origin.step]).toEqual([step, step]);
  expect(Math.max(...world.activeCounts)).toBe(2);
  return [first, second] as const;
});

effectIt.effect.each(["person", "checks"] as const)(
  "P8 six parts release their two agent slots while waiting on %s",
  (waitingOn) =>
    Effect.promise(() => {
      const answers = pushingFixes(
        script({ parts: SIX_PARTS, noPullRequest: waitingOn === "person" }),
      );
      return withWorld(
        {
          ...answers,
          holdAgent: (turn) => turn.origin.step !== "plan",
          standing: (pr, read) => ({
            ...answers.standing(pr, read),
            checks: waitingOn === "checks" ? "pending" : "passing",
          }),
        },
        (world) =>
          world.server(
            Effect.fn("factoryPack.test.slots")(function* (workflows) {
              yield* workflows.storeSet("factory/v1/config", {
                v: 1,
                concurrency: 2,
                askPlan: false,
                askMerge: false,
              });
              const { runId } = yield* startTask(workflows);
              expect((yield* world.nextTurn).origin.step).toBe("plan");
              const allChildren = yield* Effect.forEach(
                SIX_PARTS,
                (_, index) => world.child(workflows, runId, index),
                { concurrency: "unbounded" },
              );
              const [first, second] = yield* heldPair(world, workflows, allChildren, "do");
              yield* world.releaseTurn(first);
              if (waitingOn === "person") {
                yield* ask(world, workflows, first.origin.runId, "accept", "accept", [
                  "Accept",
                  "Redo",
                ]);
              } else {
                const waiting = yield* workflows.waitFor(
                  first.origin.runId,
                  (run) =>
                    run.detail === "checks/0" || run.status === "paused" || run.endedAt !== null,
                );
                expect(waiting).toMatchObject({ status: "waiting", detail: "checks/0" });
              }
              const third = yield* world.nextTurn;
              expect(third.origin.step).toBe("do");
              expect(
                new Set([first.origin.runId, second.origin.runId, third.origin.runId]).size,
              ).toBe(3);
              const work = [first, second, third];
              yield* world.releaseTurn(second);
              yield* world.releaseTurn(third);
              for (const index of [3, 4, 5]) {
                const turn = yield* world.nextTurn;
                expect(turn.origin.step, `part ${index}`).toBe("do");
                work.push(turn);
                yield* world.releaseTurn(turn);
              }
              for (const turn of work) {
                if (waitingOn === "person") {
                  yield* ask(world, workflows, turn.origin.runId, "accept", "accept", [
                    "Accept",
                    "Redo",
                  ]);
                  yield* workflows.answer(turn.origin.runId, "accept", { choice: "Accept" });
                } else {
                  yield* workflows.waitFor(turn.origin.runId, (run) => run.detail === "checks/0");
                  const url = answers.urls.get(turn.origin.runId);
                  if (typeof url !== "string")
                    throw new Error("Expected the do turn's pull request");
                  yield* workflows.signal(
                    { runId: turn.origin.runId, wait: "checks/0" },
                    {
                      state: "open",
                      checks: "failing",
                      mergeability: "mergeable",
                      url,
                    },
                    { id: `checks-failed-${turn.key}` },
                  );
                }
              }
              if (waitingOn === "checks") {
                const fixes = yield* heldPair(world, workflows, allChildren, "fix/0");
                for (const fix of fixes) yield* world.releaseTurn(fix);
                for (const index of [2, 3, 4, 5]) {
                  const fix = yield* world.nextTurn;
                  expect(fix.origin.step, `fix ${index}`).toBe("fix/0");
                  yield* world.releaseTurn(fix);
                }
                for (const turn of work) {
                  yield* workflows.waitFor(turn.origin.runId, (run) => run.detail === "checks/1");
                  const url = answers.urls.get(turn.origin.runId);
                  if (typeof url !== "string")
                    throw new Error("Expected the do turn's pull request");
                  yield* workflows.signal(
                    { runId: turn.origin.runId, wait: "checks/1" },
                    {
                      state: "open",
                      checks: "passing",
                      mergeability: "mergeable",
                      url,
                    },
                    { id: `checks-passed-${turn.key}` },
                  );
                }
                const scopes = yield* heldPair(world, workflows, allChildren, "scope/1");
                for (const scope of scopes) yield* world.releaseTurn(scope);
                for (let index = scopes.length; index < SIX_PARTS.length * 2; index++) {
                  const turn = yield* world.nextTurn;
                  expect(["scope/1", "review/1"]).toContain(turn.origin.step);
                  yield* world.releaseTurn(turn);
                }
              }
              const done = yield* world.ended(workflows, runId);
              expect(done.status).toBe("completed");
              const children = (yield* workflows.list())
                .filter((run) => run.parentRunId === runId)
                .toSorted((a, b) => (a.parentStep ?? "").localeCompare(b.parentStep ?? ""));
              expect(children).toHaveLength(6);
              expect(children.map((run) => run.status)).toEqual(
                Array.from({ length: 6 }, () => "completed"),
              );
              // r9 M1: an accepted part has no tier and no review; a merged one had a fix round
              // before its one review (see "failing checks continue" for the ambiguity).
              expect(done.result).toEqual({
                parts: SIX_PARTS.map((part, index) => ({
                  title: part.title,
                  outcome: waitingOn === "person" ? "accepted" : "merged",
                  prUrl:
                    waitingOn === "person" ? null : answers.urls.get(children[index]?.runId ?? ""),
                  stats: waitingOn === "person" ? ACCEPTED_STATS : partStats({ fixRounds: 1 }),
                })),
              });
              if (waitingOn === "checks") {
                for (const child of children) {
                  expectTurns(world, child.runId, ["do", "fix/0", "scope/1", "review/1"]);
                }
              }
              expect(Math.max(...world.activeCounts)).toBe(2);
              expect(world.activeCounts.every((count) => count <= 2)).toBe(true);
              expect(world.acts).toHaveLength(waitingOn === "person" ? 0 : 6);
            }),
          ),
      );
    }),
);

it("P8 a paused part does not hold an agent slot or block the other five parts", () => {
  const answers = script({ parts: SIX_PARTS });
  let refuse = true;
  return withWorld(
    {
      ...answers,
      listPullRequests: Effect.fn("factoryPack.test.pauseListing")(function* () {
        if (refuse) {
          refuse = false;
          return yield* new WorkflowForge.WorkflowForgeError({
            reason: "Injected pull-request lookup failure",
          });
        }
        return yield* Effect.succeed(answers.pullRequests);
      }),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.test.pausedSlot")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", {
            v: 1,
            concurrency: 2,
            askPlan: false,
            askMerge: false,
          });
          const { runId } = yield* startTask(workflows);
          const children = yield* Effect.forEach(
            SIX_PARTS,
            (_, index) => world.child(workflows, runId, index),
            { concurrency: "unbounded" },
          );
          const settled = yield* Effect.forEach(
            children,
            (child) =>
              workflows.waitFor(
                child.runId,
                (run) => run.status === "paused" || run.endedAt !== null,
              ),
            { concurrency: "unbounded" },
          );
          const paused = settled.filter((run) => run.status === "paused");
          expect(paused).toHaveLength(1);
          expect(settled.filter((run) => run.status === "completed")).toHaveLength(5);
          expect(world.acts).toHaveLength(5);
          expect((yield* workflows.get(runId)).run.endedAt).toBeNull();
          expect(world.activeCounts.every((count) => count <= 2)).toBe(true);
          const stuck = paused[0];
          if (stuck === undefined) throw new Error("Expected the injected lookup to pause a part");
          expect(
            (yield* workflows.get(stuck.runId)).steps.find((step) => step.name === "pull-request")
              ?.status,
          ).toBe("failed");
          yield* workflows.resume(stuck.runId);
          expect((yield* world.ended(workflows, runId)).status).toBe("completed");
          expect(world.acts).toHaveLength(6);
        }),
      ),
  );
});

it("P9 retrying finish after a committed note writes exactly one note", () =>
  withWorld({ ...script(), failFinishAfterCommit: true }, (world) =>
    world.server(
      Effect.fn("factoryPack.test.finishReplay")(function* (workflows) {
        yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false, askMerge: false });
        const { runId } = yield* startTask(workflows);
        const paused = yield* workflows.waitFor(
          runId,
          (run) => run.status === "paused" || run.endedAt !== null,
        );
        expect(paused.status).toBe("paused");
        expect(paused.detail).toContain("Injected failure after finish committed");
        expect(
          (yield* workflows.get(runId)).steps.find((step) => step.name === "finish")?.status,
        ).toBe("failed");
        const notes = yield* workflows.stored(`factory/v1/note/${TASK_ID}/`);
        expect(notes).toHaveLength(1);
        expect(yield* workflows.stored(`factory/v1/captured/${runId}/finish`)).toEqual([
          {
            key: `factory/v1/captured/${runId}/finish`,
            value: { v: 1, taskId: TASK_ID },
          },
        ]);
        expect(world.finishExecutions).toEqual([runId]);
        const turns = world.turns.map((turn) => turn.key);
        yield* workflows.resume(runId);
        const done = yield* world.ended(workflows, runId);
        expect(done.status).toBe("completed");
        expect(done.result).toEqual({
          parts: [{ title: PART.title, outcome: "merged", prUrl: PR_URL, stats: partStats() }],
        });
        expect(world.finishExecutions).toEqual([runId, runId]);
        expect(yield* workflows.stored(`factory/v1/note/${TASK_ID}/`)).toEqual(notes);
        expect(world.turns.map((turn) => turn.key)).toEqual(turns);
        expect(world.acts).toHaveLength(1);
      }),
    ),
  ));

effectIt.effect.each([
  { workflow: "factory-start", seeded: true, input: { taskId: TASK_ID } },
  {
    workflow: "factory-capture",
    seeded: false,
    input: {
      title: "Replayed capture",
      description: "Start the task once.",
      projectId: PROJECT,
      parentId: null,
      blockedBy: [],
      lane: "ready",
      assignee: null,
      model: MODEL,
      start: true,
    },
  },
] as const)("H2 replaying $workflow after its attempt committed starts no second run", (entry) =>
  Effect.promise(() =>
    withWorld({ ...script(), failStartAfterCommit: true }, (world) =>
      world.server(
        Effect.fn("factoryPack.test.startReplay")(function* (workflows) {
          if (entry.seeded) {
            yield* workflows.storeSet("factory/v1/seq", TASK.number);
            yield* workflows.storeSet(`factory/v1/task/${TASK_ID}`, TASK);
          }
          const { runId } = yield* workflows.start(entry.workflow, entry.input, {
            idempotencyKey: "start-replay",
          });
          const paused = yield* workflows.waitFor(
            runId,
            (run) => run.status === "paused" || run.endedAt !== null,
          );
          expect(paused.status).toBe("paused");
          expect(paused.detail).toContain("Injected failure after start committed");
          expect(world.startExecutions).toEqual([runId]);
          const attempts = yield* workflows.stored("factory/v1/attempt/");
          expect(attempts).toHaveLength(1);
          const attempt = yield* decodeAttempt(attempts[0]?.value).pipe(Effect.orDie);
          if (attempt.runId === null) throw new Error("the start step did not record its run");
          yield* ask(world, workflows, attempt.runId, "approve-plan", "plan", ["Start", "Drop"]);
          yield* workflows.answer(attempt.runId, "approve-plan", { choice: "Drop" });
          const dropped = yield* workflows.waitFor(attempt.runId, (run) => run.endedAt !== null);
          expect(dropped.status).toBe("stopped");
          yield* workflows.resume(runId);
          const done = yield* world.ended(workflows, runId);
          expect(done.status).toBe("completed");
          expect(done.result).toMatchObject({ taskId: attempt.taskId, runId: attempt.runId });
          expect(world.startExecutions).toEqual([runId, runId]);
          expect(yield* workflows.stored("factory/v1/attempt/")).toEqual(attempts);
          expect(
            (yield* workflows.list())
              .filter((run) => run.workflow === "factory-task")
              .map((run) => run.runId),
          ).toEqual([attempt.runId]);
          expect(world.turns).toHaveLength(1);
        }),
      ),
    ),
  ),
);

it("P10 merge reads the PR again and does not act when it is already merged", () => {
  const answers = script();
  let merged = false;
  return withWorld(
    {
      ...answers,
      standing: (pr, read) => ({
        ...answers.standing(pr, read),
        state: merged ? "merged" : "open",
      }),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.test.alreadyMerged")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false });
          const { runId } = yield* startTask(workflows);
          const child = yield* world.child(workflows, runId, 0);
          yield* ask(world, workflows, child.runId, "approve-merge", "merge", ["Merge", "Hold"]);
          merged = true;
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" });
          const done = yield* world.ended(workflows, runId);
          expect(done.status).toBe("completed");
          // r9 M1: the merge question was the part's one ask.
          expect(done.result).toEqual({
            parts: [
              {
                title: PART.title,
                outcome: "merged",
                prUrl: PR_URL,
                stats: partStats({ asks: 1 }),
              },
            ],
          });
          expect((yield* workflows.get(child.runId)).run.result).toEqual({
            outcome: "merged",
            prUrl: PR_URL,
            stats: partStats({ asks: 1 }),
          });
          // checks/0, risk-pr/0, head/0 (r9 L4.6), head-sha, then merge.
          expect(world.reads.map((read) => read.standing.state)).toEqual([
            "open",
            "open",
            "open",
            "open",
            "merged",
          ]);
          expect(world.acts).toEqual([]);
          expectTurns(world, child.runId, ["do", "scope/0", "review/0"]);
        }),
      ),
  );
});

effectIt.effect.each([
  { label: "unchanged", pushed: "aaa111", merged: true },
  { label: "pushed", pushed: "bbb222", merged: false },
] as const)("H1 the pull request head is $label while the merge waits", (entry) =>
  Effect.promise(() => {
    const answers = script();
    let approved = false;
    return withWorld(
      {
        ...answers,
        readPullRequest: (_address, detail) =>
          Effect.succeed({ ...detail, headSha: approved ? entry.pushed : "aaa111" }),
      },
      (world) =>
        world.server(
          Effect.fn("factoryPack.test.headBinding")(function* (workflows) {
            const { runId } = yield* startTask(workflows);
            yield* approvePlan(world, workflows, runId);
            const child = yield* world.child(workflows, runId, 0);
            yield* ask(world, workflows, child.runId, "approve-merge", "merge", ["Merge", "Hold"]);
            approved = true;
            yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" });
            const part = yield* world.ended(workflows, child.runId);
            const done = yield* world.ended(workflows, runId);
            if (entry.merged) {
              expectMerged(world, done, part, PR_URL, partStats({ asks: 1 }));
              return;
            }
            expect(part).toMatchObject({
              status: "stopped",
              detail: "pull request head changed after review",
            });
            expect(done.status).toBe("completed");
            expect(done.result).toMatchObject({
              parts: [{ title: PART.title, outcome: "stopped" }],
            });
            expect(world.acts).toEqual([]);
          }),
        ),
    );
  }),
);

effectIt.effect.each([
  { baseRef: "origin/factory", branch: "factory" },
  { baseRef: "refs/heads/release", branch: "release" },
  { baseRef: null, branch: null },
])("P11 target branch for $baseRef", ({ baseRef, branch }) =>
  Effect.promise(() =>
    withWorld(script(), (world) =>
      world.server(
        Effect.fn("factoryPack.test.targetBranch")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", {
            v: 1,
            askPlan: false,
            askMerge: false,
            baseRef,
          });
          const { runId } = yield* startTask(workflows);
          const done = yield* world.ended(workflows, runId, true);
          expect(done.status).toBe("completed");
          const work = world.turns.filter((turn) => turn.origin.step === "do");
          expect(work).toHaveLength(1);
          if (branch === null) {
            expect(work[0]?.prompt).not.toContain("Open the pull request against the branch");
          } else {
            expect(work[0]?.prompt).toContain(
              `Open the pull request against the branch \`${branch}\`.`,
            );
          }
          expect(done.result).toEqual({
            parts: [{ title: PART.title, outcome: "merged", prUrl: PR_URL, stats: partStats() }],
          });
        }),
      ),
    ),
  ),
);

const TIMED_OUT_TURN = {
  ending: "stopped",
  detail: "it was not done after 2h",
  reply: "",
} satisfies AgentResult;

effectIt.effect.each([false, true])(
  "P12 a timed-out do continues its worktree and merges (checks need a fix: %s)",
  (needsFix) =>
    Effect.promise(() => {
      const answers = pushingFixes(
        script({ checks: needsFix ? ["failing", "passing"] : ["passing"] }),
      );
      return withWorld(
        {
          ...answers,
          agent: (turn) => (turn.origin.step === "do" ? TIMED_OUT_TURN : answers.agent(turn)),
        },
        (world) =>
          world.server(
            Effect.fn("factoryPack.test.continueTimedOutDo")(function* (workflows) {
              yield* workflows.storeSet("factory/v1/config", {
                v: 1,
                askPlan: false,
                askMerge: false,
              });
              const { runId } = yield* startTask(workflows);
              const child = yield* world.child(workflows, runId, 0);
              const done = yield* world.ended(workflows, runId, true);
              const part = yield* world.ended(workflows, child.runId);
              // r9 M1: do/continue ran, so the part continued.
              expectMerged(
                world,
                done,
                part,
                PR_URL,
                partStats({ continued: true, fixRounds: needsFix ? 1 : 0 }),
              );
              expect(part.pauses).toBe(0);
              expectTurns(world, runId, ["plan"]);
              expectTurns(
                world,
                child.runId,
                needsFix
                  ? ["do", "do/continue", "fix/0", "scope/1", "review/1"]
                  : ["do", "do/continue", "scope/0", "review/0"],
              );
              expectQuestions(world, []);
              const { steps } = yield* workflows.get(child.runId);
              const failed = steps.find((step) => step.name === "do");
              const continued = steps.find((step) => step.name === "do/continue");
              expect(failed).toMatchObject({ status: "failed", threadId: expect.any(String) });
              expect(failed?.detail).toBe(`the agent's turn was stopped: ${TIMED_OUT_TURN.detail}`);
              expect(continued).toMatchObject({ status: "completed", threadId: failed?.threadId });
              for (const name of ["pull-request", "checks/0", "merge"]) {
                expect(steps.find((step) => step.name === name)?.status).toBe("completed");
              }
              expect(steps.some((step) => step.name === "do/again")).toBe(false);
              const continuation = world.turns.find(
                (turn) => turn.origin.runId === child.runId && turn.origin.step === "do/continue",
              );
              expect(continuation?.thread).toBe(failed?.threadId);
              expect(continuation?.prompt).toContain(failed?.detail);
              expect(continuation?.prompt).toMatch(
                /\b(?:do not|don't|never)\s+(?:restart|start (?:over|again)|redo)\b/i,
              );
              expect(continuation?.prompt).toMatch(/\b(?:carry on|continue|resume)\b/i);
              expect(continuation?.prompt).toMatch(/\bworktree\b/i);
              expect(continuation?.prompt).toMatch(/\bsummary\b/i);
              expect(continuation?.prompt).toMatch(/\b(?:prUrl|pull request)\b/i);
              // Each reviewed round reads the head again after review (r9 L4.6).
              expect(world.reads.map(({ standing }) => standing.checks)).toEqual(
                needsFix
                  ? [
                      "failing",
                      "passing",
                      "passing",
                      "passing",
                      "passing",
                      "passing",
                      "passing",
                      "passing",
                    ]
                  : ["passing", "passing", "passing", "passing", "passing"],
              );
              if (needsFix) {
                const fix = world.turns.find(
                  (turn) => turn.origin.runId === child.runId && turn.origin.step === "fix/0",
                );
                expect(fix?.thread).toBe(continued?.threadId);
              }
            }),
          ),
      );
    }),
);

it("P12 a failed continuation pauses there and resume continues the same thread", () => {
  const answers = script();
  let continuations = 0;
  return withWorld(
    {
      ...answers,
      agent: (turn) => {
        if (turn.origin.step === "do") return TIMED_OUT_TURN;
        if (turn.origin.step === "do/continue" && continuations++ === 0) return TIMED_OUT_TURN;
        return answers.agent(turn);
      },
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.test.resumeContinuation")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", {
            v: 1,
            askPlan: false,
            askMerge: false,
          });
          const { runId } = yield* startTask(workflows);
          const child = yield* world.child(workflows, runId, 0);
          const paused = yield* workflows.waitFor(
            child.runId,
            (run) => run.status === "paused" || run.endedAt !== null,
          );
          expect(paused).toMatchObject({
            status: "paused",
            endedAt: null,
            result: null,
            pauses: 1,
            resumesAt: null,
          });
          expect(paused.detail).toContain("do/continue");
          const failedSteps = (yield* workflows.get(child.runId)).steps;
          expect(failedSteps.find((step) => step.name === "do/continue")?.status).toBe("failed");
          expect(failedSteps.some((step) => step.name === "do/again")).toBe(false);
          expect((yield* workflows.get(runId)).run.endedAt).toBeNull();
          expectTurns(world, runId, ["plan"]);
          expectTurns(world, child.runId, ["do", "do/continue"]);
          expect(world.turns).toHaveLength(3);
          expect(world.startAttempts).toHaveLength(3);
          expect(world.acts).toEqual([]);
          expectQuestions(world, []);

          yield* workflows.resume(child.runId);
          expectMerged(
            world,
            yield* world.ended(workflows, runId, true),
            yield* world.ended(workflows, child.runId),
            PR_URL,
            partStats({ continued: true }),
          );
          expectTurns(world, child.runId, [
            "do",
            "do/continue",
            "do/continue",
            "scope/0",
            "review/0",
          ]);
          expect(world.turns).toHaveLength(6);
          expect(world.startAttempts).toHaveLength(6);
          const continued = world.turns.filter(
            (turn) => turn.origin.runId === child.runId && turn.origin.step === "do/continue",
          );
          expect(continued.map((turn) => turn.thread)).toEqual([
            failedSteps.find((step) => step.name === "do")?.threadId,
            failedSteps.find((step) => step.name === "do")?.threadId,
          ]);
          expect(continued[0]?.key).not.toBe(continued[1]?.key);
          expect(
            (yield* workflows.get(child.runId)).steps.find((step) => step.name === "do/continue")
              ?.status,
          ).toBe("completed");
        }),
      ),
  );
});

it("P12 a do that never started retries as do/again with the original launch options", () => {
  const answers = script();
  const workerModel = { instanceId: "codex", model: "recovery-worker" };
  const reason = "The provider could not create the first thread.";
  return withWorld(
    {
      ...answers,
      startError: (turn) => (turn.origin.step === "do" ? reason : undefined),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.test.againWithoutThread")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", {
            v: 1,
            askPlan: false,
            askMerge: false,
            workerModel,
            baseRef: "origin/factory-base",
          });
          const { runId } = yield* startTask(workflows);
          const child = yield* world.child(workflows, runId, 0);
          expectMerged(
            world,
            yield* world.ended(workflows, runId, true),
            yield* world.ended(workflows, child.runId),
            PR_URL,
            partStats({ continued: true }),
          );
          const attempts = world.startAttempts.filter((turn) => turn.origin.runId === child.runId);
          expect(attempts.map((turn) => turn.origin.step)).toEqual([
            "do",
            "do/again",
            "scope/0",
            "review/0",
          ]);
          const original = attempts[0];
          const again = attempts[1];
          if (original === undefined || again === undefined)
            throw new Error("Expected do and do/again");
          expect(original.thread).toBeUndefined();
          expect(again.thread).toBeUndefined();
          expect(again.project).toBe(PROJECT);
          expect(again.project).toBe(original.project);
          expect(again.model).toEqual(workerModel);
          expect(again.model).toEqual(original.model);
          expect(again.launch).toMatchObject({
            workspace: { type: "worktree" },
            runtimeMode: "full-access",
          });
          expect(again.launch).toEqual(original.launch);
          expect(again.prompt).toBe(original.prompt);
          expect(again.outputSchema).toEqual(original.outputSchema);
          expect(again.environment).toBe(original.environment);
          expect(again.issue).toEqual(original.issue);
          expect(
            world.turns
              .filter((turn) => turn.origin.runId === child.runId)
              .map((turn) => turn.origin.step),
          ).toEqual(["do/again", "scope/0", "review/0"]);
          const { steps } = yield* workflows.get(child.runId);
          expect(steps.find((step) => step.name === "do")).toMatchObject({
            status: "failed",
            threadId: null,
            detail: `the agent could not be started: ${reason}`,
          });
          expect(steps.find((step) => step.name === "do/again")).toMatchObject({
            status: "completed",
            threadId: `thread-${again.key}`,
          });
          expect(steps.some((step) => step.name === "do/continue")).toBe(false);
          expectQuestions(world, []);
        }),
      ),
  );
});

it("P12 continuations and another part's do share the concurrency-one pool", () => {
  const parts = [PART, { title: "Second part", brief: "Implement the other independent change." }];
  const answers = script({ parts });
  return withWorld(
    {
      ...answers,
      holdAgent: (turn) => turn.origin.step !== "plan",
      agent: (turn) => (turn.origin.step === "do" ? TIMED_OUT_TURN : answers.agent(turn)),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.test.continuationSlot")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", {
            v: 1,
            concurrency: 1,
            askPlan: false,
            askMerge: false,
          });
          const { runId } = yield* startTask(workflows);
          expect((yield* world.nextTurn).origin.step).toBe("plan");
          const children = yield* Effect.forEach(
            parts,
            (_, index) => world.child(workflows, runId, index),
            { concurrency: "unbounded" },
          );
          for (let index = 0; index < parts.length * 4; index++) {
            const turn = yield* world.nextTurn;
            expect(["do", "do/continue", "scope/0", "review/0"]).toContain(turn.origin.step);
            const sibling = children.find((child) => child.runId !== turn.origin.runId);
            if (sibling === undefined) throw new Error("Expected another part");
            const settled = yield* workflows.waitFor(
              sibling.runId,
              (run) =>
                run.detail === `queue factory-task:${TASK_ID}` ||
                run.status === "paused" ||
                run.endedAt !== null ||
                world.activeCounts.some((count) => count > 1),
            );
            expect(settled.status).not.toBe("paused");
            if (settled.endedAt === null) {
              expect(settled.detail).toBe(`queue factory-task:${TASK_ID}`);
            }
            expect(Math.max(...world.activeCounts)).toBe(1);
            yield* world.releaseTurn(turn);
          }
          const done = yield* world.ended(workflows, runId, true);
          expect(done.status).toBe("completed");
          expect(done.result).toEqual({
            parts: children.map((child, index) => ({
              title: parts[index]?.title,
              outcome: "merged",
              prUrl: answers.urls.get(child.runId),
              stats: partStats({ continued: true }),
            })),
          });
          for (const child of children) {
            const ended = yield* world.ended(workflows, child.runId);
            expect(ended).toMatchObject({
              status: "completed",
              result: { outcome: "merged", prUrl: answers.urls.get(child.runId) },
            });
            expectTurns(world, child.runId, ["do", "do/continue", "scope/0", "review/0"]);
            expectTags(world, ended, "review");
          }
          expectTags(world, done, "done");
          expect(world.acts).toHaveLength(2);
          expect(world.acts).toEqual(
            expect.arrayContaining([
              [{ project: PROJECT, url: PR_URL }, "merge", { mergeMethod: "squash" }],
              [
                { project: PROJECT, url: "https://github.com/factory/pack/pull/18" },
                "merge",
                { mergeMethod: "squash" },
              ],
            ]),
          );
          expectQuestions(world, []);
          expect(Math.max(...world.activeCounts)).toBe(1);
        }),
      ),
  );
});

effectIt.effect.each([
  {
    label: "a person interrupted the turn",
    result: { ending: "stopped", detail: "interrupted", reply: "" },
    reason: "the agent's turn was stopped: interrupted",
    turns: 1,
  },
  {
    label: "the timed-out turn could not be stopped",
    result: {
      ending: "stopped",
      detail: "it was not done after 2h, and its turn could not be stopped",
      reply: "",
    },
    reason:
      "the agent's turn was stopped: it was not done after 2h, and its turn could not be stopped",
    turns: 1,
  },
  {
    label: "the timed-out turn may still be at work",
    result: {
      ending: "stopped",
      detail:
        "it was not done after 2h: its turn ended without its result, and the agent may still be at work on its thread",
      reply: "",
    },
    reason:
      "the agent's turn was stopped: it was not done after 2h: its turn ended without its result, and the agent may still be at work on its thread",
    turns: 1,
  },
  {
    label: "no usable result was returned",
    result: { ending: "completed", detail: "", reply: "The work is unfinished." },
    reason: "the agent did not return a result: its turn ended with none accepted",
    turns: 3,
  },
  {
    label: "the turn died twice",
    result: { ending: "failed", detail: "provider disconnected", reply: "" },
    reason: "the agent's turn was cut short: provider disconnected",
    turns: 2,
  },
] as const)("P12a stops after $label without recovering the worker", (entry) =>
  Effect.promise(() => {
    const answers = script();
    return withWorld(
      {
        ...answers,
        agent: (turn) => (turn.origin.step === "do" ? entry.result : answers.agent(turn)),
      },
      (world) =>
        world.server(
          Effect.fn("factoryPack.test.workerStopped")(function* (workflows) {
            yield* workflows.storeSet("factory/v1/config", {
              v: 1,
              askPlan: false,
              askMerge: false,
            });
            const { runId } = yield* startTask(workflows);
            const child = yield* world.child(workflows, runId, 0);
            const part = yield* world.ended(workflows, child.runId, true);
            const done = yield* world.ended(workflows, runId, true);
            expect(part).toMatchObject({
              status: "stopped",
              detail: `worker stopped: ${entry.reason}`,
              result: null,
              pauses: 0,
            });
            expect(done).toMatchObject({
              status: "completed",
              result: { parts: [{ title: PART.title, outcome: "stopped", prUrl: null }] },
            });
            expectTags(world, part, "doing");
            expectTags(world, done, "done");
            expectTurns(world, runId, ["plan"]);
            const turns = world.turns.filter((turn) => turn.origin.runId === child.runId);
            expect(turns.map((turn) => turn.origin.step)).toEqual(
              Array.from({ length: entry.turns }, () => "do"),
            );
            expect(turns[0]?.thread).toBeUndefined();
            if (entry.result.ending === "completed") {
              expect(turns.slice(1).map((turn) => turn.thread)).toEqual([
                `thread-${turns[0]?.key}`,
                `thread-${turns[0]?.key}`,
              ]);
            } else {
              expect(turns.every((turn) => turn.thread === undefined)).toBe(true);
            }
            expect(world.startAttempts).toHaveLength(entry.turns + 1);
            const { steps } = yield* workflows.get(child.runId);
            expect(steps.find((step) => step.name === "do")).toMatchObject({
              status: "failed",
              detail: entry.reason,
              threadId: expect.any(String),
            });
            expect(
              steps.filter(
                (step) =>
                  step.name === "do/continue" ||
                  step.name === "do/again" ||
                  step.name === "pull-request" ||
                  step.kind === "wait",
              ),
            ).toEqual([]);
            expect(world.pullRequestQueries).toEqual([]);
            expect(world.readCalls).toEqual([]);
            expect(world.acts).toEqual([]);
            expectQuestions(world, []);
          }),
        ),
    );
  }),
);

effectIt.effect.each([
  { failure: "none", next: null },
  { failure: "changes", next: "Fix again" },
  { failure: "checks", next: "Fix again" },
  { failure: "changes", next: "Stop" },
  { failure: "checks", next: "Stop" },
  { failure: "changes", next: "Merge anyway" },
  { failure: "checks", next: "Merge anyway" },
] as const)("P13 an extra round with $failure then $next", (entry) =>
  Effect.promise(() => {
    const ruling = "Keep the public API and repair only the internal implementation.";
    const secondRuling = "Preserve the import boundary and finish the missing assertion.";
    const extraNotes = "The import boundary still needs a regression test.";
    const answers = pushingFixes(
      script({
        changes: true,
        // checks/0, risk-pr/0, head/0 (r9 L4.6), the two fix reads, then checks/x1 fails.
        checks:
          entry.failure === "checks"
            ? ["passing", "passing", "passing", "passing", "passing", "failing"]
            : ["passing"],
      }),
    );
    return withWorld(
      {
        ...answers,
        agent: (turn) => {
          if (turn.origin.step === "review/x1") {
            return reviewReport(entry.failure === "changes" ? [extraNotes] : []);
          }
          if (turn.origin.step === "review/x2") return reviewReport([]);
          return answers.agent(turn);
        },
      },
      (world) =>
        world.server(
          Effect.fn("factoryPack.test.extraRound")(function* (workflows) {
            yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false, fixRounds: 0 });
            const { runId } = yield* startTask(workflows);
            const child = yield* world.child(workflows, runId, 0);
            yield* askStuck(world, workflows, child.runId);
            const refused = yield* workflows
              .answer(child.runId, "stuck", { choice: "Fix again" })
              .pipe(Effect.flip);
            expect(refused._tag).toBe("WorkflowInputError");
            expect(refused.message).toMatch(/reason/i);
            yield* askStuck(world, workflows, child.runId);
            // r9 L4: round 0's open major is put to the disprove step.
            expectTurns(world, child.runId, ["do", "scope/0", "review/0", "disprove/0"]);
            yield* workflows.answer(child.runId, "stuck", { choice: "Fix again", reason: ruling });
            if (entry.next !== null) {
              yield* askStuck(world, workflows, child.runId, "stuck/x1");
              expect(world.acts).toEqual([]);
              yield* workflows.answer(
                child.runId,
                "stuck/x1",
                entry.next === "Fix again"
                  ? { choice: entry.next, reason: secondRuling }
                  : { choice: entry.next },
              );
            }
            if (entry.next !== "Stop") yield* merge(world, workflows, child.runId);
            const part = yield* world.ended(workflows, child.runId);
            const done = yield* world.ended(workflows, runId);
            if (entry.next === "Stop") {
              expect(part).toMatchObject({
                status: "stopped",
                detail: "review did not pass",
                result: null,
              });
              expect(done).toMatchObject({
                status: "completed",
                result: { parts: [{ title: PART.title, outcome: "stopped", prUrl: null }] },
              });
              expect(world.acts).toEqual([]);
            } else {
              // r9 M1: one ask per stuck question plus the merge gate, one ruling per Fix again,
              // a review round per round whose checks passed, one raised major per round that
              // asked for changes. The tier is high only when the head moved after its files were
              // listed. r9d: fixRounds counts every fix round that moved the head.
              expectMerged(
                world,
                done,
                part,
                PR_URL,
                partStats({
                  tier:
                    entry.failure === "checks" && entry.next === "Merge anyway"
                      ? "high"
                      : "standard",
                  fixRounds: entry.next === "Fix again" ? 2 : 1,
                  asks: entry.next === null ? 2 : 3,
                  rulings: entry.next === "Fix again" ? 2 : 1,
                  mergedAnyway: entry.next === "Merge anyway",
                  reviewRounds:
                    1 + (entry.failure === "checks" ? 0 : 1) + (entry.next === "Fix again" ? 1 : 0),
                  findingsRaised: entry.failure === "changes" ? 2 : 1,
                }),
              );
            }
            // r9 L4: each round that asked for changes runs the disprove step.
            const expectedTurns = ["do", "scope/0", "review/0", "disprove/0", "fix/x1"];
            if (entry.failure !== "checks") expectedTurns.push("scope/x1", "review/x1");
            if (entry.failure === "changes") expectedTurns.push("disprove/x1");
            if (entry.next === "Fix again") expectedTurns.push("fix/x2", "scope/x2", "review/x2");
            expectTurns(world, child.runId, expectedTurns);
            expectQuestions(world, [
              [child.runId, "stuck", "stuck"],
              ...(entry.next === null ? [] : ([[child.runId, "stuck/x1", "stuck"]] as const)),
              ...(entry.next === "Stop"
                ? []
                : ([[child.runId, "approve-merge", "merge"]] as const)),
            ]);
            const { steps } = yield* workflows.get(child.runId);
            expect(
              steps.filter((step) => step.name.startsWith("checks/")).map((step) => step.name),
            ).toEqual(
              entry.next === "Fix again"
                ? ["checks/0", "checks/x1", "checks/x2"]
                : ["checks/0", "checks/x1"],
            );
            const rounds = entry.next === "Fix again" ? [1, 2] : [1];
            for (const round of rounds) {
              const fix = world.turns.find(
                (turn) => turn.origin.runId === child.runId && turn.origin.step === `fix/x${round}`,
              );
              const reason = round === 1 ? ruling : secondRuling;
              expect(fix?.prompt).toContain(reason);
              // r9 L4: the review's last notes are renderFindings of its open findings.
              expect(fix?.prompt).toContain(
                reviewNotes(
                  round === 2 && entry.failure === "changes" ? extraNotes : "Review feedback.",
                ),
              );
              expect(fix?.prompt).toContain(PR_URL);
              expect(fix?.prompt).toMatch(/push/i);
              const at = (name: string) => steps.findIndex((step) => step.name === name);
              expect(at(`checks/x${round}`)).toBeGreaterThan(at(`fix/x${round}`));
              const around = [
                `fix-before/x${round}`,
                `fix/x${round}`,
                `fix-after/x${round}`,
                `checks/x${round}`,
              ];
              expect(
                steps.map((step) => step.name).filter((name) => around.includes(name)),
              ).toEqual(around);
              if (round === 2 || entry.failure !== "checks") {
                const review = world.turns.find(
                  (turn) =>
                    turn.origin.runId === child.runId && turn.origin.step === `review/x${round}`,
                );
                expect(review?.prompt).toContain(reason);
                expect(at(`review/x${round}`)).toBeGreaterThan(at(`checks/x${round}`));
              }
            }
            expectTags(world, part, "review");
            expectTags(world, done, "done");
          }),
        ),
    );
  }),
);

effectIt.effect.each(["Merge anyway", "timeout"] as const)(
  "P13 the first stuck question preserves %s",
  (choice) =>
    Effect.promise(() =>
      withWorld(script({ changes: true }), (world) =>
        world.server(
          Effect.fn("factoryPack.test.stuckExistingChoices")(function* (workflows) {
            yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false, fixRounds: 0 });
            const { runId } = yield* startTask(workflows);
            const child = yield* world.child(workflows, runId, 0);
            yield* askStuck(world, workflows, child.runId);
            if (choice === "timeout") {
              yield* world.expireQuestion(workflows, child.runId, "stuck");
            } else {
              yield* workflows.answer(child.runId, "stuck", { choice });
              yield* merge(world, workflows, child.runId);
            }
            const part = yield* world.ended(workflows, child.runId);
            const done = yield* world.ended(workflows, runId);
            if (choice === "timeout") {
              expect(part).toMatchObject({
                status: "stopped",
                detail: "review did not pass",
                result: null,
              });
              expect(done).toMatchObject({
                status: "completed",
                result: { parts: [{ title: PART.title, outcome: "stopped", prUrl: null }] },
              });
              expect(world.acts).toEqual([]);
            } else {
              // r9 M1: the stuck question and the merge gate, and round 0's raised major.
              expectMerged(
                world,
                done,
                part,
                PR_URL,
                partStats({ asks: 2, mergedAnyway: true, findingsRaised: 1 }),
              );
            }
            // r9 L4: round 0's open major is put to the disprove step.
            expectTurns(world, child.runId, ["do", "scope/0", "review/0", "disprove/0"]);
            expectQuestions(
              world,
              choice === "timeout"
                ? [[child.runId, "stuck", "stuck"]]
                : [
                    [child.runId, "stuck", "stuck"],
                    [child.runId, "approve-merge", "merge"],
                  ],
            );
          }),
        ),
      ),
    ),
);

effectIt.effect.each(["merged", "closed"] as const)(
  "P13 checks/x1 sees the pull request already %s",
  (state) =>
    Effect.promise(() => {
      const answers = pushingFixes(script({ changes: true }));
      return withWorld(
        {
          ...answers,
          standing: (address, read) => ({
            ...answers.standing(address, read),
            // checks/0, risk-pr/0, head/0 (r9 L4.6), fix-before/x1, fix-after/x1, then checks/x1.
            state: read === 5 ? state : "open",
          }),
        },
        (world) =>
          world.server(
            Effect.fn("factoryPack.test.extraRoundClosed")(function* (workflows) {
              yield* workflows.storeSet("factory/v1/config", {
                v: 1,
                askPlan: false,
                fixRounds: 0,
              });
              const { runId } = yield* startTask(workflows);
              const child = yield* world.child(workflows, runId, 0);
              yield* askStuck(world, workflows, child.runId);
              yield* workflows.answer(child.runId, "stuck", {
                choice: "Fix again",
                reason: "Finish the missing assertion on the existing pull request.",
              });
              const part = yield* world.ended(workflows, child.runId);
              const done = yield* world.ended(workflows, runId);
              if (state === "merged") {
                expect(part).toMatchObject({
                  status: "completed",
                  result: { outcome: "merged", prUrl: PR_URL },
                });
              } else {
                expect(part).toMatchObject({
                  status: "stopped",
                  detail: "pull request closed",
                  result: null,
                });
              }
              expect(done).toMatchObject({
                status: "completed",
                result: {
                  parts: [
                    {
                      title: PART.title,
                      outcome: state === "merged" ? "merged" : "stopped",
                      prUrl: state === "merged" ? PR_URL : null,
                    },
                  ],
                },
              });
              expect(
                (yield* workflows.get(child.runId)).steps.find((step) => step.name === "checks/x1")
                  ?.result,
              ).toMatchObject({ state });
              // r9 L4: round 0's open major is put to the disprove step.
              expectTurns(world, child.runId, [
                "do",
                "scope/0",
                "review/0",
                "disprove/0",
                "fix/x1",
              ]);
              expectQuestions(world, [[child.runId, "stuck", "stuck"]]);
              expect(world.acts).toEqual([]);
            }),
          ),
      );
    }),
);

it("P13 extra fixes share the concurrency-one pool across two parts", () => {
  const parts = [PART, { title: "Second part", brief: "Implement the other independent change." }];
  const answers = pushingFixes(script({ parts, changes: true }));
  return withWorld(
    {
      ...answers,
      holdAgent: (turn) => turn.origin.step !== "plan",
      agent: (turn) => (turn.origin.step === "review/x1" ? reviewReport([]) : answers.agent(turn)),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.test.extraRoundSlot")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", {
            v: 1,
            concurrency: 1,
            fixRounds: 0,
            askPlan: false,
            askMerge: false,
          });
          const { runId } = yield* startTask(workflows);
          expect((yield* world.nextTurn).origin.step).toBe("plan");
          const children = yield* Effect.forEach(
            parts,
            (_, index) => world.child(workflows, runId, index),
            { concurrency: "unbounded" },
          );
          // r9 L4: each part's round 0 ends with the disprove step, which holds a place too.
          for (let index = 0; index < parts.length * 4; index++) {
            const turn = yield* world.nextTurn;
            expect(["do", "scope/0", "review/0", "disprove/0"]).toContain(turn.origin.step);
            expect(Math.max(...world.activeCounts)).toBe(1);
            yield* world.releaseTurn(turn);
          }
          for (const child of children) yield* askStuck(world, workflows, child.runId);
          const first = children[0];
          const second = children[1];
          if (first === undefined || second === undefined) throw new Error("Expected two parts");
          const answer = {
            choice: "Fix again",
            reason: "Keep the public API and finish the assertion.",
          };
          yield* workflows.answer(first.runId, "stuck", answer);
          const held = yield* world.nextTurn;
          expect(held.origin).toMatchObject({ runId: first.runId, step: "fix/x1" });
          yield* workflows.answer(second.runId, "stuck", answer);
          const queued = yield* workflows.waitFor(
            second.runId,
            (run) =>
              run.detail === `queue factory-task:${TASK_ID}` ||
              run.detail === "agent fix/x1" ||
              run.status === "paused" ||
              run.endedAt !== null,
          );
          expect(queued).toMatchObject({
            status: "waiting",
            detail: `queue factory-task:${TASK_ID}`,
          });
          expect(Math.max(...world.activeCounts)).toBe(1);
          yield* world.releaseTurn(held);
          for (let index = 1; index < parts.length * 3; index++) {
            const turn = yield* world.nextTurn;
            expect(["fix/x1", "scope/x1", "review/x1"]).toContain(turn.origin.step);
            expect(Math.max(...world.activeCounts)).toBe(1);
            yield* world.releaseTurn(turn);
          }
          const done = yield* world.ended(workflows, runId);
          expect(done).toMatchObject({
            status: "completed",
            result: {
              parts: children.map((child, index) => ({
                title: parts[index]?.title,
                outcome: "merged",
                prUrl: answers.urls.get(child.runId),
              })),
            },
          });
          for (const child of children) {
            expectTurns(world, child.runId, [
              "do",
              "scope/0",
              "review/0",
              "disprove/0",
              "fix/x1",
              "scope/x1",
              "review/x1",
            ]);
            expect((yield* world.ended(workflows, child.runId)).status).toBe("completed");
          }
          expect(world.questions).toHaveLength(2);
          expect(world.questions.map((question) => [question.name, question.kind])).toEqual([
            ["stuck", "stuck"],
            ["stuck", "stuck"],
          ]);
          expect(world.acts).toHaveLength(2);
          expect(world.acts).toEqual(
            expect.arrayContaining([
              [{ project: PROJECT, url: PR_URL }, "merge", { mergeMethod: "squash" }],
              [
                { project: PROJECT, url: "https://github.com/factory/pack/pull/18" },
                "merge",
                { mergeMethod: "squash" },
              ],
            ]),
          );
          expect(Math.max(...world.activeCounts)).toBe(1);
        }),
      ),
  );
});

it("a fix round that adds no commit asks stuck without another checks or review cycle", () => {
  const answers = script({ changes: true });
  return withWorld(
    {
      ...answers,
      agent: (turn) =>
        turn.origin.step === "review/0"
          ? reviewReport(["Missing null guard"])
          : answers.agent(turn),
      readPullRequest: (_address, detail) => Effect.succeed({ ...detail, headSha: "sha-1" }),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.test.noOpFix")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false, fixRounds: 1 });
          const { runId } = yield* startTask(workflows);
          const child = yield* world.child(workflows, runId, 0);
          const stuck = yield* askStuck(world, workflows, child.runId);
          const data = decodeQuestionData(stuck.request).data;
          // r9 L7: lastReviewNotes is the round's renderFindings text.
          expect(data).toMatchObject({
            lastReviewNotes: reviewNotes("Missing null guard"),
            noOpFixRounds: 1,
            fixRoundsUsed: 0,
          });
          expect(JSON.stringify(data)).toMatch(/no new commit/i);
          expect(JSON.stringify(data)).toContain("sha-1");
          yield* workflows.answer(child.runId, "stuck", { choice: "Stop" });
          const part = yield* world.ended(workflows, child.runId);
          const done = yield* world.ended(workflows, runId);
          expect(part).toMatchObject({ status: "stopped", result: null });
          expect(done.status).toBe("completed");
          const names = (yield* workflows.get(child.runId)).steps.map((step) => step.name);
          expect(names.filter((name) => /^(?:checks|scope|review|fix)/.test(name))).toEqual([
            "checks/0",
            "scope/0",
            "review/0",
            "fix-before/0",
            "fix/0",
            "fix-after/0",
          ]);
          // r9 L4: the open major is put to the disprove step, and round 0 reads its head again.
          expectTurns(world, child.runId, ["do", "scope/0", "review/0", "disprove/0", "fix/0"]);
          expect(world.turns).toHaveLength(6);
          expect(world.reads.map(({ standing }) => standing.checks)).toEqual([
            "passing",
            "passing",
            "passing",
            "passing",
            "passing",
          ]);
          expectQuestions(world, [[child.runId, "stuck", "stuck"]]);
          expect(world.acts).toEqual([]);
        }),
      ),
  );
});

const issueLinkCases: ReadonlyArray<{
  readonly label: string;
  readonly issueUrl: string | null;
  readonly body: string;
  readonly commented: boolean;
}> = [
  {
    label: "comments Refs when the pull request body lacks the issue",
    issueUrl: ISSUE_URL,
    body: "Implements the part.",
    commented: true,
  },
  {
    label: "stays silent when the body already closes the issue",
    issueUrl: ISSUE_URL,
    body: "Closes #191",
    commented: false,
  },
  {
    label: "does not run without an issue",
    issueUrl: null,
    body: "Implements the part.",
    commented: false,
  },
];

effectIt.effect.each(issueLinkCases)("issue-link $label", (entry) =>
  Effect.promise(() => {
    const answers = script();
    return withWorld(
      {
        ...answers,
        readPullRequest: (_address, detail) => Effect.succeed({ ...detail, body: entry.body }),
      },
      (world) =>
        world.server(
          Effect.fn("factoryPack.test.issueLink")(function* (workflows) {
            yield* workflows.storeSet("factory/v1/config", {
              v: 1,
              askPlan: false,
              askMerge: false,
            });
            const { runId } = yield* startTask(workflows, entry.issueUrl);
            const done = yield* world.ended(workflows, runId, true);
            const child = yield* world.child(workflows, runId, 0);
            const part = yield* world.ended(workflows, child.runId);
            expectMerged(world, done, part, PR_URL, partStats());
            const linked = [
              ...(yield* workflows.get(runId)).steps,
              ...(yield* workflows.get(child.runId)).steps,
            ].filter((step) => step.name === "issue-link");
            if (entry.issueUrl === null) {
              expect(linked).toEqual([]);
            } else {
              expect(linked.map((step) => step.status)).toEqual(["completed"]);
            }
            expect(world.prComments).toEqual(
              entry.commented
                ? [{ pullRequest: { project: PROJECT, url: PR_URL }, body: `Refs ${ISSUE_URL}` }]
                : [],
            );
            for (const step of ["do", "review/0"]) {
              const brief = world.turns.find(
                (turn) => turn.origin.runId === child.runId && turn.origin.step === step,
              )?.prompt;
              expect(brief, step).toBeDefined();
              if (entry.issueUrl === null) expect(brief).not.toContain(ISSUE_URL);
              else expect(brief).toContain(ISSUE_URL);
            }
          }),
        ),
    );
  }),
);

it("the do brief routes follow-ups to factory-capture and the review brief asks to disprove", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.briefs")(function* (workflows) {
        yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false, askMerge: false });
        const { runId } = yield* startTask(workflows);
        yield* world.ended(workflows, runId, true);
        const child = yield* world.child(workflows, runId, 0);
        const brief = (step: string) =>
          world.turns.find((turn) => turn.origin.runId === child.runId && turn.origin.step === step)
            ?.prompt;
        expect(brief("do")).toContain("factory-capture");
        expect(brief("do")).toContain("blockedBy");
        expect(brief("do")).toContain(TASK_ID);
        expect(brief("review/0")).toMatch(/disprove/i);
        expect(brief("review/0")).toMatch(/edge cases?/i);
        expect(brief("review/0")).toMatch(/counterfactual/i);
        expect(brief("review/0")).toMatch(/\bcit(?:e|ing)\b/i);
        expect(brief("review/0")).toMatch(/\blines?\b/i);
      }),
    ),
  ));

const MERGE_FIELDS = [
  "prUrl",
  "headSha",
  "summary",
  "fixRoundsUsed",
  "noOpFixRounds",
  "lastReviewNotes",
  "rulings",
  "riskTier",
  "riskReasons",
  // r9 L7: the open findings of the latest round that was not stale, and how many were refuted.
  "findings",
  "refuted",
] as const;

effectIt.effect.each([
  {
    label: "a clean approval",
    kind: "clean",
    expected: {
      prUrl: PR_URL,
      headSha: "sha-0",
      summary: "Implemented the requested part.",
      fixRoundsUsed: 0,
      noOpFixRounds: 0,
    },
    stats: partStats({ asks: 1 }),
  },
  {
    label: "a fix round",
    kind: "fix",
    expected: { prUrl: PR_URL, headSha: "sha-1", fixRoundsUsed: 1, noOpFixRounds: 0 },
    stats: partStats({ fixRounds: 1, asks: 1, reviewRounds: 2, findingsRaised: 1 }),
  },
  {
    label: "a ruled extra round",
    kind: "ruling",
    expected: { prUrl: PR_URL, headSha: "sha-1", noOpFixRounds: 0 },
    // AMBIGUOUS: fixRounds read as counting fix/x1, which pushed (see P13 an extra round).
    stats: partStats({ fixRounds: 1, asks: 2, rulings: 1, reviewRounds: 2, findingsRaised: 1 }),
  },
] as const)("approve-merge carries its structured data after $label", (entry) =>
  Effect.promise(() => {
    const ruling = "Keep the public API and finish the missing assertion.";
    const answers = pushingFixes(script());
    return withWorld(
      {
        ...answers,
        agent: (turn) =>
          entry.kind !== "clean" && turn.origin.step === "review/0"
            ? reviewReport(["Missing null guard"])
            : answers.agent(turn),
      },
      (world) =>
        world.server(
          Effect.fn("factoryPack.test.mergeData")(function* (workflows) {
            yield* workflows.storeSet("factory/v1/config", {
              v: 1,
              askPlan: false,
              fixRounds: entry.kind === "ruling" ? 0 : 2,
            });
            const { runId } = yield* startTask(workflows);
            const child = yield* world.child(workflows, runId, 0);
            if (entry.kind === "ruling") {
              yield* askStuck(world, workflows, child.runId);
              yield* workflows.answer(child.runId, "stuck", {
                choice: "Fix again",
                reason: ruling,
              });
            }
            const question = yield* ask(world, workflows, child.runId, "approve-merge", "merge", [
              "Merge",
              "Hold",
            ]);
            const data = decodeQuestionData(question.request).data;
            expect(data).toMatchObject(entry.expected);
            for (const field of MERGE_FIELDS) expect(data).toHaveProperty(field);
            if (entry.kind === "ruling") expect(JSON.stringify(data)).toContain(ruling);
            yield* workflows.answer(
              child.runId,
              "approve-merge",
              { choice: "Merge" },
              { label: "Test person" },
            );
            expectMerged(
              world,
              yield* world.ended(workflows, runId),
              yield* world.ended(workflows, child.runId),
              PR_URL,
              entry.stats,
            );
          }),
        ),
    );
  }),
);

const SCRATCH_PROJECT = "scratch-proj-1";
const TWO_PARTS = [
  PART,
  { title: "Document the change", brief: "Document the requested behavior." },
];
const REPORT = "Findings\nAll figures reconcile.\n";
const REPORT_SHA = NodeCrypto.createHash("sha256").update(REPORT).digest("hex");
const REPORT_BYTES = Buffer.byteLength(REPORT);

const seedTarget = (
  workflows: Service,
  key: string,
  target: {
    readonly projectId: string | null;
    readonly workspace: "worktree" | "root" | "scratch";
    readonly workspaceRoot: string | null;
    readonly problem: string | null;
  },
) => workflows.storeSet(`factory/v1/target/${key}`, { v: 1, ...target, checkedAt: AT });

const withReportFile = async (use: (file: string) => Promise<void>) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-artifact-"));
  try {
    const file = NodePath.join(directory, "report.md");
    NodeFS.writeFileSync(file, REPORT);
    await use(file);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

it("a root target launches do in the project folder and serializes two parts despite concurrency two", () => {
  const answers = script({ parts: TWO_PARTS, noPullRequest: true });
  return withWorld({ ...answers, holdAgent: (turn) => turn.origin.step === "do" }, (world) =>
    world.server(
      Effect.fn("factoryPack.test.rootTarget")(function* (workflows) {
        yield* workflows.storeSet("factory/v1/config", { v: 1, concurrency: 2 });
        yield* seedTarget(workflows, PROJECT, {
          projectId: PROJECT,
          workspace: "root",
          workspaceRoot: "/tmp/plain",
          problem: null,
        });
        const { runId } = yield* startTask(workflows);
        expect((yield* world.nextTurn).origin.step).toBe("plan");
        yield* approvePlan(world, workflows, runId);
        const children = yield* Effect.forEach(TWO_PARTS, (_, index) =>
          world.child(workflows, runId, index),
        );
        const first = yield* world.nextTurn;
        expect(first.origin.step).toBe("do");
        const second = children.find((child) => child.runId !== first.origin.runId);
        if (second === undefined) throw new Error("Expected a second part");
        const queued = `queue factory-root:${PROJECT}`;
        const waiting = yield* workflows.waitFor(
          second.runId,
          (run) =>
            run.detail === queued ||
            run.detail === "agent do" ||
            run.status === "paused" ||
            run.endedAt !== null,
        );
        expect(waiting).toMatchObject({ status: "waiting", detail: queued });
        expect(world.turns.filter((turn) => turn.origin.step === "do")).toHaveLength(1);
        yield* world.releaseTurn(first);
        yield* ask(world, workflows, first.origin.runId, "accept", "accept", ["Accept", "Redo"]);
        yield* workflows.answer(first.origin.runId, "accept", { choice: "Accept" });
        const next = yield* world.nextTurn;
        expect(next.origin).toMatchObject({ step: "do", runId: second.runId });
        yield* world.releaseTurn(next);
        yield* ask(world, workflows, second.runId, "accept", "accept", ["Accept", "Redo"]);
        yield* workflows.answer(second.runId, "accept", { choice: "Accept" });
        const done = yield* world.ended(workflows, runId);
        expect(done).toMatchObject({
          status: "completed",
          result: {
            parts: TWO_PARTS.map((part) => ({
              title: part.title,
              outcome: "accepted",
              prUrl: null,
            })),
          },
        });
        const works = world.turns.filter((turn) => turn.origin.step === "do");
        expect(works).toHaveLength(2);
        for (const turn of works) {
          expect(turn.project).toBe(PROJECT);
          expect(turn.launch?.workspace).toEqual({ type: "root" });
        }
        expect(Math.max(...world.activeCounts)).toBe(1);
      }),
    ),
  );
});

it("a scratch task without a project plans and works in the scratch project", () =>
  withWorld(script({ noPullRequest: true }), (world) =>
    world.server(
      Effect.fn("factoryPack.test.scratchTarget")(function* (workflows) {
        yield* seedTarget(workflows, "scratch", {
          projectId: SCRATCH_PROJECT,
          workspace: "scratch",
          workspaceRoot: "/tmp/scratch",
          problem: null,
        });
        const { runId } = yield* startTask(workflows, null, null);
        yield* approvePlan(world, workflows, runId);
        const child = yield* world.child(workflows, runId, 0);
        yield* ask(world, workflows, child.runId, "accept", "accept", ["Accept", "Redo"]);
        yield* workflows.answer(child.runId, "accept", { choice: "Accept" });
        const part = yield* world.ended(workflows, child.runId);
        const done = yield* world.ended(workflows, runId);
        expect(part).toMatchObject({
          status: "completed",
          result: { outcome: "accepted", prUrl: null },
        });
        expect(done).toMatchObject({
          status: "completed",
          result: { parts: [{ title: PART.title, outcome: "accepted", prUrl: null }] },
        });
        expect(world.turns.map((turn) => [turn.origin.step, turn.project])).toEqual([
          ["plan", SCRATCH_PROJECT],
          ["do", SCRATCH_PROJECT],
        ]);
        const work = world.turns.find((turn) => turn.origin.step === "do");
        expect(work?.launch?.workspace?.type).toBe("worktree");
        expect(world.acts).toEqual([]);
      }),
    ),
  ));

effectIt.effect.each([
  {
    label: "an unavailable target",
    problem: "Scratch unavailable inside git checkout",
    detail: /^Scratch unavailable inside git checkout$/,
  },
  { label: "no target", problem: undefined, detail: /Work page/ },
] as const)("a scratch task with $label stops before any agent launches", (entry) =>
  Effect.promise(() =>
    withWorld(script(), (world) =>
      world.server(
        Effect.fn("factoryPack.test.scratchStop")(function* (workflows) {
          if (entry.problem !== undefined) {
            yield* seedTarget(workflows, "scratch", {
              projectId: null,
              workspace: "scratch",
              workspaceRoot: null,
              problem: entry.problem,
            });
          }
          const { runId } = yield* startTask(workflows, null, null);
          const done = yield* world.ended(workflows, runId, true);
          expect(done).toMatchObject({ status: "stopped", result: null });
          expect(done.detail ?? "").toMatch(entry.detail);
          expect(world.startAttempts).toEqual([]);
          expect(world.turns).toEqual([]);
          expect((yield* workflows.list()).filter((run) => run.parentRunId === runId)).toEqual([]);
        }),
      ),
    ),
  ),
);

effectIt.effect.each([
  { label: "unchanged", tampered: false },
  { label: "changed", tampered: true },
] as const)("a report file $label before Accept", (entry) =>
  Effect.promise(() =>
    withReportFile((file) => {
      const answers = script({ noPullRequest: true });
      return withWorld(
        {
          ...answers,
          agent: (turn) =>
            turn.origin.step === "do"
              ? {
                  output: {
                    summary: "Wrote report",
                    prUrl: null,
                    artifacts: [{ path: file, label: "Report" }],
                  },
                }
              : answers.agent(turn),
        },
        (world) =>
          world.server(
            Effect.fn("factoryPack.test.reportHash")(function* (workflows) {
              const { runId } = yield* startTask(workflows);
              yield* approvePlan(world, workflows, runId);
              const child = yield* world.child(workflows, runId, 0);
              const question = yield* ask(world, workflows, child.runId, "accept", "accept", [
                "Accept",
                "Redo",
              ]);
              expect(decodeQuestionData(question.request).data).toMatchObject({
                summary: "Wrote report",
                artifacts: [{ path: file, sha256: REPORT_SHA, bytes: REPORT_BYTES }],
              });
              const artifactKey = `factory/v1/artifact/${TASK_ID}/0001/${REPORT_SHA}`;
              const artifacts = yield* workflows.stored(`factory/v1/artifact/${TASK_ID}/`);
              expect(artifacts.map((row) => row.key)).toEqual([artifactKey]);
              const artifact = yield* decodeArtifact(artifacts[0]?.value).pipe(Effect.orDie);
              expect(artifacts[0]?.value).toEqual(artifact);
              expect(artifact).toMatchObject({
                v: 1,
                taskId: TASK_ID,
                attempt: 1,
                sha256: REPORT_SHA,
                kind: "file",
                location: { _tag: "file", path: file },
                bytes: REPORT_BYTES,
                label: "Report",
              });
              expect(artifact.at).toMatch(ISO);
              const before = yield* workflows.stored(`factory/v1/receipt/${TASK_ID}/`);
              expect(before.filter((row) => /\/(?:accepted|rejected)-/.test(row.key))).toEqual([]);
              if (entry.tampered) NodeFS.appendFileSync(file, "Edited after review.\n");
              yield* workflows.answer(child.runId, "accept", { choice: "Accept" });
              const part = yield* world.ended(workflows, child.runId);
              const done = yield* world.ended(workflows, runId);
              const kind = entry.tampered ? "rejected" : "accepted";
              const receiptKey = `factory/v1/receipt/${TASK_ID}/0001/${kind}-${REPORT_SHA.slice(0, 16)}`;
              const receipts = yield* workflows.stored(`factory/v1/receipt/${TASK_ID}/`);
              const stored = receipts.find((row) => row.key === receiptKey);
              expect(stored, receiptKey).toBeDefined();
              const receipt = yield* decodeReceipt(stored?.value).pipe(Effect.orDie);
              expect(receipt).toMatchObject({
                v: 1,
                taskId: TASK_ID,
                attempt: 1,
                sha256: REPORT_SHA,
                kind,
              });
              expect(receipt.at).toMatch(ISO);
              const opposite = entry.tampered ? "accepted" : "rejected";
              expect(receipts.filter((row) => row.key.includes(`/${opposite}-`))).toEqual([]);
              expect((yield* workflows.stored(`factory/v1/artifact/${TASK_ID}/`)).length).toBe(1);
              if (entry.tampered) {
                expect(part).toMatchObject({
                  status: "stopped",
                  detail: "artifact changed after review",
                  result: null,
                });
                // r9 M1: a part that did not complete is listed with no statistics.
                expect(done.result).toEqual({
                  parts: [{ title: PART.title, outcome: "stopped", prUrl: null, stats: null }],
                });
              } else {
                expect(part).toMatchObject({
                  status: "completed",
                  result: { outcome: "accepted", prUrl: null },
                });
                expect(done.result).toEqual({
                  parts: [
                    { title: PART.title, outcome: "accepted", prUrl: null, stats: ACCEPTED_STATS },
                  ],
                });
              }
              expect(done.status).toBe("completed");
              expect(world.acts).toEqual([]);
            }),
          ),
      );
    }),
  ),
);

it("capture stores the kind of a task", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.captureKind")(function* (workflows) {
        const { runId } = yield* workflows.start(
          "factory-capture",
          {
            title: "Summarize the findings",
            description: "Write up what the team learned.",
            projectId: PROJECT,
            parentId: null,
            blockedBy: [],
            lane: "ready",
            assignee: "developer",
            model: MODEL,
            kind: "knowledge",
          },
          { idempotencyKey: "capture-kind" },
        );
        const done = yield* world.ended(workflows, runId, true);
        expect(done.status).toBe("completed");
        const captured = yield* decodeCapture(done.result).pipe(Effect.orDie);
        const rows = yield* workflows.stored(`factory/v1/task/${captured.taskId}`);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.value).toMatchObject({ kind: "knowledge" });
        const task = yield* decodeFactoryTask(rows[0]?.value).pipe(Effect.orDie);
        expect(task).toMatchObject({
          id: captured.taskId,
          title: "Summarize the findings",
          projectId: PROJECT,
          lane: "ready",
          kind: "knowledge",
        });
      }),
    ),
  ));
