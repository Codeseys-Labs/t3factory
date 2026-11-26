import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  FACTORY_KIND_WORKFLOWS,
  FACTORY_WS_METHODS,
  type FactoryAttempt,
  FactoryNote,
  FactoryOrchestrator,
  type FactoryOrchestratorSetInput,
  FactoryTask,
  type FactoryTaskCreateInput,
  type FactoryTaskDetail,
  FactoryTaskError,
  type FactoryTaskGetInput,
  type FactoryTaskRunInput,
  type FactoryTaskStartInput,
  type FactoryTasksSnapshot,
  type FactoryTasksSubscribeInput,
  type FactoryTasksUpdate,
  FactoryTaskSummary,
  type FactoryTaskUpdateInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Workflows from "../workflows/Workflows.ts";
import * as FactoryTaskStore from "./FactoryTaskStore.ts";

export const FACTORY_TASK_WORKFLOW = FACTORY_KIND_WORKFLOWS.software;
export const FACTORY_POLL_INTERVAL = "5 seconds";

export class FactoryTasks extends Context.Service<
  FactoryTasks,
  {
    readonly watch: Stream.Stream<FactoryTasksUpdate>;
    readonly get: (taskId: string) => Effect.Effect<FactoryTaskDetail, FactoryTaskError>;
    readonly create: (
      input: FactoryTaskCreateInput,
    ) => Effect.Effect<FactoryTask, FactoryTaskError>;
    readonly update: (
      input: FactoryTaskUpdateInput,
    ) => Effect.Effect<FactoryTask, FactoryTaskError>;
    readonly start: (
      input: FactoryTaskStartInput,
      requestedBy: string,
    ) => Effect.Effect<FactoryAttempt, FactoryTaskError>;
    readonly setOrchestrator: (
      input: FactoryOrchestratorSetInput,
    ) => Effect.Effect<void, FactoryTaskError>;
  }
>()("t3/factory/FactoryTasks") {}

const refuse = Effect.fn("FactoryTasks.disabled")(function* () {
  return yield* new FactoryTaskError({
    reason: "invalid",
    message: "Work is not available on this server.",
  });
});

const EMPTY_SNAPSHOT: FactoryTasksSnapshot = {
  tasks: [],
  orchestrators: [],
  damaged: 0,
  truncated: false,
};

const disabled = FactoryTasks.of({
  watch: Stream.concat(Stream.make(EMPTY_SNAPSHOT), Stream.never),
  get: refuse,
  create: refuse,
  update: refuse,
  start: refuse,
  setOrchestrator: refuse,
});

export const orDisabled = Effect.map(
  Effect.serviceOption(FactoryTasks),
  Option.getOrElse(() => disabled),
);

const decodeTask = Schema.decodeUnknownEffect(FactoryTask);
const decodeNote = Schema.decodeUnknownEffect(FactoryNote);
const encodeSummary = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(FactoryTaskSummary)),
);
const encodeOrchestrators = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(Schema.Array(FactoryOrchestrator))),
);
const compareTasks = (left: FactoryTask, right: FactoryTask) =>
  left.updatedAt === right.updatedAt
    ? left.id < right.id
      ? -1
      : left.id > right.id
        ? 1
        : 0
    : left.updatedAt > right.updatedAt
      ? -1
      : 1;

