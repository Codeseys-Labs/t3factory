import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { KanbanIcon } from "lucide-react";

export function useFactoryWorkSidebarItem(onOpen: () => void) {
  const gt = useGT();
  const navigate = useNavigate();
  return {
    icon: <KanbanIcon />,
    label: gt("Work", { $context: "sidebar link to the board of tasks" }),
    onClick: () => {
      onOpen();
      void navigate({ to: "/work" });
    },
  };
}
