import {
  FACTORY_READINESS_TTL_MS,
  FactoryWorkRef,
  type EnvironmentId,
  type FactoryReadinessEdge,
  type FactoryWorkListResult,
  type FactoryWorkPrerequisiteLink,
  type FactoryWorkPrerequisitesResult,
  type FactoryWorkSummary,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

export type FactoryWorkOwnerStatus =
  | "current"
  | "loading"
  | "offline"
  | "unsupported"
  | "forbidden"
  | "failed";
export interface FactoryWorkOwner {
  readonly environmentId: EnvironmentId;
  readonly status: FactoryWorkOwnerStatus;
  readonly page: FactoryWorkListResult | null;
}
export function factoryWorkKey(ref: FactoryWorkRef): string {
  return JSON.stringify([ref.version, ref.environmentId, ref.kind, ref.id]);
}
const decodeSelection = Schema.decodeOption(Schema.fromJsonString(FactoryWorkRef));
export function parseFactoryWorkSelection(value: unknown): FactoryWorkRef | null {
  if (typeof value !== "string") return null;
  return Option.getOrNull(decodeSelection(value));
}
/** Only saved owning projects filter Work; observer checkouts never create additional items. */
export function planFactoryWorkOwners(input: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly projects:
    | readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[]
    | null;
}) {
  return [...new Set(input.environmentIds)].map((environmentId) => ({
    environmentId,
    projectIds:
      input.projects === null
        ? undefined
        : [
            ...new Set(
              input.projects
                .filter((project) => project.environmentId === environmentId)
                .map((project) => project.id),
            ),
          ].sort(),
  }));
}
/** Presentation ordering is deterministic, not a synchronized cross-environment chronology. */
export function aggregateFactoryWork(owners: readonly FactoryWorkOwner[]) {
  const items = new Map<
    string,
    { readonly item: FactoryWorkSummary; readonly stale: boolean; readonly fetchedAt: string }
  >();
  const sourceGroups = new Map<string, Set<string>>();
  for (const owner of owners) {
    if (owner.status === "forbidden" || owner.status === "unsupported" || owner.page === null)
      continue;
    for (const item of owner.page.items) {
      if (item.ref.environmentId !== owner.environmentId) continue;
      const key = factoryWorkKey(item.ref);
      items.set(key, { item, stale: owner.status !== "current", fetchedAt: owner.page.fetchedAt });
      if (item.sourceKey !== null) {
        const group = sourceGroups.get(item.sourceKey) ?? new Set<string>();
        group.add(key);
        sourceGroups.set(item.sourceKey, group);
      }
    }
  }
  return {
    items: [...items.values()].sort(
      (a, b) =>
        a.item.createdAt.localeCompare(b.item.createdAt) ||
        factoryWorkKey(a.item.ref).localeCompare(factoryWorkKey(b.item.ref)),
    ),
    conflicts: new Set(
      [...sourceGroups].filter(([, members]) => members.size > 1).map(([key]) => key),
    ),
    incomplete: owners.some(
      (owner) => owner.status !== "current" || owner.page?.nextCursor !== null,
    ),
  };
}
/** Revocation removes protected detail even if a query library retains its previous success. */
export function selectFactoryWorkDetail<A>(
  status: FactoryWorkOwnerStatus,
  value: A | null,
): A | null {
  return status === "current" ? value : null;
}

const FACTORY_WORK_PREREQUISITE_GRAPH_LIMIT = 25;
const FACTORY_WORK_PREREQUISITE_PAGE_SIZE = 25;
export type FactoryWorkPrerequisiteTone = "blocking" | "unknown" | "clear" | "removed";
export interface FactoryWorkPrerequisiteNode {
  readonly key: string;
  readonly locator: string;
  /** Null whenever the current source listing does not disclose the blocker. */
  readonly title: string | null;
  readonly tone: FactoryWorkPrerequisiteTone;
  readonly sourceLabel: string;
  readonly sourceUrl: string | null;
  readonly link:
    | { readonly kind: "retained"; readonly ref: FactoryWorkRef; readonly withinFilter: boolean }
    | { readonly kind: "none" | "not-current" | "unresolved" };
  readonly linkLabel: string;
}
export type FactoryWorkPrerequisitesView =
  | { readonly state: "unavailable" | "not-modeled"; readonly message: string }
  | {
      readonly state: "observed";
      readonly verdict: string;
      readonly observation: string;
      readonly stale: boolean;
      readonly graph: {
        readonly nodes: readonly FactoryWorkPrerequisiteNode[];
        readonly omitted: number;
      };
      readonly list: {
        readonly entries: readonly FactoryWorkPrerequisiteNode[];
        readonly page: number;
        readonly pageCount: number;
        readonly first: number;
        readonly last: number;
        readonly total: number;
      };
      readonly emptyMessage: string | null;
      readonly notes: readonly string[];
    };

