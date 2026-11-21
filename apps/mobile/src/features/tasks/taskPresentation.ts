import type {
  EnvironmentId,
  FactoryTaskAttentionReason,
  FactoryTaskSummary,
} from "@t3tools/contracts";
import {
  factoryTaskKey,
  groupFactoryTaskNeeds,
  type FactoryTaskLivePill,
  type FactoryTaskNeed,
  type resolveFactoryTaskLiveState,
} from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskOwnerStatus } from "@t3tools/client-runtime/state/factory-task-list";

import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import type { ThreadListV2Status } from "../threads/threadListV2";

export type TaskTone = "danger" | "attention" | "input" | "working" | "neutral";
export type TaskLiveState = ReturnType<typeof resolveFactoryTaskLiveState>;
export interface TaskEntry {
  readonly task: FactoryTaskSummary;
  readonly live: TaskLiveState;
}

export interface TaskPill {
  readonly label: string;
  readonly tone: TaskTone;
  readonly icon: "dot" | "alert" | "eye" | "question";
  readonly elapsed: string | null;
}

const TONES: readonly TaskTone[] = ["danger", "attention", "input", "working", "neutral"];

/** The shared live-state helpers carry a pill's colours as strings; mobile keeps its tone there. */
export function taskLivePill(label: string, tone: TaskTone): FactoryTaskLivePill {
  return { label, colorClass: tone, dotClass: tone, pulse: false };
}

const THREAD_PILLS: Partial<Record<ThreadListV2Status, { label: string; tone: TaskTone }>> = {
  approval: { label: msg("Pending Approval"), tone: "attention" },
  input: { label: msg("Awaiting Input"), tone: "input" },
  request: { label: msg("Request"), tone: "attention" },
  working: { label: msg("Working"), tone: "working" },
  waiting: { label: msg("Waiting"), tone: "neutral" },
  failed: { label: msg("Failed"), tone: "danger" },
  limited: { label: msg("Limited"), tone: "attention" },
};

/** The words the thread list uses for a run's thread, so a task row and its thread agree. */
export function taskThreadPill(status: ThreadListV2Status): FactoryTaskLivePill | null {
  const pill = THREAD_PILLS[status];
  return pill ? taskLivePill(pill.label, pill.tone) : null;
}

function toneOf(pill: FactoryTaskLivePill): TaskTone {
  return TONES.find((tone) => tone === pill.colorClass) ?? "neutral";
}

/** Minutes, hours or days since `startedAt`, as the thread rows write them. */
export function elapsedSince(startedAt: string, now: number, resolve: MessageResolver = m): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started))
    return resolve(msg("<1m", { $context: "compact elapsed time, under one minute" }));
  const minutes = Math.floor(Math.max(0, now - started) / 60_000);
  if (minutes < 1)
    return resolve(msg("<1m", { $context: "compact elapsed time, under one minute" }));
  if (minutes < 60)
    return resolve(
      msg("{count}m", { count: String(minutes), $context: "compact elapsed minutes" }),
    );
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? resolve(msg("{count}h", { count: String(hours), $context: "compact elapsed hours" }))
    : resolve(
        msg("{count}d", {
          count: String(Math.floor(hours / 24)),
          $context: "compact elapsed days",
        }),
      );
}

const NEED_PILLS: Record<FactoryTaskAttentionReason, Omit<TaskPill, "elapsed">> = {
  failed: { label: msg("Failed"), tone: "danger", icon: "alert" },
  lost: { label: msg("Lost"), tone: "danger", icon: "alert" },
  approve: { label: msg("Pending Approval"), tone: "attention", icon: "dot" },
  question: { label: msg("Awaiting Input"), tone: "input", icon: "dot" },
  unconfirmed: { label: msg("Unconfirmed"), tone: "attention", icon: "dot" },
  changed: { label: msg("Changed"), tone: "attention", icon: "eye" },
  plan: { label: msg("Plan ready"), tone: "attention", icon: "eye" },
  review: { label: msg("Review"), tone: "attention", icon: "eye" },
};

export function taskNeedPill(reason: FactoryTaskAttentionReason): TaskPill {
  return { ...NEED_PILLS[reason], elapsed: null };
}

/** The live words come from the run's thread; without one the server's run state answers. */
export function taskStatePill(entry: TaskEntry, now: number): TaskPill {
  const { task, live } = entry;
  const run = live.liveRuns[0];
  if (run) {
    const pill = run.pill;
    const label = pill?.label ?? msg("Working");
    const tone = pill ? toneOf(pill) : "working";
    return {
      label,
      tone,
      icon: "dot",
      elapsed: tone === "working" ? elapsedSince(run.startedAt, now) : null,
    };
  }
  if (task.status === "in-review") return { ...NEED_PILLS.review, elapsed: null };
  const label =
    task.run?.state === "stopping"
      ? msg("Stopping…")
      : task.run?.state === "stopped"
        ? msg("Stopped")
        : msg("In progress");
  return { label, tone: "neutral", icon: "dot", elapsed: null };
}

