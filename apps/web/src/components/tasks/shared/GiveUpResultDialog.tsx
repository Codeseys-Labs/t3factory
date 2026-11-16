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
import { presentGiveUpFolder } from "./GiveUpResultDialog.logic";
import { useTaskActions } from "./taskActions";

/**
 * Opens the confirmation for giving up a held run's result. The task and run are copied when the
 * confirmation opens, so a live update cannot swap in a pair the person never confirmed; the
 * server refuses that copy once it is no longer the held run.
 */
export function useGiveUpResult(task: FactoryTaskSummary | null): {
  open: (run: FactoryTaskRun) => void;
  dialog: ReactNode;
} {
  const [confirming, setConfirming] = useState<{
    readonly task: FactoryTaskSummary;
    readonly run: FactoryTaskRun;
  } | null>(null);
  return {
    open: (run) => {
      if (task !== null) setConfirming({ task, run });
    },
    dialog:
      confirming === null ? null : (
        <GiveUpResultDialog {...confirming} onClose={() => setConfirming(null)} />
      ),
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
  const [folder] = useState(() =>
    presentGiveUpFolder({
      workspace: run.setup.workspace,
      worktreePath: shell?.worktreePath ?? null,
      projectRoot: project?.workspaceRoot ?? null,
    }),
  );
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
            The task won't use what run {run.ordinal} made, and you can retry or reassign it.{" "}
            {folder.lead}
            {folder.path === null ? null : (
              <>
                {" "}
                <span className="break-all font-mono text-foreground">{folder.path}</span>
              </>
            )}
            {folder.tail}
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
