import type { FactoryTaskAttentionReason } from "@t3tools/contracts";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  CircleXIcon,
  DiffIcon,
  FileTextIcon,
  ListChecksIcon,
  LoaderIcon,
  type LucideIcon,
  SquareIcon,
  UsersIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { Button } from "../../ui/button";
import {
  AssigneeChip,
  type AssigneeChipProps,
  Monogram,
  NeedsYouBadge,
  TruncatedText,
} from "./atoms";
import { type KitAction, KitActionButton } from "./banners";
import { LIVE_TONE_CLASSES, type LiveTone } from "./taskVisuals";

/**
 * One ask for the person. `row` is one line with one action, for the Tasks strip and wide lists;
 * the detail truncates first. `stacked` is two lines without a button, for the Inbox list, where
 * the whole row selects.
 */
export function NeedsYouRow({
  reason,
  taskId,
  title,
  detail,
  detailIsCommand = false,
  assignee,
  layout = "row",
  action,
  onOpen,
  selected = false,
}: {
  reason: FactoryTaskAttentionReason;
  taskId: string;
  title: string;
  detail: string;
  detailIsCommand?: boolean;
  assignee: AssigneeChipProps;
  layout?: "row" | "stacked";
  /** The row's one action, such as Answer or Retry. Shown only in the `row` layout. */
  action?: KitAction;
  /** Opens the task (`row`) or selects the row (`stacked`). */
  onOpen?: () => void;
  selected?: boolean;
}) {
  const detailClass = cn(
    "min-w-0 truncate text-muted-foreground",
    detailIsCommand ? "font-mono text-xs" : "text-sm",
  );
  const taskText = `${taskId} ${title}`;
  if (layout === "stacked") {
    return (
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onOpen}
        className={cn(
          "grid w-full min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2.5 text-start outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "bg-accent",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <NeedsYouBadge reason={reason} />
          <span className="min-w-0 truncate text-sm">{taskText}</span>
        </span>
        <span className="row-span-2 flex min-w-0 justify-end">
          <AssigneeChip assignee={assignee} />
        </span>
        <span className={detailClass}>{detail}</span>
      </button>
    );
  }
  return (
    <div className="flex h-11 min-w-0 items-center gap-3 border-b border-border px-3">
      <span className="flex w-24 shrink-0">
        <NeedsYouBadge reason={reason} />
      </span>
      <span className="flex min-w-0 max-w-1/2 shrink-0 text-sm">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 cursor-pointer truncate rounded-sm text-start outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {taskText}
          </button>
        ) : (
          <TruncatedText text={taskText} />
        )}
      </span>
      <span className={cn("flex-1", detailClass)}>{detail}</span>
      <span className="flex max-w-44 shrink-0">
        <AssigneeChip assignee={assignee} />
      </span>
      {action ? <KitActionButton action={action} size="xs" /> : null}
    </div>
  );
}

const RUN_ICONS: Record<LiveTone, LucideIcon> = {
  working: LoaderIcon,
  "awaiting-input": CirclePauseIcon,
  "pending-approval": CirclePauseIcon,
  failed: CircleXIcon,
  "plan-ready": ListChecksIcon,
  completed: CircleCheckIcon,
  guest: UsersIcon,
  neutral: SquareIcon,
};

/**
 * One run in the properties rail: `Run 1 · Claude · Opus`, a detail such as
 * `13m · DESKTOP-CP4EDJH`, and its state word in the thread sidebar's tone.
 */
