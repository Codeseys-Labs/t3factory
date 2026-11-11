import {
  FactoryExecutionError,
  type FactoryExecutionTaskSpec,
  type FactoryExecutionPolicy,
  type FactoryExecutionBinding,
} from "@t3tools/contracts";
import type {
  CommandId,
  ModelSelection,
  OrchestrationV2Actor,
  OrchestrationV2AppThread,
  OrchestrationV2CreationSource,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  RunAttemptId,
  RunId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  CheckpointScopeId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type { ThreadLaunchWorkspaceStrategy } from "./ThreadLaunchService.ts";
import { ownedWriterPlatformRefusal } from "../process/OwnedProcess.ts";

export interface NativeExecutionPlanInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly text: string;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly now: DateTime.Utc;
}

export function nativeThreadRecord(
  input: Omit<NativeExecutionPlanInput, "commandId" | "text" | "workspaceStrategy"> & {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  },
): OrchestrationV2AppThread {
  return {
    createdBy: input.createdBy,
    creationSource: input.creationSource,
    id: input.threadId,
    projectId: input.projectId,
    title: input.title,
    providerInstanceId: input.modelSelection.instanceId,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: input.branch,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    pullRequests: [],
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function nativePendingAttempt(input: {
  readonly id: RunAttemptId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId;
}): OrchestrationV2RunAttempt {
  return {
    ...input,
    attemptOrdinal: 1,
    providerTurnId: null,
    reason: "initial",
    status: "pending",
    startedAt: null,
    completedAt: null,
  };
}

export const planNativeExecution = Effect.fn("NativeExecutionPlan.plan")(function* (
  input: NativeExecutionPlanInput,
) {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const adapters = yield* ProviderAdapterRegistryV2;
  const adapter = yield* adapters.get(input.modelSelection.instanceId);
  yield* validateNativeExecutionCapabilities(
    [{ modelSelection: input.modelSelection }],
    ["owned-writers"],
  );
  const runId = ids.derive.run({ threadId: input.threadId, ordinal: 1 });
  const runAttemptId = ids.derive.runAttempt({ runId, attemptOrdinal: 1 });
  const rootNodeId = ids.derive.rootNode({ runId });
  const providerThreadId = ids.derive.providerThread({
    driver: adapter.driver,
    providerInstanceId: input.modelSelection.instanceId,
    nativeThreadId: `pending:${input.threadId}`,
  });
  const providerSessionId = yield* ids.allocate.providerSession({
    providerInstanceId: input.modelSelection.instanceId,
    threadId: input.threadId,
  });
  const messageId = yield* ids.allocate.message({ threadId: input.threadId, ordinal: 1 });
  const thread = nativeThreadRecord({
    ...input,
    branch: input.workspaceStrategy.branch ?? null,
    worktreePath:
      input.workspaceStrategy.type === "existing_worktree"
        ? input.workspaceStrategy.worktreePath
        : null,
  });
  const run: OrchestrationV2Run = {
    id: runId,
    threadId: input.threadId,
    ordinal: 1,
    providerInstanceId: input.modelSelection.instanceId,
    modelSelection: input.modelSelection,
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: runAttemptId,
    status: "preparing",
    queuePosition: null,
    requestedAt: input.now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    workspacePreparation: input.workspaceStrategy,
  };
  const attempt = nativePendingAttempt({
    id: runAttemptId,
    runId,
    rootNodeId,
    providerInstanceId: input.modelSelection.instanceId,
    providerThreadId,
  });
  const base = {
    threadId: input.threadId,
    runId,
    nodeId: rootNodeId,
    providerInstanceId: input.modelSelection.instanceId,
    occurredAt: input.now,
  };
  const payloads = [
    { type: "thread.created", payload: thread },
    {
      type: "provider-thread.updated",
      driver: adapter.driver,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: input.modelSelection.instanceId,
        providerSessionId,
        appThreadId: input.threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: input.now,
        updatedAt: input.now,
      },
    },
    { type: "run.created", payload: run },
    { type: "run-attempt.created", payload: attempt },
    {
      type: "node.updated",
      payload: {
        id: rootNodeId,
        threadId: input.threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: null,
        completedAt: null,
      },
    },
    {
      type: "message.updated",
      payload: {
        id: messageId,
        threadId: input.threadId,
        runId,
        nodeId: rootNodeId,
        role: "user",
        text: input.text,
        attachments: [],
        streaming: false,
        createdAt: input.now,
        updatedAt: input.now,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      },
    },
    {
      type: "turn-item.updated",
      payload: {
        id: ids.derive.userTurnItem({ messageId }),
        threadId: input.threadId,
        runId,
        nodeId: rootNodeId,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: input.now,
        completedAt: input.now,
        updatedAt: input.now,
        type: "user_message",
        messageId,
        inputIntent: "turn_start",
        text: input.text,
        attachments: [],
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      },
    },
    {
      type: "turn-item.updated",
      payload: {
        id: ids.derive.turnItemFromProviderItem({
          driver: adapter.driver,
          nativeItemId: `workspace-preparation:${runId}`,
        }),
        threadId: input.threadId,
        runId,
        nodeId: rootNodeId,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "running",
        title: "Preparing workspace",
        startedAt: input.now,
        completedAt: null,
        updatedAt: input.now,
        type: "command_execution",
        input: "Preparing workspace",
      },
    },
  ] as const;
  const events = yield* Effect.forEach(payloads, (event) =>
    Effect.gen(function* () {
      return {
        ...base,
        ...event,
        id: yield* ids.allocate.event({ threadId: input.threadId, commandId: input.commandId }),
      } satisfies OrchestrationV2DomainEvent;
    }),
  );
  const effects: ReadonlyArray<PendingOrchestrationEffectV2> = [
    {
      id: `effect:${input.commandId}:factory.execution.prepare:${runId}`,
      commandId: input.commandId,
      threadId: input.threadId,
      request: { type: "factory.execution.prepare", runId, runAttemptId },
    },
  ];
  return { threadId: input.threadId, runId, runAttemptId, driver: adapter.driver, events, effects };
});

export const validateNativeExecutionCapabilities = Effect.fn(
  "NativeExecutionPlan.validateCapabilities",
)(function* (
  specs: ReadonlyArray<Pick<FactoryExecutionTaskSpec, "modelSelection">>,
  requiredCapabilities: FactoryExecutionPolicy["requiredCapabilities"],
) {
  // The Linux probe spawns a contained child; one call probes the host at most once.
  const platformRefusal = yield* Effect.cached(ownedWriterPlatformRefusal());
  const registry = yield* ProviderAdapterRegistryV2;
  for (const spec of specs) {
    const adapter = yield* registry
      .get(spec.modelSelection.instanceId)
      .pipe(
        Effect.mapError(
          (cause) => new FactoryExecutionError({ reason: "unsupported-capability", cause }),
        ),
      );
    const capabilities = yield* adapter
      .getCapabilities()
      .pipe(
        Effect.mapError(
          (cause) => new FactoryExecutionError({ reason: "unsupported-capability", cause }),
        ),
      );
    const capabilityReason =
      capabilities.ownedWriters !== true
        ? "This agent does not route all of its writers through attempt-owned processes."
        : requiredCapabilities.some((capability) => capability !== "owned-writers")
          ? "Hard cost limits and denial of external actions are not enforced by this runtime."
          : yield* platformRefusal;
    if (capabilityReason !== undefined) {
      return yield* new FactoryExecutionError({
        reason: "unsupported-capability",
        capabilityReason,
      });
    }
  }
});

export function planNativeStop(input: {
  readonly binding: FactoryExecutionBinding;
  readonly commandId: CommandId;
  readonly now: DateTime.Utc;
}) {
  return {
    events: [] as ReadonlyArray<OrchestrationV2DomainEvent>,
    effects: [
      {
        id: `effect:${input.commandId}:factory.execution.stop:${input.binding.runAttemptId}`,
        commandId: input.commandId,
        threadId: input.binding.threadId,
        request: {
          type: "factory.execution.stop",
          runId: input.binding.runId,
          runAttemptId: input.binding.runAttemptId,
        },
      },
    ] satisfies ReadonlyArray<PendingOrchestrationEffectV2>,
  };
}

export interface NativeExecutionFinalizationContext {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runAttemptId: RunAttemptId;
  readonly scopeId: CheckpointScopeId;
  readonly captureGeneration?: number;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
}
