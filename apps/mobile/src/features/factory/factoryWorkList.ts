import {
  aggregateFactoryWork,
  factoryWorkKey,
  type FactoryWorkOwner,
  type FactoryWorkOwnerStatus,
} from "@t3tools/client-runtime/state/factory-work";
import {
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type FactoryWorkKind,
  type FactoryWorkListInput,
  type FactoryWorkListResult,
  type FactoryWorkReadResult,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

export const FACTORY_WORK_PAGE_LIMIT = 25;
/** Bounds how many keyset pages one owner keeps mounted; a refresh starts again from the first. */
export const FACTORY_WORK_MAX_PAGES = 8;
export const FACTORY_WORK_HISTORY_MAX_PAGES = 32;

export const FACTORY_WORK_KINDS: ReadonlyArray<{
  readonly value: FactoryWorkKind | "all";
  readonly label: string;
  readonly accessibilityLabel: string;
}> = [
  { value: "all", label: "All", accessibilityLabel: "All work" },
  { value: "issue", label: "Issues", accessibilityLabel: "Issue admissions" },
  { value: "feed", label: "Feeds", accessibilityLabel: "Feed admissions" },
  { value: "brief", label: "Briefs", accessibilityLabel: "Authored briefs" },
  { value: "protocol", label: "Protocols", accessibilityLabel: "Sealed research protocols" },
];

export const FACTORY_WORK_KIND_LABELS: Record<FactoryWorkKind, string> = {
  issue: "Issue admission",
  feed: "Feed admission",
  brief: "Authored brief",
  protocol: "Sealed research protocol",
};

export const FACTORY_WORK_OWNER_MESSAGES: Record<FactoryWorkOwnerStatus, string> = {
  current: "Loaded pages. Pull to refresh to observe changes.",
  loading: "Loading this environment's work…",
  offline: "Offline. Reconnect to inspect or act.",
  unsupported: "This server doesn't support Unified Work. Update it to list work here.",
  forbidden: "Read access denied. Protected details are unavailable.",
  failed: "Couldn't read this environment's work. This is not an empty list.",
};

interface WorkEnvironment {
  readonly connection: { readonly phase: string };
  readonly serverConfig: {
    readonly environment: { readonly capabilities: { readonly factoryWork?: boolean } };
  } | null;
}

/** What may be asked of an owner before any request; the server stays authoritative. */
export function factoryWorkAccess(
  environment: WorkEnvironment | undefined,
  readable: boolean,
): FactoryWorkOwnerStatus {
  if (environment === undefined || environment.connection.phase !== "connected") return "offline";
  if (environment.serverConfig === null) return "loading";
  if (environment.serverConfig.environment.capabilities.factoryWork !== true) return "unsupported";
  return readable ? "current" : "forbidden";
}

export interface FactoryWorkPageTarget {
  readonly environmentId: EnvironmentId;
  readonly input: FactoryWorkListInput;
}

/** One target per loaded keyset page, first page first, for every owner that may be read. */
export function factoryWorkPageTargets(input: {
  readonly plan: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectIds: readonly ProjectId[] | undefined;
  }>;
  readonly access: (environmentId: EnvironmentId) => FactoryWorkOwnerStatus;
  readonly kind: FactoryWorkKind | null;
  readonly cursors: (environmentId: EnvironmentId) => readonly string[];
}): FactoryWorkPageTarget[] {
  return input.plan.flatMap((owner) =>
    input.access(owner.environmentId) !== "current"
      ? []
      : [undefined, ...input.cursors(owner.environmentId)]
          .slice(0, FACTORY_WORK_MAX_PAGES)
          .map((cursor) => ({
            environmentId: owner.environmentId,
            // Key order is part of the query atom's identity; keep it stable.
            input: {
              projectIds: owner.projectIds,
              kind: input.kind ?? undefined,
              cursor,
              limit: FACTORY_WORK_PAGE_LIMIT,
            },
          })),
  );
}

export type FactoryWorkMoreState = "idle" | "loading" | "failed";

export interface FactoryWorkOwnerView extends FactoryWorkOwner {
  /** State of the page after the merged ones; a failed later page keeps earlier pages usable. */
  readonly more: FactoryWorkMoreState;
  readonly canLoadMore: boolean;
  readonly pageCount: number;
}

type PageResult = AsyncResult.AsyncResult<FactoryWorkListResult, unknown>;

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
function deniedBy(result: PageResult): boolean {
  return (
    result._tag === "Failure" &&
    Option.exists(Cause.findErrorOption(result.cause), (error) => isAuthorizationError(error))
  );
}

/**
 * Merges each owner's loaded keyset pages into the single page the shared aggregation reads.
 * A first page that is loading or failed makes the owner non-current so its retained rows read
 * as stale; a later page that is loading or failed keeps earlier pages usable.
 */
