import { FactoryAttempt, type WorkflowRun } from "@t3tools/contracts";
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
  stepTimeout: "45 minutes",
  checksTimeout: "1 hour",
  fixRounds: 2,
  mergeMethod: "squash",
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
      if (step === "do") {
        const prUrl = options.noPullRequest
          ? null
          : `https://github.com/factory/pack/pull/${17 + urls.size}`;
        urls.set(turn.origin.runId, prUrl);
        return { output: { summary: "Implemented the requested part.", prUrl } };
      }
      if (/^review\/\d+$/.test(step)) {
        return {
          output: { verdict: options.changes ? "changes" : "approve", notes: "Review feedback." },
        };
      }
      if (/^fix\/\d+$/.test(step)) return { reply: "Fixed the reported problem." };
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

const startTask = Effect.fn("factoryPack.test.startTask")(function* (workflows: Service) {
  yield* workflows.storeSet("factory/v1/seq", TASK.number);
  yield* workflows.storeSet(`factory/v1/task/${TASK_ID}`, TASK);
  return yield* workflows.start(
    "factory-task",
    {
      taskId: TASK_ID,
      number: TASK.number,
      attempt: 1,
      title: TASK.title,
      description: TASK.description,
      projectId: PROJECT,
      model: MODEL,
      issueUrl: null,
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
  yield* workflows.answer(runId, "approve-merge", { choice: "Merge" }, { label: "Test person" });
});
const tags = (stage: string, taskId = TASK_ID) => [
  `task:${taskId}`,
  `project:${PROJECT}`,
  `stage:${stage}`,
];
const expectTurns = (world: World, runId: string, steps: ReadonlyArray<string>) => {
  const turns = world.turns.filter((turn) => turn.origin.runId === runId);
  expect(turns.map((turn) => turn.origin.step)).toEqual(steps);
  const work = turns.find((turn) => turn.origin.step === "do");
  for (const turn of turns) {
    if (turn.origin.step.startsWith("fix/")) {
      expect(work).toBeDefined();
      expect(turn.thread).toBe(`thread-${work?.key}`);
    } else {
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
const expectMerged = (world: World, parent: WorkflowRun, child: WorkflowRun, prUrl: string) => {
  expect(child.status).toBe("completed");
  expect(child.result).toEqual({ outcome: "merged", prUrl });
  expect(child.parentRunId).toBe(parent.runId);
  expect(child.parentStep).toBe("part-0");
  expectTags(world, child, "review");
  expect(parent.status).toBe("completed");
  expect(parent.result).toEqual({ parts: [{ title: PART.title, outcome: "merged", prUrl }] });
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
        expectMerged(world, done, part, "https://github.com/factory/pack/pull/17");
        expectTurns(world, runId, ["plan"]);
        expectTurns(world, child.runId, ["do", "review/0"]);
        expect(world.turns).toHaveLength(3);
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
        expectMerged(world, done, child, "https://github.com/factory/pack/pull/17");
        expectTurns(world, runId, ["plan"]);
        expectTurns(world, child.runId, ["do", "review/0"]);
        expect(world.turns).toHaveLength(3);
        expectQuestions(world, []);
        expect(yield* workflows.questions).toEqual([]);
      }),
    ),
  ));

it("failing checks continue the do thread in fix/0 before review and merge", () =>
  withWorld(script({ checks: ["failing", "passing"] }), (world) =>
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
        );
        expectTurns(world, runId, ["plan"]);
        expectTurns(world, child.runId, ["do", "fix/0", "review/1"]);
        expect(world.turns).toHaveLength(4);
        expect(world.reads.map(({ standing }) => standing.checks)).toEqual([
          "failing",
          "passing",
          "passing",
        ]);
        expect(
          (yield* workflows.get(child.runId)).steps
            .filter((step) => step.name.startsWith("checks/"))
            .map((step) => step.name),
        ).toEqual(["checks/0", "checks/1"]);
        expectQuestions(world, [
          [runId, "approve-plan", "plan"],
          [child.runId, "approve-merge", "merge"],
        ]);
      }),
    ),
  ));

