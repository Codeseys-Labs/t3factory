import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  applyFactoryTasksUpdate,
  type EnvironmentId,
  FACTORY_WS_METHODS,
  type FactorySignalCandidate,
  type FactoryTasksSnapshot,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { useGT, useMessages } from "gt-react";
import { useContext } from "react";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { useProject } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { decisionInput, type SignalDecisionLock, signalDecisionWaits } from "./signals.logic";

export const factoryTasksLive = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:factory:tasks:live",
  tag: FACTORY_WS_METHODS.factoryTasksSubscribe,
  transform: (stream) =>
    stream.pipe(
      Stream.mapAccum(
        (): FactoryTasksSnapshot | undefined => undefined,
        (snapshot, update) => {
          const next = applyFactoryTasksUpdate(snapshot, update);
          return [next, [next]] as const;
        },
      ),
    ),
});

export const factoryTaskDetail = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:factory:tasks:get",
  tag: FACTORY_WS_METHODS.factoryTasksGet,
  // Read again when the task's entry changes, or its latest run or one of that run's parts moves:
  // a run that ends writes only a note, and a part's review round only its record, neither of
  // which changes the entry.
  refreshTrigger: ({ environmentId, input }) => {
    const live = factoryTasksLive({ environmentId, input: {} });
    const config = serverEnvironment.configValueAtom(environmentId);
    const workflows = serverEnvironment.workflowsLive({ environmentId, input: {} });
    return Atom.make((get) => {
      const task = Option.getOrUndefined(AsyncResult.value(get(live)))?.tasks.find(
        (candidate) => candidate.id === input.taskId,
      );
      if (task === undefined) return undefined;
      const runId = task.attempt?.runId ?? null;
      const runs =
        runId === null || get(config)?.settings.workflowsEnabled !== true
          ? []
          : (Option.getOrUndefined(AsyncResult.value(get(workflows)))?.runs ?? []);
      const moved = runs
        .filter((candidate) => candidate.runId === runId || candidate.parentRunId === runId)
        .map((candidate) => `${candidate.runId} ${candidate.status} ${candidate.updatedAt}`)
        .join(" ");
      return `${task.rev} ${task.updatedAt} ${moved}`;
    });
  },
});

export const createFactoryTask = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:factory:tasks:create",
  tag: FACTORY_WS_METHODS.factoryTasksCreate,
});

export const updateFactoryTask = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:factory:tasks:update",
  tag: FACTORY_WS_METHODS.factoryTasksUpdate,
});

export const startFactoryTask = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:factory:tasks:start",
  tag: FACTORY_WS_METHODS.factoryTasksStart,
  // One start of a task at a time, so a double click does not start it twice.
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) => JSON.stringify([environmentId, input.taskId]),
  },
});

// Moved by every successful feed or decision command of an environment. Both list views read it,
// so one on screen is read again at once and one off screen when it is next shown.
const signalListsRevision = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`factory:signals:revision:${environmentId}`)),
);

/** The followed feeds and one view of their candidates, read again each minute while shown. */
export const factorySignalsList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:factory:signals:list",
  tag: FACTORY_WS_METHODS.factorySignalsList,
  refreshIntervalMs: 60_000,
  refreshTrigger: ({ environmentId }) => signalListsRevision(environmentId),
});

// A decision or a feed change moves rows between the views, so both are read again.
const refreshSignalLists = (
  { environmentId }: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.sync(() => {
    const revision = signalListsRevision(environmentId);
    registry.set(revision, registry.get(revision) + 1);
  });

export const addSignalFeed = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:factory:signals:feeds:add",
  tag: FACTORY_WS_METHODS.factorySignalFeedsAdd,
  onSuccess: refreshSignalLists,
});

export const removeSignalFeed = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:factory:signals:feeds:remove",
  tag: FACTORY_WS_METHODS.factorySignalFeedsRemove,
  onSuccess: refreshSignalLists,
});

/** The key of one candidate's decisions, in the command scheduler and in `signalDecisionLocks`. */
export const signalDecisionKey = (environmentId: EnvironmentId, candidateId: string) =>
  JSON.stringify([environmentId, candidateId]);

// One decision on a candidate at a time, so a double click sends it once.
const signalDecision = {
  mode: "singleFlight",
  key: ({
    environmentId,
    input,
  }: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly candidateId: string };
  }) => signalDecisionKey(environmentId, input.candidateId),
} as const;

