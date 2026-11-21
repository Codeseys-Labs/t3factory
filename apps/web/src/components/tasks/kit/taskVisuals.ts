import type {
  FactoryTaskAttentionReason,
  FactoryTaskSourceKind,
  FactoryTaskStatus,
  FactoryTaskType,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import {
  CalendarClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleIcon,
  CirclePlayIcon,
  CircleXIcon,
  EyeIcon,
  HistoryIcon,
  ListChecksIcon,
  type LucideIcon,
  RssIcon,
  ShieldCheckIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";

import type { ThreadStatusPill } from "../../Sidebar.logic";

// Hues match resolveThreadStatusPill so a task and its run's thread read the same.
const HUE = {
  sky: "text-sky-600 dark:text-sky-300/80",
  indigo: "text-indigo-600 dark:text-indigo-300/90",
  amber: "text-amber-600 dark:text-amber-300/90",
  red: "text-red-600 dark:text-red-300/90",
  violet: "text-violet-600 dark:text-violet-300/90",
  emerald: "text-emerald-600 dark:text-emerald-300/90",
  guest: "text-guest-foreground",
  muted: "text-muted-foreground",
  foreground: "text-foreground",
} as const;

export const TASK_STATUS_VISUALS: Record<
  FactoryTaskStatus,
  { label: string; Icon: LucideIcon; iconClass: string; labelClass: string }
> = {
  backlog: {
    label: msg("Backlog", { $context: "task status" }),
    Icon: CircleDashedIcon,
    iconClass: HUE.muted,
    labelClass: HUE.muted,
  },
  ready: {
    label: msg("Ready", { $context: "task status" }),
    Icon: CircleIcon,
    iconClass: HUE.foreground,
    labelClass: HUE.foreground,
  },
  "in-progress": {
    label: msg("In progress", { $context: "task status" }),
    Icon: CirclePlayIcon,
    iconClass: HUE.sky,
    labelClass: HUE.foreground,
  },
  "in-review": {
    label: msg("In review", { $context: "task status" }),
    Icon: EyeIcon,
    iconClass: HUE.violet,
    labelClass: HUE.foreground,
  },
  done: {
    label: msg("Done", { $context: "task status" }),
    Icon: CircleCheckIcon,
    iconClass: HUE.emerald,
    labelClass: HUE.foreground,
  },
  canceled: {
    label: msg("Canceled", { $context: "task status" }),
    Icon: CircleXIcon,
    iconClass: HUE.muted,
    labelClass: HUE.muted,
  },
};

export const ATTENTION_VISUALS: Record<
  FactoryTaskAttentionReason,
  { label: string; Icon: LucideIcon; variant: "warning" | "error" }
> = {
  question: {
    label: msg("Question", { $context: "attention reason" }),
    Icon: CircleHelpIcon,
    variant: "warning",
  },
  approve: {
    label: msg("Approve", { $context: "attention reason" }),
    Icon: ShieldCheckIcon,
    variant: "warning",
  },
  review: {
    label: msg("Review", { $context: "attention reason" }),
    Icon: EyeIcon,
    variant: "warning",
  },
  plan: {
    label: msg("Plan", { $context: "attention reason" }),
    Icon: ListChecksIcon,
    variant: "warning",
  },
  changed: {
    label: msg("Changed", { $context: "attention reason" }),
    Icon: HistoryIcon,
    variant: "warning",
  },
  unconfirmed: {
    label: msg("Unconfirmed", { $context: "attention reason" }),
    Icon: CircleAlertIcon,
    variant: "warning",
  },
  lost: {
    label: msg("Lost", { $context: "attention reason" }),
    Icon: UnplugIcon,
    variant: "error",
  },
  failed: {
    label: msg("Failed", { $context: "attention reason" }),
    Icon: TriangleAlertIcon,
    variant: "error",
  },
};

export const SOURCE_ICONS: Record<FactoryTaskSourceKind, LucideIcon> = {
  local: SquarePenIcon,
  issue: CircleDotIcon,
  feed: RssIcon,
  schedule: CalendarClockIcon,
};

export const TASK_TYPE_LABELS: Record<FactoryTaskType, string> = {
  task: msg("Task", { $context: "task type" }),
  bug: msg("Bug", { $context: "task type" }),
  feature: msg("Feature", { $context: "task type" }),
  docs: msg("Docs", { $context: "task type" }),
  research: msg("Research", { $context: "task type" }),
};

/** The thread sidebar's live tones, plus `neutral` for Stopping, Queued and Waiting. */
export type LiveTone =
  | "working"
  | "awaiting-input"
  | "pending-approval"
  | "failed"
  | "plan-ready"
  | "completed"
  | "guest"
  | "neutral";

export const LIVE_TONE_CLASSES: Record<LiveTone, { text: string; dot: string; surface: string }> = {
  working: {
    text: HUE.sky,
    dot: "bg-sky-500 dark:bg-sky-300/80",
    surface: "bg-sky-500/8 dark:bg-sky-300/10",
  },
  "awaiting-input": {
    text: HUE.indigo,
    dot: "bg-indigo-500 dark:bg-indigo-300/90",
    surface: "bg-indigo-500/8 dark:bg-indigo-300/10",
  },
  "pending-approval": {
    text: HUE.amber,
    dot: "bg-amber-500 dark:bg-amber-300/90",
    surface: "bg-amber-500/8 dark:bg-amber-300/10",
  },
  failed: {
    text: HUE.red,
    dot: "bg-red-500 dark:bg-red-300/90",
    surface: "bg-red-500/8 dark:bg-red-300/10",
  },
  "plan-ready": {
    text: HUE.violet,
    dot: "bg-violet-500 dark:bg-violet-300/90",
    surface: "bg-violet-500/8 dark:bg-violet-300/10",
  },
  completed: {
    text: HUE.emerald,
    dot: "bg-emerald-500 dark:bg-emerald-300/90",
    surface: "bg-emerald-500/8 dark:bg-emerald-300/10",
  },
  guest: { text: HUE.guest, dot: "bg-guest", surface: "bg-guest-surface" },
  neutral: {
    text: HUE.muted,
    dot: "bg-muted-foreground",
    surface: "bg-foreground/[0.06]",
  },
};

const THREAD_STATUS_TONES: Record<ThreadStatusPill["label"], LiveTone> = {
  Working: "working",
  Connecting: "working",
  "Awaiting Input": "awaiting-input",
  "Pending Approval": "pending-approval",
  Failed: "failed",
  "Plan Ready": "plan-ready",
  Completed: "completed",
  "Guest Request": "guest",
  Waiting: "neutral",
};

/** The tone for a pill from `resolveThreadStatusPill`, so a run reads as its thread does. */
export function liveToneForThreadStatus(label: ThreadStatusPill["label"]): LiveTone {
  return THREAD_STATUS_TONES[label] ?? "neutral";
}
