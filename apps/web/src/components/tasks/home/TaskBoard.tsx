import { RegistryContext } from "@effect/atom-react";
import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  type FactoryTaskDrop,
  factoryTaskKey,
  resolveFactoryTaskDrop,
} from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskStatus, FactoryTaskSummary } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { type KeyboardEvent, useContext, useState } from "react";

import { cn } from "~/lib/utils";
import { factoryTasks } from "../../../state/factoryTasks";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import {
  AssigneeChip,
  assigneeText,
  CountBadge,
  ProjectChip,
  TASK_STATUS_VISUALS,
  TaskStatusIcon,
} from "../kit";
import { TASK_PERMISSION_MESSAGE, useTaskAssigneeChip } from "../shared";
import { TaskCard, TaskCardBody } from "./TaskCard";
import {
  boardLanes,
  dropRefusalMessage,
  isCreatableLane,
  laneAssignee,
  moveTaskFocus,
  type TaskLane,
} from "./tasksHome.logic";

interface BoardEntry {
  readonly task: FactoryTaskSummary;
  readonly stale: boolean;
}

interface TaskBoardProps {
  readonly entries: readonly BoardEntry[];
  readonly grouping: "status" | "assignee" | "project";
  readonly statuses: readonly FactoryTaskStatus[];
  readonly counts: Readonly<Record<FactoryTaskStatus, number>>;
  readonly projectName: (task: FactoryTaskSummary) => string;
  readonly showProject: boolean;
  readonly peekKey: string | null;
  readonly onPeek: (task: FactoryTaskSummary) => void;
  readonly onOpen: (task: FactoryTaskSummary) => void;
  readonly onNewTask: (lane: "backlog" | "ready") => void;
  readonly onMove: (task: FactoryTaskSummary, lane: FactoryTaskSummary["lane"]) => void;
  readonly onStart: (task: FactoryTaskSummary) => void;
}

// useSensor keys on option identity; a fresh object each render would rebuild every draggable.
const POINTER_OPTIONS = { activationConstraint: { distance: 4 } };

type DragState = { readonly task: FactoryTaskSummary; readonly canUpdate: boolean };

function dropFor(drag: DragState, status: FactoryTaskStatus): FactoryTaskDrop {
  const drop = resolveFactoryTaskDrop(drag.task, status);
  return drop.kind === "move" && !drag.canUpdate ? { kind: "none" } : drop;
}

function dropSentence(drag: DragState, status: FactoryTaskStatus): string | null {
  const drop = resolveFactoryTaskDrop(drag.task, status);
  if (drop.kind === "refuse") return dropRefusalMessage(drag.task, drop);
  if (drop.kind === "move" && !drag.canUpdate) return TASK_PERMISSION_MESSAGE;
  return null;
}

const statusLabel = (status: FactoryTaskStatus) => TASK_STATUS_VISUALS[status].label;

/** Board keys: arrows move between the cards of a lane, and up or down into the next lane. */
function moveBoardFocus(event: KeyboardEvent<HTMLElement>) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches("[data-task-card]")) return;
  const lanes = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-task-lane]")];
  const cardsOf = (lane: HTMLElement) =>
    [...lane.querySelectorAll<HTMLElement>("[data-task-column]")].map((column) => [
      ...column.querySelectorAll<HTMLElement>("[data-task-card]"),
    ]);
  const laneIndex = lanes.findIndex((lane) => lane.contains(target));
  if (laneIndex === -1) return;
  const columns = cardsOf(lanes[laneIndex]!);
  const column = columns.findIndex((cards) => cards.includes(target));
  if (column === -1) return;
  const row = columns[column]!.indexOf(target);
  const next = moveTaskFocus(
    columns.map((cards) => cards.length),
    { column, row },
    event.key,
  );
  let focus = next === null ? null : (columns[next.column]?.[next.row] ?? null);
  if (focus === null && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    const step = event.key === "ArrowDown" ? 1 : -1;
    for (let index = laneIndex + step; index >= 0 && index < lanes.length; index += step) {
      const cards = cardsOf(lanes[index]!)[column] ?? [];
      if (cards.length === 0) continue;
      focus = step === 1 ? cards[0]! : cards[cards.length - 1]!;
      break;
    }
  }
  if (focus === null) return;
  event.preventDefault();
  focus.focus();
}

