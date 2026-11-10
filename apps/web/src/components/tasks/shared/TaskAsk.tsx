import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { useFactoryTaskRequests } from "../../../state/factoryTasks";
import { toastManager } from "../../ui/toast";
import { ApprovalCard, type QuestionAnswer, QuestionCard } from "../kit";

const optionId = (option: { readonly label: string; readonly value?: string | undefined }) =>
  option.value ?? option.label;

type Requests = ReturnType<typeof useFactoryTaskRequests>;
type Settled = Promise<{ readonly _tag: string } | undefined>;

async function settle(sending: Settled, failure: string) {
  const result = await sending;
  if (result?._tag !== "Success") toastManager.add({ type: "error", title: failure });
}

/**
 * The thread's waiting request where a person answers it: an approval first, then a question.
 * Renders nothing while nothing waits.
 */
export function TaskAsk({
  environmentId,
  threadId,
  from,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  from: string;
}) {
  const requests = useFactoryTaskRequests(environmentId, threadId);
  if (requests.approval)
    return (
      <TaskApproval
        key={requests.approval.requestId}
        approval={requests.approval}
        requests={requests}
        from={from}
      />
    );
  if (requests.question)
    return (
      <TaskQuestion
        key={requests.question.requestId}
        question={requests.question}
        requests={requests}
        from={from}
      />
    );
  return null;
}

function TaskApproval({
  approval,
  requests,
  from,
}: {
  approval: ThreadPendingApproval;
  requests: Requests;
  from: string;
}) {
  const [sending, setSending] = useState(false);
  const respond = async (send: (id: RuntimeRequestId) => Settled) => {
    setSending(true);
    await settle(send(approval.requestId), "Try sending the answer again.");
    setSending(false);
  };
  const canRemember =
    !approval.options || approval.options.some((option) => option.decision === "acceptForSession");
  const command = approval.detail ?? approval.reason ?? "Approval requested";
  const unavailable = !requests.canRespond || approval.responseCapability !== "live";
  return (
    <ApprovalCard
      from={from}
      command={command}
      {...(approval.detail && approval.reason ? { detail: approval.reason } : {})}
      pending={sending || unavailable}
      onApproveOnce={() => void respond(requests.approveOnce)}
      {...(canRemember ? { onAlwaysAllow: () => void respond(requests.alwaysAllow) } : {})}
      onDeny={() => void respond(requests.deny)}
    />
  );
}

/** Several questions are asked one after another and sent as one answer set. */
function TaskQuestion({
  question: request,
  requests,
  from,
}: {
  question: ThreadPendingUserInput;
  requests: Requests;
  from: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [sending, setSending] = useState(false);
  const index = Math.min(Object.keys(drafts).length, request.questions.length - 1);
  const current = request.questions[index];
  if (!current) return null;
  const unavailable = !requests.canRespond || request.responseCapability === "not_resumable";

  const send = async (answer: QuestionAnswer) => {
    const draft: PendingUserInputDraftAnswer = {
      ...(answer.optionId === null ? {} : { selectedOptionValues: [answer.optionId] }),
      ...(answer.text ? { customAnswer: answer.text } : {}),
    };
    const next = { ...drafts, [current.id]: draft };
    if (index < request.questions.length - 1) {
      setDrafts(next);
      return;
    }
    const answers = buildPendingUserInputAnswers(request.questions, next);
    if (answers === null) {
      toastManager.add({ type: "error", title: "Choose one of the answers." });
      return;
    }
    setSending(true);
    await settle(requests.answer(request.requestId, answers), "Try sending the answer again.");
    setSending(false);
  };

  return (
    <QuestionCard
      key={current.id}
      from={from}
      question={
        request.questions.length > 1
          ? `${current.question} (${index + 1} of ${request.questions.length})`
          : current.question
      }
      options={current.options.map((option) => ({ id: optionId(option), label: option.label }))}
      pending={sending || unavailable}
      onSend={(answer) => void send(answer)}
    />
  );
}
