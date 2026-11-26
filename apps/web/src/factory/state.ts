import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
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
  type FactoryTasksSnapshot,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT, useMessages } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { useProject } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

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
