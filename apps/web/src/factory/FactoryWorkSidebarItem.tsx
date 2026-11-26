import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, FactoryTaskSummary } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { KanbanIcon } from "lucide-react";
import { useEffect } from "react";

import { Badge } from "../components/ui/badge";
import { useWorkflowEnvironmentIds } from "../components/workflows/useWorkflowEnvironmentIds";
import { serverEnvironment } from "../state/server";
import { factoryTasksLive } from "./state";
import { type AttentionItem, deriveWorkCards, selectAttentionItems } from "./workBoard.logic";

// The environment Work showed this session. The sidebar and palette follow its lists only once
// Work has opened them, so a session that never opens Work subscribes to nothing more.
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

// Selectors keep one identity, so the sidebar re-renders only when what it shows changes.
const attentionCount = (attention: WorkAttention | null) => attention?.items.length ?? 0;
const attentionPartial = (attention: WorkAttention | null) => attention?.partial === true;
const attentionEnvironment = (attention: WorkAttention | null) => attention?.environmentId ?? null;

export function useFactoryWorkSidebarItem(onOpen: () => void) {
  const gt = useGT();
  const navigate = useNavigate();
  const attention = useWorkAttentionAtom();
  const count = useAtomValue(attention, attentionCount);
  const partial = useAtomValue(attention, attentionPartial);
  const environmentId = useAtomValue(attention, attentionEnvironment);
  return {
    icon:
      count === 0 ? (
        <KanbanIcon />
      ) : (
        <>
          <KanbanIcon />
          <Badge aria-hidden size="sm" className="absolute -end-0.5 -top-0.5">
            {count}
          </Badge>
        </>
      ),
    label:
      count === 0
        ? gt("Work", { $context: "sidebar link to the board of tasks" })
        : partial
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
