import type { FactoryTaskNeed } from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskAttentionReason, FactoryTaskSummary } from "@t3tools/contracts";

import type { LiveTone } from "../kit";

export interface TaskLivePill {
  readonly label: string;
  readonly tone: LiveTone;
  readonly duration: string;
}

export type TaskStateMarkValue =
  | { readonly kind: "live"; readonly pill: TaskLivePill }
  | { readonly kind: "needs"; readonly reason: FactoryTaskAttentionReason }
  | { readonly kind: "blocked"; readonly blockerId: string }
  | null;

/**
 * A task's state is shown once: the live pill while a run exists, otherwise the most urgent
 * Needs-you reason, otherwise the first blocker, otherwise nothing. `needs` is most urgent first.
 */
export function resolveTaskStateMark(input: {
  readonly pill: TaskLivePill | null;
  readonly needs: readonly Pick<FactoryTaskNeed, "reason">[];
  readonly blockedBy: FactoryTaskSummary["blockedBy"];
}): TaskStateMarkValue {
  if (input.pill) return { kind: "live", pill: input.pill };
  const need = input.needs[0];
  if (need) return { kind: "needs", reason: need.reason };
  const blocker = input.blockedBy[0];
  if (blocker) return { kind: "blocked", blockerId: blocker.displayId };
  return null;
}

const TONE_URGENCY: readonly LiveTone[] = [
  "pending-approval",
  "awaiting-input",
  "guest",
  "failed",
  "plan-ready",
  "working",
  "neutral",
  "completed",
];

/** The live run a pill speaks for: the one most in need of a person. */
export function mostUrgentLive<T extends { readonly tone: LiveTone }>(
  runs: readonly T[],
): T | null {
  let best: T | null = null;
  for (const run of runs)
    if (best === null || TONE_URGENCY.indexOf(run.tone) < TONE_URGENCY.indexOf(best.tone))
      best = run;
  return best;
}
