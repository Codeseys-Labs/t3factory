import { useDraggable } from "@dnd-kit/core";
import { factoryTaskKey } from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskSummary } from "@t3tools/contracts";
import type { KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { ProjectChip, TaskIdText, TaskProgress, TypeTag } from "../kit";
import { TaskAssigneeChip, TaskStateMark } from "../shared";
import { cardMeta } from "./tasksHome.logic";

interface TaskCardProps {
  readonly task: FactoryTaskSummary;
  /** Null hides the project, as when the scope is one project. */
  readonly projectName: string | null;
  readonly selected: boolean;
  /** Rows from a machine that stopped answering stay visible but cannot be dragged. */
  readonly stale: boolean;
  readonly onPeek: (task: FactoryTaskSummary) => void;
  readonly onOpen: (task: FactoryTaskSummary) => void;
}

/** Space or a click peeks; Enter or a double click opens the task page. */
export function taskItemKeyDown(
  event: KeyboardEvent<HTMLElement>,
  task: FactoryTaskSummary,
  handlers: Pick<TaskCardProps, "onPeek" | "onOpen">,
) {
  if (event.target !== event.currentTarget) return;
  if (event.key === " ") {
    event.preventDefault();
    handlers.onPeek(task);
  } else if (event.key === "Enter") {
    event.preventDefault();
    handlers.onOpen(task);
  }
}

export function TaskCard(props: TaskCardProps) {
  const { task } = props;
  // The drag attributes are left off: they describe a keyboard drag, and arrows move focus here.
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: factoryTaskKey(task.ref),
    disabled: props.stale,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      data-task-card
      {...listeners}
      aria-roledescription="task card"
      aria-pressed={props.selected}
      onClick={() => props.onPeek(task)}
      onDoubleClick={() => props.onOpen(task)}
      onKeyDown={(event) => taskItemKeyDown(event, task, props)}
      className={cn(
        "flex w-full min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 text-start outline-none hover:border-foreground/16 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.selected && "border-primary/70 bg-primary/[0.04] hover:border-primary/70",
        isDragging && "opacity-40",
        props.stale && "opacity-70",
      )}
    >
      <TaskCardBody task={task} projectName={props.projectName} />
    </button>
  );
}

/** The card's content, apart from the draggable shell so a drag re-renders only the shell. */
export function TaskCardBody({
  task,
  projectName,
}: {
  task: FactoryTaskSummary;
  projectName: string | null;
}) {
  const meta = cardMeta(task);
  return (
    <>
      <span className="flex h-5 min-w-0 items-center gap-1.5">
        <TaskIdText id={task.displayId} />
        {task.type === "task" ? null : <TypeTag type={task.type} />}
        <span className="ms-auto flex min-w-0 justify-end">
          <TaskStateMark task={task} />
        </span>
      </span>
      <span
        className={cn(
          "line-clamp-2 break-words text-sm",
          task.status === "done" || task.status === "canceled"
            ? "text-muted-foreground"
            : "text-foreground",
        )}
      >
        {task.title}
      </span>
      {projectName !== null || meta !== null ? (
        <span className="flex min-w-0 items-center gap-2.5 text-muted-foreground text-xs">
          {projectName !== null ? (
            <span className="flex min-w-0 max-w-[60%] shrink-0">
              <ProjectChip name={projectName} />
            </span>
          ) : null}
          {meta?.kind === "progress" ? <TaskProgress done={meta.done} total={meta.total} /> : null}
          {meta?.kind === "text" ? <span className="min-w-0 truncate">{meta.text}</span> : null}
        </span>
      ) : null}
      <span className="flex min-w-0">
        <TaskAssigneeChip assignee={task.assignee} environmentId={task.ref.environmentId} />
      </span>
    </>
  );
}
