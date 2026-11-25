import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type FactoryAttempt,
  type FactoryNote,
  type FactoryTask,
  type FactoryTaskCreateInput,
  type FactoryTaskError,
  type FactoryTaskPatch,
  type FactoryTasksUpdate,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type WorkflowRun,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import { KeyValues, layerKeyValues } from "../workflows/stepServices.ts";
import * as Workflows from "../workflows/Workflows.ts";
import * as FactoryTasks from "./FactoryTasks.ts";

const EPOCH = "1970-01-01T00:00:00.000Z";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISSUE = {
  _tag: "issue",
  url: "https://github.com/acme/app/issues/7",
  displayKey: "acme/app#7",
} as const;

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const taskKey = (taskId: string) => `factory/v1/task/${taskId}`;
const attemptKey = (taskId: string, n: number) =>
  `factory/v1/attempt/${taskId}/${String(n).padStart(4, "0")}`;
const isoNow = Effect.map(DateTime.now, DateTime.formatIso);

/** A task as a workflow step or the CLI writes it, straight into the store. */
const outsideTask = (
  id: string,
  number: number,
  fields: Partial<FactoryTask> = {},
): FactoryTask => ({
  v: 1,
  id,
  number,
  rev: 1,
  projectId: null,
  title: `Task ${number}`,
  description: "",
  lane: "backlog",
  laneSetAt: EPOCH,
  parentId: null,
  blockedBy: [],
  assignee: null,
  model: null,
  source: { _tag: "local" },
  createdAt: EPOCH,
  updatedAt: EPOCH,
  ...fields,
});

const outsideAttempt = (taskId: string, n: number): FactoryAttempt => ({
  v: 1,
  taskId,
  n,
  key: `task/${taskId}/a${n}`,
  workflow: "factory-task",
  runId: `run-${n}`,
  requestedBy: "agent",
  startedAt: EPOCH,
});

const outsideNote = (taskId: string, index: number): FactoryNote => {
  const at = DateTime.formatIso(DateTime.makeUnsafe(index * 1000));
  return {
    v: 1,
    taskId,
    id: `${at}-${index.toString(16).padStart(8, "0")}`,
    text: `Note ${index}`,
    by: "agent",
    at,
  };
};

const put = (key: string, value: unknown) =>
  Effect.flatMap(KeyValues, (keyValues) => keyValues.set(key, JSON.stringify(value)));

const record = (key: string) =>
  Effect.map(
    Effect.flatMap(KeyValues, (keyValues) => keyValues.get(key)),
    (raw): unknown => (raw === undefined ? undefined : JSON.parse(raw)),
  );

/** Every row of the store, with the time it was last written. */
const storeRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly key: string; readonly value_json: string; readonly updated_at: string }>`
    SELECT key, value_json, updated_at FROM workflow_store ORDER BY key
  `,
);

const reasonOf = <A>(effect: Effect.Effect<A, FactoryTaskError>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

const summaryOf = (task: FactoryTask, attempt: FactoryAttempt | null) => {
  const { description, ...rest } = task;
  return { ...rest, hasDescription: description !== "", attempt };
};

const byId = <T extends { readonly id: string }>(items: ReadonlyArray<T>) =>
  [...items].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

type Updates = Queue.Dequeue<FactoryTasksUpdate, Cause.Done>;

/** The next element, which must be a snapshot; R6 leaves the order of its tasks open. */
const snapshot = (updates: Updates) =>
  Effect.flatMap(Queue.take(updates), (update) =>
    "_tag" in update
      ? Effect.die(new Error(`Expected a snapshot, got ${JSON.stringify(update)}`))
      : Effect.succeed({ ...update, tasks: byId(update.tasks) }),
  );

/** The next element, which must be a change; R6 leaves the order of its lists open. */
const change = (updates: Updates) =>
  Effect.flatMap(Queue.take(updates), (update) =>
    "_tag" in update
      ? Effect.succeed({
          ...update,
          tasks: byId(update.tasks),
          removed: [...update.removed].sort(),
        })
      : Effect.die(new Error(`Expected a change, got ${JSON.stringify(update)}`)),
  );

const workflowRun = (runId: string, endedAt: string | null): WorkflowRun => ({
  runId,
  workflow: "factory-task",
  version: 1,
  title: "",
  status: endedAt === null ? "running" : "completed",
  detail: null,
  result: null,
  pauses: 0,
  retired: false,
  resumesAt: null,
  parentRunId: null,
  parentStep: null,
  startedAt: EPOCH,
  updatedAt: EPOCH,
  endedAt,
});

interface StartCall {
  readonly workflow: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
}

/** `Workflows` whose `start` and `get` answer as the test sets `answers`, keeping every call. */
interface FakeWorkflows {
  readonly service: Workflows.Workflows["Service"];
  readonly starts: ReadonlyArray<StartCall>;
  readonly gets: ReadonlyArray<string>;
  readonly answers: {
    start: (call: StartCall) => Effect.Effect<{ readonly runId: string }, Workflows.WorkflowError>;
    get: (
      runId: string,
    ) => Effect.Effect<
      WorkflowRun,
      Workflows.WorkflowRunNotFoundError | Workflows.WorkflowInputError
    >;
  };
}

const fakeWorkflows = (): FakeWorkflows => {
  const starts: Array<StartCall> = [];
  const gets: Array<string> = [];
  const answers: FakeWorkflows["answers"] = {
    start: () => Effect.succeed({ runId: `run-${starts.length}` }),
    get: (runId) => Effect.succeed(workflowRun(runId, EPOCH)),
  };
  const service = Workflows.Workflows.of({
    ...Workflows.disabled,
    start: (workflow, input, options) =>
      Effect.suspend(() => {
        const call = { workflow, input, idempotencyKey: options.idempotencyKey };
        starts.push(call);
        return answers.start(call);
      }),
    get: (runId) =>
      Effect.suspend(() => {
        gets.push(runId);
        return Effect.map(answers.get(runId), (run) => ({ run, steps: [], references: [] }));
      }),
  });
  return { service, starts, gets, answers };
};

/** Makes `Workflows.start` hold until `release`; `entered` waits until it was called. */
const holdStart = (workflows: FakeWorkflows) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    workflows.answers.start = () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as({ runId: "run-held" }),
      );
    return { entered: Deferred.await(entered), release: Deferred.succeed(release, undefined) };
  });

