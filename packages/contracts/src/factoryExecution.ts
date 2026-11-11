import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, RunId, RunAttemptId, ThreadId } from "./baseSchemas.ts";
import { FactoryPlanRef } from "./factoryPlan.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 256 }));
const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const FactoryExecutionSelection = Schema.Struct({
  ref: FactoryPlanRef,
  revision: Revision,
  taskId: Id,
});
export type FactoryExecutionSelection = typeof FactoryExecutionSelection.Type;
export const FactoryExecutionWorkspace = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  }),
]);
export const FactoryExecutionTaskSpec = Schema.Struct({
  taskId: Id,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: FactoryExecutionWorkspace,
  setup: Schema.Literal("deny"),
  verification: Schema.optional(
    Schema.Struct({
      command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      args: Schema.Array(Schema.String.check(Schema.isMaxLength(2000))).check(
        Schema.isMaxLength(32),
      ),
    }),
  ),
  output: Schema.Struct({ slot: Id, kind: Schema.Literals(["sealed-draft", "verified-code"]) }),
});
export type FactoryExecutionTaskSpec = typeof FactoryExecutionTaskSpec.Type;
export const FactoryExecutionEdgeRule = Schema.Struct({
  edgeId: Id,
  slot: Id,
  rule: Schema.Literals(["sealed-draft", "verified-code"]),
});
export type FactoryExecutionEdgeRule = typeof FactoryExecutionEdgeRule.Type;
export const FactoryExecutionPolicy = Schema.Struct({
  version: Schema.Literal(1),
  requesterThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(16)),
  tasks: Schema.Array(FactoryExecutionTaskSpec).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
  edges: Schema.Array(FactoryExecutionEdgeRule).check(Schema.isMaxLength(128)),
  // Tasks check blockers before they start one task. When true, a plan edge without a rule
  // passes no input and holds nothing.
  advisoryEdges: Schema.optional(Schema.Boolean),
  // Attempts admitted under an earlier grant of this plan revision that this grant keeps
  // authorized. Each must still be listed in `tasks` with the spec it was admitted with.
  continues: Schema.optional(Schema.Array(RunAttemptId).check(Schema.isMaxLength(64))),
  maxAttempts: Count,
  maxRetriesPerTask: Count,
  maxConcurrent: Count,
  expiresAt: IsoDateTime,
  requiredCapabilities: Schema.Array(
    Schema.Literals(["owned-writers", "hard-cost-limit", "external-actions-denied"]),
  ).check(Schema.isMaxLength(3)),
});
export type FactoryExecutionPolicy = typeof FactoryExecutionPolicy.Type;
export const FactoryExecutionGrant = Schema.Struct({
  ref: FactoryPlanRef,
  revision: Revision,
  version: Revision,
  issuerSessionId: Schema.String,
  issuedAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
  policy: FactoryExecutionPolicy,
});
export type FactoryExecutionGrant = typeof FactoryExecutionGrant.Type;
export const FactoryExecutionInputPin = Schema.Struct({
  edgeId: Id,
  taskId: Id,
  resultId: Digest,
  digest: Digest,
  runId: RunId,
  runAttemptId: RunAttemptId,
});
export type FactoryExecutionInputPin = typeof FactoryExecutionInputPin.Type;
export const FactoryExecutionBinding = Schema.Struct({
  selection: FactoryExecutionSelection,
  grantVersion: Revision,
  taskVersion: Revision,
  commandId: CommandId,
  threadId: ThreadId,
  runId: RunId,
  runAttemptId: RunAttemptId,
  spec: FactoryExecutionTaskSpec,
  driver: ProviderDriverKind,
  inputDigest: Digest,
  inputText: Schema.String,
  prerequisites: Schema.Array(FactoryExecutionInputPin),
  admittedAt: IsoDateTime,
  stopRequested: Schema.Boolean,
  quiescent: Schema.Boolean,
});
export type FactoryExecutionBinding = typeof FactoryExecutionBinding.Type;
export const FactoryExecutionOutput = Schema.Struct({
  resultId: Digest,
  selection: FactoryExecutionSelection,
  runId: RunId,
  runAttemptId: RunAttemptId,
  captureKey: Id,
  slot: Id,
  kind: Schema.Literals(["sealed-draft", "verified-code"]),
  digest: Digest,
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.Literals(["sealed", "failed", "held"]),
  checkpoint: Schema.NullOr(
    Schema.Struct({
      commit: Schema.String,
      tree: Schema.String,
      verificationDigest: Digest,
      retainedRef: Schema.String,
    }),
  ),
  observedAt: IsoDateTime,
});
export type FactoryExecutionOutput = typeof FactoryExecutionOutput.Type;
export const FactoryExecutionTaskState = Schema.Struct({
  taskId: Id,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  binding: Schema.NullOr(FactoryExecutionBinding),
  selectedResult: Schema.NullOr(FactoryExecutionOutput),
  status: Schema.Literals(["idle", "running", "held", "failed", "sealed"]),
  hold: Schema.NullOr(Schema.String),
});
export type FactoryExecutionTaskState = typeof FactoryExecutionTaskState.Type;
export const FactoryExecutionAssembly = Schema.Struct({
  ref: FactoryPlanRef,
  revision: Revision,
  digest: Digest,
  outputs: Schema.Array(FactoryExecutionOutput),
  missingTaskIds: Schema.Array(Id),
  inputs: Schema.Array(
    Schema.Struct({
      taskId: Id,
      runId: RunId,
      runAttemptId: RunAttemptId,
      inputDigest: Digest,
      prerequisites: Schema.Array(FactoryExecutionInputPin),
    }),
  ),
  edges: Schema.Array(FactoryExecutionEdgeRule),
  complete: Schema.Boolean,
  scope: Schema.Literal("local-preparation"),
  createdAt: IsoDateTime,
});
export type FactoryExecutionAssembly = typeof FactoryExecutionAssembly.Type;
export const FactoryPreparationAcceptance = Schema.Struct({
  selection: FactoryExecutionSelection,
  digest: Digest,
  commandId: CommandId,
  issuerSessionId: Schema.String,
  acceptedAt: IsoDateTime,
  scope: Schema.Literal("local-preparation"),
  delivery: Schema.Literals(["not-requested", "outstanding"]),
});
export type FactoryPreparationAcceptance = typeof FactoryPreparationAcceptance.Type;
export const FactoryExecutionReadInput = Schema.Struct({ ref: FactoryPlanRef, revision: Revision });
export type FactoryExecutionReadInput = typeof FactoryExecutionReadInput.Type;
export const FactoryExecutionReadResult = Schema.Struct({
  ref: FactoryPlanRef,
  revision: Revision,
  currentRevision: Revision,
  grant: Schema.NullOr(FactoryExecutionGrant),
  tasks: Schema.Array(FactoryExecutionTaskState),
  assembly: Schema.NullOr(FactoryExecutionAssembly),
  acceptance: Schema.NullOr(FactoryPreparationAcceptance),
  reopened: Schema.Boolean,
});
export type FactoryExecutionReadResult = typeof FactoryExecutionReadResult.Type;
export const FactoryExecutionIssueGrantInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryPlanRef,
  expectedRevision: Revision,
  expectedGrantVersion: Version,
  policy: FactoryExecutionPolicy,
});
export type FactoryExecutionIssueGrantInput = typeof FactoryExecutionIssueGrantInput.Type;
export const FactoryExecutionRevokeGrantInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryPlanRef,
  expectedRevision: Revision,
  expectedGrantVersion: Revision,
});
export type FactoryExecutionRevokeGrantInput = typeof FactoryExecutionRevokeGrantInput.Type;
export const FactoryExecutionAdmitInput = Schema.Struct({
  commandId: CommandId,
  selection: FactoryExecutionSelection,
  grantVersion: Revision,
  expectedTaskVersion: Version,
});
export type FactoryExecutionAdmitInput = typeof FactoryExecutionAdmitInput.Type;
export const FactoryExecutionRetryInput = Schema.Struct({
  ...FactoryExecutionAdmitInput.fields,
  priorRunId: RunId,
  priorRunAttemptId: RunAttemptId,
  priorResultId: Schema.NullOr(Digest),
  intent: Schema.Literal("retry"),
});
export type FactoryExecutionRetryInput = typeof FactoryExecutionRetryInput.Type;
export const FactoryExecutionStopInput = Schema.Struct({
  commandId: CommandId,
  selection: FactoryExecutionSelection,
  runId: RunId,
  runAttemptId: RunAttemptId,
});
export type FactoryExecutionStopInput = typeof FactoryExecutionStopInput.Type;
export const FactoryExecutionRetryCaptureInput = Schema.Struct({
  ...FactoryExecutionStopInput.fields,
  expectedResultId: Schema.NullOr(Digest),
});
export type FactoryExecutionRetryCaptureInput = typeof FactoryExecutionRetryCaptureInput.Type;
export const FactoryExecutionMutationResult = Schema.Struct({
  execution: FactoryExecutionReadResult,
  replayed: Schema.Boolean,
});
export type FactoryExecutionMutationResult = typeof FactoryExecutionMutationResult.Type;
export const FactoryExecutionOutputsInput = Schema.Struct({
  ...FactoryExecutionReadInput.fields,
  taskId: Id,
  beforeResultId: Schema.optional(Digest),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type FactoryExecutionOutputsInput = typeof FactoryExecutionOutputsInput.Type;
export const FactoryExecutionOutputsResult = Schema.Struct({
  items: Schema.Array(FactoryExecutionOutput),
  nextBeforeResultId: Schema.NullOr(Digest),
});
export type FactoryExecutionOutputsResult = typeof FactoryExecutionOutputsResult.Type;
export const FactoryExecutionOutputReadInput = Schema.Struct({
  selection: FactoryExecutionSelection,
  resultId: Digest,
});
export type FactoryExecutionOutputReadInput = typeof FactoryExecutionOutputReadInput.Type;
export const FactoryExecutionOutputReadResult = Schema.Struct({
  output: FactoryExecutionOutput,
  text: Schema.String,
  binding: FactoryExecutionBinding,
});
export type FactoryExecutionOutputReadResult = typeof FactoryExecutionOutputReadResult.Type;
export const FactoryPreparationAcceptInput = Schema.Struct({
  commandId: CommandId,
  selection: FactoryExecutionSelection,
  expectedDigest: Digest,
  scope: Schema.Literal("local-preparation"),
  delivery: Schema.Literals(["not-requested", "outstanding"]),
});
export type FactoryPreparationAcceptInput = typeof FactoryPreparationAcceptInput.Type;
export const FactoryPreparationReopenInput = Schema.Struct({
  commandId: CommandId,
  selection: FactoryExecutionSelection,
  expectedDigest: Digest,
});
export type FactoryPreparationReopenInput = typeof FactoryPreparationReopenInput.Type;
export const FactoryPreparationHistoryResult = Schema.Struct({
  items: Schema.Array(FactoryPreparationAcceptance),
});
export type FactoryPreparationHistoryResult = typeof FactoryPreparationHistoryResult.Type;
export class FactoryExecutionError extends Schema.TaggedError<FactoryExecutionError>()(
  "FactoryExecutionError",
  {
    reason: Schema.Literals([
      "forbidden",
      "wrong-environment",
      "missing-plan",
      "missing-project",
      "revision-conflict",
      "grant-conflict",
      "grant-inactive",
      "grant-expired",
      "command-conflict",
      "task-conflict",
      "budget-exhausted",
      "prerequisite-held",
      "unsupported-capability",
      "invalid-input",
      "missing-result",
      "capture-conflict",
      "not-quiescent",
      "persistence-failure",
    ]),
    capabilityReason: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.capabilityReason ?? `Execution operation failed: ${this.reason}.`;
  }
}
