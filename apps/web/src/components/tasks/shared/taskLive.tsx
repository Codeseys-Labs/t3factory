import type { FactoryTaskNeed } from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskSummary } from "@t3tools/contracts";

import { useNowMinute } from "../../../hooks/useNowMinute";
import { useFactoryTaskLiveState } from "../../../state/factoryTasks";
import { formatElapsedDurationLabel } from "../../../timestampFormat";
import type { ThreadStatusPill } from "../../Sidebar.logic";
import { BlockedBadge, LivePill, liveToneForThreadStatus, NeedsYouBadge } from "../kit";
import { mostUrgentLive, resolveTaskStateMark, type TaskLivePill } from "./taskStateMark";

/** What a task's runs are doing now, in the thread sidebar's words, and what waits on a person. */
export function useTaskLive(task: FactoryTaskSummary): {
  pill: TaskLivePill | null;
  needs: readonly FactoryTaskNeed[];
} {
  const live = useFactoryTaskLiveState(task);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const runs = live.liveRuns.flatMap((run) =>
    run.pill
      ? [
          {
            label: run.pill.label,
            // The pill's words come from `resolveThreadStatusPill`, so they are the sidebar's labels.
            tone: liveToneForThreadStatus(run.pill.label as ThreadStatusPill["label"]) ?? "neutral",
            duration: formatElapsedDurationLabel(run.startedAt, now),
          },
        ]
      : [],
  );
  return { pill: mostUrgentLive(runs), needs: live.attention };
}

export function TaskStateMark({ task }: { task: FactoryTaskSummary }) {
  const { pill, needs } = useTaskLive(task);
  const mark = resolveTaskStateMark({ pill, needs, blockedBy: task.blockedBy });
  if (mark === null) return null;
  switch (mark.kind) {
    case "live":
      return (
        <LivePill label={mark.pill.label} tone={mark.pill.tone} duration={mark.pill.duration} />
      );
    case "needs":
      return <NeedsYouBadge reason={mark.reason} />;
    case "blocked":
      return <BlockedBadge blockerId={mark.blockerId} />;
  }
}
