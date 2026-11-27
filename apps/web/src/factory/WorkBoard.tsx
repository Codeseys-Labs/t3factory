import type { FactoryTaskKind } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { msg, Plural, T, useGT, useMessages, Var } from "gt-react";
import { memo, useEffect, useId, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  type AttentionItem,
  type AttentionKind,
  groupWorkCards,
  WORK_COLUMN_DEFINITIONS,
  WORK_COLUMNS,
  type WorkBadge,
  type WorkCard,
  type WorkColumn,
} from "./workBoard.logic";
import { nextAttentionFocus } from "./workDetail.logic";

export const WORK_COLUMN_LABELS: Record<WorkColumn, string> = {
  backlog: msg("Backlog", { $context: "work board column: tasks not yet ready" }),
  ready: msg("Ready", { $context: "work board column: tasks ready to start" }),
  doing: msg("Doing", { $context: "work board column: tasks under way" }),
  review: msg("Review", { $context: "work board column: tasks in review" }),
  done: msg("Done", { $context: "work board column: finished tasks" }),
};

const BADGE_LABELS: Record<WorkBadge, string> = {
  "needs-you": msg("Needs you", { $context: "task badge: its run waits on a person" }),
  failed: msg("Failed", { $context: "task badge: a step of its run failed and paused it" }),
  blocked: msg("Blocked", { $context: "task badge: a task it waits on is not done" }),
  stopped: msg("Stopped", { $context: "task badge: its run was stopped" }),
};

const BADGE_VARIANTS = {
  "needs-you": "warning",
  failed: "error",
  blocked: "secondary",
  stopped: "outline",
} as const satisfies Record<WorkBadge, string>;

export const TASK_KIND_LABELS: Record<FactoryTaskKind, string> = {
  software: msg("Software", { $context: "kind of task: work that changes code" }),
  knowledge: msg("Knowledge", { $context: "kind of task: work that produces a written brief" }),
  research: msg("Research", { $context: "kind of task: work that runs an experiment" }),
};

const ATTENTION_LABELS: Record<AttentionKind, string> = {
  "approve-plan": msg("Approve plan", {
    $context: "a task's plan waits on the user to approve it",
  }),
  "approve-merge": msg("Merge", {
    $context: "a task's pull request waits on the user to approve merging it",
  }),
  accept: msg("Accept", { $context: "a task's result waits on the user to accept it" }),
  stuck: msg("Review stuck", {
    $context: "a task's review did not pass, so it waits on the user",
  }),
  failed: msg("Failed", { $context: "a failing step paused a task's run" }),
  question: msg("Question", { $context: "a task's run asks the user something" }),
};

/** How many cards a column, or rows the list, shows at first and adds each time. */
export const WORK_PAGE_SIZE = 50;

/** How a task is named everywhere: `T-` and its number. */
export const taskNumber = (task: { readonly number: number }) => `T-${task.number}`;

/** Whether two cards show the same thing, so a card re-renders only when its own task changed. */
export const sameWorkCard = (left: WorkCard, right: WorkCard) =>
  left.task.rev === right.task.rev &&
  left.task.updatedAt === right.task.updatedAt &&
  left.task.kind === right.task.kind &&
  left.column === right.column &&
  left.rolledUp === right.rolledUp &&
  left.badges.join() === right.badges.join() &&
  left.run?.status === right.run?.status &&
  left.childCount === right.childCount &&
  left.openBlockers.length === right.openBlockers.length &&
  left.activity === right.activity &&
  left.liveParts === right.liveParts;

/** What a card's run is doing, while nothing on it waits on a person. */
export const shownActivity = (card: WorkCard) =>
  card.badges.some((badge) => badge === "needs-you" || badge === "failed") ? null : card.activity;

export function WorkActivity({ activity }: { readonly activity: WorkCard["activity"] }) {
  if (activity === null) return null;
  return activity === "working" ? (
    <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-info-foreground">
      <span aria-hidden className="size-1.5 rounded-full bg-info" />
      <T context="task status: an agent is at work on it">Working</T>
    </span>
  ) : (
    <span className="shrink-0 text-xs text-muted-foreground">
      <T context="task status: its run waits, and nothing waits on a person">Waiting</T>
    </span>
  );
}

/** A card's column comes from its run until the run list arrives to say otherwise. */
export const waitsOnRun = (card: WorkCard) => card.run === null && card.task.attempt?.runId != null;

export function WorkBadges({
  badges,
  wrap = false,
}: {
  readonly badges: ReadonlyArray<WorkBadge>;
  /** Lets the badges break onto more lines instead of keeping their full width. */
  readonly wrap?: boolean;
}) {
  const m = useMessages();
  if (badges.length === 0) return null;
  return (
    <span className={cn("flex items-center gap-1", wrap ? "min-w-0 flex-wrap" : "shrink-0")}>
      {badges.map((badge) => (
        <Badge key={badge} size="sm" variant={BADGE_VARIANTS[badge]}>
          {m(BADGE_LABELS[badge])}
        </Badge>
      ))}
    </span>
  );
}

