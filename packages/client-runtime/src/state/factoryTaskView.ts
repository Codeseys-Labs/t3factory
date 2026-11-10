import type {
  FactoryTaskActivityEntry,
  FactoryTaskAssignee,
  FactoryTaskAttentionReason,
  FactoryTaskLane,
  FactoryTaskRef,
  FactoryTaskStatus,
  FactoryTaskSummary,
  RuntimeRequestId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { resolveModelShortName } from "../providerClients.ts";
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
    readonly shortName?: string;
    readonly subProvider?: string;
  }[];
})[];

export function presentFactoryTaskAssignee(
  assignee: FactoryTaskAssignee,
  catalog: FactoryTaskCatalog,
) {
  const mode = assignee.assignment.mode;
  if (mode === "person") return { label: "You", monogram: "BB", key: assignee.key };
  if (mode === "unassigned") return { label: "Unassigned", monogram: "", key: assignee.key };
  const setup =
    assignee.resolved?.setup ??
    (assignee.assignment.mode === "pinned" ? assignee.assignment.setup : null);
  if (!setup)
    return {
      label: mode === "auto" ? "Auto → Unassigned" : "Unassigned",
      monogram: "",
      key: assignee.key,
    };
  const { instanceId, model } = setup.modelSelection;
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
  const monograms: Readonly<Record<string, string>> = {
    codex: "Cx",
    claudeAgent: "Cl",
    claudeCode: "Cl",
    claude: "Cl",
    gemini: "Gm",
    kimi: "Km",
  };
  return {
    label: `${mode === "auto" ? "Auto → " : ""}${providerLabel} · ${modelLabel}`,
    monogram:
      monograms[provider?.driver ?? ""] ??
      monograms[providerLabel.toLowerCase()] ??
      providerInstanceInitials(providerLabel),
    key: assignee.key,
  };
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
          detail: oneLine(approval.detail ?? approval.reason ?? "Approval requested"),
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
  const rows = [...unique.values()].sort(
    (a, b) =>
      attentionOrder.indexOf(a.reason) - attentionOrder.indexOf(b.reason) ||
      factoryTaskKey(a.ref).localeCompare(factoryTaskKey(b.ref)),
  );
  const blocking = rows.filter((entry) =>
    ["failed", "approve", "question", "unconfirmed"].includes(entry.reason),
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
    | "stop"
    | "reopen"
    | "check";
  readonly label: string;
  readonly taskId?: string;
}
export function presentFactoryTaskBanner(input: {
  readonly task: FactoryTaskSummary;
  readonly attention: readonly FactoryTaskNeed[];
  readonly assigneeLabel: string;
  readonly liveLabel?: string | null;
  readonly planCount?: number;
  readonly resultTitle?: string;
  readonly runDetail?: string;
}) {
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
  if (task.status === "canceled") return banner("canceled", "neutral", "Canceled", "", null);
  if (task.status === "done")
    return banner(
      "done",
      "done",
      task.result?.state === "accepted"
        ? `Accepted · rev ${task.result.acceptedRevision ?? task.result.revision}`
        : "Done",
      task.result?.summary ?? "",
      null,
    );
  const need = [...input.attention].sort(
    (a, b) => attentionOrder.indexOf(a.reason) - attentionOrder.indexOf(b.reason),
  )[0];
  if (need && need.ref.taskId !== task.ref.taskId)
    return banner(
      "subtask-attention",
      "attention",
      `${task.progress ? `${task.progress.done} of ${task.progress.total} done · ` : ""}${need.displayId} ${need.reason === "question" ? "is waiting on an answer" : "needs you"}`,
      need.detail,
      action(
        "open-task",
        need.reason === "question" ? "Answer" : `Open ${need.displayId}`,
        need.ref.taskId,
      ),
    );
  if (need?.reason === "failed")
    return banner(
      "failed",
      "danger",
      `Run ${task.run?.ordinal ?? ""} failed${task.run?.note ? `: ${task.run.note}` : ""}`,
      input.runDetail ?? need.detail,
      action("retry", "Retry"),
      action("reassign", "Reassign"),
    );
  if (need?.reason === "approve")
    return banner(
      "approval",
      "attention",
      `${assigneeLabel} wants to run`,
      need.detail,
      action("approve", "Approve once"),
      action("always-allow", "Always allow for this task"),
      [action("deny", "Deny")],
    );
  if (need?.reason === "question")
    return banner(
      "question",
      "attention",
      `${assigneeLabel} asks`,
      need.detail,
      action("answer", "Send answer"),
    );
  if (need?.reason === "unconfirmed")
    return banner("unconfirmed", "attention", "Unconfirmed", need.detail, action("check", "Check"));
  if (need?.reason === "plan")
    return banner(
      "plan",
      "attention",
      input.planCount === undefined ? "Plan ready" : `Plan ready: ${input.planCount} sub-tasks`,
      assigneeLabel,
      action("approve-plan", "Approve plan"),
      action("edit-plan", "Edit"),
    );
  if (task.status === "in-review" || need?.reason === "review" || need?.reason === "changed")
    return banner(
      need?.reason === "changed" ? "changed" : "review",
      "attention",
      input.resultTitle ? `Result ready: ${input.resultTitle}` : "Result ready",
      task.result?.summary ?? need?.detail ?? "",
      action("accept", "Accept"),
      action("request-changes", "Request changes"),
    );
  if (task.status === "in-progress")
    return banner(
      "working",
      "working",
      input.liveLabel ??
        (task.run?.state === "stopping"
          ? "Stopping…"
          : task.run?.state === "stopped"
            ? "Stopped"
            : "In progress"),
      input.runDetail ?? assigneeLabel,
      task.liveRuns.length
        ? action("stop", "Stop")
        : task.run?.state === "stopped"
          ? action("retry", "Retry")
          : null,
    );
  const blocker = task.blockedBy[0];
  if (blocker)
    return banner(
      "blocked",
      "neutral",
      `Waiting on ${blocker.displayId}`,
      `Can start when ${blocker.displayId} is done.`,
      action("open-task", `Open ${blocker.displayId}`, blocker.taskId),
    );
  return banner(
    task.status,
    "neutral",
    task.status === "ready" ? "Ready to start" : "Not started",
    assigneeLabel,
    task.assignee.assignment.mode === "person"
      ? null
      : action("start", task.assignee.resolved ? "Start" : "Assign and start"),
  );
}

export function presentFactoryTaskActivity(
  entry: FactoryTaskActivityEntry,
  catalog: FactoryTaskCatalog = [],
): string {
  const event = entry.event;
  switch (event.type) {
    case "created":
      return event.source.kind === "local"
        ? "Created task"
        : `Created from ${event.source.label}${event.ruleName ? ` by the rule ${event.ruleName}` : ""}`;
    case "comment":
      return event.body;
    case "status":
      return `Moved to ${event.to.replaceAll("-", " ")}`;
    case "assigned":
      return `Assigned to ${presentFactoryTaskAssignee(event.assignee, catalog).label}`;
    case "edited":
      return "Updated task";
    case "subtasks-added":
      return `${event.count} sub-tasks added`;
    case "plan-proposed":
      return `${entry.actor.label} proposed a plan`;
    case "plan-approved":
      return `Plan approved: ${event.count} sub-tasks created`;
    case "run-started":
      return `Run ${event.ordinal} started`;
    case "run-ended":
      return `Run ${event.ordinal} ${event.outcome}${event.note ? `: ${oneLine(event.note)}` : ""}`;
    case "result-ready":
      return `Result ready: ${event.summary}`;
    case "accepted":
      return `${entry.actor.label} accepted rev ${event.revision}`;
    case "changes-requested":
      return `Changes requested: ${oneLine(event.note)}`;
    case "reopened":
      return "Reopened task";
  }
}
