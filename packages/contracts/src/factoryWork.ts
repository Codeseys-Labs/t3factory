import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";
import { PositiveInt } from "./baseSchemas.ts";
import { FactoryRepository } from "./factory.ts";
import { FactoryFeedSourceId } from "./factoryFeeds.ts";
import { FactoryReadiness, FactoryReadinessEdge } from "./factoryReadiness.ts";
import { FactoryResearchProtocolId } from "./factoryResearch.ts";

export const FactoryWorkKind = Schema.Literals(["issue", "feed", "brief", "protocol"]);
export type FactoryWorkKind = typeof FactoryWorkKind.Type;
/** Admission roots, concrete brief IDs and protocol IDs are local to the answering environment. */
export const FactoryWorkRef = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId,
  kind: FactoryWorkKind,
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
});
export type FactoryWorkRef = typeof FactoryWorkRef.Type;
const ShortText = Schema.String.check(Schema.isMaxLength(512));
export const FactoryWorkSummary = Schema.Struct({
  ref: FactoryWorkRef,
  // Scope retains admission/authoring ownership; native commands use detail.reviewProjectId after a restart.
  projectId: ProjectId,
  title: ShortText,
  createdAt: IsoDateTime,
  sourceKey: Schema.NullOr(Schema.String),
  sourceUrl: Schema.NullOr(Schema.String),
  sourceState: Schema.NullOr(ShortText),
  revision: Schema.NullOr(Schema.String),
  supersededBy: Schema.NullOr(Schema.String),
  originConflict: Schema.Boolean,
  // Null is unavailable, not an inferred planning stage or successful completion.
  planningStage: Schema.Null,
});
export type FactoryWorkSummary = typeof FactoryWorkSummary.Type;
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));
const Cursor = Schema.String.check(Schema.isMaxLength(8192));
export const FactoryWorkListInput = Schema.Struct({
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(128))),
  kind: Schema.optional(FactoryWorkKind),
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(Limit),
});
export type FactoryWorkListInput = typeof FactoryWorkListInput.Type;
export const FactoryWorkListResult = Schema.Struct({
  environmentId: EnvironmentId,
  items: Schema.Array(FactoryWorkSummary).check(Schema.isMaxLength(50)),
  nextCursor: Schema.NullOr(Cursor),
  fetchedAt: IsoDateTime,
});
export type FactoryWorkListResult = typeof FactoryWorkListResult.Type;
export const FactoryWorkReadInput = Schema.Struct({ ref: FactoryWorkRef });
export type FactoryWorkReadInput = typeof FactoryWorkReadInput.Type;
export const FactoryWorkReviewTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("issue"), issueNumber: PositiveInt }),
  Schema.Struct({
    kind: Schema.Literal("feed"),
    sourceId: FactoryFeedSourceId,
    itemKey: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("brief"), briefId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("protocol"), protocolId: FactoryResearchProtocolId }),
]);
export const FactoryWorkReadResult = Schema.Struct({
  item: FactoryWorkSummary,
  reviewTarget: FactoryWorkReviewTarget,
  snapshot: Schema.String.check(Schema.isMaxLength(8000)),
  snapshotTruncated: Schema.Boolean,
  projectAvailable: Schema.Boolean,
  reviewProjectId: Schema.NullOr(ProjectId),
  projectCoordinatorThreadId: Schema.NullOr(ThreadId),
  supersedes: Schema.NullOr(Schema.String),
  fetchedAt: IsoDateTime,
});
export type FactoryWorkReadResult = typeof FactoryWorkReadResult.Type;
export const FactoryWorkHistoryInput = Schema.Struct({
  ref: FactoryWorkRef,
  section: Schema.Literals(["executions", "runs", "attempts", "outputs"]),
  threadId: Schema.optional(ThreadId),
  runId: Schema.optional(Schema.String),
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(Limit),
});
export type FactoryWorkHistoryInput = typeof FactoryWorkHistoryInput.Type;
/** Small metadata only. Exact acceptance currentness and output bytes stay in native review reads. */
export const FactoryWorkHistoryEntry = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  runId: Schema.NullOr(Schema.String),
  label: ShortText,
  state: ShortText,
  pin: Schema.NullOr(Schema.String),
  superseded: Schema.Boolean,
});
export type FactoryWorkHistoryEntry = typeof FactoryWorkHistoryEntry.Type;
export const FactoryWorkHistoryResult = Schema.Struct({
  entries: Schema.Array(FactoryWorkHistoryEntry).check(Schema.isMaxLength(50)),
  nextCursor: Schema.NullOr(Cursor),
  fetchedAt: IsoDateTime,
});
export type FactoryWorkHistoryResult = typeof FactoryWorkHistoryResult.Type;
export const FactoryWorkPrerequisitesInput = Schema.Struct({ ref: FactoryWorkRef });
export type FactoryWorkPrerequisitesInput = typeof FactoryWorkPrerequisitesInput.Type;
/** Source edges beyond this are counted in `omittedCount`, never silently dropped. */
export const FACTORY_WORK_PREREQUISITES_MAX = 500;
/**
 * Where a direct blocker leads in this environment. `retained` names the stable root Work ref and
 * its admission project. Only edges the latest source listing reports are looked up, so a
 * tombstoned or inaccessible locator is never matched to local Work.
 */
export const FactoryWorkPrerequisiteLink = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("retained"), ref: FactoryWorkRef, projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("unresolved"),
    reason: Schema.Literals(["cycle", "missing-ancestry", "bound-exhausted"]),
  }),
  Schema.Struct({ kind: Schema.Literal("not-current") }),
]);
export type FactoryWorkPrerequisiteLink = typeof FactoryWorkPrerequisiteLink.Type;
export const FactoryWorkPrerequisite = Schema.Struct({
  edge: FactoryReadinessEdge,
  link: FactoryWorkPrerequisiteLink,
});
export type FactoryWorkPrerequisite = typeof FactoryWorkPrerequisite.Type;
/** Direct source blockers only; sub-issues and execution lineage are separate relations. */
export const FactoryWorkPrerequisitesResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("not-modeled"),
    kind: Schema.Literals(["feed", "brief", "protocol"]),
    fetchedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("owner-unavailable"),
    reason: Schema.Literals([
      "ambiguous-owner",
      "missing-project",
      "missing-repository",
      "unsupported-provider",
      "repository-changed",
      "read-failed",
    ]),
    fetchedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("observed"),
    reviewProjectId: ProjectId,
    repository: FactoryRepository,
    issueNumber: PositiveInt,
    readiness: FactoryReadiness.mapFields(({ edges: _edges, ...fields }) => fields),
    prerequisites: Schema.Array(FactoryWorkPrerequisite).check(
      Schema.isMaxLength(FACTORY_WORK_PREREQUISITES_MAX),
    ),
    omittedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    fetchedAt: IsoDateTime,
  }),
]);
export type FactoryWorkPrerequisitesResult = typeof FactoryWorkPrerequisitesResult.Type;
export class FactoryWorkError extends Schema.TaggedError<FactoryWorkError>()("FactoryWorkError", {
  reason: Schema.Literals([
    "invalid-cursor",
    "wrong-environment",
    "missing-work",
    "invalid-history",
    "persistence-failure",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `Work read failed: ${this.reason}.`;
  }
}
