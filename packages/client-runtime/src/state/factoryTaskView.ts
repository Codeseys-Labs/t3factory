import type {
  FactoryTaskActivityEntry,
  ModelCapabilities,
  FactoryTaskAssignee,
  FactoryTaskAttentionReason,
  FactoryTaskLane,
  FactoryTaskRef,
  FactoryTaskResult,
  FactoryTaskRun,
  FactoryTaskStatus,
  FactoryTaskSummary,
  RuntimeRequestId,
  ModelSelection,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { describeSelectedEffort } from "../modelTraits.ts";
import { resolveModelShortName } from "../providerClients.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import {
  providerInstanceInitials,
  resolveProviderInstanceDisplayName,
} from "./providerInstanceDisplay.ts";
import type { PendingThreadRequests } from "./threadRequests.ts";

export function factoryTaskKey(ref: FactoryTaskRef): string {
  return JSON.stringify([ref.environmentId, ref.projectId, ref.rootId, ref.taskId]);
}

export type FactoryTaskCatalog = readonly (Pick<
  ServerProvider,
  "instanceId" | "driver" | "displayName"
> & {
  readonly models: readonly {
    readonly slug: string;
    readonly name: string;
    readonly shortName?: string | undefined;
    readonly subProvider?: string | undefined;
    readonly capabilities?: ModelCapabilities | null | undefined;
  }[];
})[];

/** A label that stands for several tasks passes `options: false`: no one task's options speak for it. */
export interface FactoryTaskLabelOptions {
  readonly options?: boolean | undefined;
}

export function presentFactoryTaskAssignee(
  assignee: FactoryTaskAssignee,
  catalog: FactoryTaskCatalog,
  labelOptions?: FactoryTaskLabelOptions,
  resolve: MFunctionType = mFallback,
) {
  const mode = assignee.assignment.mode;
  if (mode === "person")
    return {
      label: resolve(msg("You", { $context: "the task is assigned to the reader" })),
      monogram: "",
      key: assignee.key,
    };
  if (mode === "unassigned")
    return { label: resolve(msg("Unassigned")), monogram: "", key: assignee.key };
  const setup =
    assignee.resolved?.setup ??
    (assignee.assignment.mode === "pinned" ? assignee.assignment.setup : null);
  if (!setup)
    return {
      label: mode === "auto" ? resolve(msg("Auto → Unassigned")) : resolve(msg("Unassigned")),
      monogram: "",
      key: assignee.key,
    };
  const presented = presentModelSelection(setup.modelSelection, catalog, labelOptions);
  return {
    ...presented,
    label:
      mode === "auto"
        ? resolve(msg("Auto → {label}", { label: presented.label }))
        : presented.label,
    key: assignee.key,
  };
}

function presentModelSelection(
  selection: ModelSelection,
  catalog: FactoryTaskCatalog,
  labelOptions?: FactoryTaskLabelOptions,
) {
  const { instanceId, model } = selection;
  const provider = catalog.find((entry) => entry.instanceId === instanceId);
  const providerLabel = provider
    ? resolveProviderInstanceDisplayName(provider)
    : String(instanceId);
  const entry = provider?.models.find((entry) => entry.slug === model);
  let modelLabel = entry ? (resolveModelShortName(entry, provider?.driver) ?? entry.name) : model;
  if (entry?.subProvider && modelLabel.toLowerCase().startsWith(entry.subProvider.toLowerCase())) {
    modelLabel =
      modelLabel.slice(entry.subProvider.length).replace(/^[\s.:/-]+/u, "") || modelLabel;
  }
  const effort =
    entry && labelOptions?.options !== false
      ? describeSelectedEffort(selection, entry.capabilities)
      : null;
  const monograms: Readonly<Record<string, string>> = {
    codex: "Cx",
    claudeAgent: "Cl",
    claudeCode: "Cl",
    claude: "Cl",
    gemini: "Gm",
    kimi: "Km",
  };
  return {
    label: `${providerLabel} · ${modelLabel}${effort ? ` · ${effort}` : ""}`,
    monogram:
      monograms[provider?.driver ?? ""] ??
      monograms[providerLabel.toLowerCase()] ??
      providerInstanceInitials(providerLabel),
  };
}

