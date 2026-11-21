import {
  EnvironmentAuthorizationError,
  FACTORY_DELIVERY_TITLE_MAX_CHARS,
  FactoryAcceptanceError,
  FactoryDeliveryError,
  FactoryIssueError,
  FactoryOriginKey,
  type EnvironmentId,
  type FactoryAcceptance,
  type FactoryAcceptanceReadResult,
  type FactoryArtifactDeliveryIntent,
  type FactoryArtifactDeliveryPrepareResult,
  type FactoryCommitDeliveryIntent,
  type FactoryCommitDeliveryPrepareResult,
  type FactoryDeliveryCommitPayload,
  type FactoryDeliveryDestinationIssue,
  type FactoryDeliveryIntent,
  type FactoryDeliveryMergePayload,
  type FactoryDeliveryPrepareResult,
  type FactoryDeliveryPublishPayload,
  type FactoryClaim,
  type FactoryClaimListResult,
  type FactoryIssue,
  type FactoryIssueCapabilities,
  type FactoryIssueListResult,
  type FactoryIssueTask,
  type FactoryRepository,
  type IssueTrackerKind,
  type ProjectId,
  type PullRequestMergeability,
  type PullRequestMergeMethod,
  type RuntimeMode,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export type FactoryIssueFilter = "open" | "closed" | "all";

export const FACTORY_ISSUE_FILTERS: ReadonlyArray<{
  readonly value: FactoryIssueFilter;
  readonly label: string;
}> = [
  { value: "open", label: msg("Open", { $context: "issue state filter" }) },
  { value: "closed", label: msg("Closed", { $context: "issue state filter" }) },
  { value: "all", label: msg("All", { $context: "issue state filter" }) },
];

/** Factory tasks begin supervised; the thread's normal controls can change this later. */
export const FACTORY_DEFAULT_RUNTIME_MODE: RuntimeMode = "approval-required";

export const FACTORY_SUPERVISION_NOTICE = msg(
  "Tasks run in an isolated worktree using the selected runtime. Starting a task does not authorize publishing, merging, or releasing.",
);

export interface FactoryIssuePages {
  readonly repository: FactoryRepository | null;
  /** What the issue host supports; null until the first page lands. */
  readonly capabilities: FactoryIssueCapabilities | null;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly nextPage: number | null;
  readonly fetchedAt: string | null;
}

export const EMPTY_FACTORY_ISSUE_PAGES: FactoryIssuePages = {
  repository: null,
  capabilities: null,
  issues: [],
  nextPage: null,
  fetchedAt: null,
};

/**
 * The first page replaces everything; later pages append. An issue that moved between pages
 * while the user was scrolling keeps its earliest position and takes the newest data.
 */
export function applyFactoryIssuePage(
  current: FactoryIssuePages,
  page: number,
  result: FactoryIssueListResult,
): FactoryIssuePages {
  if (page <= 1 || current.repository?.canonicalKey !== result.repository.canonicalKey) {
    return {
      repository: result.repository,
      capabilities: result.capabilities,
      issues: result.issues,
      nextPage: result.nextPage,
      fetchedAt: result.fetchedAt,
    };
  }
  const identityOf = (issue: FactoryIssue) =>
    issue.number === null ? (issue.key ?? issue.url) : String(issue.number);
  const incoming = new Map(result.issues.map((issue) => [identityOf(issue), issue]));
  const seen = new Set<string>();
  const merged = current.issues.map((issue) => {
    seen.add(identityOf(issue));
    return incoming.get(identityOf(issue)) ?? issue;
  });
  for (const issue of result.issues) {
    if (!seen.has(identityOf(issue))) merged.push(issue);
  }
  return {
    repository: result.repository,
    capabilities: result.capabilities,
    issues: merged,
    nextPage: result.nextPage,
    fetchedAt: result.fetchedAt,
  };
}

export type FactoryIssueAction =
  | { readonly kind: "open"; readonly label: string; readonly task: FactoryIssueTask }
  | { readonly kind: "start"; readonly label: string }
  | { readonly kind: "resume"; readonly label: string }
  | { readonly kind: "restart"; readonly label: string }
  | { readonly kind: "unavailable"; readonly label: string; readonly detail: string };

/**
 * One primary action per issue. A closed issue never starts new work, but a thread that still
 * exists stays openable. A deleted task needs an explicit new attempt, never an implicit one.
 */
export function factoryIssueAction(
  issue: FactoryIssue,
  resolve: MessageResolver = m,
  factoryIssueKeys = false,
): FactoryIssueAction {
  const task = issue.task;
  const closedDetail = resolve(msg("Closed issues can't start new tasks."));
  // Without native-key support the Factory persists integer numbers, so a key it cannot read as
  // one cannot start work.
  const noNumberDetail = resolve(msg("This issue's key is not a number the Factory can record."));
  const untargeted = factoryIssueTargetOf(issue, factoryIssueKeys) === null;
  if (task === null) {
    if (issue.state === "closed")
      return { kind: "unavailable", label: resolve(msg("Closed")), detail: closedDetail };
    return untargeted
      ? { kind: "unavailable", label: resolve(msg("Start task")), detail: noNumberDetail }
      : { kind: "start", label: resolve(msg("Start task")) };
  }
  switch (task.status) {
    case "missing":
      if (issue.state === "closed")
        return {
          kind: "unavailable",
          label: resolve(msg("Thread deleted")),
          detail: resolve(msg("The linked thread was deleted. {detail}", { detail: closedDetail })),
        };
      return untargeted
        ? { kind: "unavailable", label: resolve(msg("Start new attempt")), detail: noNumberDetail }
        : { kind: "restart", label: resolve(msg("Start new attempt")) };
    case "launching":
      // The reservation exists but its thread may not; Start replays the same reserved launch.
      return untargeted
        ? { kind: "unavailable", label: resolve(msg("Resume launch")), detail: noNumberDetail }
        : { kind: "resume", label: resolve(msg("Resume launch")) };
    default:
      return { kind: "open", label: resolve(msg("Open thread")), task };
  }
}

const TASK_STATUS_LABELS: Record<FactoryIssueTask["status"], string> = {
  launching: msg("Launching"),
  preparing: msg("Preparing workspace"),
  running: msg("Running"),
  idle: msg("Idle", { $context: "task status, the agent is idle" }),
  failed: msg("Failed"),
  archived: msg("Archived"),
  missing: msg("Thread deleted"),
};

export function factoryTaskStatusLabel(
  status: FactoryIssueTask["status"],
  resolve: MessageResolver = m,
): string {
  return resolve(TASK_STATUS_LABELS[status]);
}

export function factoryTaskStatusTone(
  status: FactoryIssueTask["status"],
): "active" | "neutral" | "danger" {
  switch (status) {
    case "launching":
    case "preparing":
    case "running":
      return "active";
    case "failed":
    case "missing":
      return "danger";
    default:
      return "neutral";
  }
}

const MAX_BODY_CHARACTERS = 4_000;
// Control characters other than tab and newline, plus bidirectional overrides and isolates that
// can reorder surrounding text.
const UNSAFE_TEXT = /(?![\t\n])[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Row previews are plain text, never markup or link targets. They remove disguising characters
 * and bound rendering cost; approval uses the separate, complete review representation.
 */
export function safeFactoryIssueText(value: string, limit = MAX_BODY_CHARACTERS): string {
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_TEXT, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit).trimEnd()}…` : cleaned;
}

/** The tracker's own display key, or the numbered fallback a reply without one allows. */
export function factoryIssueDisplayKey(
  issue: Pick<FactoryIssue, "number" | "key" | "displayKey">,
): string {
  if (issue.displayKey !== undefined) return issue.displayKey;
  return issue.number === null ? `#${issue.key ?? "?"}` : `#${issue.number}`;
}

