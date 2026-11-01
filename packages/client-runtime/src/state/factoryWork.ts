import {
  FactoryWorkRef,
  type EnvironmentId,
  type FactoryWorkListResult,
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
