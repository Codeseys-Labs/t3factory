import {
  FACTORY_WORK_PREREQUISITES_MAX,
  FactoryWorkError,
  type FactoryIssueError,
  type FactoryReadinessEdge,
  type FactoryWorkPrerequisitesInput,
  type FactoryWorkPrerequisitesResult,
  type FactoryWorkListInput,
  type FactoryWorkListResult,
  type FactoryWorkReadInput,
  type FactoryWorkReadResult,
  type FactoryWorkHistoryInput,
  type FactoryWorkHistoryResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Projection from "../persistence/FactoryWorkProjection.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as Relations from "./FactoryIssueRelations.ts";

export class FactoryWorkService extends Context.Service<
  FactoryWorkService,
  {
    readonly list: (
      input: FactoryWorkListInput,
    ) => Effect.Effect<FactoryWorkListResult, FactoryWorkError>;
    readonly read: (
      input: FactoryWorkReadInput,
    ) => Effect.Effect<FactoryWorkReadResult, FactoryWorkError>;
    readonly history: (
      input: FactoryWorkHistoryInput,
    ) => Effect.Effect<FactoryWorkHistoryResult, FactoryWorkError>;
    readonly readPrerequisites: (
      input: FactoryWorkPrerequisitesInput,
    ) => Effect.Effect<FactoryWorkPrerequisitesResult, FactoryWorkError>;
  }
>()("t3/factory/FactoryWorkService") {}
const ownerFailure = (error: FactoryIssueError) =>
  error.reason === "missing-project" ||
  error.reason === "missing-repository" ||
  error.reason === "unsupported-provider" ||
  error.reason === "repository-changed"
    ? error.reason
    : "read-failed";
// Same canonicalization as admitted repository identities: lower case, host without port.
const edgeKey = (edge: FactoryReadinessEdge): Projection.IssueKey => ({
  canonicalKey: sourceControlDefinitions.repositoryKeyFromRemote(
    `https://${edge.targetHost}/${edge.targetRepository}`,
  ),
  issueNumber: edge.targetNumber,
});
const edgeOrder = (edge: FactoryReadinessEdge) =>
  edge.status === "present" ? 0 : edge.status === "removed-at-source" ? 2 : 1;
const make = Effect.gen(function* () {
  const projection = yield* Projection.FactoryWorkProjection;
  const identity = yield* ServerEnvironmentIdentity;
  const relations = yield* Relations.FactoryIssueRelations;
  const list = Effect.fn("FactoryWorkService.list")(function* (input: FactoryWorkListInput) {
    const environmentId = yield* identity.getEnvironmentId;
    return {
      ...(yield* projection.list(environmentId, input)),
      environmentId,
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });
  const read = Effect.fn("FactoryWorkService.read")(function* (input: FactoryWorkReadInput) {
    const environmentId = yield* identity.getEnvironmentId;
    if (input.ref.environmentId !== environmentId)
      return yield* new FactoryWorkError({ reason: "wrong-environment" });
    return {
      ...(yield* projection.read(environmentId, input)),
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });
  const history = Effect.fn("FactoryWorkService.history")(function* (
    input: FactoryWorkHistoryInput,
  ) {
    const environmentId = yield* identity.getEnvironmentId;
    if (input.ref.environmentId !== environmentId)
      return yield* new FactoryWorkError({ reason: "wrong-environment" });
    return {
      ...(yield* projection.history(environmentId, input)),
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });
  const readPrerequisites = Effect.fn("FactoryWorkService.readPrerequisites")(function* (
    input: FactoryWorkPrerequisitesInput,
  ): Effect.fn.Return<FactoryWorkPrerequisitesResult, FactoryWorkError> {
    const environmentId = yield* identity.getEnvironmentId;
    if (input.ref.environmentId !== environmentId)
      return yield* new FactoryWorkError({ reason: "wrong-environment" });
    const fetchedAt = () => DateTime.now.pipe(Effect.map(DateTime.formatIso));
    if (input.ref.kind !== "issue") {
      yield* projection.read(environmentId, input);
      return { status: "not-modeled", kind: input.ref.kind, fetchedAt: yield* fetchedAt() };
    }
    const owner = yield* projection.issueOwner(input.ref);
    if (owner.projectId === null)
      return {
        status: "owner-unavailable",
        reason: "ambiguous-owner",
        fetchedAt: yield* fetchedAt(),
      };
    const observed = yield* relations
      .readAdmitted({
        projectId: owner.projectId,
        issueNumber: owner.issueNumber,
        canonicalKey: owner.canonicalKey,
      })
      .pipe(Effect.result);
    if (observed._tag === "Failure")
      return {
        status: "owner-unavailable",
        reason: ownerFailure(observed.failure),
        fetchedAt: yield* fetchedAt(),
      };
    const { edges, ...readiness } = observed.success.readiness;
    const ordered = edges
      .map((edge, index) => ({ edge, index }))
      .sort((a, b) => edgeOrder(a.edge) - edgeOrder(b.edge) || a.index - b.index)
      .map(({ edge }) => edge);
    const retained = ordered.slice(0, FACTORY_WORK_PREREQUISITES_MAX);
    const links = yield* projection.issueRoots(
      environmentId,
      retained.filter((edge) => edge.status === "present").map(edgeKey),
    );
    return {
      status: "observed",
      reviewProjectId: owner.projectId,
      repository: observed.success.repository,
      issueNumber: observed.success.issueNumber,
      readiness,
      prerequisites: retained.map((edge) => ({
        edge,
        link:
          edge.status !== "present"
            ? { kind: "not-current" as const }
            : (links.get(Projection.issueKeyId(edgeKey(edge))) ?? { kind: "none" as const }),
      })),
      omittedCount: ordered.length - retained.length,
      fetchedAt: yield* fetchedAt(),
    };
  });
  return FactoryWorkService.of({ list, read, history, readPrerequisites });
});
export const layer = Layer.effect(FactoryWorkService, make).pipe(Layer.provide(Projection.layer));