/** A chip naming a task's kind, shown for every kind but the default, software. */
export function WorkKind({ kind }: { readonly kind: FactoryTaskKind | undefined }) {
  const m = useMessages();
  if (kind === undefined || kind === "software") return null;
  return (
    <Badge size="sm" variant="outline">
      {m(TASK_KIND_LABELS[kind])}
    </Badge>
  );
}

/** Every item the shown tasks wait on a person for, oldest first, above any of their layouts. */
export function WorkNeedsYou({
  items,
  held,
  onOpenItem,
  onOpenRun,
}: {
  readonly items: ReadonlyArray<AttentionItem>;
  /** Stays shown with no items, so focus has its heading to come back to. */
  readonly held: boolean;
  readonly onOpenItem: (item: AttentionItem) => void;
  readonly onOpenRun: (runId: string) => void;
}) {
  const m = useMessages();
  // The item opened last from here, so "Next item needing me" moves on past it.
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  // Focus is in the strip, so an emptied strip stays for it to land on.
  const [ownsFocus, setOwnsFocus] = useState(false);
  // The row holding focus, and the keys as last shown, to move focus on when that row's item goes.
  const focusedKey = useRef<string | null>(null);
  const shownKeys = useRef<ReadonlyArray<string>>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the browser drops DOM focus to the page when the focused row's item goes; this moves it to the next row or the heading
  useEffect(() => {
    const before = shownKeys.current;
    const after = items.map((item) => item.key);
    shownKeys.current = after;
    const current = focusedKey.current;
    if (current === null || after.includes(current)) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      focusedKey.current = null;
      return;
    }
    const next = nextAttentionFocus(before, after, current);
    focusedKey.current = next;
    focusAttention(next);
  }, [items]);
  if (items.length === 0 && !held && !ownsFocus) return null;
  const open = (item: AttentionItem) => {
    setLastOpened(item.key);
    onOpenItem(item);
  };
  const next =
    items.length === 0
      ? null
      : items[(items.findIndex((item) => item.key === lastOpened) + 1) % items.length]!;
  return (
    <section
      className="shrink-0 border-b"
      onFocus={() => setOwnsFocus(true)}
      onBlur={(event) => {
        const to = event.relatedTarget;
        if (to instanceof Node && event.currentTarget.contains(to)) return;
        // Another window took focus; it comes back here.
        if (to === null && !document.hasFocus()) return;
        setOwnsFocus(false);
        // Toward nothing can be a focused row whose item went; the effect needs its key.
        if (to !== null) focusedKey.current = null;
      }}
    >
      <div className="flex items-center gap-2 px-4 pt-2 pb-1">
        <h2
          data-work-attention-heading
          tabIndex={-1}
          className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-muted-foreground outline-none"
          onFocus={() => {
            focusedKey.current = null;
          }}
        >
          <T context="the items whose tasks wait on the user">Needs you</T>
          <span className="tabular-nums">{items.length}</span>
        </h2>
        {next === null ? null : (
          <Button
            size="xs"
            variant="outline"
            onFocus={() => {
              focusedKey.current = null;
            }}
            onClick={() => open(next)}
          >
            <T>Next item needing me</T>
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-4 pb-2 text-xs text-muted-foreground">
          <T>Nothing needs you now.</T>
        </p>
      ) : (
        <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto px-4 pb-2">
          {items.map((item) => (
            <li
              key={item.key}
              className="flex min-w-0 items-center gap-2 text-sm"
              onFocus={() => {
                focusedKey.current = item.key;
              }}
            >
              <Badge size="sm" variant={item.kind === "failed" ? "error" : "warning"}>
                {m(ATTENTION_LABELS[item.kind])}
              </Badge>
              <button
                type="button"
                data-work-attention={item.key}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset"
                onClick={() => open(item)}
              >
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {taskNumber({ number: item.taskNumber })}
                </span>
                <span className="min-w-0 max-w-64 truncate">{item.taskTitle}</span>
                {item.detail === null ? null : (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {item.detail}
                  </span>
                )}
              </button>
              <Button size="xs" variant="ghost" onClick={() => onOpenRun(item.runId)}>
                <T context="verb, opens the workflow run that waits on the user">Open run</T>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Moves focus to the Needs you row with that key, or to the strip's heading for null. */
export function focusAttention(key: string | null): boolean {
  const target = document.querySelector<HTMLElement>(
    key === null ? "[data-work-attention-heading]" : `[data-work-attention="${CSS.escape(key)}"]`,
  );
  target?.focus();
  return target !== null;
}

/** The five columns, each with its count and what it means. */
export function WorkBoard({
  cards,
  projectNames,
  selectedTaskId,
  runsPending,
  onOpenTask,
}: {
  readonly cards: ReadonlyArray<WorkCard>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly selectedTaskId: string | null;
  /** Workflows are on and their runs have not arrived, so run-derived columns are not final. */
  readonly runsPending: boolean;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const id = useId();
  const [limits, setLimits] = useState<Partial<Record<WorkColumn, number>>>({});
  const columns = groupWorkCards(cards);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <ScrollArea>
          <div className="flex min-h-full min-w-0 flex-col gap-3 p-4 md:min-w-240 md:flex-row">
            {WORK_COLUMNS.map((column) => {
              const all = columns[column];
              const limit = limits[column] ?? WORK_PAGE_SIZE;
              const hidden = all.length - limit;
              const label = m(WORK_COLUMN_LABELS[column]);
              const definition = m(WORK_COLUMN_DEFINITIONS[column]);
              return (
                <section
                  key={column}
                  aria-label={label}
                  aria-describedby={`${id}-${column}`}
                  className="flex min-w-0 flex-col gap-2 md:min-w-44 md:flex-1 md:basis-0"
                >
                  <h2 className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            tabIndex={0}
                            className="rounded-sm focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset"
                          />
                        }
                      >
                        {label}
                      </TooltipTrigger>
                      <TooltipPopup side="top">{definition}</TooltipPopup>
                    </Tooltip>
                    <span className="tabular-nums">{all.length}</span>
                    <span id={`${id}-${column}`} hidden>
                      {definition}
                    </span>
                  </h2>
                  {all.length === 0 ? (
                    <p className="px-1 text-xs text-muted-foreground">
                      <T>No tasks</T>
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {all.slice(0, limit).map((card) => (
                        <WorkCardItem
                          key={card.task.id}
                          card={card}
                          projectName={
                            card.task.projectId === null
                              ? null
                              : (projectNames.get(card.task.projectId) ?? null)
                          }
                          current={card.task.id === selectedTaskId}
                          runPending={runsPending && waitsOnRun(card)}
                          onOpen={onOpenTask}
                        />
                      ))}
                    </ul>
                  )}
                  {hidden <= 0 ? null : (
                    <div className="flex justify-center">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setLimits({ ...limits, [column]: limit + WORK_PAGE_SIZE })}
                      >
                        {gt("Show {count} more", { count: Math.min(hidden, WORK_PAGE_SIZE) })}
                      </Button>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

interface WorkCardItemProps {
  readonly card: WorkCard;
  readonly projectName: string | null;
  readonly current: boolean;
  readonly runPending: boolean;
  readonly onOpen: (taskId: string) => void;
}

const WorkCardItem = memo(
  function WorkCardItem({ card, projectName, current, runPending, onOpen }: WorkCardItemProps) {
    const { task } = card;
    const blockers = card.openBlockers.length;
    return (
      <li>
        <button
          type="button"
          data-work-task={task.id}
          aria-current={current ? "true" : undefined}
          className={cn(
            "flex w-full cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset",
            current ? "bg-accent" : "bg-background hover:bg-accent/50",
          )}
          onClick={() => onOpen(task.id)}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0 font-mono">{taskNumber(task)}</span>
            <WorkKind kind={task.kind} />
            <span className="min-w-0 flex-1 truncate">{projectName}</span>
            <WorkActivity activity={shownActivity(card)} />
          </span>
          <span className="text-sm wrap-anywhere text-foreground">{task.title}</span>
          <WorkBadges badges={card.badges} wrap />
          {task.model === null &&
          card.childCount === 0 &&
          blockers === 0 &&
          !runPending &&
          card.rolledUp !== true ? null : (
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              {card.rolledUp === true ? (
                <span className="shrink-0">
                  <T context="a parent task's column comes from its subtasks' columns">
                    From children
                  </T>
                </span>
              ) : null}
              {runPending ? (
                <span className="shrink-0">
                  <T context="a task's column waits on its workflow run to load">
                    Checking its run…
                  </T>
                </span>
              ) : null}
              {task.model === null ? null : (
                <span className="min-w-0 truncate">{formatModelSlugName(task.model.model)}</span>
              )}
              {card.childCount === 0 ? null : (
                <span className="shrink-0">
                  <T>
                    <Plural
                      n={card.childCount}
                      one={
                        <>
                          <Var>{card.childCount}</Var> subtask
                        </>
                      }
                      other={
                        <>
                          <Var>{card.childCount}</Var> subtasks
                        </>
                      }
                    />
                  </T>
                </span>
              )}
              {blockers === 0 ? null : (
                <span className="shrink-0">
                  <T>
                    <Plural
                      n={blockers}
                      one={
                        <>
                          <Var>{blockers}</Var> open blocker
                        </>
                      }
                      other={
                        <>
                          <Var>{blockers}</Var> open blockers
                        </>
                      }
                    />
                  </T>
                </span>
              )}
            </span>
          )}
        </button>
      </li>
    );
  },
  (previous, next) =>
    sameWorkCard(previous.card, next.card) &&
    previous.projectName === next.projectName &&
    previous.current === next.current &&
    previous.runPending === next.runPending &&
    previous.onOpen === next.onOpen,
);