const withFactory = <A, E>(
  use: (
    workflows: FakeWorkflows,
  ) => Effect.Effect<
    A,
    E,
    FactoryTasks.FactoryTasks | KeyValues | SqlClient.SqlClient | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-factory-tasks-" });
    const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
    const workflows = fakeWorkflows();
    return yield* Effect.provide(
      Effect.scoped(use(workflows)),
      Layer.merge(FactoryTasks.layer, layerKeyValues).pipe(
        Layer.provide(Layer.succeed(Workflows.Workflows, workflows.service)),
        Layer.provideMerge(Layer.effectDiscard(runMigrations())),
        Layer.provideMerge(database),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("R1 create", () => {
  // R1: title trimmed, defaults filled, times now, number is seq + 1 and seq is stored.
  it.effect("a new task takes the defaults and the number after seq, which it stores", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const at = yield* isoNow;
        const first = yield* tasks.create({ projectId: null, title: "  Fix the build  " });
        assert.match(first.id, UUID);
        assert.deepStrictEqual(first, {
          v: 1,
          id: first.id,
          number: 1,
          rev: 1,
          projectId: null,
          title: "Fix the build",
          description: "",
          lane: "backlog",
          laneSetAt: at,
          parentId: null,
          blockedBy: [],
          assignee: null,
          model: null,
          source: { _tag: "local" },
          createdAt: at,
          updatedAt: at,
        });
        assert.deepStrictEqual(yield* record(taskKey(first.id)), first);
        assert.strictEqual(yield* record("factory/v1/seq"), 1);

        const second = yield* tasks.create({ projectId: null, title: "Second" });
        assert.strictEqual(second.number, 2);
        assert.notStrictEqual(second.id, first.id);
        assert.strictEqual(yield* record("factory/v1/seq"), 2);

        yield* put("factory/v1/seq", 41);
        assert.strictEqual((yield* tasks.create({ projectId: null, title: "Third" })).number, 42);
        assert.strictEqual(yield* record("factory/v1/seq"), 42);
      }),
    ),
  );

  // R1: a stored seq that is not a non-negative integer gives way to the highest stored number.
  it.effect("a damaged seq never hands out a number a stored task holds", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const keyValues = yield* KeyValues;
        yield* tasks.create({ projectId: null, title: "First" });
        yield* tasks.create({ projectId: null, title: "Second" });
        const damaged = [JSON.stringify("7"), "-1", "1.5", "null", "not json"];
        const handedOut = yield* Effect.forEach(damaged, (seq) =>
          Effect.gen(function* () {
            yield* keyValues.set("factory/v1/seq", seq);
            const third = yield* tasks.create({ projectId: null, title: "Third" });
            const stored = yield* record("factory/v1/seq");
            yield* keyValues.delete(taskKey(third.id));
            return [third.number, stored];
          }),
        );
        assert.deepStrictEqual(
          handedOut,
          damaged.map(() => [3, 3]),
        );
      }),
    ),
  );

  // R1: given fields are kept; blockedBy drops repeats and keeps first occurrences.
  it.effect("given fields are kept and repeated blockers collapse to their first occurrence", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const parent = yield* tasks.create({ projectId: null, title: "Parent" });
        const blocker = yield* tasks.create({ projectId: null, title: "Blocker" });
        const projectId = ProjectId.make("project-1");
        const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
        yield* TestClock.adjust("1 minute");
        const at = yield* isoNow;
        const task = yield* tasks.create({
          projectId,
          title: "Child",
          description: "Do the thing",
          lane: "ready",
          parentId: parent.id,
          blockedBy: [blocker.id, parent.id, blocker.id],
          assignee: "ana",
          model,
          source: ISSUE,
        });
        assert.deepStrictEqual(task, {
          v: 1,
          id: task.id,
          number: 3,
          rev: 1,
          projectId,
          title: "Child",
          description: "Do the thing",
          lane: "ready",
          laneSetAt: at,
          parentId: parent.id,
          blockedBy: [blocker.id, parent.id],
          assignee: "ana",
          model,
          source: ISSUE,
          createdAt: at,
          updatedAt: at,
        });
      }),
    ),
  );

  // R1 (AMBIGUOUS: a refused create uses no number): bad title, description, assignee or link.
  it.effect("an out-of-bounds title, description or assignee, or an unknown link, is invalid", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const keyValues = yield* KeyValues;
        const known = yield* tasks.create({ projectId: null, title: "Known" });
        const missing = uuid(99);
        const refused: ReadonlyArray<FactoryTaskCreateInput> = [
          { projectId: null, title: "   " },
          { projectId: null, title: "x".repeat(201) },
          { projectId: null, title: "Long", description: "x".repeat(8001) },
          { projectId: null, title: "Orphan", parentId: missing },
          { projectId: null, title: "Blocked", blockedBy: [known.id, missing] },
          { projectId: null, title: "Assigned", assignee: "x".repeat(101) },
        ];
        assert.deepStrictEqual(
          yield* Effect.forEach(refused, (input) => reasonOf(tasks.create(input))),
          refused.map(() => "invalid"),
        );
        assert.deepStrictEqual(
          (yield* keyValues.list("factory/v1/task/")).map((row) => row.key),
          [taskKey(known.id)],
        );

        const longest = yield* tasks.create({
          projectId: null,
          title: `  ${"x".repeat(200)}  `,
          description: "x".repeat(8000),
          assignee: "x".repeat(100),
        });
        assert.deepStrictEqual(
          [longest.title, longest.description, longest.assignee, longest.number],
          ["x".repeat(200), "x".repeat(8000), "x".repeat(100), 2],
        );
      }),
    ),
  );

  // R1 (AMBIGUOUS: the limit counts ids after repeats go): over 50 blockers is invalid.
  it.effect("more than 50 distinct blockers are invalid", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const blockers = yield* Effect.forEach(
          Array.from({ length: 51 }, (_, index) => index),
          (index) => tasks.create({ projectId: null, title: `Blocker ${index}` }),
        );
        const ids = blockers.map((task) => task.id);
        assert.strictEqual(
          yield* reasonOf(tasks.create({ projectId: null, title: "Too many", blockedBy: ids })),
          "invalid",
        );
        const fifty = yield* tasks.create({
          projectId: null,
          title: "Fifty",
          blockedBy: [...ids.slice(0, 50), ids[0]!],
        });
        assert.deepStrictEqual(fifty.blockedBy, ids.slice(0, 50));
      }),
    ),
  );
});

