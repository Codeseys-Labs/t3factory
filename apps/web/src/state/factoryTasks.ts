import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FactoryTaskAssigneePreviewInput,
  type FactoryTaskDisplayId,
  type FactoryTaskActivityInput,
  type FactoryTaskRef,
  type FactoryTaskSummary,
  type FactoryIntakeArrivalListInput,
  type FactoryIntakeSourceListInput,
  type FactoryIntakeRulePreviewInput,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import type { AtomCommand, AtomCommandOptions } from "@t3tools/client-runtime/state/runtime";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { Atom } from "effect/reactivity";
import { useContext } from "react";
import { createFactoryTaskEnvironmentAtoms } from "@t3tools/client-runtime/state/factory-tasks";
import { createFactoryIntakeEnvironmentAtoms } from "@t3tools/client-runtime/state/factory-intake";
import {
  createFactoryTaskListAtoms,
  factoryTaskConnectionStatus,
  type FactoryTaskListTarget,
  type FactoryTaskOwnerStatus,
} from "@t3tools/client-runtime/state/factory-task-list";
import {
  groupFactoryTaskNeeds,
  resolveFactoryTaskLiveState,
} from "@t3tools/client-runtime/state/factory-task-view";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { resolveThreadStatusPill } from "../components/Sidebar.logic";
import { environmentPresentations } from "./presentation";
import { environmentSession, sessionHasScope, useEnvironmentScope } from "./session";
import { environmentThreadDetails, environmentThreadShells, threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import { useOrchestrationCommand } from "./use-orchestration-command";

export const factoryTasks = createFactoryTaskEnvironmentAtoms(connectionAtomRuntime);
export const factoryIntake = createFactoryIntakeEnvironmentAtoms(connectionAtomRuntime);

const accessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): FactoryTaskOwnerStatus => {
    const presentation = get(environmentPresentations.presentationAtom(environmentId));
    const connection = factoryTaskConnectionStatus(
      presentation?.connection.phase,
      get(environmentCatalog.catalogValueAtom).isReady,
    );
    if (connection !== null || !presentation) return connection ?? "loading";
    if (!presentation.serverConfig) return "loading";
    const session = get(environmentSession.sessionStateAtom(environmentId));
    if (session._tag === "Initial") return "loading";
    return sessionHasScope(session, AuthOrchestrationReadScope) ? "current" : "forbidden";
  }),
);
const lists = createFactoryTaskListAtoms({
  listTasks: factoryTasks.listTasks,
  countTasks: factoryTasks.countTasks,
  accessAtom,
  changesAtom: (environmentId) => factoryTasks.subscribeTaskChanges({ environmentId, input: {} }),
});

export function useFactoryTasks(targets: readonly FactoryTaskListTarget[]) {
  const registry = useContext(RegistryContext);
  const result = useAtomValue(lists.listAtom(targets));
  return {
    ...result,
    loadMore: (environmentId: EnvironmentId) => {
      const target = targets.find((target) => target.environmentId === environmentId);
      if (target) lists.loadMore(registry, target);
    },
    refresh: () => {
      for (const target of targets) lists.refresh(registry, target);
    },
  };
}

export function useFactoryTaskDetail(ref: FactoryTaskRef) {
  return useAtomValue(
    factoryTasks.readTask({ environmentId: ref.environmentId, input: { task: { ref } } }),
  );
}
export function useFactoryTaskActivity(
  ref: FactoryTaskRef,
  page: Omit<FactoryTaskActivityInput, "ref"> = {},
) {
  return useAtomValue(
    factoryTasks.readTaskActivity({ environmentId: ref.environmentId, input: { ref, ...page } }),
  );
}
export function useFactoryTaskResult(ref: FactoryTaskRef, revision?: number) {
  return useAtomValue(
    factoryTasks.readTaskResult({
      environmentId: ref.environmentId,
      input: { ref, ...(revision === undefined ? {} : { revision }) },
    }),
  );
}
export function useFactoryTaskPlan(ref: FactoryTaskRef) {
  return useAtomValue(
    factoryTasks.readTaskPlanProposal({ environmentId: ref.environmentId, input: { ref } }),
  );
}
export function useFactoryAgentProfiles(environmentId: EnvironmentId) {
  return useAtomValue(factoryTasks.listAgentProfiles({ environmentId, input: {} }));
}
/** What an assignment would run for a task that does not exist yet, as the server resolves it. */
export function useFactoryTaskAssigneePreview(
  environmentId: EnvironmentId,
  input: FactoryTaskAssigneePreviewInput,
) {
  return useAtomValue(factoryTasks.previewTaskAssignee({ environmentId, input }));
}
/** The task a `/tasks/$environmentId/$displayId` URL names. */
export function useFactoryTaskDetailByDisplayId(
  environmentId: EnvironmentId,
  displayId: FactoryTaskDisplayId,
) {
  return useAtomValue(factoryTasks.readTask({ environmentId, input: { task: { displayId } } }));
}