export interface TaskNeedRow {
  readonly key: string;
  readonly need: FactoryTaskNeed;
  /** Null when the task is not in the loaded set; the row reads it before showing a title. */
  readonly task: FactoryTaskSummary | null;
  readonly pill: TaskPill;
}
export interface TaskGroupRow {
  readonly key: string;
  readonly task: FactoryTaskSummary;
  readonly pill: TaskPill;
}
export interface TasksSections {
  readonly count: number;
  readonly needs: readonly TaskNeedRow[];
  readonly blocking: readonly TaskNeedRow[];
  readonly review: readonly TaskNeedRow[];
  readonly groups: readonly {
    readonly status: "in-progress" | "in-review";
    readonly rows: readonly TaskGroupRow[];
  }[];
}

const GROUPS = ["in-progress", "in-review"] as const;

/**
 * Needs you has one row per ask, most urgent first. A task that has an ask, or carries a
 * sub-task's, is listed there and not again below.
 */
export function buildTasksSections(entries: readonly TaskEntry[], now: number): TasksSections {
  const needs = groupFactoryTaskNeeds(entries.map((entry) => entry.live));
  const byKey = new Map(entries.map((entry) => [factoryTaskKey(entry.task.ref), entry.task]));
  const needRow = (need: FactoryTaskNeed): TaskNeedRow => ({
    key: JSON.stringify([factoryTaskKey(need.ref), need.reason, need.threadId, need.requestId]),
    need,
    task: byKey.get(factoryTaskKey(need.ref)) ?? null,
    pill: taskNeedPill(need.reason),
  });
  const withNeeds = new Set(
    entries
      .filter((entry) => entry.live.attention.length > 0)
      .map((entry) => factoryTaskKey(entry.task.ref)),
  );
  const present = new Set(byKey.keys());
  const topLevel = (task: FactoryTaskSummary) =>
    task.parent === null ||
    !present.has(factoryTaskKey({ ...task.ref, taskId: task.parent.taskId }));
  return {
    count: needs.count,
    needs: needs.rows.map(needRow),
    blocking: needs.blocking.map(needRow),
    review: needs.review.map(needRow),
    groups: GROUPS.map((status) => ({
      status,
      rows: entries
        .filter(
          (entry) =>
            entry.task.status === status &&
            topLevel(entry.task) &&
            !withNeeds.has(factoryTaskKey(entry.task.ref)),
        )
        .map((entry) => ({
          key: factoryTaskKey(entry.task.ref),
          task: entry.task,
          pill: taskStatePill(entry, now),
        })),
    })).filter((group) => group.rows.length > 0),
  };
}

export type TasksListKind =
  | "loading"
  | "none"
  | "offline"
  | "forbidden"
  | "unsupported"
  | "failed"
  | "caught-up"
  | "ready";
export interface TasksListState {
  readonly kind: TasksListKind;
  /** Environments that could not be read while others were. */
  readonly notices: readonly {
    readonly environmentId: EnvironmentId;
    readonly status: Exclude<FactoryTaskOwnerStatus, "current" | "loading">;
  }[];
}

const EMPTY_PRIORITY = ["failed", "offline", "forbidden", "unsupported"] as const;

/**
 * Loading, offline, forbidden, unsupported and failed are different answers, and none of them
 * is an empty list. "Caught up" needs one environment that was actually read.
 */
export function resolveTasksListState(input: {
  readonly owners: readonly {
    readonly environmentId: EnvironmentId;
    readonly status: FactoryTaskOwnerStatus;
  }[];
  readonly rowCount: number;
}): TasksListState {
  const unreadOwners = input.owners.flatMap((owner) =>
    owner.status === "current" || owner.status === "loading"
      ? []
      : [{ environmentId: owner.environmentId, status: owner.status }],
  );
  const notices = [
    ...new Map(unreadOwners.map((notice) => [notice.environmentId, notice])).values(),
  ];
  if (input.owners.length === 0) return { kind: "none", notices: [] };
  if (input.rowCount > 0) return { kind: "ready", notices };
  if (input.owners.some((owner) => owner.status === "loading"))
    return { kind: "loading", notices: [] };
  if (input.owners.some((owner) => owner.status === "current"))
    return { kind: "caught-up", notices };
  const unread = EMPTY_PRIORITY.find((status) =>
    input.owners.some((owner) => owner.status === status),
  );
  return { kind: unread ?? "caught-up", notices: [] };
}

