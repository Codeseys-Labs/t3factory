import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const FactoryTaskId = Schema.String;
export type FactoryTaskId = typeof FactoryTaskId.Type;

export const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const FactoryTaskKind = Schema.Literals(["software", "knowledge", "research"]);
export type FactoryTaskKind = typeof FactoryTaskKind.Type;

export const FACTORY_KIND_WORKFLOWS = {
  software: "factory-task",
  knowledge: "factory-brief",
  research: "factory-experiment",
} as const satisfies Record<FactoryTaskKind, string>;

export const FactoryTaskLane = Schema.Literals([
  "backlog",
  "ready",
  "doing",
  "review",
  "done",
  "dropped",
]);
export type FactoryTaskLane = typeof FactoryTaskLane.Type;

export const FactorySignalFeedId = Schema.String;
export type FactorySignalFeedId = typeof FactorySignalFeedId.Type;

export const FactoryTaskSource = Schema.Union([
  Schema.TaggedStruct("local", {}),
  Schema.TaggedStruct("issue", { url: Schema.String, displayKey: Schema.String }),
  Schema.TaggedStruct("promoted", { fromTaskId: FactoryTaskId, artifactSha256: Sha256 }),
  Schema.TaggedStruct("signal", {
    feedId: FactorySignalFeedId,
    candidateId: Sha256,
    revision: PositiveInt,
    sha256: Sha256,
  }),
]);
export type FactoryTaskSource = typeof FactoryTaskSource.Type;

const FactoryTaskTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const FactoryTaskDescription = Schema.String.check(Schema.isMaxLength(8_000));
const FactoryTaskBlockedBy = Schema.Array(FactoryTaskId).check(Schema.isMaxLength(50));
const FactoryTaskAssignee = Schema.NullOr(Schema.String.check(Schema.isMaxLength(100)));

