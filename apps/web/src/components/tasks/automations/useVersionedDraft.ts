import { useState } from "react";

/**
 * What a person typed into a sheet over the item as they opened it. After a version conflict it
 * waits for the newer item from the live list, then rebases: a field the person changed stays
 * theirs unless the newer item changed it too, in which case the newer value wins.
 */
export function useVersionedDraft<T extends { readonly version: number }, F extends object>(
  live: T | undefined,
  fields: (item: T) => F,
  empty: F,
) {
  const [seen, setSeen] = useState(live);
  const [edits, setEdits] = useState<Partial<F>>({});
  const [reloadFrom, setReloadFrom] = useState<number | null>(null);
  const [reloaded, setReloaded] = useState(false);
  if (
    reloadFrom !== null &&
    live !== undefined &&
    seen !== undefined &&
    live.version >= reloadFrom &&
    live.version !== seen.version
  ) {
    const before = fields(seen);
    const after = fields(live);
    const kept: Partial<F> = {};
    for (const key of Object.keys(edits) as (keyof F)[]) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) kept[key] = edits[key];
    }
    setSeen(live);
    setEdits(kept);
    setReloadFrom(null);
    setReloaded(true);
  }
  const values: F = { ...(seen === undefined ? empty : fields(seen)), ...edits };
  return {
    values,
    item: seen,
    reloading: reloadFrom !== null,
    reloaded,
    set<K extends keyof F>(key: K, value: F[K]) {
      setEdits((current) => ({ ...current, [key]: value }));
    },
    conflict(currentVersion: number | null) {
      if (seen !== undefined) setReloadFrom(currentVersion ?? seen.version + 1);
    },
  };
}
