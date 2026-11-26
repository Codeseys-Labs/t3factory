import type {
  FactoryReviewFinding,
  FactoryReviewRound,
  FactoryTaskSummary,
} from "@t3tools/contracts";

import type { WorkCard } from "./workBoard.logic";

const BLOCKING_SEVERITIES: ReadonlyArray<FactoryReviewFinding["severity"]> = ["blocker", "major"];
const RELATIONS_LIMIT = 25;

export interface FindingView extends FactoryReviewFinding {
  /** Open, with a severity that blocks the merge. */
  readonly blocking: boolean;
  /** Null in the part's last round; else whether a later round of the part has the same id. */
  readonly raisedAgain: boolean | null;
}

export interface ReviewRoundView {
  readonly at: string;
  readonly head: string | null;
  readonly createdAt: string;
  readonly verdict: "approve" | "changes" | "stale";
  readonly lenses: ReadonlyArray<"brief" | "defects">;
  readonly findings: ReadonlyArray<FindingView>;
}

export interface PartReviewView {
  readonly part: number;
  readonly rounds: ReadonlyArray<ReviewRoundView>;
  readonly latestVerdict: "approve" | "changes" | "stale" | null;
  readonly blocking: number;
  readonly refuted: number;
}

// String order, as the server orders them: a parsed time would drop digits past the millisecond.
function compareRounds(left: FactoryReviewRound, right: FactoryReviewRound): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.at === right.at) return 0;
  return left.at < right.at ? -1 : 1;
}

/** One attempt's review rounds by part, each finding marked as blocking and as raised again. */
export function selectReviewParts(
  reviews: ReadonlyArray<FactoryReviewRound> | undefined,
  attempt: number,
): ReadonlyArray<PartReviewView> {
  if (reviews === undefined) return [];
  const byPart = new Map<number, FactoryReviewRound[]>();
  for (const round of reviews) {
    if (round.attempt !== attempt) continue;
    const rounds = byPart.get(round.part);
    if (rounds === undefined) byPart.set(round.part, [round]);
    else rounds.push(round);
  }
  return [...byPart.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([part, stored]) => {
      const ordered = stored.toSorted(compareRounds);
      // Walked from the last round back, so `later` holds the ids of every round after this one.
      const later = new Set<string>();
      const rounds: ReviewRoundView[] = [];
      for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const round = ordered[index]!;
        const last = index === ordered.length - 1;
        rounds[index] = {
          at: round.at,
          head: round.head,
          createdAt: round.createdAt,
          verdict: round.verdict,
          lenses: round.lenses,
          findings: round.findings.map((finding) => ({
            ...finding,
            blocking: finding.status === "open" && BLOCKING_SEVERITIES.includes(finding.severity),
            raisedAgain: last ? null : later.has(finding.id),
          })),
        };
        for (const finding of round.findings) later.add(finding.id);
      }
      const settled = rounds.findLast((round) => round.verdict !== "stale");
      const refuted = new Set<string>();
      for (const round of rounds) {
        for (const finding of round.findings) {
          if (finding.status === "refuted") refuted.add(finding.id);
        }
      }
      return {
        part,
        rounds,
        latestVerdict: settled?.verdict ?? "stale",
        blocking: settled?.findings.filter((finding) => finding.blocking).length ?? 0,
        refuted: refuted.size,
      };
    });
}

export type RelationStatus = "open" | "completed" | "dropped" | "unknown";

export interface RelationEdge {
  readonly taskId: string;
  readonly number: number | null;
  readonly title: string | null;
  readonly status: RelationStatus;
}

export interface DirectRelations {
  readonly blockers: ReadonlyArray<RelationEdge>;
  readonly children: ReadonlyArray<RelationEdge>;
  readonly omitted: { readonly blockers: number; readonly children: number };
}

/** What a task waits on and what is part of it, from the board's own snapshot. */
export function selectDirectRelations(
  taskId: string,
  tasks: ReadonlyArray<FactoryTaskSummary>,
  cards: ReadonlyArray<WorkCard>,
  limit: number = RELATIONS_LIMIT,
): DirectRelations {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    return { blockers: [], children: [], omitted: { blockers: 0, children: 0 } };
  }
  const cardOf = new Map<string, WorkCard>();
  for (const card of cards) cardOf.set(card.task.id, card);
  const fromCard = (card: WorkCard): RelationEdge => ({
    taskId: card.task.id,
    number: card.task.number,
    title: card.task.title,
    status: card.column === "done" ? "completed" : "open",
  });
  const blockers = task.blockedBy.map((blockerId): RelationEdge => {
    const card = cardOf.get(blockerId);
    if (card !== undefined) return fromCard(card);
    const listed = tasks.find((candidate) => candidate.id === blockerId);
    // A listed task with no card and not dropped means the cards are of another list: unknown.
    return listed === undefined
      ? { taskId: blockerId, number: null, title: null, status: "unknown" }
      : {
          taskId: blockerId,
          number: listed.number,
          title: listed.title,
          status: listed.lane === "dropped" ? "dropped" : "unknown",
        };
  });
  const children = tasks
    .filter((candidate) => candidate.parentId === taskId && cardOf.has(candidate.id))
    .toSorted((left, right) => left.number - right.number)
    .map((child) => fromCard(cardOf.get(child.id)!));
  const room = Math.max(0, limit);
  const shownBlockers = blockers.slice(0, room);
  const shownChildren = children.slice(0, room - shownBlockers.length);
  return {
    blockers: shownBlockers,
    children: shownChildren,
    omitted: {
      blockers: blockers.length - shownBlockers.length,
      children: children.length - shownChildren.length,
    },
  };
}

/** Where focus goes once the Needs you item `current` was answered or its panel closed. */
export function nextAttentionFocus(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
  current: string,
): string | null {
  if (after.includes(current)) return current;
  const index = before.indexOf(current);
  if (index === -1) return after[0] ?? null;
  const remaining = new Set(after);
  const following = before.slice(index + 1).find((key) => remaining.has(key));
  if (following !== undefined) return following;
  return before.slice(0, index).findLast((key) => remaining.has(key)) ?? null;
}

/** The Needs you count over environments; one whose count is unknown makes it a lower bound. */
export function combineAttentionCounts(counts: ReadonlyArray<number | null>): {
  readonly total: number;
  readonly atLeast: boolean;
} {
  let total = 0;
  let atLeast = false;
  for (const count of counts) {
    if (count === null) atLeast = true;
    else total += count;
  }
  return { total, atLeast };
}