export const TASKS_LIST_COPY: Record<
  Exclude<TasksListKind, "loading" | "ready">,
  { readonly title: string; readonly detail: string }
> = {
  none: {
    title: msg("No environments"),
    detail: msg("Connect an environment to see its tasks."),
  },
  offline: { title: msg("Offline"), detail: msg("Reconnect to see tasks.") },
  forbidden: {
    title: msg("No access"),
    detail: msg("This connection can't read tasks. Ask the owner for read access."),
  },
  unsupported: {
    title: msg("Update the server"),
    detail: msg("This server is too old to list tasks."),
  },
  failed: {
    title: msg("Couldn't load tasks"),
    detail: msg("Pull down to try again."),
  },
  "caught-up": { title: msg("All caught up"), detail: msg("Nothing needs you right now.") },
};

const TASKS_OWNER_NOTICE: Record<TasksListState["notices"][number]["status"], string> = {
  offline: msg("{environment} is offline"),
  forbidden: msg("{environment} can't be read with this connection"),
  unsupported: msg("{environment} is too old to list tasks"),
  failed: msg("{environment} couldn't be read"),
};

export const TONE_CLASSES: Record<
  TaskTone,
  { readonly container: string; readonly text: string; readonly dot: string }
> = {
  danger: {
    container: "bg-adaptive-rose-500-a12-a16",
    text: "text-adaptive-rose-700-300",
    dot: "bg-adaptive-rose-700-300",
  },
  attention: {
    container: "bg-adaptive-amber-500-a12-a16",
    text: "text-adaptive-amber-700-300",
    dot: "bg-adaptive-amber-700-300",
  },
  input: {
    container: "bg-adaptive-indigo-500-a12-a16",
    text: "text-adaptive-indigo-600-300",
    dot: "bg-adaptive-indigo-600-300",
  },
  working: {
    container: "bg-adaptive-sky-500-a12-a16",
    text: "text-adaptive-sky-600-400",
    dot: "bg-adaptive-sky-600-400",
  },
  neutral: {
    container: "bg-adaptive-zinc-500-a12-a16",
    text: "text-adaptive-zinc-600-300",
    dot: "bg-adaptive-zinc-600-300",
  },
};

export type TasksListItem =
  | { readonly type: "header"; readonly key: string; readonly title: string }
  | { readonly type: "need"; readonly key: string; readonly row: TaskNeedRow }
  | { readonly type: "task"; readonly key: string; readonly row: TaskGroupRow };

const GROUP_TITLES = { "in-progress": msg("In progress"), "in-review": msg("In review") } as const;

/** One line for each environment that could not be read while others were. */
export function tasksListNotices(
  state: TasksListState,
  labelOf: (environmentId: EnvironmentId) => string,
  resolve: MessageResolver = m,
): readonly { readonly key: EnvironmentId; readonly text: string }[] {
  return state.notices.map((notice) => ({
    key: notice.environmentId,
    text: resolve(TASKS_OWNER_NOTICE[notice.status], {
      environment: labelOf(notice.environmentId),
    }),
  }));
}

/** G1: Needs you, then In progress, then In review. */
export function buildTasksListItems(
  sections: TasksSections,
  needsIncomplete = false,
  resolve: MessageResolver = m,
): TasksListItem[] {
  return [
    ...(sections.needs.length > 0
      ? [
          {
            type: "header" as const,
            key: "needs",
            title: needsIncomplete
              ? resolve(msg("Needs you · {count}+", { count: String(sections.count) }))
              : resolve(msg("Needs you · {count}", { count: String(sections.count) })),
          },
          ...sections.needs.map((row) => ({ type: "need" as const, key: row.key, row })),
        ]
      : []),
    ...sections.groups.flatMap((group) => [
      { type: "header" as const, key: group.status, title: resolve(GROUP_TITLES[group.status]) },
      ...group.rows.map((row) => ({ type: "task" as const, key: row.key, row })),
    ]),
  ];
}

/** Inbox: only the asks, in the two groups the desktop uses. */
export function buildInboxListItems(
  sections: TasksSections,
  resolve: MessageResolver = m,
): TasksListItem[] {
  const group = (key: string, title: string, rows: readonly TaskNeedRow[]): TasksListItem[] =>
    rows.length === 0
      ? []
      : [
          { type: "header", key, title: resolve(title) },
          ...rows.map((row) => ({ type: "need" as const, key: row.key, row })),
        ];
  return [
    ...group("blocking", msg("Blocking a run"), sections.blocking),
    ...group("review", msg("Ready to review"), sections.review),
  ];
}