export type FactoryFailureKind =
  | "auth"
  | "unsupported"
  | "repository"
  | "changed"
  | "retry"
  | "error";

export interface FactoryFailure {
  readonly kind: FactoryFailureKind;
  readonly title: string;
  readonly detail: string;
}

const isFactoryIssueError = Schema.is(FactoryIssueError);
const isFactoryAcceptanceError = Schema.is(FactoryAcceptanceError);
const isFactoryDeliveryError = Schema.is(FactoryDeliveryError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/**
 * Maps a typed failure to text a person can act on; unknown failures keep their own message.
 * `displayName` names the issue host when it is known; a list that never loaded has none, so the
 * title stays provider-neutral rather than guessing a host.
 */
export function describeFactoryFailure(
  error: unknown,
  fallbackTitle: string,
  displayName?: string,
  resolve: MessageResolver = m,
): FactoryFailure {
  if (isAuthorizationError(error)) {
    return {
      kind: "auth",
      title: resolve(msg("Not permitted")),
      detail: resolve(msg("This connection isn't allowed to do that in this environment.")),
    };
  }
  if (isFactoryIssueError(error)) {
    switch (error.reason) {
      case "unsupported-provider":
        return {
          kind: "unsupported",
          title: resolve(msg("Repository not supported")),
          detail: error.message,
        };
      case "authentication":
        return {
          kind: "auth",
          title: displayName
            ? resolve(msg("{host} sign-in required", { host: displayName }))
            : resolve(msg("Sign-in required")),
          detail: error.message,
        };
      case "rate-limited":
        return {
          kind: "retry",
          title: displayName
            ? resolve(msg("{host} rate limit reached", { host: displayName }))
            : resolve(msg("Rate limit reached")),
          detail: error.message,
        };
      case "missing-project":
      case "missing-repository":
      case "repository-changed":
        return {
          kind: "repository",
          title: resolve(msg("Repository unavailable")),
          detail: error.message,
        };
      case "issue-changed":
        return { kind: "changed", title: resolve(msg("Issue changed")), detail: error.message };
      case "launch-failure":
        return {
          kind: "retry",
          title: resolve(msg("Launch interrupted")),
          detail: error.message,
        };
      case "deleted-task":
        return {
          kind: "retry",
          title: resolve(msg("Confirm a new attempt")),
          detail: error.message,
        };
      default:
        return { kind: "error", title: fallbackTitle, detail: error.message };
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return { kind: "error", title: fallbackTitle, detail: error.message };
  }
  return {
    kind: "error",
    title: fallbackTitle,
    detail: resolve(msg("The request failed. Try again.")),
  };
}

export function shortFactorySha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * What the accepted-commit section can honestly say. An unreadable worktree is never shown as
 * "head moved": the server reports `current: false` then, but nothing is known to have moved.
 */
export type FactoryAcceptanceView =
  | { readonly kind: "none"; readonly liveHeadSha: string | null }
  | { readonly kind: "current"; readonly acceptance: FactoryAcceptance }
  | {
      readonly kind: "moved";
      readonly acceptance: FactoryAcceptance;
      readonly liveHeadSha: string;
    }
  | { readonly kind: "unverifiable"; readonly acceptance: FactoryAcceptance };

export function factoryAcceptanceView(read: FactoryAcceptanceReadResult): FactoryAcceptanceView {
  const { acceptance, liveHeadSha } = read;
  if (acceptance === null) return { kind: "none", liveHeadSha };
  if (read.current) return { kind: "current", acceptance };
  if (liveHeadSha === null) return { kind: "unverifiable", acceptance };
  return { kind: "moved", acceptance, liveHeadSha };
}

export function describeFactoryAcceptanceFailure(
  error: unknown,
  resolve: MessageResolver = m,
): FactoryFailure {
  if (isFactoryAcceptanceError(error)) {
    switch (error.reason) {
      case "head-moved":
        return {
          kind: "changed",
          title: resolve(msg("Head moved")),
          detail: resolve(
            msg("The head moved while you were reviewing. Refresh and review again."),
          ),
        };
      case "already-accepted":
        return {
          kind: "changed",
          title: resolve(msg("Already accepted")),
          detail: resolve(
            msg(
              "A commit is already accepted for this task. Refresh, then use Re-accept at current head to replace it.",
            ),
          ),
        };
      case "worktree-unavailable":
        return {
          kind: "repository",
          title: resolve(msg("Worktree unavailable")),
          detail: error.message,
        };
      default:
        return {
          kind: "error",
          title: resolve(msg("Couldn't accept the commit")),
          detail: error.message,
        };
    }
  }
  return describeFactoryFailure(
    error,
    resolve(msg("Couldn't accept the commit")),
    undefined,
    resolve,
  );
}

export function factoryRepositoryLabel(repository: FactoryRepository): string {
  return repository.host === "github.com"
    ? repository.repository
    : `${repository.host}/${repository.repository}`;
}

export function factoryIssueStartKey(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly expectedRepositoryKey: string;
  readonly issueKey: string;
  readonly expectedIssueRevision: string;
  readonly restartDeleted: boolean;
  readonly previousThreadId: string | null;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.projectId,
    input.expectedRepositoryKey,
    input.issueKey,
    input.expectedIssueRevision,
    input.restartDeleted,
    input.previousThreadId,
  ]);
}

