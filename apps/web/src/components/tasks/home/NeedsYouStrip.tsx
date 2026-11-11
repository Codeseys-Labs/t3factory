import { factoryTaskKey } from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { CountBadge } from "../kit";
import { TaskNeedsRow } from "../shared";
import { useNeedsYou } from "../shared/taskScope";

/**
 * The asks that block a run, above the board. The review asks wait in the Inbox, so they are one
 * link here. Hidden when nothing waits.
 */
export function NeedsYouStrip({
  open,
  onOpenChange,
  onPeek,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPeek: (ref: FactoryTaskRef) => void;
}) {
  const { needs, tasks } = useNeedsYou();
  if (needs.count === 0) return null;
  const byKey = new Map(tasks.map((task) => [factoryTaskKey(task.ref), task]));
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const review = needs.review.length;
  return (
    <section
      aria-label="Needs you"
      className="mx-6 mb-4 shrink-0 overflow-hidden rounded-lg border border-border"
    >
      <div className="flex h-9 min-w-0 items-center gap-2 px-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Chevron aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          Needs you
          <CountBadge count={needs.count} tone="attention" />
        </button>
        {open && review > 0 ? (
          <Link
            to="/inbox"
            className="ms-auto inline-flex items-center gap-1 rounded-sm px-1 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {needs.blocking.length > 0 ? `${review} more to review` : `${review} to review`}
            <ChevronRightIcon aria-hidden className="size-3.5" />
          </Link>
        ) : null}
      </div>
      {open && needs.blocking.length > 0 ? (
        <div className="-mb-px max-h-[13.5rem] overflow-y-auto border-border border-t">
          {needs.blocking.map((need) => (
            <TaskNeedsRow
              key={JSON.stringify([factoryTaskKey(need.ref), need.reason, need.requestId])}
              need={need}
              task={byKey.get(factoryTaskKey(need.ref)) ?? null}
              onOpen={() => onPeek(need.ref)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