export function presentFactoryTaskActor(
  actor: FactoryTaskActivityEntry["actor"],
  catalog: FactoryTaskCatalog,
): string {
  const selection = actor.kind === "agent" ? actor.modelSelection : undefined;
  const provider = selection
    ? catalog.find((entry) => entry.instanceId === selection.instanceId)
    : undefined;
  return selection && provider?.models.some((entry) => entry.slug === selection.model)
    ? presentModelSelection(selection, catalog).label
    : actor.label;
}

export interface FactoryTaskLivePill {
  readonly label: string;
  readonly colorClass: string;
  readonly dotClass: string;
  readonly pulse: boolean;
}
export interface FactoryTaskThreadFacts {
  readonly threadId: ThreadId;
  readonly pill: FactoryTaskLivePill | null;
  readonly waiting: boolean;
  readonly requests?: PendingThreadRequests;
}
export interface FactoryTaskNeed {
  readonly ref: FactoryTaskRef;
  readonly displayId: string;
  readonly reason: FactoryTaskAttentionReason;
  readonly detail: string;
  readonly threadId: ThreadId | null;
  readonly requestId: RuntimeRequestId | null;
}
const attentionOrder: readonly FactoryTaskAttentionReason[] = [
  "failed",
  "lost",
  "approve",
  "question",
  "unconfirmed",
  "changed",
  "plan",
  "review",
];
const oneLine = (value: string) => value.replace(/\s+/gu, " ").trim();

export function resolveFactoryTaskLiveState(
  task: FactoryTaskSummary,
  facts: readonly FactoryTaskThreadFacts[],
  resolve: MFunctionType = mFallback,
) {
  const byThread = new Map(facts.map((fact) => [fact.threadId, fact]));
  const attention: FactoryTaskNeed[] = task.attention.map((entry) => ({
    ref: { ...task.ref, taskId: entry.taskId },
    displayId: entry.displayId,
    reason: entry.reason,
    detail: oneLine(
      entry.detail ||
        (entry.taskId === task.ref.taskId ? (task.result?.summary ?? task.run?.note ?? "") : ""),
    ),
    threadId:
      task.liveRuns.find((run) => run.taskId === entry.taskId)?.threadId ??
      (entry.taskId === task.ref.taskId
        ? (task.run?.threadId ?? task.result?.threadId ?? null)
        : null),
    requestId: null,
  }));
  const liveRuns = task.liveRuns.map((run) => {
    const fact = byThread.get(run.threadId);
    if (fact?.waiting && fact.requests) {
      const base = {
        ref: { ...task.ref, taskId: run.taskId },
        displayId: run.displayId,
        threadId: run.threadId,
      };
      for (const approval of fact.requests.approvals)
        attention.push({
          ...base,
          reason: "approve",
          detail: oneLine(approval.detail ?? approval.reason ?? resolve(msg("Approval requested"))),
          requestId: approval.requestId,
        });
      for (const question of fact.requests.userInputs)
        attention.push({
          ...base,
          reason: "question",
          detail: oneLine(question.questions.map((item) => item.question).join(" · ")),
          requestId: question.requestId,
        });
    }
    return { ...run, pill: fact?.pill ?? null };
  });
  // A live request replaces a server hint for the same reason with its answerable identity.
  const enriched = attention.filter(
    (entry) =>
      entry.requestId !== null ||
      !attention.some(
        (candidate) =>
          candidate.requestId !== null &&
          candidate.reason === entry.reason &&
          factoryTaskKey(candidate.ref) === factoryTaskKey(entry.ref),
      ),
  );
  enriched.sort((a, b) => attentionOrder.indexOf(a.reason) - attentionOrder.indexOf(b.reason));
  return { liveRuns, attention: enriched };
}