/** The server returns the issue URL, but only an https link is worth handing to the system. */
export function safeFactoryIssueUrl(url: string): string | null {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const FACTORY_DELIVERY_TITLE_LIMIT = FACTORY_DELIVERY_TITLE_MAX_CHARS;

export const FACTORY_DELIVERY_HEAD_MOVED = msg(
  "The head moved since acceptance. Re-accept, then prepare again.",
);
export const FACTORY_DELIVERY_PAYLOAD_CHANGED = msg(
  "The title or body changed since the preview. Prepare again.",
);
export const FACTORY_DELIVERY_ALREADY_DELIVERING = msg(
  "A pull request is already being published for this task.",
);

/** The editable starting point: nothing is published until a human grants this exact preview. */
export function factoryDeliveryDefaultPayload(issue: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
}): FactoryDeliveryPublishPayload {
  const title =
    safeFactoryIssueText(issue.title, FACTORY_DELIVERY_TITLE_LIMIT - 1) || `Issue #${issue.number}`;
  const url = safeFactoryIssueUrl(issue.url);
  return { title, body: url === null ? `Issue #${issue.number}` : `Issue: ${url}`, draft: true };
}

/** The server trims the title when decoding, so a trailing space is not an edit. */
export function sameFactoryDeliveryPayload(
  previewed: FactoryDeliveryPublishPayload,
  draft: FactoryDeliveryPublishPayload,
): boolean {
  return (
    previewed.title === draft.title.trim() &&
    previewed.body === draft.body &&
    previewed.draft === draft.draft
  );
}

// Confirmed is live too: one pull request and one merge per task, and redoing either is out of
// scope.
export function isLiveFactoryDelivery(intent: FactoryDeliveryIntent): boolean {
  return intent.status !== "failed";
}

// Stored publish payloads have no merge method, which is what tells the two shapes apart.
export function isFactoryMergePayload(
  payload: FactoryDeliveryCommitPayload,
): payload is FactoryDeliveryMergePayload {
  return "mergeMethod" in payload;
}

// A prepare answers one of two shapes; only an artifact preview carries the artifact digest.
export function isFactoryArtifactPrepareResult(
  result: FactoryDeliveryPrepareResult,
): result is FactoryArtifactDeliveryPrepareResult {
  return "artifactSha256" in result;
}

export function isFactoryArtifactIntent(
  intent: FactoryDeliveryIntent,
): intent is FactoryArtifactDeliveryIntent {
  return intent.kind === "publish-artifact";
}

// A commit-backed row: the pull request and merge sections never show a comment row.
export function isFactoryCommitIntent(
  intent: FactoryDeliveryIntent,
): intent is FactoryCommitDeliveryIntent {
  return intent.kind !== "publish-artifact";
}

/**
 * Why Grant publish is unavailable, or null when it may be pressed. The grant echoes the last
 * preview, so anything that would make the server refuse it is stated here before the tap.
 */
export function factoryDeliveryGrantBlocker(input: {
  readonly permitted: boolean;
  readonly acceptedHeadSha: string | null;
  readonly acceptanceCurrent: boolean;
  readonly liveIntent: FactoryCommitDeliveryIntent | null;
  readonly prepared: FactoryCommitDeliveryPrepareResult | null;
  readonly draft: FactoryDeliveryPublishPayload;
  readonly resolve?: MessageResolver;
}): string | null {
  const resolve = input.resolve ?? m;
  if (!input.permitted) {
    return resolve(
      msg("This connection isn't permitted to publish pull requests in this environment."),
    );
  }
  if (input.liveIntent !== null) {
    return input.liveIntent.status === "confirmed"
      ? resolve(msg("A pull request was already published for this task."))
      : resolve(FACTORY_DELIVERY_ALREADY_DELIVERING);
  }
  if (!input.acceptanceCurrent) return resolve(msg("Publishing needs a current accepted commit."));
  const { prepared } = input;
  if (prepared === null) return resolve(msg("Prepare a preview before granting."));
  if (!prepared.current || prepared.headSha !== input.acceptedHeadSha) {
    return resolve(FACTORY_DELIVERY_HEAD_MOVED);
  }
  if (prepared.existing !== null && isLiveFactoryDelivery(prepared.existing)) {
    return resolve(FACTORY_DELIVERY_ALREADY_DELIVERING);
  }
  if (
    isFactoryMergePayload(prepared.payload) ||
    !sameFactoryDeliveryPayload(prepared.payload, input.draft)
  ) {
    return resolve(FACTORY_DELIVERY_PAYLOAD_CHANGED);
  }
  return null;
}

