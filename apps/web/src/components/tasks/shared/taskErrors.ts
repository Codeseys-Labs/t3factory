import {
  EnvironmentAuthorizationError,
  FactoryIntakeError,
  FactoryTaskError,
  type FactoryTaskSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

const isTaskError = Schema.is(FactoryTaskError);
const isIntakeError = Schema.is(FactoryIntakeError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

export const TASK_PERMISSION_MESSAGE = msg("Ask the owner of this environment for access.");
const FALLBACK = msg("Something went wrong. Try again.");

type TaskReason = FactoryTaskError["reason"];
type IntakeReason = FactoryIntakeError["reason"];

const SHARED: Record<TaskReason & IntakeReason, string> = {
  "wrong-environment": msg("This belongs to another environment."),
  "missing-project": msg("This project was removed."),
  "missing-task": msg("This task was removed."),
  forbidden: TASK_PERMISSION_MESSAGE,
  "version-conflict": msg("Someone else changed this. Try again."),
  "command-conflict": msg("This request was already sent with other details. Try again."),
  "invalid-input": msg("Check what you entered and try again."),
  "invalid-cursor": msg("The list changed. Reload it."),
  "name-taken": msg("That name is taken. Choose another."),
  "persistence-failure": msg("The change could not be saved. Try again."),
};

const TASK: Omit<Record<TaskReason, string>, keyof typeof SHARED> = {
  "missing-profile": msg("That agent profile was deleted. Pick another assignee."),
  "missing-proposal": msg("The plan was replaced. Review the latest one."),
  "invalid-transition": msg("The task cannot move there from its current status."),
  "run-active": msg("Stop the run first."),
  blocked: msg("This task waits on another task."),
  "no-run": msg("This action needs a work run on this task."),
  "no-result": msg("Wait for a result first."),
  "result-conflict": msg("A newer result arrived. Review it first."),
  "assignee-unresolved": msg("Pick who does this task first."),
  "provider-unavailable": msg("That agent is unavailable on this machine. Pick another one."),
  "unsupported-capability": msg(
    "That agent can't run tasks on this machine yet. Pick another one.",
  ),
  "task-limit": msg("A top-level task holds at most 64 tasks."),
  "not-accepted": msg("Accept the result first."),
  "not-code": msg("Only a code result becomes a pull request."),
  "not-published": msg("Publish the pull request first."),
  "delivery-active": msg(
    "This was already sent. Wait for it, or Check it if it stays unconfirmed.",
  ),
  "delivery-refused": msg("The repository's host refused it. Try again later."),
};

const INTAKE: Omit<Record<IntakeReason, string>, keyof typeof SHARED> = {
  "missing-source": msg("That source was removed."),
  "missing-rule": msg("That rule was removed."),
  "missing-arrival": msg("That item already left the Inbox."),
  "source-unavailable": msg("The source is unreachable. Try again later."),
  "already-resolved": msg("Someone already handled this."),
  "autonomy-not-allowed": msg("A rule can suggest tasks. Auto-start stays off."),
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
  resolve: MessageResolver = m,
): string {
  if (isAuthorizationError(error)) return resolve(TASK_PERMISSION_MESSAGE);
  if (isTaskError(error)) {
    const task = context.task;
    if (error.reason === "blocked" && task && task.blockedBy.length > 0)
      return resolve(
        msg("This task waits on {blockers}.", {
          blockers: task.blockedBy.map((blocker) => blocker.displayId).join(", "),
        }),
      );
    // The server words these itself, since only it knows which check failed.
    if (
      (error.reason === "delivery-refused" ||
        error.reason === "run-active" ||
        error.reason === "invalid-transition" ||
        error.reason === "unsupported-capability") &&
      error.detail
    )
      return error.detail;
    if (error.reason === "invalid-transition" && task) {
      if (task.status === "in-review") return resolve(msg("Accept the result first."));
      if (task.status === "done" && task.result?.state === "accepted")
        return resolve(msg("Reopen the task first."));
    }
    return resolve(TASK_MESSAGES[error.reason]);
  }
  if (isIntakeError(error)) return resolve(INTAKE_MESSAGES[error.reason]);
  return resolve(FALLBACK);
}
