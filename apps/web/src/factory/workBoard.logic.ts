import { readWorkflowQuestion } from "@t3tools/client-runtime/workflows";
import {
  type FactoryTaskSummary,
  type WorkflowQuestion,
  type WorkflowRun,
  workflowQuestionKey,
} from "@t3tools/contracts";
import { msg } from "gt-react";

export type WorkColumn = "backlog" | "ready" | "doing" | "review" | "done";

export const WORK_COLUMNS: ReadonlyArray<WorkColumn> = [
  "backlog",
  "ready",
  "doing",
  "review",
  "done",
];

/** What each column means, in the words the Orchestrator skill uses. */
export const WORK_COLUMN_DEFINITIONS: Readonly<Record<WorkColumn, string>> = {
  backlog: msg("Work is recorded for later."),
  ready: msg("Work is queued to start and may still have blockers."),
  doing: msg("Work is under way or has been placed here manually."),
  review: msg("Work is in review or has been placed here for review."),
  done: msg("The task run completed or someone marked the task done."),
};

export type WorkBadge = "needs-you" | "failed" | "blocked" | "stopped";

export interface WorkCard {
  readonly task: FactoryTaskSummary;
  readonly column: WorkColumn;
  readonly badges: ReadonlyArray<WorkBadge>;
  /** The latest attempt's run, when the list has it. */
  readonly run: WorkflowRun | null;
  readonly childCount: number;
  /** Ids of `blockedBy` tasks not yet done. */
  readonly openBlockers: ReadonlyArray<string>;
  readonly activity: "working" | "waiting" | null;
  /** Runs directly below the card's run that have not ended. */
  readonly liveParts: number;
  /** The column comes from the task's children, not its own lane; see `rollUpParents`. */
  readonly rolledUp?: boolean;
}

const isTaggedReview = (run: WorkflowRun) => run.tags?.includes("stage:review") === true;

// WorkflowStore.runs caps ordinary runs separately from skipped roots and retains questions and pauses.
const RECENT_WORKFLOW_RUN_LIMIT = 500;

/** Review requires at least one live part and enough of the snapshot to rule out missing siblings. */
function isLiveRunInReview(
  run: WorkflowRun,
  childrenOf: ReadonlyMap<string, ReadonlyArray<WorkflowRun>>,
  recentRunsCutoff: string | undefined,
): boolean {
  if (run.workflow !== "factory-task") return isTaggedReview(run);
  if (recentRunsCutoff !== undefined && run.startedAt <= recentRunsCutoff) return false;

  const children = childrenOf.get(run.runId);
  if (children === undefined) return false;
  let hasLivePart = false;
  for (const child of children) {
    if (child.workflow !== "factory-task-part" || child.endedAt !== null) continue;
    if (!isTaggedReview(child)) return false;
    hasLivePart = true;
  }
  return hasLivePart;
}

function resolveColumn(
  task: FactoryTaskSummary,
  run: WorkflowRun | null,
  childrenOf: ReadonlyMap<string, ReadonlyArray<WorkflowRun>>,
  recentRunsCutoff: string | undefined,
): WorkColumn | null {
  if (task.lane === "dropped") return null;
  if (run === null) return task.lane;
  if (run.endedAt === null) {
    return isLiveRunInReview(run, childrenOf, recentRunsCutoff) ? "review" : "doing";
  }
  if (task.laneSetAt > run.endedAt) return task.lane;
  return run.status === "completed" ? "done" : task.lane;
}

/** The column a never-started parent shows from its children's own columns. */
function rolledUpColumn(children: ReadonlyArray<WorkColumn>): WorkColumn {
  if (children.every((column) => column === "done")) return "done";
  for (const column of ["doing", "review", "ready"] as const) {
    if (children.includes(column)) return column;
  }
  return "backlog";
}

