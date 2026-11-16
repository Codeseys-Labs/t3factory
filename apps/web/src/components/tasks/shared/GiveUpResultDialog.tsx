import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { FactoryTaskRun, FactoryTaskSummary } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

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
 * Opens the confirmation for giving up a held run's result. The run is copied when the
 * confirmation opens, so a live update cannot swap in a run the person never confirmed; the
 * server refuses that copy once it is no longer the held run.
 */
export function useGiveUpResult(task: FactoryTaskSummary | null): {
  open: (run: FactoryTaskRun) => void;
  dialog: ReactNode;
} {
  const [run, setRun] = useState<FactoryTaskRun | null>(null);
  return {
    open: setRun,
    dialog:
      task !== null && run !== null ? (
        <GiveUpResultDialog task={task} run={run} onClose={() => setRun(null)} />
      ) : null,
  };
}

function GiveUpResultDialog({
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
  const [folder] = useState(
    () => (inProject ? null : shell?.worktreePath) ?? project?.workspaceRoot ?? null,
  );
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