describe("R2 update", () => {
  // R2: unknown task is not-found; a stale rev conflicts with the stored rev and writes nothing.
  it.effect("an unknown task is not found, and a stale rev conflicts without writing", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        assert.strictEqual(
          yield* reasonOf(tasks.update({ taskId: uuid(99), rev: 1, patch: {} })),
          "not-found",
        );
        const task = yield* tasks.create({ projectId: null, title: "Task" });
        yield* tasks.update({ taskId: task.id, rev: 1, patch: { title: "Renamed" } });
        yield* TestClock.adjust("1 minute");
        const before = yield* storeRows;
        const conflicts = yield* Effect.forEach([1, 3], (rev) =>
          Effect.flip(
            tasks.update({ taskId: task.id, rev, patch: { title: "Lost" }, note: "Lost note" }),
          ),
        );
        assert.deepStrictEqual(
          conflicts.map((error) => [error.reason, error.rev]),
          [
            ["conflict", 2],
            ["conflict", 2],
          ],
        );
        assert.deepStrictEqual(yield* storeRows, before);
      }),
    ),
  );

  // R2: success is rev + 1 and updatedAt now, even when empty; laneSetAt moves with the lane only.
  it.effect("every update bumps rev and updatedAt, and laneSetAt only when the lane changes", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const task = yield* tasks.create({ projectId: null, title: "Task" });

        yield* TestClock.adjust("1 minute");
        const emptyAt = yield* isoNow;
        const empty = yield* tasks.update({ taskId: task.id, rev: 1, patch: {} });
        assert.deepStrictEqual(empty, { ...task, rev: 2, updatedAt: emptyAt });

        yield* TestClock.adjust("1 minute");
        const sameAt = yield* isoNow;
        const sameLane = yield* tasks.update({
          taskId: task.id,
          rev: 2,
          patch: { lane: "backlog" },
        });
        assert.deepStrictEqual(sameLane, { ...task, rev: 3, updatedAt: sameAt });

        yield* TestClock.adjust("1 minute");
        const movedAt = yield* isoNow;
        const moved = yield* tasks.update({ taskId: task.id, rev: 3, patch: { lane: "ready" } });
        assert.deepStrictEqual(moved, {
          ...task,
          rev: 4,
          lane: "ready",
          laneSetAt: movedAt,
          updatedAt: movedAt,
        });
        assert.deepStrictEqual(yield* record(taskKey(task.id)), moved);
      }),
    ),
  );

  // R2: the service, not the schema, checks patched fields as in R1; a refused patch writes nothing.
  it.effect("patched fields are validated as on create and stored", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const parent = yield* tasks.create({ projectId: null, title: "Parent" });
        const blocker = yield* tasks.create({ projectId: null, title: "Blocker" });
        const task = yield* tasks.create({ projectId: null, title: "Task" });
        const many = yield* Effect.forEach(
          Array.from({ length: 51 }, (_, index) => index),
          (index) => tasks.create({ projectId: null, title: `Blocker ${index}` }),
        );
        yield* TestClock.adjust("1 minute");
        const before = yield* storeRows;
        const missing = uuid(99);
        const refused: ReadonlyArray<FactoryTaskPatch> = [
          { title: "   " },
          { title: "x".repeat(201) },
          { description: "x".repeat(8001) },
          { parentId: missing },
          { blockedBy: [blocker.id, missing] },
          { blockedBy: many.map((other) => other.id) },
          { assignee: "x".repeat(101) },
        ];
        assert.deepStrictEqual(
          yield* Effect.forEach(refused, (patch) =>
            reasonOf(tasks.update({ taskId: task.id, rev: 1, patch })),
          ),
          refused.map(() => "invalid"),
        );
        assert.deepStrictEqual(yield* storeRows, before);

        const at = yield* isoNow;
        const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
        const patched = yield* tasks.update({
          taskId: task.id,
          rev: 1,
          patch: {
            title: "  Renamed  ",
            description: "x".repeat(8000),
            parentId: parent.id,
            blockedBy: [blocker.id, parent.id, blocker.id],
            assignee: "bo",
            model,
          },
        });
        assert.deepStrictEqual(patched, {
          ...task,
          rev: 2,
          title: "Renamed",
          description: "x".repeat(8000),
          parentId: parent.id,
          blockedBy: [blocker.id, parent.id],
          assignee: "bo",
          model,
          updatedAt: at,
        });
        const cleared = yield* tasks.update({
          taskId: task.id,
          rev: 2,
          patch: { parentId: null, blockedBy: [], assignee: null, model: null },
        });
        assert.deepStrictEqual(cleared, {
          ...patched,
          rev: 3,
          parentId: null,
          blockedBy: [],
          assignee: null,
          model: null,
        });
      }),
    ),
  );

  // R2: only links a patch adds must exist; links the task held stay valid once unreadable.
  it.effect(
    "a task whose links no longer decode can still be edited, but a new link must exist",
    () =>
      withFactory(() =>
        Effect.gen(function* () {
          const tasks = yield* FactoryTasks.FactoryTasks;
          const keyValues = yield* KeyValues;
          const parent = yield* tasks.create({ projectId: null, title: "Parent" });
          const blocker = yield* tasks.create({ projectId: null, title: "Blocker" });
          const other = yield* tasks.create({ projectId: null, title: "Other" });
          const task = yield* tasks.create({
            projectId: null,
            title: "Task",
            parentId: parent.id,
            blockedBy: [blocker.id],
          });
          yield* keyValues.set(taskKey(parent.id), "not json");
          yield* put(taskKey(blocker.id), { v: 1, id: blocker.id });
          yield* TestClock.adjust("1 minute");
          const at = yield* isoNow;

          const moved = yield* tasks.update({ taskId: task.id, rev: 1, patch: { lane: "ready" } });
          assert.deepStrictEqual(moved, {
            ...task,
            rev: 2,
            lane: "ready",
            laneSetAt: at,
            updatedAt: at,
          });
          const edited = yield* tasks.update({
            taskId: task.id,
            rev: 2,
            patch: {
              title: "Edited",
              description: "Still linked",
              parentId: parent.id,
              blockedBy: [blocker.id, other.id],
            },
          });
          assert.deepStrictEqual(edited, {
            ...moved,
            rev: 3,
            title: "Edited",
            description: "Still linked",
            blockedBy: [blocker.id, other.id],
          });

          assert.strictEqual(
            yield* reasonOf(
              tasks.update({
                taskId: task.id,
                rev: 3,
                patch: { blockedBy: [blocker.id, uuid(99)] },
              }),
            ),
            "invalid",
          );
          assert.deepStrictEqual(yield* record(taskKey(task.id)), edited);
        }),
      ),
  );

  // R2: parentId naming the task itself or any descendant is invalid.
  it.effect("a task cannot become its own parent or the child of a descendant", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const root = yield* tasks.create({ projectId: null, title: "Root" });
        const child = yield* tasks.create({ projectId: null, title: "Child", parentId: root.id });
        const grandchild = yield* tasks.create({
          projectId: null,
          title: "Grandchild",
          parentId: child.id,
        });
        assert.deepStrictEqual(
          yield* Effect.forEach([root.id, child.id, grandchild.id], (parentId) =>
            reasonOf(tasks.update({ taskId: root.id, rev: 1, patch: { parentId } })),
          ),
          ["invalid", "invalid", "invalid"],
        );
        assert.deepStrictEqual(yield* record(taskKey(root.id)), root);

        const moved = yield* tasks.update({
          taskId: grandchild.id,
          rev: 1,
          patch: { parentId: root.id },
        });
        assert.strictEqual(moved.parentId, root.id);
      }),
    ),
  );

  // R2: blockedBy that makes the task block itself, directly or through others, is invalid.
  it.effect("a task cannot be blocked by itself, directly or through other tasks", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const first = yield* tasks.create({ projectId: null, title: "First" });
        const second = yield* tasks.create({
          projectId: null,
          title: "Second",
          blockedBy: [first.id],
        });
        const third = yield* tasks.create({
          projectId: null,
          title: "Third",
          blockedBy: [second.id],
        });
        assert.deepStrictEqual(
          yield* Effect.forEach([first.id, second.id, third.id], (blocker) =>
            reasonOf(tasks.update({ taskId: first.id, rev: 1, patch: { blockedBy: [blocker] } })),
          ),
          ["invalid", "invalid", "invalid"],
        );
        assert.deepStrictEqual(yield* record(taskKey(first.id)), first);

        const joined = yield* tasks.update({
          taskId: third.id,
          rev: 1,
          patch: { blockedBy: [second.id, first.id] },
        });
        assert.deepStrictEqual(joined.blockedBy, [second.id, first.id]);
      }),
    ),
  );

  // R2: a note is trimmed and stored by "client" with the update; blank or over 4000 is invalid.
  it.effect("a note is stored with the update, and a blank or long note is invalid", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const keyValues = yield* KeyValues;
        const task = yield* tasks.create({ projectId: null, title: "Task" });
        yield* TestClock.adjust("1 minute");
        const before = yield* storeRows;
        assert.deepStrictEqual(
          yield* Effect.forEach(["   ", "x".repeat(4001)], (note) =>
            reasonOf(tasks.update({ taskId: task.id, rev: 1, patch: {}, note })),
          ),
          ["invalid", "invalid"],
        );
        assert.deepStrictEqual(yield* storeRows, before);

        const at = yield* isoNow;
        const updated = yield* tasks.update({
          taskId: task.id,
          rev: 1,
          patch: {},
          note: "  Looks right  ",
        });
        assert.strictEqual(updated.rev, 2);
        const { notes } = yield* tasks.get(task.id);
        assert.strictEqual(notes.length, 1);
        const note = notes[0]!;
        assert.deepStrictEqual(note, {
          v: 1,
          taskId: task.id,
          id: note.id,
          text: "Looks right",
          by: "client",
          at,
        });
        const keys = (yield* keyValues.list(`factory/v1/note/${task.id}/`)).map((row) => row.key);
        assert.strictEqual(keys.length, 1);
        const prefix = `factory/v1/note/${task.id}/${at}-`;
        assert.isTrue(keys[0]!.startsWith(prefix), keys[0]);
        assert.match(keys[0]!.slice(prefix.length), /^[0-9a-f]{8}$/);

        yield* tasks.update({ taskId: task.id, rev: 2, patch: {}, note: "x".repeat(4000) });
        assert.strictEqual((yield* tasks.get(task.id)).notes.length, 2);
      }),
    ),
  );
});

