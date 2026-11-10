import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type {
  FactoryTaskAttentionReason,
  FactoryTaskSourceKind,
  FactoryTaskStatus,
  FactoryTaskType,
} from "@t3tools/contracts";
import { CircleDashedIcon, FolderIcon, LockIcon, SparklesIcon, UserIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Badge } from "../../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  ATTENTION_VISUALS,
  LIVE_TONE_CLASSES,
  type LiveTone,
  SOURCE_ICONS,
  TASK_STATUS_VISUALS,
  TASK_TYPE_LABELS,
} from "./taskVisuals";

/** One line of text that truncates and shows the whole text on hover or focus. */
export function TruncatedText({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("min-w-0 truncate", className)} />}>
        {text}
      </TooltipTrigger>
      <TooltipPopup side="top">{text}</TooltipPopup>
    </Tooltip>
  );
}

export function TaskStatusIcon({
  status,
  className,
}: {
  status: FactoryTaskStatus;
  className?: string;
}) {
  const visual = TASK_STATUS_VISUALS[status];
  return (
    <visual.Icon
      role="img"
      aria-label={visual.label}
      className={cn("size-3.5 shrink-0", visual.iconClass, className)}
    />
  );
}

export function TaskStatusLabel({ status }: { status: FactoryTaskStatus }) {
  const visual = TASK_STATUS_VISUALS[status];
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-sm", visual.labelClass)}>
      <visual.Icon aria-hidden className={cn("size-3.5 shrink-0", visual.iconClass)} />
      <span className="truncate">{visual.label}</span>
    </span>
  );
}

/**
 * What a run is doing now. `label` is the thread sidebar's word (Working, Awaiting Input, …);
 * pulse follows the sidebar's Working dot, a stepped blink that rests between frames.
 */
export function LivePill({
  label,
  tone,
  duration,
  pulse,
}: {
  label: string;
  tone: LiveTone;
  duration?: string;
  /** Defaults to on for `working`. */
  pulse?: boolean;
}) {
  const classes = LIVE_TONE_CLASSES[tone];
  const pulsing = pulse ?? tone === "working";
  return (
    <span
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 font-medium text-xs",
        classes.surface,
        classes.text,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          classes.dot,
          pulsing && "motion-safe:animate-status-pulse",
        )}
      />
      {label}
      {duration ? <span className="font-normal tabular-nums opacity-70">{duration}</span> : null}
    </span>
  );
}

export function NeedsYouBadge({ reason }: { reason: FactoryTaskAttentionReason }) {
  const visual = ATTENTION_VISUALS[reason];
  return (
    <Badge variant={visual.variant}>
      <visual.Icon aria-hidden />
      {visual.label}
    </Badge>
  );
}

export function BlockedBadge({ blockerId }: { blockerId: string }) {
  return (
    <Badge variant="muted">
      <LockIcon aria-hidden />
      Blocked by {blockerId}
    </Badge>
  );
}

/** Two letters in a circle: an agent's harness (`Cx`) or a person's initials (`BB`). */
export function Monogram({
  text,
  size = "sm",
  tone = "default",
}: {
  text: string;
  size?: "sm" | "md";
  tone?: "default" | "auto";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium text-3xs leading-none",
        size === "sm" ? "size-4" : "size-6",
        tone === "auto" ? "bg-primary/16 text-primary" : "bg-foreground/[0.08] text-foreground/80",
      )}
    >
      {text}
    </span>
  );
}

export type AssigneeChipProps =
  | { kind: "agent"; label: string; mono: string }
  | { kind: "auto"; label?: string }
  | { kind: "unassigned" }
  | { kind: "person"; label: string };

export function assigneeText(assignee: AssigneeChipProps): string {
  switch (assignee.kind) {
    case "agent":
    case "person":
      return assignee.label;
    case "auto":
      return assignee.label ? `Auto → ${assignee.label}` : "Auto";
    case "unassigned":
      return "Unassigned";
  }
}

/**
 * Who does the task. Pass `render={<button type="button" />}` to make it a control, such as the
 * Assignee picker's trigger.
 */
export function AssigneeChip({
  assignee,
  render,
  ...props
}: { assignee: AssigneeChipProps } & useRender.ComponentProps<"span">) {
  const text = assigneeText(assignee);
  const leading =
    assignee.kind === "agent" ? (
      <Monogram text={assignee.mono} />
    ) : assignee.kind === "auto" ? (
      <SparklesIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
    ) : assignee.kind === "person" ? (
      <UserIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <CircleDashedIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    );
  const merged = mergeProps<"span">(
    {
      className: cn(
        "inline-flex h-5 min-w-0 max-w-full shrink items-center gap-1.5 rounded-full border border-border ps-0.5 pe-2 text-xs outline-none",
        assignee.kind === "unassigned" ? "text-muted-foreground" : "text-foreground",
        assignee.kind !== "agent" && "ps-1",
        "[button&]:cursor-pointer [button&]:hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      ),
    },
    props,
  );
  // A wrapping trigger (render={<AssigneeChip … />}) passes `children: undefined`; the chip owns its content.
  return useRender({
    defaultTagName: "span",
    render,
    props: {
      ...merged,
      children: (
        <>
          {leading}
          <span className="min-w-0 truncate">{text}</span>
        </>
      ),
    },
  });
}

export function ProjectChip({ name }: { name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
      <FolderIcon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

/** Where a task came from. `label` is display text such as `GitHub #96` or `Mondays 09:00`. */
export function SourceChip({ kind, label }: { kind: FactoryTaskSourceKind; label: string }) {
  const Icon = SOURCE_ICONS[kind];
  return (
    <Badge variant="muted-outline">
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}

export function TypeTag({ type }: { type: FactoryTaskType }) {
  return <Badge variant="muted">{TASK_TYPE_LABELS[type]}</Badge>;
}

export function TaskIdText({ id }: { id: string }) {
  return (
    <span className="shrink-0 whitespace-nowrap text-muted-foreground text-xs tabular-nums">
      {id}
    </span>
  );
}

/** Sub-task progress on a parent: `2 of 4` with its bar. */
export function TaskProgress({ done, total }: { done: number; total: number }) {
  const fraction = total > 0 ? Math.min(done, total) / total : 0;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs tabular-nums">
      <span
        role="progressbar"
        aria-label="Sub-tasks done"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(done, total)}
        aria-valuetext={`${done} of ${total}`}
        className="relative h-1 w-10 overflow-hidden rounded-full bg-foreground/10"
      >
        <span
          className="absolute inset-y-0 start-0 rounded-full bg-success"
          style={{ width: `${fraction * 100}%` }}
        />
      </span>
      <span aria-hidden>
        {done} of {total}
      </span>
    </span>
  );
}

/** A number on a nav row or column header. `attention` means something needs you. */
export function CountBadge({
  count,
  tone = "neutral",
}: {
  count: number;
  tone?: "attention" | "neutral";
}) {
  return (
    <Badge variant={tone === "attention" ? "warning" : "muted"} size="sm">
      {count}
    </Badge>
  );
}
