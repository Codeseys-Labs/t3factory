import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  FactoryTaskListInput,
  type FactoryTaskActivityResult,
  type FactoryTaskDisplayId,
  type FactoryTaskRef,
  type FactoryTaskSummary,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  createFactoryTaskListAtoms,
  factoryTaskQueryStatus,
  type FactoryTaskListTarget,
  type FactoryTaskOwnerStatus,
} from "@t3tools/client-runtime/state/factory-task-list";
import {
  resolveFactoryTaskLiveState,
  type FactoryTaskCatalog,
} from "@t3tools/client-runtime/state/factory-task-view";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useEffect, useMemo } from "react";

import { taskThreadPill, type TaskEntry } from "../features/tasks/taskPresentation";
import { resolveThreadListV2Status } from "../features/threads/threadListV2";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentSession, sessionHasScope, useEnvironmentScope } from "./session";
import { factoryTaskEnvironment } from "./factory";
import { environmentThreadDetails, environmentThreadShells, threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

const accessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): FactoryTaskOwnerStatus => {
    const presentation = get(environmentPresentations.presentationAtom(environmentId));
    const phase = presentation?.connection.phase;
    if (phase === "unsupported") return "unsupported";
    // Before the first connection settles, the machine is not known to be offline.
    if (phase === undefined || phase === "available" || phase === "connecting") return "loading";
    if (phase !== "connected" || !presentation) return "offline";
    if (!presentation.serverConfig) return "loading";
    const session = get(environmentSession.sessionStateAtom(environmentId));
    if (session._tag === "Initial") return "loading";
    return sessionHasScope(session, AuthOrchestrationReadScope) ? "current" : "forbidden";
  }),
);

const lists = createFactoryTaskListAtoms({
  listTasks: factoryTaskEnvironment.listTasks,
  countTasks: factoryTaskEnvironment.countTasks,
  accessAtom,
  changesAtom: (environmentId) =>
    factoryTaskEnvironment.subscribeTaskChanges({ environmentId, input: {} }),
});

const decodeEnvironmentIds = Schema.decodeUnknownSync(Schema.Array(EnvironmentId));
const decodeTargets = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ environmentId: EnvironmentId, input: FactoryTaskListInput })),
  ),
);

/**
 * Tasks across environments. Each environment keeps its own cursor chain and live refresh.
 * `loadAll` keeps reading each environment's next page until its chain ends or is capped.
 */
