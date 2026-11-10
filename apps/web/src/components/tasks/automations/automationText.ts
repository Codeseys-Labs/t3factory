import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  FactoryIntakeAutonomy,
  FactoryIntakeSchedule,
  FactoryIntakeSource,
  FactoryTaskType,
} from "@t3tools/contracts";

import { TASK_TYPE_LABELS } from "../kit";

export const TASK_TYPES = Object.keys(TASK_TYPE_LABELS) as FactoryTaskType[];

export const AUTONOMY: Record<FactoryIntakeAutonomy, { label: string; description: string }> = {
  manual: { label: "Manual", description: "New items wait in the Inbox." },
  suggest: { label: "Suggest", description: "Fills in type and assignee; you accept." },
  "auto-start": {
    label: "Auto-start",
    description: "Creates the task and starts it. The agent runs in its profile's mode.",
  },
};

export const EVERY_START_NEEDS_A_PERSON = "Every start needs a person.";

/** Monday first, as people read a week; the values are the contract's 0 = Sunday. */
export const WEEKDAYS = [
  { day: 1, short: "Mon", plural: "Mondays" },
  { day: 2, short: "Tue", plural: "Tuesdays" },
  { day: 3, short: "Wed", plural: "Wednesdays" },
  { day: 4, short: "Thu", plural: "Thursdays" },
  { day: 5, short: "Fri", plural: "Fridays" },
  { day: 6, short: "Sat", plural: "Saturdays" },
  { day: 0, short: "Sun", plural: "Sundays" },
] as const;

function scheduleText({ timeOfDay, weekdays }: FactoryIntakeSchedule): string {
  const days = new Set(weekdays);
  if (days.size === 0 || days.size === 7) return `Every day ${timeOfDay}`;
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day)))
    return `Weekdays ${timeOfDay}`;
  const names = WEEKDAYS.filter(({ day }) => days.has(day)).map(({ plural }) => plural);
  return `${names.join(", ")} ${timeOfDay}`;
}

export function sourceDetail(source: FactoryIntakeSource): string {
  return source.config.kind === "schedule" ? scheduleText(source.config.schedule) : source.detail;
}

export function sourceStatusText(source: FactoryIntakeSource): string | null {
  if (source.status === "unavailable") return "This server can't read this project's issues";
  if (source.status === "failed") return "The last check failed";
  return null;
}

function typePlural(type: FactoryTaskType): string {
  const word = TASK_TYPE_LABELS[type].toLowerCase();
  return word.endsWith("s") || type === "research" ? word : `${word}s`;
}

/** `used for bugs and features`, from the task types Auto hands to a profile. */
export function handlesText(handles: readonly FactoryTaskType[]): string | null {
  const words = TASK_TYPES.filter((type) => handles.includes(type)).map(typePlural);
  if (words.length === 0) return null;
  const list =
    words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
  return `used for ${list}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
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
export function refusalText(reason: string | null, thing: string): string {
  switch (reason) {
    case "autonomy-not-allowed":
      return EVERY_START_NEEDS_A_PERSON;
    case "name-taken":
      return `Another ${thing} already has this name.`;
    case "forbidden":
      return `You don't have permission to change this ${thing} on this machine.`;
    case "missing-project":
      return "That project is no longer on this machine.";
    case "missing-source":
      return "That source was deleted.";
    case "missing-rule":
    case "missing-profile":
      return `This ${thing} was deleted.`;
    case "source-unavailable":
      return "This server can't read that project's issues.";
    case "invalid-input":
      return `Check the ${thing}'s fields and try again.`;
    default:
      return `Couldn't save the ${thing}. Try again.`;
  }
}
