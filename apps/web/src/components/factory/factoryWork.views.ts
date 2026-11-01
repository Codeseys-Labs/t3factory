import type { FactoryWorkKind, FactoryWorkSummary } from "@t3tools/contracts";

export type FactoryWorkBoardGrouping = "origin" | "project";

export function parseFactoryWorkBoardGrouping(value: unknown): FactoryWorkBoardGrouping {
  return value === "project" ? "project" : "origin";
}

export const FACTORY_WORK_ORIGIN_LABELS: Record<FactoryWorkKind, string> = {
  issue: "Issue admission",
  feed: "Feed admission",
  brief: "Authored brief",
  protocol: "Sealed protocol",
};
const ORIGIN_ORDER: readonly FactoryWorkKind[] = ["issue", "feed", "brief", "protocol"];

export interface FactoryWorkEntry {
  readonly item: FactoryWorkSummary;
  readonly stale: boolean;
}
export interface FactoryWorkBoardColumn<E extends FactoryWorkEntry> {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly E[];
}

/**
 * Columns describe what an item is or where it was admitted, never progress: the collection has no
 * planning stage, and runtime/acceptance live in each item's history reads.
 */
export function groupFactoryWorkForBoard<E extends FactoryWorkEntry>(
  entries: readonly E[],
  grouping: FactoryWorkBoardGrouping,
  options: {
    readonly kind: FactoryWorkKind | undefined;
    readonly projectOf: (item: FactoryWorkSummary) => {
      readonly key: string;
      readonly label: string;
    };
  },
): readonly FactoryWorkBoardColumn<E>[] {
  if (grouping === "origin") {
    return ORIGIN_ORDER.filter((kind) => options.kind === undefined || options.kind === kind).map(
      (kind) => ({
        key: kind,
        label: FACTORY_WORK_ORIGIN_LABELS[kind],
        entries: entries.filter((entry) => entry.item.ref.kind === kind),
      }),
    );
  }
  const columns = new Map<string, { key: string; label: string; entries: E[] }>();
  for (const entry of entries) {
    const project = options.projectOf(entry.item);
    const column = columns.get(project.key) ?? { ...project, entries: [] };
    column.entries.push(entry);
    columns.set(project.key, column);
  }
  return [...columns.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  );
}

/** Arrow-key focus over enabled cards; horizontal moves skip empty columns and clamp the row. */
export function moveFactoryWorkFocus(
  columnSizes: readonly number[],
  current: { readonly column: number; readonly row: number },
  key: string,
): { readonly column: number; readonly row: number } | null {
  const size = columnSizes[current.column] ?? 0;
  if (key === "ArrowDown")
    return current.row + 1 < size ? { ...current, row: current.row + 1 } : null;
  if (key === "ArrowUp") return current.row > 0 ? { ...current, row: current.row - 1 } : null;
  if (key === "Home") return size > 0 ? { ...current, row: 0 } : null;
  if (key === "End") return size > 0 ? { ...current, row: size - 1 } : null;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const step = key === "ArrowRight" ? 1 : -1;
  for (
    let column = current.column + step;
    column >= 0 && column < columnSizes.length;
    column += step
  ) {
    const target = columnSizes[column] ?? 0;
    if (target > 0) return { column, row: Math.min(current.row, target - 1) };
  }
  return null;
}
