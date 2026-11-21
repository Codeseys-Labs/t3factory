import {
  IssueTrackerKind,
  SourceControlProviderKind,
  type FactoryIssueCapabilities,
} from "@t3tools/contracts";
import type { SourceControlApiResource } from "@t3tools/source-control-core/server/driver";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssueTrackerRegistry from "../issue/IssueTrackerRegistry.ts";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

const GITHUB = SourceControlProviderKind.make("github");

/**
 * What the Factory can do on a host beyond reading and commenting on its issues, which the issue
 * tracker covers: observe GitHub's issue relations, and publish and merge a delivery.
 */
export class FactoryIssueHosts extends Context.Service<
  FactoryIssueHosts,
  {
    /** Null for a host whose issues no tracker reads. */
    readonly capabilities: (kind: SourceControlProviderKind) => FactoryIssueCapabilities | null;
    /** One GitHub REST resource, through the GitHub driver's shared credential, quota and pause. */
    readonly readRelation: (input: {
      readonly host: string;
      readonly path: string;
    }) => Effect.Effect<SourceControlApiResource, IssueTrackerError>;
  }
>()("t3/factory/FactoryIssueHosts") {}

const make = Effect.gen(function* () {
  const drivers = yield* BuiltInDrivers.SourceControlDrivers;
  const trackers = yield* IssueTrackerRegistry.IssueTrackerRegistry;
  const github = drivers.find(({ driver }) => driver.kind === GITHUB)?.instance;
  const readApiResource = github?.readApiResource;
  return FactoryIssueHosts.of({
    capabilities: (kind) => {
      const tracker = trackers.get(IssueTrackerKind.make(kind));
      if (tracker === null) return null;
      // The relation decoder reads GitHub's REST shapes, so no other host is observed.
      const relations = kind === GITHUB && readApiResource !== undefined;
      // Delivery classifies only GitHub's definite rejections, and only GitHub's `runAction` pins
      // a merge to `expectedHeadSha`, so no other host publishes until both hold for it.
      const pullRequests = kind === GITHUB ? (github?.pullRequests ?? null) : null;
      return {
        provider: kind,
        displayName: sourceControlDefinitions.get(kind).label,
        blockedBy: relations ? "listing-with-total" : "none",
        subIssues: relations,
        closeAcceptance: relations ? "close-reason" : "none",
        publish: pullRequests !== null,
        headPinnedMerge: pullRequests?.capabilities.actions.includes("merge") === true,
        issueComment: tracker.capabilities.comment && tracker.comment !== undefined,
      };
    },
    readRelation:
      readApiResource ??
      (() =>
        Effect.fail(
          new IssueTrackerError({
            tracker: IssueTrackerKind.make(GITHUB),
            operation: "readRelation",
            reason: "failed",
            detail: "This server reads no GitHub issue relations.",
          }),
        )),
  });
});

export const layer = Layer.effect(FactoryIssueHosts, make);
