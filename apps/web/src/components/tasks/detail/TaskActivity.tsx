import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentFactoryTaskActivity } from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskActivityEntry, FactoryTaskDetail, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useNowMinute } from "../../../hooks/useNowMinute";
import { useFactoryTaskActivity } from "../../../state/factoryTasks";
import { useEnvironmentPresentation } from "../../../state/presentation";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { Button } from "../../ui/button";
import { ActivityItem, type ActivityItemProps } from "../kit";
import { useTaskCatalog } from "../shared";
import { TaskCommentBox } from "./TaskCommentBox";

const PAGE = 50;
// The server pages forward from the oldest entry; past this many pages the newest are not read.
const MAX_PAGES = 20;

/** The task's history, oldest first, with the newest page in view, then the comment box. */
export function TaskActivity({ detail }: { detail: FactoryTaskDetail }) {
  return (
    <div className="flex flex-col gap-3">
      <ActivityPages detail={detail} cursor={undefined} earlier={[]} page={1} />
      <TaskCommentBox task={detail.task} />
    </div>
  );
}

/**
 * Reads one page and hands what it has read so far to the next, so the last page renders the
 * whole history at once and nothing waits on an effect.
 */
function ActivityPages({
  detail,
  cursor,
  earlier,
  page,
}: {
  detail: FactoryTaskDetail;
  cursor: string | undefined;
  earlier: readonly FactoryTaskActivityEntry[];
  page: number;
}) {
  const result = useFactoryTaskActivity(detail.task.ref, cursor);
  if (result._tag === "Success") {
    const entries = [...earlier, ...result.value.entries];
    const next = result.value.nextCursor;
    if (next !== null && page < MAX_PAGES)
      return <ActivityPages detail={detail} cursor={next} earlier={entries} page={page + 1} />;
    return <ActivityList detail={detail} entries={entries} />;
  }
  if (earlier.length > 0) return <ActivityList detail={detail} entries={earlier} />;
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
}: {
  detail: FactoryTaskDetail;
  entries: readonly FactoryTaskActivityEntry[];
}) {
  const [shown, setShown] = useState(PAGE);
  const present = useActivityPresenter(detail);
  const hidden = Math.max(0, entries.length - shown);
  if (entries.length === 0) return null;
  return (
    <ol aria-label="Activity" className="flex flex-col gap-1.5">
      {hidden > 0 ? (
        <li>
          <Button variant="ghost-muted" size="xs" onClick={() => setShown(shown + PAGE)}>
            Show earlier
          </Button>
        </li>
      ) : null}
      {entries.slice(hidden).map((entry) => (
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
    if (event.type === "comment")
      return {
        kind: "comment",
        text: event.body,
        author: actor.label,
        initials: initialsOf(actor.label),
        time,
      };
    if (event.type === "run-started")
      return {
        kind: "run",
        author: actor.label,
        text: `${presentFactoryTaskActivity(entry, catalog)}${machine ? ` on ${machine}` : ""}`,
        time,
        onOpen: () => openThread(event.threadId),
      };
    if (event.type === "run-ended" && event.outcome === "failed" && event.note) {
      // The excerpt shows under the line, which carries the run's short reason instead.
      const reason = detail.runs.find((run) => run.ordinal === event.ordinal)?.note ?? null;
      return {
        kind: "run",
        author: actor.label,
        text: presentFactoryTaskActivity({ ...entry, event: { ...event, note: reason } }, catalog),
        time,
        outcome: "failed",
        excerpt: event.note,
        onOpen: () => openThread(event.threadId),
      };
    }
    const text = presentFactoryTaskActivity(entry, catalog);
    const named =
      (actor.kind === "person" || actor.kind === "agent") && !text.startsWith(actor.label);
    return { kind: "event", text, author: named ? actor.label : "", time };
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
