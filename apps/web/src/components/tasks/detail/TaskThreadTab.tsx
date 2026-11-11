import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, FactoryTaskSummary, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { useRef } from "react";

import { useEnvironmentSettings } from "../../../hooks/useSettings";
import { useTheme } from "../../../hooks/useTheme";
import { deriveActiveWorkStartedAt, derivePhase } from "../../../session-logic";
import {
  useProject,
  useQuietThreadProjection,
  useThreadShell,
  useThreadStatus,
} from "../../../state/entities";
import { useFactoryTaskLiveState } from "../../../state/factoryTasks";
import { buildThreadRouteParams } from "../../../threadRoutes";
import type { ExpandedImagePreview } from "../../chat/ExpandedImagePreview";
import { ThreadTimeline } from "../../chat/ThreadTimeline";
import { ScrollToEndButton } from "../../chat/TimelineOverlays";
import { useTimelineFollow } from "../../chat/useTimelineFollow";
import { InlineButton } from "../../ui/button";
import { useTaskCatalog } from "../shared";
import { presentTaskSetup } from "../shared/taskAssigneeModel";
import { TaskCommentBox } from "./TaskCommentBox";
import { isRunLive, runStateWord } from "./taskRuns";

const NO_TURN_DIFFS: ReadonlyArray<never> = [];
const NO_OPTIMISTIC_MESSAGES: ReadonlyArray<never> = [];
const ignore = () => {};
const openExpandedImage = (preview: ExpandedImagePreview) => {
  const src = preview.images[preview.index]?.src;
  if (src) window.open(src, "_blank", "noopener,noreferrer");
};

/**
 * The current run's conversation, inside the task. A planning run takes messages here; a work
 * run's conversation is shown as it is, and opens full size from the link.
 */
export function TaskThreadTab({ task }: { task: FactoryTaskSummary }) {
  const run = task.run;
  const catalog = useTaskCatalog(task.ref.environmentId);
  const live = useFactoryTaskLiveState(task);
  if (run === null) return <p className="py-2 text-muted-foreground text-sm">No runs yet.</p>;
  const pill = live.liveRuns.find((entry) => entry.threadId === run.threadId)?.pill ?? null;
  const state = runStateWord(run, pill?.label ?? null);
  const ownLive = isRunLive(run) && task.liveRuns.some((entry) => entry.threadId === run.threadId);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="min-w-0 truncate">
          Run {run.ordinal} · {presentTaskSetup(run.setup, catalog).label}
        </span>
        <span className="shrink-0 text-muted-foreground text-xs">{state.label}</span>
        <span className="flex-1" />
        <InlineButton
          tone="muted"
          render={
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(scopeThreadRef(task.ref.environmentId, run.threadId))}
            />
          }
        >
          Open full size
          <ArrowUpRightIcon aria-hidden className="size-3.5" />
        </InlineButton>
      </div>
      <TaskThreadTimeline
        environmentId={task.ref.environmentId}
        projectId={task.ref.projectId}
        threadId={run.threadId}
      />
      {ownLive && run.purpose === "planning" ? (
        <TaskCommentBox task={task} initialMode="agent" />
      ) : (
        <p className="text-muted-foreground text-xs">
          {run.purpose === "work" && ownLive
            ? "Replies to this run go through its questions and Request changes."
            : "This run has ended. Comments for people go in Activity."}
        </p>
      )}
    </div>
  );
}

/** The stock thread timeline for one thread, read-only: no rollback, fork or approvals. */
function TaskThreadTimeline({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: FactoryTaskSummary["ref"]["projectId"];
  threadId: ThreadId;
}) {
  const ref = scopeThreadRef(environmentId, threadId);
  const threadKey = scopedThreadKey(ref);
  const listRef = useRef<LegendListRef | null>(null);
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const timestampFormat = useEnvironmentSettings(
    environmentId,
    (settings) => settings.timestampFormat,
  );
  const shell = useThreadShell(ref);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const status = useThreadStatus(ref);
  const projection = useQuietThreadProjection(ref)?.projection ?? null;
  const activityRun = projection ? deriveThreadActivityRun(projection) : null;
  const runtime = projection ? deriveThreadStructureRuntime(projection) : null;
  const runlessWorkStartedAt = projection ? deriveRunlessWorkStartedAt(projection) : null;
  const isWorking = derivePhase(runtime) === "running" || runlessWorkStartedAt !== null;
  const workStartedAt =
    deriveActiveWorkStartedAt(activityRun, runtime, null) ?? runlessWorkStartedAt;
  const runningRunId = runtime?.activeRunId ?? null;
  const follow = useTimelineFollow({
    legendListRef: listRef,
    composerTimelineInset: 0,
    routeThreadKey: threadKey,
    activeThreadKey: threadKey,
    isServerThread: true,
    serverProjection: projection,
    threadStatus: status,
    activeActivityRun: activityRun,
    activeRunningTurnId: runningRunId,
    timelineEntries: NO_OPTIMISTIC_MESSAGES,
    timelineAnchorMessageId: null,
    setTimelineAnchor: ignore,
  });
  const openThread = (next: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, next)),
    });
  const workspaceRoot = project?.workspaceRoot;
  return (
    <div className="relative h-128 min-h-0 overflow-hidden rounded-lg border border-border">
      <ThreadTimeline
        threadDetailRef={ref}
        entriesInput={{
          optimisticMessages: NO_OPTIMISTIC_MESSAGES,
          ...(projection
            ? { attempts: projection.attempts, nodes: projection.nodes, plans: projection.plans }
            : {}),
        }}
        draftEntries={null}
        activeThreadKey={threadKey}
        syncing={status === "synchronizing"}
        detailLoading={projection === null}
        listRef={listRef}
        isWorking={isWorking}
        activeTurnStartedAt={workStartedAt}
        latestRun={activityRun}
        runningRunId={runningRunId}
        turnDiffSummaries={NO_TURN_DIFFS}
        runs={projection?.runs ?? []}
        routeThreadKey={threadKey}
        onOpenThread={openThread}
        supportsConversationRollback={false}
        onRevertToTurnCount={ignore}
        isRevertingCheckpoint={false}
        onImageExpand={openExpandedImage}
        activeThreadEnvironmentId={environmentId}
        markdownCwd={shell?.worktreePath ?? workspaceRoot}
        resolvedTheme={resolvedTheme}
        timestampFormat={timestampFormat}
        workspaceRoot={workspaceRoot}
        anchorMessageId={null}
        onAnchorReady={ignore}
        onAnchorSizeChanged={ignore}
        contentInsetEndAdjustment={0}
        emptyPlaceholderInset={0}
        liveFollowEnabled={follow.timelineLiveFollowEnabled}
        onIsAtEndChange={follow.onIsAtEndChangeStable}
        onViewportAttach={follow.attachTimelineViewport}
      />
      {follow.showScrollToBottom ? (
        <ScrollToEndButton
          summary={null}
          bottom={4}
          onScrollToEnd={() => follow.scrollToEnd(true)}
        />
      ) : null}
    </div>
  );
}
