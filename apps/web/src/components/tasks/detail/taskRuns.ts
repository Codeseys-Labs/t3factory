import type { FactoryTaskRun } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../../i18n/messages";

import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../../../timestampFormat";
import type { ThreadStatusPill } from "../../Sidebar.logic";
import { type LiveTone, liveToneForThreadStatus } from "../kit";

const ENDED: Record<
  Exclude<FactoryTaskRun["state"], "running">,
  { label: string; tone: LiveTone }
> = {
  stopping: { label: msg("Stopping", { $context: "run state" }), tone: "neutral" },
  held: { label: msg("Held", { $context: "run state" }), tone: "failed" },
  failed: { label: msg("Failed", { $context: "run state" }), tone: "failed" },
  stopped: { label: msg("Stopped", { $context: "run state" }), tone: "neutral" },
  completed: { label: msg("Completed", { $context: "run state" }), tone: "completed" },
};

/**
 * A run's state word. While it runs, the word is its thread's, as in the thread sidebar; the
 * server's state names a run that has finished.
 */
export function runStateWord(
  run: Pick<FactoryTaskRun, "state">,
  threadLabel: string | null,
  resolve: MessageResolver = m,
): { label: string; tone: LiveTone } {
  if (run.state === "running" && threadLabel !== null)
    return {
      label: resolve(threadLabel),
      tone: liveToneForThreadStatus(threadLabel as ThreadStatusPill["label"]) ?? "neutral",
    };
  return run.state === "running"
    ? { label: resolve(msg("Working", { $context: "run state" })), tone: "working" }
    : {
        label: resolve(ENDED[run.state].label),
        tone: ENDED[run.state].tone,
      };
}

/** `13m · DESKTOP-CP4EDJH` for a work run, `Planning · 2d ago` for a planning run. */
export function runDetailLine(
  run: FactoryTaskRun,
  now: number,
  machine: string | undefined,
  resolve: MessageResolver = m,
) {
  if (run.purpose === "planning")
    return resolve(msg("Planning · {time}", { time: formatRelativeTimeLabel(run.startedAt, now) }));
  const end = run.endedAt === null ? now : Date.parse(run.endedAt);
  return [formatElapsedDurationLabel(run.startedAt, end), machine].filter(Boolean).join(" · ");
}

/** A run that has not finished, so its thread may still be steered or stopped. */
export function isRunLive(run: Pick<FactoryTaskRun, "state">) {
  return run.state === "running" || run.state === "stopping";
}