const unavailableMessages: Record<Exclude<FactoryWorkOwnerStatus, "current">, string> = {
  loading: "Loading owner…",
  offline:
    "Owner offline. Prerequisites are unavailable until it reconnects; this is not an empty graph.",
  unsupported: "Owner does not advertise Unified Work. Update its server.",
  forbidden: "Owner read access denied. Prerequisites are hidden.",
  failed: "Owner read failed. Prerequisites are unavailable; this is not an empty graph.",
};
type OwnerUnavailable = Extract<FactoryWorkPrerequisitesResult, { status: "owner-unavailable" }>;
const ownerUnavailableMessages: Record<OwnerUnavailable["reason"], string> = {
  "ambiguous-owner":
    "The current review owner is missing or ambiguous, so source blockers are not read.",
  "missing-project":
    "The current review project no longer exists, so source blockers are not read.",
  "missing-repository": "The current review project has no usable repository remote.",
  "unsupported-provider": "The current review project's host cannot report issue blockers here.",
  "repository-changed":
    "The review project's origin no longer matches the admitted repository, so another repository's blockers are not shown.",
  "read-failed": "Prerequisite read failed. This is not an empty graph.",
};
const notModeledLabels = { feed: "feed work", brief: "briefs", protocol: "protocols" } as const;
const toneOrder: Record<FactoryWorkPrerequisiteTone, number> = {
  blocking: 0,
  unknown: 1,
  clear: 2,
  removed: 3,
};
const resolutionLabels: Record<FactoryReadinessEdge["resolution"], string> = {
  open: "Open at source",
  "closed-unaccepted": "Closed at source without completion",
  accepted: "Completed at source",
  deleted: "Deleted at source",
  inaccessible: "Inaccessible to this environment; details withheld",
  moved: "Moved at source",
  unverified: "Unverified at source",
};
const unresolvedLabels: Record<
  Extract<FactoryWorkPrerequisiteLink, { kind: "unresolved" }>["reason"],
  string
