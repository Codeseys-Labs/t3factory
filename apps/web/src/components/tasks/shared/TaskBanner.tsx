import { useAtomValue } from "@effect/atom-react";
import {
  type FactoryTaskBannerAction,
  presentFactoryTaskBanner,
} from "@t3tools/client-runtime/state/factory-task-view";
import type {
  FactoryTaskDetail,
  FactoryTaskPlanProposalReadResult,
  FactoryTaskSummary,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { useEnvironmentPresentation } from "../../../state/presentation";
import { factoryTasks } from "../../../state/factoryTasks";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Textarea } from "../../ui/textarea";
import { assigneeText, type KitAction, StatusBanner, type StatusBannerState } from "../kit";
import { openTaskSetup } from "../taskDialogs";
import { TaskAsk } from "./TaskAsk";
import { useTaskActions, useTaskPermissions } from "./taskActions";
import { useTaskAssigneeChip } from "./taskAssigneeChip";
import { presentTaskSetup } from "./taskAssigneeModel";
import { useTaskCatalog } from "./taskCatalog";
import { useTaskLive } from "./taskLive";
import { useTaskPullRequestChecks } from "./taskPullRequest";

const NO_PLAN: Atom.Atom<AsyncResult.AsyncResult<FactoryTaskPlanProposalReadResult, unknown>> =
  Atom.make(AsyncResult.initial(false));

const BANNER_STATES: Record<string, StatusBannerState> = {
  canceled: "backlog",
  done: "done",
  "subtask-attention": "needs-you",
  failed: "failed",
  lost: "failed",
  approval: "needs-you",
  question: "needs-you",
  unconfirmed: "needs-you",
  plan: "plan-proposed",
  changed: "in-review",
  review: "in-review",
  working: "in-progress",
  blocked: "blocked",
  backlog: "backlog",
  ready: "ready",
};

/**
 * Where the task stands and the action that fits, under the task title. A question or approval
 * on the task's own run takes the banner's place.
 */
