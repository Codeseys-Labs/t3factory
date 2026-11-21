import {
  EnvironmentAuthorizationError,
  ProjectCoordinatorError,
  type ProjectCoordinatorStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export function coordinatorPresentation(
  status: ProjectCoordinatorStatus,
  resolve: MessageResolver = m,
) {
  switch (status) {
    case "launching":
      return {
        label: resolve(msg("Launch pending")),
        detail: resolve(
          msg(
            "The launch has not finished. Resume uses the same thread and original orientation request.",
          ),
        ),
      };
    case "preparing":
      return {
        label: resolve(msg("Preparing")),
        detail: resolve(msg("The orchestrator thread is being prepared.")),
      };
    case "running":
      return {
        label: resolve(msg("Running")),
        detail: resolve(msg("The agent is running in the existing orchestrator thread.")),
      };
    case "idle":
      return {
        label: resolve(msg("Idle")),
        detail: resolve(msg("The orchestrator is waiting for your next request.")),
      };
    case "failed":
      return {
        label: resolve(msg("Failed")),
        detail: resolve(
          msg(
            "Open the existing thread to inspect the failure and use its retry controls. No replacement is created.",
          ),
        ),
      };
    case "archived":
      return {
        label: resolve(msg("Archived")),
        detail: resolve(
          msg("Open the existing thread to inspect or unarchive it. Opening sends no message."),
        ),
      };
    case "missing":
      return {
        label: resolve(msg("Unavailable")),
        detail: resolve(
          msg(
            "The saved orchestrator is missing or its startup cannot finish. Creating a replacement requires a new confirmation.",
          ),
        ),
      };
  }
}

export interface CoordinatorFailure {
  readonly title: string;
  readonly message: string;
  readonly requiresReview: boolean;
}

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isCoordinatorError = Schema.is(ProjectCoordinatorError);

export function coordinatorFailure(
  error: unknown,
  resolve: MessageResolver = m,
): CoordinatorFailure {
  if (isAuthorizationError(error)) {
    return {
      title: resolve(msg("Permission required")),
      message: resolve(
        msg("This connection does not have permission for this orchestrator request."),
      ),
      requiresReview: true,
    };
  }
  if (isCoordinatorError(error)) {
    switch (error.reason) {
      case "ineligible-thread":
        return {
          title: resolve(msg("Thread unavailable")),
          message: error.message,
          requiresReview: true,
        };
      case "missing-project":
        return {
          title: resolve(msg("Project unavailable")),
          message: resolve(
            msg(
              "The selected project no longer exists. Close this dialog and choose an available checkout.",
            ),
          ),
          requiresReview: true,
        };
      case "provider-unavailable":
        return {
          title: resolve(msg("Provider unavailable")),
          message: resolve(
            msg(
              "The selected provider or model is unavailable. Close this dialog and review the provider settings.",
            ),
          ),
          requiresReview: true,
        };
      case "retired-coordinator":
      case "binding-changed":
        return {
          title: resolve(msg("Orchestrator binding changed")),
          message: resolve(
            msg(
              "Close this dialog and review the refreshed orchestrator before confirming another request.",
            ),
          ),
          requiresReview: true,
        };
      case "command-conflict":
        return {
          title: resolve(msg("Request conflict")),
          message: resolve(
            msg(
              "This request cannot be reused for this destination. Close the dialog and review a new request.",
            ),
          ),
          requiresReview: true,
        };
      case "launch-authority":
        return {
          title: resolve(msg("Launch mode not permitted")),
          message: resolve(
            msg(
              "This connection cannot launch with the requested modes. Close the dialog and review the modes and permissions.",
            ),
          ),
          requiresReview: true,
        };
      case "launch-failed":
        return {
          title: resolve(msg("Launch did not finish")),
          message: resolve(
            msg(
              "The orientation launch did not finish. Retry the same request to recover its existing thread without sending another orientation.",
            ),
          ),
          requiresReview: false,
        };
      case "persistence-failure":
        return {
          title: resolve(msg("Could not save the orchestrator")),
          message: resolve(
            msg(
              "The environment could not persist this request. Retry the same request or reconnect before reviewing its state.",
            ),
          ),
          requiresReview: false,
        };
    }
  }
  return {
    title: resolve(msg("Orchestrator request failed")),
    message: resolve(
      msg(
        "The environment could not complete the request. Check the connection, then refresh or retry the same request.",
      ),
    ),
    requiresReview: false,
  };
}
