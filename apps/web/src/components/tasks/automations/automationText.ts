import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  FactoryIntakeAutonomy,
  FactoryIntakeSchedule,
  FactoryIntakeSource,
  FactoryTaskType,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../../i18n/messages";
import { TASK_TYPE_LABELS } from "../kit";

export const TASK_TYPES = Object.keys(TASK_TYPE_LABELS) as FactoryTaskType[];

export const AUTONOMY: Record<FactoryIntakeAutonomy, { label: string; description: string }> = {
  manual: {
    label: msg("Manual", { $context: "intake autonomy level" }),
    description: msg("New items wait in the Inbox."),
  },
  suggest: {
    label: msg("Suggest", { $context: "intake autonomy level" }),
    description: msg("Fills in type and assignee; you accept."),
  },
  "auto-start": {
    label: msg("Auto-start", { $context: "intake autonomy level" }),
    description: msg("Creates the task and starts it. The agent runs in its profile's mode."),
  },
};

export const EVERY_START_NEEDS_A_PERSON = msg("Every start needs a person.");

/** Monday first, as people read a week; the values are the contract's 0 = Sunday. */
export const WEEKDAYS = [
  { day: 1, short: msg("Mon"), plural: msg("Mondays") },
  { day: 2, short: msg("Tue"), plural: msg("Tuesdays") },
  { day: 3, short: msg("Wed"), plural: msg("Wednesdays") },
  { day: 4, short: msg("Thu"), plural: msg("Thursdays") },
  { day: 5, short: msg("Fri"), plural: msg("Fridays") },
  { day: 6, short: msg("Sat"), plural: msg("Saturdays") },
  { day: 0, short: msg("Sun"), plural: msg("Sundays") },
] as const;

function scheduleText(
  { timeOfDay, weekdays }: FactoryIntakeSchedule,
  resolve: MessageResolver = m,
): string {
  const days = new Set(weekdays);
  if (days.size === 0 || days.size === 7)
    return resolve(msg("Every day {time}", { time: timeOfDay }));
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day)))
    return resolve(msg("Weekdays {time}", { time: timeOfDay }));
  const names = WEEKDAYS.filter(({ day }) => days.has(day)).map(({ plural }) => resolve(plural));
  return resolve(msg("{names} {time}", { names: names.join(", "), time: timeOfDay }));
}

export function sourceDetail(source: FactoryIntakeSource, resolve: MessageResolver = m): string {
  return source.config.kind === "schedule"
    ? scheduleText(source.config.schedule, resolve)
    : source.detail;
}

export function sourceStatusText(
  source: FactoryIntakeSource,
  resolve: MessageResolver = m,
): string | null {
  if (source.status === "unavailable")
    return resolve(msg("This server can't read this project's issues"));
  if (source.status === "failed") return resolve(msg("The last check failed"));
  return null;
}

function typePlural(type: FactoryTaskType, resolve: MessageResolver = m): string {
  const word = resolve(TASK_TYPE_LABELS[type]).toLowerCase();
  return word.endsWith("s") || type === "research" ? word : `${word}s`;
}

/** `used for bugs and features`, from the task types Auto hands to a profile. */
export function handlesText(
  handles: readonly FactoryTaskType[],
  resolve: MessageResolver = m,
): string | null {
  const words = TASK_TYPES.filter((type) => handles.includes(type)).map((type) =>
    typePlural(type, resolve),
  );
  if (words.length === 0) return null;
  const list =
    words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
  return resolve(msg("used for {list}", { list }));
}

export function plural(
  count: number,
  unit: "issue" | "item",
  resolve: MessageResolver = m,
): string {
  return resolve(
    unit === "issue"
      ? msg("{count, plural, one {{count} issue} other {{count} issues}}", { count })
      : msg("{count, plural, one {{count} item} other {{count} items}}", { count }),
  );
}

/** The reason and current version a refused command carries, when it is a task or intake error. */
export function readRefusal(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const failure = squashAtomCommandFailure(result);
  if (typeof failure !== "object" || failure === null)
    return { reason: null, currentVersion: null };
  return {
    reason: "reason" in failure && typeof failure.reason === "string" ? failure.reason : null,
    currentVersion:
      "currentVersion" in failure && typeof failure.currentVersion === "number"
        ? failure.currentVersion
        : null,
  };
}

/** A refusal in plain words. `thing` names what was being saved, such as `rule`. */
export function refusalText(
  reason: string | null,
  thing: string,
  resolve: MessageResolver = m,
): string {
  switch (reason) {
    case "autonomy-not-allowed":
      return resolve(EVERY_START_NEEDS_A_PERSON);
    case "name-taken":
      return resolve(msg("Another {thing} already has this name.", { thing }));
    case "forbidden":
      return resolve(
        msg("You don't have permission to change this {thing} on this machine.", {
          thing,
        }),
      );
    case "missing-project":
      return resolve(msg("That project is no longer on this machine."));
    case "missing-source":
      return resolve(msg("That source was deleted."));
    case "missing-rule":
    case "missing-profile":
      return resolve(msg("This {thing} was deleted.", { thing }));
    case "source-unavailable":
      return resolve(msg("This server can't read that project's issues."));
    case "invalid-input":
      return resolve(msg("Check the {thing}'s fields and try again.", { thing }));
    default:
      return resolve(msg("Couldn't save the {thing}. Try again.", { thing }));
  }
}
