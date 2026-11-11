import { useAtomValue } from "@effect/atom-react";
import {
  type FactoryTaskNeed,
  factoryTaskKey,
} from "@t3tools/client-runtime/state/factory-task-view";
import type {
  FactoryTaskDetail,
  FactoryTaskSummary,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { factoryTasks, useFactoryTaskRequests } from "../../../state/factoryTasks";
import { toastManager } from "../../ui/toast";
import { openTaskSetup } from "../taskDialogs";
import { type KitAction, NeedsYouRow } from "../kit";
import { useTaskActions, useTaskPermissions } from "./taskActions";
import { useTaskAssigneeChip } from "./taskAssigneeChip";

const NO_DETAIL: Atom.Atom<AsyncResult.AsyncResult<FactoryTaskDetail, unknown>> = Atom.make(
  AsyncResult.initial(false),
);

/** The task a need belongs to: the one given, or its detail when a parent carried the need. */
function useNeedTask(need: FactoryTaskNeed, task: FactoryTaskSummary | null) {
  const matches = task !== null && factoryTaskKey(task.ref) === factoryTaskKey(need.ref);
  const detail = useAtomValue(
    matches
      ? NO_DETAIL
      : factoryTasks.readTask({
          environmentId: need.ref.environmentId,
          input: { task: { ref: need.ref } },
        }),
  );
  if (matches) return task;
  return detail._tag === "Success" ? detail.value.task : null;
}

type RowProps = {
  need: FactoryTaskNeed;
  task: FactoryTaskSummary | null;
  layout?: "row" | "stacked" | undefined;
  selected?: boolean | undefined;
  onOpen: () => void;
};

/** One ask in a Needs-you list, with the one action that fits its reason. */
export function TaskNeedsRow(props: RowProps) {
  const task = useNeedTask(props.need, props.task);
  if (props.need.reason === "approve" && props.need.threadId && props.need.requestId)
    return (
      <ApproveRow
        {...props}
        task={task}
        threadId={props.need.threadId}
        requestId={props.need.requestId}
      />
    );
  return <NeedsRow {...props} task={task} />;
}

function NeedsRow({ need, task, layout, selected, onOpen }: RowProps) {
  const actions = useTaskActions();
  const permissions = useTaskPermissions(need.ref.environmentId);
  const [retrying, setRetrying] = useState(false);
  const action: KitAction =
    need.reason === "failed" && task?.run?.purpose === "planning"
      ? {
          label: "Break down",
          disabled: !permissions.start,
          onClick: () => openTaskSetup(task.ref, "break-down"),
        }
      : need.reason === "failed"
        ? {
            label: "Retry",
            disabled: task === null || !permissions.retry || retrying,
            onClick: () => {
              if (task === null) return;
              setRetrying(true);
              void actions.retry(task).then(() => setRetrying(false));
            },
          }
        : { label: need.reason === "question" ? "Answer" : "Review", onClick: onOpen };
  return (
    <Row
      need={need}
      task={task}
      layout={layout}
      selected={selected}
      onOpen={onOpen}
      action={action}
    />
  );
}

function ApproveRow({
  need,
  task,
  layout,
  selected,
  onOpen,
  threadId,
  requestId,
}: RowProps & { threadId: ThreadId; requestId: RuntimeRequestId }) {
  const requests = useFactoryTaskRequests(need.ref.environmentId, threadId);
  const [sending, setSending] = useState(false);
  const live = requests.approvals.some(
    (approval) => approval.requestId === requestId && approval.responseCapability === "live",
  );
  const action: KitAction = {
    label: "Approve once",
    tone: "primary",
    disabled: !requests.canRespond || !live || sending,
    onClick: () => {
      setSending(true);
      void requests.approveOnce(requestId).then((result) => {
        setSending(false);
        if (result?._tag !== "Success")
          toastManager.add({ type: "error", title: "Try approving again." });
      });
    },
  };
  return (
    <Row
      need={need}
      task={task}
      layout={layout}
      selected={selected}
      onOpen={onOpen}
      action={action}
    />
  );
}

function Row({ need, task, layout, selected, onOpen, action }: RowProps & { action: KitAction }) {
  const assignee = useTaskAssigneeChip(
    task?.assignee ?? { assignment: { mode: "unassigned" }, key: "unassigned", resolved: null },
    need.ref.environmentId,
  );
  return (
    <NeedsYouRow
      reason={need.reason}
      taskId={need.displayId}
      title={task?.title ?? ""}
      detail={need.detail}
      detailIsCommand={need.reason === "approve"}
      assignee={assignee}
      {...(layout ? { layout } : {})}
      {...(selected === undefined ? {} : { selected })}
      action={action}
      onOpen={onOpen}
    />
  );
}