const make = Effect.gen(function* () {
  const store = yield* FactoryTaskStore.make;
  const workflows = yield* Workflows.Workflows;
  const random = yield* SecureRandom.SecureRandom;
  const projects = Option.getOrUndefined(
    yield* Effect.serviceOption(ProjectService.ProjectService),
  );
  const folders = Option.getOrUndefined(
    yield* Effect.serviceOption(ManagedProjectFolders.ManagedProjectFolders),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const changes = yield* Effect.acquireRelease(
    PubSub.sliding<FactoryTasksSnapshot>(1),
    PubSub.shutdown,
  );
  const subscriberLock = yield* Semaphore.make(1);
  const refreshLock = yield* Semaphore.make(1);
  const scratchLock = yield* Semaphore.make(1);
  const startLocks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  let subscribers = 0;
  let ownWrites = 0;
  const notify = Effect.gen(function* () {
    ownWrites++;
    if (subscribers > 0) yield* refreshSafely;
  });

  const requireTask = Effect.fn("FactoryTasks.requireTask")(function* (taskId: string) {
    const task = yield* store.tasks.get(taskId);
    if (task === undefined) {
      return yield* new FactoryTaskError({ reason: "not-found", message: "Task not found." });
    }
    return task;
  });

  const validateTask = Effect.fn("FactoryTasks.validateTask")(function* (value: unknown) {
    return yield* decodeTask(value).pipe(
      Effect.mapError(
        () => new FactoryTaskError({ reason: "invalid", message: "Task fields are invalid." }),
      ),
    );
  });

  const resolveTarget = Effect.fn("FactoryTasks.resolveTarget")(function* (
    projectId: FactoryTask["projectId"],
    probeOnly: boolean,
  ) {
    if (projectId !== null) {
      if (projects === undefined) return;
      const project = yield* projects.getById(projectId);
      if (Option.isNone(project)) {
        return {
          projectId,
          workspace: "root",
          workspaceRoot: null,
          problem: "The task's project no longer exists.",
        } as const;
      }
      const { workspaceRoot } = project.value;
      const git = yield* fileSystem.exists(path.join(workspaceRoot, ".git"));
      return {
        projectId,
        workspaceRoot,
        workspace: git ? "worktree" : "root",
        problem: null,
      } as const;
    }
    if (folders === undefined) return;
    if (!probeOnly) {
      const scratch = yield* folders.ensureScratchProject;
      return {
        projectId: scratch.projectId,
        workspaceRoot: Option.getOrNull(yield* folders.scratchRoot),
        workspace: "scratch",
        problem: null,
      } as const;
    }
    const workspaceRoot = Option.getOrNull(yield* folders.scratchRoot);
    const previous = yield* store.readTarget(null);
    const scratchId =
      workspaceRoot === null
        ? null
        : projects !== undefined
          ? (Option.getOrNull(yield* projects.getByWorkspaceRoot(workspaceRoot))?.id ?? null)
          : previous?.workspaceRoot === workspaceRoot
            ? previous.projectId
            : null;
    return {
      projectId: scratchId,
      workspaceRoot,
      workspace: "scratch",
      problem:
        scratchId !== null
          ? null
          : workspaceRoot === null
            ? (previous?.problem ??
              "Threads without a project are not available on this environment.")
            : "Start this task once from the Work page so the server can set up its scratch folder.",
    } as const;
  });

  const refreshTarget = Effect.fn("FactoryTasks.refreshTarget")(
    function* ({
      projectId,
      probeOnly = false,
    }: {
      readonly projectId: FactoryTask["projectId"];
      readonly probeOnly?: boolean;
    }) {
      const target = yield* resolveTarget(projectId, probeOnly).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            projectId,
            workspace: projectId === null ? "scratch" : "root",
            workspaceRoot: null,
            problem: error.message,
          } as const),
        ),
      );
      if (target === undefined) return null;
      yield* store.writeTarget(projectId, {
        ...target,
        v: 1,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
      });
      return target;
    },
    (effect, { projectId }) => (projectId === null ? scratchLock.withPermits(1)(effect) : effect),
  );

  const checkReferences = Effect.fn("FactoryTasks.checkReferences")(function* (
    taskId: string,
    roots: ReadonlyArray<string>,
    field: "parentId" | "blockedBy",
    existing: ReadonlyArray<string> = [],
  ) {
    const required = new Set(roots.filter((id) => !existing.includes(id)));
    const visited = new Set<string>();
    const pending = [...roots];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) break;
      if (id === taskId) {
        return yield* new FactoryTaskError({
          reason: "invalid",
          message: "Task relationships cannot form a cycle.",
        });
      }
      if (visited.has(id)) continue;
      visited.add(id);
      const task = yield* store.tasks.get(id);
      if (task === undefined) {
        if (required.has(id)) {
          return yield* new FactoryTaskError({
            reason: "invalid",
            message: "Referenced task not found.",
          });
        }
        continue;
      }
      if (field === "parentId") {
        if (task.parentId !== null) pending.push(task.parentId);
      } else {
        pending.push(...task.blockedBy);
      }
    }
  });

  const create = Effect.fn("FactoryTasks.create")(
    function* (input: FactoryTaskCreateInput) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const number = (yield* store.sequence) + 1;
      const task = yield* validateTask({
        v: 1,
        id: yield* random.uuidV4(),
        number,
        rev: 1,
        projectId: input.projectId,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        title: input.title.trim(),
        description: input.description ?? "",
        lane: input.lane ?? "backlog",
        laneSetAt: now,
        parentId: input.parentId ?? null,
        blockedBy: [...new Set(input.blockedBy ?? [])],
        assignee: input.assignee ?? null,
        model: input.model ?? null,
        source: input.source ?? { _tag: "local" },
        createdAt: now,
        updatedAt: now,
      });
      yield* checkReferences(task.id, task.parentId === null ? [] : [task.parentId], "parentId");
      yield* checkReferences(task.id, task.blockedBy, "blockedBy");
      if (task.source._tag === "promoted" && !(yield* store.tasks.get(task.source.fromTaskId))) {
        return yield* new FactoryTaskError({
          reason: "invalid",
          message: "Promoted task not found.",
        });
      }
      yield* store.setSequence(number);
      yield* store.tasks.set(task.id, task);
      return task;
    },
    store.transaction,
    Effect.tap((task) => refreshTarget({ projectId: task.projectId })),
    Effect.tap(() => notify),
    Effect.uninterruptible,
  );

  const update = Effect.fn("FactoryTasks.update")(
    function* (input: FactoryTaskUpdateInput) {
      const current = yield* requireTask(input.taskId);
      if (input.rev !== current.rev) {
        return yield* new FactoryTaskError({
          reason: "conflict",
          message: "Task has changed.",
          rev: current.rev,
        });
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const task = yield* validateTask({
        ...current,
        ...input.patch,
        title: input.patch.title?.trim() ?? current.title,
        blockedBy: [...new Set(input.patch.blockedBy ?? current.blockedBy)],
        rev: current.rev + 1,
        updatedAt: now,
        laneSetAt:
          input.patch.lane !== undefined && input.patch.lane !== current.lane
            ? now
            : current.laneSetAt,
      });
      if (input.patch.parentId !== undefined) {
        yield* checkReferences(
          task.id,
          task.parentId === null ? [] : [task.parentId],
          "parentId",
          current.parentId === null ? [] : [current.parentId],
        );
      }
      if (input.patch.blockedBy !== undefined) {
        yield* checkReferences(task.id, task.blockedBy, "blockedBy", current.blockedBy);
      }
      if (input.note !== undefined) {
        const note = yield* decodeNote({
          v: 1,
          taskId: task.id,
          id: `${now}-${(yield* random.uuidV4()).slice(0, 8)}`,
          text: input.note.trim(),
          by: "client",
          at: now,
        }).pipe(
          Effect.mapError(
            () =>
              new FactoryTaskError({
                reason: "invalid",
                message: "Note must contain 1 to 4000 characters.",
              }),
          ),
        );
        yield* store.notes.set(`${task.id}/${note.id}`, note);
      }
      yield* store.tasks.set(task.id, task);
      return task;
    },
    store.transaction,
    Effect.tap(() => notify),
    Effect.uninterruptible,
  );

  const get = Effect.fn("FactoryTasks.get")(function* (taskId: string) {
    const task = yield* requireTask(taskId);
    const attempts = (yield* store.attempts.list(`${taskId}/`)).items
      .map((row) => row.value)
      .sort((left, right) => left.n - right.n);
    const notes = (yield* store.notes.list(`${taskId}/`)).items
      .map((row) => row.value)
      .sort((left, right) =>
        left.at === right.at
          ? left.id < right.id
            ? -1
            : left.id > right.id
              ? 1
              : 0
          : left.at < right.at
            ? -1
            : 1,
      )
      .slice(-200);
    const artifacts = yield* store.listArtifacts(taskId);
    const receipts = yield* store.listReceipts(taskId);
    const reviews = yield* store.listReviews(taskId);
    return { task, attempts, notes, artifacts, receipts, reviews };
  }, store.transaction);

  const readStartState = Effect.fn("FactoryTasks.readStartState")(function* (taskId: string) {
    const task = yield* requireTask(taskId);
    if (task.lane === "dropped") {
      return yield* new FactoryTaskError({
        reason: "invalid",
        message: "A dropped task cannot be started.",
      });
    }
    const attempts = yield* store.attempts.list(`${task.id}/`);
    let last: FactoryAttempt | undefined;
    let ran: FactoryAttempt | undefined;
    for (const { value } of attempts.items) {
      if (last === undefined || value.n > last.n) last = value;
      if (value.runId !== null && (ran === undefined || value.n > ran.n)) ran = value;
    }
    return { task, last, runId: ran?.runId ?? null };
  });

  const checkRun = Effect.fn("FactoryTasks.checkRun")(function* (runId: string | null) {
    if (runId === null) return;
    const running = yield* workflows.get(runId).pipe(
      Effect.map(({ run }) => run.endedAt === null),
      Effect.catchTags({
        WorkflowInputError: (error) =>
          error.problem === Workflows.OFF
            ? Effect.fail(new FactoryTaskError({ reason: "workflows-off", message: error.message }))
            : Effect.succeed(false),
        WorkflowRunNotFoundError: () => Effect.succeed(false),
      }),
    );
    if (running) {
      return yield* new FactoryTaskError({
        reason: "already-running",
        message: "Task is already running.",
      });
    }
  });

  const prepareAttempt = Effect.fn("FactoryTasks.prepareAttempt")(
    function* (
      input: FactoryTaskStartInput,
      requestedBy: string,
      checkedRunId: string | null,
      allowsResearch: boolean,
    ) {
      // A workflow can write attempts, or the user can change kind, while the folder is resolved.
      const { task, last, runId } = yield* readStartState(input.taskId);
      if (runId !== checkedRunId) yield* checkRun(runId);
      if (task.kind === "research" && !allowsResearch) {
        return yield* new FactoryTaskError({
          reason: "workspace-unavailable",
          message: "An experiment needs a Git project.",
        });
      }
      const workflow = FACTORY_KIND_WORKFLOWS[task.kind ?? "software"];
      const n = last?.runId === null && last.workflow === workflow ? last.n : (last?.n ?? 0) + 1;
      const attempt: FactoryAttempt = {
        v: 1,
        taskId: task.id,
        n,
        key: `task/${task.id}/a${n}`,
        workflow,
        runId: null,
        requestedBy,
        startedAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* store.attempts.set(`${task.id}/${String(n).padStart(4, "0")}`, attempt);
      return { task, attempt };
    },
    store.transaction,
    Effect.tap(() => notify),
    Effect.uninterruptible,
  );

  const finishAttempt = Effect.fn("FactoryTasks.finishAttempt")(
    function* (attempt: FactoryAttempt, runId: string) {
      const current = yield* requireTask(attempt.taskId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const started = { ...attempt, runId };
      yield* store.attempts.set(`${attempt.taskId}/${String(attempt.n).padStart(4, "0")}`, started);
      if (current.lane !== "dropped") {
        yield* store.tasks.set(current.id, {
          ...current,
          lane: "doing",
          laneSetAt: now,
          updatedAt: now,
          rev: current.rev + 1,
        });
      }
      return started;
    },
    store.transaction,
    Effect.tap(() => notify),
    Effect.uninterruptible,
  );

  const start = Effect.fn("FactoryTasks.start")(
    function* (input: FactoryTaskStartInput, requestedBy: string) {
      const initial = yield* readStartState(input.taskId);
      yield* checkRun(initial.runId);
      const target = yield* refreshTarget({ projectId: initial.task.projectId });
      if (target !== null && target.problem !== null) {
        return yield* new FactoryTaskError({
          reason: "workspace-unavailable",
          message: target.problem,
        });
      }
      const { task, attempt } = yield* prepareAttempt(
        input,
        requestedBy,
        initial.runId,
        target === null || target.workspace === "worktree",
      );
      const runInput: FactoryTaskRunInput = {
        taskId: task.id,
        number: task.number,
        attempt: attempt.n,
        title: task.title,
        description: task.description,
        projectId: task.projectId,
        model: task.model,
        issueUrl: task.source._tag === "issue" ? task.source.url : null,
      };
      const { runId } = yield* workflows
        .start(attempt.workflow, runInput, {
          idempotencyKey: attempt.key,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new FactoryTaskError({
                reason:
                  error._tag === "WorkflowNotRegisteredError"
                    ? "workflow-missing"
                    : error._tag === "WorkflowInputError" && error.problem === Workflows.OFF
                      ? "workflows-off"
                      : "invalid",
                message: error.message,
              }),
          ),
        );
      return yield* finishAttempt(attempt, runId);
    },
    Effect.uninterruptible,
    (effect, input) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = startLocks.get(input.taskId) ?? {
            semaphore: Semaphore.makeUnsafe(1),
            users: 0,
          };
          entry.users++;
          startLocks.set(input.taskId, entry);
          return entry;
        }),
        (entry) => entry.semaphore.withPermits(1)(effect),
        (entry) =>
          Effect.sync(() => {
            entry.users--;
            if (entry.users === 0) startLocks.delete(input.taskId);
          }),
      ),
  );

  const setOrchestrator = Effect.fn("FactoryTasks.setOrchestrator")(
    function* (input: FactoryOrchestratorSetInput) {
      if (input.threadId === null) {
        yield* store.orchestrators.delete(input.projectId);
      } else {
        yield* store.orchestrators.set(input.projectId, { v: 1, threadId: input.threadId });
      }
    },
    store.transaction,
    Effect.tap(() => notify),
    Effect.uninterruptible,
  );

  const readSnapshot = Effect.fn("FactoryTasks.readSnapshot")(function* () {
    const stored = yield* store.tasks.list();
    const tasks = stored.items.map((row) => row.value).sort(compareTasks);
    const attempts = new Map<string, FactoryAttempt>();
    for (const { value } of (yield* store.attempts.list()).items) {
      const last = attempts.get(value.taskId);
      if (last === undefined || value.n > last.n) attempts.set(value.taskId, value);
    }
    return {
      tasks: tasks.map((task): FactoryTaskSummary => {
        const { description, ...summary } = task;
        return {
          ...summary,
          hasDescription: description.length > 0,
          attempt: attempts.get(task.id) ?? null,
        };
      }),
      orchestrators: (yield* store.listOrchestrators()).items,
      damaged: stored.damaged,
    };
  }, store.transaction);

  let cached:
    | {
        readonly watermark: Effect.Success<typeof store.watermark>;
        readonly ownWrites: number;
        readonly records: Pick<FactoryTasksSnapshot, "tasks" | "orchestrators" | "damaged">;
      }
    | undefined;
  const refresh = Effect.fn("FactoryTasks.refresh")(function* () {
    const version = ownWrites;
    const watermark = yield* store.watermark;
    let current = cached;
    if (
      current === undefined ||
      version !== current.ownWrites ||
      watermark.count !== current.watermark.count ||
      watermark.updatedAt !== current.watermark.updatedAt ||
      watermark.totalLength !== current.watermark.totalLength
    ) {
      current = { watermark, ownWrites: version, records: yield* readSnapshot() };
      cached = current;
    }
    const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 30 }));
    const tasks = current.records.tasks.filter(
      (task) => task.lane !== "dropped" && (task.lane !== "done" || task.updatedAt >= cutoff),
    );
    const snapshot: FactoryTasksSnapshot = {
      tasks: tasks.slice(0, 2_000),
      orchestrators: current.records.orchestrators,
      damaged: current.records.damaged,
      truncated: tasks.length > 2_000,
    };
    yield* PubSub.publish(changes, snapshot);
    return snapshot;
  }, refreshLock.withPermits(1));
  const refreshSafely = refresh().pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Reading Factory tasks failed", cause),
    ),
  );

  const poll = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(FACTORY_POLL_INTERVAL);
      yield* refreshSafely;
    }
  });
  let polling: Fiber.Fiber<void> | undefined;
  const subscribe = Effect.acquireRelease(
    subscriberLock.withPermits(1)(
      Effect.gen(function* () {
        if (subscribers === 0) polling = yield* Effect.forkIn(Effect.interruptible(poll), scope);
        subscribers++;
      }),
    ),
    () =>
      subscriberLock.withPermits(1)(
        Effect.gen(function* () {
          subscribers--;
          if (subscribers === 0 && polling !== undefined) {
            yield* Fiber.interrupt(polling);
            polling = undefined;
          }
        }),
      ),
  );

  type Sent = { readonly tasks: ReadonlyMap<string, string>; readonly orchestrators: string };
  const watch = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      yield* subscribe;
      return Stream.concat(
        Stream.fromEffect(refresh().pipe(Effect.orDie)),
        Stream.fromSubscription(subscription),
      ).pipe(
        Stream.mapAccum(
          (): Sent | undefined => undefined,
          (sent, next): readonly [Sent, ReadonlyArray<FactoryTasksUpdate>] => {
            const now: Sent = {
              tasks: new Map(next.tasks.map((task) => [task.id, encodeSummary(task)])),
              orchestrators: encodeOrchestrators(next.orchestrators),
            };
            if (sent === undefined) return [now, [next]];
            const tasks = next.tasks.filter(
              (task) => sent.tasks.get(task.id) !== now.tasks.get(task.id),
            );
            const removed = [...sent.tasks.keys()].filter((id) => !now.tasks.has(id));
            const orchestratorsChanged = sent.orchestrators !== now.orchestrators;
            return [
              now,
              tasks.length === 0 && removed.length === 0 && !orchestratorsChanged
                ? []
                : [
                    {
                      _tag: "changed",
                      tasks,
                      removed,
                      ...(orchestratorsChanged ? { orchestrators: next.orchestrators } : {}),
                    },
                  ],
            ];
          },
        ),
      );
    }),
  );

  if (projects !== undefined || folders !== undefined) {
    yield* Effect.gen(function* () {
      const ids = new Set<FactoryTask["projectId"]>();
      for (const { value } of (yield* store.tasks.list()).items) {
        if (value.lane !== "dropped") ids.add(value.projectId);
      }
      yield* Effect.forEach(
        ids,
        (id) =>
          refreshTarget({ projectId: id, probeOnly: true }).pipe(
            Effect.flatMap((target) =>
              target === null || target.problem === null
                ? Effect.void
                : Effect.logWarning("Factory workspace unavailable", {
                    projectId: id,
                    problem: target.problem,
                  }),
            ),
          ),
        { discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Refreshing Factory targets failed", cause),
      ),
      Effect.forkIn(scope),
    );
  }

  return FactoryTasks.of({ watch, get, create, update, start, setOrchestrator });
});

export const layer: Layer.Layer<
  FactoryTasks,
  never,
  SqlClient.SqlClient | Workflows.Workflows | FileSystem.FileSystem | Path.Path
> = Layer.effect(FactoryTasks, make).pipe(Layer.provide(NodeCrypto.layer));

export const wsHandlers = (service: FactoryTasks["Service"]) => ({
  [FACTORY_WS_METHODS.factoryTasksSubscribe]: (_input: FactoryTasksSubscribeInput) => service.watch,
  [FACTORY_WS_METHODS.factoryTasksGet]: (input: FactoryTaskGetInput) => service.get(input.taskId),
  [FACTORY_WS_METHODS.factoryTasksCreate]: (input: FactoryTaskCreateInput) => service.create(input),
  [FACTORY_WS_METHODS.factoryTasksUpdate]: (input: FactoryTaskUpdateInput) => service.update(input),
  [FACTORY_WS_METHODS.factoryTasksStart]: (input: FactoryTaskStartInput) =>
    service.start(input, "client"),
  [FACTORY_WS_METHODS.factoryOrchestratorSet]: (input: FactoryOrchestratorSetInput) =>
    service.setOrchestrator(input),
});