it("fixRounds one asks stuck after two changes reviews and Stop ends only the part", () =>
  withWorld(script({ changes: true }), (world) =>
    world.server(
      Effect.fn("factoryPack.test.stuck")(function* (workflows) {
        yield* workflows.storeSet("factory/v1/config", { v: 1, fixRounds: 1 });
        const { runId } = yield* startTask(workflows);
        yield* approvePlan(world, workflows, runId);
        const child = yield* world.child(workflows, runId, 0);
        yield* ask(world, workflows, child.runId, "stuck", "stuck", ["Merge anyway", "Stop"]);
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
        expect(done.result).toEqual({
          parts: [{ title: PART.title, outcome: "stopped", prUrl: null }],
        });
        expectTags(world, done, "done");
        expectTurns(world, runId, ["plan"]);
        expectTurns(world, child.runId, ["do", "review/0", "fix/0", "review/1"]);
        expect(world.turns).toHaveLength(5);
        expectQuestions(world, [
          [runId, "approve-plan", "plan"],
          [child.runId, "stuck", "stuck"],
        ]);
        expect(world.acts).toEqual([]);
        expect(world.reads.map(({ standing }) => standing.checks)).toEqual(["passing", "passing"]);
        expect(world.issueQueries).toEqual([]);
        yield* expectNote(workflows, TASK_ID, [{ title: PART.title, outcome: "stopped" }]);
      }),
    ),
  ));

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
          parts: [{ title: PART.title, outcome: "accepted", prUrl: null }],
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
        expect(done.result).toEqual({
          parts: parts.map((part, index) => ({
            title: part.title,
            outcome: "merged",
            prUrl: answers.urls.get(children[index]?.runId ?? ""),
          })),
        });
        expectTags(world, done, "done");
        for (const [index, child] of children.entries()) {
          expect(child.parentStep).toBe(`part-${index}`);
          expect(child.status).toBe("completed");
          expect(child.result).toEqual({ outcome: "merged", prUrl: answers.urls.get(child.runId) });
          expectTags(world, child, "review");
          expectTurns(world, child.runId, ["do", "review/0"]);
        }
        expectTurns(world, runId, ["plan"]);
        expect(world.turns).toHaveLength(5);
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
        expectMerged(world, done, child, "https://github.com/factory/pack/pull/17");
        expect(
          (yield* workflows.get(runId)).steps.find((step) => step.name === "config")?.result,
        ).toEqual({ ...DEFAULT_CONFIG, askPlan: false, askMerge: false });
        expectTurns(world, runId, ["plan"]);
        expectTurns(world, child.runId, ["do", "review/0"]);
        expect(world.turns).toHaveLength(3);
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
          expectTurns(world, child.runId, ["do", "review/0"]);
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
          expectMerged(world, done, child, "https://github.com/factory/pack/pull/17");
          expect(world.turns.map((turn) => turn.key)).toEqual(waiting.keys);
          expect(world.turns).toHaveLength(3);
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
          expect(done.result).toEqual({
            parts: [
              {
                title: PART.title,
                outcome: entry.merged ? "merged" : "stopped",
                prUrl: entry.merged ? PR_URL : null,
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
          expectTurns(world, child.runId, ["do", "review/0"]);
          expectTags(world, done, "done");
        }),
      ),
    ),
  ),
);

it("P2 refuses a pull request outside the project before checks, reviews or acts", () =>
  withWorld({ ...script(), pullRequests: [pullRequestAt(99)] }, (world) =>
    world.server(
      Effect.fn("factoryPack.test.foreignPullRequest")(function* (workflows) {
        yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false, askMerge: false });
        const { runId } = yield* startTask(workflows);
        const child = yield* world.child(workflows, runId, 0);
        const part = yield* world.ended(workflows, child.runId);
        const done = yield* world.ended(workflows, runId);
        expect(part).toMatchObject({
          status: "stopped",
          detail: "pull request is not this project's",
          result: null,
        });
        expect(done.result).toEqual({
          parts: [{ title: PART.title, outcome: "stopped", prUrl: null }],
        });
        expect(done.status).toBe("completed");
        const { steps } = yield* workflows.get(child.runId);
        expect(steps.find((step) => step.name === "pull-request")?.status).toBe("completed");
        expect(steps.filter((step) => step.kind === "wait")).toEqual([]);
        expectTurns(world, child.runId, ["do"]);
        expect(world.pullRequestQueries).toHaveLength(1);
        expect(world.pullRequestQueries[0]).toMatchObject({ project: PROJECT, state: "all" });
        expect(world.reads).toEqual([]);
        expect(world.acts).toEqual([]);
        expectQuestions(world, []);
      }),
    ),
  ));

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
                parts: [{ title: PART.title, outcome: "stopped", prUrl: null }],
              });
              expectTurns(world, child.runId, ["do"]);
              expect(
                (yield* workflows.get(child.runId)).steps.filter((step) => step.kind === "wait"),
              ).toEqual([]);
              expect(world.reads).toEqual([]);
              expect(world.acts).toEqual([]);
              return;
            }
            expect(done.result).toEqual({
              parts: [{ title: PART.title, outcome: "merged", prUrl: PR_URL }],
            });
            expect(child.result).toEqual({ outcome: "merged", prUrl: PR_URL });
            expectTurns(world, child.runId, ["do", "review/0"]);
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
      const answers = script({ parts: SIX_PARTS, noPullRequest: waitingOn === "person" });
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
                const reviews = yield* heldPair(world, workflows, allChildren, "review/1");
                for (const review of reviews) yield* world.releaseTurn(review);
                for (const index of [2, 3, 4, 5]) {
                  const review = yield* world.nextTurn;
                  expect(review.origin.step, `review ${index}`).toBe("review/1");
                  yield* world.releaseTurn(review);
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
              expect(done.result).toEqual({
                parts: SIX_PARTS.map((part, index) => ({
                  title: part.title,
                  outcome: waitingOn === "person" ? "accepted" : "merged",
                  prUrl:
                    waitingOn === "person" ? null : answers.urls.get(children[index]?.runId ?? ""),
                })),
              });
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
          parts: [{ title: PART.title, outcome: "merged", prUrl: PR_URL }],
        });
        expect(world.finishExecutions).toEqual([runId, runId]);
        expect(yield* workflows.stored(`factory/v1/note/${TASK_ID}/`)).toEqual(notes);
        expect(world.turns.map((turn) => turn.key)).toEqual(turns);
        expect(world.acts).toHaveLength(1);
      }),
    ),
  ));

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
          expect(done.result).toEqual({
            parts: [{ title: PART.title, outcome: "merged", prUrl: PR_URL }],
          });
          expect((yield* workflows.get(child.runId)).run.result).toEqual({
            outcome: "merged",
            prUrl: PR_URL,
          });
          expect(world.reads.map((read) => read.standing.state)).toEqual(["open", "merged"]);
          expect(world.acts).toEqual([]);
          expectTurns(world, child.runId, ["do", "review/0"]);
        }),
      ),
  );
});

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
            parts: [{ title: PART.title, outcome: "merged", prUrl: PR_URL }],
          });
        }),
      ),
    ),
  ),
);