export const FactoryTask = Schema.Struct({
  v: Schema.Literal(1),
  id: FactoryTaskId,
  number: PositiveInt,
  rev: PositiveInt,
  projectId: Schema.NullOr(ProjectId),
  kind: Schema.optionalKey(FactoryTaskKind),
  title: FactoryTaskTitle,
  description: FactoryTaskDescription,
  lane: FactoryTaskLane,
  laneSetAt: IsoDateTime,
  parentId: Schema.NullOr(FactoryTaskId),
  blockedBy: FactoryTaskBlockedBy,
  assignee: FactoryTaskAssignee,
  model: Schema.NullOr(ModelSelection),
  source: FactoryTaskSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryTask = typeof FactoryTask.Type;

export const FACTORY_SIGNAL_FEEDS_MAX = 20;
export const FACTORY_SIGNAL_LIST_LIMIT = 200;

export const FactorySignalFailure = Schema.Literals([
  "not-a-url",
  "scheme",
  "credentials",
  "port",
  "hostname",
  "address",
  "dns",
  "network",
  "timeout",
  "redirect",
  "status",
  "too-large",
  "encoding",
  "dtd",
  "entity",
  "malformed",
  "too-deep",
  "format",
  "store",
]);
export type FactorySignalFailure = typeof FactorySignalFailure.Type;

const Bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const FactorySignalFeed = Schema.Struct({
  v: Schema.Literal(1),
  id: FactorySignalFeedId,
  url: Bounded(2_048),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  projectId: Schema.NullOr(ProjectId),
  addedAt: IsoDateTime,
});
export type FactorySignalFeed = typeof FactorySignalFeed.Type;

export const FactorySignalFeedState = Schema.Struct({
  v: Schema.Literal(1),
  feedId: FactorySignalFeedId,
  lastPullAt: IsoDateTime,
  lastOkAt: Schema.NullOr(IsoDateTime),
  etag: Schema.NullOr(Bounded(200)),
  lastModified: Schema.NullOr(Bounded(200)),
  failures: NonNegativeInt,
  failure: Schema.NullOr(FactorySignalFailure),
  httpStatus: Schema.NullOr(Schema.Int),
  items: NonNegativeInt,
});
export type FactorySignalFeedState = typeof FactorySignalFeedState.Type;

export const FactorySignalCandidate = Schema.Struct({
  v: Schema.Literal(1),
  id: Sha256,
  feedId: FactorySignalFeedId,
  projectId: Schema.NullOr(ProjectId),
  itemKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  revision: PositiveInt,
  sha256: Sha256,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  summary: Bounded(2_000),
  link: Schema.NullOr(Bounded(2_000)),
  state: Schema.Literals(["pending", "admitted", "dismissed"]),
  firstSeenAt: IsoDateTime,
  changedAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
  decidedRevision: Schema.NullOr(PositiveInt),
  decidedSha256: Schema.NullOr(Sha256),
  taskId: Schema.NullOr(FactoryTaskId),
});
export type FactorySignalCandidate = typeof FactorySignalCandidate.Type;

export const FactorySignalFeedView = Schema.Struct({
  feed: FactorySignalFeed,
  state: Schema.NullOr(FactorySignalFeedState),
  pending: NonNegativeInt,
});
export type FactorySignalFeedView = typeof FactorySignalFeedView.Type;

export const FactorySignalsListInput = Schema.Struct({
  view: Schema.Literals(["pending", "decided"]),
});
export type FactorySignalsListInput = typeof FactorySignalsListInput.Type;

export const FactorySignalsList = Schema.Struct({
  feeds: Schema.Array(FactorySignalFeedView),
  candidates: Schema.Array(FactorySignalCandidate),
  damaged: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type FactorySignalsList = typeof FactorySignalsList.Type;

export const FactorySignalFeedAddInput = Schema.Struct({
  url: Schema.String,
  label: Schema.String,
  projectId: Schema.NullOr(ProjectId),
});
export type FactorySignalFeedAddInput = typeof FactorySignalFeedAddInput.Type;

export const FactorySignalFeedRemoveInput = Schema.Struct({ feedId: FactorySignalFeedId });
export type FactorySignalFeedRemoveInput = typeof FactorySignalFeedRemoveInput.Type;

export const FactorySignalDecisionInput = Schema.Struct({
  feedId: FactorySignalFeedId,
  candidateId: Sha256,
  revision: PositiveInt,
  sha256: Sha256,
});
export type FactorySignalDecisionInput = typeof FactorySignalDecisionInput.Type;

export const FactorySignalAdmitResult = Schema.Struct({
  candidate: FactorySignalCandidate,
  task: FactoryTask,
});
export type FactorySignalAdmitResult = typeof FactorySignalAdmitResult.Type;

export const FactoryTaskRunInput = Schema.Struct({
  taskId: FactoryTaskId,
  number: Schema.Number,
  attempt: Schema.Number,
  title: Schema.String,
  description: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.toType(ModelSelection)),
  issueUrl: Schema.NullOr(Schema.String),
});
export type FactoryTaskRunInput = typeof FactoryTaskRunInput.Type;

export const FactoryAttempt = Schema.Struct({
  v: Schema.Literal(1),
  taskId: FactoryTaskId,
  n: PositiveInt,
  key: Schema.String,
  workflow: Schema.String,
  runId: Schema.NullOr(Schema.String),
  requestedBy: Schema.String,
  startedAt: IsoDateTime,
});
export type FactoryAttempt = typeof FactoryAttempt.Type;

export const FactoryNote = Schema.Struct({
  v: Schema.Literal(1),
  taskId: FactoryTaskId,
  id: Schema.String,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
  by: Schema.String,
  at: IsoDateTime,
});
export type FactoryNote = typeof FactoryNote.Type;

export const FactoryArtifact = Schema.Struct({
  v: Schema.Literal(1),
  taskId: FactoryTaskId,
  attempt: PositiveInt,
  sha256: Sha256,
  kind: Schema.Literals(["deliverable", "brief", "protocol", "evaluator", "results", "file"]),
  location: Schema.Union([
    Schema.TaggedStruct("file", { path: Schema.String.check(Schema.isMaxLength(1_024)) }),
    Schema.TaggedStruct("inline", { text: Schema.String.check(Schema.isMaxLength(65_536)) }),
  ]),
  bytes: NonNegativeInt,
  label: Schema.String.check(Schema.isMaxLength(200)),
  step: Schema.String,
  runId: Schema.String,
  at: IsoDateTime,
});
export type FactoryArtifact = typeof FactoryArtifact.Type;

export const FactoryReceipt = Schema.Struct({
  v: Schema.Literal(1),
  taskId: FactoryTaskId,
  attempt: PositiveInt,
  sha256: Sha256,
  kind: Schema.Literals([
    "sealed",
    "critiqued",
    "accepted",
    "rejected",
    "delivered",
    "uncertain",
    "promoted",
  ]),
  by: Schema.Literals(["person", "agent", "pack"]),
  runId: Schema.String,
  at: IsoDateTime,
  detail: Schema.optionalKey(
    Schema.Struct({
      url: Schema.optionalKey(Schema.String),
      commentId: Schema.optionalKey(Schema.String),
      reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
      taskId: Schema.optionalKey(FactoryTaskId),
    }),
  ),
});
export type FactoryReceipt = typeof FactoryReceipt.Type;

export const FactoryReviewFinding = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/)),
  lens: Schema.Literals(["brief", "defects"]),
  severity: Schema.Literals(["blocker", "major", "minor", "nit"]),
  category: Schema.Literals(["correctness", "scope", "test", "security", "other"]),
  path: Schema.String.check(Schema.isMaxLength(500)),
  line: Schema.NullOr(Schema.Int),
  claim: Schema.String.check(Schema.isMaxLength(500)),
  evidence: Schema.String.check(Schema.isMaxLength(2_000)),
  status: Schema.Literals(["open", "refuted"]),
  disproof: Schema.Struct({
    outcome: Schema.Literals(["survived", "refuted", "not-run"]),
    tried: Schema.String.check(Schema.isMaxLength(1_000)),
  }),
});
export type FactoryReviewFinding = typeof FactoryReviewFinding.Type;