export const FACTORY_MERGE_METHODS: ReadonlyArray<{
  readonly value: PullRequestMergeMethod;
  readonly label: string;
  readonly accessibilityLabel: string;
}> = [
  {
    value: "merge",
    label: msg("Merge", { $context: "verb, merge a pull request with a merge commit" }),
    accessibilityLabel: msg("Create a merge commit"),
  },
  {
    value: "squash",
    label: msg("Squash", { $context: "verb, squash and merge a pull request" }),
    accessibilityLabel: msg("Squash and merge"),
  },
  {
    value: "rebase",
    label: msg("Rebase", { $context: "verb, rebase and merge a pull request" }),
    accessibilityLabel: msg("Rebase and merge"),
  },
];

export const FACTORY_DEFAULT_MERGE_METHOD: PullRequestMergeMethod = "squash";

export const FACTORY_MERGE_NOT_PUBLISHED = msg("Publish the pull request first.");
export const FACTORY_MERGE_PR_HEAD_MOVED = msg(
  "The pull request head is not the accepted commit. Re-accept and refresh.",
);
export const FACTORY_MERGE_ALREADY_MERGED = msg("This pull request is already merged.");
export const factoryMergeNotMergeable = (displayName: string, resolve: MessageResolver = m) =>
  resolve(
    msg("{host} reports the pull request cannot be merged right now.", { host: displayName }),
  );
export const FACTORY_MERGE_ALREADY_MERGING = msg("A merge is already in progress for this task.");
export const FACTORY_MERGE_METHOD_CHANGED = msg(
  "The merge method changed since the preview. Prepare again.",
);
export const factoryMergeDraft = (displayName: string, resolve: MessageResolver = m) =>
  resolve(
    msg("The pull request is a draft. Mark it ready for review on {host}, then prepare again.", {
      host: displayName,
    }),
  );

type FactoryMergePullRequest = NonNullable<FactoryCommitDeliveryPrepareResult["pullRequest"]>;

export function factoryMergeabilityLabel(
  mergeability: PullRequestMergeability,
  displayName: string,
  resolve: MessageResolver = m,
): string {
  switch (mergeability) {
    case "mergeable":
      return resolve(msg("No merge conflicts"));
    case "conflicting":
      return resolve(msg("Has merge conflicts"));
    case "unknown":
      return resolve(msg("{host} has not decided mergeability yet", { host: displayName }));
  }
}

/**
 * Compares the pull request's head with the accepted commit. An unreadable head never matches:
 * the server refuses to merge anything it cannot pin to the accepted commit.
 */
export function factoryPullRequestHeadView(
  pullRequest: FactoryMergePullRequest,
  acceptedHeadSha: string | null,
  resolve: MessageResolver = m,
): { readonly matches: boolean; readonly text: string } {
  if (pullRequest.headSha === null) {
    return { matches: false, text: resolve(msg("The pull request head could not be read.")) };
  }
  const head = shortFactorySha(pullRequest.headSha);
  if (acceptedHeadSha === null) {
    return {
      matches: false,
      text: resolve(msg("Head {head}. No accepted commit to compare.", { head })),
    };
  }
  return pullRequest.headSha === acceptedHeadSha
    ? { matches: true, text: resolve(msg("Head {head} matches the accepted commit.", { head })) }
    : {
        matches: false,
        text: resolve(
          msg("Head {head} is not the accepted commit {accepted}.", {
            head,
            accepted: shortFactorySha(acceptedHeadSha),
          }),
        ),
      };
}

/**
 * Why Grant merge is unavailable, or null when it may be pressed. The host's branch protection
 * still decides required checks and reviews; this only states what would make the server or
 * the host refuse this exact grant.
 */
export function factoryMergeGrantBlocker(input: {
  readonly permitted: boolean;
  readonly acceptedHeadSha: string | null;
  readonly acceptanceCurrent: boolean;
  readonly liveIntent: FactoryCommitDeliveryIntent | null;
  readonly prepared: FactoryCommitDeliveryPrepareResult | null;
  readonly mergeMethod: PullRequestMergeMethod;
  readonly displayName: string;
  readonly resolve?: MessageResolver;
}): string | null {
  const resolve = input.resolve ?? m;
  if (!input.permitted) {
    return resolve(
      msg("This connection isn't permitted to merge pull requests in this environment."),
    );
  }
  if (input.liveIntent !== null) {
    return input.liveIntent.status === "confirmed"
      ? resolve(FACTORY_MERGE_ALREADY_MERGED)
      : resolve(FACTORY_MERGE_ALREADY_MERGING);
  }
  if (!input.acceptanceCurrent) return resolve(msg("Merging needs a current accepted commit."));
  const { prepared } = input;
  if (prepared === null) return resolve(msg("Prepare a merge preview before granting."));
  if (!prepared.current || prepared.headSha !== input.acceptedHeadSha) {
    return resolve(FACTORY_DELIVERY_HEAD_MOVED);
  }
  const pullRequest = prepared.pullRequest ?? null;
  if (pullRequest === null) return resolve(FACTORY_MERGE_NOT_PUBLISHED);
  if (pullRequest.state === "merged") return resolve(FACTORY_MERGE_ALREADY_MERGED);
  if (pullRequest.state === "closed") return resolve(msg("This pull request is closed."));
  if (!factoryPullRequestHeadView(pullRequest, input.acceptedHeadSha).matches) {
    return resolve(FACTORY_MERGE_PR_HEAD_MOVED);
  }
  if (pullRequest.isDraft) return factoryMergeDraft(input.displayName, resolve);
  if (pullRequest.mergeability === "conflicting") {
    return factoryMergeNotMergeable(input.displayName, resolve);
  }
  if (prepared.existing !== null && isLiveFactoryDelivery(prepared.existing)) {
    return prepared.existing.status === "confirmed"
      ? resolve(FACTORY_MERGE_ALREADY_MERGED)
      : resolve(FACTORY_MERGE_ALREADY_MERGING);
  }
  if (
    !isFactoryMergePayload(prepared.payload) ||
    prepared.payload.mergeMethod !== input.mergeMethod
  ) {
    return resolve(FACTORY_MERGE_METHOD_CHANGED);
  }
  if (!pullRequest.mergeMethods.includes(input.mergeMethod)) {
    return resolve(
      msg("The repository does not allow {method} merges. Choose another method.", {
        method: input.mergeMethod,
      }),
    );
  }
  return null;
}

