import { formatModelSlugName } from "@t3tools/shared/model";
import { T, useGT, useMessages } from "gt-react";
import { memo, useState } from "react";

import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { RelativeLabel } from "../components/workflows/WorkflowRunFeed";
import {
  sameWorkCard,
  taskNumber,
  waitsOnRun,
  WORK_COLUMN_LABELS,
  WORK_PAGE_SIZE,
  WorkBadges,
} from "./WorkBoard";
import type { WorkCard } from "./workBoard.logic";

/** The board's cards as rows, in the order the board derives them. */
export function WorkList({
  cards,
  projectNames,
  selectedTaskId,
  runsPending,
  onOpenTask,
}: {
  readonly cards: ReadonlyArray<WorkCard>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly selectedTaskId: string | null;
  readonly runsPending: boolean;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const gt = useGT();
  const [limit, setLimit] = useState(WORK_PAGE_SIZE);
  const hidden = cards.length - limit;
  return (
    <div className="min-h-0 flex-1">
      <ScrollArea>
        <div className="flex flex-col gap-2 p-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <T context="table column: a task's number">Number</T>
                </TableHead>
                <TableHead>
                  <T context="table column: a task's title">Title</T>
                </TableHead>
                <TableHead>
                  <T context="table column: the board column a task is in">Column</T>
                </TableHead>
                <TableHead>
                  <T context="table column: a task's project">Project</T>
                </TableHead>
                <TableHead>
                  <T context="table column: the model a task runs with">Model</T>
                </TableHead>
                <TableHead>
                  <T context="table column: who a task is assigned to">Assignee</T>
                </TableHead>
                <TableHead>
                  <T context="table column: when a task last changed">Updated</T>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cards.slice(0, limit).map((card) => (
                <WorkRow
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
            </TableBody>
          </Table>
          {hidden <= 0 ? null : (
            <div className="flex justify-center">
              <Button size="xs" variant="ghost" onClick={() => setLimit(limit + WORK_PAGE_SIZE)}>
                {gt("Show {count} more", { count: Math.min(hidden, WORK_PAGE_SIZE) })}
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

interface WorkRowProps {
  readonly card: WorkCard;
  readonly projectName: string | null;
  readonly current: boolean;
  readonly runPending: boolean;
  readonly onOpen: (taskId: string) => void;
}

const WorkRow = memo(
  function WorkRow({ card, projectName, current, runPending, onOpen }: WorkRowProps) {
    const m = useMessages();
    const { task, column, badges } = card;
    return (
      <TableRow data-state={current ? "selected" : undefined}>
        <TableCell>
          <span className="font-mono text-muted-foreground">{taskNumber(task)}</span>
        </TableCell>
        <TableCell>
          <span className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              data-work-task={task.id}
              aria-current={current ? "true" : undefined}
              className="max-w-96 cursor-pointer truncate rounded-sm text-left text-sm text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset"
              onClick={() => onOpen(task.id)}
            >
              {task.title}
            </button>
            <WorkBadges badges={badges} />
          </span>
        </TableCell>
        <TableCell>
          {runPending ? (
            <span className="text-muted-foreground">
              <T context="a task's column waits on its workflow run to load">Checking its run…</T>
            </span>
          ) : (
            m(WORK_COLUMN_LABELS[column])
          )}
        </TableCell>
        <TableCell>
          <span className="text-muted-foreground">{projectName}</span>
        </TableCell>
        <TableCell>
          <span className="text-muted-foreground">
            {task.model === null ? null : formatModelSlugName(task.model.model)}
          </span>
        </TableCell>
        <TableCell>
          <span className="text-muted-foreground">{task.assignee}</span>
        </TableCell>
        <TableCell>
          <span className="text-muted-foreground">
            <RelativeLabel value={task.updatedAt} />
          </span>
        </TableCell>
      </TableRow>
    );
  },
  (previous, next) =>
    sameWorkCard(previous.card, next.card) &&
    previous.projectName === next.projectName &&
    previous.current === next.current &&
    previous.runPending === next.runPending &&
    previous.onOpen === next.onOpen,
);
