import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type FactoryAgentSetup,
  FactoryTaskError,
  type FactoryTaskLane,
  type FactoryTaskRef,
  type FactoryTaskSummary,
  type FactoryTaskUpdateInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useContext } from "react";

import { randomUUID } from "~/lib/utils";
import { factoryTasks } from "../../../state/factoryTasks";
import { toastManager } from "../../ui/toast";
import { taskErrorMessage } from "./taskErrors";

const isTaskError = Schema.is(FactoryTaskError);
const commandId = () => CommandId.make(randomUUID());

export type TaskUpdate = Omit<FactoryTaskUpdateInput, "commandId" | "ref" | "expectedVersion">;
type TaskContext = Parameters<typeof taskErrorMessage>[1];

/**
 * The task commands every screen shares. Each call mints a fresh command id, and a refusal shows
 * its sentence in a toast. Resolves to the command's value, or null when it was refused.
 */
export function useTaskActions() {
  const registry = useContext(RegistryContext);
  const run = async <I, A, E>(
    command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
    environmentId: EnvironmentId,
    input: I,
    context: TaskContext,
    retryInput?: (currentVersion: number) => I,
  ): Promise<A | null> => {
    let result = await runAtomCommand(
      registry,
      command,
      { environmentId, input },
      { reportFailure: false },
    );
    if (result._tag === "Failure" && retryInput) {
      const error = squashAtomCommandFailure(result);
      if (
        isTaskError(error) &&
        error.reason === "version-conflict" &&
        error.currentVersion !== undefined
      )
        result = await runAtomCommand(
          registry,
          command,
          { environmentId, input: retryInput(error.currentVersion) },
          { reportFailure: false },
        );
    }
    if (result._tag === "Success") return result.value;
    toastManager.add({
      type: "error",
      title: taskErrorMessage(squashAtomCommandFailure(result), context),
    });
    return null;
  };

  const update = (task: FactoryTaskSummary, change: TaskUpdate) =>
    run(
      factoryTasks.updateTask,
      task.ref.environmentId,
      { ...change, commandId: commandId(), ref: task.ref, expectedVersion: task.version },
      { task },
      (currentVersion) => ({
        ...change,
        commandId: commandId(),
        ref: task.ref,
        expectedVersion: currentVersion,
      }),
    );

  return {
    update,
    setLane: (task: FactoryTaskSummary, lane: FactoryTaskLane) => update(task, { lane }),
    cancel: (task: FactoryTaskSummary) => update(task, { lane: "canceled" }),
    stop: (task: FactoryTaskSummary) =>
      run(
        factoryTasks.stopTask,
        task.ref.environmentId,
        { commandId: commandId(), ref: task.ref },
        { task },
      ),
    retry: (task: FactoryTaskSummary, setup?: FactoryAgentSetup) =>
      run(
        factoryTasks.retryTask,
        task.ref.environmentId,
        {
          commandId: commandId(),
          ref: task.ref,
          expectedVersion: task.version,
          ...(setup ? { setup } : {}),
        },
        { task },
      ),
    accept: (task: FactoryTaskSummary, revision: number) =>
      run(
        factoryTasks.acceptTaskResult,
        task.ref.environmentId,
        { commandId: commandId(), ref: task.ref, revision },
        { task },
      ),
    requestChanges: (task: FactoryTaskSummary, revision: number, note: string) =>
      run(
        factoryTasks.requestTaskChanges,
        task.ref.environmentId,
        { commandId: commandId(), ref: task.ref, revision, note },
        { task },
      ),
    reopen: (task: FactoryTaskSummary) =>
      run(
        factoryTasks.reopenTask,
        task.ref.environmentId,
        { commandId: commandId(), ref: task.ref },
        { task },
      ),
    publish: (task: FactoryTaskSummary, revision: number) =>
      run(
        factoryTasks.publishTaskResult,
        task.ref.environmentId,
        { commandId: commandId(), ref: task.ref, revision },
        { task },
      ),
    merge: (task: FactoryTaskSummary, revision: number) =>
      run(
        factoryTasks.mergeTaskResult,
        task.ref.environmentId,
        { commandId: commandId(), ref: task.ref, revision },
        { task },
      ),
    check: (task: FactoryTaskSummary) =>
      run(
        factoryTasks.checkTaskResult,
        task.ref.environmentId,
        { commandId: commandId(), ref: task.ref },
        { task },
      ),
    comment: (ref: FactoryTaskRef, body: string) =>
      run(
        factoryTasks.addTaskComment,
        ref.environmentId,
        { commandId: commandId(), ref, body },
        {},
      ),
    resolvePlan: (
      task: FactoryTaskSummary,
      proposal: { readonly id: string; readonly version: number },
      action: "approve" | "dismiss",
    ) =>
      run(
        factoryTasks.resolveTaskPlanProposal,
        task.ref.environmentId,
        {
          commandId: commandId(),
          ref: task.ref,
          proposalId: proposal.id,
          expectedVersion: proposal.version,
          action,
        },
        { task },
      ),
  };
}

/** Whether this connection may run each task command in an environment. */
export function useTaskPermissions(environmentId: EnvironmentId) {
  return {
    update: useAtomValue(factoryTasks.updateTask.permissionAtom(environmentId)),
    start: useAtomValue(factoryTasks.startTask.permissionAtom(environmentId)),
    stop: useAtomValue(factoryTasks.stopTask.permissionAtom(environmentId)),
    retry: useAtomValue(factoryTasks.retryTask.permissionAtom(environmentId)),
    breakDown: useAtomValue(factoryTasks.requestTaskBreakdown.permissionAtom(environmentId)),
    accept: useAtomValue(factoryTasks.acceptTaskResult.permissionAtom(environmentId)),
    requestChanges: useAtomValue(factoryTasks.requestTaskChanges.permissionAtom(environmentId)),
    reopen: useAtomValue(factoryTasks.reopenTask.permissionAtom(environmentId)),
    publish: useAtomValue(factoryTasks.publishTaskResult.permissionAtom(environmentId)),
    merge: useAtomValue(factoryTasks.mergeTaskResult.permissionAtom(environmentId)),
    check: useAtomValue(factoryTasks.checkTaskResult.permissionAtom(environmentId)),
    resolvePlan: useAtomValue(factoryTasks.resolveTaskPlanProposal.permissionAtom(environmentId)),
  };
}