export type FactoryDeliveryStatusView =
  | { readonly kind: "in-progress"; readonly text: string }
  | {
      readonly kind: "confirmed";
      readonly text: string;
      readonly link: { readonly label: string; readonly url: string } | null;
    }
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "unknown"; readonly text: string };

/**
 * Publish, merge, and comment rows share a list shape, so each says which act it records. A
 * comment names its host by the repository it was granted for, never by a guessed display name.
 */
export function factoryDeliveryStatusView(
  intent: FactoryDeliveryIntent,
  displayName: string,
  resolve: MessageResolver = m,
): FactoryDeliveryStatusView {
  if (isFactoryArtifactIntent(intent)) return factoryArtifactDeliveryStatusView(intent, resolve);
  const merge = intent.kind === "merge-pr";
  switch (intent.status) {
    case "pending":
    case "sending":
      return {
        kind: "in-progress",
        text: merge ? resolve(msg("Merging…")) : resolve(msg("Publishing…")),
      };
    case "confirmed": {
      if (intent.remote === null) {
        return {
          kind: "confirmed",
          text: merge ? resolve(msg("Merged")) : resolve(msg("Pull request published")),
          link: null,
        };
      }
      const { number } = intent.remote;
      const url = safeFactoryIssueUrl(intent.remote.url);
      return {
        kind: "confirmed",
        text: merge
          ? resolve(msg("Merged pull request #{number}", { number: String(number) }))
          : resolve(msg("Published pull request #{number}", { number: String(number) })),
        link:
          url === null
            ? null
            : {
                label: resolve(msg("Open pull request #{number}", { number: String(number) })),
                url,
              },
      };
    }
    case "failed":
      return {
        kind: "failed",
        text:
          intent.failure ??
          (merge ? resolve(msg("Merging failed.")) : resolve(msg("Publishing failed."))),
      };
    case "unknown":
      return {
        kind: "unknown",
        text: merge
          ? resolve(
              msg("The server lost the merge response. Reconcile to check {host}.", {
                host: displayName,
              }),
            )
          : resolve(
              msg("The server lost the response. Reconcile to check {host}.", {
                host: displayName,
              }),
            ),
      };
  }
}

/** What a host that cannot publish says instead of offering the pull request controls. */
export const factoryPublishUnsupportedText = (displayName: string, resolve: MessageResolver = m) =>
  resolve(msg("Publishing from {host} is not supported yet.", { host: displayName }));

export function describeFactoryDeliveryFailure(
  error: unknown,
  displayName: string,
  resolve: MessageResolver = m,
): FactoryFailure {
  if (isFactoryDeliveryError(error)) {
    switch (error.reason) {
      case "head-moved":
      case "acceptance-stale":
        return {
          kind: "changed",
          title: resolve(msg("Head moved")),
          detail: resolve(FACTORY_DELIVERY_HEAD_MOVED),
        };
      case "payload-changed":
        return {
          kind: "changed",
          title: resolve(msg("Preview changed")),
          detail: resolve(FACTORY_DELIVERY_PAYLOAD_CHANGED),
        };
      case "already-delivering":
        return {
          kind: "changed",
          title: resolve(msg("Already publishing")),
          detail: resolve(FACTORY_DELIVERY_ALREADY_DELIVERING),
        };
      case "not-accepted":
        return {
          kind: "changed",
          title: resolve(msg("No accepted commit")),
          detail: resolve(msg("Accept a commit before publishing a pull request.")),
        };
      case "worktree-unavailable":
        return {
          kind: "repository",
          title: resolve(msg("Worktree unavailable")),
          detail: error.message,
        };
      case "capability-unsupported":
        return {
          kind: "unsupported",
          title: resolve(msg("Not supported")),
          detail: factoryPublishUnsupportedText(displayName, resolve),
        };
      default:
        return { kind: "error", title: resolve(msg("Couldn't publish")), detail: error.message };
    }
  }
  return describeFactoryFailure(error, resolve(msg("Couldn't publish")), displayName, resolve);
}