function isOnParentCycle(taskId: string, parentOf: ReadonlyMap<string, string | null>): boolean {
  const seen = new Set<string>();
  let current = parentOf.get(taskId) ?? null;
  while (current !== null && !seen.has(current)) {
    if (current === taskId) return true;
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}

function readRunActivity(
  run: WorkflowRun,
  childrenOf: ReadonlyMap<string, ReadonlyArray<WorkflowRun>>,
): {
  readonly activity: "working" | "waiting" | null;
  readonly liveParts: number;
  readonly paused: boolean;
} {
  let liveParts = 0;
  for (const child of childrenOf.get(run.runId) ?? []) {
    if (child.endedAt === null && child.runId !== run.runId) liveParts += 1;
  }
  if (run.endedAt !== null) return { activity: null, liveParts, paused: false };
  const seen = new Set<string>([run.runId]);
  const pending: WorkflowRun[] = [run];
  let working = false;
  let paused = false;
  for (let head = 0; head < pending.length; head += 1) {
    const current = pending[head]!;
    if (current.endedAt === null) {
      if (current.status === "paused") paused = true;
      if (
        current.status === "running" ||
        (current.status === "waiting" && current.detail?.startsWith("agent ") === true)
      ) {
        working = true;
      }
    }
    for (const child of childrenOf.get(current.runId) ?? []) {
      if (seen.has(child.runId)) continue;
      seen.add(child.runId);
      pending.push(child);
    }
  }
  return { activity: working ? "working" : "waiting", liveParts, paused };
}

function compareTasks(a: FactoryTaskSummary, b: FactoryTaskSummary): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function deriveWorkCards(input: {
  readonly tasks: ReadonlyArray<FactoryTaskSummary>;
  /** The workflow snapshot's runs, newest first. */
  readonly runs: ReadonlyArray<WorkflowRun>;
  readonly questions: ReadonlyArray<WorkflowQuestion>;
  /**
   * Shows a never-started parent with children in the column its children add up to. Display
   * only: blockers still read each task's own column. Pass it only for a complete task list.
   */
  readonly rollUpParents?: boolean;
}): ReadonlyArray<WorkCard> {
  const runsById = new Map<string, WorkflowRun>();
  for (const run of input.runs) runsById.set(run.runId, run);

  // Every run on the parent chain of an asking run, the asking run included.
  const askingRuns = new Set<string>();
  for (const question of input.questions) {
    let runId: string | null = question.runId;
    while (runId !== null && !askingRuns.has(runId)) {
      askingRuns.add(runId);
      runId = runsById.get(runId)?.parentRunId ?? null;
    }
  }

  const childrenOf = new Map<string, WorkflowRun[]>();
  let recentRuns = 0;
  let recentRunsCutoff: string | undefined;
  for (const run of input.runs) {
    if (recentRunsCutoff === undefined && !(run.status === "skipped" && run.parentRunId === null)) {
      recentRuns += 1;
      if (recentRuns === RECENT_WORKFLOW_RUN_LIMIT) recentRunsCutoff = run.startedAt;
    }
    if (run.parentRunId === null) continue;
    const siblings = childrenOf.get(run.parentRunId);
    if (siblings === undefined) childrenOf.set(run.parentRunId, [run]);
    else siblings.push(run);
  }

  const childCounts = new Map<string, number>();
  const columns = new Map<string, WorkColumn | null>();
  const runOf = new Map<string, WorkflowRun | null>();
  const childColumns = new Map<string, WorkColumn[]>();
  const parentOf = new Map<string, string | null>();
  for (const task of input.tasks) {
    const runId = task.attempt?.runId;
    const run = runId === null || runId === undefined ? null : (runsById.get(runId) ?? null);
    runOf.set(task.id, run);
    const column = resolveColumn(task, run, childrenOf, recentRunsCutoff);
    columns.set(task.id, column);
    parentOf.set(task.id, task.parentId);
    if (task.lane !== "dropped" && task.parentId !== null) {
      childCounts.set(task.parentId, (childCounts.get(task.parentId) ?? 0) + 1);
    }
    if (input.rollUpParents === true && column !== null && task.parentId !== null) {
      const siblings = childColumns.get(task.parentId);
      if (siblings === undefined) childColumns.set(task.parentId, [column]);
      else siblings.push(column);
    }
  }

  const cards: WorkCard[] = [];
  for (const task of [...input.tasks].toSorted(compareTasks)) {
    const ownColumn = columns.get(task.id) ?? null;
    if (ownColumn === null) continue;
    const children = childColumns.get(task.id);
    const rolledUp =
      children !== undefined && task.attempt === null && !isOnParentCycle(task.id, parentOf);
    const column = rolledUp ? rolledUpColumn(children) : ownColumn;
    const run = runOf.get(task.id) ?? null;
    const openBlockers = task.blockedBy.filter((id) => {
      const blockerColumn = columns.get(id);
      return blockerColumn !== undefined && blockerColumn !== null && blockerColumn !== "done";
    });
    const { activity, liveParts, paused } =
      run === null
        ? { activity: null, liveParts: 0, paused: false }
        : readRunActivity(run, childrenOf);
    const stopped =
      run !== null &&
      run.endedAt !== null &&
      (run.status === "stopped" || run.status === "cancelled") &&
      task.laneSetAt <= run.endedAt;
    const badges: WorkBadge[] = [];
    if (run !== null && askingRuns.has(run.runId)) badges.push("needs-you");
    if (paused) badges.push("failed");
    if (openBlockers.length > 0) badges.push("blocked");
    if (stopped) badges.push("stopped");
    cards.push({
      task,
      column,
      badges,
      run,
      childCount: childCounts.get(task.id) ?? 0,
      openBlockers,
      activity,
      liveParts,
      rolledUp,
    });
  }
  return cards;
}

export type AttentionKind =
  | "approve-plan"
  | "approve-merge"
  | "accept"
  | "stuck"
  | "failed"
  | "question";

/** One thing a task waits on a person for: an open question, or a run a failing step paused. */
export interface AttentionItem {
  readonly key: string;
  readonly taskId: string;
  readonly taskNumber: number;
  readonly taskTitle: string;
  /** The run that asks or is paused: the task's own run or a part below it. */
  readonly runId: string;
  readonly kind: AttentionKind;
  /** The question's title, or why the run paused. */
  readonly detail: string | null;
  /** When it started waiting on the person. */
  readonly askedAt: string;
}

/** The item a question is, by the kinds the Factory pack declares. */
function questionAttentionKind(kind: string | undefined): AttentionKind {
  switch (kind) {
    case "plan":
      return "approve-plan";
    case "merge":
      return "approve-merge";
    case "accept":
    case "stuck":
      return kind;
    default:
      return "question";
  }
}

/**
 * Every item the cards' runs wait on a person for, oldest first: each open question, and each
 * paused run, on a card's run or a run below it, while every run from it up to the card's is live.
 */
export function selectAttentionItems(input: {
  readonly cards: ReadonlyArray<WorkCard>;
  readonly runs: ReadonlyArray<WorkflowRun>;
  readonly questions: ReadonlyArray<WorkflowQuestion>;
}): ReadonlyArray<AttentionItem> {
  const cardOfRun = new Map<string, WorkCard>();
  for (const card of input.cards) {
    if (card.run !== null) cardOfRun.set(card.run.runId, card);
  }
  if (cardOfRun.size === 0) return [];
  const runsById = new Map<string, WorkflowRun>();
  for (const run of input.runs) runsById.set(run.runId, run);

  // The card a run belongs to up its parent chain, or null when a run on the way has ended or
  // the chain loops. Memoised, so each run is walked once.
  const owners = new Map<string, WorkCard | null>();
  const ownerOf = (runId: string): WorkCard | null => {
    const path: string[] = [];
    const onPath = new Set<string>();
    let owner: WorkCard | null = null;
    let current: string | null = runId;
    while (current !== null && !onPath.has(current)) {
      const known = owners.get(current);
      if (known !== undefined) {
        owner = known;
        break;
      }
      const card = cardOfRun.get(current);
      if (card !== undefined) {
        owner = card.run?.endedAt === null ? card : null;
        owners.set(current, owner);
        break;
      }
      onPath.add(current);
      path.push(current);
      current = runsById.get(current)?.parentRunId ?? null;
    }
    // From the run nearest the card down to the asking one: an ended run cuts off all below it.
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const id = path[index]!;
      if (owner !== null && runsById.get(id)?.endedAt !== null) owner = null;
      owners.set(id, owner);
    }
    return owner;
  };

  const items: AttentionItem[] = [];
  for (const question of input.questions) {
    const card = ownerOf(question.runId);
    if (card === null) continue;
    items.push({
      key: `question ${workflowQuestionKey(question)}`,
      taskId: card.task.id,
      taskNumber: card.task.number,
      taskTitle: card.task.title,
      runId: question.runId,
      kind: questionAttentionKind(question.kind),
      detail: readWorkflowQuestion(question).title,
      askedAt: question.askedAt,
    });
  }
  for (const run of input.runs) {
    if (run.status !== "paused" || run.endedAt !== null) continue;
    const card = ownerOf(run.runId);
    if (card === null) continue;
    items.push({
      key: `failed ${JSON.stringify([run.runId, run.pauses])}`,
      taskId: card.task.id,
      taskNumber: card.task.number,
      taskTitle: card.task.title,
      runId: run.runId,
      kind: "failed",
      detail: run.detail,
      askedAt: run.updatedAt,
    });
  }
  return items.toSorted((left, right) =>
    left.askedAt !== right.askedAt
      ? left.askedAt < right.askedAt
        ? -1
        : 1
      : left.key === right.key
        ? 0
        : left.key < right.key
          ? -1
          : 1,
  );
}