export function groupFactoryTaskNeeds(
  states: readonly { readonly attention: readonly FactoryTaskNeed[] }[],
) {
  const unique = new Map<string, FactoryTaskNeed>();
  for (const state of states)
    for (const entry of state.attention) {
      const key = JSON.stringify([
        factoryTaskKey(entry.ref),
        entry.reason,
        entry.requestId === null ? null : entry.threadId,
        entry.requestId,
      ]);
      const previous = unique.get(key);
      if (!previous || previous.threadId === null || entry.threadId !== null)
        unique.set(key, entry);
    }
  // Within one reason the newer task comes first, as the design lists them (T-36 above T-33).
  const newerFirst = (a: string, b: string) => {
    const left = a.slice(2).split(".").map(Number);
    const right = b.slice(2).split(".").map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const difference = (right[index] ?? 0) - (left[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  const rows = [...unique.values()].sort(
    (a, b) =>
      attentionOrder.indexOf(a.reason) - attentionOrder.indexOf(b.reason) ||
      newerFirst(a.displayId, b.displayId) ||
      factoryTaskKey(a.ref).localeCompare(factoryTaskKey(b.ref)),
  );
  const blocking = rows.filter((entry) =>
    ["failed", "lost", "approve", "question", "unconfirmed"].includes(entry.reason),
  );
  const review = rows.filter((entry) => ["review", "changed", "plan"].includes(entry.reason));
  return { blocking, review, rows, count: rows.length };
}

export type FactoryTaskDrop =
  | { readonly kind: "move"; readonly lane: FactoryTaskLane }
  | { readonly kind: "start" }
  | { readonly kind: "none" }
  | {
      readonly kind: "refuse";
      readonly reason: "run-active" | "invalid-transition" | "blocked" | "assignee-unresolved";
    };
export function resolveFactoryTaskDrop(
  task: FactoryTaskSummary,
  target: FactoryTaskStatus,
): FactoryTaskDrop {
  if (target === task.status) return { kind: "none" };
  const live =
    task.liveRuns.length > 0 || task.run?.state === "running" || task.run?.state === "stopping";
  const review =
    task.result?.state === "ready" ||
    task.result?.state === "changed" ||
    task.status === "in-review";
  if (target === "in-progress") {
    if (live) return { kind: "refuse", reason: "run-active" };
    if (task.status !== "backlog" && task.status !== "ready")
      return { kind: "refuse", reason: "invalid-transition" };
    if (task.blockedBy.length) return { kind: "refuse", reason: "blocked" };
    if (task.assignee.assignment.mode === "person")
      return { kind: "refuse", reason: "assignee-unresolved" };
    return { kind: "start" };
  }
  if (target === "in-review") return { kind: "refuse", reason: "invalid-transition" };
  if (target === "done" || target === "canceled") {
    if (live) return { kind: "refuse", reason: "run-active" };
    if (target === "done" && review) return { kind: "refuse", reason: "invalid-transition" };
    return { kind: "move", lane: target };
  }
  if (
    task.status === "backlog" ||
    task.status === "ready" ||
    task.status === "canceled" ||
    (task.status === "done" && task.lane === "done" && task.result?.state !== "accepted")
  )
    return { kind: "move", lane: target };
  return { kind: "refuse", reason: "invalid-transition" };
}

export function nestFactoryTasks(tasks: readonly FactoryTaskSummary[]) {
  const present = new Map(tasks.map((task) => [factoryTaskKey(task.ref), task]));
  const children = new Map<string, FactoryTaskSummary[]>();
  const roots: FactoryTaskSummary[] = [];
  for (const task of present.values()) {
    const parentKey = task.parent
      ? factoryTaskKey({ ...task.ref, taskId: task.parent.taskId })
      : null;
    if (parentKey && parentKey !== factoryTaskKey(task.ref) && present.has(parentKey)) {
      const siblings = children.get(parentKey) ?? [];
      siblings.push(task);
      children.set(parentKey, siblings);
    } else roots.push(task);
  }
  const rows: { task: FactoryTaskSummary; depth: number }[] = [];
  const visited = new Set<string>();
  const visit = (task: FactoryTaskSummary, depth: number) => {
    const key = factoryTaskKey(task.ref);
    if (visited.has(key)) return;
    visited.add(key);
    rows.push({ task, depth });
    for (const child of children.get(key) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const task of present.values()) visit(task, 0);
  return rows;
}

export function groupFactoryTasks(
  tasks: readonly FactoryTaskSummary[],
  by: "status" | "assignee" | "project",
) {
  const groups = new Map<string, FactoryTaskSummary[]>();
  for (const task of tasks) {
    const key =
      by === "status"
        ? task.status
        : by === "assignee"
          ? JSON.stringify([task.ref.environmentId, task.assignee.key])
          : JSON.stringify([task.ref.environmentId, task.ref.projectId]);
    const items = groups.get(key) ?? [];
    items.push(task);
    groups.set(key, items);
  }
  const entries = [...groups];
  if (by === "status") {
    const order = ["backlog", "ready", "in-progress", "in-review", "done", "canceled"];
    entries.sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  }
  return entries.map(([key, items]) => ({ key, items, rows: nestFactoryTasks(items) }));
}

export interface FactoryTaskBannerAction {
  readonly kind:
    | "start"
    | "open-task"
    | "approve-plan"
    | "edit-plan"
    | "answer"
    | "approve"
    | "always-allow"
    | "deny"
    | "accept"
    | "request-changes"
    | "retry"
    | "reassign"
    | "save-again"
    | "give-up"
    | "stop"
    | "reopen"
    | "break-down"
    | "check"
    | "publish"
    | "merge";
  readonly label: string;
  readonly taskId?: string;
}

/** A pull request's checks in the words the result line uses. */
export type FactoryTaskChecks = "passing" | "failing" | "pending";
const CHECK_WORDS: Record<FactoryTaskChecks, string> = {
  passing: msg("checks pass"),
  failing: msg("checks fail"),
  pending: msg("checks running"),
};
export const presentFactoryTaskChecks = (
  checks: FactoryTaskChecks,
  resolve: MFunctionType = mFallback,
): string => resolve(CHECK_WORDS[checks]);

/**
 * The result line with its pull request: `PR #112 · +184 −20 · 6 files · checks pass`, or
 * `PR #108 is open · …` once accepted. Checks come from the host and are known only on screens
 * that read the pull request.
 */
function presentFactoryTaskResultLine(
  result: Pick<FactoryTaskResult, "summary" | "state" | "pullRequest">,
  checks: FactoryTaskChecks | null = null,
  resolve: MFunctionType = mFallback,
): string {
  const pullRequest = result.pullRequest ?? null;
  const lead =
    pullRequest === null
      ? null
      : pullRequest.state === "merged"
        ? resolve(msg("PR #{number} merged", { number: String(pullRequest.number) }))
        : result.state === "accepted"
          ? resolve(msg("PR #{number} is open", { number: String(pullRequest.number) }))
          : resolve(msg("PR #{number}", { number: String(pullRequest.number) }));
  return [
    lead,
    result.summary,
    pullRequest?.state === "open" && checks ? resolve(CHECK_WORDS[checks]) : null,
  ]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
}

/** Where an accepted code result stands on its way out: Publish, then Merge, then merged. */
function presentDelivery(result: FactoryTaskResult, resolve: MFunctionType = mFallback) {
  const pullRequest = result.pullRequest ?? null;
  const delivery = result.delivery ?? null;
  const failed =
    delivery?.state === "failed"
      ? delivery.action === "merge"
        ? delivery.detail
          ? resolve(msg("Merge failed: {detail}", { detail: delivery.detail }))
          : resolve(msg("Merge failed"))
        : delivery.detail
          ? resolve(msg("Publish failed: {detail}", { detail: delivery.detail }))
          : resolve(msg("Publish failed"))
      : null;
  if (pullRequest?.state === "merged")
    return {
      title: resolve(msg("Accepted · PR #{number} merged", { number: String(pullRequest.number) })),
      detail: result.summary,
      action: null,
    };
  if (delivery?.state === "sending")
    return {
      title: null,
      detail:
        delivery.action === "merge" && pullRequest
          ? resolve(msg("Merging PR #{number}…", { number: String(pullRequest.number) }))
          : resolve(msg("Opening a pull request…")),
      action: null,
    };
  if (pullRequest)
    return {
      title: null,
      detail: failed,
      action: {
        kind: "merge" as const,
        label: resolve(msg("Merge PR #{number}", { number: String(pullRequest.number) })),
      },
    };
  return {
    title: null,
    detail: failed,
    action: { kind: "publish" as const, label: resolve(msg("Publish")) },
  };
}
/**
 * What a person can do about a task's failed or held work run. A held run refuses Retry and
 * Reassign; only one whose result could not be saved can move, by saving it again.
 */
export function presentFactoryTaskRunRecovery(
  run: Pick<FactoryTaskRun, "state" | "captureFailed"> | null,
  resolve: MFunctionType = mFallback,
): readonly FactoryTaskBannerAction[] {
  if (run?.state !== "held")
    return [
      { kind: "retry", label: resolve(msg("Retry")) },
      { kind: "reassign", label: resolve(msg("Reassign")) },
    ];
  // Giving the result up settles the run as failed, which then offers Retry and Reassign.
  return run.captureFailed
    ? [
        { kind: "save-again", label: resolve(msg("Save again")) },
        { kind: "give-up", label: resolve(msg("Give up result")) },
      ]
    : [];
}

/** The run a task's `failed` need speaks of: a planning run that came later does not stand in. */
export const factoryTaskFailedRun = (task: Pick<FactoryTaskSummary, "run" | "failedRun">) =>
  task.failedRun ?? task.run;

export function presentFactoryTaskBanner(
  input: {
    readonly task: FactoryTaskSummary;
    readonly attention: readonly FactoryTaskNeed[];
    readonly assigneeLabel: string;
    readonly liveLabel?: string | null;
    readonly planCount?: number;
    readonly runDetail?: string;
    /** The published pull request's checks, when the screen reads them. */
    readonly checks?: FactoryTaskChecks | null;
  },
  resolve: MFunctionType = mFallback,
) {
  const { task, assigneeLabel } = input;
  const action = (
    kind: FactoryTaskBannerAction["kind"],
    label: string,
    taskId?: string,
  ): FactoryTaskBannerAction => ({ kind, label, ...(taskId ? { taskId } : {}) });
  const banner = (
    state: string,
    tone: "neutral" | "attention" | "danger" | "working" | "done",
    title: string,
    detail: string,
    primary: FactoryTaskBannerAction | null,
    secondary: FactoryTaskBannerAction | null = null,
    additional: readonly FactoryTaskBannerAction[] = [],
  ) => ({ state, tone, title, detail, primary, secondary, additional });
  if (task.status === "canceled")
    return banner("canceled", "neutral", resolve(msg("Canceled")), "", null);
  const need = [...input.attention].sort(
    (a, b) => attentionOrder.indexOf(a.reason) - attentionOrder.indexOf(b.reason),
  )[0];
  // A sent Publish or Merge whose outcome is unknown waits on a person even after Done.
  if (need?.reason === "unconfirmed" && need.ref.taskId === task.ref.taskId)
    return banner(
      "unconfirmed",
      "attention",
      resolve(msg("Unconfirmed")),
      need.detail,
      action("check", resolve(msg("Check"))),
    );
  if (task.status === "done") {
    const result = task.result;
    if (result?.state !== "accepted")
      return banner("done", "done", resolve(msg("Done")), result?.summary ?? "", null);
    const accepted = resolve(
      msg("Accepted · rev {revision}", {
        revision: String(result.acceptedRevision ?? result.revision),
      }),
    );
    const line = presentFactoryTaskResultLine(result, input.checks ?? null, resolve);
    if (result.kind !== "code") return banner("done", "done", accepted, line, null);
    const delivery = presentDelivery(result, resolve);
    return banner(
      "done",
      "done",
      delivery.title ?? accepted,
      delivery.detail ?? line,
      delivery.action ? action(delivery.action.kind, delivery.action.label) : null,
      result.pullRequest?.state === "open" ? action("check", resolve(msg("Check"))) : null,
    );
  }
  if (need && need.ref.taskId !== task.ref.taskId) {
    const attention =
      need.reason === "question"
        ? task.progress
          ? resolve(
              msg("{done} of {total} done · {displayId} is waiting on an answer", {
                done: String(task.progress.done),
                total: String(task.progress.total),
                displayId: need.displayId,
              }),
            )
          : resolve(msg("{displayId} is waiting on an answer", { displayId: need.displayId }))
        : task.progress
          ? resolve(
              msg("{done} of {total} done · {displayId} needs you", {
                done: String(task.progress.done),
                total: String(task.progress.total),
                displayId: need.displayId,
              }),
            )
          : resolve(msg("{displayId} needs you", { displayId: need.displayId }));
    return banner(
      "subtask-attention",
      "attention",
      attention,
      need.detail,
      action(
        "open-task",
        need.reason === "question"
          ? resolve(msg("Answer"))
          : resolve(msg("Open {displayId}", { displayId: need.displayId })),
        need.ref.taskId,
      ),
    );
  }
  const failedRun = factoryTaskFailedRun(task);
  if (
    need?.reason === "failed" &&
    failedRun?.purpose === "planning" &&
    failedRun.state === "failed"
  )
    return banner(
      "failed",
      "danger",
      resolve(msg("Break down failed")),
      input.runDetail ?? need.detail,
      action("break-down", resolve(msg("Break down"))),
      null,
    );
  if (need?.reason === "failed") {
    const [primary = null, secondary = null] = presentFactoryTaskRunRecovery(failedRun, resolve);
    const outcome = failedRun?.state === "held" ? "" : " failed";
    return banner(
      "failed",
      "danger",
      failedRun?.note
        ? outcome === ""
          ? resolve(
              msg("Run {ordinal}: {note}", {
                ordinal: String(failedRun.ordinal ?? ""),
                note: failedRun.note,
              }),
            )
          : resolve(
              msg("Run {ordinal} failed: {note}", {
                ordinal: String(failedRun.ordinal ?? ""),
                note: failedRun.note,
              }),
            )
        : outcome === ""
          ? resolve(msg("Run {ordinal}", { ordinal: String(failedRun?.ordinal ?? "") }))
          : resolve(msg("Run {ordinal} failed", { ordinal: String(failedRun?.ordinal ?? "") })),
      input.runDetail ?? need.detail,
      primary,
      secondary,
    );
  }
  // Retry is refused while the run is live, so Stop comes first; the Stopped banner offers Retry.
  if (need?.reason === "lost")
    return banner(
      "lost",
      "danger",
      resolve(msg("Run {ordinal} lost its agent", { ordinal: String(task.run?.ordinal ?? "") })),
      need.detail,
      action("stop", resolve(msg("Stop"))),
    );
  if (need?.reason === "approve")
    return banner(
      "approval",
      "attention",
      resolve(msg("{assignee} wants to run", { assignee: assigneeLabel })),
      need.detail,
      action("approve", resolve(msg("Approve once"))),
      action("always-allow", resolve(msg("Always allow for this task"))),
      [action("deny", resolve(msg("Deny")))],
    );
  if (need?.reason === "question")
    return banner(
      "question",
      "attention",
      resolve(msg("{assignee} asks", { assignee: assigneeLabel })),
      need.detail,
      action("answer", resolve(msg("Send answer"))),
    );
  if (need?.reason === "plan")
    return banner(
      "plan",
      "attention",
      input.planCount === undefined
        ? resolve(msg("Plan ready"))
        : resolve(msg("Plan ready: {count} sub-tasks", { count: String(input.planCount) })),
      assigneeLabel,
      action("approve-plan", resolve(msg("Approve plan"))),
      action("edit-plan", resolve(msg("Edit"))),
    );
  if (task.status === "in-review" || need?.reason === "review" || need?.reason === "changed") {
    const pullRequest = task.result?.pullRequest ?? null;
    return banner(
      need?.reason === "changed" ? "changed" : "review",
      "attention",
      pullRequest
        ? resolve(msg("Result ready: PR #{number}", { number: String(pullRequest.number) }))
        : resolve(msg("Result ready")),
      task.result
        ? [
            task.result.summary,
            pullRequest && input.checks ? resolve(CHECK_WORDS[input.checks]) : null,
          ]
            .filter((part) => part !== null && part !== "")
            .join(" · ")
        : (need?.detail ?? ""),
      action("accept", resolve(msg("Accept"))),
      action("request-changes", resolve(msg("Request changes"))),
    );
  }
  if (task.status === "in-progress") {
    const ownLive = task.liveRuns.some((run) => run.taskId === task.ref.taskId);
    const descendant = task.liveRuns.find((run) => run.taskId !== task.ref.taskId);
    return banner(
      "working",
      "working",
      input.liveLabel ??
        (task.run?.state === "stopping"
          ? resolve(msg("Stopping…"))
          : task.run?.state === "stopped"
            ? resolve(msg("Stopped"))
            : resolve(msg("In progress"))),
      input.runDetail ?? assigneeLabel,
      ownLive
        ? task.run?.purpose === "work"
          ? action("stop", resolve(msg("Stop")))
          : null
        : descendant
          ? action(
              "open-task",
              resolve(msg("Open {displayId}", { displayId: descendant.displayId })),
              descendant.taskId,
            )
          : task.run?.state === "stopped"
            ? action("retry", resolve(msg("Retry")))
            : null,
    );
  }
  const blocker = task.blockedBy[0];
  if (blocker)
    return banner(
      "blocked",
      "neutral",
      resolve(msg("Waiting on {displayId}", { displayId: blocker.displayId })),
      resolve(msg("Can start when {displayId} is done.", { displayId: blocker.displayId })),
      action(
        "open-task",
        resolve(msg("Open {displayId}", { displayId: blocker.displayId })),
        blocker.taskId,
      ),
    );
  return banner(
    task.status,
    "neutral",
    task.status === "ready" ? resolve(msg("Ready to start")) : resolve(msg("Not started")),
    assigneeLabel,
    task.assignee.assignment.mode === "person"
      ? null
      : action(
          "start",
          task.assignee.resolved ? resolve(msg("Start")) : resolve(msg("Assign and start")),
        ),
  );
}

export function presentFactoryTaskActivity(
  entry: FactoryTaskActivityEntry,
  catalog: FactoryTaskCatalog = [],
  resolve: MFunctionType = mFallback,
): string {
  const event = entry.event;
  const author = presentFactoryTaskActor(entry.actor, catalog);
  switch (event.type) {
    case "created":
      return event.source.kind === "local"
        ? resolve(msg("Created task"))
        : event.ruleName
          ? resolve(
              msg("Created from {source} by the rule {rule}", {
                source: event.source.label,
                rule: event.ruleName,
              }),
            )
          : resolve(msg("Created from {source}", { source: event.source.label }));
    case "comment":
      return event.body;
    case "status":
      return resolve(msg("Moved to {status}", { status: event.to.replaceAll("-", " ") }));
    case "assigned":
      return resolve(
        msg("Assigned to {assignee}", {
          assignee: presentFactoryTaskAssignee(event.assignee, catalog, undefined, resolve).label,
        }),
      );
    case "edited":
      return resolve(msg("Updated task"));
    case "subtasks-added":
      return resolve(msg("{count} sub-tasks added", { count: String(event.count) }));
    case "plan-proposed":
      return resolve(msg("{author} proposed a plan", { author }));
    case "plan-approved":
      return resolve(
        msg("Plan approved: {count} sub-tasks created", { count: String(event.count) }),
      );
    case "run-started":
      return resolve(msg("Run {ordinal} started", { ordinal: String(event.ordinal) }));
    case "run-ended":
      return event.note
        ? resolve(
            msg("Run {ordinal} {outcome}: {note}", {
              ordinal: String(event.ordinal),
              outcome: event.outcome,
              note: oneLine(event.note),
            }),
          )
        : resolve(
            msg("Run {ordinal} {outcome}", {
              ordinal: String(event.ordinal),
              outcome: event.outcome,
            }),
          );
    case "result-ready":
      return resolve(msg("Result ready: {summary}", { summary: event.summary }));
    case "accepted":
      return resolve(
        msg("{author} accepted rev {revision}", {
          author,
          revision: String(event.revision),
        }),
      );
    case "changes-requested":
      return resolve(msg("Changes requested: {note}", { note: oneLine(event.note) }));
    case "reopened":
      return resolve(msg("Reopened task"));
    case "pull-request":
      return resolve(
        msg("PR #{number} {action}", {
          number: String(event.number),
          action: event.action,
        }),
      );
  }
}
