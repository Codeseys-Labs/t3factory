import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type FactoryTaskPlanProposal,
  type FactoryTaskRun,
  type FactoryTaskSummary,
} from "@t3tools/contracts";
import { useContext } from "react";

import { newMessageId, randomUUID } from "~/lib/utils";
import { factoryTasks } from "../../../state/factoryTasks";
import { threadEnvironment } from "../../../state/threads";
import { useOrchestrationCommand } from "../../../state/use-orchestration-command";
import { toastManager } from "../../ui/toast";
import { taskErrorMessage } from "../shared";
import type { PlanDraftItem } from "./taskPlanModel";

/**
 * The task page's own commands: saving an edited plan, and a message to the run's agent through
 * the thread's own send. Each resolves to whether it went through; a refusal shows a toast.
 */
export function useTaskDetailCommands() {
  const registry = useContext(RegistryContext);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });

  const savePlan = async (
    task: FactoryTaskSummary,
    proposal: Pick<FactoryTaskPlanProposal, "id" | "version">,
    items: readonly PlanDraftItem[],
  ) => {
    const result = await runAtomCommand(
      registry,
      factoryTasks.updateTaskPlanProposal,
      {
        environmentId: task.ref.environmentId,
        input: {
          commandId: CommandId.make(randomUUID()),
          ref: task.ref,
          proposalId: proposal.id,
          expectedVersion: proposal.version,
          items,
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Success") return true;
    toastManager.add({
      type: "error",
      title: taskErrorMessage(squashAtomCommandFailure(result), { task }),
    });
    return false;
  };

  const messageAgent = async (task: FactoryTaskSummary, run: FactoryTaskRun, text: string) => {
    const result = await startTurn({
      environmentId: task.ref.environmentId,
      input: {
        threadId: run.threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode: run.setup.runtimeMode,
        interactionMode: run.setup.interactionMode,
        dispatchMode: "auto",
      },
    });
    if (result._tag === "Success") return true;
    toastManager.add({ type: "error", title: "Couldn't send the message. Try again." });
    return false;
  };

  return { savePlan, messageAgent };
}