export function describeFactoryMergeFailure(
  error: unknown,
  displayName: string,
  resolve: MessageResolver = m,
): FactoryFailure {
  if (isFactoryDeliveryError(error)) {
    switch (error.reason) {
      case "not-published":
        return {
          kind: "changed",
          title: resolve(msg("Not published")),
          detail: resolve(FACTORY_MERGE_NOT_PUBLISHED),
        };
      case "pull-request-head-moved":
        return {
          kind: "changed",
          title: resolve(msg("Pull request head moved")),
          detail: resolve(FACTORY_MERGE_PR_HEAD_MOVED),
        };
      case "already-merged":
        return {
          kind: "changed",
          title: resolve(msg("Already merged")),
          detail: resolve(FACTORY_MERGE_ALREADY_MERGED),
        };
      case "not-mergeable":
        return {
          kind: "retry",
          title: resolve(msg("Not mergeable")),
          detail: factoryMergeNotMergeable(displayName, resolve),
        };
      case "head-moved":
      case "acceptance-stale":
        return {
          kind: "changed",
          title: resolve(msg("Head moved")),
          detail: resolve(FACTORY_DELIVERY_HEAD_MOVED),
        };
      case "payload-changed":
        return {
          kind: "changed",
          title: resolve(msg("Preview changed")),
          detail: resolve(FACTORY_MERGE_METHOD_CHANGED),
        };
      case "already-delivering":
        return {
          kind: "changed",
          title: resolve(msg("Already merging")),
          detail: resolve(FACTORY_MERGE_ALREADY_MERGING),
        };
      case "not-accepted":
        return {
          kind: "changed",
          title: resolve(msg("No accepted commit")),
          detail: resolve(msg("Accept a commit before merging a pull request.")),
        };
      case "capability-unsupported":
        return {
          kind: "unsupported",
          title: resolve(msg("Not supported")),
          detail: factoryPublishUnsupportedText(displayName, resolve),
        };
      default:
        return { kind: "error", title: resolve(msg("Couldn't merge")), detail: error.message };
    }
  }
  return describeFactoryFailure(error, resolve(msg("Couldn't merge")), displayName, resolve);
}

export const FACTORY_ARTIFACT_ALREADY_DELIVERING = msg(
  "A comment with this deliverable is already being posted, or was posted, on that issue.",
);
export const FACTORY_ARTIFACT_CHANGED = msg(
  "The deliverable changed since it was accepted. Re-accept it, then prepare again.",
);
export const FACTORY_ARTIFACT_PAYLOAD_CHANGED = msg(
  "The issue number changed since the preview. Prepare again.",
);
export const FACTORY_ARTIFACT_NOT_ACCEPTED = msg(
  "Accept the current artifact before posting it as an issue comment.",
);

/** A host that cannot comment on issues gets this one line instead of a preview. */
export const factoryIssueCommentUnsupportedText = (
  displayName: string | null,
  resolve: MessageResolver = m,
) =>
  displayName === null
    ? resolve(msg("This repository's host does not support issue comments yet."))
    : resolve(msg("{host} does not support issue comments yet.", { host: displayName }));

/** The issue number a person typed, or null while it is not a positive whole number. */
export function parseFactoryIssueNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[1-9][0-9]{0,8}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * A git host keys its issues by a decimal number. A server without `factoryIssueKeys` can address
 * nothing else, so any other key is a tracker it cannot reach. Mirrors the web's
 * `factoryIssueNumberFromKey`.
 */
export function factoryIssueNumberFromKey(key: string): number | null {
  if (!/^[1-9]\d*$/u.test(key)) return null;
  const value = Number(key);
  return Number.isSafeInteger(value) ? value : null;
}

/** How a Factory request names one issue: its native key, or the legacy number older servers read. */
export type FactoryIssueTarget = { readonly key: string } | { readonly issueNumber: number };

/**
 * The address a Factory section may act on, or null when the server or the issue cannot take part.
 * A server that advertises `factoryIssueKeys` takes any key; one that does not takes decimal
 * numbers only. Mirrors the web's `resolveFactoryIssueSection`.
 */
export function resolveFactoryIssueSection(options: {
  readonly factoryIssues: boolean;
  readonly factoryIssueKeys: boolean;
  readonly key: string;
}): FactoryIssueTarget | null {
  if (!options.factoryIssues) return null;
  if (options.factoryIssueKeys) return options.key.length > 0 ? { key: options.key } : null;
  const issueNumber = factoryIssueNumberFromKey(options.key);
  return issueNumber === null ? null : { issueNumber };
}

export function factoryIssueKeyOf(issue: Pick<FactoryIssue, "number" | "key">): string | null {
  return issue.key ?? (issue.number === null ? null : String(issue.number));
}

/** The address of an issue already read, in the form the server in use accepts. */
export function factoryIssueTargetOf(
  issue: Pick<FactoryIssue, "number" | "key">,
  factoryIssueKeys: boolean,
): FactoryIssueTarget | null {
  if (factoryIssueKeys) {
    const key = factoryIssueKeyOf(issue);
    return key === null ? null : { key };
  }
  return issue.number === null ? null : { issueNumber: issue.number };
}

/** Reconcile reads the host for an `unknown` or `failed` comment; it never posts again. */
export function isFactoryArtifactReconcilable(intent: FactoryArtifactDeliveryIntent): boolean {
  return intent.status === "unknown" || intent.status === "failed";
}

/** One live comment per destination: a comment on another issue never blocks this one. */
export function liveFactoryArtifactIntent(
  intents: ReadonlyArray<FactoryArtifactDeliveryIntent>,
  issueNumber: number | null,
): FactoryArtifactDeliveryIntent | null {
  if (issueNumber === null) return null;
  return (
    intents.find(
      (intent) => intent.payload.issueNumber === issueNumber && isLiveFactoryDelivery(intent),
    ) ?? null
  );
}

