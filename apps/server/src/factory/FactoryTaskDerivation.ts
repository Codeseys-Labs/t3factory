import type {
  FactoryTaskAttention,
  FactoryTaskAttentionReason,
  FactoryTaskLane,
  FactoryTaskLiveRun,
  FactoryTaskResult,
  FactoryTaskRun,
  FactoryTaskRunState,
  FactoryTaskStatus,
} from "@t3tools/contracts";

/** What the execution engine and the run's thread say about one work run. */
interface WorkRunFacts {
  readonly quiescent: boolean;
  readonly engineStop: boolean;
  readonly stopByPerson: boolean;
  readonly nativeStatus: string | null;
  readonly outputStatus: "sealed" | "failed" | "held" | null;
  readonly effectsPending: boolean;
}

const INTERRUPTED = new Set(["interrupted", "cancelled", "rolled_back"]);

export function workRunState(facts: WorkRunFacts): {
  readonly state: FactoryTaskRunState;
  readonly note: string | null;
} {
  const interrupted = facts.stopByPerson || INTERRUPTED.has(facts.nativeStatus ?? "");
  if (facts.quiescent) {
    if (facts.outputStatus === "sealed") return { state: "completed", note: null };
    return interrupted ? { state: "stopped", note: null } : { state: "failed", note: "Run failed" };
  }
  if (!facts.engineStop) return { state: "running", note: null };
  // The run ended or was told to stop. With no effect left to finish it, it waits on a person.
  if (!facts.effectsPending)
    return { state: "held", note: "Waiting for the run's processes to exit" };
  return { state: interrupted ? "stopping" : "running", note: null };
}

export function planningRunState(nativeStatus: string | null): {
  readonly state: FactoryTaskRunState;
  readonly note: string | null;
} {
  if (nativeStatus === "completed") return { state: "completed", note: null };
  if (nativeStatus === "failed") return { state: "failed", note: "Run failed" };
  if (INTERRUPTED.has(nativeStatus ?? "")) return { state: "stopped", note: null };
  return { state: "running", note: null };
}

export const isLiveRunState = (state: FactoryTaskRunState): boolean =>
  state === "running" || state === "stopping" || state === "held";

export interface TaskResultFact {
  readonly revision: number;
  readonly kind: FactoryTaskResult["kind"];
  readonly summary: string;
  readonly runOrdinal: number;
  readonly threadId: FactoryTaskResult["threadId"];
  readonly observedAt: string;
}

export interface TaskFacts {
  readonly taskId: string;
  readonly displayId: string;
  readonly lane: FactoryTaskLane;
  /** Oldest first, work and planning runs together. */
  readonly runs: ReadonlyArray<FactoryTaskRun>;
  /** Oldest first. */
  readonly results: ReadonlyArray<TaskResultFact>;
  readonly acceptedRevision: number | null;
  /** Item count of the proposal waiting on a person, if any. */
  readonly proposalItems: number | null;
}

/** What a parent needs from each direct sub-task. */
export interface SubtaskFacts {
  readonly status: FactoryTaskStatus;
  readonly attention: ReadonlyArray<FactoryTaskAttention>;
  readonly liveRuns: ReadonlyArray<FactoryTaskLiveRun>;
}

export interface DerivedTask extends SubtaskFacts {
  /** The status before sub-tasks are considered. Lane moves and starts are judged on it. */
  readonly ownStatus: FactoryTaskStatus;
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly result: FactoryTaskResult | null;
  readonly run: FactoryTaskRun | null;
}

const ATTENTION_ORDER: ReadonlyArray<FactoryTaskAttentionReason> = [
  "failed",
  "approve",
  "question",
  "unconfirmed",
  "changed",
  "plan",
  "review",
];
const MAX_ROLLUP = 16;