export interface WorkFilter {
  readonly projectId?: string | null;
  readonly assignee?: string;
  readonly modelInstanceId?: string;
  readonly text?: string;
}

export function filterWorkCards(
  cards: ReadonlyArray<WorkCard>,
  filter: WorkFilter,
): ReadonlyArray<WorkCard> {
  const text = filter.text?.toLowerCase();
  return cards.filter(({ task }) => {
    if (filter.projectId !== undefined && task.projectId !== filter.projectId) return false;
    if (filter.assignee !== undefined && task.assignee !== filter.assignee) return false;
    if (filter.modelInstanceId !== undefined && task.model?.instanceId !== filter.modelInstanceId) {
      return false;
    }
    if (text !== undefined) {
      return (
        task.title.toLowerCase().includes(text) || `t-${task.number}`.toLowerCase().includes(text)
      );
    }
    return true;
  });
}

export function groupWorkCards(
  cards: ReadonlyArray<WorkCard>,
): Readonly<Record<WorkColumn, ReadonlyArray<WorkCard>>> {
  const groups: Record<WorkColumn, WorkCard[]> = {
    backlog: [],
    ready: [],
    doing: [],
    review: [],
    done: [],
  };
  for (const card of cards) groups[card.column].push(card);
  return groups;
}

export interface WorkGraph {
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly depth: number;
    readonly card: WorkCard;
  }>;
  readonly edges: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly kind: "parent" | "blocks";
  }>;
}

