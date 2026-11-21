import type { FactoryTaskPlanProposal, FactoryTaskSummary } from "@t3tools/contracts";
import { resolveFactoryTaskDrop } from "@t3tools/client-runtime/state/factory-task-view";
import {
  ArchiveRestoreIcon,
  CircleXIcon,
  CheckIcon,
  EllipsisIcon,
  LinkIcon,
  ListXIcon,
  RotateCcwIcon,
} from "lucide-react";

import { msg, T, useGT } from "gt-react";

import { m } from "../../../i18n/messages";
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
  const gt = useGT();
  const runLive = task.liveRuns.length > 0;
  const lane = task.status === "done" ? "ready" : "done";
  const manualMove =
    task.assignee.assignment.mode === "person" &&
    (task.status === "done"
      ? task.lane === "done" && task.result?.state !== "accepted"
      : task.status !== "canceled");
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
        ? { type: "success", title: m(msg("Link copied")) }
        : { type: "error", title: m(msg("Couldn't copy the link.")) },
    );
  };
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost-muted" size="icon-xs" aria-label={gt("Task actions")} />}
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        {manualMove ? (
          <MenuItem
            disabled={!permissions.update || resolveFactoryTaskDrop(task, lane).kind !== "move"}
            onClick={() => void actions.setLane(task, lane)}
          >
            {lane === "done" ? <CheckIcon aria-hidden /> : <ArchiveRestoreIcon aria-hidden />}
            {lane === "done" ? <T>Mark done</T> : <T>Move to Ready</T>}
          </MenuItem>
        ) : null}
        {task.status === "canceled" ? (
          <MenuItem
            disabled={!permissions.update}
            onClick={() => void actions.setLane(task, "backlog")}
          >
            <ArchiveRestoreIcon aria-hidden />
            <T>Restore</T>
          </MenuItem>
        ) : (
          <MenuItem
            variant="destructive"
            disabled={!permissions.update || runLive}
            onClick={() => void actions.cancel(task)}
          >
            <CircleXIcon aria-hidden />
            <T>Cancel task</T>
          </MenuItem>
        )}
        {task.result?.state === "accepted" ? (
          <MenuItem disabled={!permissions.reopen} onClick={() => void actions.reopen(task)}>
            <RotateCcwIcon aria-hidden />
            <T>Reopen</T>
          </MenuItem>
        ) : null}
        {proposal ? (
          <MenuItem
            disabled={!permissions.resolvePlan}
            onClick={() => void actions.resolvePlan(task, proposal, "dismiss")}
          >
            <ListXIcon aria-hidden />
            <T>Dismiss plan</T>
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => void copyLink()}>
          <LinkIcon aria-hidden />
          <T>Copy link</T>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
