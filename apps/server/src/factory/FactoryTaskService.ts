import {
  CommandId,
  FactoryTaskAcceptInput,
  FactoryTaskActivityInput,
  FactoryTaskAssignment,
  FactoryTaskByThreadInput,
  FactoryTaskCheckInput,
  FactoryTaskCommentInput,
  FactoryTaskAssigneeListInput,
  FactoryTaskCountInput,
  FactoryTaskCreateInput,
  FactoryTaskDeliverInput,
  FactoryTaskError,
  FactoryTaskListInput,
  FactoryTaskReadInput,
  FactoryTaskReopenInput,
  FactoryTaskRequestChangesInput,
  FactoryTaskResultReadInput,
  FactoryTaskRetryInput,
  FactoryTaskStartInput,
  FactoryTaskStopInput,
  FactoryTaskUpdateInput,
  type ApplicationStoredEvent,
  FactoryDeliveryError,
  type FactoryAgentSetup,
  type FactoryExecutionError,
  type FactoryExecutionPolicy,
  type FactoryExecutionTaskSpec,
  type FactoryPlanError,
  type FactoryPlanOperation,
  type FactoryPlanRef,
  type FactoryPlanSnapshot,
  type FactoryTaskActivityResult,
  type FactoryTaskAssignee,
  type FactoryTaskByThreadResult,
  type FactoryTaskChange,
  type FactoryTaskCommentResult,
  type FactoryTaskAssigneeListResult,
  type FactoryTaskCountResult,
  type FactoryTaskDetail,
  type FactoryTaskListResult,
  type FactoryTaskMutationResult,
  type FactoryTaskRef,
  type FactoryTaskResultReadResult,
  type FactoryTaskRun,
  type FactoryTaskSource,
  type FactoryTaskStatus,
  type FactoryTaskSummary,
  type FactoryTaskType,
  type ProjectId,
  type RunId,
  type ServerSettings as Settings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as DeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import * as ExecutionStore from "../persistence/FactoryExecutionStore.ts";
import * as Tasks from "../persistence/FactoryTaskStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Processes from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Delivery from "./FactoryDeliveryService.ts";
import { executionDigest } from "./FactoryExecutionDigest.ts";
import * as Executions from "./FactoryExecutionService.ts";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";
import * as Plans from "./FactoryPlanService.ts";
import type { FactoryIntakeScheduleAuthority } from "./FactoryIntakeSchedule.ts";
import { resolveAssignee, setupKey } from "./FactoryTaskAssignee.ts";
import * as Changes from "./FactoryTaskChanges.ts";
import { parseTaskResultOriginKey, taskResultOriginKey } from "./FactoryOriginKey.ts";
import { checkLaneMove, isLiveRunState } from "./FactoryTaskDerivation.ts";
import * as Work from "./FactoryWorkService.ts";

/** Set by intake when a source, not a person typing, is where the task came from. */
export interface FactoryTaskOrigin {
  readonly source: FactoryTaskSource;
  readonly ruleName: string | null;
}

export class FactoryTaskService extends Context.Service<
  FactoryTaskService,
  {
    readonly list: (
      input: FactoryTaskListInput,
    ) => Effect.Effect<FactoryTaskListResult, FactoryTaskError>;
    readonly count: (
      input: FactoryTaskCountInput,
    ) => Effect.Effect<FactoryTaskCountResult, FactoryTaskError>;
    readonly listAssignees: (
      input: FactoryTaskAssigneeListInput,
    ) => Effect.Effect<FactoryTaskAssigneeListResult, FactoryTaskError>;
    readonly read: (
      input: FactoryTaskReadInput,
    ) => Effect.Effect<FactoryTaskDetail, FactoryTaskError>;
    readonly create: (
      input: FactoryTaskCreateInput,
      actor: FactoryPlanActor,
      origin?: FactoryTaskOrigin,
      schedule?: FactoryIntakeScheduleAuthority,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly update: (
      input: FactoryTaskUpdateInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly start: (
      input: FactoryTaskStartInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly stop: (
      input: FactoryTaskStopInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly retry: (
      input: FactoryTaskRetryInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly accept: (
      input: FactoryTaskAcceptInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly requestChanges: (
      input: FactoryTaskRequestChangesInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly reopen: (
      input: FactoryTaskReopenInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    /**
     * Opens a pull request from the accepted code result. A person's act only: no rule, plan or
     * agent publishes, and no MCP tool exposes it.
     */
    readonly publish: (
      input: FactoryTaskDeliverInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    /** Merges the published pull request at the accepted commit. A person's act only. */
    readonly merge: (
      input: FactoryTaskDeliverInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    /** Reads the host to settle an unconfirmed Publish or Merge. It never sends again. */
    readonly check: (
      input: FactoryTaskCheckInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly readResult: (
      input: FactoryTaskResultReadInput,
    ) => Effect.Effect<FactoryTaskResultReadResult, FactoryTaskError>;
    readonly comment: (
      input: FactoryTaskCommentInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskCommentResult, FactoryTaskError>;
    readonly activity: (
      input: FactoryTaskActivityInput,
    ) => Effect.Effect<FactoryTaskActivityResult, FactoryTaskError>;
    readonly findByThread: (
      input: FactoryTaskByThreadInput,
    ) => Effect.Effect<FactoryTaskByThreadResult, FactoryTaskError>;
    /** One element per committed change. Never replays the past. */
    readonly changes: Stream.Stream<FactoryTaskChange>;
    /** What `assignment` would run for a task of this type in this project, without storing it. */
    readonly resolveAssignee: (input: {
      readonly projectId: ProjectId;
      readonly type: FactoryTaskType;
      readonly assignment: FactoryTaskAssignment;
      readonly parent?: FactoryTaskRef | undefined;
    }) => Effect.Effect<FactoryTaskAssignee, FactoryTaskError>;
    /** Adds sub-tasks and their blockers to one parent in a single plan revision. */
    readonly createSubtasks: (
      input: {
        readonly commandId: CommandId;
        readonly parent: FactoryTaskRef;
        readonly items: ReadonlyArray<{
          // Local to this call; `after` names the keys of items that must finish first.
          readonly key: string;
          readonly title: string;
          readonly description: string;
          readonly assignment: FactoryTaskAssignment;
          readonly after: ReadonlyArray<string>;
        }>;
      },
      actor: FactoryPlanActor,
    ) => Effect.Effect<
      {
        readonly parent: FactoryTaskSummary;
        readonly created: ReadonlyArray<{
          readonly key: string;
          readonly task: FactoryTaskSummary;
        }>;
      },
      FactoryTaskError
    >;
    /** Planning reports its run here so the task's runs, live state and activity include it. */
    readonly recordPlanningRun: (input: {
      readonly ref: FactoryTaskRef;
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly setup: FactoryAgentSetup;
    }) => Effect.Effect<void, FactoryTaskError>;
    /** Planning reports a proposal's state here; `proposed` raises the `plan` attention reason. */
    readonly recordProposal: (input: {
      readonly ref: FactoryTaskRef;
      readonly proposalId: string;
      readonly itemCount: number;
      readonly status: "proposed" | "approved" | "dismissed";
      readonly actor: FactoryPlanActor;
    }) => Effect.Effect<void, FactoryTaskError>;
  }
>()("t3/factory/FactoryTaskService") {}

const invalid = (cause: unknown) => new FactoryTaskError({ reason: "invalid-input", cause });
const refuse = (reason: FactoryTaskError["reason"]) => new FactoryTaskError({ reason });
const isTaskError = Schema.is(FactoryTaskError);
const asTaskError = (cause: unknown) =>
  isTaskError(cause) ? cause : new FactoryTaskError({ reason: "persistence-failure", cause });

const decodeList = Schema.decodeEffect(FactoryTaskListInput);
const decodeCount = Schema.decodeEffect(FactoryTaskCountInput);
const decodeAssigneeList = Schema.decodeEffect(FactoryTaskAssigneeListInput);
const decodeRead = Schema.decodeEffect(FactoryTaskReadInput);
const decodeCreate = Schema.decodeEffect(FactoryTaskCreateInput);
const decodeUpdate = Schema.decodeEffect(FactoryTaskUpdateInput);
const decodeStart = Schema.decodeEffect(FactoryTaskStartInput);
const decodeStop = Schema.decodeEffect(FactoryTaskStopInput);
const decodeRetry = Schema.decodeEffect(FactoryTaskRetryInput);
const decodeAccept = Schema.decodeEffect(FactoryTaskAcceptInput);
const decodeRequestChanges = Schema.decodeEffect(FactoryTaskRequestChangesInput);
const decodeReopen = Schema.decodeEffect(FactoryTaskReopenInput);
const decodeDeliver = Schema.decodeEffect(FactoryTaskDeliverInput);
const decodeCheck = Schema.decodeEffect(FactoryTaskCheckInput);
const decodeResultRead = Schema.decodeEffect(FactoryTaskResultReadInput);
const decodeComment = Schema.decodeEffect(FactoryTaskCommentInput);
const decodeActivity = Schema.decodeEffect(FactoryTaskActivityInput);
const decodeByThread = Schema.decodeEffect(FactoryTaskByThreadInput);

const CursorJson = Schema.fromJsonString(
  Schema.Struct({
    scope: Schema.String,
    updatedAt: Schema.optional(Schema.String),
    rootId: Schema.optional(Schema.String),
    taskId: Schema.optional(Schema.String),
    seq: Schema.optional(Schema.Number),
  }),
);
const encodeCursorJson = Schema.encodeSync(CursorJson);
const decodeCursorJson = Schema.decodeUnknownEffect(CursorJson);
const encodeCursor = (cursor: typeof CursorJson.Type) =>
  Buffer.from(encodeCursorJson(cursor), "utf8").toString("base64url");
const decodeCursor = Effect.fnUntraced(function* (cursor: string, scope: string) {
  const decoded = yield* decodeCursorJson(Buffer.from(cursor, "base64url").toString("utf8")).pipe(
    Effect.mapError(() => refuse("invalid-cursor")),
  );
  // A cursor continues one filter. Used with another, it would skip or repeat entries.
  if (decoded.scope !== scope) return yield* refuse("invalid-cursor");
  return decoded;
});

const decodeTaskKey = Schema.decodeUnknownEffect(
  Schema.Struct({ rootId: Schema.String, taskId: Schema.String }),
);

const MAX_TASKS = 64;
const PERSON: Tasks.TaskActor = { kind: "person", label: "You" };
const FAILED_NATIVE = new Set(["failed", "interrupted", "cancelled"]);
// A start is one person's approval of one task; it ends with their session, not with a clock.
const GRANT_EXPIRES_AT = "9999-12-31T23:59:59.999Z";
// The engine keeps a code checkpoint only behind a check. This one changes nothing.
const CHECKPOINT_CHECK = { command: "git", args: ["rev-parse", "--verify", "HEAD"] };
const SHA = /^[a-f0-9]{40,64}$/;

const planError = (error: FactoryPlanError) => {
  const reasons: Record<FactoryPlanError["reason"], FactoryTaskError["reason"]> = {
    "wrong-environment": "wrong-environment",
    "missing-project": "missing-project",
    "missing-plan": "missing-task",
    forbidden: "forbidden",
    "revision-conflict": "version-conflict",
    "command-conflict": "command-conflict",
    "invalid-plan": "invalid-input",
    "invalid-operation": "invalid-input",
    "context-unavailable": "invalid-input",
    "persistence-failure": "persistence-failure",
  };
  return new FactoryTaskError({ reason: reasons[error.reason], cause: error });
};

const executionError = (error: FactoryExecutionError) => {
  const reasons: Record<FactoryExecutionError["reason"], FactoryTaskError["reason"]> = {
    forbidden: "forbidden",
    "wrong-environment": "wrong-environment",
    "missing-plan": "missing-task",
    "missing-project": "missing-project",
    "revision-conflict": "version-conflict",
    "grant-conflict": "version-conflict",
    "grant-inactive": "forbidden",
    "grant-expired": "forbidden",
    "command-conflict": "command-conflict",
    "task-conflict": "run-active",
    "budget-exhausted": "run-active",
    "prerequisite-held": "blocked",
    // An unknown or disabled provider instance fails the same check with its lookup as the cause.
    "unsupported-capability":
      error.cause === undefined ? "unsupported-capability" : "provider-unavailable",
    "invalid-input": "invalid-input",
    "missing-result": "no-result",
    "capture-conflict": "result-conflict",
    "not-quiescent": "run-active",
    "persistence-failure": "persistence-failure",
  };
  return new FactoryTaskError({
    reason: reasons[error.reason],
    ...(error.capabilityReason === undefined ? {} : { detail: error.capabilityReason }),
    cause: error,
  });
};

/** Plain words for what stopped a Publish or Merge; the client shows `detail` as it is. */
const deliveryRefusal = (error: FactoryDeliveryError): FactoryTaskError => {
  const as = (reason: FactoryTaskError["reason"]) => new FactoryTaskError({ reason, cause: error });
  const refused = (detail: string) =>
    new FactoryTaskError({ reason: "delivery-refused", detail, cause: error });
  switch (error.reason) {
    case "already-delivering":
      return as("delivery-active");
    case "not-published":
      return as("not-published");
    case "not-accepted":
    case "acceptance-stale":
      return as("not-accepted");
    case "persistence-failure":
    case "intent-not-found":
      return as("persistence-failure");
    case "missing-base-branch":
      return refused(
        "The repository has no default branch on origin to open a pull request against.",
      );
    case "capability-unsupported":
      return refused("This repository's host can't open or merge pull requests from here.");
    case "repository-changed":
      return refused("The project's origin repository changed or can't be read.");
    case "worktree-unavailable":
      return refused("The accepted commit is no longer in the project's repository.");
    case "pull-request-head-moved":
      return refused("The pull request has commits beyond the accepted one. Merge it on the host.");
    case "payload-changed":
      return refused("The pull request's base branch changed on the host.");
    default:
      return refused(error.message);
  }
};

const deliveryBranch = (
  ref: FactoryTaskRef,
  displayId: string,
  title: string,
  revision: number,
) => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const identity = executionDigest([
    ref.environmentId,
    ref.projectId,
    ref.rootId,
    ref.taskId,
  ]).slice(0, 32);
  return `t3/${displayId}-rev${revision}-${identity}/${slug || "task"}`;
};

const sameSetup = (left: FactoryAgentSetup | undefined, right: FactoryAgentSetup) =>
  left !== undefined && executionDigest(left) === executionDigest(right);
const unfinished = (status: FactoryTaskStatus) => status !== "done" && status !== "canceled";
const plainRun = (run: Tasks.TaskRunRow): FactoryTaskRun => ({
  ordinal: run.ordinal,
  threadId: run.threadId,
  runId: run.runId,
  state: run.state,
  purpose: run.purpose,
  setup: run.setup,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  note: run.note,
});
const firstLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line !== "")
    ?.slice(0, 200) ?? "Document";

/** What settings give a task nobody chose a model or permissions for. */
const taskDefaultsOf = (value: Settings) => ({
  model: value.defaultModelSelection,
  runtimeModes: {
    environment: value.defaultRuntimeMode,
    // Sorted so an unchanged setting mirrors to the same text.
    projects: Object.fromEntries(
      Object.entries(value.projectSettingsOverrides)
        .flatMap(([projectId, overrides]) =>
          overrides.defaultRuntimeMode === undefined
            ? []
            : [[projectId, overrides.defaultRuntimeMode] as const],
        )
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  },
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Tasks.FactoryTaskStore;
  const plans = yield* Plans.FactoryPlanService;
  const work = yield* Work.FactoryWorkService;
  const executions = yield* Executions.FactoryExecutionService;
  const executionStore = yield* ExecutionStore.FactoryExecutionStore;
  const projections = yield* Projections.ProjectionStoreV2;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const processes = yield* Processes.ProcessRunner;
  const changes = yield* Changes.FactoryTaskChanges;
  const delivery = yield* Delivery.FactoryDeliveryService;
  const deliveryStore = yield* DeliveryStore.FactoryDeliveryStore;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;

  // Request changes still starting a run in this process, by task.
  const requestingChanges = new Set<string>();
  const transact = <A, R>(effect: Effect.Effect<A, FactoryTaskError, R>) =>
    sql.withTransaction(effect).pipe(Effect.mapError(asTaskError));
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const derived = (commandId: CommandId, step: string) =>
    CommandId.make(`factory-task:${step}:${commandId}`);
  const planRef = (ref: Tasks.TaskKey & { readonly projectId: ProjectId }): FactoryPlanRef => ({
    environmentId,
    projectId: ref.projectId,
    rootId: ref.rootId,
  });
  const actorOf = (actor: FactoryPlanActor) =>
    actor.kind === "human" ? Effect.succeed(PERSON) : store.threadActor(actor.threadId);
  const requireHuman = (actor: FactoryPlanActor) =>
    actor.kind === "human" ? Effect.void : Effect.fail(refuse("forbidden"));

  const pointers = (root: Tasks.RootView, taskIds: ReadonlyArray<string>) =>
    taskIds.flatMap((taskId) => {
      const view = root.tasks.get(taskId);
      return view === undefined
        ? []
        : [
            {
              taskId,
              displayId: view.row.displayId,
              title: view.row.title,
              status: view.derived.status,
            },
          ];
    });

  const summarize = (root: Tasks.RootView, view: Tasks.TaskView): FactoryTaskSummary => {
    const parent = view.row.parentId === null ? undefined : root.tasks.get(view.row.parentId);
    return {
      ref: {
        environmentId,
        projectId: view.row.projectId,
        rootId: view.row.rootId,
        taskId: view.row.taskId,
      },
      displayId: view.row.displayId,
      parent:
        parent === undefined
          ? null
          : { taskId: parent.row.taskId, displayId: parent.row.displayId },
      title: view.row.title,
      type: view.row.type,
      status: view.derived.status,
      lane: view.row.lane,
      assignee: view.assignee,
      source: view.row.source,
      blockedBy: pointers(root, view.blockedBy)
        .filter((blocker) => unfinished(blocker.status))
        .slice(0, 8),
      progress: view.derived.progress,
      run: view.runs.length === 0 ? null : plainRun(view.runs.at(-1)!),
      liveRuns: view.derived.liveRuns,
      attention: view.derived.attention,
      result: view.derived.result,
      version: view.row.version,
      createdAt: view.row.createdAt,
      updatedAt: view.row.updatedAt,
    };
  };
  const loadTask = Effect.fn("FactoryTaskService.loadTask")(function* (key: Tasks.TaskKey) {
    const root = (yield* store.loadRoots([key.rootId])).get(key.rootId);
    const task = root?.tasks.get(key.taskId);
    if (root === undefined || task === undefined) return yield* refuse("missing-task");
    return { root, task };
  });
  const requireTask = Effect.fn("FactoryTaskService.requireTask")(function* (ref: FactoryTaskRef) {
    if (ref.environmentId !== environmentId) return yield* refuse("wrong-environment");
    if ((yield* store.projectWorkspace(ref.projectId)) === null)
      return yield* refuse("missing-project");
    const found = yield* loadTask(ref);
    if (found.root.projectId !== ref.projectId) return yield* refuse("missing-task");
    return found;
  });
  const summaryOf = Effect.fn("FactoryTaskService.summaryOf")(function* (key: Tasks.TaskKey) {
    const { root, task } = yield* loadTask(key);
    return summarize(root, task);
  });

  /** A command id answers once: the same input replays, a different one conflicts. */
  const begin = Effect.fn("FactoryTaskService.begin")(function* (
    kind: string,
    commandId: CommandId,
    actor: FactoryPlanActor,
    input: unknown,
  ) {
    const digest = executionDigest([kind, actor, input]);
    const existing = yield* store.receipt(commandId);
    if (existing !== null && (existing.kind !== kind || existing.digest !== digest))
      return yield* refuse("command-conflict");
    return {
      replayed: existing !== null,
      outcome: existing?.outcome,
      record: (outcome: unknown) => store.recordReceipt({ commandId, kind, digest, outcome }),
    };
  });

  const applyPlan = Effect.fn("FactoryTaskService.applyPlan")(function* (input: {
    readonly commandId: CommandId;
    readonly ref: FactoryPlanRef;
    readonly actor: FactoryPlanActor;
    readonly operations: (plan: FactoryPlanSnapshot) => ReadonlyArray<FactoryPlanOperation>;
    readonly adding?: number;
  }) {
    // Another task's edit may move the plan between the read and the commit. Each try has its
    // own command id, so a replayed command walks the same tries and lands on the same one.
    for (let attempt = 0; ; attempt += 1) {
      const head = yield* plans.read({ ref: input.ref }).pipe(Effect.mapError(planError));
      if (head.tasks.length + (input.adding ?? 0) > MAX_TASKS) return yield* refuse("task-limit");
      const applied = yield* plans
        .apply(
          {
            commandId: derived(input.commandId, `plan-${attempt}`),
            ref: input.ref,
            expectedRevision: head.revision,
            operations: input.operations(head),
          },
          input.actor,
        )
        .pipe(Effect.result);
      if (Result.isSuccess(applied)) return applied.success.plan;
      if (applied.failure.reason !== "revision-conflict" || attempt === 3)
        return yield* planError(applied.failure);
    }
  });

  const requireProfile = Effect.fn("FactoryTaskService.requireProfile")(function* (
    assignment: FactoryTaskAssignment | undefined,
  ) {
    if (assignment?.mode !== "profile") return;
    const profiles = yield* store.listProfiles;
    if (!profiles.some((profile) => profile.id === assignment.profileId))
      return yield* refuse("missing-profile");
  });

  const describeResult = Effect.fn("FactoryTaskService.describeResult")(function* (
    pending: Tasks.PendingResult,
  ) {
    const commit = pending.output.checkpoint?.commit;
    if (commit !== undefined && pending.baseRef !== null && pending.repositoryPath !== null) {
      const diff = yield* processes
        .run({
          command: "git",
          args: ["diff", "--numstat", "--no-renames", "-z", pending.baseRef, commit],
          cwd: pending.repositoryPath,
          maxOutputBytes: 1024 * 1024,
          outputMode: "truncate",
        })
        .pipe(Effect.result);
      if (Result.isFailure(diff) || diff.success.code !== 0)
        return { kind: "code" as const, summary: "Code changes", files: [], filesOmitted: 0 };
      const files = diff.success.stdout
        .split("\0")
        .map((entry) => /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry))
        .flatMap((match) =>
          match === null
            ? []
            : [
                {
                  path: match[3]!,
                  additions: Number(match[1]) || 0,
                  deletions: Number(match[2]) || 0,
                },
              ],
        );
      if (files.length > 0) {
        const additions = files.reduce((total, file) => total + file.additions, 0);
        const deletions = files.reduce((total, file) => total + file.deletions, 0);
        return {
          kind: "code" as const,
          summary: `+${additions} −${deletions} · ${files.length} ${files.length === 1 ? "file" : "files"}`,
          files: files.slice(0, 500),
          filesOmitted: Math.max(0, files.length - 500),
        };
      }
    }
    // A run that changed no file answered in words: its result is the text.
    const text = yield* executions
      .readOutput({ selection: pending.output.selection, resultId: pending.output.resultId })
      .pipe(
        Effect.map((output) => output.text),
        Effect.orElseSucceed(() => ""),
      );
    const messages = yield* projections
      .getThreadRecords(pending.threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [pending.output.runId],
      })
      .pipe(Effect.mapError(asTaskError));
    const answer =
      messages.messages.findLast((message) => message.text.trim() !== "")?.text ??
      text
        .trim()
        .split(/\r?\n\s*\r?\n/)
        .at(-1) ??
      "";
    return { kind: "document" as const, summary: firstLine(answer), files: [], filesOmitted: 0 };
  });

  /** Brings runs, results and the index up to date with the execution engine. */
  const sync = Effect.fn("FactoryTaskService.sync")(function* (rootId: string) {
    const at = yield* now;
    const pending = yield* transact(
      Effect.gen(function* () {
        const sealed = yield* store.syncRuns(rootId, at);
        yield* store.refreshRoots([rootId]);
        yield* changes.announce({ rootIds: [rootId] });
        return sealed;
      }),
    );
    for (const result of pending) {
      const described = yield* describeResult(result);
      yield* transact(
        Effect.gen(function* () {
          yield* store.recordResult({ pending: result, ...described });
          yield* store.refreshRoots([rootId]);
          yield* changes.announce({ rootIds: [rootId] });
        }),
      );
    }
  });

  const headCommit = Effect.fn("FactoryTaskService.headCommit")(function* (projectId: ProjectId) {
    const cwd = yield* store.projectWorkspace(projectId);
    if (cwd === null) return yield* refuse("missing-project");
    const head = yield* processes
      .run({
        command: "git",
        args: ["rev-parse", "--verify", "HEAD^{commit}"],
        cwd,
        maxOutputBytes: 256,
        outputMode: "error",
      })
      .pipe(
        Effect.mapError(
          (cause) => new FactoryTaskError({ reason: "unsupported-capability", cause }),
        ),
      );
    const sha = head.stdout.trim();
    if (head.code !== 0 || !SHA.test(sha)) return yield* refuse("unsupported-capability");
    return sha;
  });

  const requireIdleSiblings = Effect.fn("FactoryTaskService.requireIdleSiblings")(function* (
    row: Tasks.TaskRow,
    revision: number,
  ) {
    if (
      (yield* store.liveAttempts({
        rootId: row.rootId,
        revision,
        exceptTaskId: row.taskId,
      })).length > 0
    )
      return yield* new FactoryTaskError({
        reason: "run-active",
        detail: "Another sub-task of this task is running. Try again when it finishes.",
      });
  });

  /**
   * Where the task's next run starts in the engine. The engine runs a task once per plan
   * revision, so another round takes a new revision, which stops authorizing every sibling run
   * admitted under the current one: a round waits until no sibling is running.
   */
  const nextRound = Effect.fn("FactoryTaskService.nextRound")(function* (row: Tasks.TaskRow) {
    const head = yield* plans.read({ ref: planRef(row) }).pipe(Effect.mapError(planError));
    const prior = yield* store.engineAttempt({
      rootId: row.rootId,
      revision: head.revision,
      taskId: row.taskId,
    });
    if (prior !== null && !prior.quiescent) return yield* refuse("run-active");
    const retryable =
      prior !== null &&
      prior.latestStatus !== "sealed" &&
      (FAILED_NATIVE.has(prior.nativeStatus ?? "") || prior.latestStatus === "failed");
    const round = prior !== null && !retryable;
    if (round) yield* requireIdleSiblings(row, head.revision);
    return { head, prior, round };
  });

  /** Issues the person's grant for this one task at the current plan revision and admits it. */
  const launch = Effect.fn("FactoryTaskService.launch")(function* (input: {
    readonly commandId: CommandId;
    readonly task: Tasks.TaskView;
    readonly setup: FactoryAgentSetup;
    readonly profileId: string | null;
    readonly actor: FactoryPlanActor;
    /** A code result to continue from, instead of the project's current commit. */
    readonly baseCommit: string | null;
  }) {
    const { row } = input.task;
    const ref = planRef(row);
    const admitId = derived(input.commandId, "admit");
    yield* store.registerLaunch({ commandId: admitId, profileId: input.profileId, actor: PERSON });
    if (yield* store.launched(admitId)) return;
    const next = yield* nextRound(row);
    let { head, prior } = next;
    if (next.round) {
      const title = head.tasks.find((task) => task.id === row.taskId)?.title ?? row.title;
      head = (yield* transact(
        Effect.gen(function* () {
          yield* requireIdleSiblings(row, head.revision);
          return yield* plans
            .apply(
              {
                commandId: derived(input.commandId, "round"),
                ref,
                expectedRevision: head.revision,
                operations: [{ type: "task.update", id: row.taskId, title }],
              },
              input.actor,
            )
            .pipe(Effect.mapError(planError));
        }),
      )).plan;
      prior = null;
    }
    const worktree = input.setup.workspace === "worktree";
    const spec: FactoryExecutionTaskSpec = {
      taskId: row.taskId,
      modelSelection: input.setup.modelSelection,
      runtimeMode: input.setup.runtimeMode,
      interactionMode: input.setup.interactionMode,
      workspaceStrategy: worktree
        ? { type: "worktree", baseRef: input.baseCommit ?? (yield* headCommit(row.projectId)) }
        : { type: "root" },
      setup: "deny",
      ...(worktree ? { verification: CHECKPOINT_CHECK } : {}),
      output: { slot: "result", kind: worktree ? "verified-code" : "sealed-draft" },
    };
    const running = yield* store.liveAttempts({
      rootId: row.rootId,
      revision: head.revision,
      exceptTaskId: row.taskId,
    });
    const policy: FactoryExecutionPolicy = {
      version: 1,
      requesterThreadIds: [],
      tasks: [spec, ...running.map((attempt) => attempt.spec)],
      edges: [],
      advisoryEdges: true,
      // A new grant replaces the last one; naming the running attempts keeps them authorized.
      ...(running.length === 0
        ? {}
        : { continues: running.map((attempt) => attempt.runAttemptId) }),
      maxAttempts: MAX_TASKS,
      maxRetriesPerTask: MAX_TASKS,
      maxConcurrent: MAX_TASKS,
      expiresAt: GRANT_EXPIRES_AT,
      requiredCapabilities: [],
    };
    const granted = yield* executions
      .issueGrant(
        {
          commandId: derived(input.commandId, "grant"),
          ref,
          expectedRevision: head.revision,
          expectedGrantVersion: yield* store.grantVersion(row.rootId),
          policy,
        },
        input.actor,
      )
      .pipe(Effect.mapError(executionError));
    const admission = {
      commandId: admitId,
      selection: { ref, revision: head.revision, taskId: row.taskId },
      grantVersion: granted.execution.grant!.version,
    };
    yield* (
      prior === null
        ? executions.admit({ ...admission, expectedTaskVersion: 0 }, input.actor)
        : executions.retry(
            {
              ...admission,
              expectedTaskVersion: prior.version,
              priorRunId: prior.runId,
              priorRunAttemptId: prior.runAttemptId,
              priorResultId: prior.latestResultId,
              intent: "retry",
            },
            input.actor,
          )
    ).pipe(Effect.mapError(executionError));
  });

  /** Assigns the task to the setup it is about to run with, when it does not already resolve to it. */
  const assignFor = Effect.fn("FactoryTaskService.assignFor")(function* (
    task: Tasks.TaskView,
    setup: FactoryAgentSetup,
  ) {
    const resolved = task.assignee.resolved;
    if (resolved !== null && sameSetup(resolved.setup, setup)) return resolved.profile?.id ?? null;
    const assignment: FactoryTaskAssignment = { mode: "pinned", setup };
    const at = yield* now;
    yield* transact(
      Effect.gen(function* () {
        yield* store.updateBoard(task.row, { assignment, bumpVersion: false, at });
        yield* store.appendActivity({
          key: task.row,
          at,
          actor: PERSON,
          event: {
            type: "assigned",
            assignee: {
              assignment,
              key: setupKey(setup),
              resolved: { profile: null, setup, via: "assignment" },
            },
          },
        });
      }),
    );
    return null;
  });

  /** Launches a run and closes the command: the shared tail of start, retry and request changes. */
  const run = Effect.fn("FactoryTaskService.run")(function* (input: {
    readonly commandId: CommandId;
    readonly task: Tasks.TaskView;
    readonly setup: FactoryAgentSetup;
    readonly profileId: string | null;
    readonly actor: FactoryPlanActor;
    readonly baseCommit: string | null;
    readonly record: (outcome: unknown) => Effect.Effect<void, FactoryTaskError>;
  }) {
    const { row } = input.task;
    yield* launch(input);
    yield* sync(row.rootId);
    const at = yield* now;
    yield* transact(
      Effect.gen(function* () {
        yield* store.updateBoard(row, { bumpVersion: true, at });
        yield* store.refreshRoots([row.rootId]);
        yield* input.record({ rootId: row.rootId, taskId: row.taskId });
        yield* changes.announce({ rootIds: [row.rootId] });
      }),
    );
    return { task: yield* summaryOf(row), replayed: false };
  });

  const replay = Effect.fn("FactoryTaskService.replay")(function* (key: Tasks.TaskKey) {
    return { task: yield* summaryOf(key), replayed: true };
  });

  const list: FactoryTaskService["Service"]["list"] = Effect.fn("FactoryTaskService.list")(
    function* (raw) {
      const {
        cursor,
        limit = 50,
        ...filter
      } = yield* decodeList(raw).pipe(Effect.mapError(invalid));
      const scope = executionDigest(["factory-task-list/1", filter]);
      const position = cursor === undefined ? null : yield* decodeCursor(cursor, scope);
      if (
        position !== null &&
        (position.updatedAt === undefined ||
          position.rootId === undefined ||
          position.taskId === undefined)
      )
        return yield* refuse("invalid-cursor");
      const rows = yield* store.page({
        filter,
        after:
          position === null
            ? null
            : {
                updatedAt: position.updatedAt!,
                rootId: position.rootId!,
                taskId: position.taskId!,
              },
        limit: limit + 1,
      });
      const selected = rows.slice(0, limit);
      const roots = yield* store.loadRoots(selected.map((row) => row.rootId));
      const last = selected.at(-1);
      return {
        environmentId,
        items: selected.flatMap((row) => {
          const root = roots.get(row.rootId);
          const view = root?.tasks.get(row.taskId);
          return root === undefined || view === undefined ? [] : [summarize(root, view)];
        }),
        nextCursor:
          rows.length > limit && last !== undefined ? encodeCursor({ scope, ...last }) : null,
        fetchedAt: yield* now,
      };
    },
  );

  const count: FactoryTaskService["Service"]["count"] = Effect.fn("FactoryTaskService.count")(
    function* (raw) {
      const filter = yield* decodeCount(raw).pipe(Effect.mapError(invalid));
      return { environmentId, byStatus: yield* store.count(filter), fetchedAt: yield* now };
    },
  );

  const listAssignees: FactoryTaskService["Service"]["listAssignees"] = Effect.fn(
    "FactoryTaskService.listAssignees",
  )(function* (raw) {
    const { projectIds } = yield* decodeAssigneeList(raw).pipe(Effect.mapError(invalid));
    const samples = yield* store.assigneeSamples({
      filter: { scope: "all", ...(projectIds === undefined ? {} : { projectIds }) },
      limit: 128,
    });
    const roots = yield* store.loadRoots([...new Set(samples.map((sample) => sample.rootId))]);
    const assignees = new Map<string, FactoryTaskSummary["assignee"]>();
    for (const sample of samples) {
      const root = roots.get(sample.rootId);
      const view = root?.tasks.get(sample.taskId);
      if (root === undefined || view === undefined) continue;
      const { assignee } = summarize(root, view);
      if (!assignees.has(assignee.key)) assignees.set(assignee.key, assignee);
    }
    return { assignees: [...assignees.values()], fetchedAt: yield* now };
  });

  const read: FactoryTaskService["Service"]["read"] = Effect.fn("FactoryTaskService.read")(
    function* (raw) {
      const input = yield* decodeRead(raw).pipe(Effect.mapError(invalid));
      let found: { readonly root: Tasks.RootView; readonly task: Tasks.TaskView };
      if ("ref" in input.task) found = yield* requireTask(input.task.ref);
      else {
        const key = yield* store.locate(input.task.displayId);
        if (key === null) return yield* refuse("missing-task");
        found = yield* loadTask(key);
      }
      const { root, task } = found;
      const plan = yield* plans.read({ ref: planRef(task.row) }).pipe(Effect.mapError(planError));
      const ancestors: string[] = [];
      for (
        let parent = task.row.parentId;
        parent !== null && !ancestors.includes(parent);
        parent = root.tasks.get(parent)?.row.parentId ?? null
      )
        ancestors.unshift(parent);
      return {
        task: summarize(root, task),
        description: plan.tasks.find((entry) => entry.id === task.row.taskId)?.context ?? "",
        ancestors: pointers(root, ancestors).slice(-16),
        subtasks: task.subtasks.slice(0, 64).flatMap((taskId) => {
          const view = root.tasks.get(taskId);
          return view === undefined ? [] : [summarize(root, view)];
        }),
        blockedBy: pointers(root, task.blockedBy).slice(0, 64),
        blocks: pointers(root, task.blocks).slice(0, 64),
        runs: task.runs.toReversed().slice(0, 32).map(plainRun),
        fetchedAt: yield* now,
      };
    },
  );

  const create: FactoryTaskService["Service"]["create"] = Effect.fn("FactoryTaskService.create")(
    function* (raw, actor, origin, schedule) {
      yield* requireHuman(actor);
      const input = yield* decodeCreate(raw).pipe(Effect.mapError(invalid));
      if (
        schedule !== undefined &&
        (input.parent !== undefined ||
          input.workRef !== undefined ||
          origin?.source.kind !== "schedule")
      )
        return yield* refuse("forbidden");
      const command = yield* begin("create", input.commandId, actor, [input, origin ?? null]);
      if (command.replayed)
        return yield* replay(
          yield* decodeTaskKey(command.outcome).pipe(Effect.mapError(asTaskError)),
        );
      if ((yield* store.projectWorkspace(input.projectId)) === null)
        return yield* refuse("missing-project");
      yield* requireProfile(input.assignment);
      // Read before anything is created: a task is never left behind without its Work.
      const retained =
        input.workRef === undefined
          ? null
          : yield* work.read({ ref: input.workRef }).pipe(
              Effect.mapError(
                (cause) =>
                  new FactoryTaskError({
                    reason:
                      cause.reason === "wrong-environment" ? "wrong-environment" : "invalid-input",
                    cause,
                  }),
              ),
            );
      if (retained !== null && !retained.projectAvailable) return yield* refuse("invalid-input");
      const attach = (taskId: string): ReadonlyArray<FactoryPlanOperation> =>
        input.workRef === undefined
          ? []
          : [
              {
                type: "context.attachWork",
                id: executionDigest(["factory-task-work/1", input.commandId]),
                taskId,
                ref: input.workRef,
              },
            ];
      let key: Tasks.TaskKey;
      if (input.parent === undefined) {
        const created = yield* plans
          .create(
            {
              commandId: derived(input.commandId, "plan"),
              projectId: input.projectId,
              title: input.title,
              ...(input.description === undefined ? {} : { context: input.description }),
            },
            actor,
            schedule,
          )
          .pipe(Effect.mapError(planError));
        const rootId = created.plan.ref.rootId;
        key = { rootId, taskId: rootId };
        if (input.workRef !== undefined)
          yield* applyPlan({
            commandId: input.commandId,
            ref: created.plan.ref,
            actor,
            operations: () => attach(rootId),
          });
      } else {
        const parent = input.parent;
        const { root } = yield* requireTask({
          environmentId,
          projectId: input.projectId,
          rootId: parent.rootId,
          taskId: parent.taskId,
        });
        const blockers = [...new Set(parent.blockedBy ?? [])];
        if (blockers.some((taskId) => !root.tasks.has(taskId)))
          return yield* refuse("invalid-input");
        const taskId = executionDigest(["factory-task/1", input.commandId]);
        key = { rootId: parent.rootId, taskId };
        yield* applyPlan({
          commandId: input.commandId,
          ref: planRef({ ...key, projectId: input.projectId }),
          actor,
          adding: 1,
          operations: () => [
            {
              type: "task.add",
              id: taskId,
              parentId: parent.taskId,
              title: input.title,
              ...(input.description === undefined ? {} : { context: input.description }),
            },
            ...blockers.map((blocker): FactoryPlanOperation => ({
              type: "edge.add",
              id: executionDigest(["factory-task-blocker/1", input.commandId, blocker]),
              fromTaskId: taskId,
              toTaskId: blocker,
              requirement: "",
            })),
            ...attach(taskId),
          ],
        });
      }
      const bounded = (value: string | null) =>
        value === null || value.length > 2048 ? null : value;
      const source: FactoryTaskSource | undefined =
        origin?.source ??
        (retained === null
          ? undefined
          : {
              kind:
                retained.item.ref.kind === "issue" || retained.item.ref.kind === "feed"
                  ? retained.item.ref.kind
                  : "local",
              label: retained.item.title,
              url: bounded(retained.item.sourceUrl),
              key: bounded(retained.item.sourceKey),
              workRef: retained.item.ref,
            });
      const at = yield* now;
      yield* transact(
        Effect.gen(function* () {
          yield* store.updateBoard(key, {
            ...(input.type === undefined ? {} : { type: input.type }),
            ...(input.lane === undefined ? {} : { lane: input.lane }),
            ...(input.assignment === undefined ? {} : { assignment: input.assignment }),
            ...(source === undefined ? {} : { source }),
            bumpVersion: false,
            at,
          });
          yield* store.appendActivity({
            key,
            at,
            actor:
              origin === undefined || origin.ruleName === null
                ? PERSON
                : { kind: "rule", label: origin.ruleName },
            event: {
              type: "created",
              source: source ?? Tasks.LOCAL_TASK_SOURCE,
              ruleName: origin?.ruleName ?? null,
            },
            dedupeKey: `created:${key.rootId}:${key.taskId}`,
          });
          if (input.parent !== undefined)
            yield* store.appendActivity({
              key: { rootId: key.rootId, taskId: input.parent.taskId },
              at,
              actor: PERSON,
              event: { type: "subtasks-added", count: 1 },
              dedupeKey: `subtasks-added:${input.commandId}`,
            });
          yield* store.refreshRoots([key.rootId]);
          yield* command.record(key);
          yield* changes.announce({ rootIds: [key.rootId] });
        }),
      );
      return { task: yield* summaryOf(key), replayed: false };
    },
  );

  const createSubtasks: FactoryTaskService["Service"]["createSubtasks"] = Effect.fn(
    "FactoryTaskService.createSubtasks",
  )(function* (input, actor) {
    const command = yield* begin("createSubtasks", input.commandId, actor, input);
    const taskIdOf = (key: string) => executionDigest(["factory-subtask/1", input.commandId, key]);
    const answer = Effect.fn("FactoryTaskService.createSubtasks.answer")(function* () {
      const { root, task } = yield* loadTask(input.parent);
      return {
        parent: summarize(root, task),
        created: input.items.flatMap((item) => {
          const view = root.tasks.get(taskIdOf(item.key));
          return view === undefined ? [] : [{ key: item.key, task: summarize(root, view) }];
        }),
      };
    });
    if (command.replayed) return yield* answer();
    yield* requireTask(input.parent);
    const keys = new Set(input.items.map((item) => item.key));
    if (
      input.items.length === 0 ||
      keys.size !== input.items.length ||
      input.items.some(
        (item) => item.after.includes(item.key) || item.after.some((key) => !keys.has(key)),
      )
    )
      return yield* refuse("invalid-input");
    for (const item of input.items) yield* requireProfile(item.assignment);
    yield* applyPlan({
      commandId: input.commandId,
      ref: planRef(input.parent),
      actor,
      adding: input.items.length,
      operations: () => [
        ...input.items.map((item): FactoryPlanOperation => ({
          type: "task.add",
          id: taskIdOf(item.key),
          parentId: input.parent.taskId,
          title: item.title,
          context: item.description,
        })),
        ...input.items.flatMap((item) =>
          [...new Set(item.after)].map((after): FactoryPlanOperation => ({
            type: "edge.add",
            id: executionDigest(["factory-subtask-order/1", input.commandId, item.key, after]),
            fromTaskId: taskIdOf(item.key),
            toTaskId: taskIdOf(after),
            requirement: "",
          })),
        ),
      ],
    });
    const at = yield* now;
    const author = yield* actorOf(actor);
    yield* transact(
      Effect.gen(function* () {
        for (const item of input.items) {
          const key = { rootId: input.parent.rootId, taskId: taskIdOf(item.key) };
          yield* store.updateBoard(key, { assignment: item.assignment, bumpVersion: false, at });
          yield* store.appendActivity({
            key,
            at,
            actor: author,
            event: { type: "created", source: Tasks.LOCAL_TASK_SOURCE, ruleName: null },
            dedupeKey: `created:${key.rootId}:${key.taskId}`,
          });
        }
        yield* store.appendActivity({
          key: input.parent,
          at,
          actor: author,
          event: { type: "subtasks-added", count: input.items.length },
          dedupeKey: `subtasks-added:${input.commandId}`,
        });
        yield* store.refreshRoots([input.parent.rootId]);
        yield* command.record({ rootId: input.parent.rootId });
        yield* changes.announce({ rootIds: [input.parent.rootId] });
      }),
    );
    return yield* answer();
  });

  const update: FactoryTaskService["Service"]["update"] = Effect.fn("FactoryTaskService.update")(
    function* (raw, actor) {
      yield* requireHuman(actor);
      const input = yield* decodeUpdate(raw).pipe(Effect.mapError(invalid));
      const command = yield* begin("update", input.commandId, actor, input);
      if (command.replayed) return yield* replay(input.ref);
      yield* requireProfile(input.assignment);
      const at = yield* now;
      // Checked and written in one transaction, so two devices editing from the same version
      // cannot both land.
      const row = yield* transact(
        Effect.gen(function* () {
          const { task } = yield* requireTask(input.ref);
          const { row } = task;
          if (row.version !== input.expectedVersion)
            return yield* new FactoryTaskError({
              reason: "version-conflict",
              currentVersion: row.version,
            });
          const latestResult = task.derived.result;
          if (input.lane !== undefined) {
            const move = checkLaneMove({
              from: row.lane,
              to: input.lane,
              status: task.derived.status,
              accepted: row.acceptedRevision !== null,
              runLive: task.derived.liveRuns.length > 0,
              resultWaiting: latestResult !== null && latestResult.state !== "accepted",
            });
            if (!move.allowed) return yield* refuse(move.reason);
          }
          const ref = planRef(row);
          const plan = yield* plans.read({ ref }).pipe(Effect.mapError(planError));
          const current = plan.tasks.find((entry) => entry.id === row.taskId);
          const title = input.title !== undefined && input.title !== current?.title;
          const description =
            input.description !== undefined && input.description !== current?.context;
          if (title || description)
            yield* applyPlan({
              commandId: input.commandId,
              ref,
              actor,
              operations: () => [
                {
                  type: "task.update",
                  id: row.taskId,
                  ...(title ? { title: input.title! } : {}),
                  ...(description ? { context: input.description! } : {}),
                },
              ],
            });
          const type = input.type !== undefined && input.type !== row.type;
          const lane = input.lane !== undefined && input.lane !== row.lane;
          const assignment =
            input.assignment !== undefined &&
            executionDigest(input.assignment) !== executionDigest(row.assignment);
          yield* store.updateBoard(row, {
            ...(type ? { type: input.type! } : {}),
            ...(lane ? { lane: input.lane! } : {}),
            ...(assignment ? { assignment: input.assignment! } : {}),
            bumpVersion: type || lane || assignment,
            at,
          });
          yield* store.refreshRoots([row.rootId]);
          const after = (yield* loadTask(row)).task;
          if (title || description || type)
            yield* store.appendActivity({ key: row, at, actor: PERSON, event: { type: "edited" } });
          if (after.derived.status !== task.derived.status)
            yield* store.appendActivity({
              key: row,
              at,
              actor: PERSON,
              event: { type: "status", from: task.derived.status, to: after.derived.status },
            });
          if (assignment)
            yield* store.appendActivity({
              key: row,
              at,
              actor: PERSON,
              event: { type: "assigned", assignee: after.assignee },
            });
          yield* command.record(row);
          yield* changes.announce({ rootIds: [row.rootId] });
          return row;
        }),
      );
      return { task: yield* summaryOf(row), replayed: false };
    },
  );

  const requireRunnable = Effect.fn("FactoryTaskService.requireRunnable")(function* (
    root: Tasks.RootView,
    task: Tasks.TaskView,
  ) {
    if (task.row.assignment.mode === "person") return yield* refuse("assignee-unresolved");
    if (task.derived.ownStatus === "done" || task.derived.ownStatus === "canceled")
      return yield* refuse("invalid-transition");
    if (pointers(root, task.blockedBy).some((blocker) => unfinished(blocker.status)))
      return yield* refuse("blocked");
  });

  const start: FactoryTaskService["Service"]["start"] = Effect.fn("FactoryTaskService.start")(
    function* (raw, actor) {
      yield* requireHuman(actor);
      const input = yield* decodeStart(raw).pipe(Effect.mapError(invalid));
      const command = yield* begin("start", input.commandId, actor, input);
      if (command.replayed) return yield* replay(input.ref);
      const { root, task } = yield* requireTask(input.ref);
      // A command that already admitted its run only has to finish recording it.
      if (!(yield* store.launched(derived(input.commandId, "admit")))) {
        if (task.row.version !== input.expectedVersion)
          return yield* new FactoryTaskError({
            reason: "version-conflict",
            currentVersion: task.row.version,
          });
        yield* requireRunnable(root, task);
        if (task.runs.some((entry) => isLiveRunState(entry.state)))
          return yield* refuse("run-active");
        if (task.derived.ownStatus !== "backlog" && task.derived.ownStatus !== "ready")
          return yield* refuse("invalid-transition");
      }
      return yield* run({
        commandId: input.commandId,
        task,
        setup: input.setup,
        profileId: yield* assignFor(task, input.setup),
        actor,
        baseCommit: null,
        record: command.record,
      });
    },
  );

  const retry: FactoryTaskService["Service"]["retry"] = Effect.fn("FactoryTaskService.retry")(
    function* (raw, actor) {
      yield* requireHuman(actor);
      const input = yield* decodeRetry(raw).pipe(Effect.mapError(invalid));
      const command = yield* begin("retry", input.commandId, actor, input);
      if (command.replayed) return yield* replay(input.ref);
      const { root, task } = yield* requireTask(input.ref);
      const work = task.runs.filter((entry) => entry.purpose === "work");
      const resumed = yield* store.launched(derived(input.commandId, "admit"));
      const previous = resumed ? work.at(-2) : work.at(-1);
      if (!resumed) {
        if (task.row.version !== input.expectedVersion)
          return yield* new FactoryTaskError({
            reason: "version-conflict",
            currentVersion: task.row.version,
          });
        if (previous === undefined) return yield* refuse("no-run");
        yield* requireRunnable(root, task);
        if (task.runs.some((entry) => isLiveRunState(entry.state)))
          return yield* refuse("run-active");
        if (previous.state !== "failed" && previous.state !== "stopped")
          return yield* refuse("invalid-transition");
      }
      const setup = input.setup ?? previous?.setup ?? work.at(-1)?.setup;
      if (setup === undefined) return yield* refuse("no-run");
      const base = previous?.baseRef ?? null;
      return yield* run({
        commandId: input.commandId,
        task,
        setup,
        profileId:
          input.setup === undefined
            ? (previous?.profileId ?? null)
            : yield* assignFor(task, input.setup),
        actor,
        // A failed Request changes run starts again from the result it was changing.
        baseCommit:
          base !== null && task.results.some((result) => result.commit === base) ? base : null,
        record: command.record,
      });
    },
  );

  const stop: FactoryTaskService["Service"]["stop"] = Effect.fn("FactoryTaskService.stop")(
    function* (raw, actor) {
      yield* requireHuman(actor);
      const input = yield* decodeStop(raw).pipe(Effect.mapError(invalid));
      const command = yield* begin("stop", input.commandId, actor, input);
      if (command.replayed) return yield* replay(input.ref);
      const { task } = yield* requireTask(input.ref);
      const live = task.runs.findLast(
        (entry) => entry.purpose === "work" && isLiveRunState(entry.state),
      );
      if (live === undefined || live.attemptId === null || live.planRevision === null)
        return yield* refuse("no-run");
      yield* executions
        .requestStop(
          {
            commandId: derived(input.commandId, "stop"),
            selection: {
              ref: planRef(task.row),
              revision: live.planRevision,
              taskId: task.row.taskId,
            },
            runId: live.runId,
            runAttemptId: live.attemptId,
          },
          actor,
        )
        .pipe(Effect.mapError(executionError));
      yield* transact(
        Effect.gen(function* () {
          yield* store.markStopRequested(live.threadId);
          yield* command.record(task.row);
        }),
      );
      yield* sync(task.row.rootId);
      return { task: yield* summaryOf(task.row), replayed: false };
    },
  );

  /** A review command names the result it saw; a newer one means the reviewer must look again. */
  const reviewed = Effect.fn("FactoryTaskService.reviewed")(function* (
    task: Tasks.TaskView,
    revision: number,
  ) {
    const latest = task.results.at(-1);
    if (latest === undefined) return yield* refuse("no-result");
    if (task.runs.some((entry) => entry.purpose === "work" && isLiveRunState(entry.state)))
      return yield* refuse("run-active");
    if (latest.revision !== revision) return yield* refuse("result-conflict");
    if (task.row.acceptedRevision === latest.revision) return yield* refuse("invalid-transition");
    return latest;
  });

  const accept: FactoryTaskService["Service"]["accept"] = Effect.fn("FactoryTaskService.accept")(
    function* (raw, actor) {
      yield* requireHuman(actor);
      const input = yield* decodeAccept(raw).pipe(Effect.mapError(invalid));
      const command = yield* begin("accept", input.commandId, actor, input);
      if (command.replayed) return yield* replay(input.ref);
      const { task } = yield* requireTask(input.ref);
      const { row } = task;
      const latest = yield* reviewed(task, input.revision);
      // The review is of the bytes the engine kept: a result that no longer matches is refused.
      yield* executions
        .readOutput({
          selection: {
            ref: planRef(row),
            revision: latest.planRevision,
            taskId: row.taskId,
          },
          resultId: latest.resultId,
        })
        .pipe(Effect.mapError(executionError));
      const at = yield* now;
      yield* transact(
        Effect.gen(function* () {
          // A Request changes may have started a run since the first check; mirror what the
          // engine admitted and check again where the acceptance is written.
          const sealed = yield* store.syncRuns(row.rootId, at);
          yield* reviewed((yield* loadTask(row)).task, input.revision);
          if (sealed.some((result) => result.taskId === row.taskId))
            return yield* refuse("result-conflict");
          yield* store.updateBoard(row, {
            acceptedRevision: latest.revision,
            bumpVersion: true,
            at,
          });
          yield* store.appendActivity({
            key: row,
            at,
            actor: PERSON,
            event: { type: "accepted", revision: latest.revision },
          });
          yield* store.refreshRoots([row.rootId]);
          yield* command.record(row);
          yield* changes.announce({ rootIds: [row.rootId] });
        }),
      );
      return { task: yield* summaryOf(row), replayed: false };
    },
  );

  const requestChanges: FactoryTaskService["Service"]["requestChanges"] = Effect.fn(
    "FactoryTaskService.requestChanges",
  )(function* (raw, actor) {
    yield* requireHuman(actor);
    const input = yield* decodeRequestChanges(raw).pipe(Effect.mapError(invalid));
    const command = yield* begin("requestChanges", input.commandId, actor, input);
    if (command.replayed) return yield* replay(input.ref);
    const { root, task } = yield* requireTask(input.ref);
    const { row } = task;
    // A failed request clears the pending note, so two in flight on one task could clear the other's.
    const pendingKey = `${row.rootId}/${row.taskId}`;
    if (requestingChanges.has(pendingKey))
      return yield* new FactoryTaskError({
        reason: "run-active",
        detail: "Changes are already being requested on this task. Try again in a moment.",
      });
    requestingChanges.add(pendingKey);
    return yield* Effect.gen(function* () {
      const resumed = yield* store.launched(derived(input.commandId, "admit"));
      if (!resumed) yield* requireRunnable(root, task);
      const latest = resumed
        ? task.results.findLast((result) => result.revision === input.revision)
        : yield* reviewed(task, input.revision);
      if (latest === undefined) return yield* refuse("no-result");
      const author =
        task.runs.find((entry) => entry.threadId === latest.threadId) ??
        task.runs.findLast((entry) => entry.purpose === "work");
      if (author === undefined) return yield* refuse("no-run");
      // Refused before the note is kept, so a request that cannot run leaves nothing behind.
      if (!resumed) yield* nextRound(row);
      const at = yield* now;
      const activityKey = `changes-requested:${input.commandId}`;
      // A sealed attempt cannot continue, so the note travels in the next attempt's input.
      yield* transact(
        Effect.gen(function* () {
          yield* store.updateBoard(row, {
            inputNote: `Changes requested on the previous result:\n${input.note}`,
            bumpVersion: false,
            at,
          });
          yield* store.appendActivity({
            key: row,
            at,
            actor: PERSON,
            event: { type: "changes-requested", revision: latest.revision, note: input.note },
            dedupeKey: activityKey,
          });
        }),
      );
      return yield* run({
        commandId: input.commandId,
        task,
        setup: author.setup,
        profileId: author.profileId,
        actor,
        // Code continues from the result under review; a document starts from the task again.
        baseCommit: latest.kind === "code" ? latest.commit : null,
        record: command.record,
      }).pipe(
        // A run that was never admitted leaves no trace for a later one; an Accept that won says so.
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (yield* store.launched(derived(input.commandId, "admit"))) return yield* error;
            yield* transact(
              Effect.gen(function* () {
                yield* store.updateBoard(row, { inputNote: null, bumpVersion: false, at });
                yield* store.retractActivity(activityKey);
              }),
            );
            if ((yield* store.acceptedRevision(row)) !== null)
              return yield* refuse("invalid-transition");
            return yield* error;
          }),
        ),
      );
    }).pipe(Effect.ensuring(Effect.sync(() => requestingChanges.delete(pendingKey))));
  });

  const reopen: FactoryTaskService["Service"]["reopen"] = Effect.fn("FactoryTaskService.reopen")(
    function* (raw, actor) {
      yield* requireHuman(actor);
      const input = yield* decodeReopen(raw).pipe(Effect.mapError(invalid));
      const command = yield* begin("reopen", input.commandId, actor, input);
      if (command.replayed) return yield* replay(input.ref);
      const { task } = yield* requireTask(input.ref);
      const { row } = task;
      if (row.acceptedRevision === null) return yield* refuse("invalid-transition");
      const at = yield* now;
      yield* transact(
        Effect.gen(function* () {
          yield* store.updateBoard(row, { acceptedRevision: null, bumpVersion: true, at });
          yield* store.appendActivity({
            key: row,
            at,
            actor: PERSON,
            event: { type: "reopened" },
          });
          yield* store.refreshRoots([row.rootId]);
          yield* command.record(row);
          yield* changes.announce({ rootIds: [row.rootId] });
        }),
      );
      return { task: yield* summaryOf(row), replayed: false };
    },
  );

  /** The accepted code result a Publish or Merge names; any other revision is refused. */
  const deliverable = Effect.fn("FactoryTaskService.deliverable")(function* (
    task: Tasks.TaskView,
    revision: number,
  ) {
    const result = task.results.find((entry) => entry.revision === revision);
    if (result === undefined) return yield* refuse("no-result");
    if (task.row.acceptedRevision === null) return yield* refuse("not-accepted");
    if (task.row.acceptedRevision !== revision) return yield* refuse("result-conflict");
    if (result.kind !== "code" || result.commit === null) return yield* refuse("not-code");
    return { ...result, commit: result.commit };
  });

  const deliver = Effect.fn("FactoryTaskService.deliver")(function* (
    kind: "publish-pr" | "merge-pr",
    raw: FactoryTaskDeliverInput,
    actor: FactoryPlanActor,
  ) {
    yield* requireHuman(actor);
    const input = yield* decodeDeliver(raw).pipe(Effect.mapError(invalid));
    const command = yield* begin(kind, input.commandId, actor, input);
    if (command.replayed) return yield* replay(input.ref);
    const { task } = yield* requireTask(input.ref);
    const { row } = task;
    const result = yield* deliverable(task, input.revision);
    let baseRef =
      task.runs.find((run) => run.purpose === "work" && run.threadId === result.threadId)
        ?.baseRef ?? null;
    let revision = result.revision;
    while (baseRef !== null) {
      const continued = task.results.findLast(
        (entry) => entry.revision < revision && entry.kind === "code" && entry.commit === baseRef,
      );
      if (continued === undefined) break;
      baseRef =
        task.runs.find((run) => run.purpose === "work" && run.threadId === continued.threadId)
          ?.baseRef ?? null;
      revision = continued.revision;
    }
    const description =
      kind === "publish-pr"
        ? ((yield* plans.read({ ref: planRef(row) }).pipe(Effect.mapError(planError))).tasks.find(
            (entry) => entry.id === row.taskId,
          )?.context ?? "")
        : "";
    yield* delivery
      .grantCommit({
        kind,
        commandId: derived(input.commandId, kind),
        originKey: taskResultOriginKey(row.rootId, row.taskId, result.revision),
        acceptanceId: `task:${row.rootId}/${row.taskId}@${result.revision}`,
        projectId: row.projectId,
        threadId: result.threadId,
        headSha: result.commit,
        baseRef,
        publish: {
          title: row.title,
          body: [description.trim(), `Task ${row.displayId} · result rev ${result.revision}`]
            .filter((part) => part !== "")
            .join("\n\n"),
          headBranch: deliveryBranch(input.ref, row.displayId, row.title, result.revision),
        },
        // Inside the grant transaction: a reopen between the click and the grant wins.
        recheck: store.acceptedRevision(row).pipe(
          Effect.mapError(
            (cause) => new FactoryDeliveryError({ reason: "persistence-failure", cause }),
          ),
          Effect.flatMap((accepted) =>
            accepted === result.revision
              ? Effect.void
              : Effect.fail(new FactoryDeliveryError({ reason: "not-accepted" })),
          ),
        ),
      })
      .pipe(Effect.mapError(deliveryRefusal));
    yield* transact(
      Effect.gen(function* () {
        yield* store.refreshRoots([row.rootId]);
        yield* command.record(row);
        yield* changes.announce({ rootIds: [row.rootId] });
      }),
    );
    return { task: yield* summaryOf(row), replayed: false };
  });

  const publish: FactoryTaskService["Service"]["publish"] = (input, actor) =>
    deliver("publish-pr", input, actor);
  const merge: FactoryTaskService["Service"]["merge"] = (input, actor) =>
    deliver("merge-pr", input, actor);

  const check: FactoryTaskService["Service"]["check"] = Effect.fn("FactoryTaskService.check")(
    function* (raw, actor) {
      yield* requireHuman(actor);
      const input = yield* decodeCheck(raw).pipe(Effect.mapError(invalid));
      const { task } = yield* requireTask(input.ref);
      const { row } = task;
      for (const result of task.results) {
        if (result.delivery?.state !== "unconfirmed" && result.pullRequest?.state !== "open")
          continue;
        const originKey = taskResultOriginKey(row.rootId, row.taskId, result.revision);
        for (const kind of ["merge-pr", "publish-pr"] as const) {
          const live = yield* deliveryStore
            .getLive(originKey, kind)
            .pipe(Effect.mapError(deliveryRefusal));
          if (
            live._tag === "Some" &&
            (live.value.status === "unknown" ||
              (kind === "publish-pr" && live.value.status === "confirmed"))
          )
            yield* delivery
              .reconcile({ projectId: row.projectId, intentId: live.value.id })
              .pipe(Effect.mapError(deliveryRefusal));
          if (kind === "merge-pr" && live._tag === "Some") break;
        }
      }
      yield* followDeliveries(row);
      return { task: yield* summaryOf(row), replayed: false };
    },
  );

  /**
   * Mirrors what the delivery store settled for one task: the index, and one activity entry per
   * pull request opened or merged.
   */
  const followDeliveries = Effect.fn("FactoryTaskService.followDeliveries")(function* (
    key: Tasks.TaskKey,
  ) {
    const { task } = yield* loadTask(key);
    const at = yield* now;
    const entries: Array<{
      readonly id: string;
      readonly revision: number;
      readonly event: "opened" | "merged";
      readonly remote: { readonly number: number; readonly url: string };
    }> = [];
    for (const result of task.results) {
      if (result.kind !== "code") continue;
      const originKey = taskResultOriginKey(key.rootId, key.taskId, result.revision);
      for (const kind of ["publish-pr", "merge-pr"] as const) {
        const live = yield* deliveryStore
          .getLive(originKey, kind)
          .pipe(Effect.mapError(asTaskError));
        if (
          live._tag === "Some" &&
          live.value.status === "confirmed" &&
          live.value.remote !== null
        ) {
          entries.push({
            id: live.value.id,
            revision: result.revision,
            event: kind === "publish-pr" ? "opened" : "merged",
            remote: live.value.remote,
          });
          if (kind === "publish-pr" && live.value.remote.merged)
            entries.push({
              id: `${live.value.id}:merged`,
              revision: result.revision,
              event: "merged",
              remote: live.value.remote,
            });
        }
      }
    }
    yield* transact(
      Effect.gen(function* () {
        for (const entry of entries)
          yield* store.appendActivity({
            key,
            at,
            actor: PERSON,
            event: {
              type: "pull-request",
              action: entry.event,
              revision: entry.revision,
              number: entry.remote.number,
              url: entry.remote.url,
            },
            dedupeKey: `pull-request:${entry.id}`,
          });
        yield* store.refreshRoots([key.rootId]);
        yield* changes.announce({ rootIds: [key.rootId] });
      }),
    );
  });

  const readResult: FactoryTaskService["Service"]["readResult"] = Effect.fn(
    "FactoryTaskService.readResult",
  )(function* (raw) {
    const input = yield* decodeResultRead(raw).pipe(Effect.mapError(invalid));
    const { task } = yield* requireTask(input.ref);
    const latest = task.derived.result;
    const row =
      input.revision === undefined
        ? task.results.at(-1)
        : task.results.find((result) => result.revision === input.revision);
    if (row === undefined || latest === null) return yield* refuse("no-result");
    const accepted = task.row.acceptedRevision;
    const text =
      row.kind === "code"
        ? null
        : (yield* executions
            .readOutput({
              selection: {
                ref: planRef(task.row),
                revision: row.planRevision,
                taskId: task.row.taskId,
              },
              resultId: row.resultId,
            })
            .pipe(Effect.mapError(executionError))).text;
    return {
      result:
        row.revision === latest.revision
          ? latest
          : {
              kind: row.kind,
              revision: row.revision,
              summary: row.summary,
              state:
                accepted === row.revision
                  ? "accepted"
                  : accepted !== null && row.revision > accepted
                    ? "changed"
                    : "ready",
              acceptedRevision: accepted,
              runOrdinal: task.runs.find((entry) => entry.threadId === row.threadId)?.ordinal ?? 1,
              threadId: row.threadId,
              observedAt: row.observedAt,
              pullRequest: row.pullRequest,
              delivery: row.delivery,
            },
      text,
      files: row.files,
      filesOmitted: row.filesOmitted,
    };
  });

  const comment: FactoryTaskService["Service"]["comment"] = Effect.fn("FactoryTaskService.comment")(
    function* (raw, actor) {
      yield* requireHuman(actor);
      const input = yield* decodeComment(raw).pipe(Effect.mapError(invalid));
      const command = yield* begin("comment", input.commandId, actor, input);
      if (command.replayed) {
        const entry = yield* store.readActivity(Number(command.outcome));
        if (entry === null) return yield* refuse("persistence-failure");
        return { entry, replayed: true };
      }
      const { task } = yield* requireTask(input.ref);
      const at = yield* now;
      const entry = yield* transact(
        Effect.gen(function* () {
          const appended = yield* store.appendActivity({
            key: task.row,
            at,
            actor: PERSON,
            event: { type: "comment", body: input.body },
          });
          if (appended === null) return yield* refuse("persistence-failure");
          yield* command.record(Number(appended.id));
          yield* changes.announce({ rootIds: [task.row.rootId] });
          return appended;
        }),
      );
      return { entry, replayed: false };
    },
  );

  const activity: FactoryTaskService["Service"]["activity"] = Effect.fn(
    "FactoryTaskService.activity",
  )(function* (raw) {
    const input = yield* decodeActivity(raw).pipe(Effect.mapError(invalid));
    const { task } = yield* requireTask(input.ref);
    const limit = input.limit ?? 50;
    const newest = input.order === "newest";
    const scope = executionDigest([
      newest ? "factory-task-activity/newest/1" : "factory-task-activity/1",
      task.row.rootId,
      task.row.taskId,
    ]);
    const position = input.cursor === undefined ? null : yield* decodeCursor(input.cursor, scope);
    const rows = yield* store.pageActivity({
      key: task.row,
      afterSeq: position?.seq ?? (newest ? Number.MAX_SAFE_INTEGER : 0),
      limit: limit + 1,
      ...(newest ? { order: "newest" } : {}),
    });
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      entries: selected.map((row) => row.entry),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor({ scope, seq: last.seq }) : null,
      fetchedAt: yield* now,
    };
  });

  const findByThread: FactoryTaskService["Service"]["findByThread"] = Effect.fn(
    "FactoryTaskService.findByThread",
  )(function* (raw) {
    const input = yield* decodeByThread(raw).pipe(Effect.mapError(invalid));
    const key = yield* store.taskOfThread(input.threadId);
    if (key === null) return { task: null };
    const root = (yield* store.loadRoots([key.rootId])).get(key.rootId);
    const view = root?.tasks.get(key.taskId);
    return { task: root === undefined || view === undefined ? null : summarize(root, view) };
  });

  const resolve: FactoryTaskService["Service"]["resolveAssignee"] = Effect.fn(
    "FactoryTaskService.resolveAssignee",
  )(function* (input) {
    if ((yield* store.projectWorkspace(input.projectId)) === null)
      return yield* refuse("missing-project");
    const ancestors: FactoryTaskAssignment[] = [];
    if (input.parent !== undefined) {
      if (input.parent.projectId !== input.projectId) return yield* refuse("invalid-input");
      const { root, task } = yield* requireTask(input.parent);
      let ancestor: Tasks.TaskView | undefined = task;
      while (ancestor !== undefined) {
        ancestors.push(ancestor.row.assignment);
        ancestor =
          ancestor.row.parentId === null ? undefined : root.tasks.get(ancestor.row.parentId);
      }
    }
    return resolveAssignee(input.assignment, {
      type: input.type,
      ancestors,
      ...(yield* store.assigneeDefaults(input.projectId)),
    });
  });

  const recordPlanningRun: FactoryTaskService["Service"]["recordPlanningRun"] = Effect.fn(
    "FactoryTaskService.recordPlanningRun",
  )(function* (input) {
    const { task } = yield* requireTask(input.ref);
    const at = yield* now;
    yield* transact(
      Effect.gen(function* () {
        yield* store.recordPlanningRun({
          key: task.row,
          threadId: input.threadId,
          runId: input.runId,
          setup: input.setup,
          at,
        });
        yield* store.refreshRoots([task.row.rootId]);
        yield* changes.announce({ rootIds: [task.row.rootId] });
      }),
    );
  });

  const recordProposal: FactoryTaskService["Service"]["recordProposal"] = Effect.fn(
    "FactoryTaskService.recordProposal",
  )(function* (input) {
    const { task } = yield* requireTask(input.ref);
    const at = yield* now;
    const author = yield* actorOf(input.actor);
    yield* transact(
      Effect.gen(function* () {
        const changed = yield* store.recordProposal({
          key: task.row,
          proposalId: input.proposalId,
          itemCount: input.itemCount,
          status: input.status,
          at,
        });
        if (!changed) return;
        if (input.status !== "dismissed" && input.itemCount > 0)
          yield* store.appendActivity({
            key: task.row,
            at,
            actor: author,
            event: {
              type: input.status === "proposed" ? "plan-proposed" : "plan-approved",
              count: input.itemCount,
            },
            dedupeKey: `plan-${input.status}:${input.proposalId}`,
          });
        yield* store.refreshRoots([task.row.rootId]);
        yield* changes.announce({ rootIds: [task.row.rootId] });
      }),
    );
  });

  const refreshEverything = transact(
    Effect.gen(function* () {
      yield* store.refreshAll;
      yield* changes.announce({ rootIds: [], profiles: true });
    }),
  );
  // Settings that fail to decode answer with defaults, which are not the person's choice: the last
  // mirror stays, as it does when the read fails. Each change reads the file's current state, since
  // a queued value may come from a broken file that has been fixed since.
  const mirrorDefaults = Effect.fn("FactoryTaskService.mirrorDefaults")(function* () {
    const current = yield* settings.decodedSettings ?? Effect.asSome(settings.getSettings);
    if (Option.isNone(current)) return false;
    return yield* transact(store.setEnvironmentDefaults(taskDefaultsOf(current.value)));
  });
  const mirrorEnvironmentDefault = Effect.fn("FactoryTaskService.mirrorEnvironmentDefault")(
    function* () {
      if (yield* mirrorDefaults()) yield* refreshEverything;
    },
  );

  const onEvent = Effect.fn("FactoryTaskService.onEvent")(function* (
    stored: ApplicationStoredEvent,
  ) {
    if ("event" in stored) {
      const key = yield* store.taskOfThread(stored.event.threadId);
      if (key !== null) yield* sync(key.rootId);
      return;
    }
    // The plan store queued the notice with the revision; it only has to be delivered.
    if (stored.type === "project.factory-plan-revised") return yield* changes.flush;
    if (stored.type === "project.factory-execution-updated")
      return yield* sync(stored.payload.ref.rootId);
    yield* refreshEverything;
  });
  const relevant = (stored: ApplicationStoredEvent) =>
    "event" in stored
      ? stored.event.type === "run.created" ||
        stored.event.type === "run.updated" ||
        // A run can outlive its agent's session; that ending raises `lost`.
        (stored.event.type === "provider-session.updated" &&
          (stored.event.payload.status === "stopped" || stored.event.payload.status === "error"))
      : stored.type === "project.factory-plan-revised" ||
        stored.type === "project.factory-execution-updated" ||
        (stored.type === "project.meta-updated" &&
          stored.payload.defaultModelSelection !== undefined);
  const quietly = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Task index could not follow a change").pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
    );

  const settingsChanges = yield* settings.subscribeChanges;
  yield* quietly(mirrorDefaults());
  // Read here, not in the fiber: nothing committed after this layer is built may be missed.
  let resumeFrom: number | null = yield* events.latestApplicationSequence.pipe(Effect.orDie);
  const follow = Effect.gen(function* () {
    const afterSequence = resumeFrom ?? (yield* events.latestApplicationSequence);
    resumeFrom = null;
    // What a previous process, or a stream that fell behind, left unmirrored.
    for (const rootId of yield* store.unsyncedRoots) yield* quietly(sync(rootId));
    yield* transact(store.refreshAll);
    yield* events
      .streamProjectedApplicationEvents({
        afterSequence,
        project: (stored) => stored,
        filter: relevant,
      })
      .pipe(Stream.runForEach((stored) => quietly(onEvent(stored))));
  });
  // The event stream ends when its reader falls too far behind. Start over rather than go deaf.
  yield* follow.pipe(
    quietly,
    Effect.andThen(Effect.sleep("5 seconds")),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* executionStore.settlements.pipe(
    Stream.runForEach((attemptId) =>
      quietly(
        Effect.gen(function* () {
          const rootId = yield* store.rootOfAttempt(attemptId);
          if (rootId !== null) yield* sync(rootId);
        }),
      ),
    ),
    Effect.forkScoped,
  );
  yield* deliveryStore.changes.pipe(
    Stream.runForEach((originKey) => {
      const task = parseTaskResultOriginKey(originKey);
      return task === null ? Effect.void : quietly(followDeliveries(task));
    }),
    Effect.forkScoped,
  );
  yield* settingsChanges.pipe(
    Stream.runForEach(() => quietly(mirrorEnvironmentDefault())),
    Effect.forkScoped,
  );

  return FactoryTaskService.of({
    list,
    count,
    listAssignees,
    read,
    create,
    update,
    start,
    stop,
    retry,
    accept,
    requestChanges,
    reopen,
    publish,
    merge,
    check,
    readResult,
    comment,
    activity,
    findByThread,
    changes: changes.stream,
    resolveAssignee: resolve,
    createSubtasks,
    recordPlanningRun,
    recordProposal,
  });
});

export const layer = Layer.effect(FactoryTaskService, make).pipe(
  Layer.provide(Layer.mergeAll(Changes.layer, Tasks.layer, ExecutionStore.layer)),
);
