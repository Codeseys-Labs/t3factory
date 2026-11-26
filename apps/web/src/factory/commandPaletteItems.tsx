import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { KanbanIcon } from "lucide-react";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../components/CommandPalette.logic";
import { useWorkAttentionAtom } from "./FactoryWorkSidebarItem";
import { useMakeThreadOrchestrator } from "./state";

/**
 * Factory palette rows: open the work board, and make the open thread its project's Orchestrator.
 * Once Work has shown an environment this session, also the next item needing the person there
 * and every task of it by number.
 */
export function useFactoryCommandPaletteItems(
  activeThread: Parameters<typeof useMakeThreadOrchestrator>[0],
): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const gt = useGT();
  const navigate = useNavigate();
  const makeThreadOrchestrator = useMakeThreadOrchestrator(activeThread);
  const attentionAtom = useWorkAttentionAtom();
  const attention = useAtomValue(attentionAtom);
  const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
    {
      kind: "action",
      value: "action:work",
      searchTerms: ["work", "tasks", "board", "kanban", "factory"],
      title: gt("Open work"),
      icon: <KanbanIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/work" });
      },
    },
  ];
  if (attention !== null) {
    const { environmentId } = attention;
    const openTask = async (taskId: string) => {
      await navigate({ to: "/work", search: { env: environmentId, task: taskId } });
    };
    const next = attention.items[0];
    if (next !== undefined) {
      items.push({
        kind: "action",
        value: "action:work-next",
        searchTerms: ["needs you", "next", "approve", "question", "work", "tasks", "factory"],
        title: gt("Next item needing me"),
        description: `T-${next.taskNumber} ${next.taskTitle}`,
        icon: <KanbanIcon className={ITEM_ICON_CLASS} />,
        run: () => openTask(next.taskId),
      });
    }
    if (attention.tasks.length > 0) {
      items.push({
        kind: "submenu",
        value: "action:work-task",
        searchTerms: ["task", "t-", "number", "work", "factory"],
        title: gt("Go to task..."),
        icon: <KanbanIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <KanbanIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "work-tasks",
            label: gt("Tasks", { $context: "command palette group: the tasks on the work board" }),
            items: attention.tasks.map((task) => ({
              kind: "action" as const,
              value: `action:work-task:${task.id}`,
              searchTerms: [`T-${task.number}`, task.title],
              title: `T-${task.number} ${task.title}`,
              icon: <KanbanIcon className={ITEM_ICON_CLASS} />,
              run: () => openTask(task.id),
            })),
          },
        ],
      });
    }
  }
  if (makeThreadOrchestrator !== null) {
    items.push({
      kind: "action",
      value: "action:work-orchestrator",
      searchTerms: ["orchestrator", "factory", "work", "tasks"],
      title: gt("Make this thread the project's Orchestrator"),
      icon: <KanbanIcon className={ITEM_ICON_CLASS} />,
      run: makeThreadOrchestrator,
    });
  }
  return items;
}