export const admitSignal = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:factory:signals:admit",
  tag: FACTORY_WS_METHODS.factorySignalsAdmit,
  concurrency: signalDecision,
  onSuccess: refreshSignalLists,
});

export const dismissSignal = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:factory:signals:dismiss",
  tag: FACTORY_WS_METHODS.factorySignalsDismiss,
  concurrency: signalDecision,
  onSuccess: refreshSignalLists,
});

// Kept alive and outside the dialog: a decision outlives the dialog it was made in, and the dialog
// opened again must not offer the other decision while the first runs or is not yet read back.
export const signalDecisionLocks = Atom.make<ReadonlyMap<string, SignalDecisionLock>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("factory:signals:decisions"));

/**
 * Admit and Dismiss of a candidate, one decision at a time whichever is asked: while one runs, or
 * once one succeeded and the list still shows the candidate as it was decided on, another sends
 * nothing and answers null.
 */
export function useSignalDecisions() {
  const registry = useContext(RegistryContext);
  const admit = useAtomCommand(admitSignal, {
    label: "factory signal admit",
    reportFailure: false,
  });
  const dismiss = useAtomCommand(dismissSignal, {
    label: "factory signal dismiss",
    reportFailure: false,
  });
  const decide = async <A, E>(
    environmentId: EnvironmentId,
    candidate: FactorySignalCandidate,
    run: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<AtomCommandResult<A, E> | null> => {
    const key = signalDecisionKey(environmentId, candidate.id);
    const lock = (next: SignalDecisionLock | null) => {
      const locks = new Map(registry.get(signalDecisionLocks));
      if (next === null) locks.delete(key);
      else locks.set(key, next);
      registry.set(signalDecisionLocks, locks);
    };
    if (signalDecisionWaits(registry.get(signalDecisionLocks).get(key), candidate)) return null;
    lock({ phase: "running" });
    const result = await run();
    // A success keeps the buttons waiting until the list shows the candidate as decided.
    lock(
      result._tag === "Success"
        ? { phase: "decided", revision: candidate.revision, state: candidate.state }
        : null,
    );
    return result;
  };
  return {
    admit: (environmentId: EnvironmentId, candidate: FactorySignalCandidate) =>
      decide(environmentId, candidate, () =>
        admit({ environmentId, input: decisionInput(candidate) }),
      ),
    dismiss: (environmentId: EnvironmentId, candidate: FactorySignalCandidate) =>
      decide(environmentId, candidate, () =>
        dismiss({ environmentId, input: decisionInput(candidate) }),
      ),
  };
}

/** The Needs you item a Work panel was opened from, and the item keys then, to return focus to. */
export interface WorkTriage {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly key: string;
  readonly keys: ReadonlyArray<string>;
}

// Kept alive: the command palette sets it before Work has mounted to read it.
export const workTriage = Atom.make<WorkTriage | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("factory:work:triage"),
);

const setFactoryOrchestrator = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:factory:orchestrator:set",
  tag: FACTORY_WS_METHODS.factoryOrchestratorSet,
});

/**
 * Makes the open thread its project's Orchestrator, for the command palette. Null while there is
 * no such thread to offer: none open, one in no project, or no permission to set it.
 */
export function useMakeThreadOrchestrator(
  thread:
    | {
        readonly environmentId: EnvironmentId;
        readonly id: ThreadId;
        readonly projectId: ProjectId;
      }
    | null
    | undefined,
): (() => Promise<void>) | null {
  const gt = useGT();
  const m = useMessages();
  const project = useProject(
    thread == null ? null : scopeProjectRef(thread.environmentId, thread.projectId),
  );
  const allowed = useAtomValue(
    setFactoryOrchestrator.permissionAtom(thread?.environmentId ?? null),
  );
  const set = useAtomCommand(setFactoryOrchestrator, {
    label: "factory orchestrator set",
    reportFailure: false,
  });
  if (thread == null || project === null || project.isScratch === true || !allowed) return null;
  const { environmentId, id: threadId, projectId } = thread;
  const projectTitle = project.title;
  return async () => {
    const result = await set({ environmentId, input: { projectId, threadId } });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("This thread is now the Orchestrator for {project}", { project: projectTitle }),
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title: gt("Could not make this thread the Orchestrator"),
      description:
        errorDisplayMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
    });
  };
}
