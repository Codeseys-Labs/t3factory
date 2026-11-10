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
  "no-run": "Start the task first.",
  "no-result": "Wait for a result first.",
  "result-conflict": "A newer result arrived. Review it first.",
  "assignee-unresolved": "Pick who does this task first.",
  "provider-unavailable": "That agent is unavailable on this machine. Pick another one.",
  "unsupported-capability": "Update this environment's server to use tasks.",
  "task-limit": "A top-level task holds at most 64 tasks.",
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
