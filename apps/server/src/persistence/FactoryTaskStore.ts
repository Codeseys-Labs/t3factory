import {
  FactoryAgentProfile,
  FactoryAgentSetup,
  FactoryExecutionBinding,
  FactoryExecutionOutput,
  FactoryTaskActivityEntry,
  FactoryTaskActivityEvent,
  FactoryTaskAssignment,
  FactoryTaskError,
  FactoryTaskSource,
  FactoryTaskType,
  ModelSelection,
  type CommandId,
  type FactoryPlanSnapshot,
  type FactoryTaskAssignee,
  type FactoryTaskCountInput,
  type FactoryTaskDelivery,
  type FactoryTaskLane,
  type FactoryTaskPullRequest,
  type FactoryTaskRun,
  type FactoryTaskStatus,
  type ProjectId,
  type RunAttemptId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { resolveAssignee, setupKey } from "../factory/FactoryTaskAssignee.ts";
import {
  deliveryState,
  deriveTree,
  isLiveRunState,
  planningRunState,
  workRunState,
  type DerivedTask,
  type TaskDeliveryFact,
} from "../factory/FactoryTaskDerivation.ts";
import { taskResultOriginKey } from "../factory/FactoryOriginKey.ts";
import { canonicalExecutionJson } from "../factory/FactoryExecutionDigest.ts";

export const LOCAL_TASK_SOURCE: FactoryTaskSource = {
  kind: "local",
  label: "Local",
  url: null,
  key: null,
  workRef: null,
};

export type TaskActor = FactoryTaskActivityEntry["actor"];
const SYSTEM_ACTOR: TaskActor = { kind: "system", label: "T3 Factory" };

export interface TaskKey {
  readonly rootId: string;
  readonly taskId: string;
}

export interface TaskRow extends TaskKey {
  readonly projectId: ProjectId;
  readonly parentId: string | null;
  readonly displayId: string;
  readonly title: string;
  readonly retired: boolean;
  readonly type: FactoryTaskType;
  readonly lane: FactoryTaskLane;
  readonly assignment: FactoryTaskAssignment;
  readonly source: FactoryTaskSource;
  readonly acceptedRevision: number | null;
  readonly status: FactoryTaskStatus;
  /** Indexed: the task, or one of its sub-tasks, waits on a person or has a live run. */
  readonly needsAttention: boolean;
  readonly assigneeKey: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskResultRow {
  readonly revision: number;
  readonly resultId: string;
  readonly threadId: ThreadId;
  readonly planRevision: number;
  readonly kind: "document" | "code";
  readonly summary: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly filesOmitted: number;
  readonly commit: string | null;
  readonly observedAt: string;
  readonly pullRequest: FactoryTaskPullRequest | null;
  readonly delivery: FactoryTaskDelivery | null;
}

export interface TaskRunRow extends FactoryTaskRun {
  readonly attemptId: RunAttemptId | null;
  readonly profileId: string | null;
  /** Plan revision the run was admitted under. Null for a planning run. */
  readonly planRevision: number | null;
  /** Commit the run's worktree started from. Null for a planning run or one in the project root. */
  readonly baseRef: string | null;
}

export interface TaskView {
  readonly row: TaskRow;
  readonly derived: DerivedTask;
  readonly assignee: FactoryTaskAssignee;
  /** Oldest first. */
  readonly runs: ReadonlyArray<TaskRunRow>;
  /** Oldest first. */
  readonly results: ReadonlyArray<TaskResultRow>;
  readonly blockedBy: ReadonlyArray<string>;
  readonly blocks: ReadonlyArray<string>;
  /** Direct sub-tasks in creation order. */
  readonly subtasks: ReadonlyArray<string>;
}

export interface RootView {
  readonly rootId: string;
  readonly projectId: ProjectId;
  readonly tasks: ReadonlyMap<string, TaskView>;
}

export type TaskFilter = FactoryTaskCountInput;

export interface TaskPageCursor {
  readonly updatedAt: string;
  readonly rootId: string;
  readonly taskId: string;
}

export interface BoardPatch {
  readonly type?: FactoryTaskType;
  readonly lane?: FactoryTaskLane;
  readonly assignment?: FactoryTaskAssignment;
  readonly source?: FactoryTaskSource;
  readonly acceptedRevision?: number | null;
  readonly inputNote?: string | null;
  readonly bumpVersion: boolean;
  readonly at: string;
}

export interface PendingResult {
  readonly rootId: string;
  readonly taskId: string;
  readonly output: FactoryExecutionOutput;
  readonly threadId: ThreadId;
  /** Commit the result is compared with. Null when the run worked in the project root. */
  readonly baseRef: string | null;
  readonly repositoryPath: string | null;
}

export interface EngineAttempt {
  readonly version: number;
  readonly runId: RunId;
  readonly runAttemptId: RunAttemptId;
  readonly quiescent: boolean;
  readonly nativeStatus: string | null;
  readonly latestResultId: string | null;
  readonly latestStatus: "sealed" | "failed" | "held" | null;
}

export class FactoryTaskStore extends Context.Service<
  FactoryTaskStore,
  {
    /** Mirrors a committed plan revision into board rows. Runs inside the plan's transaction. */
    readonly projectPlan: (plan: FactoryPlanSnapshot) => Effect.Effect<void, FactoryTaskError>;
    readonly refreshRoots: (
      rootIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, FactoryTaskError>;
    readonly refreshAll: Effect.Effect<void, FactoryTaskError>;
    readonly loadRoots: (
      rootIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, RootView>, FactoryTaskError>;
    readonly page: (input: {
      readonly filter: TaskFilter;
      readonly after: TaskPageCursor | null;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<TaskPageCursor>, FactoryTaskError>;
    readonly count: (
      filter: TaskFilter,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly status: FactoryTaskStatus; readonly count: number }>,
      FactoryTaskError
    >;
    readonly locate: (displayId: string) => Effect.Effect<TaskKey | null, FactoryTaskError>;
    /** The accepted result revision as stored now; read inside a caller's transaction. */
    readonly acceptedRevision: (key: TaskKey) => Effect.Effect<number | null, FactoryTaskError>;
    readonly taskOfThread: (threadId: ThreadId) => Effect.Effect<TaskKey | null, FactoryTaskError>;
    readonly rootOfAttempt: (
      attemptId: RunAttemptId,
    ) => Effect.Effect<string | null, FactoryTaskError>;
    readonly projectWorkspace: (
      projectId: ProjectId,
    ) => Effect.Effect<string | null, FactoryTaskError>;
    readonly updateBoard: (
      key: TaskKey,
      patch: BoardPatch,
    ) => Effect.Effect<void, FactoryTaskError>;
    readonly appendActivity: (input: {
      readonly key: TaskKey;
      readonly at: string;
      readonly actor: TaskActor;
      readonly event: FactoryTaskActivityEvent;
      readonly dedupeKey?: string;
    }) => Effect.Effect<FactoryTaskActivityEntry | null, FactoryTaskError>;
    readonly pageActivity: (input: {
      readonly key: TaskKey;
      readonly afterSeq: number;
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly seq: number; readonly entry: FactoryTaskActivityEntry }>,
      FactoryTaskError
    >;
    readonly readActivity: (
      seq: number,
    ) => Effect.Effect<FactoryTaskActivityEntry | null, FactoryTaskError>;
    readonly receipt: (
      commandId: CommandId,
    ) => Effect.Effect<
      { readonly kind: string; readonly digest: string; readonly outcome: unknown } | null,
      FactoryTaskError
    >;
    readonly recordReceipt: (input: {
      readonly commandId: CommandId;
      readonly kind: string;
      readonly digest: string;
      readonly outcome: unknown;
    }) => Effect.Effect<void, FactoryTaskError>;
    readonly registerLaunch: (input: {
      readonly commandId: CommandId;
      readonly profileId: string | null;
      readonly actor: TaskActor;
    }) => Effect.Effect<void, FactoryTaskError>;
    readonly launched: (commandId: CommandId) => Effect.Effect<boolean, FactoryTaskError>;
    readonly markStopRequested: (threadId: ThreadId) => Effect.Effect<void, FactoryTaskError>;
    readonly recordPlanningRun: (input: {
      readonly key: TaskKey;
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly setup: FactoryAgentSetup;
      readonly at: string;
    }) => Effect.Effect<void, FactoryTaskError>;
    readonly recordProposal: (input: {
      readonly key: TaskKey;
      readonly proposalId: string;
      readonly itemCount: number;
      readonly status: "proposed" | "approved" | "dismissed";
      readonly at: string;
    }) => Effect.Effect<boolean, FactoryTaskError>;
    /** Mirrors new runs and closes finished ones. Returns the sealed results not recorded yet. */
    readonly syncRuns: (
      rootId: string,
      now: string,
    ) => Effect.Effect<ReadonlyArray<PendingResult>, FactoryTaskError>;
    readonly recordResult: (input: {
      readonly pending: PendingResult;
      readonly kind: "document" | "code";
      readonly summary: string;
      readonly files: TaskResultRow["files"];
      readonly filesOmitted: number;
    }) => Effect.Effect<void, FactoryTaskError>;
    /** Top-level tasks whose runs or results the last process may not have mirrored. */
    readonly unsyncedRoots: Effect.Effect<ReadonlyArray<string>, FactoryTaskError>;
    readonly engineAttempt: (input: {
      readonly rootId: string;
      readonly revision: number;
      readonly taskId: string;
    }) => Effect.Effect<EngineAttempt | null, FactoryTaskError>;
    /** The other tasks still running under this plan revision, as they were admitted. */
    readonly liveAttempts: (input: {
      readonly rootId: string;
      readonly revision: number;
      readonly exceptTaskId: string;
    }) => Effect.Effect<
      ReadonlyArray<Pick<FactoryExecutionBinding, "spec" | "runAttemptId">>,
      FactoryTaskError
    >;
    /**
     * Queues a change notice in the current transaction. It is delivered only if that
     * transaction commits, so a caller's rollback also takes back the notice.
     */
    readonly announce: (change: {
      readonly rootIds: ReadonlyArray<string>;
      readonly profiles?: boolean;
    }) => Effect.Effect<void, FactoryTaskError>;
    readonly takeAnnouncements: Effect.Effect<
      { readonly rootIds: ReadonlyArray<string>; readonly profiles: boolean },
      FactoryTaskError
    >;
    readonly grantVersion: (rootId: string) => Effect.Effect<number, FactoryTaskError>;
    /** How activity names the agent working in a run's thread. */
    readonly threadActor: (threadId: ThreadId) => Effect.Effect<TaskActor, FactoryTaskError>;
    /** What `auto` can fall back to for a task of this project. */
    readonly assigneeDefaults: (projectId: ProjectId) => Effect.Effect<
      {
        readonly profiles: ReadonlyArray<FactoryAgentProfile>;
        readonly projectDefault: ModelSelection | null;
        readonly environmentDefault: ModelSelection | null;
      },
      FactoryTaskError
    >;
    readonly listProfiles: Effect.Effect<ReadonlyArray<FactoryAgentProfile>, FactoryTaskError>;
    readonly profileUsage: (
      since: string,
    ) => Effect.Effect<ReadonlyMap<string, number>, FactoryTaskError>;
    /** Fails `name-taken` when another profile holds the name. */
    readonly putProfile: (profile: FactoryAgentProfile) => Effect.Effect<void, FactoryTaskError>;
    readonly deleteProfile: (id: string) => Effect.Effect<void, FactoryTaskError>;
    readonly setEnvironmentDefault: (
      model: ModelSelection | null,
    ) => Effect.Effect<boolean, FactoryTaskError>;
  }
>()("t3/persistence/FactoryTaskStore") {}

const isTaskError = Schema.is(FactoryTaskError);
const failure = (cause: unknown) =>
  isTaskError(cause) ? cause : new FactoryTaskError({ reason: "persistence-failure", cause });

const AssignmentJson = Schema.fromJsonString(FactoryTaskAssignment);
const SourceJson = Schema.fromJsonString(FactoryTaskSource);
const SetupJson = Schema.fromJsonString(FactoryAgentSetup);
const ModelJson = Schema.fromJsonString(ModelSelection);
const ActorJson = Schema.fromJsonString(FactoryTaskActivityEntry.fields.actor);
const EventJson = Schema.fromJsonString(FactoryTaskActivityEvent);
const HandlesJson = Schema.fromJsonString(Schema.Array(FactoryTaskType));
const FilesJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ path: Schema.String, additions: Schema.Number, deletions: Schema.Number }),
  ),
);
const decodeAssignment = Schema.decodeUnknownEffect(AssignmentJson);
const encodeAssignment = Schema.encodeEffect(AssignmentJson);
const decodeSource = Schema.decodeUnknownEffect(SourceJson);
const encodeSource = Schema.encodeEffect(SourceJson);
const decodeSetup = Schema.decodeUnknownEffect(SetupJson);
const encodeSetup = Schema.encodeEffect(SetupJson);
const decodeModel = Schema.decodeUnknownEffect(ModelJson);
const encodeModel = Schema.encodeEffect(ModelJson);
const decodeActor = Schema.decodeUnknownEffect(ActorJson);
const encodeActor = Schema.encodeEffect(ActorJson);
const decodeEvent = Schema.decodeUnknownEffect(EventJson);
const encodeEvent = Schema.encodeEffect(EventJson);
const decodeHandles = Schema.decodeUnknownEffect(HandlesJson);
const encodeHandles = Schema.encodeEffect(HandlesJson);
const decodeFiles = Schema.decodeUnknownEffect(FilesJson);
const encodeFiles = Schema.encodeEffect(FilesJson);
const RemoteJson = Schema.NullOr(
  Schema.fromJsonString(
    Schema.Struct({
      number: Schema.Number,
      url: Schema.String,
      merged: Schema.optional(Schema.Literal(true)),
    }),
  ),
);
const RepositoryJson = Schema.fromJsonString(
  Schema.Struct({ host: Schema.String, repository: Schema.String }),
);
const decodeRemote = Schema.decodeUnknownEffect(RemoteJson);
const decodeRepository = Schema.decodeUnknownEffect(RepositoryJson);
const OutcomeJson = Schema.fromJsonString(Schema.Unknown);
const decodeOutcome = Schema.decodeUnknownEffect(OutcomeJson);
const encodeOutcome = Schema.encodeEffect(OutcomeJson);
const decodeBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionBinding));
const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionOutput));