export function deriveTask(facts: TaskFacts, subtasks: ReadonlyArray<SubtaskFacts>): DerivedTask {
  const workRuns = facts.runs.filter((run) => run.purpose === "work");
  const latestWork = workRuns.at(-1) ?? null;
  const workLive = workRuns.some((run) => isLiveRunState(run.state));
  const latest = facts.results.at(-1) ?? null;
  const accepted = latest !== null && facts.acceptedRevision === latest.revision;
  const changed =
    latest !== null && facts.acceptedRevision !== null && latest.revision > facts.acceptedRevision;

  const ownStatus: FactoryTaskStatus =
    facts.lane === "canceled"
      ? "canceled"
      : accepted || facts.lane === "done"
        ? "done"
        : latest !== null && !workLive
          ? "in-review"
          : workRuns.length > 0
            ? "in-progress"
            : facts.lane;
  const status: FactoryTaskStatus =
    (ownStatus === "backlog" || ownStatus === "ready") &&
    subtasks.some(
      (subtask) =>
        subtask.status === "in-progress" ||
        subtask.status === "in-review" ||
        subtask.status === "done",
    )
      ? "in-progress"
      : ownStatus;

  const own: FactoryTaskAttention[] = [];
  const raise = (reason: FactoryTaskAttentionReason, detail: string) =>
    own.push({ reason, taskId: facts.taskId, displayId: facts.displayId, detail });
  if (ownStatus !== "done" && ownStatus !== "canceled") {
    if (latestWork !== null && (latestWork.state === "failed" || latestWork.state === "held"))
      raise("failed", latestWork.note ?? "Run failed");
    if (ownStatus === "in-review" && latest !== null)
      raise(changed ? "changed" : "review", latest.summary);
    if (facts.proposalItems !== null)
      raise("plan", facts.proposalItems === 1 ? "1 sub-task" : `${facts.proposalItems} sub-tasks`);
  }
  const attention = [...own, ...subtasks.flatMap((subtask) => subtask.attention)]
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        ATTENTION_ORDER.indexOf(a.entry.reason) - ATTENTION_ORDER.indexOf(b.entry.reason) ||
        a.index - b.index,
    )
    .slice(0, MAX_ROLLUP)
    .map(({ entry }) => entry);

  const liveRuns = [
    ...facts.runs
      .filter((run) => isLiveRunState(run.state))
      .map((run) => ({
        taskId: facts.taskId,
        displayId: facts.displayId,
        threadId: run.threadId,
        state: run.state,
        startedAt: run.startedAt,
      })),
    ...subtasks.flatMap((subtask) => subtask.liveRuns),
  ].slice(0, MAX_ROLLUP);

  const counted = subtasks.filter((subtask) => subtask.status !== "canceled");
  return {
    ownStatus,
    status,
    attention,
    liveRuns,
    progress:
      counted.length === 0
        ? null
        : {
            done: counted.filter((subtask) => subtask.status === "done").length,
            total: counted.length,
          },
    result:
      latest === null
        ? null
        : {
            kind: latest.kind,
            revision: latest.revision,
            summary: latest.summary,
            state: accepted ? "accepted" : changed ? "changed" : "ready",
            acceptedRevision: facts.acceptedRevision,
            runOrdinal: latest.runOrdinal,
            threadId: latest.threadId,
            observedAt: latest.observedAt,
          },
    run: facts.runs.at(-1) ?? null,
  };
}

/** Derives every task of one top-level task, sub-tasks before their parents. */
export function deriveTree(
  tasks: ReadonlyArray<TaskFacts & { readonly parentId: string | null }>,
): ReadonlyMap<string, DerivedTask> {
  const children = new Map<string, Array<(typeof tasks)[number]>>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const siblings = children.get(task.parentId) ?? [];
    siblings.push(task);
    children.set(task.parentId, siblings);
  }
  const derived = new Map<string, DerivedTask>();
  const visiting = new Set<string>();
  const visit = (task: (typeof tasks)[number]): DerivedTask => {
    const known = derived.get(task.taskId);
    if (known !== undefined) return known;
    // The plan reducer rejects parent cycles; a repeated visit can only be corrupt data.
    const subtasks = visiting.has(task.taskId) ? [] : (children.get(task.taskId) ?? []);
    visiting.add(task.taskId);
    const result = deriveTask(task, subtasks.map(visit));
    derived.set(task.taskId, result);
    return result;
  };
  for (const task of tasks) visit(task);
  return derived;
}

type LaneMove =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "run-active" | "invalid-transition" };

/** The lane rules of the Tasks surface: what a person may move, and why not. */
export function checkLaneMove(input: {
  readonly from: FactoryTaskLane;
  readonly to: FactoryTaskLane;
  readonly status: FactoryTaskStatus;
  readonly accepted: boolean;
  readonly runLive: boolean;
  readonly resultWaiting: boolean;
}): LaneMove {
  const refuse = (reason: "run-active" | "invalid-transition"): LaneMove => ({
    allowed: false,
    reason,
  });
  if (input.from === input.to) return { allowed: true };
  if (input.to === "canceled") return input.runLive ? refuse("run-active") : { allowed: true };
  if (input.to === "done") {
    if (input.from === "canceled") return refuse("invalid-transition");
    if (input.runLive) return refuse("run-active");
    return input.resultWaiting ? refuse("invalid-transition") : { allowed: true };
  }
  if (input.from === "canceled") return { allowed: true };
  if (input.from === "done")
    return input.accepted ? refuse("invalid-transition") : { allowed: true };
  return input.status === "backlog" || input.status === "ready"
    ? { allowed: true }
    : refuse("invalid-transition");
}
