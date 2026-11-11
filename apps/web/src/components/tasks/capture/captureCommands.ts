import { RegistryContext } from "@effect/atom-react";
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
  type FactoryTaskCreateInput,
  type FactoryTaskMutationResult,
  type FactoryTaskSummary,
  type FactoryTaskUpdateInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useContext } from "react";

import { randomUUID } from "~/lib/utils";
import { factoryTasks } from "../../../state/factoryTasks";
import { taskErrorMessage } from "../shared/taskErrors";

const isTaskError = Schema.is(FactoryTaskError);
const commandId = () => CommandId.make(randomUUID());

export type CommandOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string; readonly conflict: boolean };

type TaskContext = Parameters<typeof taskErrorMessage>[1];

/**
 * The commands the capture dialogs send. Each call mints a fresh command id and reports a refusal
 * as a sentence for the dialog to show, since a dialog keeps what the person typed.
 */
export function useCaptureCommands() {
  const registry = useContext(RegistryContext);
  const run = async <I, A, E>(
    command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
    environmentId: EnvironmentId,
    input: I,
    context: TaskContext = {},
  ): Promise<CommandOutcome<A>> => {
    const result = await runAtomCommand(
      registry,
      command,
      { environmentId, input },
      { reportFailure: false },
    );
    if (result._tag === "Success") return { ok: true, value: result.value };
    const error = squashAtomCommandFailure(result);
    return {
      ok: false,
      message: taskErrorMessage(error, context),
      conflict: isTaskError(error) && error.reason === "version-conflict",
    };
  };

  return {
    create: (environmentId: EnvironmentId, input: Omit<FactoryTaskCreateInput, "commandId">) =>
      run<FactoryTaskCreateInput, FactoryTaskMutationResult, unknown>(
        factoryTasks.createTask,
        environmentId,
        { commandId: commandId(), ...input },
      ),
    updateAssignment: (
      task: FactoryTaskSummary,
      assignment: FactoryTaskUpdateInput["assignment"],
    ) =>
      run(
        factoryTasks.updateTask,
        task.ref.environmentId,
        { commandId: commandId(), ref: task.ref, expectedVersion: task.version, assignment },
        { task },
      ),
    start: (task: FactoryTaskSummary, setup: FactoryAgentSetup) =>
      run(
        factoryTasks.startTask,
        task.ref.environmentId,
        { commandId: commandId(), ref: task.ref, expectedVersion: task.version, setup },
        { task },
      ),
    retry: (task: FactoryTaskSummary, setup: FactoryAgentSetup) =>
      run(
        factoryTasks.retryTask,
        task.ref.environmentId,
        { commandId: commandId(), ref: task.ref, expectedVersion: task.version, setup },
        { task },
      ),
    requestBreakdown: (task: FactoryTaskSummary, setup: FactoryAgentSetup) =>
      run(
        factoryTasks.requestTaskBreakdown,
        task.ref.environmentId,
        { commandId: commandId(), ref: task.ref, expectedVersion: task.version, setup },
        { task },
      ),
  };
}
