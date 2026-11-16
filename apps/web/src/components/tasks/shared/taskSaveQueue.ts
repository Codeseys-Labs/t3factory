import type { FactoryTaskRef } from "@t3tools/contracts";

// Per task, not per editor: an editor that unmounts leaves its saves running, and the next editor
// for the same task must queue behind them. A task has an entry only while a save is pending.
const tails = new Map<string, Promise<void>>();

/**
 * Runs `save` after every save already queued for this task in this client, so assignment picks
 * land in the order they were chosen. A save that rejects does not hold up the ones behind it.
 */
export function queueTaskSave<A>(ref: FactoryTaskRef, save: () => Promise<A>): Promise<A> {
  const key = JSON.stringify([ref.environmentId, ref.projectId, ref.rootId, ref.taskId]);
  const run = (tails.get(key) ?? Promise.resolve()).then(save);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