export function TaskBanner({
  task,
  detail,
  onEditPlan,
}: {
  task: FactoryTaskSummary;
  detail?: FactoryTaskDetail;
  onEditPlan?: () => void;
}) {
  const { environmentId } = task.ref;
  const { pill, needs } = useTaskLive(task);
  const chip = useTaskAssigneeChip(task.assignee, environmentId);
  const catalog = useTaskCatalog(environmentId);
  const permissions = useTaskPermissions(environmentId);
  const actions = useTaskActions();
  const navigate = useNavigate();
  const machine = useEnvironmentPresentation(environmentId).presentation?.entry.target.label;
  const checks = useTaskPullRequestChecks(task);
  const [busy, setBusy] = useState(false);
  const [requestingChanges, setRequestingChanges] = useState(false);
  const need = needs[0];
  const wantsPlan = needs.some(
    (entry) => entry.reason === "plan" && entry.ref.taskId === task.ref.taskId,
  );
  const plan = useAtomValue(
    wantsPlan
      ? factoryTasks.readTaskPlanProposal({ environmentId, input: { ref: task.ref } })
      : NO_PLAN,
  );

  const runLabel = task.run ? presentTaskSetup(task.run.setup, catalog).label : null;
  const askFrom = runLabel ?? assigneeText(chip);
  if (
    need &&
    need.ref.taskId === task.ref.taskId &&
    (need.reason === "question" || need.reason === "approve") &&
    need.threadId !== null
  )
    return <TaskAsk environmentId={environmentId} threadId={need.threadId} from={askFrom} />;

  const proposal = plan._tag === "Success" ? plan.value.proposal : null;
  const where = [runLabel, machine].filter(Boolean).join(" · ");
  const presented = presentFactoryTaskBanner({
    task,
    attention: needs,
    assigneeLabel: assigneeText(chip),
    liveLabel: pill ? `${pill.label} · ${pill.duration}` : null,
    ...(proposal ? { planCount: proposal.items.length } : {}),
    checks,
    ...(where
      ? {
          runDetail:
            need?.reason === "failed" && task.run ? `Run ${task.run.ordinal} · ${where}` : where,
        }
      : {}),
  });
  let { title, detail: line } = presented;
  if (presented.state === "subtask-attention" && need) {
    title = `${need.displayId} ${need.reason === "question" ? "is waiting on an answer" : "needs you"}`;
    line = task.progress
      ? `${task.progress.done} of ${task.progress.total} sub-tasks done`
      : need.detail;
  }

  const displayIdOf = (taskId: string) =>
    [
      ...task.attention,
      ...task.blockedBy,
      ...task.liveRuns,
      ...(detail?.subtasks.map((subtask) => ({
        taskId: subtask.ref.taskId,
        displayId: subtask.displayId,
      })) ?? []),
    ].find((entry) => entry.taskId === taskId)?.displayId ?? null;

  const runAction = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().then(() => setBusy(false));
  };
  const revision = task.result?.revision;
  const acceptedRevision = task.result?.acceptedRevision ?? undefined;

  const toKit = (action: FactoryTaskBannerAction | null): KitAction | undefined => {
    if (action === null) return undefined;
    const kit = (onClick: () => void, allowed: boolean, tone?: KitAction["tone"]): KitAction => ({
      label: action.label,
      onClick,
      disabled: busy || !allowed,
      ...(tone ? { tone } : {}),
    });
    switch (action.kind) {
      case "start":
        return kit(() => openTaskSetup(task.ref, "start"), permissions.start);
      case "reassign":
        return kit(() => openTaskSetup(task.ref, "retry"), permissions.retry);
      case "retry":
        return kit(() => runAction(() => actions.retry(task)), permissions.retry);
      case "break-down":
        return kit(() => openTaskSetup(task.ref, "break-down"), permissions.breakDown);
      case "stop":
        return kit(() => runAction(() => actions.stop(task)), permissions.stop, "danger");
      case "accept":
        return kit(
          () => revision !== undefined && runAction(() => actions.accept(task, revision)),
          permissions.accept && revision !== undefined,
        );
      case "request-changes":
        return kit(
          () => setRequestingChanges(true),
          permissions.requestChanges && revision !== undefined,
        );
      case "reopen":
        return kit(() => runAction(() => actions.reopen(task)), permissions.reopen);
      case "publish":
        return kit(
          () =>
            acceptedRevision !== undefined &&
            runAction(() => actions.publish(task, acceptedRevision)),
          permissions.publish && acceptedRevision !== undefined,
        );
      case "merge":
        return kit(
          () =>
            acceptedRevision !== undefined &&
            runAction(() => actions.merge(task, acceptedRevision)),
          permissions.merge && acceptedRevision !== undefined,
        );
      case "check":
        return kit(() => runAction(() => actions.check(task)), permissions.check);
      case "approve-plan":
        return kit(
          () => proposal && runAction(() => actions.resolvePlan(task, proposal, "approve")),
          permissions.resolvePlan && proposal !== null,
        );
      case "edit-plan":
        return onEditPlan ? kit(onEditPlan, true) : undefined;
      case "open-task": {
        const displayId = action.taskId ? displayIdOf(action.taskId) : null;
        return displayId
          ? kit(
              () =>
                void navigate({
                  to: "/tasks/$environmentId/$displayId",
                  params: { environmentId, displayId },
                }),
              true,
            )
          : undefined;
      }
      default:
        return undefined;
    }
  };
  const primary = toKit(presented.primary);
  const secondary = toKit(presented.secondary);

  return (
    <>
      <StatusBanner
        state={BANNER_STATES[presented.state] ?? "backlog"}
        headline={title}
        {...(line ? { detail: line } : {})}
        {...(primary ? { primary } : {})}
        {...(secondary ? { secondary } : {})}
      />
      {requestingChanges && revision !== undefined ? (
        <RequestChangesDialog
          onClose={() => setRequestingChanges(false)}
          onSend={async (note) => {
            const sent = await actions.requestChanges(task, revision, note);
            if (sent !== null) setRequestingChanges(false);
          }}
        />
      ) : null}
    </>
  );
}

function RequestChangesDialog({
  onClose,
  onSend,
}: {
  onClose: () => void;
  onSend: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const trimmed = note.trim();
  const submit = async () => {
    if (!trimmed || sending) return;
    setSending(true);
    await onSend(trimmed);
    setSending(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Request changes</DialogTitle>
            <DialogDescription>The agent gets this note and makes a new result.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Textarea
              aria-label="What should change"
              placeholder="What should change?"
              value={note}
              autoFocus
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed || sending}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