describe("R3 start", () => {
  // R3: attempt 1 is written before start, which gets the run input and key; then lane doing.
  it.effect(
    "start writes attempt 1, then starts factory-task with the run input under its key",
    () =>
      withFactory((workflows) =>
        Effect.gen(function* () {
          const tasks = yield* FactoryTasks.FactoryTasks;
          const keyValues = yield* KeyValues;
          const projectId = ProjectId.make("project-1");
          const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
          const task = yield* tasks.create({
            projectId,
            title: "Ship it",
            description: "All of it",
            model,
            source: ISSUE,
          });
          yield* TestClock.adjust("1 minute");
          const at = yield* isoNow;
          const key = `task/${task.id}/a1`;
          const seenAtStart: Array<unknown> = [];
          workflows.answers.start = () =>
            Effect.map(keyValues.get(attemptKey(task.id, 1)), (raw) => {
              seenAtStart.push(raw === undefined ? undefined : JSON.parse(raw));
              return { runId: "run-a1" };
            });

          const attempt = yield* tasks.start({ taskId: task.id }, "tester");
          const written: FactoryAttempt = {
            v: 1,
            taskId: task.id,
            n: 1,
            key,
            workflow: "factory-task",
            runId: null,
            requestedBy: "tester",
            startedAt: at,
          };
          assert.deepStrictEqual(seenAtStart, [written]);
          assert.strictEqual(FactoryTasks.FACTORY_TASK_WORKFLOW, "factory-task");
          assert.deepStrictEqual(workflows.starts, [
            {
              workflow: "factory-task",
              input: {
                taskId: task.id,
                number: 1,
                attempt: 1,
                title: "Ship it",
                description: "All of it",
                projectId: "project-1",
                model: { instanceId: "codex", model: "gpt-5" },
                issueUrl: ISSUE.url,
              },
              idempotencyKey: key,
            },
          ]);
          assert.deepStrictEqual(workflows.gets, []);
          assert.deepStrictEqual(attempt, { ...written, runId: "run-a1" });
          assert.deepStrictEqual(yield* record(attemptKey(task.id, 1)), attempt);
          assert.deepStrictEqual(yield* tasks.get(task.id), {
            task: { ...task, lane: "doing", laneSetAt: at, updatedAt: at, rev: 2 },
            attempts: [attempt],
            notes: [],
          });
        }),
      ),
  );

  // R3: an unknown task is not-found and a dropped one invalid; neither writes or starts.
  it.effect("an unknown or dropped task does not start", () =>
    withFactory((workflows) =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const keyValues = yield* KeyValues;
        assert.strictEqual(
          yield* reasonOf(tasks.start({ taskId: uuid(99) }, "tester")),
          "not-found",
        );
        const task = yield* tasks.create({ projectId: null, title: "Dropped" });
        yield* tasks.update({ taskId: task.id, rev: 1, patch: { lane: "dropped" } });
        assert.strictEqual(yield* reasonOf(tasks.start({ taskId: task.id }, "tester")), "invalid");
        assert.deepStrictEqual(yield* keyValues.list("factory/v1/attempt/"), []);
        assert.deepStrictEqual(workflows.starts, []);
      }),
    ),
  );

  // R3: a run not ended is already-running; an ended run or a failing get allows n + 1.
  it.effect(
    "a running attempt refuses a new start, and an ended or unknown run allows the next",
    () =>
      withFactory((workflows) =>
        Effect.gen(function* () {
          const tasks = yield* FactoryTasks.FactoryTasks;
          const task = yield* tasks.create({ projectId: null, title: "Again" });
          const at = yield* isoNow;
          const attemptOf = (n: number): FactoryAttempt => ({
            v: 1,
            taskId: task.id,
            n,
            key: `task/${task.id}/a${n}`,
            workflow: "factory-task",
            runId: `run-${n}`,
            requestedBy: "tester",
            startedAt: at,
          });
          const first = yield* tasks.start({ taskId: task.id }, "tester");
          assert.deepStrictEqual(first, attemptOf(1));
          const started = yield* tasks.get(task.id);

          workflows.answers.get = (runId) => Effect.succeed(workflowRun(runId, null));
          assert.strictEqual(
            yield* reasonOf(tasks.start({ taskId: task.id }, "tester")),
            "already-running",
          );
          assert.deepStrictEqual(workflows.gets, ["run-1"]);
          assert.strictEqual(workflows.starts.length, 1);
          assert.deepStrictEqual(yield* tasks.get(task.id), started);

          workflows.answers.get = (runId) => Effect.succeed(workflowRun(runId, EPOCH));
          const second = yield* tasks.start({ taskId: task.id }, "tester");
          assert.deepStrictEqual(second, attemptOf(2));

          workflows.answers.get = (runId) =>
            Effect.fail(new Workflows.WorkflowRunNotFoundError({ runId }));
          const third = yield* tasks.start({ taskId: task.id }, "tester");
          assert.deepStrictEqual(third, attemptOf(3));

          assert.deepStrictEqual(workflows.gets, ["run-1", "run-1", "run-2"]);
          assert.deepStrictEqual(
            workflows.starts.map((call) => [call.idempotencyKey, call.input]),
            [1, 2, 3].map((n) => [
              `task/${task.id}/a${n}`,
              {
                taskId: task.id,
                number: task.number,
                attempt: n,
                title: "Again",
                description: "",
                projectId: null,
                model: null,
                issueUrl: null,
              },
            ]),
          );
          assert.deepStrictEqual((yield* tasks.get(task.id)).attempts, [first, second, third]);
        }),
      ),
  );

  // R3 (AMBIGUOUS: "carrying its message" as the same message): refusals keep runId null.
  it.effect("a refused start leaves its attempt without a run, and the next start reuses it", () =>
    withFactory((workflows) =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const keyValues = yield* KeyValues;
        const task = yield* tasks.create({ projectId: null, title: "Later" });
        const at = yield* isoNow;
        const key = `task/${task.id}/a1`;

        workflows.answers.start = () =>
          Effect.fail(new Workflows.WorkflowInputError({ problem: Workflows.OFF }));
        assert.strictEqual(
          yield* reasonOf(tasks.start({ taskId: task.id }, "tester")),
          "workflows-off",
        );
        workflows.answers.start = () =>
          Effect.fail(new Workflows.WorkflowNotRegisteredError({ workflow: "factory-task" }));
        assert.strictEqual(
          yield* reasonOf(tasks.start({ taskId: task.id }, "tester")),
          "workflow-missing",
        );
        workflows.answers.start = () =>
          Effect.fail(new Workflows.WorkflowInputError({ problem: "The input has no title." }));
        const refused = yield* Effect.flip(tasks.start({ taskId: task.id }, "tester"));
        assert.deepStrictEqual(
          [refused.reason, refused.message],
          ["invalid", "The input has no title."],
        );

        assert.deepStrictEqual(
          (yield* keyValues.list(`factory/v1/attempt/${task.id}/`)).map((row) => row.key),
          [attemptKey(task.id, 1)],
        );
        assert.deepStrictEqual(yield* record(attemptKey(task.id, 1)), {
          v: 1,
          taskId: task.id,
          n: 1,
          key,
          workflow: "factory-task",
          runId: null,
          requestedBy: "tester",
          startedAt: at,
        });
        assert.deepStrictEqual(yield* record(taskKey(task.id)), task);

        workflows.answers.start = () => Effect.succeed({ runId: "run-1" });
        const attempt = yield* tasks.start({ taskId: task.id }, "tester");
        assert.deepStrictEqual([attempt.n, attempt.key, attempt.runId], [1, key, "run-1"]);
        assert.deepStrictEqual(
          workflows.starts.map((call) => call.idempotencyKey),
          [key, key, key, key],
        );
        assert.deepStrictEqual(workflows.gets, []);
        const detail = yield* tasks.get(task.id);
        assert.deepStrictEqual(detail.attempts, [attempt]);
        assert.deepStrictEqual([detail.task.lane, detail.task.rev], ["doing", 2]);
      }),
    ),
  );

  // R3: a get refused as workflows-off answers workflows-off and writes nothing.
  it.effect("a start refused because workflows are off writes nothing and starts nothing", () =>
    withFactory((workflows) =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const task = yield* tasks.create({ projectId: null, title: "Live" });
        const first = yield* tasks.start({ taskId: task.id }, "tester");
        yield* TestClock.adjust("1 minute");
        const before = yield* storeRows;

        workflows.answers.get = () =>
          Effect.fail(new Workflows.WorkflowInputError({ problem: Workflows.OFF }));
        assert.strictEqual(
          yield* reasonOf(tasks.start({ taskId: task.id }, "tester")),
          "workflows-off",
        );
        assert.deepStrictEqual(yield* storeRows, before);

        workflows.answers.get = (runId) => Effect.succeed(workflowRun(runId, null));
        assert.strictEqual(
          yield* reasonOf(tasks.start({ taskId: task.id }, "tester")),
          "already-running",
        );
        assert.deepStrictEqual(yield* storeRows, before);
        assert.strictEqual(workflows.starts.length, 1);
        assert.deepStrictEqual([first.runId, workflows.gets], ["run-1", ["run-1", "run-1"]]);
      }),
    ),
  );

  // R3: the running check asks about the newest attempt with a run, past a later one without.
  it.effect("a later attempt without a run does not hide the run of an earlier one", () =>
    withFactory((workflows) =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const task = yield* tasks.create({ projectId: null, title: "Twice" });
        const first = yield* tasks.start({ taskId: task.id }, "tester");
        const pending: FactoryAttempt = { ...outsideAttempt(task.id, 2), runId: null };
        yield* put(attemptKey(task.id, 2), pending);

        workflows.answers.get = (runId) => Effect.succeed(workflowRun(runId, null));
        assert.strictEqual(
          yield* reasonOf(tasks.start({ taskId: task.id }, "tester")),
          "already-running",
        );
        assert.deepStrictEqual(workflows.gets, ["run-1"]);
        assert.strictEqual(workflows.starts.length, 1);
        assert.deepStrictEqual(yield* record(attemptKey(task.id, 2)), pending);

        workflows.answers.get = (runId) => Effect.succeed(workflowRun(runId, EPOCH));
        const reused = yield* tasks.start({ taskId: task.id }, "tester");
        assert.deepStrictEqual(
          [reused.n, reused.key, reused.runId],
          [2, `task/${task.id}/a2`, "run-2"],
        );
        assert.deepStrictEqual(workflows.gets, ["run-1", "run-1"]);
        assert.deepStrictEqual((yield* tasks.get(task.id)).attempts, [first, reused]);
      }),
    ),
  );

  // R3: once the attempt is written, interrupting the caller still records the run and lane doing.
  it.effect("a start whose caller is interrupted while the run starts still records it", () =>
    withFactory((workflows) =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const task = yield* tasks.create({ projectId: null, title: "Walked away from" });
        const at = yield* isoNow;
        const held = yield* holdStart(workflows);
        const caller = yield* tasks.start({ taskId: task.id }, "tester").pipe(Effect.forkChild);
        yield* held.entered;
        const interrupting = yield* Fiber.interrupt(caller).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* held.release;
        yield* Fiber.join(interrupting);

        yield* tasks.watch.pipe(
          Stream.filter((update) =>
            update.tasks.some(
              (summary) =>
                summary.id === task.id &&
                summary.lane === "doing" &&
                summary.attempt?.runId === "run-held",
            ),
          ),
          Stream.runHead,
        );
        assert.deepStrictEqual(yield* tasks.get(task.id), {
          task: { ...task, lane: "doing", laneSetAt: at, updatedAt: at, rev: 2 },
          attempts: [
            {
              v: 1,
              taskId: task.id,
              n: 1,
              key: `task/${task.id}/a1`,
              workflow: "factory-task",
              runId: "run-held",
              requestedBy: "tester",
              startedAt: at,
            },
          ],
          notes: [],
        });
        assert.strictEqual(workflows.starts.length, 1);
      }),
    ),
  );

  // R3: a task moved to dropped while its run starts stays dropped; only its attempt gets the run.
  it.effect("a task dropped while its run starts stays dropped", () =>
    withFactory((workflows) =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const task = yield* tasks.create({ projectId: null, title: "Changed my mind" });
        const at = yield* isoNow;
        const held = yield* holdStart(workflows);
        const starting = yield* tasks.start({ taskId: task.id }, "tester").pipe(Effect.forkChild);
        yield* held.entered;
        const dropped = yield* tasks.update({
          taskId: task.id,
          rev: 1,
          patch: { lane: "dropped" },
        });
        yield* held.release;
        const attempt = yield* Fiber.join(starting);

        assert.deepStrictEqual(attempt, {
          v: 1,
          taskId: task.id,
          n: 1,
          key: `task/${task.id}/a1`,
          workflow: "factory-task",
          runId: "run-held",
          requestedBy: "tester",
          startedAt: at,
        });
        assert.deepStrictEqual(yield* tasks.get(task.id), {
          task: dropped,
          attempts: [attempt],
          notes: [],
        });
      }),
    ),
  );
});

