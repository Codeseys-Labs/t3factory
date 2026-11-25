import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { KanbanIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { useMakeThreadOrchestrator } from "./state";

/** Factory palette rows: open the work board, and make the open thread its project's Orchestrator. */
export function useFactoryCommandPaletteItems(
  activeThread: Parameters<typeof useMakeThreadOrchestrator>[0],
): CommandPaletteActionItem[] {
  const gt = useGT();
  const navigate = useNavigate();
  const makeThreadOrchestrator = useMakeThreadOrchestrator(activeThread);
  const items: CommandPaletteActionItem[] = [
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
