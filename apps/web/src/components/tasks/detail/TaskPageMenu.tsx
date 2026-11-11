import type { FactoryTaskPlanProposal, FactoryTaskSummary } from "@t3tools/contracts";
import {
  ArchiveRestoreIcon,
  CircleXIcon,
  EllipsisIcon,
  LinkIcon,
  ListXIcon,
  RotateCcwIcon,
} from "lucide-react";

import { writeTextToClipboard } from "../../../hooks/useCopyToClipboard";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { toastManager } from "../../ui/toast";
import { useTaskActions, useTaskPermissions } from "../shared";

/** The page menu: cancel or restore the task, reopen an accepted one, dismiss a waiting plan, copy the link. */
export function TaskPageMenu({
  task,
  proposal,
}: {
  task: FactoryTaskSummary;
  proposal: FactoryTaskPlanProposal | null;
}) {
  const permissions = useTaskPermissions(task.ref.environmentId);
  const actions = useTaskActions();
  const ownRunLive = task.liveRuns.some((run) => run.taskId === task.ref.taskId);
  const copyLink = async () => {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    const copied = await writeTextToClipboard(url.href).then(
      () => true,
      () => false,
    );
    toastManager.add(
      copied
        ? { type: "success", title: "Link copied" }
        : { type: "error", title: "Couldn't copy the link." },
    );
  };
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost-muted" size="icon-xs" aria-label="Task actions" />}
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        {task.status === "canceled" ? (
          <MenuItem
            disabled={!permissions.update}
            onClick={() => void actions.setLane(task, "backlog")}
          >
            <ArchiveRestoreIcon aria-hidden />
            Restore
          </MenuItem>
        ) : (
          <MenuItem
            variant="destructive"
            disabled={!permissions.update || ownRunLive}
            onClick={() => void actions.cancel(task)}
          >
            <CircleXIcon aria-hidden />
            Cancel task
          </MenuItem>
        )}
        {task.result?.state === "accepted" ? (
          <MenuItem disabled={!permissions.reopen} onClick={() => void actions.reopen(task)}>
            <RotateCcwIcon aria-hidden />
            Reopen
          </MenuItem>
        ) : null}
        {proposal ? (
          <MenuItem
            disabled={!permissions.resolvePlan}
            onClick={() => void actions.resolvePlan(task, proposal, "dismiss")}
          >
            <ListXIcon aria-hidden />
            Dismiss plan
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => void copyLink()}>
          <LinkIcon aria-hidden />
          Copy link
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
