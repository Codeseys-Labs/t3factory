import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { FactoryTaskRun, FactoryTaskSummary } from "@t3tools/contracts";
import { useState } from "react";

import { useProject, useThreadShell } from "../../../state/entities";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { useTaskActions } from "./taskActions";

/**
 * Confirms giving up the result of a run held because it could not be saved. It names the run
 * the person saw, so a run that changed meanwhile is refused instead of given up.
 */
export function GiveUpResultDialog({
  task,
  run,
  onClose,
}: {
  task: FactoryTaskSummary;
  run: FactoryTaskRun;
  onClose: () => void;
}) {
  const actions = useTaskActions();
  const [sending, setSending] = useState(false);
  const shell = useThreadShell(scopeThreadRef(task.ref.environmentId, run.threadId));
  const project = useProject(scopeProjectRef(task.ref.environmentId, task.ref.projectId));
  const inProject = run.setup.workspace === "root";
  const folder = (inProject ? null : shell?.worktreePath) ?? project?.workspaceRoot ?? null;
  const path =
    folder === null ? null : <span className="break-all font-mono text-foreground">{folder}</span>;
  const confirm = async () => {
    setSending(true);
    const given = await actions.giveUp(task, run.runId);
    setSending(false);
    if (given !== null) onClose();
  };
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Give up the result of run {run.ordinal}?</AlertDialogTitle>
          <AlertDialogDescription>
            The task won't use what run {run.ordinal} made, and you can retry or reassign it.
            {inProject ? (
              <>
                Nothing is removed: the agent's changes stay in the project folder
                {path === null ? "" : " "}
                {path}.
              </>
            ) : (
              <>
                Nothing is removed: the agent's files stay in {path ?? "the run's folder"} until
                your Storage settings clean up that folder, as for any other thread.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </AlertDialogClose>
          <Button size="sm" variant="destructive" disabled={sending} onClick={() => void confirm()}>
            Give up result
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
