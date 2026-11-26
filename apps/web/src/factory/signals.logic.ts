import {
  FACTORY_SIGNAL_FEEDS_MAX,
  type FactorySignalCandidate,
  type FactorySignalDecisionInput,
  type FactorySignalFailure,
  type FactorySignalFeedView,
  type FactorySignalsList,
} from "@t3tools/contracts";

export type SignalAction = "admit" | "dismiss" | "open-task";

/** One candidate as Signals shows it, with what a person can do with it there. */
export interface SignalRow {
  readonly candidate: FactorySignalCandidate;
  /** Null when the list does not have the candidate's feed. */
  readonly feedLabel: string | null;
  /** The number of the task it was admitted as, when the tasks given have that task. */
  readonly taskNumber: number | null;
  /** Admitted, and the feed has revised the item since the revision that was admitted. */
  readonly changedAfterAdmit: boolean;
  readonly actions: ReadonlyArray<SignalAction>;
}

export type SignalFeedStatus =
  | { readonly kind: "unread" }
  | { readonly kind: "ok"; readonly at: string }
  | {
      readonly kind: "failed";
      readonly at: string;
      readonly failure: FactorySignalFailure;
      readonly httpStatus: number | null;
      readonly lastOkAt: string | null;
    };

/** A decision under way on a candidate, or one that succeeded on the revision and state shown. */
export type SignalDecisionLock =
  | { readonly phase: "running" }
  | {
      readonly phase: "decided";
      readonly revision: number;
      readonly state: FactorySignalCandidate["state"];
    };

const PENDING_ACTIONS: ReadonlyArray<SignalAction> = ["admit", "dismiss"];
const DISMISSED_ACTIONS: ReadonlyArray<SignalAction> = ["admit"];
const ADMITTED_ACTIONS: ReadonlyArray<SignalAction> = ["open-task"];
const NO_ACTIONS: ReadonlyArray<SignalAction> = [];

/** The list's candidates in its order, each with its feed's name, its task and its actions. */
export function selectSignalRows(
  list: Pick<FactorySignalsList, "feeds" | "candidates">,
  tasks: ReadonlyArray<{ readonly id: string; readonly number: number }>,
): ReadonlyArray<SignalRow> {
  const labels = new Map(list.feeds.map((view) => [view.feed.id, view.feed.label] as const));
  const numbers = new Map(tasks.map((task) => [task.id, task.number] as const));
  return list.candidates.map((candidate) => {
    const taskNumber = candidate.taskId === null ? null : (numbers.get(candidate.taskId) ?? null);
    const admitted = candidate.state === "admitted";
    return {
      candidate,
      feedLabel: labels.get(candidate.feedId) ?? null,
      taskNumber,
      changedAfterAdmit:
        admitted &&
        candidate.decidedRevision !== null &&
        candidate.revision > candidate.decidedRevision,
      actions:
        candidate.state === "pending"
          ? PENDING_ACTIONS
          : candidate.state === "dismissed"
            ? DISMISSED_ACTIONS
            : taskNumber !== null
              ? ADMITTED_ACTIONS
              : NO_ACTIONS,
    };
  });
}

/** The candidates waiting across every followed feed. */
export function pendingTotal(list: Pick<FactorySignalsList, "feeds">): number {
  return list.feeds.reduce((total, view) => total + view.pending, 0);
}

/** How the last read of a feed went; a reservation with nothing read yet is still unread. */
export function feedStatus(view: Pick<FactorySignalFeedView, "state">): SignalFeedStatus {
  const { state } = view;
  if (state === null) return { kind: "unread" };
  if (state.failure === null) {
    return state.lastOkAt === null ? { kind: "unread" } : { kind: "ok", at: state.lastOkAt };
  }
  return {
    kind: "failed",
    at: state.lastPullAt,
    failure: state.failure,
    httpStatus: state.httpStatus,
    lastOkAt: state.lastOkAt,
  };
}

/** What Admit or Dismiss sends: exactly the revision and digest of the candidate that was shown. */
export function decisionInput(candidate: FactorySignalCandidate): FactorySignalDecisionInput {
  return {
    feedId: candidate.feedId,
    candidateId: candidate.id,
    revision: candidate.revision,
    sha256: candidate.sha256,
  };
}

/** Whether the server would take one more feed, as far as the list shows. */
export function canFollowMore(list: Pick<FactorySignalsList, "feeds">): boolean {
  return list.feeds.length < FACTORY_SIGNAL_FEEDS_MAX;
}

/**
 * Whether a candidate's Admit and Dismiss wait: a decision on it is under way, or one succeeded
 * and the list still shows the candidate at the revision and state it was decided on.
 */
export function signalDecisionWaits(
  lock: SignalDecisionLock | undefined,
  candidate: Pick<FactorySignalCandidate, "revision" | "state">,
): boolean {
  if (lock === undefined) return false;
  return (
    lock.phase === "running" ||
    (lock.revision === candidate.revision && lock.state === candidate.state)
  );
}