describe("R4 get", () => {
  // R4: unknown task is not-found; attempts by n ascending; the newest 200 notes, oldest first.
  it.effect("get lists attempts by number and the newest 200 notes oldest first", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        assert.strictEqual(yield* reasonOf(tasks.get(uuid(99))), "not-found");
        const task = yield* tasks.create({ projectId: null, title: "Busy" });
        const other = yield* tasks.create({ projectId: null, title: "Other" });
        const notes = Array.from({ length: 201 }, (_, index) => outsideNote(task.id, index));
        yield* Effect.forEach(
          [10, 2, 1],
          (n) => put(attemptKey(task.id, n), outsideAttempt(task.id, n)),
          { discard: true },
        );
        yield* Effect.forEach(
          [outsideNote(other.id, 300), ...[...notes].reverse()],
          (note) => put(`factory/v1/note/${note.taskId}/${note.id}`, note),
          { discard: true },
        );
        yield* put(attemptKey(other.id, 5), outsideAttempt(other.id, 5));

        assert.deepStrictEqual(yield* tasks.get(task.id), {
          task,
          attempts: [1, 2, 10].map((n) => outsideAttempt(task.id, n)),
          notes: notes.slice(1),
        });
      }),
    ),
  );
});

describe("R5 setOrchestrator", () => {
  // R5: a threadId writes the record, another replaces it, null deletes it, for any project.
  it.effect("an orchestrator is set, replaced and cleared for a project nobody knows", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const projectId = ProjectId.make("project-nobody-knows");
        const key = "factory/v1/orchestrator/project-nobody-knows";
        yield* tasks.setOrchestrator({ projectId, threadId: ThreadId.make("thread-1") });
        assert.deepStrictEqual(yield* record(key), { v: 1, threadId: "thread-1" });
        yield* tasks.setOrchestrator({ projectId, threadId: ThreadId.make("thread-2") });
        assert.deepStrictEqual(yield* record(key), { v: 1, threadId: "thread-2" });
        yield* tasks.setOrchestrator({ projectId, threadId: null });
        assert.strictEqual(yield* record(key), undefined);
        yield* tasks.setOrchestrator({ projectId, threadId: null });
        assert.strictEqual(yield* record(key), undefined);
      }),
    ),
  );
});

