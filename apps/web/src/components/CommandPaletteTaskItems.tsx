import {
  presentFactoryTaskAssignee,
  factoryTaskKey,
} from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskSummary, ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { InboxIcon, PanelsTopLeftIcon, SquarePenIcon, ZapIcon } from "lucide-react";

import { useFactoryTasks } from "../state/factoryTasks";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "./CommandPalette.logic";
import { AssigneeChip, TaskStatusIcon } from "./tasks/kit";
import { useTaskCatalog } from "./tasks/shared/taskCatalog";
import { useTaskScope } from "./tasks/shared/taskScope";
import { openNewTask } from "./tasks/taskDialogs";

function TaskAssigneeLabel({ task }: { task: FactoryTaskSummary }) {
  const catalog = useTaskCatalog(task.ref.environmentId);
  const assignee = presentFactoryTaskAssignee(task.assignee, catalog);
  return (
    <AssigneeChip
      assignee={
        task.assignee.assignment.mode === "unassigned"
          ? { kind: "unassigned" }
          : task.assignee.assignment.mode === "person"
            ? { kind: "person", label: assignee.label }
            : { kind: "agent", label: assignee.label, mono: assignee.monogram }
      }
    />
  );
}

function newTaskPaletteAction(single: ScopedProjectRef | null): CommandPaletteActionItem {
  return {
    kind: "action",
    value: "action:new-task",
    title: "New task",
    searchTerms: ["new task", "create", "capture"],
    icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "tasks.new",
    run: async () => {
      openNewTask(single ?? {});
    },
  };
}

export function useCommandPaletteTaskItems(query: string, enabled: boolean) {
  const scope = useTaskScope();
  const navigate = useNavigate();
  const text = query.trim().slice(0, 256);
  const list = useFactoryTasks(
    enabled && !text.startsWith(">")
      ? scope.targets.map((target) => ({
          ...target,
          input: { ...target.input, scope: "all", ...(text ? { text } : {}) },
        }))
      : [],
  );
  const taskItems: CommandPaletteActionItem[] = list.items.map(({ task }) => ({
    kind: "action",
    value: `task:${factoryTaskKey(task.ref)}`,
    title: `${task.displayId} ${task.title}`,
    searchTerms: [task.title, task.displayId],
    icon: <TaskStatusIcon status={task.status} />,
    titleTrailingContent: <TaskAssigneeLabel task={task} />,
    run: async () => {
      await navigate({
        to: "/tasks/$environmentId/$displayId",
        params: { environmentId: task.ref.environmentId, displayId: task.displayId },
      });
    },
  }));
  const taskActions = [newTaskPaletteAction(scope.single)];
  for (const { to, title, Icon } of [
    { to: "/tasks", title: "Go to Tasks", Icon: PanelsTopLeftIcon },
    { to: "/inbox", title: "Go to Inbox", Icon: InboxIcon },
    { to: "/automations", title: "Go to Automations", Icon: ZapIcon },
  ] as const)
    taskActions.push({
      kind: "action",
      value: `action:${to.slice(1)}`,
      title,
      searchTerms: [title],
      icon: <Icon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to });
      },
    });
  const unavailable = list.owners.filter((owner) => owner.status !== "current");
  const taskSearchNotice =
    unavailable.length > 0
      ? unavailable.some((owner) => owner.status === "failed")
        ? "Task search failed. Try again from Tasks."
        : unavailable.some((owner) => owner.status === "offline")
          ? "Connect to search tasks."
          : unavailable.some((owner) => owner.status === "forbidden")
            ? "Task search needs read access."
            : unavailable.some((owner) => owner.status === "unsupported")
              ? "Task search is unavailable on this environment."
              : "Searching tasks…"
      : list.more.length > 0
        ? "More tasks match. Open Tasks to see all results."
        : null;
  return { taskItems, taskActions, taskSearchNotice };
}
