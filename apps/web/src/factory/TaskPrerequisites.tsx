import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";

import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { taskNumber } from "./WorkBoard";
import type { DirectRelations, RelationEdge, RelationStatus } from "./workDetail.logic";
import type { WorkSearch } from "./WorkPage";

const STATUS_LABELS: Record<RelationStatus, string> = {
  open: msg("Not done", { $context: "a related task is not finished yet" }),
  completed: msg("Done", { $context: "a related task is finished" }),
  dropped: msg("Dropped", { $context: "a related task is no longer to be done" }),
  unknown: msg("Unknown", { $context: "the state of a related task this page cannot see" }),
};

const STATUS_VARIANTS = {
  open: "outline",
  completed: "success",
  dropped: "secondary",
  unknown: "warning",
} as const satisfies Record<RelationStatus, string>;

const NODE_HEIGHT = 44;
const ROW_GAP = 8;
/** Space between diagram columns, in percent of its width. */
const COLUMN_GAP = 8;

const edgeName = (edge: RelationEdge) =>
  edge.number === null ? edge.taskId.slice(0, 8) : taskNumber({ number: edge.number });

/** The tasks this one waits on, and the tasks that are part of it, drawn and listed. */
export function TaskPrerequisites({
  task,
  relations,
  taskSearch,
}: {
  readonly task: { readonly number: number; readonly title: string };
  readonly relations: DirectRelations;
  /** The Work address that selects a task, for each related task's link. */
  readonly taskSearch: (taskId: string) => WorkSearch;
}) {
  const gt = useGT();
  const m = useMessages();
  const { blockers, children, omitted } = relations;
  const groups = [
    {
      key: "blockers",
      label: <T context="field: the tasks this one waits on">Blocked by</T>,
      edges: blockers,
      omitted: omitted.blockers,
    },
    {
      key: "children",
      label: <T context="the tasks that are part of this one">Subtasks</T>,
      edges: children,
      omitted: omitted.children,
    },
  ].filter((group) => group.edges.length > 0 || group.omitted > 0);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">
        <T context="the tasks this one waits on and the tasks that are part of it">Prerequisites</T>
      </h3>
      <RelationDiagram task={task} blockers={blockers} subtasks={children} />
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">{group.label}</h4>
          <ul className="flex flex-col gap-1">
            {group.edges.map((edge) => (
              <li key={edge.taskId} className="flex min-w-0 items-center gap-2 text-sm">
                <Link
                  to="/work"
                  search={taskSearch(edge.taskId)}
                  replace
                  className="min-w-0 truncate underline underline-offset-2"
                >
                  {edge.title === null ? edgeName(edge) : `${edgeName(edge)} ${edge.title}`}
                </Link>
                <Badge size="sm" variant={STATUS_VARIANTS[edge.status]}>
                  {m(STATUS_LABELS[edge.status])}
                </Badge>
              </li>
            ))}
          </ul>
          {group.omitted === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              {gt("{count, plural, one {{count} more not shown} other {{count} more not shown}}", {
                count: group.omitted,
                $context: "related tasks left out of a list that is too long",
              })}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

/** Blockers, then this task, then its subtasks, left to right: a picture the lists repeat. */
function RelationDiagram({
  task,
  blockers,
  subtasks,
}: {
  readonly task: { readonly number: number; readonly title: string };
  readonly blockers: ReadonlyArray<RelationEdge>;
  readonly subtasks: ReadonlyArray<RelationEdge>;
}) {
  const m = useMessages();
  const columns = [
    ...(blockers.length > 0 ? ["blockers"] : []),
    "task",
    ...(subtasks.length > 0 ? ["subtasks"] : []),
  ];
  const width = (100 - COLUMN_GAP * (columns.length - 1)) / columns.length;
  const left = (column: string) => columns.indexOf(column) * (width + COLUMN_GAP);
  const rows = Math.max(blockers.length, 1, subtasks.length);
  const height = rows * NODE_HEIGHT + (rows - 1) * ROW_GAP;
  const top = (count: number, index: number) =>
    (height - (count * NODE_HEIGHT + (count - 1) * ROW_GAP)) / 2 + index * (NODE_HEIGHT + ROW_GAP);
  const taskMiddle = top(1, 0) + NODE_HEIGHT / 2;
  const curve = (fromX: number, fromY: number, toX: number, toY: number) => {
    const bend = (toX - fromX) / 2;
    return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`;
  };
  const node = (
    key: string,
    column: string,
    y: number,
    name: string,
    title: string | null,
    status: RelationStatus | null,
  ) => (
    <div
      key={key}
      className={cn(
        "absolute flex flex-col justify-center gap-0.5 overflow-hidden rounded-lg border px-2",
        status === null ? "bg-accent" : "bg-background",
      )}
      style={{ left: `${left(column)}%`, width: `${width}%`, top: y, height: NODE_HEIGHT }}
    >
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="shrink-0 font-mono">{name}</span>
        {status === null ? null : (
          <span className="min-w-0 truncate">{m(STATUS_LABELS[status])}</span>
        )}
      </span>
      <span className="truncate text-xs text-foreground">{title}</span>
    </div>
  );
  return (
    <div aria-hidden className="relative" style={{ height }}>
      <svg
        className="pointer-events-none absolute inset-0 size-full text-muted-foreground"
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
      >
        {blockers.map((edge, index) => (
          <path
            key={`blocks ${edge.taskId}`}
            d={curve(
              left("blockers") + width,
              top(blockers.length, index) + NODE_HEIGHT / 2,
              left("task"),
              taskMiddle,
            )}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {subtasks.map((edge, index) => (
          <path
            key={`parent ${edge.taskId}`}
            d={curve(
              left("task") + width,
              taskMiddle,
              left("subtasks"),
              top(subtasks.length, index) + NODE_HEIGHT / 2,
            )}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {blockers.map((edge, index) =>
        node(
          `blocker ${edge.taskId}`,
          "blockers",
          top(blockers.length, index),
          edgeName(edge),
          edge.title,
          edge.status,
        ),
      )}
      {node("task", "task", top(1, 0), taskNumber(task), task.title, null)}
      {subtasks.map((edge, index) =>
        node(
          `subtask ${edge.taskId}`,
          "subtasks",
          top(subtasks.length, index),
          edgeName(edge),
          edge.title,
          edge.status,
        ),
      )}
    </div>
  );
}