const GRID_CLASSES: Record<number, string> = {
  5: "min-w-[1132px] grid-cols-[repeat(5,minmax(220px,1fr))]",
  6: "min-w-[1360px] grid-cols-[repeat(6,minmax(220px,1fr))]",
};

export function TaskBoard(props: TaskBoardProps) {
  const registry = useContext(RegistryContext);
  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS));
  const [drag, setDrag] = useState<DragState | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const tasksByKey = new Map(props.entries.map((entry) => [factoryTaskKey(entry.task.ref), entry]));
  const lanes: readonly TaskLane[] =
    props.grouping === "status"
      ? [{ key: "all", tasks: props.entries.map((entry) => entry.task) }]
      : boardLanes(
          props.entries.map((entry) => entry.task),
          props.grouping,
        );

  const taskOf = (id: string | number) => tasksByKey.get(String(id))?.task ?? null;
  const statusOf = (data: unknown): FactoryTaskStatus | null =>
    typeof data === "object" && data !== null && "status" in data
      ? (data.status as FactoryTaskStatus)
      : null;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${taskOf(active.id)?.displayId ?? "the task"}.`,
    onDragOver: ({ active, over }) => {
      const status = statusOf(over?.data.current);
      const task = taskOf(active.id);
      if (!task || !status || !drag) return undefined;
      return dropSentence(drag, status) ?? `${task.displayId} is over ${statusLabel(status)}.`;
    },
    onDragEnd: ({ active }) => `Dropped ${taskOf(active.id)?.displayId ?? "the task"}.`,
    onDragCancel: ({ active }) =>
      `${taskOf(active.id)?.displayId ?? "The task"} is back where it was.`,
  };

  const onDragStart = (event: DragStartEvent) => {
    const task = taskOf(event.active.id);
    if (!task) return;
    setDrag({
      task,
      canUpdate: registry.get(factoryTasks.updateTask.permissionAtom(task.ref.environmentId)),
    });
  };
  const onDragEnd = (event: DragEndEvent) => {
    const current = drag;
    setDrag(null);
    const status = statusOf(event.over?.data.current);
    if (!current || !status) return;
    const drop = resolveFactoryTaskDrop(current.task, status);
    if (drop.kind === "refuse") {
      toastManager.add({ type: "warning", title: dropRefusalMessage(current.task, drop) });
      return;
    }
    if (drop.kind === "start") props.onStart(current.task);
    if (drop.kind !== "move") return;
    if (!current.canUpdate) {
      toastManager.add({ type: "warning", title: TASK_PERMISSION_MESSAGE });
      return;
    }
    props.onMove(current.task, drop.lane);
  };

  const toggleLane = (key: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      accessibility={{ announcements }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDrag(null)}
    >
      <div
        role="region"
        aria-label="Task board"
        className="min-h-0 flex-1 overflow-auto px-6 pb-6"
        onKeyDown={moveBoardFocus}
      >
        <div className={cn("grid gap-x-2", GRID_CLASSES[props.statuses.length])}>
          <div className="sticky top-0 z-10 col-span-full grid grid-cols-subgrid bg-background pt-1">
            {props.statuses.map((status) => (
              <ColumnHeader
                key={status}
                status={status}
                count={props.counts[status]}
                onNewTask={props.onNewTask}
              />
            ))}
          </div>
          {lanes.map((lane) => {
            const open = !collapsed.has(lane.key);
            return (
              <div key={lane.key} className="col-span-full grid grid-cols-subgrid">
                {props.grouping === "status" ? null : (
                  <LaneHeader
                    lane={lane}
                    grouping={props.grouping}
                    projectName={props.projectName}
                    open={open}
                    onToggle={() => toggleLane(lane.key)}
                  />
                )}
                {open ? (
                  <div
                    data-task-lane
                    className={cn(
                      "col-span-full grid grid-cols-subgrid",
                      props.grouping === "status" ? "pt-1" : "py-2",
                    )}
                  >
                    {props.statuses.map((status) => (
                      <BoardColumn
                        key={status}
                        laneKey={lane.key}
                        status={status}
                        drag={drag}
                        tasks={lane.tasks.filter((task) => task.status === status)}
                        board={props}
                        stale={(task) => tasksByKey.get(factoryTaskKey(task.ref))?.stale ?? false}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {drag ? (
          <div className="flex w-[220px] cursor-grabbing flex-col gap-1.5 rounded-lg border border-primary/60 bg-card p-2.5 shadow-lg">
            <TaskCardBody
              task={drag.task}
              projectName={props.showProject ? props.projectName(drag.task) : null}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function ColumnHeader({
  status,
  count,
  onNewTask,
}: {
  status: FactoryTaskStatus;
  count: number;
  onNewTask: (lane: "backlog" | "ready") => void;
}) {
  const label = statusLabel(status);
  return (
    <div className="flex h-9 min-w-0 items-center gap-2 px-1">
      <TaskStatusIcon status={status} />
      <h2 className="min-w-0 truncate font-medium text-sm">{label}</h2>
      <CountBadge count={count} />
      {isCreatableLane(status) ? (
        <Button
          variant="ghost-muted"
          size="icon-xs"
          className="ms-auto"
          aria-label={`New task in ${label}`}
          onClick={() => onNewTask(status)}
        >
          <PlusIcon aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

function LaneHeader({
  lane,
  grouping,
  projectName,
  open,
  onToggle,
}: {
  lane: TaskLane;
  grouping: "assignee" | "project";
  projectName: (task: FactoryTaskSummary) => string;
  open: boolean;
  onToggle: () => void;
}) {
  const sample = lane.tasks[0]!;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const assignee = useTaskAssigneeChip(
    laneAssignee(lane.tasks) ?? sample.assignee,
    sample.ref.environmentId,
  );
  const name = grouping === "project" ? projectName(sample) : assigneeText(assignee);
  return (
    <div className="col-span-full flex h-10 min-w-0 items-center gap-2 border-border border-b px-1">
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
        onClick={onToggle}
      >
        <Chevron aria-hidden />
      </Button>
      {grouping === "project" ? <ProjectChip name={name} /> : <AssigneeChip assignee={assignee} />}
      <CountBadge count={lane.tasks.length} />
    </div>
  );
}

function BoardColumn({
  laneKey,
  status,
  drag,
  tasks,
  board,
  stale,
}: {
  laneKey: string;
  status: FactoryTaskStatus;
  drag: DragState | null;
  tasks: readonly FactoryTaskSummary[];
  board: TaskBoardProps;
  stale: (task: FactoryTaskSummary) => boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${laneKey}|${status}`, data: { status } });
  const drop = drag ? dropFor(drag, status) : null;
  const accepts = drop?.kind === "move" || drop?.kind === "start";
  const refused = drag !== null && !accepts && drop?.kind !== "none";
  const sentence = drag && isOver && refused ? dropSentence(drag, status) : null;
  return (
    <div
      ref={setNodeRef}
      data-task-column
      data-drop={drag === null ? undefined : accepts ? "accepts" : refused ? "refuses" : "same"}
      aria-label={`${statusLabel(status)}, ${tasks.length} tasks`}
      role="group"
      className={cn(
        "flex min-h-24 min-w-0 flex-col gap-2 rounded-lg p-0.5",
        accepts && "bg-accent/40",
        accepts && isOver && "bg-primary/[0.08] ring-1 ring-primary/40 ring-inset",
        refused && "opacity-50",
        refused && isOver && "ring-1 ring-destructive/40 ring-inset",
      )}
    >
      {sentence ? (
        <p role="status" className="px-1.5 py-1 text-muted-foreground text-xs">
          {sentence}
        </p>
      ) : null}
      {tasks.map((task) => {
        const key = factoryTaskKey(task.ref);
        return (
          <TaskCard
            key={key}
            task={task}
            projectName={board.showProject ? board.projectName(task) : null}
            selected={key === board.peekKey}
            stale={stale(task)}
            onPeek={board.onPeek}
            onOpen={board.onOpen}
          />
        );
      })}
    </div>
  );
}
