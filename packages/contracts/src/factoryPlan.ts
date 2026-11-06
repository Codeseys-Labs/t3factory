import * as Schema from "effect/Schema";
import { CommandId, EnvironmentId, IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";
import { FactoryWorkRef } from "./factoryWork.ts";

const LocalId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const ContextText = Schema.String.check(Schema.isMaxLength(8000));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));

export const FactoryPlanRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  rootId: LocalId,
});
export type FactoryPlanRef = typeof FactoryPlanRef.Type;

export const FactoryPlanTask = Schema.Struct({
  id: LocalId,
  parentId: Schema.NullOr(LocalId),
  title: Title,
  context: ContextText,
  order: Schema.Int,
  retired: Schema.Boolean,
});
export type FactoryPlanTask = typeof FactoryPlanTask.Type;

export const FactoryPlanEdge = Schema.Struct({
  id: LocalId,
  kind: Schema.Literal("requires"),
  fromTaskId: LocalId,
  toTaskId: LocalId,
  requirement: ContextText,
  retired: Schema.Boolean,
});
export type FactoryPlanEdge = typeof FactoryPlanEdge.Type;
export const FactoryPlanWorkContext = Schema.Struct({
  id: LocalId,
  taskId: LocalId,
  ref: FactoryWorkRef,
  projectId: ProjectId,
  title: Title,
  revision: Schema.NullOr(Schema.String),
  snapshot: ContextText,
  snapshotTruncated: Schema.Boolean,
  // Time the retained Work record was read, not an external source freshness assertion.
  observedAt: IsoDateTime,
  sha256: Schema.String,
  retired: Schema.Boolean,
});
export type FactoryPlanWorkContext = typeof FactoryPlanWorkContext.Type;

export const FactoryPlanSnapshot = Schema.Struct({
  ref: FactoryPlanRef,
  revision: Revision,
  tasks: Schema.Array(FactoryPlanTask).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  edges: Schema.Array(FactoryPlanEdge).check(Schema.isMaxLength(128)),
  workContexts: Schema.Array(FactoryPlanWorkContext).check(Schema.isMaxLength(64)),
  editorThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(16)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryPlanSnapshot = typeof FactoryPlanSnapshot.Type;

export const FactoryPlanOperation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("task.add"),
    id: LocalId,
    parentId: LocalId,
    title: Title,
    context: Schema.optional(ContextText),
    order: Schema.optional(Schema.Int),
  }),
  Schema.Struct({
    type: Schema.Literal("task.update"),
    id: LocalId,
    title: Schema.optional(Title),
    context: Schema.optional(ContextText),
    order: Schema.optional(Schema.Int),
  }),
  Schema.Struct({ type: Schema.Literal("task.move"), id: LocalId, parentId: LocalId }),
  Schema.Struct({ type: Schema.Literal("task.retire"), id: LocalId }),
  Schema.Struct({ type: Schema.Literal("task.restore"), id: LocalId }),
  Schema.Struct({
    type: Schema.Literal("edge.add"),
    id: LocalId,
    fromTaskId: LocalId,
    toTaskId: LocalId,
    requirement: ContextText,
  }),
  Schema.Struct({ type: Schema.Literal("edge.retire"), id: LocalId }),
  Schema.Struct({ type: Schema.Literal("edge.restore"), id: LocalId }),
  Schema.Struct({ type: Schema.Literal("editor.grant"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("editor.revoke"), threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("context.attachWork"),
    id: LocalId,
    taskId: LocalId,
    ref: FactoryWorkRef,
  }),
  Schema.Struct({ type: Schema.Literal("context.retire"), id: LocalId }),
  Schema.Struct({ type: Schema.Literal("context.restore"), id: LocalId }),
]);
export type FactoryPlanOperation = typeof FactoryPlanOperation.Type;

export const FactoryPlanCreateInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  title: Title,
  context: Schema.optional(ContextText),
});
export type FactoryPlanCreateInput = typeof FactoryPlanCreateInput.Type;
export const FactoryPlanApplyInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryPlanRef,
  expectedRevision: Revision,
  operations: Schema.Array(FactoryPlanOperation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
});
export type FactoryPlanApplyInput = typeof FactoryPlanApplyInput.Type;
export const FactoryPlanReadInput = Schema.Struct({
  ref: FactoryPlanRef,
  revision: Schema.optional(Revision),
});
export type FactoryPlanReadInput = typeof FactoryPlanReadInput.Type;
export const FactoryPlanListInput = Schema.Struct({
  projectId: ProjectId,
  limit: Schema.optional(Limit),
  afterRootId: Schema.optional(LocalId),
});
export type FactoryPlanListInput = typeof FactoryPlanListInput.Type;
export const FactoryPlanHistoryInput = Schema.Struct({
  ref: FactoryPlanRef,
  beforeRevision: Schema.optional(Revision),
  limit: Schema.optional(Limit),
});
export type FactoryPlanHistoryInput = typeof FactoryPlanHistoryInput.Type;
export const FactoryPlanSummary = Schema.Struct({
  ref: FactoryPlanRef,
  revision: Revision,
  title: Title,
  retired: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type FactoryPlanSummary = typeof FactoryPlanSummary.Type;
export const FactoryPlanListResult = Schema.Struct({
  items: Schema.Array(FactoryPlanSummary).check(Schema.isMaxLength(50)),
  nextRootId: Schema.NullOr(LocalId),
});
export type FactoryPlanListResult = typeof FactoryPlanListResult.Type;
export const FactoryPlanHistoryResult = Schema.Struct({
  items: Schema.Array(FactoryPlanSummary).check(Schema.isMaxLength(50)),
  nextBeforeRevision: Schema.NullOr(Revision),
});
export type FactoryPlanHistoryResult = typeof FactoryPlanHistoryResult.Type;
export const FactoryPlanMutationResult = Schema.Struct({
  plan: FactoryPlanSnapshot,
  current: Schema.Boolean,
  replayed: Schema.Boolean,
});
export type FactoryPlanMutationResult = typeof FactoryPlanMutationResult.Type;

export class FactoryPlanError extends Schema.TaggedError<FactoryPlanError>()("FactoryPlanError", {
  reason: Schema.Literals([
    "wrong-environment",
    "missing-project",
    "missing-plan",
    "forbidden",
    "revision-conflict",
    "command-conflict",
    "invalid-plan",
    "invalid-operation",
    "context-unavailable",
    "persistence-failure",
  ]),
  currentRevision: Schema.optional(Revision),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `Plan operation failed: ${this.reason}.`;
  }
}
