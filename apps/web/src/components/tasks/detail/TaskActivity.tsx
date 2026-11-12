import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  presentFactoryTaskActivity,
  presentFactoryTaskActor,
} from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskActivityEntry, FactoryTaskDetail, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useNowMinute } from "../../../hooks/useNowMinute";
import { useFactoryTaskActivity, useRefreshFactoryTaskActivity } from "../../../state/factoryTasks";
import { useEnvironmentPresentation } from "../../../state/presentation";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { Button } from "../../ui/button";
import { ActivityItem, type ActivityItemProps } from "../kit";
import { useTaskCatalog } from "../shared";
import { TaskCommentBox } from "./TaskCommentBox";

/** The task's history, oldest first, read newest first so the latest entries are always shown. */
export function TaskActivity({ detail }: { detail: FactoryTaskDetail }) {
  const { taskId } = detail.task.ref;
  // Held here, not in the pages: a new entry gives every page a new cursor and remounts them.
  const [opened, setOpened] = useState({ taskId, earlier: 0 });
  const earlier = opened.taskId === taskId ? opened.earlier : 0;
  return (
    <div className="flex flex-col gap-3">
      <ActivityPages
        detail={detail}
        cursor={undefined}
        later={[]}
        earlier={earlier}
        onShowEarlier={() => setOpened({ taskId, earlier: earlier + 1 })}
      />
      <TaskCommentBox task={detail.task} />
    </div>
  );
}

/**
 * Reads one page older than `later`, then as many older pages as `earlier` counts. Each page hands
 * everything read so far to the next, so the list renders at once and nothing waits on an effect.
 */
function ActivityPages({
  detail,
  cursor,
  later,
  earlier,
  onShowEarlier,
}: {
  detail: FactoryTaskDetail;
  cursor: string | undefined;
  later: readonly FactoryTaskActivityEntry[];
  earlier: number;
  onShowEarlier: () => void;
}) {
  const page = { order: "newest" as const, ...(cursor === undefined ? {} : { cursor }) };
  const result = useFactoryTaskActivity(detail.task.ref, page);
  const retry = useRefreshFactoryTaskActivity(detail.task.ref, page);
  if (result._tag === "Success") {
    const entries = [...result.value.entries].reverse().concat(later);
    const next = result.value.nextCursor;
    if (earlier > 0 && next !== null)
      return (
        <ActivityPages
          detail={detail}
          cursor={next}
          later={entries}
          earlier={earlier - 1}
          onShowEarlier={onShowEarlier}
        />
      );
    return (
      <ActivityList
        detail={detail}
        entries={entries}
        onShowEarlier={next === null ? undefined : onShowEarlier}
      />
    );
  }
  if (later.length > 0)
    return (
      <div className="flex flex-col gap-1.5">
        {result._tag === "Failure" ? (
          <p role="alert" className="text-destructive-foreground flex items-center gap-2 text-sm">
            Couldn't load earlier activity.
            <Button variant="ghost-muted" size="xs" onClick={retry}>
              Try again
            </Button>
          </p>
        ) : null}
        <ActivityList detail={detail} entries={later} />
      </div>
    );
  if (result._tag === "Failure")
    return (
      <p role="alert" className="text-destructive-foreground text-sm">
        Couldn't load the activity. Check the machine's connection and reload.
      </p>
    );
  return (
    <p role="status" className="text-muted-foreground text-sm">
      Loading activity…
    </p>
  );
}

function ActivityList({
  detail,
  entries,
  onShowEarlier,
}: {
  detail: FactoryTaskDetail;
  entries: readonly FactoryTaskActivityEntry[];
  onShowEarlier?: (() => void) | undefined;
}) {
  const present = useActivityPresenter(detail);
  if (entries.length === 0) return null;
  return (
    <ol aria-label="Activity" className="flex flex-col gap-1.5">
      {onShowEarlier ? (
        <li>
          <Button variant="ghost-muted" size="xs" onClick={onShowEarlier}>
            Show earlier
          </Button>
        </li>
      ) : null}
      {entries.map((entry) => (
        <li key={entry.id}>
          <ActivityItem {...present(entry)} />
        </li>
      ))}
    </ol>
  );
}

/** Turns an entry into a kit item: the sentence, who did it, when, and a run's excerpt. */
function useActivityPresenter(detail: FactoryTaskDetail) {
  const { ref } = detail.task;
  const catalog = useTaskCatalog(ref.environmentId);
  const machine = useEnvironmentPresentation(ref.environmentId).presentation?.entry.target.label;
  const navigate = useNavigate();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(ref.environmentId, threadId)),
    });
  return (entry: FactoryTaskActivityEntry): ActivityItemProps => {
    const time = formatRelativeTimeLabel(entry.at, now);
    const { event, actor } = entry;
    const actorLabel = presentFactoryTaskActor(actor, catalog);
    if (event.type === "comment")
      return {
        kind: "comment",
        text: event.body,
        author: actorLabel,
        initials: initialsOf(actorLabel),
        time,
      };
    if (event.type === "run-started")
      return {
        kind: "run",
        author: actorLabel,
        text: `${presentFactoryTaskActivity(entry, catalog)}${machine ? ` on ${machine}` : ""}`,
        time,
        onOpen: () => openThread(event.threadId),
      };
    if (event.type === "run-ended" && event.outcome === "failed" && event.note) {
      // The excerpt shows under the line, which carries the run's short reason instead.
      const reason = detail.runs.find((run) => run.ordinal === event.ordinal)?.note ?? null;
      return {
        kind: "run",
        author: actorLabel,
        text: presentFactoryTaskActivity({ ...entry, event: { ...event, note: reason } }, catalog),
        time,
        outcome: "failed",
        excerpt: event.note,
        onOpen: () => openThread(event.threadId),
      };
    }
    const text = presentFactoryTaskActivity(entry, catalog);
    // A pull request opened or merged reads as a fact of the task, as C7 draws it.
    const named =
      (actor.kind === "person" || actor.kind === "agent") &&
      event.type !== "pull-request" &&
      !text.startsWith(actorLabel);
    return { kind: "event", text, author: named ? actorLabel : "", time };
  };
}

/** `You` is `Y`; anyone else is the first letters of the first two words. */
function initialsOf(label: string) {
  if (label === "You") return "Y";
  return label
    .split(/\s+/u)
    .filter((word) => /\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}
