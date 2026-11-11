import { LegendList } from "@legendapp/list/react-native";
import { StackActions, useNavigation } from "@react-navigation/native";
import type { FactoryTaskSummary } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { Platform, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useFactoryTaskDetail } from "../../state/factoryTasks";
import { TaskRow, TasksSectionHeader } from "./TaskParts";
import { TasksTabBar, type TasksTab } from "./TasksTabBar";
import {
  TASKS_LIST_COPY,
  type TaskNeedRow,
  type TasksListItem,
  type TasksListState,
} from "./taskPresentation";
import type { TaskLabels } from "./useTasksData";

export interface TasksListBodyProps {
  readonly items: readonly TasksListItem[];
  readonly notices: readonly { readonly key: string; readonly text: string }[];
  readonly state: TasksListState;
  readonly refreshing: boolean;
  readonly incomplete?: boolean;
  readonly onRefresh: () => void;
  readonly labelsFor: (task: FactoryTaskSummary) => TaskLabels;
  readonly onOpen: (target: { readonly environmentId: string; readonly displayId: string }) => void;
}

function UnloadedNeedRow(props: {
  readonly row: TaskNeedRow;
  readonly labelsFor: TasksListBodyProps["labelsFor"];
  readonly onOpen: TasksListBodyProps["onOpen"];
}) {
  const { need } = props.row;
  const detail = Option.getOrNull(AsyncResult.value(useFactoryTaskDetail(need.ref)));
  const labels = detail ? props.labelsFor(detail.task) : null;
  return (
    <TaskRow
      displayId={need.displayId}
      title={detail?.task.title ?? null}
      projectLabel={labels?.projectLabel ?? need.ref.projectId}
      assigneeLabel={labels?.assigneeLabel ?? ""}
      assigneeMonogram={labels?.assigneeMonogram ?? ""}
      pill={props.row.pill}
      onPress={() =>
        props.onOpen({ environmentId: need.ref.environmentId, displayId: need.displayId })
      }
    />
  );
}

function ListItemView(props: { readonly item: TasksListItem } & Omit<TasksListBodyProps, "items">) {
  const { item } = props;
  if (item.type === "header") return <TasksSectionHeader title={item.title} />;
  if (item.type === "need") {
    const task = item.row.task;
    if (task === null)
      return <UnloadedNeedRow row={item.row} labelsFor={props.labelsFor} onOpen={props.onOpen} />;
    const labels = props.labelsFor(task);
    return (
      <TaskRow
        displayId={item.row.need.displayId}
        title={task.title}
        projectLabel={labels.projectLabel}
        assigneeLabel={labels.assigneeLabel}
        assigneeMonogram={labels.assigneeMonogram}
        pill={item.row.pill}
        onPress={() =>
          props.onOpen({
            environmentId: item.row.need.ref.environmentId,
            displayId: item.row.need.displayId,
          })
        }
      />
    );
  }
  const { task, pill } = item.row;
  const labels = props.labelsFor(task);
  return (
    <TaskRow
      displayId={task.displayId}
      title={task.title}
      projectLabel={labels.projectLabel}
      assigneeLabel={labels.assigneeLabel}
      assigneeMonogram={labels.assigneeMonogram}
      pill={pill}
      onPress={() =>
        props.onOpen({ environmentId: task.ref.environmentId, displayId: task.displayId })
      }
    />
  );
}

/** Each state of the list is its own answer; a failed read is never an empty list. */
export function TasksListBody(props: TasksListBodyProps) {
  const { state } = props;
  const insets = useSafeAreaInsets();
  return (
    <LegendList
      renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
      className="flex-1"
      contentContainerStyle={{ paddingBottom: insets.bottom + 18, paddingHorizontal: 16 }}
      contentInsetAdjustmentBehavior="automatic"
      data={props.items}
      estimatedItemSize={92}
      getItemType={(item) => item.type}
      keyExtractor={(item) => item.key}
      refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
      ListHeaderComponent={
        props.notices.length > 0 || props.incomplete ? (
          <View className="gap-1 pb-1 pt-2">
            {props.notices.map((notice) => (
              <Text key={notice.key} textRole="footnote" className="px-1 text-foreground-muted">
                {notice.text}
              </Text>
            ))}
            {props.incomplete ? (
              <Text textRole="footnote" className="px-1 text-foreground-muted">
                More tasks may be waiting on you.
              </Text>
            ) : null}
          </View>
        ) : null
      }
      renderItem={({ item }) => <ListItemView item={item} {...props} />}
      ListEmptyComponent={
        state.kind === "loading" ? (
          <View className="items-center py-10">
            <AppActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading tasks" />
          </View>
        ) : state.kind === "ready" || (state.kind === "caught-up" && props.incomplete) ? null : (
          <EmptyState
            variant="plain"
            title={TASKS_LIST_COPY[state.kind].title}
            detail={TASKS_LIST_COPY[state.kind].detail}
            actionLabel={state.kind === "failed" ? "Try again" : undefined}
            onAction={state.kind === "failed" ? props.onRefresh : undefined}
          />
        )
      }
    />
  );
}

export function TasksListScreen(
  props: TasksListBodyProps & {
    readonly title: string;
    readonly tab: TasksTab;
    readonly needsCount: number;
    readonly needsIncomplete: boolean;
  },
) {
  const navigation = useNavigation();
  const select = (tab: TasksTab) => {
    if (tab === props.tab) return;
    if (tab === "threads") navigation.dispatch(StackActions.popTo("Home"));
    else navigation.dispatch(StackActions.replace(tab === "tasks" ? "Tasks" : "TasksInbox"));
  };
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={props.title} onBack={() => navigation.goBack()} sidebar={false} />
      <TasksListBody {...props} />
      <TasksTabBar
        selected={props.tab}
        needsCount={props.needsCount}
        needsIncomplete={props.needsIncomplete}
        onSelect={select}
      />
    </View>
  );
}
