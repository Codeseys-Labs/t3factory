import { formatModelSlugName } from "@t3tools/shared/model";
import { msg, Plural, T, useGT, useMessages, Var } from "gt-react";
import { memo, useState } from "react";

import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  groupWorkCards,
  WORK_COLUMNS,
  type WorkBadge,
  type WorkCard,
  type WorkColumn,
} from "./workBoard.logic";

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

/** How many cards a column, or rows the list, shows at first and adds each time. */
export const WORK_PAGE_SIZE = 50;

/** How a task is named everywhere: `T-` and its number. */
export const taskNumber = (task: { readonly number: number }) => `T-${task.number}`;

/** Whether two cards show the same thing, so a card re-renders only when its own task changed. */
export const sameWorkCard = (left: WorkCard, right: WorkCard) =>
  left.task.rev === right.task.rev &&
  left.task.updatedAt === right.task.updatedAt &&
  left.column === right.column &&
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

/** What waits on a person above the five columns, each column with its count. */
export function WorkBoard({
  cards,
  projectNames,
  selectedTaskId,
  runsPending,
  onOpenTask,
  onOpenRun,
}: {
  readonly cards: ReadonlyArray<WorkCard>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly selectedTaskId: string | null;
  /** Workflows are on and their runs have not arrived, so run-derived columns are not final. */
  readonly runsPending: boolean;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [limits, setLimits] = useState<Partial<Record<WorkColumn, number>>>({});
  const needsYou = cards.filter((card) =>
    card.badges.some((badge) => badge === "needs-you" || badge === "failed"),
  );
  const columns = groupWorkCards(cards);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {needsYou.length === 0 ? null : (
        <section className="shrink-0 border-b">
          <h2 className="px-4 pt-2 pb-1 text-xs font-medium text-muted-foreground">
            <T context="tasks whose runs wait on the user">Needs you</T>
          </h2>
          <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto px-4 pb-2">
            {needsYou.map((card) => (
              <NeedsYouRow key={card.task.id} card={card} onOpenRun={onOpenRun} />
            ))}
          </ul>
        </section>
      )}
      <div className="min-h-0 flex-1">
        <ScrollArea>
          {/* 60rem is five 11rem columns with their gaps and padding; narrower, the row scrolls. */}
          <div className="flex min-h-full min-w-240 gap-3 p-4">
            {WORK_COLUMNS.map((column) => {
              const all = columns[column];
              const limit = limits[column] ?? WORK_PAGE_SIZE;
              const hidden = all.length - limit;
              return (
                <section
                  key={column}
                  aria-label={m(WORK_COLUMN_LABELS[column])}
                  className="flex min-w-44 flex-1 basis-0 flex-col gap-2"
                >
                  <h2 className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
                    <span>{m(WORK_COLUMN_LABELS[column])}</span>
                    <span className="tabular-nums">{all.length}</span>
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

function NeedsYouRow({
  card,
  onOpenRun,
}: {
  readonly card: WorkCard;
  readonly onOpenRun: (runId: string) => void;
}) {
  const { run, task } = card;
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      <WorkBadges
        badges={card.badges.filter((badge) => badge === "needs-you" || badge === "failed")}
      />
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{taskNumber(task)}</span>
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      {run === null ? null : (
        <Button size="xs" variant="outline" onClick={() => onOpenRun(run.runId)}>
          <T context="verb, opens the task's workflow run">Open</T>
        </Button>
      )}
    </li>
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
            <span className="min-w-0 flex-1 truncate">{projectName}</span>
            <WorkActivity activity={shownActivity(card)} />
          </span>
          <span className="text-sm wrap-anywhere text-foreground">{task.title}</span>
          <WorkBadges badges={card.badges} wrap />
          {task.model === null && card.childCount === 0 && blockers === 0 && !runPending ? null : (
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
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
