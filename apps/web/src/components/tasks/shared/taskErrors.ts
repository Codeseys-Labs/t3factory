import {
  EnvironmentAuthorizationError,
  FactoryIntakeError,
  FactoryTaskError,
  type FactoryTaskSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isTaskError = Schema.is(FactoryTaskError);
const isIntakeError = Schema.is(FactoryIntakeError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

export const TASK_PERMISSION_MESSAGE = "Ask the owner of this environment for access.";
const FALLBACK = "Something went wrong. Try again.";

type TaskReason = FactoryTaskError["reason"];
type IntakeReason = FactoryIntakeError["reason"];

const SHARED: Record<TaskReason & IntakeReason, string> = {
  "wrong-environment": "This belongs to another environment.",
  "missing-project": "This project was removed.",
  "missing-task": "This task was removed.",
  forbidden: TASK_PERMISSION_MESSAGE,
  "version-conflict": "Someone else changed this. Try again.",
  "command-conflict": "This request was already sent with other details. Try again.",
  "invalid-input": "Check what you entered and try again.",
  "invalid-cursor": "The list changed. Reload it.",
  "name-taken": "That name is taken. Choose another.",
  "persistence-failure": "The change could not be saved. Try again.",
};

const TASK: Omit<Record<TaskReason, string>, keyof typeof SHARED> = {
  "missing-profile": "That agent profile was deleted. Pick another assignee.",
  "missing-proposal": "The plan was replaced. Review the latest one.",
  "invalid-transition": "The task cannot move there from its current status.",
  "run-active": "Stop the run first.",
  blocked: "This task waits on another task.",
  "no-run": "This action needs a work run on this task.",
  "no-result": "Wait for a result first.",
  "result-conflict": "A newer result arrived. Review it first.",
  "assignee-unresolved": "Pick who does this task first.",
  "provider-unavailable": "That agent is unavailable on this machine. Pick another one.",
  "unsupported-capability": "That agent can't run tasks on this machine yet. Pick another one.",
  "task-limit": "A top-level task holds at most 64 tasks.",
  "not-accepted": "Accept the result first.",
  "not-code": "Only a code result becomes a pull request.",
  "not-published": "Publish the pull request first.",
  "delivery-active": "This was already sent. Wait for it, or Check it if it stays unconfirmed.",
  "delivery-refused": "The repository's host refused it. Try again later.",
};

const INTAKE: Omit<Record<IntakeReason, string>, keyof typeof SHARED> = {
  "missing-source": "That source was removed.",
  "missing-rule": "That rule was removed.",
  "missing-arrival": "That item already left the Inbox.",
  "source-unavailable": "The source is unreachable. Try again later.",
  "already-resolved": "Someone already handled this.",
  "autonomy-not-allowed": "A rule can suggest tasks. Auto-start stays off.",
};

const TASK_MESSAGES: Record<TaskReason, string> = { ...SHARED, ...TASK };
const INTAKE_MESSAGES: Record<IntakeReason, string> = { ...SHARED, ...INTAKE };

/**
 * One plain sentence for a refused task or intake command. `task` sharpens the sentences that
 * depend on where the task stands, such as naming the blocker it waits on.
 */
export function taskErrorMessage(
  error: unknown,
  context: {
    readonly task?: Pick<FactoryTaskSummary, "blockedBy" | "status" | "result" | "lane"> | null;
  } = {},
): string {
  if (isAuthorizationError(error)) return TASK_PERMISSION_MESSAGE;
  if (isTaskError(error)) {
    const task = context.task;
    if (error.reason === "blocked" && task && task.blockedBy.length > 0)
      return `This task waits on ${task.blockedBy.map((blocker) => blocker.displayId).join(", ")}.`;
    // The server words these itself, since only it knows which check failed.
    if (
      (error.reason === "delivery-refused" ||
        error.reason === "run-active" ||
        error.reason === "unsupported-capability") &&
      error.detail
    )
      return error.detail;
    if (error.reason === "invalid-transition" && task) {
      if (task.status === "in-review") return "Accept the result first.";
      if (task.status === "done" && task.result?.state === "accepted")
        return "Reopen the task first.";
    }
    return TASK_MESSAGES[error.reason];
  }
  if (isIntakeError(error)) return INTAKE_MESSAGES[error.reason];
  return FALLBACK;
}