export const FactoryReviewRound = Schema.Struct({
  v: Schema.Literal(1),
  taskId: FactoryTaskId,
  attempt: PositiveInt,
  part: NonNegativeInt,
  at: Schema.String.check(Schema.isMaxLength(40)),
  runId: Schema.String,
  head: Schema.NullOr(Schema.String),
  lenses: Schema.Array(Schema.Literals(["brief", "defects"])),
  verdict: Schema.Literals(["approve", "changes", "stale"]),
  findings: Schema.Array(FactoryReviewFinding).check(Schema.isMaxLength(40)),
  createdAt: IsoDateTime,
});
export type FactoryReviewRound = typeof FactoryReviewRound.Type;

export const FactoryTaskSummary = FactoryTask.mapFields(Struct.omit(["description"])).mapFields(
  (fields) => ({
    ...fields,
    hasDescription: Schema.Boolean,
    attempt: Schema.NullOr(FactoryAttempt),
  }),
);
export type FactoryTaskSummary = typeof FactoryTaskSummary.Type;

export const FactoryTaskDetail = Schema.Struct({
  task: FactoryTask,
  attempts: Schema.Array(FactoryAttempt),
  notes: Schema.Array(FactoryNote),
  artifacts: Schema.Array(FactoryArtifact),
  receipts: Schema.Array(FactoryReceipt),
  reviews: Schema.optionalKey(Schema.Array(FactoryReviewRound)),
});
export type FactoryTaskDetail = typeof FactoryTaskDetail.Type;

export const FactoryOrchestrator = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type FactoryOrchestrator = typeof FactoryOrchestrator.Type;

export const FactoryTasksSubscribeInput = Schema.Struct({});
export type FactoryTasksSubscribeInput = typeof FactoryTasksSubscribeInput.Type;

export const FactoryTasksSnapshot = Schema.Struct({
  tasks: Schema.Array(FactoryTaskSummary),
  orchestrators: Schema.Array(FactoryOrchestrator),
  damaged: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type FactoryTasksSnapshot = typeof FactoryTasksSnapshot.Type;

export const FactoryTasksChange = Schema.TaggedStruct("changed", {
  tasks: Schema.Array(FactoryTaskSummary),
  removed: Schema.Array(FactoryTaskId),
  orchestrators: Schema.optionalKey(Schema.Array(FactoryOrchestrator)),
});
export type FactoryTasksChange = typeof FactoryTasksChange.Type;

export const FactoryTasksUpdate = Schema.Union([FactoryTasksSnapshot, FactoryTasksChange]);
export type FactoryTasksUpdate = typeof FactoryTasksUpdate.Type;

export const FactoryTaskGetInput = Schema.Struct({ taskId: FactoryTaskId });
export type FactoryTaskGetInput = typeof FactoryTaskGetInput.Type;

export const FactoryTaskCreateInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  kind: Schema.optionalKey(FactoryTaskKind),
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  lane: Schema.optionalKey(FactoryTaskLane),
  parentId: Schema.optionalKey(Schema.NullOr(FactoryTaskId)),
  blockedBy: Schema.optionalKey(Schema.Array(FactoryTaskId)),
  assignee: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  source: Schema.optionalKey(FactoryTaskSource),
});
export type FactoryTaskCreateInput = typeof FactoryTaskCreateInput.Type;