/** Marks every node on a cycle (a self-edge included): Tarjan's components, without recursion. */
function findCycleNodes(outgoing: ReadonlyArray<ReadonlyArray<number>>): ReadonlyArray<boolean> {
  const count = outgoing.length;
  const onCycle: boolean[] = new Array<boolean>(count).fill(false);
  const order: number[] = new Array<number>(count).fill(-1);
  const low: number[] = new Array<number>(count).fill(0);
  const open: boolean[] = new Array<boolean>(count).fill(false);
  const stack: number[] = [];
  let next = 0;

  for (let root = 0; root < count; root += 1) {
    if (order[root] !== -1) continue;
    const frames: Array<{ readonly node: number; edge: number }> = [{ node: root, edge: 0 }];
    order[root] = low[root] = next++;
    stack.push(root);
    open[root] = true;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const targets = outgoing[frame.node]!;
      if (frame.edge < targets.length) {
        const target = targets[frame.edge++]!;
        if (target === frame.node) onCycle[target] = true;
        if (order[target] === -1) {
          order[target] = low[target] = next++;
          stack.push(target);
          open[target] = true;
          frames.push({ node: target, edge: 0 });
        } else if (open[target]) {
          low[frame.node] = Math.min(low[frame.node]!, order[target]!);
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        low[parent.node] = Math.min(low[parent.node]!, low[frame.node]!);
      }
      if (low[frame.node] === order[frame.node]) {
        const component: number[] = [];
        let member: number;
        do {
          member = stack.pop()!;
          open[member] = false;
          component.push(member);
        } while (member !== frame.node);
        if (component.length > 1) {
          for (const node of component) onCycle[node] = true;
        }
      }
    }
  }
  return onCycle;
}

export function deriveWorkGraph(cards: ReadonlyArray<WorkCard>): WorkGraph {
  const indexById = new Map<string, number>();
  cards.forEach((card, index) => indexById.set(card.task.id, index));

  const edges: Array<{ from: string; to: string; kind: "parent" | "blocks" }> = [];
  const outgoing: number[][] = cards.map(() => []);
  const incoming: number[][] = cards.map(() => []);
  const link = (from: string, to: number, kind: "parent" | "blocks") => {
    const source = indexById.get(from);
    if (source === undefined) return;
    edges.push({ from, to: cards[to]!.task.id, kind });
    outgoing[source]!.push(to);
    incoming[to]!.push(source);
  };
  cards.forEach(({ task }, index) => {
    if (task.parentId !== null) link(task.parentId, index, "parent");
    for (const blockerId of task.blockedBy) link(blockerId, index, "blocks");
  });

  const onCycle = findCycleNodes(outgoing);
  const depth: number[] = new Array<number>(cards.length).fill(0);
  // Edges into a cycle node are ignored, so what remains is acyclic and every node is reached.
  const waiting = incoming.map((sources, index) => (onCycle[index] ? 0 : sources.length));
  const ready: number[] = [];
  waiting.forEach((count, index) => {
    if (count === 0) ready.push(index);
  });
  for (let head = 0; head < ready.length; head += 1) {
    const node = ready[head]!;
    for (const target of outgoing[node]!) {
      if (onCycle[target]) continue;
      depth[target] = Math.max(depth[target]!, depth[node]! + 1);
      waiting[target] = waiting[target]! - 1;
      if (waiting[target] === 0) ready.push(target);
    }
  }

  return {
    nodes: cards.map((card, index) => ({ id: card.task.id, depth: depth[index]!, card })),
    edges,
  };
}
