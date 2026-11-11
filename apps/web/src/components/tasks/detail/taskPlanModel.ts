import type { FactoryTaskPlanProposal } from "@t3tools/contracts";

export type PlanDraftItem = FactoryTaskPlanProposal["items"][number];

const MAX_ITEMS = 32;
const MAX_AFTER = 16;
const MAX_TITLE = 512;
const MAX_DESCRIPTION = 8000;

/** `First`, or the numbers of the items this one comes after, such as `After 1, 3`. */
export function planOrderNote(item: PlanDraftItem, items: readonly PlanDraftItem[]): string {
  if (item.after.length === 0) return "First";
  const numbers = item.after.map((key) => {
    const index = items.findIndex((candidate) => candidate.key === key);
    return index === -1 ? "a removed sub-task" : String(index + 1);
  });
  return `After ${numbers.join(", ")}`;
}

/** Why the plan cannot be saved as it is, or null when it can. Items are numbered from 1. */
export function planProblem(items: readonly PlanDraftItem[]): string | null {
  if (items.length === 0) return "A plan needs at least one sub-task.";
  if (items.length > MAX_ITEMS) return `A plan holds at most ${MAX_ITEMS} sub-tasks.`;
  const keys = new Set(items.map((item) => item.key));
  for (const [index, item] of items.entries()) {
    const number = index + 1;
    const title = item.title.trim();
    if (title.length === 0) return `Sub-task ${number} needs a title.`;
    if (title.length > MAX_TITLE)
      return `Sub-task ${number} has a title longer than ${MAX_TITLE} characters.`;
    if (item.description.length > MAX_DESCRIPTION)
      return `Sub-task ${number} has a description longer than ${MAX_DESCRIPTION} characters.`;
    if (item.after.length > MAX_AFTER)
      return `Sub-task ${number} comes after more than ${MAX_AFTER} sub-tasks.`;
    if (item.after.some((key) => !keys.has(key)))
      return `Sub-task ${number} comes after a sub-task that was removed.`;
  }
  const cycle = findCycle(items);
  return cycle === null
    ? null
    : `Sub-tasks ${cycle.map((index) => index + 1).join(", ")} each wait on another, so none can start.`;
}

/** Positions of the items in one ordering loop, in the order they wait on each other. */
function findCycle(items: readonly PlanDraftItem[]): number[] | null {
  const indexOf = new Map(items.map((item, index) => [item.key, index]));
  const state = items.map(() => "new" as "new" | "open" | "done");
  const path: number[] = [];
  const visit = (index: number): number[] | null => {
    state[index] = "open";
    path.push(index);
    for (const key of items[index]?.after ?? []) {
      const next = indexOf.get(key);
      if (next === undefined) continue;
      if (state[next] === "open") return path.slice(path.indexOf(next));
      if (state[next] === "new") {
        const found = visit(next);
        if (found) return found;
      }
    }
    path.pop();
    state[index] = "done";
    return null;
  };
  for (const index of items.keys()) {
    if (state[index] !== "new") continue;
    const found = visit(index);
    if (found) return found;
  }
  return null;
}

/** The items as the server takes them: titles trimmed. */
export function planForSave(items: readonly PlanDraftItem[]): PlanDraftItem[] {
  return items.map((item) => ({ ...item, title: item.title.trim() }));
}