export const FactoryTaskPatch = Schema.Struct({
  kind: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  lane: Schema.optionalKey(FactoryTaskLane),
  parentId: Schema.optionalKey(Schema.NullOr(FactoryTaskId)),
  blockedBy: Schema.optionalKey(Schema.Array(FactoryTaskId)),
  assignee: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model: Schema.optionalKey(Schema.NullOr(ModelSelection)),
});
export type FactoryTaskPatch = typeof FactoryTaskPatch.Type;

export const FactoryTaskUpdateInput = Schema.Struct({
  taskId: FactoryTaskId,
  rev: PositiveInt,
  patch: FactoryTaskPatch,
  note: Schema.optionalKey(Schema.String),
});
export type FactoryTaskUpdateInput = typeof FactoryTaskUpdateInput.Type;

export const FactoryTaskStartInput = Schema.Struct({ taskId: FactoryTaskId });
export type FactoryTaskStartInput = typeof FactoryTaskStartInput.Type;

export const FactoryOrchestratorSetInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
});
export type FactoryOrchestratorSetInput = typeof FactoryOrchestratorSetInput.Type;

export const FactoryTaskErrorReason = Schema.Literals([
  "not-found",
  "conflict",
  "invalid",
  "workflows-off",
  "workflow-missing",
  "workspace-unavailable",
  "already-running",
]);
export type FactoryTaskErrorReason = typeof FactoryTaskErrorReason.Type;

export class FactoryTaskError extends Schema.TaggedError<FactoryTaskError>()("FactoryTaskError", {
  reason: FactoryTaskErrorReason,
  message: Schema.String,
  rev: Schema.optionalKey(PositiveInt),
}) {}

/** The list once `update` is applied: newest `updatedAt` first, ties by id. */
export function applyFactoryTasksUpdate(
  snapshot: FactoryTasksSnapshot | undefined,
  update: FactoryTasksUpdate,
): FactoryTasksSnapshot {
  if (!("_tag" in update)) return update;
  const base = snapshot ?? { tasks: [], orchestrators: [], damaged: 0, truncated: false };
  const tasks = new Map(base.tasks.map((task) => [task.id, task]));
  for (const id of update.removed) tasks.delete(id);
  for (const task of update.tasks) tasks.set(task.id, task);
  return {
    ...base,
    tasks: [...tasks.values()].sort((left, right) =>
      left.updatedAt === right.updatedAt
        ? left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0
        : left.updatedAt < right.updatedAt
          ? 1
          : -1,
    ),
    orchestrators: update.orchestrators ?? base.orchestrators,
  };
}

export const FACTORY_WS_METHODS = {
  factoryTasksSubscribe: "factory.tasks.subscribe",
  factoryTasksGet: "factory.tasks.get",
  factoryTasksCreate: "factory.tasks.create",
  factoryTasksUpdate: "factory.tasks.update",
  factoryTasksStart: "factory.tasks.start",
  factoryOrchestratorSet: "factory.orchestrator.set",
  factorySignalsList: "factory.signals.list",
  factorySignalFeedsAdd: "factory.signals.feeds.add",
  factorySignalFeedsRemove: "factory.signals.feeds.remove",
  factorySignalsAdmit: "factory.signals.admit",
  factorySignalsDismiss: "factory.signals.dismiss",
} as const;

const FactoryTaskRequestError = Schema.Union([FactoryTaskError, EnvironmentAuthorizationError]);