export function factoryArtifactDeliveryStatusView(
  intent: FactoryArtifactDeliveryIntent,
  resolve: MessageResolver = m,
): FactoryDeliveryStatusView {
  const issue = String(intent.payload.issueNumber);
  switch (intent.status) {
    case "pending":
    case "sending":
      return {
        kind: "in-progress",
        text: resolve(msg("Posting comment on issue #{issue}…", { issue })),
      };
    case "confirmed": {
      const url = intent.remote === null ? null : safeFactoryIssueUrl(intent.remote.url);
      return {
        kind: "confirmed",
        text: resolve(msg("Posted comment on issue #{issue}", { issue })),
        link: url === null ? null : { label: resolve(msg("Open comment")), url },
      };
    }
    case "failed":
      return {
        kind: "failed",
        text: intent.failure ?? resolve(msg("Posting the comment failed.")),
      };
    case "unknown":
      return {
        kind: "unknown",
        text: resolve(
          msg("{failure} Reconcile to check {host}.", {
            failure: intent.failure?.trim() || resolve(msg("The server lost the response.")),
            host: intent.repository.host,
          }),
        ),
      };
  }
}

/** The destination as the host reports it now, so a person sees where the comment lands. */
export function factoryArtifactDestinationText(
  destination: FactoryDeliveryDestinationIssue,
  resolve: MessageResolver = m,
) {
  const title = safeFactoryIssueText(destination.title, 240) || resolve(msg("Untitled issue"));
  return resolve(
    msg("#{number} {title} ({state})", {
      number: String(destination.number),
      title,
      state: destination.state,
    }),
  );
}

/**
 * Why Grant publish is unavailable for an artifact, or null when it may be pressed. The grant
 * echoes the last preview's artifact digest and payload digest, so anything that would make the
 * server refuse it is stated here before the tap. `liveIntent` is the live comment for the
 * typed issue only: a comment on another issue never blocks this one.
 */
export function factoryArtifactGrantBlocker(input: {
  readonly permitted: boolean;
  readonly acceptedSha256: string | null;
  readonly issueNumber: number | null;
  readonly liveIntent: FactoryArtifactDeliveryIntent | null;
  readonly prepared: FactoryArtifactDeliveryPrepareResult | null;
  readonly resolve?: MessageResolver;
}): string | null {
  const resolve = input.resolve ?? m;
  if (!input.permitted) {
    return resolve(
      msg("This connection isn't permitted to publish issue comments in this environment."),
    );
  }
  if (input.liveIntent !== null) {
    return input.liveIntent.status === "confirmed"
      ? resolve(msg("This deliverable was already posted on that issue."))
      : resolve(FACTORY_ARTIFACT_ALREADY_DELIVERING);
  }
  const { prepared } = input;
  if (prepared === null) return resolve(msg("Prepare a preview before granting."));
  if (!prepared.current || prepared.artifactSha256 !== input.acceptedSha256) {
    return resolve(FACTORY_ARTIFACT_CHANGED);
  }
  if (prepared.existing !== null && isLiveFactoryDelivery(prepared.existing)) {
    return resolve(FACTORY_ARTIFACT_ALREADY_DELIVERING);
  }
  if (input.issueNumber === null || prepared.payload.issueNumber !== input.issueNumber) {
    return resolve(FACTORY_ARTIFACT_PAYLOAD_CHANGED);
  }
  return null;
}

/**
 * Maps a refused comment preview, grant, or reconcile to the next step. `displayName` is null
 * when no issue read has named the host, so the unsupported line stays host-neutral.
 */
export function describeFactoryArtifactDeliveryFailure(
  error: unknown,
  displayName: string | null,
  resolve: MessageResolver = m,
): FactoryFailure {
  if (isFactoryDeliveryError(error)) {
    switch (error.reason) {
      case "artifact-changed":
      case "acceptance-stale":
        return {
          kind: "changed",
          title: resolve(msg("Deliverable changed")),
          detail: resolve(FACTORY_ARTIFACT_CHANGED),
        };
      case "payload-changed":
        return {
          kind: "changed",
          title: resolve(msg("Preview changed")),
          detail: resolve(FACTORY_ARTIFACT_PAYLOAD_CHANGED),
        };
      case "already-delivering":
        return {
          kind: "changed",
          title: resolve(msg("Already posting")),
          detail: resolve(FACTORY_ARTIFACT_ALREADY_DELIVERING),
        };
      case "not-accepted":
        return {
          kind: "changed",
          title: resolve(msg("No accepted artifact")),
          detail: resolve(FACTORY_ARTIFACT_NOT_ACCEPTED),
        };
      case "artifact-too-large":
      case "artifact-not-text":
        return {
          kind: "error",
          title: resolve(msg("Can't post this deliverable")),
          detail: error.message,
        };
      case "destination-not-found":
        return {
          kind: "repository",
          title: resolve(msg("Issue not found")),
          detail: resolve(
            msg(
              "That number is not an issue in this project's repository. Check the number, then prepare again.",
            ),
          ),
        };
      case "capability-unsupported":
        return {
          kind: "unsupported",
          title: resolve(msg("Not supported")),
          detail: factoryIssueCommentUnsupportedText(displayName, resolve),
        };
      default:
        return {
          kind: "error",
          title: resolve(msg("Couldn't post the comment")),
          detail: error.message,
        };
    }
  }
  return describeFactoryFailure(
    error,
    resolve(msg("Couldn't post the comment")),
    displayName ?? undefined,
    resolve,
  );
}

/**
 * Origin keys are compared across environments, so this is the server's encoding byte for byte
 * (`apps/server/src/factory/FactoryOriginKey.ts` owns the definition). Each component escapes
 * `%`, `|`, `#` and `:` so a locator or item key can never forge a neighbouring field; slashes and
 * every other character pass through untouched. Mirrors the web's claims logic.
 */