describe("R6 watch", () => {
  // R6: the snapshot leaves out dropped and month-old done tasks, counts damaged task records.
  it.effect("the first element is a snapshot of the listed tasks and orchestrators", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const keyValues = yield* KeyValues;
        const projectId = ProjectId.make("project-1");
        const threadId = ThreadId.make("thread-1");
        const created = yield* tasks.create({ projectId, title: "Started", description: "Body" });
        const attempt = yield* tasks.start({ taskId: created.id }, "tester");
        const { task: started } = yield* tasks.get(created.id);
        const plain = yield* tasks.create({ projectId: null, title: "Plain" });
        const dropped = yield* tasks.create({ projectId: null, title: "Dropped" });
        yield* tasks.update({ taskId: dropped.id, rev: 1, patch: { lane: "dropped" } });
        yield* tasks.setOrchestrator({ projectId, threadId });

        const now = yield* DateTime.now;
        const daysAgo = (days: number) => DateTime.formatIso(DateTime.subtract(now, { days }));
        const recentDone = outsideTask(uuid(1), 10, {
          lane: "done",
          laneSetAt: daysAgo(29),
          createdAt: daysAgo(40),
          updatedAt: daysAgo(29),
        });
        const agedOut = outsideTask(uuid(2), 11, {
          lane: "done",
          laneSetAt: daysAgo(31),
          createdAt: daysAgo(40),
          updatedAt: daysAgo(31),
        });
        const oldBacklog = outsideTask(uuid(3), 12, {
          laneSetAt: daysAgo(90),
          createdAt: daysAgo(90),
          updatedAt: daysAgo(90),
        });
        yield* Effect.forEach(
          [recentDone, agedOut, oldBacklog],
          (task) => put(taskKey(task.id), task),
          { discard: true },
        );
        yield* Effect.forEach(
          [1, 3, 2],
          (n) => put(attemptKey(oldBacklog.id, n), outsideAttempt(oldBacklog.id, n)),
          { discard: true },
        );
        yield* keyValues.set(taskKey(uuid(4)), "not json");
        yield* put(taskKey(uuid(5)), { v: 1, id: uuid(5) });

        const updates = yield* tasks.watch.pipe(Stream.toQueue({ capacity: "unbounded" }));
        assert.deepStrictEqual(yield* snapshot(updates), {
          tasks: byId([
            summaryOf(started, attempt),
            summaryOf(plain, null),
            summaryOf(recentDone, null),
            summaryOf(oldBacklog, outsideAttempt(oldBacklog.id, 3)),
          ]),
          orchestrators: [{ projectId, threadId }],
          damaged: 2,
          truncated: false,
        });
      }),
    ),
  );

  // R6: past 2,000 listed tasks the snapshot keeps the newest 2,000 and is truncated.
  it.effect("a snapshot of more than 2,000 tasks keeps the newest and says it is truncated", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const keyValues = yield* KeyValues;
        const listed = Array.from({ length: 2001 }, (_, index) =>
          outsideTask(uuid(index + 1), index + 1, {
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(index * 1000)),
          }),
        );
        yield* keyValues.transaction(
          Effect.forEach(listed, (task) => put(taskKey(task.id), task), { discard: true }),
        );

        const updates = yield* tasks.watch.pipe(Stream.toQueue({ capacity: "unbounded" }));
        const first = yield* snapshot(updates);
        assert.strictEqual(first.truncated, true);
        assert.deepStrictEqual(
          first.tasks.map((task) => task.id),
          listed.slice(1).map((task) => task.id),
        );
      }),
    ),
  );

  // R6: changes carry only what differs; orchestrators only when changed; no-ops send nothing.
  it.effect("later elements are changes of only what differs, and no-op writes send nothing", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const projectId = ProjectId.make("project-1");
        const threadId = ThreadId.make("thread-1");
        const first = yield* tasks.create({ projectId: null, title: "First" });
        const updates = yield* tasks.watch.pipe(Stream.toQueue({ capacity: "unbounded" }));
        assert.deepStrictEqual(yield* snapshot(updates), {
          tasks: [summaryOf(first, null)],
          orchestrators: [],
          damaged: 0,
          truncated: false,
        });

        const second = yield* tasks.create({ projectId: null, title: "Second" });
        assert.deepStrictEqual(yield* change(updates), {
          _tag: "changed",
          tasks: [summaryOf(second, null)],
          removed: [],
        });
        const renamed = yield* tasks.update({
          taskId: first.id,
          rev: 1,
          patch: { title: "First, renamed" },
        });
        assert.deepStrictEqual(yield* change(updates), {
          _tag: "changed",
          tasks: [summaryOf(renamed, null)],
          removed: [],
        });
        yield* tasks.update({ taskId: second.id, rev: 1, patch: { lane: "dropped" } });
        assert.deepStrictEqual(yield* change(updates), {
          _tag: "changed",
          tasks: [],
          removed: [second.id],
        });

        yield* tasks.update({ taskId: second.id, rev: 2, patch: { title: "Still dropped" } });
        yield* tasks.setOrchestrator({ projectId, threadId });
        assert.deepStrictEqual(yield* change(updates), {
          _tag: "changed",
          tasks: [],
          removed: [],
          orchestrators: [{ projectId, threadId }],
        });
        yield* tasks.setOrchestrator({ projectId, threadId });
        yield* tasks.setOrchestrator({ projectId, threadId: null });
        assert.deepStrictEqual(yield* change(updates), {
          _tag: "changed",
          tasks: [],
          removed: [],
          orchestrators: [],
        });
      }),
    ),
  );
});

