import {
  EnvironmentAuthorizationError,
  FACTORY_READINESS_OVERRIDE_REASON_MAX_CHARS,
  FACTORY_READINESS_TTL_MS,
  FactoryIssueError,
  type CommandId,
  type EnvironmentId,
  type FactoryFrontierChild,
  type FactoryIssue,
  type FactoryIssueFrontierReadResult,
  type FactoryIssueListInput,
  type FactoryIssueTask,
  type FactoryReadiness,
  type FactoryReadinessEdge,
  type FactoryReadinessOverride,
  type FactoryReadinessOverrideId,
  type FactoryReadinessOverrideKind,
  type FactoryReadinessOverrideSetInput,
  type FactoryReadinessReason,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { formatRelativeTimeLabel } from "../../timestampFormat";

export type FactoryIssueStateFilter = NonNullable<FactoryIssueListInput["state"]>;

export const FACTORY_STATE_FILTERS: ReadonlyArray<{
  readonly value: FactoryIssueStateFilter;
  readonly label: string;
}> = [
  { value: "open", label: msg("Open", { $context: "issue state filter" }) },
  { value: "closed", label: msg("Closed", { $context: "issue state filter" }) },
  { value: "all", label: msg("All", { $context: "issue state filter" }) },
];

export function parseFactoryStateFilter(value: unknown): FactoryIssueStateFilter {
  return value === "closed" || value === "all" ? value : "open";
}

/**
 * A git host keys its issues by a decimal number. A server without `factoryIssueKeys` can address
 * nothing else, so any other key is a tracker it cannot reach.
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
 * numbers only.
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

export type FactoryIssueOpenRoute = "panel" | "inline-start" | "external";

/**
 * Where a queue row's review/start goes. The Issues panel is the home of reading and starting; a
 * server that runs the Factory without the upstream issue layer has no panel, so the row opens the
 * Factory section inline instead of leaving the app. A panel that cannot resolve this one issue
 * still falls back to its tracker page.
 */
export function resolveFactoryIssueOpenRoute(options: {
  readonly panelAvailable: boolean;
  readonly panelResolves: boolean;
  readonly startable: boolean;
}): FactoryIssueOpenRoute {
  if (options.panelAvailable && options.panelResolves) return "panel";
  if (!options.panelAvailable && options.startable) return "inline-start";
  return "external";
}

/** The tracker's key for an issue; older servers send only the number. */
export function factoryIssueKeyOf(issue: Pick<FactoryIssue, "number" | "key">): string | null {
  return issue.key ?? (issue.number === null ? null : String(issue.number));
}

/** The label a person reads for an issue: `#12` on a git host, `ENG-12` on Linear. */
export function factoryIssueDisplayKey(
  issue: Pick<FactoryIssue, "number" | "key" | "displayKey">,
): string {
  return issue.displayKey ?? (issue.number === null ? (issue.key ?? "") : `#${issue.number}`);
}

type TaskBadgeVariant = "info" | "success" | "warning" | "error" | "secondary" | "outline";

export interface FactoryTaskPresentation {
  readonly label: string;
  readonly variant: TaskBadgeVariant;
  readonly detail: string;
}

/**
 * Labels mirror the server's own task status; nothing here infers progress it was not told about.
 */
export function factoryTaskPresentation(
  status: FactoryIssueTask["status"],
  resolve: MessageResolver = m,
): FactoryTaskPresentation {
  switch (status) {
    case "launching":
      return {
        label: resolve(msg("Launch pending")),
        variant: "warning",
        detail: resolve(
          msg(
            "A launch was reserved but did not finish. Resume completes the same task with its original settings.",
          ),
        ),
      };
    case "preparing":
      return {
        label: resolve(msg("Preparing")),
        variant: "info",
        detail: resolve(msg("The isolated worktree is being prepared.")),
      };
    case "running":
      return {
        label: resolve(msg("Running")),
        variant: "success",
        detail: resolve(msg("An agent is working on this task.")),
      };
    case "idle":
      return {
        label: resolve(msg("Idle")),
        variant: "secondary",
        detail: resolve(msg("The task thread is waiting for you.")),
      };
    case "failed":
      return {
        label: resolve(msg("Failed")),
        variant: "error",
        detail: resolve(
          msg("Setup or the last run failed. Open the thread to retry or inspect it."),
        ),
      };
    case "archived":
      return {
        label: resolve(msg("Archived")),
        variant: "outline",
        detail: resolve(msg("The task thread is archived. Opening it does not start new work.")),
      };
    case "missing":
      return {
        label: resolve(msg("Thread deleted")),
        variant: "warning",
        detail: resolve(
          msg("The linked thread was deleted. A new attempt needs explicit confirmation."),
        ),
      };
  }
}

export type FactoryIssueAction =
  | { readonly kind: "start" }
  | { readonly kind: "resume" }
  | { readonly kind: "restart" }
  | { readonly kind: "open"; readonly task: FactoryIssueTask }
  | { readonly kind: "unavailable"; readonly reason: string };

/** A closed issue never begins new work, but a task that already exists stays reachable. */
export function resolveFactoryIssueAction(
  issue: FactoryIssue,
  resolve: MessageResolver = m,
): FactoryIssueAction {
  const { task } = issue;
  if (task === null) {
    return issue.state === "open"
      ? { kind: "start" }
      : { kind: "unavailable", reason: resolve(msg("Closed issues cannot start new tasks.")) };
  }
  switch (task.status) {
    case "launching":
      return { kind: "resume" };
    case "missing":
      return issue.state === "open"
        ? { kind: "restart" }
        : {
            kind: "unavailable",
            reason: resolve(msg("Closed issues cannot start a new attempt.")),
          };
    default:
      return { kind: "open", task };
  }
}

export type FactoryFailureKind = "permission" | "unsupported" | "repository" | "changed" | "other";

export interface FactoryFailure {
  readonly kind: FactoryFailureKind;
  readonly title: string;
  readonly message: string;
  readonly reason: FactoryIssueError["reason"] | null;
}

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isFactoryIssueError = Schema.is(FactoryIssueError);

/**
 * `displayName` names the issue host in titles that blame it. A failure raised before any issue
 * read has answered carries none, so those titles stay host-neutral instead of guessing one.
 */
export function describeFactoryFailure(
  error: unknown,
  fallbackMessage?: string,
  displayName?: string,
  resolve: MessageResolver = m,
): FactoryFailure {
  if (isAuthorizationError(error)) {
    return {
      kind: "permission",
      title: resolve(msg("Permission required")),
      message:
        error.message.trim() ||
        resolve(msg("This connection lacks permission for factory issues.")),
      reason: null,
    };
  }
  if (isFactoryIssueError(error)) {
    switch (error.reason) {
      case "issue-changed":
        return {
          kind: "changed",
          title: resolve(msg("Issue changed")),
          message: error.message,
          reason: error.reason,
        };
      case "readiness-changed":
        return {
          kind: "changed",
          title: resolve(msg("Blocker changed")),
          message: error.message,
          reason: error.reason,
        };
      case "override-not-allowed":
        return {
          kind: "other",
          title: resolve(msg("Override not allowed")),
          message: error.message,
          reason: error.reason,
        };
      case "unsupported-provider":
        return {
          kind: "unsupported",
          title: resolve(msg("Repository not supported")),
          message: error.message,
          reason: error.reason,
        };
      case "missing-repository":
      case "missing-project":
      case "repository-changed":
        return {
          kind: "repository",
          title: resolve(msg("Repository unavailable")),
          message: error.message,
          reason: error.reason,
        };
      case "authentication":
        return {
          kind: "other",
          title:
            displayName === undefined
              ? resolve(msg("Sign-in required"))
              : resolve(msg("{displayName} sign-in required", { displayName })),
          message: error.message,
          reason: error.reason,
        };
      case "rate-limited":
        return {
          kind: "other",
          title:
            displayName === undefined
              ? resolve(msg("Rate limit reached"))
              : resolve(msg("{displayName} rate limit reached", { displayName })),
          message: error.message,
          reason: error.reason,
        };
      default:
        return {
          kind: "other",
          title: resolve(msg("Could not complete the request")),
          message: error.message,
          reason: error.reason,
        };
    }
  }
  const message =
    fallbackMessage ??
    (error instanceof Error && error.message.trim().length > 0
      ? error.message
      : resolve(msg("The environment request failed.")));
  return {
    kind: "other",
    title: resolve(msg("Could not complete the request")),
    message,
    reason: null,
  };
}

/** An empty base ref means "current HEAD", which the server resolves; the client never guesses it. */
export function normalizeFactoryBaseRef(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Issue URLs come from a remote service and are untrusted; only http(s) becomes a link. */
export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Visited page numbers, last is current. Previous returns to the page that led here, not page-1. */
export function pushFactoryPage(
  pages: ReadonlyArray<number>,
  nextPage: number,
): ReadonlyArray<number> {
  return [...pages, nextPage];
}

export function popFactoryPage(pages: ReadonlyArray<number>): ReadonlyArray<number> {
  return pages.length <= 1 ? [1] : pages.slice(0, -1);
}

export function currentFactoryPage(pages: ReadonlyArray<number>): number {
  return pages.at(-1) ?? 1;
}

/** Every piece of queue state is keyed by this, so changing scope can never show another scope's rows. */
export function factoryScopeKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  state: FactoryIssueStateFilter,
): string {
  return JSON.stringify([environmentId, projectId, state]);
}

export type FactoryReadinessTone = "success" | "warning" | "info" | "neutral";

export type FactoryReadinessOverrideAction = "dispute" | "waive";

export interface FactoryReadinessEdgeRow {
  /** Identity is the tracker's database id; repository and number are only a locator. */
  readonly key: string;
  readonly targetHost: string;
  readonly targetId: number;
  readonly locator: string;
  readonly url: string | null;
  readonly title: string;
  readonly stateLabel: string;
  readonly closedAt: string | null;
  readonly resolutionLabel: string;
  readonly statusLabel: string;
  /** Opaque digest of the resolution shown here; an override sends it back to bind to this view. */
  readonly fingerprint: string;
  /** What a reviewer may record on this edge now; null when an override already applies or none fits. */
  readonly overrideAction: FactoryReadinessOverrideAction | null;
  readonly overrideId: FactoryReadinessOverrideId | null;
  /** `Disputed: <reason>` or `Waived: <reason>` while an override is in effect on this edge. */
  readonly overrideLabel: string | null;
}

export interface FactoryReadinessInactiveOverrideRow {
  readonly key: string;
  readonly locator: string;
  readonly kindLabel: string;
  readonly statusLabel: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface FactoryReadinessPresentation {
  readonly label: string;
  readonly tone: FactoryReadinessTone;
  readonly stale: boolean;
  readonly edgeRows: ReadonlyArray<FactoryReadinessEdgeRow>;
  /** Lapsed and revoked decisions, kept visible for the record; none of them is applied. */
  readonly inactiveOverrides: ReadonlyArray<FactoryReadinessInactiveOverrideRow>;
  /** Why new overrides cannot be recorded from this observation, or null when they can. */
  readonly overridesLockedReason: string | null;
}

// A switch over the contract's reason union, so a new server reason fails to compile here instead
// of reaching the screen as a raw token.
function readinessReasonLabel(
  reason: FactoryReadinessReason,
  displayName: string,
  resolve: MessageResolver,
): string {
  switch (reason) {
    case "closed-subject":
      return resolve(msg("the issue is closed"));
    case "open-blocker":
      return resolve(msg("a blocker is still open"));
    case "unaccepted-blocker":
      return resolve(msg("a blocker was closed without completion"));
    case "deleted-blocker":
      return resolve(msg("a blocker was deleted"));
    case "inaccessible-blocker":
      return resolve(msg("a blocker is not accessible"));
    case "moved-blocker":
      return resolve(msg("a blocker moved"));
    case "unverified-blocker":
      return resolve(msg("a blocker could not be verified"));
    case "partial-listing":
      return resolve(msg("{displayName} returned only part of the blocker list", { displayName }));
    case "summary-missing":
      return resolve(msg("{displayName} did not report how many blockers exist", { displayName }));
    case "truncated-response":
      return resolve(msg("the blocker list was truncated"));
    case "invalid-response":
      return resolve(
        msg("{displayName} returned a response that could not be read", { displayName }),
      );
    case "authentication":
      return resolve(msg("{displayName} sign-in is required", { displayName }));
    case "rate-limited":
      return resolve(msg("the {displayName} rate limit was reached", { displayName }));
    case "remote-failure":
      return resolve(msg("{displayName} could not be reached", { displayName }));
    case "capability-unsupported":
      return resolve(msg("{displayName} does not expose blocking relationships", { displayName }));
    case "cycle":
      return resolve(msg("the blockers form a cycle"));
    case "overridden-not-ready":
      return resolve(msg("a blocker is disputed"));
  }
}

/** The whole blockers panel for a host whose API cannot express blocking relationships. */
export function factoryBlockersUnsupportedMessage(
  displayName: string,
  resolve: MessageResolver = m,
): string {
  return resolve(
    msg("{displayName} does not expose blocking relationships; readiness stays unknown.", {
      displayName,
    }),
  );
}

function edgeStateLabel(edge: FactoryReadinessEdge, resolve: MessageResolver): string {
  if (edge.state === "open") return resolve(msg("Open", { $context: "blocker state" }));
  if (edge.state === "closed") {
    // Reasons arrive as tracker tokens such as `not_planned`; show them as words.
    return edge.stateReason === null
      ? resolve(msg("Closed", { $context: "blocker state" }))
      : resolve(msg("Closed · {reason}", { reason: edge.stateReason.replaceAll("_", " ") }));
  }
  return resolve(msg("State unknown"));
}

function edgeResolutionLabel(edge: FactoryReadinessEdge, resolve: MessageResolver): string {
  // The tracker removed this dependency; that is its call and the server does not count it.
  if (edge.status === "removed-at-source") return resolve(msg("Not counted, removed at source"));
  switch (edge.resolution) {
    case "accepted":
      return resolve(msg("Accepted", { $context: "blocker resolution" }));
    case "open":
      return resolve(msg("Open, unresolved"));
    case "closed-unaccepted":
      return edge.stateReason === null
        ? resolve(msg("Closed, not accepted (no reason recorded)"))
        : resolve(
            msg("Closed, not accepted ({reason})", {
              reason: edge.stateReason.replaceAll("_", " "),
            }),
          );
    case "deleted":
      return resolve(msg("Deleted, counts as unresolved"));
    case "inaccessible":
      return resolve(msg("Inaccessible, cannot verify"));
    case "moved":
      return resolve(msg("Moved, cannot verify"));
    case "unverified":
      return resolve(msg("Could not be verified"));
  }
}

function edgeStatusLabel(status: FactoryReadinessEdge["status"], resolve: MessageResolver): string {
  switch (status) {
    case "present":
      return resolve(msg("Listed"));
    case "removed-at-source":
      return resolve(msg("No longer listed"));
    case "deleted":
      return resolve(msg("Deleted at source"));
    case "inaccessible":
      return resolve(msg("Inaccessible", { $context: "blocker status" }));
    case "moved":
      return resolve(msg("Moved", { $context: "blocker status" }));
    case "unverified":
      return resolve(msg("Unverified"));
  }
}

// `waive` retires a tombstone nothing in the tracker can fix; an accepted blocker can only be
// disputed, and an open or unaccepted one must be resolved in the tracker.
function edgeOverrideAction(edge: FactoryReadinessEdge): FactoryReadinessOverrideAction | null {
  // Not counted at all, so there is nothing to dispute or waive.
  if (edge.status === "removed-at-source") return null;
  if (edge.override !== null) return null;
  switch (edge.resolution) {
    case "accepted":
      return "dispute";
    case "deleted":
    case "inaccessible":
    case "moved":
    case "unverified":
      return "waive";
    case "open":
    case "closed-unaccepted":
      return null;
  }
}

function overrideLabel(override: FactoryReadinessOverride | null, resolve: MessageResolver) {
  if (override === null) return resolve(msg("Override in effect"));
  return override.kind === "waive"
    ? resolve(msg("Waived: {reason}", { reason: override.reason }))
    : resolve(msg("Disputed: {reason}", { reason: override.reason }));
}

function activeOverridesById(
  readiness: FactoryReadiness,
): ReadonlyMap<FactoryReadinessOverrideId, FactoryReadinessOverride> {
  return new Map(
    readiness.overrides
      .filter((override) => override.status === "active")
      .map((override) => [override.id, override] as const),
  );
}

function edgeRow(
  edge: FactoryReadinessEdge,
  override: FactoryReadinessOverride | null,
  overridable: boolean,
  resolve: MessageResolver,
): FactoryReadinessEdgeRow {
  const title = edge.title?.trim() ?? "";
  return {
    key: `${edge.targetHost}:${edge.targetId}`,
    targetHost: edge.targetHost,
    targetId: edge.targetId,
    locator: `${edge.targetRepository}#${edge.targetNumber}`,
    url: safeExternalUrl(edge.targetUrl),
    title: title.length > 0 ? title : resolve(msg("Title unavailable")),
    stateLabel: edgeStateLabel(edge, resolve),
    closedAt: edge.closedAt,
    resolutionLabel: edgeResolutionLabel(edge, resolve),
    statusLabel: edgeStatusLabel(edge.status, resolve),
    fingerprint: edge.fingerprint,
    overrideAction: overridable ? edgeOverrideAction(edge) : null,
    overrideId: edge.override,
    overrideLabel: edge.override === null ? null : overrideLabel(override, resolve),
  };
}

interface ReadinessVerdict {
  readonly label: string;
  readonly tone: FactoryReadinessTone;
  readonly stale: boolean;
}

/** The active override on an edge, if the readiness result carries it. */
function activeOverrideOf(
  edge: FactoryReadinessEdge,
  active: ReadonlyMap<FactoryReadinessOverrideId, FactoryReadinessOverride>,
): FactoryReadinessOverride | null {
  return edge.override === null ? null : (active.get(edge.override) ?? null);
}

function inactiveOverrideRows(
  readiness: FactoryReadiness,
  resolve: MessageResolver,
): ReadonlyArray<FactoryReadinessInactiveOverrideRow> {
  const locators = new Map(
    readiness.edges.map((edge) => [
      `${edge.targetHost}:${edge.targetId}`,
      `${edge.targetRepository}#${edge.targetNumber}`,
    ]),
  );
  return readiness.overrides
    .filter((override) => override.status !== "active")
    .map((override) => {
      const identity = `${override.targetHost}:${override.targetId}`;
      return {
        key: override.id,
        locator: locators.get(identity) ?? identity,
        kindLabel:
          override.kind === "waive"
            ? resolve(msg("Waiver", { $context: "recorded decision" }))
            : resolve(msg("Dispute", { $context: "recorded decision" })),
        statusLabel:
          override.status === "revoked"
            ? resolve(msg("Revoked", { $context: "recorded decision" }))
            : resolve(msg("No longer applies")),
        reason: override.reason,
        createdAt: override.createdAt,
        revokedAt: override.revokedAt,
      };
    });
}

function readinessVerdict(
  readiness: FactoryReadiness,
  active: ReadonlyMap<FactoryReadinessOverrideId, FactoryReadinessOverride>,
  now: number,
  displayName: string,
  resolve: MessageResolver,
): ReadinessVerdict {
  const stale = !(now - Date.parse(readiness.observedAt) <= FACTORY_READINESS_TTL_MS);
  let label: string;
  let tone: FactoryReadinessTone;
  switch (readiness.status) {
    case "ready": {
      const observed = formatRelativeTimeLabel(readiness.observedAt, now, resolve);
      const waived = readiness.edges.filter(
        (edge) => activeOverrideOf(edge, active)?.kind === "waive",
      ).length;
      // A verdict that leans on a waiver says so, so it cannot read as the tracker's own signal.
      label =
        readiness.basis === "override"
          ? resolve(
              msg(
                "No unresolved blockers observed {observed} · basis: override ({waived} waived)",
                { observed, waived },
              ),
            )
          : resolve(
              msg("No unresolved blockers observed {observed} · basis: source", { observed }),
            );
      tone = stale ? "info" : "success";
      break;
    }
    case "blocked": {
      let unresolved = 0;
      let disputed = 0;
      for (const edge of readiness.edges) {
        // The tracker removed this dependency; the server does not count it.
        if (edge.status === "removed-at-source") continue;
        const override = activeOverrideOf(edge, active);
        if (override?.kind === "waive") continue;
        if (override?.kind === "force-not-ready") {
          unresolved += 1;
          disputed += 1;
        } else if (edge.resolution !== "accepted") {
          unresolved += 1;
        }
      }
      label =
        disputed > 0
          ? resolve(
              msg(
                "Blocked: {unresolved, plural, one {{unresolved} unresolved blocker} other {{unresolved} unresolved blockers}} ({disputed} disputed)",
                { unresolved, disputed },
              ),
            )
          : resolve(
              msg(
                "Blocked: {unresolved, plural, one {{unresolved} unresolved blocker} other {{unresolved} unresolved blockers}}",
                { unresolved },
              ),
            );
      tone = "warning";
      break;
    }
    case "unknown": {
      const reason = readiness.reasons[0];
      label = resolve(
        msg("Readiness unknown: {reason}", {
          reason:
            reason === undefined
              ? resolve(msg("no reason reported"))
              : readinessReasonLabel(reason, displayName, resolve),
        }),
      );
      tone = "info";
      break;
    }
    case "not-applicable":
      label = resolve(msg("Not applicable (closed)"));
      tone = "neutral";
      break;
  }
  return { label: stale ? resolve(msg("{label} · stale", { label })) : label, tone, stale };
}

/** Wording for observed blocker evidence. It never says "Ready": the line reports what was seen and when, and nothing here gates starting work. A stale observation (or one whose time cannot be read) is marked rather than hidden, and no longer reads as a positive signal.  Overrides are the reviewer's own recorded decisions about single edges. Setting one needs current, complete evidence, so a stale or partial observation locks new decisions until it is observed again; revoking never needs fresh evidence. */
export function factoryReadinessPresentation(
  readiness: FactoryReadiness,
  now: number,
  displayName: string,
  resolve: MessageResolver = m,
): FactoryReadinessPresentation {
  const active = activeOverridesById(readiness);
  const verdict = readinessVerdict(readiness, active, now, displayName, resolve);
  const overridable = readiness.status !== "not-applicable";
  return {
    label: verdict.label,
    tone: verdict.tone,
    stale: verdict.stale,
    edgeRows: readiness.edges.map((edge) =>
      edgeRow(edge, activeOverrideOf(edge, active), overridable, resolve),
    ),
    inactiveOverrides: inactiveOverrideRows(readiness, resolve),
    overridesLockedReason: verdict.stale
      ? resolve(msg("This observation is stale. Refresh before changing overrides."))
      : readiness.complete
        ? null
        : resolve(msg("The blocker list is incomplete. Refresh before changing overrides.")),
  };
}

export interface FactoryFrontierRow {
  readonly key: string;
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly state: FactoryFrontierChild["state"];
  readonly assignees: ReadonlyArray<string>;
  readonly assigneesLabel: string;
  /** The child's observed verdict wording, or `Closed` or `Not observed` when it has none. */
  readonly verdictLabel: string;
  readonly tone: FactoryReadinessTone;
}

export interface FactoryFrontierPresentation {
  /** In the tracker's recorded order; nothing here ranks or picks a child. */
  readonly rows: ReadonlyArray<FactoryFrontierRow>;
  readonly note: string | null;
  readonly stale: boolean;
}

/**
 * A planning view of one parent's sub-issues. Assignees are shown for context and are never a
 * readiness input, and an incomplete enumeration is reported rather than presented as the whole.
 */
export function factoryFrontierPresentation(
  result: FactoryIssueFrontierReadResult,
  now: number,
  displayName: string,
  resolve: MessageResolver = m,
): FactoryFrontierPresentation {
  const rows = result.children.map((child): FactoryFrontierRow => {
    const title = child.title.trim();
    let verdictLabel: string;
    let tone: FactoryReadinessTone;
    if (child.state === "closed") {
      verdictLabel = resolve(msg("Closed", { $context: "sub-issue verdict" }));
      tone = "neutral";
    } else if (child.readiness === null) {
      verdictLabel = resolve(msg("Not observed"));
      tone = "info";
    } else {
      const active = activeOverridesById(child.readiness);
      ({ label: verdictLabel, tone } = readinessVerdict(
        child.readiness,
        active,
        now,
        displayName,
        resolve,
      ));
    }
    return {
      key: String(child.number),
      number: child.number,
      title: title.length > 0 ? title : resolve(msg("Title unavailable")),
      url: safeExternalUrl(child.url),
      state: child.state,
      assignees: child.assignees,
      assigneesLabel:
        child.assignees.length === 0 ? resolve(msg("Unassigned")) : child.assignees.join(", "),
      verdictLabel,
      tone,
    };
  });
  let note: string | null = null;
  if (!result.complete) {
    note =
      result.summaryTotal === null
        ? resolve(
            msg(
              "Incomplete: {displayName} did not report how many sub-issues exist, so this list may be missing some.",
              { displayName },
            ),
          )
        : resolve(
            msg(
              "Incomplete: {displayName} reports {total, plural, one {{total} sub-issue} other {{total} sub-issues}}, {listed} listed here. This list may be missing some.",
              { displayName, total: result.summaryTotal, listed: rows.length },
            ),
          );
  }
  return {
    rows,
    note,
    stale: !(now - Date.parse(result.observedAt) <= FACTORY_READINESS_TTL_MS),
  };
}

/**
 * The fields are `msg()` strings: the dialog and buttons that show them resolve them with
 * `useMessages()`, and `description` resolves itself so it never reaches a caller encoded.
 */
export const FACTORY_OVERRIDE_ACTIONS: Record<
  FactoryReadinessOverrideAction,
  {
    readonly kind: FactoryReadinessOverrideKind;
    readonly buttonLabel: string;
    readonly title: string;
    readonly description: (displayName: string, resolve?: MessageResolver) => string;
    readonly confirmLabel: string;
    readonly pendingLabel: string;
  }
> = {
  dispute: {
    kind: "force-not-ready",
    buttonLabel: msg("Dispute", { $context: "button, disputes a blocker" }),
    title: msg("Dispute blocker"),
    description: (displayName, resolve = m) =>
      resolve(
        msg(
          "{displayName} reports this blocker as completed. Recording a dispute keeps the issue reading as blocked until you revoke it or the blocker changes. It is your recorded decision and never allows or prevents starting work.",
          { displayName },
        ),
      ),
    confirmLabel: msg("Record dispute"),
    pendingLabel: msg("Recording…"),
  },
  waive: {
    kind: "waive",
    buttonLabel: msg("Waive", { $context: "button, waives a blocker" }),
    title: msg("Waive blocker"),
    description: (displayName, resolve = m) =>
      resolve(
        msg(
          "This blocker can no longer be resolved or verified on {displayName}. Waiving it stops counting it, so the issue can read as having no unresolved blockers with the basis shown as override. It lapses if the blocker changes, and never allows or prevents starting work.",
          { displayName },
        ),
      ),
    confirmLabel: msg("Record waiver"),
    pendingLabel: msg("Recording…"),
  },
};

export interface FactoryOverrideSubmitReadiness {
  readonly canOperate: boolean;
  readonly pending: boolean;
  readonly changed: boolean;
  readonly reason: string;
}

/** `changed` locks resubmission: the pinned edge is stale and must be reviewed again. */
export function isFactoryOverrideSubmitEnabled(readiness: FactoryOverrideSubmitReadiness): boolean {
  return (
    readiness.canOperate &&
    !readiness.pending &&
    !readiness.changed &&
    readiness.reason.trim().length > 0 &&
    readiness.reason.length <= FACTORY_READINESS_OVERRIDE_REASON_MAX_CHARS
  );
}

export function buildFactoryReadinessOverrideInput(options: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly issueNumber: number;
  readonly row: Pick<FactoryReadinessEdgeRow, "targetHost" | "targetId" | "fingerprint">;
  readonly action: FactoryReadinessOverrideAction;
  readonly reason: string;
}): FactoryReadinessOverrideSetInput {
  return {
    commandId: options.commandId,
    projectId: options.projectId,
    issueNumber: options.issueNumber,
    targetHost: options.row.targetHost,
    targetId: options.row.targetId,
    // The resolution the reviewer saw, never one read again at submit time.
    expectedFingerprint: options.row.fingerprint,
    kind: FACTORY_OVERRIDE_ACTIONS[options.action].kind,
    reason: options.reason.trim(),
  };
}
