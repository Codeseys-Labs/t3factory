import type {
  FactoryTaskActivityEntry,
  FactoryTaskSummary,
  ProviderApprovalDecision,
  ProviderRequestKind,
} from "@t3tools/contracts";
import {
  presentFactoryTaskActivity,
  presentFactoryTaskActor,
  type FactoryTaskCatalog,
  type FactoryTaskNeed,
} from "@t3tools/client-runtime/state/factory-task-view";
import type {
  PendingThreadRequests,
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";

import { elapsedSince } from "./taskPresentation";

export type TaskAsk =
  | {
      readonly kind: "question";
      readonly need: FactoryTaskNeed;
      readonly input: ThreadPendingUserInput;
    }
  | {
      readonly kind: "approval";
      readonly need: FactoryTaskNeed;
      readonly approval: ThreadPendingApproval;
    };

/**
 * The ask this screen answers: the task's own approval first, then its own question. A sub-task's
 * ask belongs to the sub-task's screen, which the parent's banner opens.
 */
export function resolveTaskAsk(input: {
  readonly task: FactoryTaskSummary;
  readonly attention: readonly FactoryTaskNeed[];
  readonly requests: PendingThreadRequests;
}): TaskAsk | null {
  const own = input.attention.filter(
    (need) => need.ref.taskId === input.task.ref.taskId && need.requestId !== null,
  );
  for (const need of own) {
    if (need.reason === "approve") {
      const approval = input.requests.approvals.find((item) => item.requestId === need.requestId);
      if (approval) return { kind: "approval", need, approval };
    }
  }
  for (const need of own) {
    if (need.reason === "question") {
      const question = input.requests.userInputs.find((item) => item.requestId === need.requestId);
      if (question) return { kind: "question", need, input: question };
    }
  }
  return null;
}

/** What the provider lets this approval answer with. No listed options means all three. */
export function approvalAvailability(approval: ThreadPendingApproval) {
  const offers = (decision: ProviderApprovalDecision) =>
    approval.responseCapability === "live" &&
    (!approval.options || approval.options.some((option) => option.decision === decision));
  return {
    approve: offers("accept"),
    alwaysAllow: offers("acceptForSession"),
    deny: offers("decline"),
  };
}

const APPROVAL_COPY: Record<
  ProviderRequestKind,
  { readonly wants: string; readonly detailLabel: string; readonly asked: string }
> = {
  command: { wants: "Wants to run", detailLabel: "Command", asked: "asked to run a command" },
  "file-change": {
    wants: "Wants to change files",
    detailLabel: "Change",
    asked: "asked to change files",
  },
  "file-read": {
    wants: "Wants to read files",
    detailLabel: "Files",
    asked: "asked to read files",
  },
  "mcp-elicitation": {
    wants: "Needs your input",
    detailLabel: "Request",
    asked: "asked for input",
  },
  permission: { wants: "Needs permission", detailLabel: "Request", asked: "asked for permission" },
};

export function approvalCopy(kind: ProviderRequestKind) {
  return APPROVAL_COPY[kind];
}

/** `4m ago`, or `just now` inside the first minute. */
export function agoLabel(at: string, now: number): string {
  const elapsed = elapsedSince(at, now);
  return elapsed === "<1m" ? "just now" : `${elapsed} ago`;
}

const ACTIVITY_LINES = 6;

/** The latest activity, oldest first, each with how long ago it happened. */
export function activityLines(
  entries: readonly FactoryTaskActivityEntry[],
  catalog: FactoryTaskCatalog,
  now: number,
): readonly { readonly key: string; readonly text: string }[] {
  return entries.slice(-ACTIVITY_LINES).map((entry) => {
    const text = presentFactoryTaskActivity(entry, catalog);
    const author = presentFactoryTaskActor(entry.actor, catalog);
    const line =
      entry.actor.kind === "agent" && !text.startsWith(author) ? `${author} · ${text}` : text;
    return { key: entry.id, text: `${line} · ${agoLabel(entry.at, now)}` };
  });
}

/** The lines the live ask adds after the recorded activity. */
export function askLines(ask: TaskAsk, assigneeLabel: string, now: number): readonly string[] {
  return ask.kind === "question"
    ? [
        `${assigneeLabel} asked a question · ${agoLabel(ask.input.createdAt, now)}`,
        "Waiting for your answer",
      ]
    : [
        `${assigneeLabel} ${approvalCopy(ask.approval.requestKind).asked} · ${agoLabel(ask.approval.createdAt, now)}`,
      ];
}
