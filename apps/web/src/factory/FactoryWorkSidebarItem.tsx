import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, FactoryTaskSummary } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { KanbanIcon } from "lucide-react";
import { useEffect } from "react";

import { Badge } from "../components/ui/badge";
import { useWorkflowEnvironmentIds } from "../components/workflows/useWorkflowEnvironmentIds";
import { environmentSummaries } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { factoryTasksLive } from "./state";
import { type AttentionItem, deriveWorkCards, selectAttentionItems } from "./workBoard.logic";
import { combineAttentionCounts } from "./workDetail.logic";

// The environment Work showed this session. The sidebar and palette follow Factory lists only once
// Work has opened one, so a session that never opens Work subscribes to nothing more.
const workEnvironment = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("factory:work:environment"),
);

/** Remembers the environment Work shows, for the sidebar's count and the palette's task rows. */
export function useRememberWorkEnvironment(environmentId: EnvironmentId | null) {
  const remember = useAtomSet(workEnvironment);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the environment Work shows to the sidebar and palette, which follow the lists Work opened instead of opening their own
  useEffect(() => {
    if (environmentId !== null) remember(environmentId);
  }, [environmentId, remember]);
}

interface WorkAttention {
  readonly environmentId: EnvironmentId;
  readonly tasks: ReadonlyArray<FactoryTaskSummary>;
  readonly items: ReadonlyArray<AttentionItem>;
  /** Task records were cut off or unreadable, so more may wait than `items` holds. */
  readonly partial: boolean;
}

const NO_WORK_ATTENTION = Atom.make<WorkAttention | null>(null).pipe(
  Atom.withLabel("factory:work:attention:none"),
);

const workAttention = Atom.family((environmentId: EnvironmentId) => {
  const tasks = factoryTasksLive({ environmentId, input: {} });
  const workflows = serverEnvironment.workflowsLive({ environmentId, input: {} });
  return Atom.make((get): WorkAttention | null => {
    const taskResult = get(tasks);
    const runResult = get(workflows);
    // Loading, refused or disconnected: neither list can say how much waits.
    if (taskResult._tag !== "Success" || runResult._tag !== "Success") return null;
    const { runs, questions } = runResult.value;
    const snapshot = taskResult.value;
    return {
      environmentId,
      tasks: snapshot.tasks,
      items: selectAttentionItems({
        cards: deriveWorkCards({ tasks: snapshot.tasks, runs, questions }),
        runs,
        questions,
      }),
      partial: snapshot.truncated || snapshot.damaged > 0,
    };
  }).pipe(Atom.withLabel(`factory:work:attention:${environmentId}`));
});

/** What waits on the person in the environment Work last showed, while it has workflows on. */
export function useWorkAttentionAtom() {
  const remembered = useAtomValue(workEnvironment);
  const workflowIds = useWorkflowEnvironmentIds();
  return remembered !== null && workflowIds.includes(remembered)
    ? workAttention(remembered)
    : NO_WORK_ATTENTION;
}

/**
 * The Needs you count over every enabled environment, once Work has opened this session. One that
 * is away, has workflows off, refuses or has not sent its lists, or whose task list is cut off or
 * unreadable in part, counts as unknown.
 */
const combinedAttention = Atom.make((get) => {
  if (get(workEnvironment) === null) return null;
  const counts = get(environmentSummaries.environmentsAtom)
    .filter((environment) => environment.isEnabled)
    .map(({ environmentId, connectionState }) => {
      if (
        connectionState !== "connected" ||
        get(serverEnvironment.configValueAtom(environmentId))?.settings.workflowsEnabled !== true
      ) {
        return null;
      }
      const attention = get(workAttention(environmentId));
      return attention === null || attention.partial ? null : attention.items.length;
    });
  return combineAttentionCounts(counts);
}).pipe(Atom.withLabel("factory:work:attention:combined"));

// Selectors keep one identity, so the sidebar re-renders only when what it shows changes.
const attentionTotal = (attention: { readonly total: number } | null) => attention?.total ?? 0;
const attentionAtLeast = (attention: { readonly atLeast: boolean } | null) =>
  attention?.atLeast === true;

export function useFactoryWorkSidebarItem(onOpen: () => void) {
  const gt = useGT();
  const navigate = useNavigate();
  const count = useAtomValue(combinedAttention, attentionTotal);
  const atLeast = useAtomValue(combinedAttention, attentionAtLeast);
  const environmentId = useAtomValue(workEnvironment);
  return {
    icon:
      count === 0 ? (
        <KanbanIcon />
      ) : (
        <>
          <KanbanIcon />
          <Badge aria-hidden size="sm" className="absolute -end-0.5 -top-0.5">
            {atLeast
              ? gt("{count}+", {
                  count,
                  $context: "a small badge: at least this many items need the user",
                })
              : count}
          </Badge>
        </>
      ),
    label:
      count === 0
        ? atLeast
          ? gt("Work, some environments could not be counted", {
              $context:
                "sidebar link to the board of tasks; how many items need the user is unknown",
            })
          : gt("Work", { $context: "sidebar link to the board of tasks" })
        : atLeast
          ? gt(
              "{count, plural, one {Work, at least {count} item needs you} other {Work, at least {count} items need you}}",
              { count },
            )
          : gt(
              "{count, plural, one {Work, {count} item needs you} other {Work, {count} items need you}}",
              { count },
            ),
    onClick: () => {
      onOpen();
      void navigate({ to: "/work", search: environmentId === null ? {} : { env: environmentId } });
    },
  };
}
