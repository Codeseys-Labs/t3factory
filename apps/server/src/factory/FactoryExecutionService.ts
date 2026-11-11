// @effect-diagnostics nodeBuiltinImport:off
import {
  CommandId,
  ThreadId,
  FactoryExecutionError,
  FactoryExecutionIssueGrantInput,
  FactoryExecutionRevokeGrantInput,
  FactoryExecutionAdmitInput,
  FactoryExecutionRetryInput,
  FactoryExecutionStopInput,
  FactoryExecutionRetryCaptureInput,
  FactoryExecutionReadInput,
  FactoryExecutionOutputsInput,
  FactoryExecutionOutputReadInput,
  type FactoryExecutionMutationResult,
  type FactoryExecutionReadResult,
  type FactoryExecutionOutputsResult,
  type FactoryExecutionOutputReadResult,
  type FactoryExecutionAssembly,
  type FactoryPlanRef,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Store from "../persistence/FactoryExecutionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Capture from "./FactoryExecutionCapture.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import {
  planNativeExecution,
  planNativeStop,
  validateNativeExecutionCapabilities,
  type NativeExecutionFinalizationContext,
} from "../orchestration-v2/NativeExecutionPlan.ts";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";
import { executionDigest } from "./FactoryExecutionDigest.ts";
import type { PendingOrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";

export type { ObserveResultInput } from "../persistence/FactoryExecutionStore.ts";
export class FactoryExecutionService extends Context.Service<
  FactoryExecutionService,
  {
    readonly issueGrant: (
      input: FactoryExecutionIssueGrantInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryExecutionMutationResult, FactoryExecutionError>;
    readonly revokeGrant: (
      input: FactoryExecutionRevokeGrantInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryExecutionMutationResult, FactoryExecutionError>;
    readonly admit: (
      input: FactoryExecutionAdmitInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryExecutionMutationResult, FactoryExecutionError>;
    readonly retry: (
      input: FactoryExecutionRetryInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryExecutionMutationResult, FactoryExecutionError>;
    readonly retryCapture: (
      input: FactoryExecutionRetryCaptureInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryExecutionMutationResult, FactoryExecutionError>;
    readonly requestStop: (
      input: FactoryExecutionStopInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryExecutionMutationResult, FactoryExecutionError>;
    readonly readExecution: (
      input: FactoryExecutionReadInput,
    ) => Effect.Effect<FactoryExecutionReadResult, FactoryExecutionError>;
    readonly readOutputs: (
      input: FactoryExecutionOutputsInput,
    ) => Effect.Effect<FactoryExecutionOutputsResult, FactoryExecutionError>;
    readonly readOutput: (
      input: FactoryExecutionOutputReadInput,
    ) => Effect.Effect<FactoryExecutionOutputReadResult, FactoryExecutionError>;
    readonly readAssembly: (
      input: FactoryExecutionReadInput,
    ) => Effect.Effect<FactoryExecutionAssembly | null, FactoryExecutionError>;
    readonly advanceReady: (
      input: FactoryExecutionReadInput,
    ) => Effect.Effect<FactoryExecutionReadResult, FactoryExecutionError>;
    readonly observeResult: (
      input: Store.ObserveResultInput,
    ) => Effect.Effect<FactoryExecutionMutationResult, FactoryExecutionError>;
    readonly captureNativeResult: (
      input: NativeExecutionFinalizationContext,
    ) => Effect.Effect<Store.ObserveResultInput, FactoryExecutionError>;
    readonly readNativeCapture: (
      input: NativeExecutionFinalizationContext,
    ) => Effect.Effect<Store.ObserveResultInput | null, FactoryExecutionError>;
  }
>()("t3/factory/FactoryExecutionService") {}
const invalid = (cause: unknown) => new FactoryExecutionError({ reason: "invalid-input", cause });
const isFactoryExecutionError = Schema.is(FactoryExecutionError);
const decodeIssueGrant = Schema.decodeEffect(FactoryExecutionIssueGrantInput);
const decodeRevokeGrant = Schema.decodeEffect(FactoryExecutionRevokeGrantInput);
const decodeAdmit = Schema.decodeEffect(FactoryExecutionAdmitInput);
const decodeRetry = Schema.decodeEffect(FactoryExecutionRetryInput);
const decodeStop = Schema.decodeEffect(FactoryExecutionStopInput);
const decodeRetryCapture = Schema.decodeEffect(FactoryExecutionRetryCaptureInput);
const decodeReadExecution = Schema.decodeEffect(FactoryExecutionReadInput);
const decodeReadOutputs = Schema.decodeEffect(FactoryExecutionOutputsInput);
const decodeReadOutput = Schema.decodeEffect(FactoryExecutionOutputReadInput);
const make = Effect.gen(function* () {
  const store = yield* Store.FactoryExecutionStore;
  const sink = yield* EventSink.EventSinkV2;
  const capture = yield* Capture.FactoryExecutionCapture;
  const identity = yield* ServerEnvironmentIdentity;
  const adapters = yield* ProviderAdapterRegistryV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const assertEnvironment = Effect.fn("FactoryExecutionService.assertEnvironment")(function* (
    ref: FactoryPlanRef,
  ) {
    if (ref.environmentId !== (yield* identity.getEnvironmentId))
      return yield* new FactoryExecutionError({ reason: "wrong-environment" });
  });
  const commit = Effect.fn("FactoryExecutionService.commit")(function* (
    operation: Store.ExecutionOperation,
    actor: Store.FactoryExecutionActor,
    ref: FactoryPlanRef,
    revision: number,
    commandId: CommandId,
    digest: string,
    native: {
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
      readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
    } = { events: [], effects: [] },
  ) {
    yield* assertEnvironment(ref);
    return yield* sink.commitFactoryExecutionCommand({
      command: {
        commandId,
        ref,
        revision,
        actor,
        digest,
        operation,
        now: DateTime.formatIso(yield* DateTime.now),
      },
      ...native,
    });
  });
  const issueGrant = Effect.fn("FactoryExecutionService.issueGrant")(function* (
    raw: FactoryExecutionIssueGrantInput,
    actor: FactoryPlanActor,
  ) {
    if (actor.kind !== "human") return yield* new FactoryExecutionError({ reason: "forbidden" });
    const input = yield* decodeIssueGrant(raw).pipe(Effect.mapError(invalid));
    yield* assertEnvironment(input.ref);
    for (const spec of input.policy.tasks)
      yield* validateNativeExecutionCapabilities(spec, input.policy.requiredCapabilities).pipe(
        Effect.provideService(ProviderAdapterRegistryV2, adapters),
      );
    return yield* commit(
      { type: "grant", input },
      actor,
      input.ref,
      input.expectedRevision,
      input.commandId,
      executionDigest(["grant", actor, input]),
    );
  });
  const revokeGrant = Effect.fn("FactoryExecutionService.revokeGrant")(function* (
    raw: FactoryExecutionRevokeGrantInput,
    actor: FactoryPlanActor,
  ) {
    if (actor.kind !== "human") return yield* new FactoryExecutionError({ reason: "forbidden" });
    const input = yield* decodeRevokeGrant(raw).pipe(Effect.mapError(invalid));
    return yield* commit(
      { type: "revoke", input },
      actor,
      input.ref,
      input.expectedRevision,
      input.commandId,
      executionDigest(["revoke", actor, input]),
    );
  });
  const launch = Effect.fn("FactoryExecutionService.launch")(function* (
    input: FactoryExecutionAdmitInput | FactoryExecutionRetryInput,
    actor: Store.FactoryExecutionActor,
  ) {
    yield* assertEnvironment(input.selection.ref);
    const type = "intent" in input ? "retry" : "admit";
    const digest = executionDigest([type, actor, input]);
    const replay = yield* store.replay({
      commandId: input.commandId,
      digest,
      ref: input.selection.ref,
      actor,
    });
    if (replay) return { execution: replay, replayed: true };
    const now = yield* DateTime.now;
    const prepared = yield* store.prepareAdmission(input, actor, DateTime.formatIso(now));
    const native = yield* planNativeExecution({
      commandId: input.commandId,
      threadId: ThreadId.make(`factory:${NodeCrypto.randomUUID()}`),
      projectId: input.selection.ref.projectId,
      title: prepared.title,
      modelSelection: prepared.spec.modelSelection,
      runtimeMode: prepared.spec.runtimeMode,
      interactionMode: prepared.spec.interactionMode,
      workspaceStrategy: prepared.spec.workspaceStrategy,
      text: prepared.inputText,
      createdBy: actor.kind === "human" ? "user" : "system",
      creationSource: "server",
      now,
    }).pipe(
      Effect.provideService(ProviderAdapterRegistryV2, adapters),
      Effect.provideService(IdAllocator.IdAllocatorV2, ids),
      Effect.mapError((cause) =>
        isFactoryExecutionError(cause)
          ? cause
          : new FactoryExecutionError({ reason: "unsupported-capability", cause }),
      ),
    );
    const binding = {
      selection: input.selection,
      grantVersion: input.grantVersion,
      taskVersion: prepared.taskVersion,
      commandId: input.commandId,
      threadId: native.threadId,
      runId: native.runId,
      runAttemptId: native.runAttemptId,
      driver: native.driver,
      spec: prepared.spec,
      inputDigest: prepared.inputDigest,
      inputText: prepared.inputText,
      prerequisites: prepared.prerequisites,
      admittedAt: DateTime.formatIso(now),
      stopRequested: false,
      quiescent: false,
    };
    return yield* commit(
      "intent" in input ? { type: "retry", input, binding } : { type: "admit", input, binding },
      actor,
      input.selection.ref,
      input.selection.revision,
      input.commandId,
      digest,
      native,
    );
  });
  const admit = Effect.fn("FactoryExecutionService.admit")(function* (
    raw: FactoryExecutionAdmitInput,
    actor: FactoryPlanActor,
  ) {
    return yield* launch(yield* decodeAdmit(raw).pipe(Effect.mapError(invalid)), actor);
  });
  const retry = Effect.fn("FactoryExecutionService.retry")(function* (
    raw: FactoryExecutionRetryInput,
    actor: FactoryPlanActor,
  ) {
    return yield* launch(yield* decodeRetry(raw).pipe(Effect.mapError(invalid)), actor);
  });
  const requestStop = Effect.fn("FactoryExecutionService.requestStop")(function* (
    raw: FactoryExecutionStopInput,
    actor: FactoryPlanActor,
  ) {
    const input = yield* decodeStop(raw).pipe(Effect.mapError(invalid));
    yield* assertEnvironment(input.selection.ref);
    const binding = yield* store.getBinding(input.runAttemptId);
    return yield* commit(
      { type: "stop", input },
      actor,
      input.selection.ref,
      input.selection.revision,
      input.commandId,
      executionDigest(["stop", actor, input]),
      planNativeStop({ binding, commandId: input.commandId, now: yield* DateTime.now }),
    );
  });
  const retryCapture = Effect.fn("FactoryExecutionService.retryCapture")(function* (
    raw: FactoryExecutionRetryCaptureInput,
    actor: FactoryPlanActor,
  ) {
    if (actor.kind !== "human") return yield* new FactoryExecutionError({ reason: "forbidden" });
    const input = yield* decodeRetryCapture(raw).pipe(Effect.mapError(invalid));
    yield* assertEnvironment(input.selection.ref);
    const binding = yield* store.getBinding(input.runAttemptId);
    const projection = yield* projections
      .getThreadProjection(binding.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new FactoryExecutionError({ reason: "prerequisite-held", cause }),
        ),
      );
    const attempt = projection.attempts.find((entry) => entry.id === binding.runAttemptId);
    const scope = projection.checkpointScopes.find(
      (entry) => entry.runId === binding.runId && entry.kind === "root_run",
    );
    if (!attempt || !scope)
      return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
    const captureGeneration =
      Number((yield* store.captureKey(binding.runAttemptId)).split("/")[1]) + 1;
    return yield* commit(
      { type: "retryCapture", input },
      actor,
      input.selection.ref,
      input.selection.revision,
      input.commandId,
      executionDigest(["retryCapture", actor, input]),
      {
        events: [],
        effects: [
          {
            id: `effect:${input.commandId}:factory.execution.finalize`,
            commandId: input.commandId,
            threadId: binding.threadId,
            request: {
              type: "factory.execution.finalize",
              runId: binding.runId,
              runAttemptId: binding.runAttemptId,
              captureGeneration,
              scopeId: scope.id,
              providerThreadId: attempt.providerThreadId,
              driver: binding.driver,
              providerInstanceId: binding.spec.modelSelection.instanceId,
            },
          },
        ],
      },
    );
  });
  const readExecution = Effect.fn("FactoryExecutionService.readExecution")(function* (
    raw: FactoryExecutionReadInput,
  ) {
    const input = yield* decodeReadExecution(raw).pipe(Effect.mapError(invalid));
    yield* assertEnvironment(input.ref);
    return yield* store.readExecution(input);
  });
  const readOutputs = Effect.fn("FactoryExecutionService.readOutputs")(function* (
    raw: FactoryExecutionOutputsInput,
  ) {
    const input = yield* decodeReadOutputs(raw).pipe(Effect.mapError(invalid));
    yield* assertEnvironment(input.ref);
    return yield* store.readOutputs(input);
  });
  const readOutput = Effect.fn("FactoryExecutionService.readOutput")(function* (
    raw: FactoryExecutionOutputReadInput,
  ) {
    const input = yield* decodeReadOutput(raw).pipe(Effect.mapError(invalid));
    yield* assertEnvironment(input.selection.ref);
    return yield* store.readOutput(input);
  });
  const observeResult = Effect.fn("FactoryExecutionService.observeResult")(function* (
    input: Store.ObserveResultInput,
  ) {
    const binding = yield* store.getBinding(input.runAttemptId);
    const digest = executionDigest(["observe", input]);
    return yield* commit(
      { type: "observe", input },
      { kind: "automation" },
      binding.selection.ref,
      binding.selection.revision,
      CommandId.make(`factory:observe:${executionDigest([input.runAttemptId, input.captureKey])}`),
      digest,
    );
  });
  const advanceReady = Effect.fn("FactoryExecutionService.advanceReady")(function* (
    raw: FactoryExecutionReadInput,
  ) {
    const input = yield* decodeReadExecution(raw).pipe(Effect.mapError(invalid));
    let state = yield* readExecution(input);
    const grant = state.grant;
    if (
      !grant ||
      state.acceptance ||
      state.reopened ||
      state.currentRevision !== state.revision ||
      grant.revokedAt !== null
    )
      return state;
    // At most the finite policy frontier is considered; only native completion schedules another pass.
    for (const spec of grant.policy.tasks) {
      const task = state.tasks.find((entry) => entry.taskId === spec.taskId);
      if (!task || task.version !== 0) continue;
      const frontier = state.tasks.map((entry) => [
        entry.taskId,
        entry.version,
        entry.selectedResult?.resultId,
        entry.binding?.quiescent,
      ]);
      const admission: FactoryExecutionAdmitInput = {
        commandId: CommandId.make(
          `factory:advance:${executionDigest([input, grant.version, spec.taskId, frontier])}`,
        ),
        selection: { ...input, taskId: spec.taskId },
        grantVersion: grant.version,
        expectedTaskVersion: 0,
      };
      const launched = yield* launch(admission, { kind: "automation" }).pipe(Effect.result);
      if (Result.isFailure(launched)) {
        if (
          ![
            "prerequisite-held",
            "budget-exhausted",
            "task-conflict",
            "grant-inactive",
            "grant-expired",
            "grant-conflict",
            "revision-conflict",
          ].includes(launched.failure.reason)
        )
          return yield* launched.failure;
      } else state = launched.success.execution;
    }
    return yield* readExecution(input);
  });
  return FactoryExecutionService.of({
    issueGrant,
    revokeGrant,
    admit,
    retry,
    retryCapture,
    requestStop,
    readExecution,
    readOutputs,
    readOutput,
    readAssembly: Effect.fn("FactoryExecutionService.readAssembly")((input) =>
      readExecution(input).pipe(Effect.map((state) => state.assembly)),
    ),
    observeResult,
    advanceReady,
    captureNativeResult: capture.capture,
    readNativeCapture: capture.read,
  });
});
export const layer = Layer.effect(FactoryExecutionService, make).pipe(
  Layer.provide(Capture.layer),
  Layer.provide(Store.layer),
);
