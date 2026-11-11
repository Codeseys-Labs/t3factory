import { WS_METHODS, type EnvironmentId, type FactoryTaskChange } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import {
  createFactoryTaskReadGuard,
  EMPTY_FACTORY_TASK_REFRESH,
  factoryTaskRefreshVersion,
  reduceFactoryTaskRefresh,
} from "./factoryTaskRefresh.ts";
export type { FactoryTaskRefreshState } from "./factoryTaskRefresh.ts";

export function createFactoryTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const guard = createFactoryTaskReadGuard(runtime);
  const local = Atom.family((_id: EnvironmentId) => Atom.make(EMPTY_FACTORY_TASK_REFRESH));
  const displayRoots = Atom.family((_id: EnvironmentId) =>
    Atom.family((_displayId: string) => Atom.make<string | null>(null)),
  );
  const subscribeTaskChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    tag: WS_METHODS.factorySubscribeTaskChanges,

    label: "factory-tasks:changes",
    idleTtlMs: 0,
    transform: (stream) =>
      stream.pipe(Stream.scan(() => EMPTY_FACTORY_TASK_REFRESH, reduceFactoryTaskRefresh)),
  });
  const signals = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((scope: string) =>
      Atom.make((get) => {
        const remote = AsyncResult.getOrElse(
          get(subscribeTaskChanges({ environmentId, input: {} })),
          () => EMPTY_FACTORY_TASK_REFRESH,
        );
        const key = scope === "list" || scope === "profiles" ? scope : { rootId: scope.slice(5) };
        return `${factoryTaskRefreshVersion(remote, key)}:${factoryTaskRefreshVersion(get(local(environmentId)), key)}`;
      }),
    ),
  );
  const invalidate = (registry: AtomRegistry.AtomRegistry, change: FactoryTaskChange) =>
    registry.set(
      local(change.environmentId),
      reduceFactoryTaskRefresh(registry.get(local(change.environmentId)), change),
    );
  const listTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    signals(environmentId)("list");
  const displaySignal = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((displayId: string) =>
      Atom.make((get) => {
        const rootId = get(displayRoots(environmentId)(displayId));
        return get(signals(environmentId)(rootId === null ? "list" : `root:${rootId}`));
      }),
    ),
  );
  const rootTrigger = ({
    environmentId,
    input,
  }: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly ref: { readonly rootId: string } };
  }) => signals(environmentId)(`root:${input.ref.rootId}`);
  const refreshRoot = (
    {
      environmentId,
      input,
    }: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly ref: { readonly rootId: string } };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      invalidate(registry, { environmentId, rootIds: [input.ref.rootId], profiles: false }),
    );
  const refreshCreated = (
    {
      environmentId,
      input,
    }: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly parent?: { readonly rootId: string } | undefined };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      if (input.parent)
        invalidate(registry, { environmentId, rootIds: [input.parent.rootId], profiles: false });
      else {
        const state = registry.get(local(environmentId));
        registry.set(local(environmentId), { ...state, revision: state.revision + 1 });
      }
    });
  const refreshProfiles = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => invalidate(registry, { environmentId, rootIds: [], profiles: true }));
  return {
    subscribeTaskChanges,
    invalidate,
    listTasks: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-tasks:list",
        tag: WS_METHODS.factoryListTasks,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: listTrigger,
      }),
    ),
    countTasks: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-tasks:counts",
        tag: WS_METHODS.factoryCountTasks,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: listTrigger,
      }),
    ),
    listTaskAssignees: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-tasks:assignees",
        tag: WS_METHODS.factoryListTaskAssignees,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: listTrigger,
      }),
    ),
    readTask: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-tasks:detail",
        tag: WS_METHODS.factoryReadTask,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: ({ environmentId, input }) =>
          "ref" in input.task
            ? signals(environmentId)(`root:${input.task.ref.rootId}`)
            : displaySignal(environmentId)(input.task.displayId),
        onAnswer: ({ environmentId }, detail, registry) =>
          Effect.sync(() => {
            const atom = displayRoots(environmentId)(detail.task.displayId);
            if (registry.get(atom) !== detail.task.ref.rootId)
              registry.set(atom, detail.task.ref.rootId);
          }),
      }),
    ),
    readTaskResult: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-tasks:result",
        tag: WS_METHODS.factoryReadTaskResult,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: rootTrigger,
      }),
    ),
    readTaskActivity: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-tasks:activity",
        tag: WS_METHODS.factoryReadTaskActivity,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: rootTrigger,
      }),
    ),
    readTaskPlanProposal: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-tasks:plan",
        tag: WS_METHODS.factoryReadTaskPlanProposal,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: rootTrigger,
      }),
    ),
    findTaskByThread: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-tasks:by-thread",
        tag: WS_METHODS.factoryFindTaskByThread,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: listTrigger,
      }),
    ),
    listAgentProfiles: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-tasks:profiles",
        tag: WS_METHODS.factoryListAgentProfiles,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: ({ environmentId }) => signals(environmentId)("profiles"),
      }),
    ),
    previewTaskAssignee: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-tasks:assignee-preview",
        tag: WS_METHODS.factoryPreviewTaskAssignee,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: ({ environmentId, input }) =>
          signals(environmentId)(input.parent ? `root:${input.parent.rootId}` : "profiles"),
      }),
    ),
    createTask: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:create",
      tag: WS_METHODS.factoryCreateTask,
      onSettled: refreshCreated,
    }),
    updateTask: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:update",
      tag: WS_METHODS.factoryUpdateTask,
      onSettled: refreshRoot,
    }),
    startTask: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:start",
      tag: WS_METHODS.factoryStartTask,
      onSettled: refreshRoot,
    }),
    stopTask: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:stop",
      tag: WS_METHODS.factoryStopTask,
      onSettled: refreshRoot,
    }),
    retryTask: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:retry",
      tag: WS_METHODS.factoryRetryTask,
      onSettled: refreshRoot,
    }),
    acceptTaskResult: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:accept",
      tag: WS_METHODS.factoryAcceptTaskResult,
      onSettled: refreshRoot,
    }),
    requestTaskChanges: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:request-changes",
      tag: WS_METHODS.factoryRequestTaskChanges,
      onSettled: refreshRoot,
    }),
    reopenTask: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:reopen",
      tag: WS_METHODS.factoryReopenTask,
      onSettled: refreshRoot,
    }),
    publishTaskResult: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:publish",
      tag: WS_METHODS.factoryPublishTaskResult,
      onSettled: refreshRoot,
    }),
    mergeTaskResult: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:merge",
      tag: WS_METHODS.factoryMergeTaskResult,
      onSettled: refreshRoot,
    }),
    checkTaskResult: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:check",
      tag: WS_METHODS.factoryCheckTaskResult,
      onSettled: refreshRoot,
    }),
    addTaskComment: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:comment",
      tag: WS_METHODS.factoryAddTaskComment,
      onSettled: refreshRoot,
    }),
    saveAgentProfile: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:save-profile",
      tag: WS_METHODS.factorySaveAgentProfile,
      onSettled: refreshProfiles,
    }),
    deleteAgentProfile: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:delete-profile",
      tag: WS_METHODS.factoryDeleteAgentProfile,
      onSettled: refreshProfiles,
    }),
    requestTaskBreakdown: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:breakdown",
      tag: WS_METHODS.factoryRequestTaskBreakdown,
      onSettled: refreshRoot,
    }),
    updateTaskPlanProposal: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:edit-plan",
      tag: WS_METHODS.factoryUpdateTaskPlanProposal,
      onSettled: refreshRoot,
    }),
    resolveTaskPlanProposal: createEnvironmentRpcCommand(runtime, {
      label: "factory-tasks:resolve-plan",
      tag: WS_METHODS.factoryResolveTaskPlanProposal,
      onSettled: refreshRoot,
    }),
  };
}
