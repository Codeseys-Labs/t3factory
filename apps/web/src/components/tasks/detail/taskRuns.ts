import type { FactoryTaskRun } from "@t3tools/contracts";

import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../../../timestampFormat";
import type { ThreadStatusPill } from "../../Sidebar.logic";
import { type LiveTone, liveToneForThreadStatus } from "../kit";

const ENDED: Record<
  Exclude<FactoryTaskRun["state"], "running">,
  { label: string; tone: LiveTone }
> = {
  stopping: { label: "Stopping", tone: "neutral" },
  held: { label: "Held", tone: "failed" },
  failed: { label: "Failed", tone: "failed" },
  stopped: { label: "Stopped", tone: "neutral" },
  completed: { label: "Completed", tone: "completed" },
};

/**
 * A run's state word. While it runs, the word is its thread's, as in the thread sidebar; the
 * server's state names a run that has finished.
 */
export function runStateWord(
  run: Pick<FactoryTaskRun, "state">,
  threadLabel: string | null,
): { label: string; tone: LiveTone } {
  if (run.state === "running" && threadLabel !== null)
    return {
      label: threadLabel,
      tone: liveToneForThreadStatus(threadLabel as ThreadStatusPill["label"]) ?? "neutral",
    };
  return run.state === "running" ? { label: "Working", tone: "working" } : ENDED[run.state];
}

/** `13m · DESKTOP-CP4EDJH` for a work run, `Planning · 2d ago` for a planning run. */
export function runDetailLine(run: FactoryTaskRun, now: number, machine: string | undefined) {
  if (run.purpose === "planning")
    return `Planning · ${formatRelativeTimeLabel(run.startedAt, now)}`;
  const end = run.endedAt === null ? now : Date.parse(run.endedAt);
  return [formatElapsedDurationLabel(run.startedAt, end), machine].filter(Boolean).join(" · ");
}

/** A run that has not finished, so its thread may still be steered or stopped. */
export function isRunLive(run: Pick<FactoryTaskRun, "state">) {
  return run.state === "running" || run.state === "stopping";
}
