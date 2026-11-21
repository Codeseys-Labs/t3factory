import {
  FACTORY_DELIVERY_BODY_MAX_CHARS,
  FactoryDeliveryError,
  type FactoryArtifactDeliveryIntent,
  type FactoryArtifactDeliveryPrepareResult,
  type FactoryCommitDeliveryIntent,
  type FactoryCommitDeliveryPrepareResult,
  type FactoryDeliveryIntent,
  type FactoryDeliveryPrepareResult,
  type PullRequestMergeMethod,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { describeFactoryFailure } from "./factoryIssues.logic";

const isFactoryDeliveryError = Schema.is(FactoryDeliveryError);

/** Reasons whose copy differs when the subject is an accepted artifact instead of a commit. */
function artifactDeliveryFailureMessage(
  reason: FactoryDeliveryError["reason"],
  resolve: MessageResolver = m,
): string | null {
  switch (reason) {
    case "head-moved":
    case "acceptance-stale":
    case "artifact-changed":
      return resolve(
        msg("The artifact changed since acceptance. Re-accept it, then prepare again."),
      );
    case "payload-changed":
      return resolve(msg("The comment changed since the preview. Prepare again."));
    case "already-delivering":
      return resolve(msg("A comment is already posted, or being posted, to this issue."));
    case "not-accepted":
      return resolve(msg("Accept the artifact, then prepare again."));
    case "worktree-unavailable":
      return resolve(msg("Restore the task folder, then prepare again."));
    case "artifact-too-large":
      return resolve(
        msg(
          "The deliverable is larger than one comment can hold ({count} characters). It is never truncated or split.",
          { count: FACTORY_DELIVERY_BODY_MAX_CHARS.toLocaleString("en-US") },
        ),
      );
    case "artifact-not-text":
      return resolve(
        msg("The deliverable is not UTF-8 text, so it cannot be posted as a comment."),
      );
    case "destination-not-found":
      return resolve(
        msg("That issue does not exist in this project's repository, or it is a pull request."),
      );
    case "capability-unsupported":
      return resolve(
        msg("This project's issue tracker cannot receive comments from the Factory yet."),
      );
    default:
      return null;
  }
}

export function factoryDeliveryFailureMessage(
  error: unknown,
  displayName: string,
  fallbackMessage?: string,
  kind: FactoryDeliveryIntent["kind"] = "publish-pr",
  resolve: MessageResolver = m,
): string {
  if (isFactoryDeliveryError(error)) {
    if (kind === "publish-artifact") {
      const artifactMessage = artifactDeliveryFailureMessage(error.reason, resolve);
      if (artifactMessage !== null) return artifactMessage;
    }
    // Reasons an artifact delivery has no copy for share the messages below.
    switch (error.reason) {
      case "head-moved":
      case "acceptance-stale":
        return resolve(msg("The head moved since acceptance. Re-accept, then prepare again."));
      case "payload-changed":
        return resolve(
          kind === "merge-pr"
            ? msg("The merge details changed since the preview. Prepare again.")
            : msg("The title or body changed since the preview. Prepare again."),
        );
      case "already-delivering":
        return resolve(
          kind === "merge-pr"
            ? msg("A merge has already been granted for this task.")
            : msg("A pull request is already being published for this task."),
        );
      case "not-published":
        return resolve(msg("Publish the pull request first."));
      case "pull-request-head-moved":
        return resolve(
          msg("The pull request head is not the accepted commit. Re-accept and refresh."),
        );
      case "already-merged":
        return resolve(msg("This pull request is already merged."));
      case "not-mergeable":
        return resolve(
          msg("{displayName} reports the pull request cannot be merged right now.", {
            displayName,
          }),
        );
      case "not-accepted":
        return resolve(msg("Accept the current commit, then prepare again."));
      case "not-reconcilable":
        if (error.replacementDeliveryId !== undefined) return error.message;
        return resolve(msg("This delivery can no longer be reconciled. Refresh its status."));
      case "intent-not-found":
        return resolve(msg("This delivery is no longer available. Refresh its status."));
      case "unknown-thread":
        return resolve(msg("This thread is no longer available."));
      case "not-a-factory-task":
        return resolve(msg("This thread is not a claimed Factory task."));
      case "worktree-unavailable":
        return resolve(msg("Restore the worktree, then prepare again."));
      case "capability-unsupported":
        return resolve(
          kind === "merge-pr"
            ? msg("Merging from {displayName} is not supported yet.", { displayName })
            : msg("Publishing from {displayName} is not supported yet.", { displayName }),
        );
    }
  }
  return describeFactoryFailure(error, fallbackMessage).message;
}

/** The whole delivery section for a host that cannot publish an exact accepted commit. */
export function factoryPublishUnsupportedMessage(
  displayName: string,
  resolve: MessageResolver = m,
): string {
  return resolve(msg("Publishing from {displayName} is not supported yet.", { displayName }));
}

export function isLiveFactoryDelivery(intent: Pick<FactoryDeliveryIntent, "status">): boolean {
  // Confirmed still owns the single delivery slot for this task and kind.
  return intent.status !== "failed";
}

type GrantConditions = {
  readonly acceptanceCurrent: boolean;
  readonly existing: Pick<FactoryDeliveryIntent, "status"> | null;
  readonly hasPermission: boolean;
};

export function factoryDeliveryGrantDisabledReason(
  conditions: GrantConditions,
  resolve: MessageResolver = m,
): string | null {
  if (!conditions.acceptanceCurrent) {
    return resolve(msg("The head moved since acceptance. Re-accept, then prepare again."));
  }
  if (conditions.existing !== null && isLiveFactoryDelivery(conditions.existing)) {
    return resolve(
      conditions.existing.status === "confirmed"
        ? msg("A pull request has already been published for this task.")
        : msg("A pull request is already being published for this task."),
    );
  }
  if (!conditions.hasPermission) {
    return resolve(
      msg("Publishing needs operate and source-control write permissions on this environment."),
    );
  }
  return null;
}

export function canGrantFactoryDelivery(conditions: GrantConditions): boolean {
  return factoryDeliveryGrantDisabledReason(conditions) === null;
}

export function mergeGrantDisabledReason(
  conditions: GrantConditions & {
    readonly displayName: string;
    readonly prepared: Pick<
      FactoryCommitDeliveryPrepareResult,
      "current" | "headSha" | "pullRequest"
    > | null;
    readonly mergeMethod?: PullRequestMergeMethod;
  },
  resolve: MessageResolver = m,
): string | null {
  if (!conditions.acceptanceCurrent || conditions.prepared?.current === false) {
    return resolve(msg("The head moved since acceptance. Re-accept, then prepare again."));
  }
  if (conditions.existing !== null && isLiveFactoryDelivery(conditions.existing)) {
    return resolve(
      conditions.existing.status === "confirmed"
        ? msg("This pull request is already merged.")
        : msg("A merge has already been granted for this task."),
    );
  }
  if (!conditions.hasPermission) {
    return resolve(
      msg("Merging needs operate and source-control write permissions on this environment."),
    );
  }
  const prepared = conditions.prepared;
  const pullRequest = prepared?.pullRequest;
  if (prepared === null || pullRequest == null) {
    return resolve(msg("Prepare the merge before granting it."));
  }
  if (pullRequest.state === "merged") {
    return resolve(msg("This pull request is already merged."));
  }
  if (pullRequest.headSha !== prepared.headSha) {
    return resolve(msg("The pull request head is not the accepted commit. Re-accept and refresh."));
  }
  if (pullRequest.isDraft) {
    return resolve(msg("Mark the pull request ready for review before merging."));
  }
  if (pullRequest.mergeability === "conflicting" || pullRequest.state === "closed") {
    return resolve(
      msg("{displayName} reports the pull request cannot be merged right now.", {
        displayName: conditions.displayName,
      }),
    );
  }
  if (
    conditions.mergeMethod !== undefined &&
    !pullRequest.mergeMethods.includes(conditions.mergeMethod)
  ) {
    return resolve(
      msg("The repository does not allow {method} merges. Choose another method.", {
        method: conditions.mergeMethod,
      }),
    );
  }
  return null;
}

const DELIVERY_STATUS_LABELS = {
  "publish-pr": {
    active: msg("Publishing…"),
    done: msg("Published"),
    failed: msg("Publication failed."),
  },
  "merge-pr": { active: msg("Merging…"), done: msg("Merged"), failed: msg("Merge failed.") },
  "publish-artifact": {
    active: msg("Posting comment…"),
    done: msg("Comment posted"),
    failed: msg("Posting the comment failed."),
  },
} as const satisfies Record<
  FactoryDeliveryIntent["kind"],
  { readonly active: string; readonly done: string; readonly failed: string }
>;

export function describeDeliveryStatus(
  intent: Pick<FactoryDeliveryIntent, "kind" | "status" | "failure">,
  displayName: string,
  resolve: MessageResolver = m,
): string {
  const labels = DELIVERY_STATUS_LABELS[intent.kind];
  switch (intent.status) {
    case "pending":
    case "sending":
      return resolve(labels.active);
    case "confirmed":
      return resolve(labels.done);
    case "unknown":
      if (intent.kind === "publish-artifact" && intent.failure?.trim())
        return resolve(
          msg("{failure} Reconcile to check {displayName}.", {
            failure: intent.failure,
            displayName,
          }),
        );
      return resolve(
        msg("The server lost the response. Reconcile to check {displayName}.", {
          displayName,
        }),
      );
    case "failed":
      return intent.failure ?? resolve(labels.failed);
  }
}

export function isArtifactDeliveryIntent(
  intent: FactoryDeliveryIntent,
): intent is FactoryArtifactDeliveryIntent {
  return intent.kind === "publish-artifact";
}

export function isCommitDeliveryIntent(
  intent: FactoryDeliveryIntent,
): intent is FactoryCommitDeliveryIntent {
  return intent.kind !== "publish-artifact";
}

/** The artifact result is the only member that carries the artifact digest. */
export function artifactDeliveryPrepareResult(
  result: FactoryDeliveryPrepareResult | null,
): FactoryArtifactDeliveryPrepareResult | null {
  return result !== null && "artifactSha256" in result ? result : null;
}

export function commitDeliveryPrepareResult(
  result: FactoryDeliveryPrepareResult | null,
): FactoryCommitDeliveryPrepareResult | null {
  return result !== null && !("artifactSha256" in result) ? result : null;
}

/** A destination issue number as a person types it: `12` or `#12`, never a partial number. */
export function parseFactoryIssueNumber(text: string): number | null {
  const match = /^#?(\d+)$/.exec(text.trim());
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function artifactGrantDisabledReason(
  conditions: GrantConditions & {
    readonly prepared: Pick<FactoryArtifactDeliveryPrepareResult, "current"> | null;
  },
  resolve: MessageResolver = m,
): string | null {
  if (!conditions.acceptanceCurrent || conditions.prepared?.current === false) {
    return resolve(msg("The artifact changed since acceptance. Re-accept it, then prepare again."));
  }
  if (conditions.existing !== null && isLiveFactoryDelivery(conditions.existing)) {
    return resolve(
      conditions.existing.status === "confirmed"
        ? msg("A comment has already been posted to this issue.")
        : msg("A comment is already being posted to this issue."),
    );
  }
  if (!conditions.hasPermission) {
    return resolve(
      msg(
        "Posting a comment needs operate and source-control write permissions on this environment.",
      ),
    );
  }
  if (conditions.prepared === null) return resolve(msg("Prepare the comment before granting it."));
  return null;
}

export interface FactoryArtifactDeliveryFailure {
  readonly message: string;
  readonly unsupported: boolean;
}

/**
 * A failure does not name the host, so the copy says "the issue tracker". A capability refusal is
 * flagged so the panel can show it as a quiet notice instead of an error.
 */
export function factoryArtifactDeliveryFailure(
  error: unknown,
  fallbackMessage?: string,
  resolve: MessageResolver = m,
): FactoryArtifactDeliveryFailure {
  return {
    message: factoryDeliveryFailureMessage(
      error,
      "the issue tracker",
      fallbackMessage,
      "publish-artifact",
      resolve,
    ),
    unsupported: isFactoryDeliveryError(error) && error.reason === "capability-unsupported",
  };
}
