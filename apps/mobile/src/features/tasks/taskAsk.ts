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

import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
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
  { readonly wants: string; readonly detailLabel: string }
> = {
  command: { wants: msg("Wants to run"), detailLabel: msg("Command") },
  "file-change": {
    wants: msg("Wants to change files"),
    detailLabel: msg("Change", { $context: "noun, a file change an agent asked to make" }),
  },
  "file-read": {
    wants: msg("Wants to read files"),
    detailLabel: msg("Files"),
  },
  "mcp-elicitation": {
    wants: msg("Needs your input"),
    detailLabel: msg("Request"),
  },
  permission: { wants: msg("Needs permission"), detailLabel: msg("Request") },
};

export function approvalCopy(kind: ProviderRequestKind) {
  return APPROVAL_COPY[kind];
}

/** `4m ago`, or `just now` inside the first minute. */
export function agoLabel(at: string, now: number, resolve: MessageResolver = m): string {
  const started = Date.parse(at);
  const underAMinute = Number.isNaN(started) || Math.floor(Math.max(0, now - started) / 60_000) < 1;
  return underAMinute
    ? resolve(msg("just now"))
    : resolve(msg("{elapsed} ago", { elapsed: elapsedSince(at, now, resolve) }));
}

const ACTIVITY_LINES = 6;

/** The latest activity, oldest first, each with how long ago it happened. */
export function activityLines(
  entries: readonly FactoryTaskActivityEntry[],
  catalog: FactoryTaskCatalog,
  now: number,
  resolve: MessageResolver = m,
): readonly { readonly key: string; readonly text: string }[] {
  return entries.slice(-ACTIVITY_LINES).map((entry) => {
    const text = presentFactoryTaskActivity(entry, catalog);
    const author = presentFactoryTaskActor(entry.actor, catalog);
    const line =
      entry.actor.kind === "agent" && !text.startsWith(author) ? `${author} · ${text}` : text;
    return { key: entry.id, text: `${line} · ${agoLabel(entry.at, now, resolve)}` };
  });
}

/** The words for who asked, per approval kind, as one sentence with how long ago it was. */
function approvalAskedLine(
  kind: ProviderRequestKind,
  assignee: string,
  ago: string,
  resolve: MessageResolver,
): string {
  switch (kind) {
    case "command":
      return resolve(msg("{assignee} asked to run a command · {ago}", { assignee, ago }));
    case "file-change":
      return resolve(msg("{assignee} asked to change files · {ago}", { assignee, ago }));
    case "file-read":
      return resolve(msg("{assignee} asked to read files · {ago}", { assignee, ago }));
    case "mcp-elicitation":
      return resolve(msg("{assignee} asked for input · {ago}", { assignee, ago }));
    case "permission":
      return resolve(msg("{assignee} asked for permission · {ago}", { assignee, ago }));
  }
}

/** The lines the live ask adds after the recorded activity. */
export function askLines(
  ask: TaskAsk,
  assigneeLabel: string,
  now: number,
  resolve: MessageResolver = m,
): readonly string[] {
  return ask.kind === "question"
    ? [
        resolve(
          msg("{assignee} asked a question · {ago}", {
            assignee: assigneeLabel,
            ago: agoLabel(ask.input.createdAt, now, resolve),
          }),
        ),
        resolve(msg("Waiting for your answer")),
      ]
    : [
        approvalAskedLine(
          ask.approval.requestKind,
          assigneeLabel,
          agoLabel(ask.approval.createdAt, now, resolve),
          resolve,
        ),
      ];
}