export function RunRow({
  label,
  detail,
  stateLabel,
  tone,
  onOpen,
}: {
  label: string;
  detail: string;
  stateLabel: string;
  tone: LiveTone;
  onOpen?: () => void;
}) {
  const Icon = RUN_ICONS[tone];
  const text = LIVE_TONE_CLASSES[tone].text;
  const body = (
    <>
      <Icon aria-hidden className={cn("size-4 shrink-0", text)} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{label}</span>
        <span className="truncate text-muted-foreground text-xs">{detail}</span>
      </span>
      <span className={cn("shrink-0 text-xs", text)}>{stateLabel}</span>
    </>
  );
  const className =
    "flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 text-start";
  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        className,
        "cursor-pointer outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

export type ActivityItemProps =
  | { kind: "event"; text: string; author: string; time: string }
  | { kind: "comment"; text: string; author: string; initials: string; time: string }
  | { kind: "agent"; text: string; author: string; time: string }
  | { kind: "question"; text: string; author: string; time: string }
  | {
      kind: "run";
      text: string;
      author: string;
      time: string;
      /** Absent while the run is live. */
      outcome?: "completed" | "failed" | "stopped";
      /** A short monospace excerpt from the run, such as the failing command. */
      excerpt?: string;
      onOpen?: () => void;
    };

function ActivityByline({ author, time }: { author: string; time: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="min-w-0 truncate font-medium text-sm">{author}</span>
      <span className="shrink-0 text-muted-foreground text-xs">{time}</span>
    </span>
  );
}

const RUN_OUTCOME_ICONS: Record<
  "live" | "completed" | "failed" | "stopped",
  { Icon: LucideIcon; className: string }
> = {
  live: { Icon: CirclePlayIcon, className: LIVE_TONE_CLASSES.working.text },
  completed: { Icon: CircleCheckIcon, className: LIVE_TONE_CLASSES.completed.text },
  failed: { Icon: CircleXIcon, className: LIVE_TONE_CLASSES.failed.text },
  stopped: { Icon: SquareIcon, className: LIVE_TONE_CLASSES.neutral.text },
};

/** One entry in a task's Activity. */
export function ActivityItem(props: ActivityItemProps) {
  switch (props.kind) {
    case "event":
      return (
        <div className="flex min-w-0 items-center gap-3 py-1.5 ps-1 text-xs">
          <span aria-hidden className="size-1 shrink-0 rounded-full bg-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{props.text}</span>
          <span className="shrink-0 text-muted-foreground">{props.author}</span>
          <span className="shrink-0 text-muted-foreground">{props.time}</span>
        </div>
      );
    case "comment":
      return (
        <div className="flex min-w-0 gap-3 py-1.5">
          <Monogram text={props.initials} size="md" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <ActivityByline author={props.author} time={props.time} />
            <p className="whitespace-pre-wrap break-words text-sm">{props.text}</p>
          </div>
        </div>
      );
    case "agent":
      return (
        <div className="flex min-w-0 gap-3 py-1.5">
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-muted-foreground"
          >
            <BotIcon className="size-3.5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <ActivityByline author={props.author} time={props.time} />
            <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-card px-3 py-2 text-sm">
              {props.text}
            </p>
          </div>
        </div>
      );
    case "question":
      return (
        <div className="flex min-w-0 gap-3 rounded-lg border border-warning/48 bg-warning-surface px-3 py-2.5">
          <CircleHelpIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate font-medium text-warning-foreground text-xs">
                {props.author}
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">{props.time}</span>
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">{props.text}</p>
          </div>
        </div>
      );
    case "run": {
      const outcome = RUN_OUTCOME_ICONS[props.outcome ?? "live"];
      const line = (
        <>
          <outcome.Icon aria-hidden className={cn("size-4 shrink-0", outcome.className)} />
          <span className="shrink-0 font-medium text-sm">{props.author}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
            {props.text}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs">{props.time}</span>
          {props.onOpen ? (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
        </>
      );
      const lineClass = "flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-start";
      return (
        <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
          {props.onOpen ? (
            <button
              type="button"
              onClick={props.onOpen}
              className={cn(
                lineClass,
                "cursor-pointer outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              )}
            >
              {line}
            </button>
          ) : (
            <div className={lineClass}>{line}</div>
          )}
          {props.excerpt ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-all border-t border-border bg-background px-3 py-2 font-mono text-muted-foreground text-xs">
              {props.excerpt}
            </pre>
          ) : null}
        </div>
      );
    }
  }
}

const RESULT_ICONS: Record<"pull-request" | "document" | "code", LucideIcon> = {
  "pull-request": PullRequestGlyph.pullRequest,
  document: FileTextIcon,
  code: DiffIcon,
};

/**
 * What the task produced. Pending shows Accept and Request changes; accepted shows the Accepted
 * chip. `showActions={false}` hides the buttons, as on the Result tab.
 */
export function ResultCard({
  kind,
  title,
  meta,
  review,
  revisionLabel,
  showActions = true,
  pending = false,
  onAccept,
  onRequestChanges,
}: {
  kind: "pull-request" | "document" | "code";
  title: string;
  meta: string;
  review: "pending" | "accepted";
  /** Which revision the chip names, such as `rev 2`. */
  revisionLabel: string;
  showActions?: boolean;
  pending?: boolean;
  onAccept?: () => void;
  onRequestChanges?: () => void;
}) {
  const Icon = RESULT_ICONS[kind];
  const tone = review === "pending" ? LIVE_TONE_CLASSES["plan-ready"] : LIVE_TONE_CLASSES.completed;
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-muted-foreground"
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <TruncatedText text={title} className="font-medium text-sm" />
        <span className="truncate text-muted-foreground text-xs">{meta}</span>
      </div>
      <span
        className={cn(
          "inline-flex h-4.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 font-medium text-xs",
          tone.surface,
          tone.text,
        )}
      >
        {review === "pending" ? (
          <span aria-hidden className={cn("size-1.5 rounded-full", tone.dot)} />
        ) : (
          <CheckIcon aria-hidden className="size-3" />
        )}
        {review === "pending" ? "Needs review" : "Accepted"}
        <span aria-hidden>·</span>
        {revisionLabel}
      </span>
      {showActions && review === "pending" && (onAccept || onRequestChanges) ? (
        <div className="flex shrink-0 items-center gap-2">
          {onAccept ? (
            <Button size="sm" disabled={pending} onClick={onAccept}>
              Accept
            </Button>
          ) : null}
          {onRequestChanges ? (
            <Button variant="outline" size="sm" disabled={pending} onClick={onRequestChanges}>
              Request changes
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
