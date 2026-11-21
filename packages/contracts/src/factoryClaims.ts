import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryIssueTask, FactoryRepository } from "./factory.ts";
import { OrchestrationV2CreationSource } from "./orchestrationV2.ts";

/**
 * An admitted origin's identity across environments: `<tracker>:<canonicalScopeKey>#<key>` (git numeric
 * keys keep their bytes), `feed:<canonicalKey>|<locator>|<itemKey>`, `research:<protocolId>:<role>`,
 * `knowledge:<briefId>`. Equal keys with different threads are duplicate execution; same thread, a copied DB.
 */
export const FactoryOriginKey = Schema.String.pipe(Schema.brand("FactoryOriginKey"));
export type FactoryOriginKey = typeof FactoryOriginKey.Type;

export const FactoryClaim = Schema.Struct({
  originKey: FactoryOriginKey,
  // Only an `issueKeys` listing carries the trackers added with the issue layer (Linear, Forgejo,
  // Azure DevOps): older clients reject a whole list holding an origin they do not know.
  origin: Schema.Literals([
    "github-issue",
    "gitlab-issue",
    "linear-issue",
    "forgejo-issue",
    "azure-devops-issue",
    "feed-item",
    "research-run",
    "knowledge-brief",
  ]),
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  threadId: ThreadId,
  status: FactoryIssueTask.fields.status,
  // Null for knowledge briefs: they run in a non-git folder and have no base commit.
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  creationSource: OrchestrationV2CreationSource,
  // Provenance only: the environment whose guard chain wrote the row. Ownership is always the
  // answering environment; rows written before provenance was recorded carry null.
  admittedBy: Schema.NullOr(EnvironmentId),
  // A legacy duplicate group member (feed claims keyed before origin keys existed). Never merged;
  // further admissions against the group are refused.
  originConflict: Schema.Boolean,
  // The live acceptance record's pin only. Whether it is still current needs a git read per
  // claim, so the detail read (`factory.readAcceptance`) derives that instead.
  acceptance: Schema.NullOr(Schema.Struct({ headSha: Schema.String, acceptedAt: IsoDateTime })),
  // The live artifact acceptance of a knowledge brief; null for every other origin. The digest
  // is the pin, and whether it is still current needs a file read, so `factory.readKnowledgeTask`
  // derives that instead.
  artifactAcceptance: Schema.NullOr(
    Schema.Struct({ sha256: Schema.String, acceptedAt: IsoDateTime }),
  ),
});
export type FactoryClaim = typeof FactoryClaim.Type;

export const FactoryClaimListInput = Schema.Struct({
  projectId: ProjectId,
  issueKeys: Schema.optionalKey(Schema.Boolean),
});
export type FactoryClaimListInput = typeof FactoryClaimListInput.Type;
export const FactoryClaimListResult = Schema.Struct({
  environmentId: EnvironmentId,
  repository: FactoryRepository,
  claims: Schema.Array(FactoryClaim),
  fetchedAt: IsoDateTime,
});
export type FactoryClaimListResult = typeof FactoryClaimListResult.Type;
