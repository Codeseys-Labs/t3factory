import { StackActions, useNavigation } from "@react-navigation/native";

import { TasksListScreen } from "./TasksList";
import { buildInboxListItems, buildTasksListItems, tasksListNotices } from "./taskPresentation";
import { useTasksData } from "./useTasksData";

function useOpenTask() {
  const navigation = useNavigation();
  return (target: { readonly environmentId: string; readonly displayId: string }) =>
    navigation.dispatch(StackActions.push("Task", target));
}

/** G1: what needs you, then what is in progress. */
export function TasksRouteScreen() {
  const data = useTasksData();
  const openTask = useOpenTask();
  return (
    <TasksListScreen
      title="Tasks"
      tab="tasks"
      needsCount={data.sections.count}
      items={buildTasksListItems(data.sections)}
      notices={tasksListNotices(data.state, data.environmentLabel)}
      state={data.state}
      refreshing={data.refreshing}
      onRefresh={data.refresh}
      labelsFor={data.labelsFor}
      onOpen={openTask}
    />
  );
}

/** The asks alone: those blocking a run, then those ready to review. */
export function TasksInboxRouteScreen() {
  const data = useTasksData();
  const openTask = useOpenTask();
  return (
    <TasksListScreen
      title="Inbox"
      tab="inbox"
      needsCount={data.sections.count}
      items={buildInboxListItems(data.sections)}
      notices={tasksListNotices(data.inboxState, data.environmentLabel)}
      state={data.inboxState}
      refreshing={data.refreshing}
      onRefresh={data.refresh}
      labelsFor={data.labelsFor}
      onOpen={openTask}
    />
  );
}