> = {
  cycle: "Retained Work lineage has a cycle; not linked",
  "missing-ancestry": "Retained Work lineage is incomplete; not linked",
  "bound-exhausted": "Retained Work lineage exceeds the traversal bound; not linked",
};
type Observed = Extract<FactoryWorkPrerequisitesResult, { status: "observed" }>;
type FilterTest = (link: {
  readonly ref: FactoryWorkRef;
  readonly projectId: ProjectId;
}) => boolean;
function prerequisiteNode(
  { edge, link }: Observed["prerequisites"][number],
  overrides: Observed["readiness"]["overrides"],
  withinFilter: FilterTest,
): FactoryWorkPrerequisiteNode {
  const present = edge.status === "present";
  const override = overrides.find((candidate) => candidate.id === edge.override)?.kind;
  const tone: FactoryWorkPrerequisiteTone =
    edge.status === "removed-at-source"
      ? "removed"
      : override === "force-not-ready"
        ? "blocking"
        : override === "waive"
          ? "clear"
          : edge.resolution === "open" ||
              edge.resolution === "closed-unaccepted" ||
              edge.resolution === "deleted"
            ? "blocking"
            : edge.resolution === "accepted"
              ? "clear"
              : "unknown";
  const source =
    edge.status === "removed-at-source"
      ? "No longer listed as a blocker at source"
      : resolutionLabels[edge.resolution];
  const within = link.kind === "retained" && withinFilter(link);
  return {
    key: `${edge.targetHost}/${edge.targetId}`,
    locator: `${edge.targetRepository}#${edge.targetNumber}`,
    title: present && edge.resolution !== "inaccessible" ? edge.title : null,
    tone,
    sourceLabel:
      override === "force-not-ready"
        ? `${source} · override: not ready`
        : override === "waive"
          ? `${source} · override: waived`
          : source,
    sourceUrl: present ? edge.targetUrl : null,
    link:
      link.kind === "retained"
        ? { kind: "retained", ref: link.ref, withinFilter: within }
        : { kind: link.kind },
    linkLabel:
      link.kind === "retained"
        ? within
          ? "Open retained Work"
          : "Open retained Work (outside current filter)"
        : link.kind === "none"
          ? "No retained Work in this environment"
          : link.kind === "not-current"
            ? "Not linked: this blocker was not verified in the latest source observation"
            : unresolvedLabels[link.reason],
  };
}
/** One presenter for every client; protected content appears only while the owner is current. */
export function presentFactoryWorkPrerequisites(input: {
  readonly status: FactoryWorkOwnerStatus;
  readonly supported: boolean;
  readonly failed: boolean;
  readonly result: FactoryWorkPrerequisitesResult | null;
  readonly withinFilter: FilterTest;
  readonly page: number;
  readonly nowMs: number;
}): FactoryWorkPrerequisitesView {
  if (input.status !== "current")
    return { state: "unavailable", message: unavailableMessages[input.status] };
  if (!input.supported)
    return {
      state: "unavailable",
      message:
        "This owner's server cannot report Work prerequisites. Update it to inspect blockers.",
    };
  if (input.failed)
    return { state: "unavailable", message: ownerUnavailableMessages["read-failed"] };
  const result = input.result;
  if (result === null) return { state: "unavailable", message: "Observing source prerequisites…" };
  if (result.status === "not-modeled")
    return {
      state: "not-modeled",
      message: `Prerequisites are not modeled here for ${notModeledLabels[result.kind]}. This does not mean the work has no real-world dependencies.`,
    };
  if (result.status === "owner-unavailable")
    return { state: "unavailable", message: ownerUnavailableMessages[result.reason] };
  const { readiness } = result;
  const nodes = result.prerequisites
    .map((entry, index) => ({
      node: prerequisiteNode(entry, readiness.overrides, input.withinFilter),
      index,
    }))
    .sort((a, b) => toneOrder[a.node.tone] - toneOrder[b.node.tone] || a.index - b.index)
    .map(({ node }) => node);
  const pageCount = Math.max(1, Math.ceil(nodes.length / FACTORY_WORK_PREREQUISITE_PAGE_SIZE));
  const page = Math.min(Math.max(0, Math.trunc(input.page)), pageCount - 1);
  const start = page * FACTORY_WORK_PREREQUISITE_PAGE_SIZE;
  const entries = nodes.slice(start, start + FACTORY_WORK_PREREQUISITE_PAGE_SIZE);
  const observedAt = Date.parse(readiness.observedAt);
  const stale = !Number.isFinite(observedAt) || input.nowMs - observedAt > FACTORY_READINESS_TTL_MS;
  const verdict =
    readiness.status === "ready"
      ? readiness.basis === "override"
        ? "Ready at source, relying on an active waiver"
        : "Ready at source"
      : readiness.status === "blocked"
        ? "Blocked"
        : readiness.status === "not-applicable"
          ? "Not applicable: the item is closed at source"
          : "Unknown";
  const reasons = readiness.reasons.map((reason) => reason.replaceAll("-", " ")).join(", ");
  return {
    state: "observed",
    verdict: reasons.length === 0 ? verdict : `${verdict} · ${reasons}`,
    observation: `Current source observation ${readiness.observedAt}${stale ? " (stale)" : ""} · ${
      readiness.complete ? "complete" : "partial"
    } listing, ${readiness.listedCount} listed of ${readiness.summaryTotal ?? "an unreported number"}.`,
    stale,
    graph: {
      nodes: nodes.slice(0, FACTORY_WORK_PREREQUISITE_GRAPH_LIMIT),
      omitted: Math.max(0, nodes.length - FACTORY_WORK_PREREQUISITE_GRAPH_LIMIT),
    },
    list: {
      entries,
      page,
      pageCount,
      first: entries.length === 0 ? 0 : start + 1,
      last: start + entries.length,
      total: nodes.length,
    },
    emptyMessage:
      nodes.length > 0
        ? null
        : readiness.complete
          ? "The source reports no direct blockers in a complete observation."
          : "No blockers could be listed. The observation is incomplete, so this is not an empty prerequisite set.",
    notes: [
      "Closed or completed at source is tracker evidence only. It is not artifact acceptance or publication.",
      ...(result.omittedCount > 0
        ? [`${result.omittedCount} more source edges exceed the response bound and are not shown.`]
        : []),
    ],
  };
}
