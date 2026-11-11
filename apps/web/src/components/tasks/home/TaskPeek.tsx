import { presentFactoryTaskActivity } from "@t3tools/client-runtime/state/factory-task-view";
import type {
  FactoryTaskActivityEntry,
  FactoryTaskRef,
  FactoryTaskSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { XIcon } from "lucide-react";
import { useEffect, useEffectEvent } from "react";

import { useNowMinute } from "../../../hooks/useNowMinute";
import { useFactoryTaskActivity, useFactoryTaskDetail } from "../../../state/factoryTasks";
import { formatRelativeTime } from "../../../timestampFormat";
import { Button } from "../../ui/button";
import {
  ActivityItem,
  type ActivityItemProps,
  ProjectChip,
  PropertyList,
  PropertyRow,
  SectionHeader,
  SourceChip,
  TaskIdText,
  TaskStatusLabel,
  TypeTag,
} from "../kit";
import { TaskAssigneeChip, TaskBanner, taskErrorMessage, useTaskCatalog } from "../shared";

const LATEST = 3;
// Activity is oldest first; a task with more pages than this shows the newest it reached.
const MAX_ACTIVITY_PAGES = 20;

/**
 * The task beside the board: the same banner and action as its page, its properties and the
 * three newest activity entries. No scrim, so the board stays usable; Escape closes it.
 */
export function TaskPeek({
  peekRef,
  summary,
  projectName,
  onClose,
  onOpen,
}: {
  peekRef: FactoryTaskRef;
  summary: FactoryTaskSummary | null;
  projectName: (task: FactoryTaskSummary) => string;
  onClose: () => void;
  onOpen: (task: FactoryTaskSummary) => void;
}) {
  const detail = useFactoryTaskDetail(peekRef);
  const loaded = detail._tag === "Success" ? detail.value : null;
  const task = loaded?.task ?? summary;
  const close = useEffectEvent(onClose);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape anywhere on the page closes the panel, which has no modal focus trap
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest("[role=dialog],[role=menu]"))
        return;
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <aside
      aria-label={task ? `${task.displayId} ${task.title}` : "Task"}
      className="absolute inset-y-0 end-0 z-30 flex w-[440px] max-w-full flex-col border-border border-s bg-background shadow-xl"
    >
      <div className="flex min-w-0 items-start gap-2 border-border border-b px-4 pt-4 pb-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {task ? (
            <>
              <span className="flex items-center gap-1.5">
                <TaskIdText id={task.displayId} />
                {task.type === "task" ? null : <TypeTag type={task.type} />}
              </span>
              <h2 className="break-words font-semibold text-base">{task.title}</h2>
            </>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="xs"
          disabled={task === null}
          onClick={() => (task ? onOpen(task) : undefined)}
        >
          Open
        </Button>
        <Button variant="ghost-muted" size="icon-xs" aria-label="Close" onClick={onClose}>
          <XIcon aria-hidden />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        {task ? (
          <>
            <TaskBanner task={task} {...(loaded ? { detail: loaded } : {})} />
            <PropertyList>
              <PropertyRow label="Status">
                <TaskStatusLabel status={task.status} />
              </PropertyRow>
              <PropertyRow label="Assignee">
                <TaskAssigneeChip assignee={task.assignee} environmentId={task.ref.environmentId} />
              </PropertyRow>
              <PropertyRow label="Project">
                <ProjectChip name={projectName(task)} />
              </PropertyRow>
              <PropertyRow label="Source">
                <SourceChip kind={task.source.kind} label={task.source.label} />
              </PropertyRow>
            </PropertyList>
            <section aria-label="Latest" className="flex min-w-0 flex-col gap-1">
              <SectionHeader title="Latest" />
              <LatestActivity taskRef={task.ref} carry={[]} page={0} />
            </section>
          </>
        ) : detail._tag === "Failure" ? (
          <p role="alert" className="text-muted-foreground text-sm">
            {taskErrorMessage(Cause.squash(detail.cause))}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">Loading the task…</p>
        )}
      </div>
    </aside>
  );
}

function LatestActivity({
  taskRef,
  cursor,
  carry,
  page,
}: {
  taskRef: FactoryTaskRef;
  cursor?: string;
  carry: readonly FactoryTaskActivityEntry[];
  page: number;
}) {
  const result = useFactoryTaskActivity(taskRef, cursor);
  if (result._tag === "Failure")
    return (
      <p role="alert" className="text-muted-foreground text-sm">
        {taskErrorMessage(Cause.squash(result.cause))}
      </p>
    );
  if (result._tag !== "Success")
    return <p className="text-muted-foreground text-sm">Loading activity…</p>;
  const entries = [...carry, ...result.value.entries].slice(-LATEST);
  if (result.value.nextCursor !== null && page + 1 < MAX_ACTIVITY_PAGES)
    return (
      <LatestActivity
        taskRef={taskRef}
        cursor={result.value.nextCursor}
        carry={entries}
        page={page + 1}
      />
    );
  return <ActivityEntries entries={entries} environmentId={taskRef.environmentId} />;
}

function ActivityEntries({
  entries,
  environmentId,
}: {
  entries: readonly FactoryTaskActivityEntry[];
  environmentId: FactoryTaskRef["environmentId"];
}) {
  const catalog = useTaskCatalog(environmentId);
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00Z`);
  if (entries.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {entries.map((entry) => (
        <ActivityItem key={entry.id} {...activityItem(entry, catalog, nowMs)} />
      ))}
    </div>
  );
}

function activityItem(
  entry: FactoryTaskActivityEntry,
  catalog: ReturnType<typeof useTaskCatalog>,
  nowMs: number,
): ActivityItemProps {
  const text = presentFactoryTaskActivity(entry, catalog);
  const author = entry.actor.label;
  const time = formatRelativeTime(entry.at, nowMs)?.value ?? "";
  if (entry.event.type === "comment")
    return entry.actor.kind === "agent"
      ? { kind: "agent", text, author, time }
      : {
          kind: "comment",
          text,
          author,
          time,
          initials: author === "You" ? "Y" : author.slice(0, 2).toUpperCase(),
        };
  return { kind: "event", text, author, time };
}