const FactoryTasksSubscribeRpc = Rpc.make(FACTORY_WS_METHODS.factoryTasksSubscribe, {
  payload: FactoryTasksSubscribeInput,
  success: FactoryTasksUpdate,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const FactoryTasksGetRpc = Rpc.make(FACTORY_WS_METHODS.factoryTasksGet, {
  payload: FactoryTaskGetInput,
  success: FactoryTaskDetail,
  error: FactoryTaskRequestError,
});

const FactoryTasksCreateRpc = Rpc.make(FACTORY_WS_METHODS.factoryTasksCreate, {
  payload: FactoryTaskCreateInput,
  success: FactoryTask,
  error: FactoryTaskRequestError,
});

const FactoryTasksUpdateRpc = Rpc.make(FACTORY_WS_METHODS.factoryTasksUpdate, {
  payload: FactoryTaskUpdateInput,
  success: FactoryTask,
  error: FactoryTaskRequestError,
});

const FactoryTasksStartRpc = Rpc.make(FACTORY_WS_METHODS.factoryTasksStart, {
  payload: FactoryTaskStartInput,
  success: FactoryAttempt,
  error: FactoryTaskRequestError,
});

const FactoryOrchestratorSetRpc = Rpc.make(FACTORY_WS_METHODS.factoryOrchestratorSet, {
  payload: FactoryOrchestratorSetInput,
  error: FactoryTaskRequestError,
});

const FactorySignalsListRpc = Rpc.make(FACTORY_WS_METHODS.factorySignalsList, {
  payload: FactorySignalsListInput,
  success: FactorySignalsList,
  error: FactoryTaskRequestError,
});

const FactorySignalFeedsAddRpc = Rpc.make(FACTORY_WS_METHODS.factorySignalFeedsAdd, {
  payload: FactorySignalFeedAddInput,
  success: FactorySignalFeed,
  error: FactoryTaskRequestError,
});

const FactorySignalFeedsRemoveRpc = Rpc.make(FACTORY_WS_METHODS.factorySignalFeedsRemove, {
  payload: FactorySignalFeedRemoveInput,
  error: FactoryTaskRequestError,
});

const FactorySignalsAdmitRpc = Rpc.make(FACTORY_WS_METHODS.factorySignalsAdmit, {
  payload: FactorySignalDecisionInput,
  success: FactorySignalAdmitResult,
  error: FactoryTaskRequestError,
});

const FactorySignalsDismissRpc = Rpc.make(FACTORY_WS_METHODS.factorySignalsDismiss, {
  payload: FactorySignalDecisionInput,
  success: FactorySignalCandidate,
  error: FactoryTaskRequestError,
});

export const FactoryRpcGroup = RpcGroup.make(
  FactoryTasksSubscribeRpc,
  FactoryTasksGetRpc,
  FactoryTasksCreateRpc,
  FactoryTasksUpdateRpc,
  FactoryTasksStartRpc,
  FactoryOrchestratorSetRpc,
  FactorySignalsListRpc,
  FactorySignalFeedsAddRpc,
  FactorySignalFeedsRemoveRpc,
  FactorySignalsAdmitRpc,
  FactorySignalsDismissRpc,
);

export const FACTORY_RPC_AGGREGATES = {
  [FACTORY_WS_METHODS.factoryTasksSubscribe]: "factory",
  [FACTORY_WS_METHODS.factoryTasksGet]: "factory",
  [FACTORY_WS_METHODS.factoryTasksCreate]: "factory",
  [FACTORY_WS_METHODS.factoryTasksUpdate]: "factory",
  [FACTORY_WS_METHODS.factoryTasksStart]: "factory",
  [FACTORY_WS_METHODS.factoryOrchestratorSet]: "factory",
  [FACTORY_WS_METHODS.factorySignalsList]: "factory",
  [FACTORY_WS_METHODS.factorySignalFeedsAdd]: "factory",
  [FACTORY_WS_METHODS.factorySignalFeedsRemove]: "factory",
  [FACTORY_WS_METHODS.factorySignalsAdmit]: "factory",
  [FACTORY_WS_METHODS.factorySignalsDismiss]: "factory",
} as const;

export const FACTORY_RPC_READ_SCOPES = {
  [FACTORY_WS_METHODS.factoryTasksSubscribe]: AuthOrchestrationReadScope,
  [FACTORY_WS_METHODS.factoryTasksGet]: AuthOrchestrationReadScope,
  [FACTORY_WS_METHODS.factorySignalsList]: AuthOrchestrationReadScope,
} as const;

export const FACTORY_CLIENT_GUARDED_RPC_SCOPES = {
  [FACTORY_WS_METHODS.factoryTasksCreate]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryTasksUpdate]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryTasksStart]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryOrchestratorSet]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factorySignalFeedsAdd]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factorySignalFeedsRemove]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factorySignalsAdmit]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factorySignalsDismiss]: AuthOrchestrationOperateScope,
} as const;