describe("R7 liveness", () => {
  // R7: a change made through the service reaches every subscriber without a poll.
  it.effect("an own write reaches every subscriber without waiting for a poll", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const left = yield* tasks.watch.pipe(Stream.toQueue({ capacity: "unbounded" }));
        const right = yield* tasks.watch.pipe(Stream.toQueue({ capacity: "unbounded" }));
        yield* snapshot(left);
        yield* snapshot(right);
        const task = yield* tasks.create({ projectId: null, title: "Seen by both" });
        assert.deepStrictEqual(yield* change(left), {
          _tag: "changed",
          tasks: [summaryOf(task, null)],
          removed: [],
        });
        assert.deepStrictEqual(yield* change(right), {
          _tag: "changed",
          tasks: [summaryOf(task, null)],
          removed: [],
        });
      }),
    ),
  );

  // R7: a store write by anything else reaches every subscriber within one FACTORY_POLL_INTERVAL.
  it.effect("writes from outside reach every subscriber within one poll interval", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const keyValues = yield* KeyValues;
        const updates = yield* tasks.watch.pipe(Stream.toQueue({ capacity: "unbounded" }));
        const other = yield* tasks.watch.pipe(Stream.toQueue({ capacity: "unbounded" }));
        assert.deepStrictEqual(yield* snapshot(updates), {
          tasks: [],
          orchestrators: [],
          damaged: 0,
          truncated: false,
        });
        yield* snapshot(other);
        yield* TestClock.adjust(FactoryTasks.FACTORY_POLL_INTERVAL);

        const outside = outsideTask(uuid(1), 1, { title: "Captured by a workflow" });
        yield* put(taskKey(outside.id), outside);
        yield* TestClock.adjust(FactoryTasks.FACTORY_POLL_INTERVAL);
        assert.deepStrictEqual(yield* change(updates), {
          _tag: "changed",
          tasks: [summaryOf(outside, null)],
          removed: [],
        });
        assert.deepStrictEqual(yield* change(other), {
          _tag: "changed",
          tasks: [summaryOf(outside, null)],
          removed: [],
        });

        const attempt = outsideAttempt(outside.id, 1);
        yield* put(attemptKey(outside.id, 1), attempt);
        yield* TestClock.adjust(FactoryTasks.FACTORY_POLL_INTERVAL);
        assert.deepStrictEqual(yield* change(updates), {
          _tag: "changed",
          tasks: [summaryOf(outside, attempt)],
          removed: [],
        });

        yield* put("factory/v1/orchestrator/project-1", { v: 1, threadId: "thread-1" });
        yield* TestClock.adjust(FactoryTasks.FACTORY_POLL_INTERVAL);
        assert.deepStrictEqual(yield* change(updates), {
          _tag: "changed",
          tasks: [],
          removed: [],
          orchestrators: [
            { projectId: ProjectId.make("project-1"), threadId: ThreadId.make("thread-1") },
          ],
        });

        yield* keyValues.delete(taskKey(outside.id));
        yield* TestClock.adjust(FactoryTasks.FACTORY_POLL_INTERVAL);
        assert.deepStrictEqual(yield* change(updates), {
          _tag: "changed",
          tasks: [],
          removed: [outside.id],
        });
      }),
    ),
  );

  // R7: a poll whose store read fails is skipped; later outside writes still reach subscribers.
  it.effect("a failed poll does not stop outside writes reaching old or new subscribers", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const sql = yield* SqlClient.SqlClient;
        const early = yield* tasks.watch.pipe(Stream.toQueue({ capacity: "unbounded" }));
        yield* snapshot(early);
        yield* sql`ALTER TABLE workflow_store RENAME TO workflow_store_away`;
        yield* TestClock.adjust(FactoryTasks.FACTORY_POLL_INTERVAL);
        yield* sql`ALTER TABLE workflow_store_away RENAME TO workflow_store`;

        const first = outsideTask(uuid(1), 1, { title: "Written after the failed poll" });
        yield* put(taskKey(first.id), first);
        yield* TestClock.adjust(FactoryTasks.FACTORY_POLL_INTERVAL);
        assert.deepStrictEqual(yield* change(early), {
          _tag: "changed",
          tasks: [summaryOf(first, null)],
          removed: [],
        });

        const late = yield* tasks.watch.pipe(Stream.toQueue({ capacity: "unbounded" }));
        assert.deepStrictEqual(yield* snapshot(late), {
          tasks: [summaryOf(first, null)],
          orchestrators: [],
          damaged: 0,
          truncated: false,
        });
        const second = outsideTask(uuid(2), 2, { title: "Seen by both" });
        yield* put(taskKey(second.id), second);
        yield* TestClock.adjust(FactoryTasks.FACTORY_POLL_INTERVAL);
        assert.deepStrictEqual(yield* change(early), {
          _tag: "changed",
          tasks: [summaryOf(second, null)],
          removed: [],
        });
        assert.deepStrictEqual(yield* change(late), {
          _tag: "changed",
          tasks: [summaryOf(second, null)],
          removed: [],
        });
      }),
    ),
  );
});