export function useFactoryTasks(
  targets: readonly FactoryTaskListTarget[],
  options?: { readonly loadAll?: boolean },
) {
  const registry = useContext(RegistryContext);
  const result = useAtomValue(lists.listAtom(targets));
  const targetsKey = JSON.stringify(targets);
  const waitingKey = JSON.stringify(
    options?.loadAll
      ? result.more.filter((entry) => entry.available).map((entry) => entry.environmentId)
      : [],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Pulls the next page of each environment's server-side cursor chain until it ends; the keys carry what it needs.
  useEffect(() => {
    const waiting = new Set<string>(decodeEnvironmentIds(JSON.parse(waitingKey)));
    for (const target of decodeTargets(targetsKey))
      if (waiting.has(target.environmentId)) lists.loadMore(registry, target);
  }, [registry, targetsKey, waitingKey]);
  return {
    ...result,
    loadMore: (environmentId: EnvironmentId) => {
      const target = targets.find((entry) => entry.environmentId === environmentId);
      if (target) lists.loadMore(registry, target);
    },
    refresh: () => {
      for (const target of targets) lists.refresh(registry, target);
    },
  };
}

export function useFactoryTaskDetail(ref: FactoryTaskRef) {
  return useAtomValue(
    factoryTaskEnvironment.readTask({ environmentId: ref.environmentId, input: { task: { ref } } }),
  );
}

/** The task a Tasks route names: an environment and a display id such as `T-38.2`. */
export function useFactoryTaskDetailByDisplayId(
  environmentId: EnvironmentId,
  displayId: FactoryTaskDisplayId,
) {
  const atom = factoryTaskEnvironment.readTask({ environmentId, input: { task: { displayId } } });
  const access = useAtomValue(accessAtom(environmentId));
  const result = useAtomValue(atom);
  return {
    result,
    refresh: useAtomRefresh(atom),
    status: access === "current" ? factoryTaskQueryStatus(result) : access,
  };
}

export function useFactoryTaskActivity(ref: FactoryTaskRef) {
  const atom = useMemo(
    () =>
      Atom.make((get): AsyncResult.AsyncResult<FactoryTaskActivityResult, unknown> => {
        let cursor: string | undefined;
        let latest: FactoryTaskActivityResult | undefined;
        let waiting = false;
        const seen = new Set<string>();
        while (true) {
          const page = get(
            factoryTaskEnvironment.readTaskActivity({
              environmentId: ref.environmentId,
              input: { ref, ...(cursor === undefined ? {} : { cursor }) },
            }),
          );
          if (page._tag !== "Success") return page;
          latest = {
            entries: [...(latest?.entries ?? []), ...page.value.entries].slice(-6),
            nextCursor: null,
            fetchedAt: page.value.fetchedAt,
          };
          waiting ||= page.waiting;
          const next = page.value.nextCursor;
          if (next === null) return AsyncResult.success(latest, { waiting });
          if (seen.has(next))
            return AsyncResult.failure(Cause.fail(new Error("Repeated activity cursor")));
          seen.add(next);
          cursor = next;
        }
      }).pipe(Atom.setIdleTTL(0)),
    [ref],
  );
  return useAtomValue(atom);
}

const catalogs = Atom.family((key: string) =>
  Atom.make(
    (get): ReadonlyMap<EnvironmentId, FactoryTaskCatalog> =>
      new Map(
        decodeEnvironmentIds(JSON.parse(key)).map(
          (environmentId) =>
            [
              environmentId,
              get(serverEnvironment.providersValueAtom(environmentId)) ?? [],
            ] as const,
        ),
      ),
  ),
);

/** Provider and model names for the assignee labels, read once for every environment shown. */
export function useFactoryTaskCatalogs(environmentIds: readonly EnvironmentId[]) {
  return useAtomValue(catalogs(JSON.stringify([...new Set(environmentIds)].sort())));
}

function liveState(get: Atom.AtomContext, task: FactoryTaskSummary): TaskEntry {
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
      pill: thread ? taskThreadPill(resolveThreadListV2Status(thread)) : null,
      ...(requests ? { requests } : {}),
    };
  });
  return { task, live: resolveFactoryTaskLiveState(task, facts) };
}

/** Each task's live runs and asks, from the same thread facts the thread list shows. */
export function useFactoryTaskEntries(tasks: readonly FactoryTaskSummary[]): readonly TaskEntry[] {
  const atom = useMemo(
    () => Atom.make((get): readonly TaskEntry[] => tasks.map((task) => liveState(get, task))),
    [tasks],
  );
  return useAtomValue(atom);
}

const emptyRequests: PendingThreadRequests = { approvals: [], userInputs: [] };

/** One waiting thread's question and approval, and the thread commands that answer them. */
export function useFactoryTaskRequests(environmentId: EnvironmentId, threadId: ThreadId | null) {
  const registry = useContext(RegistryContext);
  const waitingRequests = useMemo(
    () =>
      Atom.make((get): PendingThreadRequests => {
        if (threadId === null) return emptyRequests;
        const ref = { environmentId, threadId };
        const thread = get(environmentThreadShells.threadShellAtom(ref));
        return thread &&
          (thread.hasPendingApprovals ||
            thread.hasPendingUserInput ||
            thread.pendingSubagentRequest)
          ? (get(environmentThreadDetails.pendingRequestsAtom(ref)) ?? emptyRequests)
          : emptyRequests;
      }),
    [environmentId, threadId],
  );
  const requests = useAtomValue(waitingRequests);
  const canRespond = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const sendAnswer = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const sendApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respond = (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
    const current = registry
      .get(waitingRequests)
      .approvals.find((item) => item.requestId === requestId);
    if (threadId === null || !current || current.responseCapability !== "live")
      return Promise.resolve(undefined);
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
      .userInputs.find((item) => item.requestId === requestId);
    if (threadId === null || !current || current.responseCapability === "not_resumable")
      return Promise.resolve(undefined);
    return sendAnswer({ environmentId, input: { threadId, requestId, answers } });
  };
  return {
    ...requests,
    canRespond,
    answer,
    approveOnce: (id: RuntimeRequestId) => respond(id, "accept"),
    alwaysAllow: (id: RuntimeRequestId) => respond(id, "acceptForSession"),
    deny: (id: RuntimeRequestId) => respond(id, "decline"),
  };
}