export function resolveFactoryWorkOwners(input: {
  readonly plan: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
  readonly access: (environmentId: EnvironmentId) => FactoryWorkOwnerStatus;
  readonly pages: (environmentId: EnvironmentId) => readonly PageResult[];
}): FactoryWorkOwnerView[] {
  return input.plan.map(({ environmentId }): FactoryWorkOwnerView => {
    const idle = { more: "idle" as const, canLoadMore: false, pageCount: 0 };
    const access = input.access(environmentId);
    if (access !== "current") return { environmentId, status: access, page: null, ...idle };
    const results = input.pages(environmentId);
    if (results.some(deniedBy)) return { environmentId, status: "forbidden", page: null, ...idle };
    const first = results[0];
    if (first === undefined) return { environmentId, status: "loading", page: null, ...idle };
    if (first._tag !== "Success" || first.waiting) {
      return {
        environmentId,
        status: first._tag === "Failure" ? "failed" : "loading",
        page: Option.getOrNull(AsyncResult.value(first)),
        ...idle,
        pageCount: 1,
      };
    }
    let page = first.value;
    let more: FactoryWorkMoreState = "idle";
    let pageCount = 1;
    for (const result of results.slice(1)) {
      if (result._tag !== "Success" || result.waiting) {
        more = result._tag === "Failure" ? "failed" : "loading";
        break;
      }
      page = {
        environmentId: page.environmentId,
        items: [...page.items, ...result.value.items],
        nextCursor: result.value.nextCursor,
        // The oldest observation is the honest age of what is merged.
        fetchedAt:
          result.value.fetchedAt < page.fetchedAt ? result.value.fetchedAt : page.fetchedAt,
      };
      pageCount += 1;
    }
    return {
      environmentId,
      status: "current",
      // A pending later page was requested with this page's cursor, so it stays incomplete.
      page,
      more,
      canLoadMore:
        more === "idle" && page.nextCursor !== null && results.length < FACTORY_WORK_MAX_PAGES,
      pageCount,
    };
  });
}

type Aggregate = ReturnType<typeof aggregateFactoryWork>;
type AggregateEntry = Aggregate["items"][number];

export type FactoryWorkRow =
  | { readonly type: "owner"; readonly key: string; readonly owner: FactoryWorkOwnerView }
  | {
      readonly type: "item";
      readonly key: string;
      readonly entry: AggregateEntry;
      readonly conflict: boolean;
    }
  | { readonly type: "footer"; readonly key: string; readonly owner: FactoryWorkOwnerView };

/** Owner sections in plan order; items keep the shared deterministic order within each owner. */
export function factoryWorkRows(
  owners: readonly FactoryWorkOwnerView[],
  aggregate: Aggregate,
): FactoryWorkRow[] {
  return owners.flatMap((owner): FactoryWorkRow[] => [
    { type: "owner", key: `owner:${owner.environmentId}`, owner },
    ...aggregate.items
      .filter(({ item }) => item.ref.environmentId === owner.environmentId)
      .map((entry): FactoryWorkRow => ({
        type: "item",
        key: factoryWorkKey(entry.item.ref),
        entry,
        conflict: entry.item.sourceKey !== null && aggregate.conflicts.has(entry.item.sourceKey),
      })),
    { type: "footer", key: `footer:${owner.environmentId}`, owner },
  ]);
}

export type FactoryWorkReview =
  | {
      readonly kind: "open";
      readonly section: "issues" | "briefs";
      readonly projectId: ProjectId;
      readonly label: string;
      /** Set when the destination cannot start or resume; review stays read-only. */
      readonly operateNote: string | null;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Mobile reviews issues and briefs in their project's existing inbox. Feed and protocol review,
 * and any action the destination does not advertise or permit, are named rather than hidden.
 */
export function resolveFactoryWorkReview(input: {
  readonly detail: FactoryWorkReadResult;
  readonly reviewProjectKnown: boolean;
  readonly capabilities: {
    readonly factoryIssues?: boolean | undefined;
    readonly factoryKnowledge?: boolean | undefined;
  };
  readonly canOperate: boolean;
}): FactoryWorkReview {
  const { detail } = input;
  const target = detail.reviewTarget;
  if (target.kind === "feed") {
    return {
      kind: "unavailable",
      reason: detail.item.originConflict
        ? "Native actions unavailable: legacy feed admissions conflict. Inspect each execution below; no member is chosen for you."
        : "Feed review isn't available on mobile. Review, start or resume this admission from Sources on desktop or web.",
    };
  }
  if (target.kind === "protocol") {
    return {
      kind: "unavailable",
      reason:
        "Research protocol review isn't available on mobile. Review runs and findings from Research on desktop or web.",
    };
  }
  if (detail.reviewProjectId === null || !input.reviewProjectKnown) {
    return {
      kind: "unavailable",
      reason:
        "Actions unavailable: the saved review project is missing on this connection. Work provenance is retained.",
    };
  }
  const supported =
    target.kind === "issue"
      ? input.capabilities.factoryIssues === true
      : input.capabilities.factoryKnowledge === true;
  if (!supported) {
    return {
      kind: "unavailable",
      reason:
        target.kind === "issue"
          ? "Issue review is unsupported by this server."
          : "Brief review is unsupported by this server.",
    };
  }
  return {
    kind: "open",
    section: target.kind === "issue" ? "issues" : "briefs",
    projectId: detail.reviewProjectId,
    label: target.kind === "issue" ? `Find #${target.issueNumber} in Issues` : "Review brief",
    operateNote: input.canOperate
      ? null
      : "Starting or resuming needs operate permission in this environment. Review stays read-only.",
  };
}
