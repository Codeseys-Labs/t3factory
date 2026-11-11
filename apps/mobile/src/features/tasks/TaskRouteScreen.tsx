import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  type FactoryTaskDisplayId,
  type FactoryTaskSummary,
} from "@t3tools/contracts";
import {
  presentFactoryTaskAssignee,
  presentFactoryTaskBanner,
  type FactoryTaskBannerAction,
} from "@t3tools/client-runtime/state/factory-task-view";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { useNowMinuteMs } from "../../lib/clock";
import {
  useFactoryTaskActivity,
  useFactoryTaskCatalogs,
  useFactoryTaskDetailByDisplayId,
  useFactoryTaskEntries,
  useFactoryTaskRequests,
} from "../../state/factoryTasks";
import { activityLines, askLines, resolveTaskAsk } from "./taskAsk";
import { TaskApprovalPanel, TaskCard, TaskFrame, TaskQuestionPanel } from "./TaskPanels";
import { TASKS_LIST_COPY, type TaskTone } from "./taskPresentation";

export type TaskRouteParams = { readonly environmentId: string; readonly displayId: string };

const DESKTOP_ACTIONS: readonly FactoryTaskBannerAction["kind"][] = [
  "start",
  "approve-plan",
  "edit-plan",
  "accept",
  "request-changes",
  "retry",
  "reassign",
  "reopen",
  "check",
  "publish",
  "merge",
];

const BANNER_CARD_TONES: Record<"neutral" | "attention" | "danger" | "working" | "done", TaskTone> =
  {
    neutral: "neutral",
    attention: "attention",
    danger: "danger",
    working: "working",
    done: "neutral",
  };

/** G2 and G3: a task, and the question or approval that waits on you. */
export function TaskRouteScreen({ route }: StaticScreenProps<TaskRouteParams>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const displayId: FactoryTaskDisplayId = route.params.displayId;
  const { result, refresh, status } = useFactoryTaskDetailByDisplayId(environmentId, displayId);
  const detail = Option.getOrNull(AsyncResult.value(result));
  if (detail !== null && (status === "current" || status === "loading"))
    return <TaskLoaded key={detail.task.ref.taskId} task={detail.task} />;
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={displayId} onBack={() => navigation.goBack()} sidebar={false} />
      {status === "loading" || status === "current" ? (
        <View className="items-center py-10">
          <AppActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading task" />
        </View>
      ) : (
        <EmptyState
          variant="plain"
          title={status === "failed" ? "Couldn't load this task" : TASKS_LIST_COPY[status].title}
          detail={
            status === "failed"
              ? "Check your connection and try again."
              : TASKS_LIST_COPY[status].detail
          }
          actionLabel={status === "failed" ? "Try again" : undefined}
          onAction={status === "failed" ? refresh : undefined}
        />
      )}
    </View>
  );
}

function TaskLoaded(props: { readonly task: FactoryTaskSummary }) {
  const { task } = props;
  const navigation = useNavigation();
  const now = useNowMinuteMs();
  const tasks = useMemo(() => [task], [task]);
  const live = useFactoryTaskEntries(tasks)[0]?.live ?? { liveRuns: [], attention: [] };
  const catalog =
    useFactoryTaskCatalogs([task.ref.environmentId]).get(task.ref.environmentId) ?? [];
  const activity = Option.getOrNull(AsyncResult.value(useFactoryTaskActivity(task.ref)));
  const ownRequest = live.attention.find(
    (need) => need.ref.taskId === task.ref.taskId && need.requestId !== null,
  );
  const requests = useFactoryTaskRequests(task.ref.environmentId, ownRequest?.threadId ?? null);
  const ask = resolveTaskAsk({ task, attention: live.attention, requests });
  const assignee = presentFactoryTaskAssignee(task.assignee, catalog);
  const agentLabel = assignee.label.replace(/^Auto → /u, "");
  const lines = [
    ...activityLines(activity?.entries ?? [], catalog, now),
    ...(ask ? askLines(ask, agentLabel, now).map((text) => ({ key: text, text })) : []),
  ];
  const frame = {
    displayId: task.displayId,
    title: task.title,
    assignee: { label: assignee.label, monogram: assignee.monogram },
    lines,
    onBack: () => navigation.goBack(),
  };
  const done = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.dispatch(StackActions.replace("Tasks"));
  };
  if (ask?.kind === "question")
    return (
      <TaskQuestionPanel
        key={ask.need.requestId}
        {...frame}
        ask={ask}
        agentLabel={agentLabel}
        requests={requests}
        onDone={done}
      />
    );
  if (ask?.kind === "approval")
    return (
      <TaskApprovalPanel
        key={ask.need.requestId}
        {...frame}
        ask={ask}
        requests={requests}
        onDone={done}
      />
    );

  const banner = presentFactoryTaskBanner({
    task,
    attention: live.attention,
    assigneeLabel: assignee.label,
    liveLabel: live.liveRuns[0]?.pill?.label ?? null,
  });
  const target =
    banner.primary?.kind === "open-task"
      ? (live.attention.find((need) => need.ref.taskId === banner.primary?.taskId) ??
        task.liveRuns.find((run) => run.taskId === banner.primary?.taskId) ??
        task.blockedBy.find((blocker) => blocker.taskId === banner.primary?.taskId))
      : undefined;
  const hint =
    banner.primary && DESKTOP_ACTIONS.includes(banner.primary.kind)
      ? "Continue this on the desktop."
      : null;
  return (
    <TaskFrame
      {...frame}
      card={
        <TaskCard tone={BANNER_CARD_TONES[banner.tone]} heading={banner.title}>
          {banner.detail ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {banner.detail}
            </Text>
          ) : null}
          {hint ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {hint}
            </Text>
          ) : null}
        </TaskCard>
      }
      actions={
        banner.primary && target ? (
          <Button
            tone="primary"
            fullWidth
            label={banner.primary.label}
            onPress={() =>
              navigation.dispatch(
                StackActions.push("Task", {
                  environmentId: task.ref.environmentId,
                  displayId: target.displayId,
                }),
              )
            }
          />
        ) : undefined
      }
    />
  );
}