function escapeOriginComponent(value: string): string {
  return value.replace(
    /[%|#:]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** The tracker kind is the namespace, so `github:` keys match rows written before other forges. */
export function originKeyForIssue(
  tracker: SourceControlProviderKind | IssueTrackerKind,
  scopeKey: string,
  key: string | number,
): FactoryOriginKey {
  return FactoryOriginKey.make(
    `${tracker}:${escapeOriginComponent(scopeKey)}#${escapeOriginComponent(String(key))}`,
  );
}

/** The origin key of one issue, through its tracker's own scope when the launch recorded one. */
export function originKeyForFactoryIssue(
  repository: Pick<FactoryRepository, "provider" | "canonicalKey" | "issueScope">,
  issue: Pick<FactoryIssue, "number" | "key">,
): FactoryOriginKey {
  return originKeyForIssue(
    repository.issueScope?.tracker ?? repository.provider,
    repository.issueScope?.canonicalKey ?? repository.canonicalKey,
    issue.key ?? String(issue.number),
  );
}

export interface FactoryClaimElsewhere {
  readonly environmentId: EnvironmentId;
  readonly claim: FactoryClaim;
}

/** Claims for the origin held by any environment other than the one that would start the work. */
export function claimsElsewhere(
  claimsByEnvironment: ReadonlyMap<EnvironmentId, FactoryClaimListResult>,
  originKey: FactoryOriginKey,
  environmentId: EnvironmentId,
): ReadonlyArray<FactoryClaimElsewhere> {
  const elsewhere: FactoryClaimElsewhere[] = [];
  for (const [holder, result] of claimsByEnvironment) {
    if (holder === environmentId) continue;
    for (const claim of result.claims) {
      if (claim.originKey === originKey) elsewhere.push({ environmentId: holder, claim });
    }
  }
  return elsewhere;
}

type EnvironmentLabel = (environmentId: EnvironmentId) => string;

/**
 * The Start review warns but never blocks: a claim elsewhere may be a stale copy, and the server
 * still guards this environment's own claim.
 */
export function describeClaimsElsewhere(
  elsewhere: ReadonlyArray<FactoryClaimElsewhere>,
  labelOf: EnvironmentLabel,
  resolve: MessageResolver = m,
): string | null {
  if (elsewhere.length === 0) return null;
  const holders = elsewhere.map(
    ({ environmentId, claim }) => `${labelOf(environmentId)} (${claim.status})`,
  );
  return resolve(
    msg(
      "Already claimed in {holders}. Starting here begins a separate attempt in this environment; nothing merges.",
      { holders: holders.join(", ") },
    ),
  );
}

export interface FactoryClaimEnvironmentFacts {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly claimsSupported: boolean;
  readonly canRead: boolean;
}

export interface FactoryClaimProjectFacts {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly repositoryKey: string | null;
}

export interface FactoryClaimTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export type FactoryClaimsUnavailableReason = "offline" | "unsupported" | "no-access" | "failed";

export interface FactoryClaimsUnavailable {
  readonly environmentId: EnvironmentId;
  readonly reason: FactoryClaimsUnavailableReason;
}

/**
 * One request per environment that holds a checkout of the same repository. The claim list is
 * repository-wide inside an environment, so a second checkout there adds nothing. The selected
 * environment is always asked first; every other environment that has a matching checkout but
 * cannot answer is reported as unreadable instead of being treated as having no claims.
 */
export function planClaimTargets(input: {
  readonly current: FactoryClaimTarget & { readonly repositoryKey: string | null };
  readonly environments: ReadonlyArray<FactoryClaimEnvironmentFacts>;
  readonly projects: ReadonlyArray<FactoryClaimProjectFacts>;
}): {
  readonly targets: ReadonlyArray<FactoryClaimTarget>;
  readonly unavailable: ReadonlyArray<FactoryClaimsUnavailable>;
} {
  const targets: FactoryClaimTarget[] = [
    { environmentId: input.current.environmentId, projectId: input.current.projectId },
  ];
  const unavailable: FactoryClaimsUnavailable[] = [];
  const repositoryKey = input.current.repositoryKey?.toLowerCase() ?? null;
  if (repositoryKey === null) return { targets, unavailable };
  for (const environment of input.environments) {
    if (environment.environmentId === input.current.environmentId) continue;
    const project = input.projects.find(
      (candidate) =>
        candidate.environmentId === environment.environmentId &&
        candidate.repositoryKey?.toLowerCase() === repositoryKey,
    );
    if (project === undefined) continue;
    if (!environment.connected) {
      unavailable.push({ environmentId: environment.environmentId, reason: "offline" });
    } else if (!environment.claimsSupported) {
      unavailable.push({ environmentId: environment.environmentId, reason: "unsupported" });
    } else if (!environment.canRead) {
      unavailable.push({ environmentId: environment.environmentId, reason: "no-access" });
    } else {
      targets.push({ environmentId: environment.environmentId, projectId: project.id });
    }
  }
  return { targets, unavailable };
}

const CLAIMS_UNAVAILABLE_LABELS: Record<FactoryClaimsUnavailableReason, string> = {
  offline: msg("offline"),
  unsupported: msg("server needs an update"),
  "no-access": msg("no read access"),
  failed: msg("request failed"),
};

/**
 * Environments that may hold claims but did not answer. This is never worded as "no claims": an
 * origin can be claimed in an environment this client could not read.
 */
export function describeUnavailableClaims(
  unavailable: ReadonlyArray<FactoryClaimsUnavailable>,
  labelOf: EnvironmentLabel,
  resolve: MessageResolver = m,
): string | null {
  if (unavailable.length === 0) return null;
  const list = unavailable
    .map(
      ({ environmentId, reason }) =>
        `${labelOf(environmentId)} (${resolve(CLAIMS_UNAVAILABLE_LABELS[reason])})`,
    )
    .join(", ");
  return resolve(
    msg("Claims could not be read from {list}. An origin may be claimed there too.", { list }),
  );
}
