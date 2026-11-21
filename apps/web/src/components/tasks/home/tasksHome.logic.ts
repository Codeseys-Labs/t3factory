import {
  type FactoryTaskDrop,
  factoryTaskFailedRun,
  groupFactoryTasks,
  nestFactoryTasks,
} from "@t3tools/client-runtime/state/factory-task-view";
import {
  FactoryTaskError,
  type FactoryTaskAssignee,
  type FactoryTaskCountInput,
  type FactoryTaskStatus,
  type FactoryTaskSummary,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { taskErrorMessage } from "../shared/taskErrors";
import { m, type MessageResolver } from "../../../i18n/messages";

const BOARD_STATUSES = ["backlog", "ready", "in-progress", "in-review", "done"] as const;
const LIST_STATUS_ORDER: readonly FactoryTaskStatus[] = [
  "in-progress",
  "in-review",
  "ready",
  "backlog",
  "done",
  "canceled",
];

/** A task cannot be created in a status that follows a run. */
export const isCreatableLane = (status: FactoryTaskStatus): status is "backlog" | "ready" =>
  status === "backlog" || status === "ready";

/** The board's columns. Canceled tasks stay off the board unless the filter asks for them. */
export function boardStatuses(filters: FactoryTaskCountInput): readonly FactoryTaskStatus[] {
  return filters.statuses?.includes("canceled") ? [...BOARD_STATUSES, "canceled"] : BOARD_STATUSES;
}

export type TaskFilterField = "statuses" | "types" | "sourceKinds" | "assigneeKeys";

export function toggleTaskFilter(
  filters: FactoryTaskCountInput,
  field: TaskFilterField,
  value: string,
): FactoryTaskCountInput {
  const current: readonly string[] = filters[field] ?? [];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  const { [field]: _removed, ...rest } = filters;
  return (next.length === 0 ? rest : { ...rest, [field]: next }) as FactoryTaskCountInput;
}

export function activeFilterCount(filters: FactoryTaskCountInput): number {
  return (
    (filters.statuses?.length ?? 0) +
    (filters.types?.length ?? 0) +
    (filters.sourceKinds?.length ?? 0) +
    (filters.assigneeKeys?.length ?? 0) +
    (filters.text ? 1 : 0)
  );
}

/** The shown statuses' server counts. `canceled` counts only when the filter shows it. */
export function countShownTasks(
  byStatus: Readonly<Record<FactoryTaskStatus, number>>,
  statuses: readonly FactoryTaskStatus[],
): number {
  return statuses.reduce((total, status) => total + byStatus[status], 0);
}

/**
 * Arrow-key movement over the cards of one lane, copied from the Work board: vertical moves stay
 * in the column, horizontal moves skip empty columns and keep the row where they can.
 */
export function moveTaskFocus(
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

/**
 * A card's result: `#99 merged`, `#112 · +184 −20` for a pull request still open, otherwise the
 * summary with `Document` shortened to `Doc`.
 */
function shortResultLine(
  result: NonNullable<FactoryTaskSummary["result"]>,
  resolve: MessageResolver = m,
): string {
  const pullRequest = result.pullRequest ?? null;
  if (pullRequest?.state === "merged")
    return resolve(msg("#{number} merged", { number: String(pullRequest.number) }));
  if (pullRequest)
    return resolve(
      msg("#{number} · {summary}", {
        number: String(pullRequest.number),
        summary: result.summary.split(" · ")[0],
      }),
    );
  return result.summary.replace(/^Document\b/u, "Doc");
}

const failedRunLine = (task: FactoryTaskSummary, resolve: MessageResolver = m) => {
  const run = factoryTaskFailedRun(task);
  if (run?.state !== "failed" && run?.state !== "held") return null;
  return run.note
    ? run.state === "failed"
      ? resolve(
          msg("Run {ordinal} failed: {note}", { ordinal: String(run.ordinal), note: run.note }),
        )
      : resolve(msg("Run {ordinal}: {note}", { ordinal: String(run.ordinal), note: run.note }))
    : run.state === "failed"
      ? resolve(msg("Run {ordinal} failed", { ordinal: String(run.ordinal) }))
      : resolve(msg("Run {ordinal}", { ordinal: String(run.ordinal) }));
};

/** The card's meta line beside the project: progress for a parent, else result, run or source. */
export function cardMeta(
  task: FactoryTaskSummary,
  resolve: MessageResolver = m,
):
  | { readonly kind: "progress"; readonly done: number; readonly total: number }
  | { readonly kind: "text"; readonly text: string }
  | null {
  if (task.progress) return { kind: "progress", ...task.progress };
  const failed = failedRunLine(task, resolve);
  if (failed) return { kind: "text", text: failed };
  if (task.result) return { kind: "text", text: shortResultLine(task.result, resolve) };
  if (task.source.kind !== "local") return { kind: "text", text: task.source.label };
  return null;
}

/** The list's Result column. */
export function listResultText(task: FactoryTaskSummary, resolve: MessageResolver = m): string {
  if (task.progress)
    return resolve(
      msg("{done} of {total} done", {
        done: String(task.progress.done),
        total: String(task.progress.total),
      }),
    );
  const failed = failedRunLine(task, resolve);
  if (failed) return failed;
  if (task.result) {
    const pullRequest = task.result.pullRequest ?? null;
    if (pullRequest?.state === "merged")
      return resolve(msg("PR #{number} merged", { number: String(pullRequest.number) }));
    if (task.result.state === "accepted")
      return pullRequest
        ? resolve(msg("PR #{number} open · accepted", { number: String(pullRequest.number) }))
        : resolve(msg("Accepted · rev {revision}", { revision: String(task.result.revision) }));
    return pullRequest
      ? resolve(
          msg("PR #{number} · {summary}", {
            number: String(pullRequest.number),
            summary: task.result.summary,
          }),
        )
      : task.result.summary;
  }
  return "";
}

export interface TaskLane {
  readonly key: string;
  readonly tasks: readonly FactoryTaskSummary[];
}

/** Board lanes for Assignee or Project grouping, in first-seen order; Unassigned comes last. */
export function boardLanes(
  tasks: readonly FactoryTaskSummary[],
  grouping: "assignee" | "project",
): readonly TaskLane[] {
  const groups = new Map<string, FactoryTaskSummary[]>();
  for (const task of tasks) {
    const key =
      grouping === "assignee"
        ? JSON.stringify([task.ref.environmentId, task.assignee.key])
        : JSON.stringify([task.ref.environmentId, task.ref.projectId]);
    const items = groups.get(key) ?? [];
    items.push(task);
    groups.set(key, items);
  }
  const lanes = [...groups].map(([key, items]) => ({ key, tasks: items }));
  if (grouping === "assignee")
    lanes.sort(
      (a, b) =>
        Number(a.tasks[0]!.assignee.key === "unassigned") -
        Number(b.tasks[0]!.assignee.key === "unassigned"),
    );
  return lanes;
}

/** A lane, section or filter choice stands for tasks that may differ in options, so its label names none. */
export const GROUP_ASSIGNEE_LABEL = { options: false } as const;

/** An Auto assignee as the agent it resolved to, so a lane or a filter choice names the agent. */
export function agentAssignee(assignee: FactoryTaskAssignee): FactoryTaskAssignee {
  if (assignee.assignment.mode !== "auto" || !assignee.resolved) return assignee;
  return {
    ...assignee,
    assignment: assignee.resolved.profile
      ? { mode: "profile", profileId: assignee.resolved.profile.id }
      : { mode: "pinned", setup: assignee.resolved.setup },
  };
}

/** Who a lane or section stands for. Its tasks share an assignee key. */
export function laneAssignee(tasks: readonly FactoryTaskSummary[]): FactoryTaskAssignee | null {
  const direct = tasks.find((task) => task.assignee.assignment.mode !== "auto");
  if (direct) return direct.assignee;
  const auto = tasks[0]?.assignee;
  return auto ? agentAssignee(auto) : null;
}

interface TaskListRow {
  readonly task: FactoryTaskSummary;
  readonly depth: number;
}
export interface TaskListSection {
  readonly key: string;
  readonly status: FactoryTaskStatus | null;
  readonly sample: FactoryTaskSummary | null;
  readonly rows: readonly TaskListRow[];
}

/**
 * List sections. By status, sub-tasks stay under their parent in the parent's section, in the
 * order In progress, In review, Ready, Backlog, Done. By assignee or project, each group nests
 * the tasks it holds.
 */
export function listSections(
  tasks: readonly FactoryTaskSummary[],
  grouping: "status" | "assignee" | "project",
  statuses: readonly FactoryTaskStatus[],
): readonly TaskListSection[] {
  if (grouping !== "status") {
    const groups = groupFactoryTasks(tasks, grouping);
    const sections = groups.map((group) => ({
      key: group.key,
      status: null,
      sample: group.items[0] ?? null,
      rows: group.rows,
    }));
    if (grouping === "assignee")
      sections.sort(
        (a, b) =>
          Number(a.sample?.assignee.key === "unassigned") -
          Number(b.sample?.assignee.key === "unassigned"),
      );
    return sections;
  }
  const byStatus = new Map<FactoryTaskStatus, TaskListRow[]>();
  let section: TaskListRow[] | null = null;
  for (const row of nestFactoryTasks(tasks)) {
    if (row.depth === 0) {
      section = byStatus.get(row.task.status) ?? [];
      byStatus.set(row.task.status, section);
    }
    section?.push(row);
  }
  return LIST_STATUS_ORDER.filter(
    (status) => statuses.includes(status) || byStatus.has(status),
  ).map((status) => ({
    key: status,
    status,
    sample: null,
    rows: byStatus.get(status) ?? [],
  }));
}

/** One sentence for a drop the board refuses, in the words the server would use. */
export function dropRefusalMessage(
  task: FactoryTaskSummary,
  drop: Extract<FactoryTaskDrop, { kind: "refuse" }>,
  resolve: MessageResolver = m,
): string {
  return taskErrorMessage(new FactoryTaskError({ reason: drop.reason }), { task }, resolve);
}