export function useFactoryIntakeArrivals(
  environmentId: EnvironmentId,
  input: FactoryIntakeArrivalListInput = {},
) {
  return useAtomValue(factoryIntake.listIntakeArrivals({ environmentId, input }));
}
export function useFactoryIntakeSources(
  environmentId: EnvironmentId,
  input: FactoryIntakeSourceListInput = {},
) {
  return useAtomValue(factoryIntake.listIntakeSources({ environmentId, input }));
}
export function useFactoryIntakeRules(environmentId: EnvironmentId) {
  return useAtomValue(factoryIntake.listIntakeRules({ environmentId, input: {} }));
}
export function useFactoryIntakePreview(
  environmentId: EnvironmentId,
  input: FactoryIntakeRulePreviewInput,
) {
  return useAtomValue(factoryIntake.previewIntakeRule({ environmentId, input }));
}

export function useFactoryTaskCommand<I, A, E, P>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E> & {
    readonly permissionAtom: (environmentId: EnvironmentId, input?: I) => Atom.Atom<P>;
  },
  target: { readonly environmentId: EnvironmentId; readonly input: I },
  options?: AtomCommandOptions,
) {
  const run = useAtomCommand(command, options);
  const permission = useAtomValue(command.permissionAtom(target.environmentId, target.input));
  return { permission, run: () => run(target) };
}

function liveState(get: Atom.AtomContext, task: FactoryTaskSummary) {
  const facts = task.liveRuns.map((run) => {
    const ref = { environmentId: task.ref.environmentId, threadId: run.threadId };
    const thread = get(environmentThreadShells.threadShellAtom(ref));
    const waiting =
      thread !== null &&
      (thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.pendingSubagentRequest === "approval" ||
        thread.pendingSubagentRequest === "user_input");
    const requests = waiting ? get(environmentThreadDetails.pendingRequestsAtom(ref)) : null;
    return {
      threadId: run.threadId,
      waiting,
      pill: thread ? resolveThreadStatusPill({ thread }) : null,
      ...(requests ? { requests } : {}),
    };
  });
  return resolveFactoryTaskLiveState(task, facts);
}

export function useFactoryTaskLiveState(task: FactoryTaskSummary) {
  const atom = Atom.make((get) => liveState(get, task));
  return useAtomValue(atom);
}
export function useFactoryTaskNeeds(tasks: readonly FactoryTaskSummary[]) {
  const atom = Atom.make((get) => groupFactoryTaskNeeds(tasks.map((task) => liveState(get, task))));
  return useAtomValue(atom);
}

const emptyRequests: PendingThreadRequests = { approvals: [], userInputs: [] };
export function useFactoryTaskRequests(environmentId: EnvironmentId, threadId: ThreadId) {
  const registry = useContext(RegistryContext);
  const ref = { environmentId, threadId };
  const pendingAtom = environmentThreadDetails.pendingRequestsAtom(ref);
  const waitingRequests = Atom.make((get) => {
    const thread = get(environmentThreadShells.threadShellAtom(ref));
    return thread &&
      (thread.hasPendingApprovals || thread.hasPendingUserInput || thread.pendingSubagentRequest)
      ? (get(pendingAtom) ?? emptyRequests)
      : emptyRequests;
  });
  const requests = useAtomValue(waitingRequests);
  const canRespond = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const sendAnswer = useOrchestrationCommand(threadEnvironment.respondToUserInput);
  const sendApproval = useOrchestrationCommand(threadEnvironment.respondToApproval);
  const respond = (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
    const current = registry
      .get(waitingRequests)
      ?.approvals.find((item) => item.requestId === requestId);
    if (!current || current.responseCapability !== "live") return Promise.resolve(undefined);
    if (current.options && !current.options.some((option) => option.decision === decision))
      return Promise.resolve(undefined);
    return sendApproval({ environmentId, input: { threadId, requestId, decision } });
  };
  const answer = (
    requestId: RuntimeRequestId,
    answers: Parameters<typeof sendAnswer>[0]["input"]["answers"],
  ) => {
    const current = registry
      .get(waitingRequests)
      ?.userInputs.find((item) => item.requestId === requestId);
    if (!current || current.responseCapability === "not_resumable")
      return Promise.resolve(undefined);
    return sendAnswer({ environmentId, input: { threadId, requestId, answers } });
  };
  return {
    ...requests,
    question: requests.userInputs[0] ?? null,
    approval: requests.approvals[0] ?? null,
    canRespond,
    answer,
    approveOnce: (id: RuntimeRequestId) => respond(id, "accept"),
    alwaysAllow: (id: RuntimeRequestId) => respond(id, "acceptForSession"),
    deny: (id: RuntimeRequestId) => respond(id, "decline"),
  };
}
