import type { FactoryTaskSummary } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { memo } from "react";

import { cn } from "../lib/utils";
import { ScrollArea } from "../components/ui/scroll-area";
import { sameWorkCard, taskNumber, waitsOnRun, WORK_COLUMN_LABELS, WorkBadges } from "./WorkBoard";
import { deriveWorkGraph, type WorkCard } from "./workBoard.logic";
import { layoutWorkGraph } from "./workGraph.logic";

const GRAPH_LIMIT = 200;

/** The cards as a graph: parents and blockers to the left of what hangs on them. */
export function WorkGraph({
  cards,
  tasks,
  selectedTaskId,
  runsPending,
  onOpenTask,
}: {
  readonly cards: ReadonlyArray<WorkCard>;
  /** Every listed task, to name blockers the filters leave out. */
  readonly tasks: ReadonlyArray<FactoryTaskSummary>;
  readonly selectedTaskId: string | null;
  readonly runsPending: boolean;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const shown = cards.length > GRAPH_LIMIT ? cards.slice(0, GRAPH_LIMIT) : cards;
  const layout = layoutWorkGraph(deriveWorkGraph(shown));
  const numbers = new Map(tasks.map((task) => [task.id, taskNumber(task)] as const));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {shown.length === cards.length ? null : (
        <p role="status" className="shrink-0 border-b px-4 py-1.5 text-xs text-muted-foreground">
          {gt("The graph shows the newest {shown} of {count} tasks. Filter to see the rest.", {
            shown: shown.length,
            count: cards.length,
          })}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <ScrollArea>
          <div className="relative" style={{ width: layout.width, height: layout.height }}>
            <svg
              aria-hidden
              className="pointer-events-none absolute inset-0 text-muted-foreground"
              width={layout.width}
              height={layout.height}
            >
              {layout.edges.map((edge) => (
                <path
                  key={`${edge.kind} ${edge.from} ${edge.to}`}
                  d={edge.path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeDasharray={edge.kind === "blocks" ? "4 4" : undefined}
                />
              ))}
            </svg>
            {layout.nodes.map((node) => {
              const column = m(WORK_COLUMN_LABELS[node.card.column]);
              const blockers = node.card.openBlockers
                .map((id) => numbers.get(id))
                .filter((number) => number !== undefined);
              const task = taskNumber(node.card.task);
              return (
                <GraphNode
                  key={node.id}
                  card={node.card}
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={node.height}
                  label={
                    blockers.length === 0
                      ? gt("{task} {title}, {column}", {
                          task,
                          title: node.card.task.title,
                          column,
                        })
                      : gt("{task} {title}, {column}, blocked by {blockers}", {
                          task,
                          title: node.card.task.title,
                          column,
                          blockers: blockers.join(", "),
                        })
                  }
                  column={column}
                  current={node.id === selectedTaskId}
                  runPending={runsPending && waitsOnRun(node.card)}
                  onOpen={onOpenTask}
                />
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

interface GraphNodeProps {
  readonly card: WorkCard;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly column: string;
  readonly current: boolean;
  readonly runPending: boolean;
  readonly onOpen: (taskId: string) => void;
}

const GraphNode = memo(
  function GraphNode({
    card,
    x,
    y,
    width,
    height,
    label,
    column,
    current,
    runPending,
    onOpen,
  }: GraphNodeProps) {
    const { task } = card;
    return (
      <button
        type="button"
        data-work-task={task.id}
        aria-label={label}
        aria-current={current ? "true" : undefined}
        className={cn(
          "absolute flex cursor-pointer flex-col justify-center gap-0.5 rounded-lg border px-3 text-left focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset",
          current ? "bg-accent" : "bg-background hover:bg-accent/50",
        )}
        style={{ left: x, top: y, width, height }}
        onClick={() => onOpen(task.id)}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 font-mono">{taskNumber(task)}</span>
          <span className="min-w-0 flex-1 truncate">
            {runPending ? (
              <T context="a task's column waits on its workflow run to load">Checking its run…</T>
            ) : (
              column
            )}
          </span>
          <WorkBadges badges={card.badges} />
        </span>
        <span className="truncate text-sm text-foreground">{task.title}</span>
      </button>
    );
  },
  (previous, next) =>
    sameWorkCard(previous.card, next.card) &&
    previous.x === next.x &&
    previous.y === next.y &&
    previous.width === next.width &&
    previous.height === next.height &&
    previous.label === next.label &&
    previous.column === next.column &&
    previous.current === next.current &&
    previous.runPending === next.runPending &&
    previous.onOpen === next.onOpen,
);