describe("R8 isolation", () => {
  // R8: keys outside factory/v1/ written first are not listed or touched by any method.
  it.effect("the service reads and writes only keys under factory/v1/", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const stranger = outsideTask(uuid(1), 1, { title: "Not a factory task" });
        yield* put("factory/v1", { v: 1 });
        yield* put("factory/v10/seq", 41);
        yield* put(`factory/v10/task/${stranger.id}`, stranger);
        yield* put(`factory/v10/task/${uuid(2)}`, { v: 1 });
        yield* put("intake/switch", { on: true });
        const seeded = yield* storeRows;
        yield* TestClock.adjust("1 minute");

        const updates = yield* tasks.watch.pipe(Stream.toQueue({ capacity: "unbounded" }));
        assert.deepStrictEqual(yield* snapshot(updates), {
          tasks: [],
          orchestrators: [],
          damaged: 0,
          truncated: false,
        });
        const task = yield* tasks.create({ projectId: null, title: "Ours" });
        assert.strictEqual(task.number, 1);
        yield* tasks.update({
          taskId: task.id,
          rev: 1,
          patch: { title: "Ours, renamed" },
          note: "Checked",
        });
        yield* tasks.start({ taskId: task.id }, "tester");
        yield* tasks.get(task.id);
        const projectId = ProjectId.make("project-1");
        yield* tasks.setOrchestrator({ projectId, threadId: ThreadId.make("thread-1") });
        yield* tasks.setOrchestrator({ projectId, threadId: null });
        yield* TestClock.adjust(FactoryTasks.FACTORY_POLL_INTERVAL);

        const fresh = yield* tasks.watch.pipe(Stream.toQueue({ capacity: "unbounded" }));
        const listed = yield* snapshot(fresh);
        assert.deepStrictEqual(
          [listed.tasks.map((summary) => summary.id), listed.damaged],
          [[task.id], 0],
        );
        const rows = yield* storeRows;
        const seededKeys = new Set(seeded.map((row) => row.key));
        assert.deepStrictEqual(
          rows.filter((row) => seededKeys.has(row.key)),
          seeded,
        );
        assert.deepStrictEqual(
          rows
            .filter((row) => !seededKeys.has(row.key) && !row.key.startsWith("factory/v1/"))
            .map((row) => row.key),
          [],
        );
      }),
    ),
  );
});
