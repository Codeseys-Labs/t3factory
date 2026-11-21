import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueTrackerProjectBinding,
  type ProjectId,
} from "@t3tools/contracts";
import type { SourceControlDriverInstance } from "@t3tools/source-control-core/server/driver";
import type {
  IssueTrackerApi,
  TrackerIssueDetail,
} from "@t3tools/source-control-core/server/IssueTracker";
import type { PullRequestProviderApi } from "@t3tools/source-control-core/server/PullRequestProvider";
import { fakeSourceControlDriverInstance } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssueService from "../issue/IssueService.ts";
import * as IssueTrackerRegistry from "../issue/IssueTrackerRegistry.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as FactoryIssueHosts from "./FactoryIssueHosts.ts";

const READ_ONLY: IssueCapabilities = {
  create: false,
  edit: false,
  comment: false,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: false,
};

/** The fields a Factory issue keeps, as a tracker's detail reports them. */
export interface FakeTrackerIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly url: string;
  readonly labels: ReadonlyArray<string>;
  readonly updatedAt: string;
}

/** A tracker's detail of `issue` and its conversation; it also serves as a listing row. */
export const trackerIssue = (
  issue: FakeTrackerIssue,
  conversation: Pick<TrackerIssueDetail, "comments" | "commentsCursor"> = {
    comments: [],
    commentsCursor: null,
  },
): TrackerIssueDetail => ({
  key: String(issue.number),
  displayKey: `#${issue.number}`,
  title: issue.title,
  url: issue.url,
  author: null,
  state: { category: issue.state, name: issue.state },
  createdAt: issue.updatedAt,
  updatedAt: issue.updatedAt,
  closedAt: null,
  assignees: [],
  labels: issue.labels.map((name) => ({ name, color: null })),
  commentCount: conversation.comments.length,
  body: issue.body,
  viewer: null,
  viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
  states: [],
  ...conversation,
  events: [],
  linkedPullRequests: [],
});

/** A tracker whose host calls die unless a test supplies them. GitHub's takes comments. */
export const fakeIssueTracker = (
  kind: "github" | "gitlab",
  calls: Partial<IssueTrackerApi> = {},
): IssueTrackerApi => ({
  kind: IssueTrackerKind.make(kind),
  capabilities: { ...READ_ONLY, comment: kind === "github" },
  getViewer: () => Effect.die(`Unexpected ${kind} viewer read`),
  listIssues: () => Effect.die(`Unexpected ${kind} issue listing`),
  getIssue: () => Effect.die(`Unexpected ${kind} issue read`),
  getComments: () => Effect.die(`Unexpected ${kind} comment listing`),
  ...(kind === "github" ? { comment: () => Effect.die(`Unexpected ${kind} issue comment`) } : {}),
  ...calls,
});

export interface FakeIssueHostOptions {
  /** The GitHub driver's REST read the relation reader goes through. */
  readonly readApiResource?: NonNullable<SourceControlDriverInstance["readApiResource"]>;
  /** A host's pull request provider, which delivery's publish and pinned merge derive from. */
  readonly pullRequests?: Readonly<Record<string, Partial<PullRequestProviderApi> | null>>;
}

/**
 * The issue tracker registry over `trackers`, and the Factory's host capabilities over fake
 * drivers for the same hosts, so services under test see the gates production derives.
 */
export const issueTrackersLayer = (
  trackers: ReadonlyArray<IssueTrackerApi> = [
    fakeIssueTracker("github"),
    fakeIssueTracker("gitlab"),
  ],
  options: FakeIssueHostOptions = {},
) =>
  FactoryIssueHosts.layer.pipe(
    Layer.provide(
      Layer.succeed(
        BuiltInDrivers.SourceControlDrivers,
        trackers
          .filter((tracker) => !("standalone" in tracker))
          .map(({ kind }) => {
            const definition = sourceControlDefinitions.get(kind);
            const pullRequests = options.pullRequests?.[kind];
            return {
              driver: { kind: definition.kind, definition },
              instance: {
                ...fakeSourceControlDriverInstance(
                  kind,
                  pullRequests === undefined ? {} : { pullRequests },
                ),
                ...(kind === "github"
                  ? {
                      readApiResource:
                        options.readApiResource ??
                        (({ path }) => Effect.die(`Unexpected GitHub relation read ${path}`)),
                    }
                  : {}),
              },
            };
          }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        IssueTrackerRegistry.IssueTrackerRegistry,
        IssueTrackerRegistry.fromTrackers(trackers),
      ),
    ),
  );

/** The issue service over the registry, for the projects and checkouts a test supplies. */
export const issueServiceLayerFor = (
  bindings: ReadonlyMap<ProjectId, IssueTrackerProjectBinding> = new Map(),
) =>
  IssueService.layer.pipe(
    Layer.provide(
      Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
        list: Effect.succeed(bindings),
      }),
    ),
  );
export const issueServiceLayer = issueServiceLayerFor();