const ROOT_CHUNK = 64;
const ALL_STATUSES: ReadonlyArray<FactoryTaskStatus> = [
  "backlog",
  "ready",
  "in-progress",
  "in-review",
  "done",
  "canceled",
];

interface TaskRecord {
  rootId: string;
  taskId: string;
  projectId: ProjectId;
  parentId: string | null;
  displayId: string;
  title: string;
  planOrder: number;
  retired: number;
  type: FactoryTaskType;
  lane: FactoryTaskLane;
  assignment: string;
  source: string;
  acceptedRevision: number | null;
  status: FactoryTaskStatus;
  needsAttention: number;
  assigneeKey: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface RunRecord {
  threadId: ThreadId;
  rootId: string;
  taskId: string;
  ordinal: number;
  purpose: "work" | "planning";
  runId: RunId;
  attemptId: RunAttemptId | null;
  setup: string;
  profileId: string | null;
  startedAt: string;
  stopRequested: number;
  endedAt: string | null;
  planRevision: number | null;
  baseRef: string | null;
  quiescent: number | null;
  engineStop: number | null;
  nativeStatus: string | null;
  nativeCompletedAt: string | null;
  outputStatus: "sealed" | "failed" | "held" | null;
  effectsPending: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const activeProject = sql`EXISTS (SELECT 1 FROM projection_projects p WHERE p.project_id = t.project_id AND p.deleted_at IS NULL)`;
  const oneOf = (column: string, values: ReadonlyArray<string>) =>
    values.length === 0 ? sql`1 = 0` : sql`${sql.literal(column)} IN ${sql.in(values)}`;
  const filterClauses = (filter: TaskFilter, statuses: ReadonlyArray<FactoryTaskStatus> | null) => {
    const text = filter.text?.trim() ?? "";
    const pattern = `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    return [
      sql`t.retired = 0`,
      activeProject,
      ...(filter.scope === "all" ? [] : [sql`t.parent_id IS NULL`]),
      ...(filter.attention === true ? [sql`t.needs_attention = 1`] : []),
      ...(statuses === null ? [] : [oneOf("t.status", statuses)]),
      ...(filter.projectIds === undefined ? [] : [oneOf("t.project_id", filter.projectIds)]),
      ...(filter.types === undefined ? [] : [oneOf("t.type", filter.types)]),
      ...(filter.sourceKinds === undefined ? [] : [oneOf("t.source_kind", filter.sourceKinds)]),
      ...(filter.assigneeKeys === undefined ? [] : [oneOf("t.assignee_key", filter.assigneeKeys)]),
      ...(text === ""
        ? []
        : [sql`(t.title LIKE ${pattern} ESCAPE '\\' OR t.display_id LIKE ${pattern} ESCAPE '\\')`]),
    ];
  };

  const page: FactoryTaskStore["Service"]["page"] = Effect.fn("FactoryTaskStore.page")(function* (
    input,
  ) {
    const after = input.after;
    return yield* sql<TaskPageCursor>`SELECT t.updated_at AS updatedAt, t.root_id AS rootId, t.task_id AS taskId FROM factory_tasks t WHERE ${sql.and(
      [
        // Canceled tasks stay off the board unless they are asked for.
        ...filterClauses(
          input.filter,
          input.filter.statuses ?? ALL_STATUSES.filter((status) => status !== "canceled"),
        ),
        ...(after === null
          ? []
          : [
              sql`(t.updated_at < ${after.updatedAt} OR (t.updated_at = ${after.updatedAt} AND (t.root_id < ${after.rootId} OR (t.root_id = ${after.rootId} AND t.task_id < ${after.taskId}))))`,
            ]),
      ],
    )} ORDER BY t.updated_at DESC, t.root_id DESC, t.task_id DESC LIMIT ${input.limit}`;
  }, Effect.mapError(failure));

  const count: FactoryTaskStore["Service"]["count"] = Effect.fn("FactoryTaskStore.count")(
    function* (filter) {
      const rows = yield* sql<{
        status: FactoryTaskStatus;
        count: number;
      }>`SELECT t.status AS status, count(*) AS count FROM factory_tasks t WHERE ${sql.and(
        filterClauses(filter, filter.statuses ?? null),
      )} GROUP BY t.status`;
      return ALL_STATUSES.map((status) => ({
        status,
        count: rows.find((row) => row.status === status)?.count ?? 0,
      }));
    },
    Effect.mapError(failure),
  );

  const profiles = Effect.fn("FactoryTaskStore.listProfiles")(function* () {
    const rows = yield* sql<{
      id: string;
      name: string;
      setup: string;
      handles: string;
      version: number;
      createdAt: string;
      updatedAt: string;
    }>`SELECT profile_id AS id, name, setup_json AS setup, handles_json AS handles, version, created_at AS createdAt, updated_at AS updatedAt FROM factory_agent_profiles ORDER BY created_at, profile_id`;
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        return {
          ...row,
          setup: yield* decodeSetup(row.setup),
          handles: yield* decodeHandles(row.handles),
        } satisfies FactoryAgentProfile;
      }),
    );
  }, Effect.mapError(failure));

  const modelOrNull = (json: string | null | undefined) =>
    json === null || json === undefined || json === "null"
      ? Effect.succeed(null)
      : decodeModel(json).pipe(Effect.orElseSucceed(() => null));

  const defaults = Effect.fn("FactoryTaskStore.defaults")(function* (
    projectIds: ReadonlyArray<ProjectId>,
  ) {
    const projectRows = yield* sql<{
      projectId: ProjectId;
      model: string | null;
    }>`SELECT project_id AS projectId, default_model_selection_json AS model FROM projection_projects WHERE project_id IN ${sql.in(projectIds)}`;
    const projectDefaults = new Map<string, ModelSelection | null>();
    for (const row of projectRows)
      projectDefaults.set(row.projectId, yield* modelOrNull(row.model));
    const environmentRows = yield* sql<{
      model: string | null;
    }>`SELECT environment_model_json AS model FROM factory_task_defaults WHERE id = 1`;
    return {
      projectDefaults,
      environmentDefault: yield* modelOrNull(environmentRows[0]?.model),
      profiles: yield* profiles(),
    };
  }, Effect.mapError(failure));

  const loadChunk = Effect.fn("FactoryTaskStore.loadChunk")(function* (
    rootIds: ReadonlyArray<string>,
  ) {
    const views = new Map<string, RootView>();
    if (rootIds.length === 0) return views;
    const records =
      yield* sql<TaskRecord>`SELECT root_id AS rootId, task_id AS taskId, project_id AS projectId, parent_id AS parentId, display_id AS displayId, title, plan_order AS planOrder, retired, type, lane, assignment_json AS assignment, source_json AS source, accepted_revision AS acceptedRevision, status, needs_attention AS needsAttention, assignee_key AS assigneeKey, version, created_at AS createdAt, updated_at AS updatedAt FROM factory_tasks WHERE root_id IN ${sql.in(rootIds)} ORDER BY root_id, plan_order`;
    if (records.length === 0) return views;
    const runRecords =
      yield* sql<RunRecord>`SELECT r.thread_id AS threadId, r.root_id AS rootId, r.task_id AS taskId, r.ordinal, r.purpose, r.run_id AS runId, r.attempt_id AS attemptId, r.setup_json AS setup, r.profile_id AS profileId, r.started_at AS startedAt, r.stop_requested AS stopRequested, r.ended_at AS endedAt, b.revision AS planRevision, json_extract(b.binding_json, '$.spec.workspaceStrategy.baseRef') AS baseRef, b.quiescent, b.stop_requested AS engineStop, json_extract(n.payload_json, '$.status') AS nativeStatus, n.completed_at AS nativeCompletedAt, (SELECT json_extract(o.output_json, '$.status') FROM factory_execution_results o WHERE o.attempt_id = r.attempt_id ORDER BY o.rowid DESC LIMIT 1) AS outputStatus, EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox e WHERE e.thread_id = r.thread_id AND e.status IN ('pending', 'running')) AS effectsPending FROM factory_task_runs r LEFT JOIN factory_execution_bindings b ON b.attempt_id = r.attempt_id LEFT JOIN orchestration_v2_projection_runs n ON n.run_id = r.run_id WHERE r.root_id IN ${sql.in(rootIds)} ORDER BY r.root_id, r.task_id, r.ordinal`;
    const resultRecords = yield* sql<{
      rootId: string;
      taskId: string;
      revision: number;
      resultId: string;
      threadId: ThreadId;
      planRevision: number;
      kind: "document" | "code";
      summary: string;
      files: string;
      filesOmitted: number;
      commit: string | null;
      observedAt: string;
    }>`SELECT root_id AS rootId, task_id AS taskId, revision, result_id AS resultId, thread_id AS threadId, plan_revision AS planRevision, kind, summary, files_json AS files, files_omitted AS filesOmitted, commit_sha AS "commit", observed_at AS observedAt FROM factory_task_results WHERE root_id IN ${sql.in(rootIds)} ORDER BY root_id, task_id, revision`;
    // Publish and Merge of code results, which the delivery service records per result revision.
    const deliveryKeys = resultRecords
      .filter((record) => record.kind === "code")
      .map((record) => taskResultOriginKey(record.rootId, record.taskId, record.revision));
    const deliveries = new Map<string, TaskDeliveryFact[]>();
    if (deliveryKeys.length > 0)
      for (const record of yield* sql<{
        originKey: string;
        kind: TaskDeliveryFact["kind"];
        status: TaskDeliveryFact["status"];
        remote: string | null;
        repository: string;
        failure: string | null;
      }>`SELECT origin_key AS originKey, kind, status, remote_json AS remote, repository_json AS repository, failure FROM factory_delivery_intents WHERE origin_key IN ${sql.in(deliveryKeys)} ORDER BY granted_at, rowid`) {
        const repository = yield* decodeRepository(record.repository);
        const entries = deliveries.get(record.originKey) ?? [];
        entries.push({
          kind: record.kind,
          status: record.status,
          remote: yield* decodeRemote(record.remote),
          host: repository.host,
          repository: repository.repository,
          failure: record.failure,
        });
        deliveries.set(record.originKey, entries);
      }
    const blockerRecords = yield* sql<{
      rootId: string;
      taskId: string;
      blockerId: string;
    }>`SELECT root_id AS rootId, task_id AS taskId, blocker_id AS blockerId FROM factory_task_blockers WHERE root_id IN ${sql.in(rootIds)} ORDER BY root_id, task_id, blocker_id`;
    const proposalRecords = yield* sql<{
      rootId: string;
      taskId: string;
      itemCount: number;
    }>`SELECT root_id AS rootId, task_id AS taskId, item_count AS itemCount FROM factory_task_proposal_facts WHERE root_id IN ${sql.in(rootIds)} AND status = 'proposed' ORDER BY updated_at`;
    const {
      projectDefaults,
      environmentDefault,
      profiles: agentProfiles,
    } = yield* defaults([...new Set(records.map((record) => record.projectId))]);

    for (const rootId of rootIds) {
      const tasks = records.filter((record) => record.rootId === rootId);
      const root = tasks.find((record) => record.parentId === null);
      if (root === undefined) continue;
      const rows = new Map<string, TaskRow>();
      for (const record of tasks) {
        const { planOrder: _planOrder, ...fields } = record;
        rows.set(record.taskId, {
          ...fields,
          retired: record.retired === 1,
          needsAttention: record.needsAttention === 1,
          assignment: yield* decodeAssignment(record.assignment),
          source: yield* decodeSource(record.source),
        });
      }
      const live = tasks.filter((record) => record.retired === 0);
      const runsByTask = new Map<string, TaskRunRow[]>();
      for (const record of runRecords) {
        if (record.rootId !== rootId) continue;
        const { state, note } =
          record.purpose === "planning"
            ? planningRunState(record.nativeStatus)
            : workRunState({
                quiescent: record.quiescent !== 0,
                engineStop: record.engineStop === 1,
                stopByPerson: record.stopRequested === 1,
                nativeStatus: record.nativeStatus,
                outputStatus: record.outputStatus,
                effectsPending: record.effectsPending === 1,
              });
        const runs = runsByTask.get(record.taskId) ?? [];
        runs.push({
          ordinal: record.ordinal,
          threadId: record.threadId,
          runId: record.runId,
          state,
          purpose: record.purpose,
          setup: yield* decodeSetup(record.setup),
          startedAt: record.startedAt,
          endedAt: isLiveRunState(state) ? null : (record.endedAt ?? record.nativeCompletedAt),
          note,
          attemptId: record.attemptId,
          profileId: record.profileId,
          planRevision: record.planRevision,
          baseRef: record.baseRef,
        });
        runsByTask.set(record.taskId, runs);
      }
      const resultsByTask = new Map<string, TaskResultRow[]>();
      for (const record of resultRecords) {
        if (record.rootId !== rootId) continue;
        const { rootId: _rootId, taskId, files, ...fields } = record;
        const results = resultsByTask.get(taskId) ?? [];
        results.push({
          ...fields,
          files: yield* decodeFiles(files),
          ...deliveryState(
            deliveries.get(taskResultOriginKey(rootId, taskId, record.revision)) ?? [],
          ),
        });
        resultsByTask.set(taskId, results);
      }
      const derived = deriveTree(
        live.map((record) => {
          const runs = runsByTask.get(record.taskId) ?? [];
          return {
            taskId: record.taskId,
            parentId: record.parentId,
            displayId: record.displayId,
            lane: record.lane,
            runs,
            results: (resultsByTask.get(record.taskId) ?? []).map((result) => ({
              revision: result.revision,
              kind: result.kind,
              summary: result.summary,
              runOrdinal: runs.find((run) => run.threadId === result.threadId)?.ordinal ?? 1,
              threadId: result.threadId,
              observedAt: result.observedAt,
              pullRequest: result.pullRequest,
              delivery: result.delivery,
            })),
            acceptedRevision: record.acceptedRevision,
            proposalItems:
              proposalRecords.findLast(
                (proposal) => proposal.rootId === rootId && proposal.taskId === record.taskId,
              )?.itemCount ?? null,
          };
        }),
      );
      const blockers = blockerRecords.filter((record) => record.rootId === rootId);
      const taskViews = new Map<string, TaskView>();
      for (const record of live) {
        const row = rows.get(record.taskId)!;
        const ancestors: FactoryTaskAssignment[] = [];
        const seen = new Set([record.taskId]);
        let parent = record.parentId === null ? undefined : rows.get(record.parentId);
        while (parent !== undefined && !seen.has(parent.taskId)) {
          seen.add(parent.taskId);
          ancestors.push(parent.assignment);
          parent = parent.parentId === null ? undefined : rows.get(parent.parentId);
        }
        taskViews.set(record.taskId, {
          row,
          derived: derived.get(record.taskId)!,
          assignee: resolveAssignee(row.assignment, {
            type: row.type,
            ancestors,
            profiles: agentProfiles,
            projectDefault: projectDefaults.get(row.projectId) ?? null,
            environmentDefault,
          }),
          runs: runsByTask.get(record.taskId) ?? [],
          results: resultsByTask.get(record.taskId) ?? [],
          blockedBy: blockers
            .filter((entry) => entry.taskId === record.taskId)
            .map((entry) => entry.blockerId),
          blocks: blockers
            .filter((entry) => entry.blockerId === record.taskId)
            .map((entry) => entry.taskId),
          subtasks: live
            .filter((entry) => entry.parentId === record.taskId)
            .map((entry) => entry.taskId),
        });
      }
      views.set(rootId, { rootId, projectId: root.projectId, tasks: taskViews });
    }
    return views;
  }, Effect.mapError(failure));

  const loadRoots: FactoryTaskStore["Service"]["loadRoots"] = Effect.fn(
    "FactoryTaskStore.loadRoots",
  )(function* (rootIds) {
    const unique = [...new Set(rootIds)];
    const views = new Map<string, RootView>();
    for (let index = 0; index < unique.length; index += ROOT_CHUNK)
      for (const [rootId, view] of yield* loadChunk(unique.slice(index, index + ROOT_CHUNK)))
        views.set(rootId, view);
    return views;
  });

  const refreshRoots: FactoryTaskStore["Service"]["refreshRoots"] = Effect.fn(
    "FactoryTaskStore.refreshRoots",
  )(function* (rootIds) {
    for (const view of (yield* loadRoots(rootIds)).values())
      for (const task of view.tasks.values()) {
        const needsAttention =
          task.derived.attention.length > 0 || task.derived.liveRuns.length > 0;
        if (
          task.row.status === task.derived.status &&
          task.row.needsAttention === needsAttention &&
          task.row.assigneeKey === task.assignee.key
        )
          continue;
        yield* sql`UPDATE factory_tasks SET status = ${task.derived.status}, needs_attention = ${needsAttention ? 1 : 0}, assignee_key = ${task.assignee.key} WHERE root_id = ${task.row.rootId} AND task_id = ${task.row.taskId}`.pipe(
          Effect.mapError(failure),
        );
      }
  });

  const refreshAll = Effect.gen(function* () {
    const roots = yield* sql<{
      rootId: string;
    }>`SELECT root_id AS rootId FROM factory_tasks WHERE parent_id IS NULL`.pipe(
      Effect.mapError(failure),
    );
    yield* refreshRoots(roots.map((row) => row.rootId));
  }).pipe(Effect.withSpan("FactoryTaskStore.refreshAll"));

  const announce: FactoryTaskStore["Service"]["announce"] = Effect.fn("FactoryTaskStore.announce")(
    function* (change) {
      const profiles = change.profiles === true ? 1 : 0;
      const rootIds = [...new Set(change.rootIds)];
      if (rootIds.length === 0 && profiles === 1)
        yield* sql`INSERT INTO factory_task_announcements(root_id, profiles) VALUES (NULL, 1)`;
      for (const rootId of rootIds)
        yield* sql`INSERT INTO factory_task_announcements(root_id, profiles) VALUES (${rootId}, ${profiles})`;
    },
    Effect.mapError(failure),
  );

  const allocate = Effect.fn("FactoryTaskStore.allocate")(function* (
    rootId: string,
    parentId: string,
  ) {
    const rows = yield* sql<{
      number: number;
    }>`INSERT INTO factory_task_counters(root_id, parent_id, next) VALUES (${rootId}, ${parentId}, 2) ON CONFLICT(root_id, parent_id) DO UPDATE SET next = next + 1 RETURNING next - 1 AS number`;
    return rows[0]!.number;
  });

  const projectPlan: FactoryTaskStore["Service"]["projectPlan"] = Effect.fn(
    "FactoryTaskStore.projectPlan",
  )(function* (plan) {
    const rootId = plan.ref.rootId;
    const existing = yield* sql<{
      taskId: string;
      displayId: string;
      definition: string;
    }>`SELECT task_id AS taskId, display_id AS displayId, definition FROM factory_tasks WHERE root_id = ${rootId}`;
    const known = new Map(existing.map((row) => [row.taskId, row]));
    const displayIds = new Map(existing.map((row) => [row.taskId, row.displayId]));
    const blockersOf = (taskId: string) =>
      plan.edges
        .filter((edge) => !edge.retired && edge.fromTaskId === taskId)
        .map((edge) => edge.toTaskId)
        .sort();
    let pending = plan.tasks.map((task, order) => ({ task, order }));
    while (pending.length > 0) {
      const waiting: typeof pending = [];
      for (const entry of pending) {
        const { task, order } = entry;
        const definition = canonicalExecutionJson({
          title: task.title,
          context: task.context,
          parentId: task.parentId,
          retired: task.retired,
          blockers: blockersOf(task.id),
          work: plan.workContexts
            .filter((context) => context.taskId === task.id && !context.retired)
            .map((context) => context.id)
            .sort(),
        });
        const row = known.get(task.id);
        if (row !== undefined) {
          if (row.definition === definition) continue;
          // An empty definition is a row the migration made; adopting it is not an edit.
          const edited = row.definition === "" ? 0 : 1;
          yield* sql`UPDATE factory_tasks SET title = ${task.title}, parent_id = ${task.parentId}, definition = ${definition}, plan_order = ${order}, retired = ${task.retired ? 1 : 0}, version = version + ${edited}, updated_at = CASE WHEN ${edited} = 1 THEN ${plan.updatedAt} ELSE updated_at END WHERE root_id = ${rootId} AND task_id = ${task.id}`;
          continue;
        }
        const parentDisplayId = task.parentId === null ? null : displayIds.get(task.parentId);
        if (task.parentId !== null && parentDisplayId === undefined) {
          waiting.push(entry);
          continue;
        }
        const displayId =
          task.parentId === null
            ? `T-${yield* allocate("", "")}`
            : `${parentDisplayId}.${yield* allocate(rootId, task.parentId)}`;
        displayIds.set(task.id, displayId);
        yield* sql`INSERT INTO factory_tasks(root_id, task_id, project_id, parent_id, display_id, title, definition, plan_order, retired, assignment_json, source_json, created_at, updated_at) VALUES (${rootId}, ${task.id}, ${plan.ref.projectId}, ${task.parentId}, ${displayId}, ${task.title}, ${definition}, ${order}, ${task.retired ? 1 : 0}, ${yield* encodeAssignment({ mode: task.parentId === null ? "unassigned" : "auto" })}, ${yield* encodeSource(LOCAL_TASK_SOURCE)}, ${plan.updatedAt}, ${plan.updatedAt})`;
      }
      // The plan reducer guarantees every parent exists, so a round always places a task.
      if (waiting.length === pending.length) break;
      pending = waiting;
    }
    yield* sql`DELETE FROM factory_task_blockers WHERE root_id = ${rootId}`;
    for (const edge of plan.edges) {
      if (edge.retired) continue;
      yield* sql`INSERT OR IGNORE INTO factory_task_blockers(root_id, task_id, blocker_id) VALUES (${rootId}, ${edge.fromTaskId}, ${edge.toTaskId})`;
    }
    yield* refreshRoots([rootId]);
    yield* announce({ rootIds: [rootId] });
  }, Effect.mapError(failure));

  const appendActivity: FactoryTaskStore["Service"]["appendActivity"] = Effect.fn(
    "FactoryTaskStore.appendActivity",
  )(function* (input) {
    const rows = yield* sql<{
      seq: number;
    }>`INSERT INTO factory_task_activity(root_id, task_id, at, actor_json, event_json, dedupe_key) VALUES (${input.key.rootId}, ${input.key.taskId}, ${input.at}, ${yield* encodeActor(input.actor)}, ${yield* encodeEvent(input.event)}, ${input.dedupeKey ?? null}) ON CONFLICT(dedupe_key) DO NOTHING RETURNING seq`;
    if (rows[0] === undefined) return null;
    yield* sql`UPDATE factory_tasks SET updated_at = ${input.at} WHERE root_id = ${input.key.rootId} AND task_id = ${input.key.taskId} AND updated_at < ${input.at}`;
    return { id: String(rows[0].seq), at: input.at, actor: input.actor, event: input.event };
  }, Effect.mapError(failure));

  const activityEntry = Effect.fnUntraced(function* (row: {
    seq: number;
    at: string;
    actor: string;
    event: string;
  }) {
    return {
      seq: row.seq,
      entry: {
        id: String(row.seq),
        at: row.at,
        actor: yield* decodeActor(row.actor),
        event: yield* decodeEvent(row.event),
      } satisfies FactoryTaskActivityEntry,
    };
  });

  const updateBoard: FactoryTaskStore["Service"]["updateBoard"] = Effect.fn(
    "FactoryTaskStore.updateBoard",
  )(function* (key, patch) {
    const where = sql`WHERE root_id = ${key.rootId} AND task_id = ${key.taskId}`;
    if (patch.type !== undefined)
      yield* sql`UPDATE factory_tasks SET type = ${patch.type} ${where}`;
    if (patch.lane !== undefined)
      yield* sql`UPDATE factory_tasks SET lane = ${patch.lane} ${where}`;
    if (patch.assignment !== undefined)
      yield* sql`UPDATE factory_tasks SET assignment_json = ${yield* encodeAssignment(patch.assignment)} ${where}`;
    if (patch.source !== undefined)
      yield* sql`UPDATE factory_tasks SET source_kind = ${patch.source.kind}, source_json = ${yield* encodeSource(patch.source)} ${where}`;
    if (patch.acceptedRevision !== undefined)
      yield* sql`UPDATE factory_tasks SET accepted_revision = ${patch.acceptedRevision} ${where}`;
    if (patch.inputNote !== undefined)
      yield* sql`UPDATE factory_tasks SET input_note = ${patch.inputNote} ${where}`;
    yield* sql`UPDATE factory_tasks SET version = version + ${patch.bumpVersion ? 1 : 0}, updated_at = max(updated_at, ${patch.at}) ${where}`;
  }, Effect.mapError(failure));

  const agentActor = Effect.fnUntraced(function* (
    setup: FactoryAgentSetup,
    profileId: string | null,
  ) {
    const named =
      profileId === null
        ? []
        : yield* sql<{
            name: string;
          }>`SELECT name FROM factory_agent_profiles WHERE profile_id = ${profileId}`;
    return {
      kind: "agent",
      label: named[0]?.name ?? setupKey(setup).replace("/", " · "),
      ...(named[0] === undefined ? { modelSelection: setup.modelSelection } : {}),
    } satisfies TaskActor;
  });

  const nextOrdinal = Effect.fnUntraced(function* (key: TaskKey) {
    const rows = yield* sql<{
      next: number;
    }>`SELECT coalesce(max(ordinal), 0) + 1 AS next FROM factory_task_runs WHERE root_id = ${key.rootId} AND task_id = ${key.taskId}`;
    return rows[0]!.next;
  });

  const closeRuns = Effect.fn("FactoryTaskStore.closeRuns")(function* (
    rootId: string,
    now: string,
  ) {
    const view = (yield* loadRoots([rootId])).get(rootId);
    for (const task of view?.tasks.values() ?? [])
      for (const run of task.runs) {
        if (isLiveRunState(run.state)) continue;
        const closed =
          yield* sql`UPDATE factory_task_runs SET ended_at = ${run.endedAt ?? now}, outcome = ${run.state} WHERE thread_id = ${run.threadId} AND outcome IS NULL RETURNING thread_id`;
        if (closed.length === 0) continue;
        yield* appendActivity({
          key: task.row,
          at: now,
          actor: yield* agentActor(run.setup, run.profileId),
          event: {
            type: "run-ended",
            ordinal: run.ordinal,
            threadId: run.threadId,
            outcome: run.state === "completed" || run.state === "failed" ? run.state : "stopped",
            note: run.note,
          },
          dedupeKey: `run-ended:${run.threadId}`,
        });
      }
  });

  const syncRuns: FactoryTaskStore["Service"]["syncRuns"] = Effect.fn("FactoryTaskStore.syncRuns")(
    function* (rootId, now) {
      // Close before mirroring, so a retry reads as run 1 ended, then run 2 started.
      yield* closeRuns(rootId, now);
      const unmirrored = yield* sql<{
        json: string;
      }>`SELECT b.binding_json AS json FROM factory_execution_bindings b WHERE b.root_id = ${rootId} AND NOT EXISTS (SELECT 1 FROM factory_task_runs r WHERE r.thread_id = b.thread_id) AND EXISTS (SELECT 1 FROM factory_tasks t WHERE t.root_id = b.root_id AND t.task_id = b.task_id) ORDER BY json_extract(b.binding_json, '$.admittedAt'), b.rowid`;
      for (const row of unmirrored) {
        const binding = yield* decodeBinding(row.json);
        const key = { rootId, taskId: binding.selection.taskId };
        const setup: FactoryAgentSetup = {
          modelSelection: binding.spec.modelSelection,
          runtimeMode: binding.spec.runtimeMode,
          interactionMode: binding.spec.interactionMode,
          workspace: binding.spec.workspaceStrategy.type,
        };
        const launches = yield* sql<{
          profileId: string | null;
          actor: string;
        }>`SELECT profile_id AS profileId, actor_json AS actor FROM factory_task_launches WHERE command_id = ${binding.commandId}`;
        const ordinal = yield* nextOrdinal(key);
        yield* sql`INSERT INTO factory_task_runs(thread_id, root_id, task_id, ordinal, purpose, run_id, attempt_id, setup_json, profile_id, started_at) VALUES (${binding.threadId}, ${rootId}, ${key.taskId}, ${ordinal}, 'work', ${binding.runId}, ${binding.runAttemptId}, ${yield* encodeSetup(setup)}, ${launches[0]?.profileId ?? null}, ${binding.admittedAt})`;
        yield* appendActivity({
          key,
          at: binding.admittedAt,
          actor: launches[0] ? yield* decodeActor(launches[0].actor) : SYSTEM_ACTOR,
          event: { type: "run-started", ordinal, threadId: binding.threadId, setup },
          dedupeKey: `run-started:${binding.threadId}`,
        });
      }
      // A run started and finished elsewhere since the last pass is mirrored and closed at once.
      if (unmirrored.length > 0) yield* closeRuns(rootId, now);
      const sealed = yield* sql<{
        taskId: string;
        output: string;
        binding: string;
        repositoryPath: string | null;
      }>`SELECT o.task_id AS taskId, o.output_json AS output, b.binding_json AS binding, (SELECT v.repository_path FROM factory_execution_verifications v WHERE v.attempt_id = o.attempt_id AND v.digest = json_extract(o.output_json, '$.checkpoint.verificationDigest')) AS repositoryPath FROM factory_execution_results o JOIN factory_execution_bindings b ON b.attempt_id = o.attempt_id WHERE o.root_id = ${rootId} AND b.quiescent = 1 AND json_extract(o.output_json, '$.status') = 'sealed' AND NOT EXISTS (SELECT 1 FROM factory_task_results r WHERE r.attempt_id = o.attempt_id) AND EXISTS (SELECT 1 FROM factory_tasks t WHERE t.root_id = o.root_id AND t.task_id = o.task_id) ORDER BY o.rowid`;
      const pending: PendingResult[] = [];
      for (const row of sealed) {
        const binding = yield* decodeBinding(row.binding);
        if (pending.some((entry) => entry.output.runAttemptId === binding.runAttemptId)) continue;
        // A run that continued an earlier result is compared with that result's base, so each
        // revision lists the whole change a Publish would send.
        let baseRef =
          binding.spec.workspaceStrategy.type === "worktree"
            ? binding.spec.workspaceStrategy.baseRef
            : null;
        const seen = new Set<string>();
        while (baseRef !== null && !seen.has(baseRef)) {
          seen.add(baseRef);
          const earlier = yield* sql<{
            base: string | null;
          }>`SELECT json_extract(b.binding_json, '$.spec.workspaceStrategy.baseRef') AS base FROM factory_task_results r JOIN factory_execution_bindings b ON b.attempt_id = r.attempt_id WHERE r.root_id = ${rootId} AND r.task_id = ${row.taskId} AND r.commit_sha = ${baseRef} ORDER BY r.revision LIMIT 1`;
          if (earlier[0]?.base == null) break;
          baseRef = earlier[0].base;
        }
        pending.push({
          rootId,
          taskId: row.taskId,
          output: yield* decodeOutput(row.output),
          threadId: binding.threadId,
          baseRef,
          repositoryPath: row.repositoryPath,
        });
      }
      return pending;
    },
    Effect.mapError(failure),
  );

  const recordResult: FactoryTaskStore["Service"]["recordResult"] = Effect.fn(
    "FactoryTaskStore.recordResult",
  )(function* (input) {
    const { pending } = input;
    const key = { rootId: pending.rootId, taskId: pending.taskId };
    const inserted = yield* sql<{
      revision: number;
    }>`INSERT INTO factory_task_results(root_id, task_id, revision, result_id, attempt_id, thread_id, plan_revision, kind, summary, files_json, files_omitted, commit_sha, observed_at) SELECT ${key.rootId}, ${key.taskId}, coalesce(max(revision), 0) + 1, ${pending.output.resultId}, ${pending.output.runAttemptId}, ${pending.threadId}, ${pending.output.selection.revision}, ${input.kind}, ${input.summary}, ${yield* encodeFiles(input.files)}, ${input.filesOmitted}, ${pending.output.checkpoint?.commit ?? null}, ${pending.output.observedAt} FROM factory_task_results WHERE root_id = ${key.rootId} AND task_id = ${key.taskId} ON CONFLICT DO NOTHING RETURNING revision`;
    const revision = inserted[0]?.revision;
    if (revision === undefined) return;
    // The note asked for this result; the next run starts from the task alone.
    yield* sql`UPDATE factory_tasks SET input_note = NULL WHERE root_id = ${key.rootId} AND task_id = ${key.taskId}`;
    const runs = yield* sql<{
      setup: string;
      profileId: string | null;
    }>`SELECT setup_json AS setup, profile_id AS profileId FROM factory_task_runs WHERE thread_id = ${pending.threadId}`;
    yield* appendActivity({
      key,
      at: pending.output.observedAt,
      actor: runs[0]
        ? yield* agentActor(yield* decodeSetup(runs[0].setup), runs[0].profileId)
        : SYSTEM_ACTOR,
      event: { type: "result-ready", revision, summary: input.summary },
      dedupeKey: `result-ready:${pending.output.resultId}`,
    });
  }, Effect.mapError(failure));

  const putProfile: FactoryTaskStore["Service"]["putProfile"] = Effect.fn(
    "FactoryTaskStore.putProfile",
  )(function* (profile) {
    const nameKey = profile.name.trim().toLowerCase();
    const taken =
      yield* sql`SELECT profile_id FROM factory_agent_profiles WHERE name_key = ${nameKey} AND profile_id <> ${profile.id}`;
    if (taken.length > 0) return yield* new FactoryTaskError({ reason: "name-taken" });
    yield* sql`INSERT INTO factory_agent_profiles(profile_id, name, name_key, setup_json, handles_json, version, created_at, updated_at) VALUES (${profile.id}, ${profile.name}, ${nameKey}, ${yield* encodeSetup(profile.setup)}, ${yield* encodeHandles(profile.handles)}, ${profile.version}, ${profile.createdAt}, ${profile.updatedAt}) ON CONFLICT(profile_id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, setup_json = excluded.setup_json, handles_json = excluded.handles_json, version = excluded.version, updated_at = excluded.updated_at`;
  }, Effect.mapError(failure));

  return FactoryTaskStore.of({
    projectPlan,
    refreshRoots,
    refreshAll,
    loadRoots,
    page,
    count,
    locate: Effect.fn("FactoryTaskStore.locate")(function* (displayId) {
      const rows =
        yield* sql<TaskKey>`SELECT root_id AS rootId, task_id AS taskId FROM factory_tasks WHERE display_id = ${displayId} AND retired = 0`;
      return rows[0] ?? null;
    }, Effect.mapError(failure)),
    acceptedRevision: Effect.fn("FactoryTaskStore.acceptedRevision")(function* (key) {
      const rows = yield* sql<{
        acceptedRevision: number | null;
      }>`SELECT accepted_revision AS acceptedRevision FROM factory_tasks WHERE root_id = ${key.rootId} AND task_id = ${key.taskId}`;
      return rows[0]?.acceptedRevision ?? null;
    }, Effect.mapError(failure)),
    taskOfThread: Effect.fn("FactoryTaskStore.taskOfThread")(function* (threadId) {
      const rows =
        yield* sql<TaskKey>`SELECT root_id AS rootId, task_id AS taskId FROM factory_task_runs WHERE thread_id = ${threadId} UNION ALL SELECT root_id AS rootId, task_id AS taskId FROM factory_execution_bindings WHERE thread_id = ${threadId} LIMIT 1`;
      return rows[0] ?? null;
    }, Effect.mapError(failure)),
    rootOfAttempt: Effect.fn("FactoryTaskStore.rootOfAttempt")(function* (attemptId) {
      const rows = yield* sql<{
        rootId: string;
      }>`SELECT root_id AS rootId FROM factory_execution_bindings WHERE attempt_id = ${attemptId}`;
      return rows[0]?.rootId ?? null;
    }, Effect.mapError(failure)),
    projectWorkspace: Effect.fn("FactoryTaskStore.projectWorkspace")(function* (projectId) {
      const rows = yield* sql<{
        workspaceRoot: string;
      }>`SELECT workspace_root AS workspaceRoot FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`;
      return rows[0]?.workspaceRoot ?? null;
    }, Effect.mapError(failure)),
    updateBoard,
    appendActivity,
    pageActivity: Effect.fn("FactoryTaskStore.pageActivity")(function* (input) {
      const rows = yield* sql<{
        seq: number;
        at: string;
        actor: string;
        event: string;
      }>`SELECT seq, at, actor_json AS actor, event_json AS event FROM factory_task_activity WHERE root_id = ${input.key.rootId} AND task_id = ${input.key.taskId} AND seq > ${input.afterSeq} ORDER BY seq LIMIT ${input.limit}`;
      return yield* Effect.forEach(rows, activityEntry);
    }, Effect.mapError(failure)),
    readActivity: Effect.fn("FactoryTaskStore.readActivity")(function* (seq) {
      const rows = yield* sql<{
        seq: number;
        at: string;
        actor: string;
        event: string;
      }>`SELECT seq, at, actor_json AS actor, event_json AS event FROM factory_task_activity WHERE seq = ${seq}`;
      return rows[0] ? (yield* activityEntry(rows[0])).entry : null;
    }, Effect.mapError(failure)),
    receipt: Effect.fn("FactoryTaskStore.receipt")(function* (commandId) {
      const rows = yield* sql<{
        kind: string;
        digest: string;
        outcome: string;
      }>`SELECT kind, digest, outcome_json AS outcome FROM factory_task_commands WHERE command_id = ${commandId}`;
      return rows[0]
        ? {
            kind: rows[0].kind,
            digest: rows[0].digest,
            outcome: yield* decodeOutcome(rows[0].outcome),
          }
        : null;
    }, Effect.mapError(failure)),
    recordReceipt: Effect.fn("FactoryTaskStore.recordReceipt")(function* (input) {
      yield* sql`INSERT INTO factory_task_commands(command_id, kind, digest, outcome_json) VALUES (${input.commandId}, ${input.kind}, ${input.digest}, ${yield* encodeOutcome(input.outcome)})`;
    }, Effect.mapError(failure)),
    registerLaunch: Effect.fn("FactoryTaskStore.registerLaunch")(function* (input) {
      yield* sql`INSERT INTO factory_task_launches(command_id, profile_id, actor_json) VALUES (${input.commandId}, ${input.profileId}, ${yield* encodeActor(input.actor)}) ON CONFLICT(command_id) DO NOTHING`;
    }, Effect.mapError(failure)),
    launched: Effect.fn("FactoryTaskStore.launched")(function* (commandId) {
      const rows =
        yield* sql`SELECT attempt_id FROM factory_execution_bindings WHERE json_extract(binding_json, '$.commandId') = ${commandId}`;
      return rows.length > 0;
    }, Effect.mapError(failure)),
    markStopRequested: Effect.fn("FactoryTaskStore.markStopRequested")(function* (threadId) {
      yield* sql`UPDATE factory_task_runs SET stop_requested = 1 WHERE thread_id = ${threadId}`;
    }, Effect.mapError(failure)),
    recordPlanningRun: Effect.fn("FactoryTaskStore.recordPlanningRun")(function* (input) {
      const ordinal = yield* nextOrdinal(input.key);
      const inserted =
        yield* sql`INSERT INTO factory_task_runs(thread_id, root_id, task_id, ordinal, purpose, run_id, attempt_id, setup_json, profile_id, started_at) VALUES (${input.threadId}, ${input.key.rootId}, ${input.key.taskId}, ${ordinal}, 'planning', ${input.runId}, NULL, ${yield* encodeSetup(input.setup)}, NULL, ${input.at}) ON CONFLICT(thread_id) DO NOTHING RETURNING thread_id`;
      if (inserted.length === 0) return;
      yield* appendActivity({
        key: input.key,
        at: input.at,
        actor: SYSTEM_ACTOR,
        event: { type: "run-started", ordinal, threadId: input.threadId, setup: input.setup },
        dedupeKey: `run-started:${input.threadId}`,
      });
    }, Effect.mapError(failure)),
    recordProposal: Effect.fn("FactoryTaskStore.recordProposal")(function* (input) {
      const changed =
        yield* sql`INSERT INTO factory_task_proposal_facts(proposal_id, root_id, task_id, item_count, status, updated_at) VALUES (${input.proposalId}, ${input.key.rootId}, ${input.key.taskId}, ${input.itemCount}, ${input.status}, ${input.at}) ON CONFLICT(proposal_id) DO UPDATE SET item_count = excluded.item_count, status = excluded.status, updated_at = excluded.updated_at WHERE factory_task_proposal_facts.status <> excluded.status OR factory_task_proposal_facts.item_count <> excluded.item_count RETURNING proposal_id`;
      return changed.length > 0;
    }, Effect.mapError(failure)),
    syncRuns,
    recordResult,
    unsyncedRoots: Effect.gen(function* () {
      const rows = yield* sql<{
        rootId: string;
      }>`SELECT DISTINCT b.root_id AS rootId FROM factory_execution_bindings b WHERE NOT EXISTS (SELECT 1 FROM factory_task_runs r WHERE r.thread_id = b.thread_id) UNION SELECT DISTINCT r.root_id AS rootId FROM factory_task_runs r WHERE r.outcome IS NULL UNION SELECT DISTINCT o.root_id AS rootId FROM factory_execution_results o WHERE json_extract(o.output_json, '$.status') = 'sealed' AND NOT EXISTS (SELECT 1 FROM factory_task_results t WHERE t.attempt_id = o.attempt_id)`;
      return rows.map((row) => row.rootId);
    }).pipe(Effect.mapError(failure), Effect.withSpan("FactoryTaskStore.unsyncedRoots")),
    engineAttempt: Effect.fn("FactoryTaskStore.engineAttempt")(function* (input) {
      const rows = yield* sql<{
        version: number;
        runId: RunId;
        runAttemptId: RunAttemptId;
        quiescent: number;
        nativeStatus: string | null;
        latest: string | null;
      }>`SELECT t.version, b.run_id AS runId, b.attempt_id AS runAttemptId, b.quiescent, (SELECT json_extract(n.payload_json, '$.status') FROM orchestration_v2_projection_runs n WHERE n.run_id = b.run_id) AS nativeStatus, (SELECT o.output_json FROM factory_execution_results o WHERE o.attempt_id = b.attempt_id ORDER BY o.rowid DESC LIMIT 1) AS latest FROM factory_execution_tasks t JOIN factory_execution_bindings b ON b.attempt_id = t.attempt_id WHERE t.root_id = ${input.rootId} AND t.revision = ${input.revision} AND t.task_id = ${input.taskId}`;
      const row = rows[0];
      if (row === undefined) return null;
      const latest = row.latest === null ? null : yield* decodeOutput(row.latest);
      return {
        version: row.version,
        runId: row.runId,
        runAttemptId: row.runAttemptId,
        quiescent: row.quiescent === 1,
        nativeStatus: row.nativeStatus,
        latestResultId: latest?.resultId ?? null,
        latestStatus: latest?.status ?? null,
      };
    }, Effect.mapError(failure)),
    liveAttempts: Effect.fn("FactoryTaskStore.liveAttempts")(function* (input) {
      const rows = yield* sql<{
        json: string;
      }>`SELECT b.binding_json AS json FROM factory_execution_bindings b JOIN factory_execution_tasks t ON t.attempt_id = b.attempt_id WHERE b.root_id = ${input.rootId} AND b.revision = ${input.revision} AND b.quiescent = 0 AND b.task_id <> ${input.exceptTaskId}`;
      return yield* Effect.forEach(rows, (row) => decodeBinding(row.json));
    }, Effect.mapError(failure)),
    announce,
    takeAnnouncements: Effect.gen(function* () {
      const rows = yield* sql<{
        rootId: string | null;
        profiles: number;
      }>`DELETE FROM factory_task_announcements RETURNING root_id AS rootId, profiles`;
      return {
        rootIds: [...new Set(rows.flatMap((row) => (row.rootId === null ? [] : [row.rootId])))],
        profiles: rows.some((row) => row.profiles === 1),
      };
    }).pipe(Effect.mapError(failure), Effect.withSpan("FactoryTaskStore.takeAnnouncements")),
    grantVersion: Effect.fn("FactoryTaskStore.grantVersion")(function* (rootId) {
      const rows = yield* sql<{
        version: number;
      }>`SELECT coalesce(max(version), 0) AS version FROM factory_execution_grants WHERE root_id = ${rootId}`;
      return rows[0]!.version;
    }, Effect.mapError(failure)),
    threadActor: Effect.fn("FactoryTaskStore.threadActor")(function* (threadId) {
      const rows = yield* sql<{
        setup: string;
        profileId: string | null;
      }>`SELECT setup_json AS setup, profile_id AS profileId FROM factory_task_runs WHERE thread_id = ${threadId}`;
      return rows[0]
        ? yield* agentActor(yield* decodeSetup(rows[0].setup), rows[0].profileId)
        : ({ kind: "agent", label: "Agent" } satisfies TaskActor);
    }, Effect.mapError(failure)),
    assigneeDefaults: Effect.fn("FactoryTaskStore.assigneeDefaults")(function* (projectId) {
      const found = yield* defaults([projectId]);
      return {
        profiles: found.profiles,
        projectDefault: found.projectDefaults.get(projectId) ?? null,
        environmentDefault: found.environmentDefault,
      };
    }),
    listProfiles: profiles(),
    profileUsage: Effect.fn("FactoryTaskStore.profileUsage")(function* (since) {
      const rows = yield* sql<{
        profileId: string;
        tasks: number;
      }>`SELECT profile_id AS profileId, count(DISTINCT root_id || char(0) || task_id) AS tasks FROM factory_task_runs WHERE profile_id IS NOT NULL AND started_at >= ${since} GROUP BY profile_id`;
      return new Map(rows.map((row) => [row.profileId, row.tasks]));
    }, Effect.mapError(failure)),
    putProfile,
    deleteProfile: Effect.fn("FactoryTaskStore.deleteProfile")(function* (id) {
      yield* sql`DELETE FROM factory_agent_profiles WHERE profile_id = ${id}`;
    }, Effect.mapError(failure)),
    setEnvironmentDefault: Effect.fn("FactoryTaskStore.setEnvironmentDefault")(function* (model) {
      const next = model === null ? null : yield* encodeModel(model);
      const rows = yield* sql<{
        model: string | null;
      }>`SELECT environment_model_json AS model FROM factory_task_defaults WHERE id = 1`;
      if (rows.length === 1 && rows[0]!.model === next) return false;
      yield* sql`INSERT INTO factory_task_defaults(id, environment_model_json) VALUES (1, ${next}) ON CONFLICT(id) DO UPDATE SET environment_model_json = excluded.environment_model_json`;
      return rows.length === 1 || next !== null;
    }, Effect.mapError(failure)),
  });
});

export const layer = Layer.effect(FactoryTaskStore, make);
