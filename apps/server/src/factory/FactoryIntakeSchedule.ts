import type { FactoryIntakeSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

// Slots are wall-clock times in the environment's own zone.
const slotOnDay = (schedule: FactoryIntakeSchedule, fromMs: number, dayOffset: number) => {
  const hour = Number(schedule.timeOfDay.slice(0, 2));
  const minute = Number(schedule.timeOfDay.slice(3, 5));
  const from = DateTime.makeZonedUnsafe(fromMs, { timeZone: DateTime.zoneMakeLocal() });
  const slot = DateTime.setParts(DateTime.add(from, { days: dayOffset }), {
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  return schedule.weekdays.length === 0 ||
    schedule.weekdays.includes(DateTime.toParts(slot).weekDay)
    ? DateTime.toEpochMillis(slot)
    : null;
};

/** The first slot strictly after `fromMs`. */
export function nextSlotAfter(schedule: FactoryIntakeSchedule, fromMs: number): number {
  for (let offset = 0; offset <= 8; offset += 1) {
    const slot = slotOnDay(schedule, fromMs, offset);
    if (slot !== null && slot > fromMs) return slot;
  }
  throw new Error("A schedule always has a slot within eight days.");
}

/** The latest slot at or before `atMs`. */
export function latestSlotAtOrBefore(schedule: FactoryIntakeSchedule, atMs: number): number {
  for (let offset = 0; offset >= -8; offset -= 1) {
    const slot = slotOnDay(schedule, atMs, offset);
    if (slot !== null && slot <= atMs) return slot;
  }
  throw new Error("A schedule always has a slot within eight days.");
}
