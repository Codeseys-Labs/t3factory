import {
  FactoryExecutionError,
  type FactoryExecutionBinding,
  type OrchestrationV2ServerCommand,
  type RunAttemptId,
  type RunId,
  type ThreadId,
  type AuthSessionId,
} from "@t3tools/contracts";
import type { OwnedProcessGroup } from "../process/OwnedProcess.ts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { OwnedProcess } from "@t3tools/shared/ownedProcess";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FactoryExecutionStore from "../persistence/FactoryExecutionStore.ts";
import { makeOwnedProcess } from "../process/OwnedProcess.ts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
const isFactoryExecutionError = Schema.is(FactoryExecutionError);

type Phase = FactoryExecutionStore.FactoryExecutionPhase;
type PhaseInput = Identity & {
  readonly phase: Phase;
  readonly runtimeResponse?: Omit<
    FactoryExecutionStore.FactoryRuntimeResponseCheck,
    "expectedStatus"
  >;
};
type Identity = {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runAttemptId: RunAttemptId;
  readonly captureGeneration?: number;
};

export class FactoryOwnedProcessFactory extends Context.Reference<{
  readonly make: () => Effect.Effect<OwnedProcessGroup>;
}>("t3/FactoryOwnedProcessFactory", { defaultValue: () => ({ make: makeOwnedProcess }) }) {}

export class FactoryNativeAuthority extends Context.Reference<RunAttemptId | undefined>(
  "t3/FactoryNativeAuthority",
  { defaultValue: (): RunAttemptId | undefined => undefined },
) {}

export class FactoryRuntimeResponseSession extends Context.Reference<AuthSessionId | undefined>(
  "t3/FactoryRuntimeResponseSession",
  { defaultValue: (): AuthSessionId | undefined => undefined },
) {}

export class FactoryExecutionLifecycle extends Context.Service<
  FactoryExecutionLifecycle,
  {
    readonly binding: (input: {
      readonly threadId: ThreadId;
      readonly runId?: RunId;
      readonly runAttemptId?: RunAttemptId;
    }) => Effect.Effect<FactoryExecutionBinding | null, FactoryExecutionError>;
    readonly guardCommand: (
      command: OrchestrationV2ServerCommand,
    ) => Effect.Effect<void, FactoryExecutionError>;
    readonly runPhase: <A, E, R>(
      input: PhaseInput,
      work: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | FactoryExecutionError, R>;
    readonly respond: <A, E, R>(
      input: Omit<FactoryExecutionStore.FactoryRuntimeResponseCheck, "expectedStatus">,
      work: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | FactoryExecutionError, R>;
    readonly recover: (input: Identity) => Effect.Effect<void, FactoryExecutionError>;
    readonly stop: (input: Identity) => Effect.Effect<boolean, FactoryExecutionError>;
    readonly quiesce: (input: Identity) => Effect.Effect<boolean, FactoryExecutionError>;
    readonly complete: (input: Identity) => Effect.Effect<boolean, FactoryExecutionError>;
  }
>()("t3/factory/FactoryExecutionLifecycle") {}

const make = Effect.gen(function* () {
  const store = yield* FactoryExecutionStore.FactoryExecutionStore;
  const crypto = yield* Crypto.Crypto;
  const processFactory = yield* FactoryOwnedProcessFactory;
  const platform = yield* HostProcess.Platform;
  const owners = new Map<
    RunAttemptId,
    {
      readonly process: OwnedProcessGroup;
      captureProcess?: OwnedProcessGroup;
      readonly claims: Map<
        Phase,
        { claimantId: string; joined: boolean; settled: boolean; done: Deferred.Deferred<void> }
      >;
    }
  >();
  const binding = Effect.fn("FactoryExecutionLifecycle.binding")(function* (
    input: Parameters<typeof store.findNativeBinding>[0],
  ) {
    const managed = yield* store.findNativeBinding(input);
    if (
      managed !== null &&
      ((input.runId !== undefined && managed.runId !== input.runId) ||
        (input.runAttemptId !== undefined && managed.runAttemptId !== input.runAttemptId))
    ) {
      return yield* new FactoryExecutionError({ reason: "task-conflict" });
    }
    return managed;
  });
  // A failed ownership observation is unknown, not quiescent: reservation stays held.
  const quiesced = (process: OwnedProcessGroup) =>
    process.quiesce().pipe(Effect.orElseSucceed(() => false));
  const reconcile = Effect.fn("FactoryExecutionLifecycle.reconcile")(function* (
    input: Identity,
    release = true,
  ) {
    const managed = yield* binding(input);
    if (managed === null) return true;
    yield* store.requestNativeStop({
      threadId: input.threadId,
      runId: input.runId,
      detail: "Native attempt completion/stop requested; retain outstanding ownership.",
    });
    const owner = owners.get(input.runAttemptId);
    if (owner === undefined) {
      if (!release) return false;
      // Windows jobs die with their observer; Linux cgroups can outlive the server.
      if (platform === "win32")
        yield* store.expireOrphanClaims({ runAttemptId: input.runAttemptId });
      const retained = yield* store.readCapture(input.runAttemptId);
      return yield* store
        .settleAttempt({
          runAttemptId: input.runAttemptId,
          observation: retained === null ? "no-start" : "quiescent",
          detail:
            "Reconcile only durable positive phase/capture observations or zero outstanding claims; never infer from missing PID or owner registry.",
        })
        .pipe(
          Effect.as(true),
          Effect.catchTags({
            FactoryExecutionError: (error) =>
              error.reason === "not-quiescent" ? Effect.succeed(false) : Effect.fail(error),
          }),
        );
    }
    const processQuiet = yield* quiesced(owner.process);
    const captureQuiet =
      owner.captureProcess === undefined || (yield* quiesced(owner.captureProcess));
    if (!processQuiet || !captureQuiet) {
      for (const [phase, claim] of owner.claims) {
        if (!claim.settled)
          yield* store.settlePhase({
            runAttemptId: input.runAttemptId,
            phase,
            claimantId: claim.claimantId,
            observation: "unknown",
            detail:
              "Owned writer/job or acquisition remains unresolved; keep claimant and reservation.",
          });
      }
      return false;
    }
    for (const [phase, claim] of owner.claims) {
      if (!claim.joined) return false;
      if (claim.settled) continue;
      yield* store.settlePhase({
        runAttemptId: input.runAttemptId,
        phase,
        claimantId: claim.claimantId,
        observation: "quiescent",
        detail: "Claimant joined and every owned process container independently observed empty.",
      });
      claim.settled = true;
    }
    if (release)
      yield* store.settleAttempt({
        runAttemptId: input.runAttemptId,
        observation: "quiescent",
        detail:
          "All local claimants joined and owned jobs independently observed empty; future acquisitions tombstoned.",
      });
    return true;
  });
  const runPhase = Effect.fn("FactoryExecutionLifecycle.runPhase")(function* <A, E, R>(
    input: PhaseInput,
    work: Effect.Effect<A, E, R>,
  ) {
    const managed = yield* binding(input);
    if (managed === null) {
      if (input.phase.startsWith("response:"))
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      return yield* work;
    }
    const claimantId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claim = yield* store.claimPhase({
          runAttemptId: input.runAttemptId,
          phase: input.phase,
          claimantId,
          ...(input.runtimeResponse === undefined
            ? {}
            : { runtimeResponse: input.runtimeResponse }),
          ...(input.phase === "capture" ? { captureGeneration: input.captureGeneration ?? 1 } : {}),
        });
        if (claim.status !== "claimed") {
          if (claim.status === "suppressed")
            yield* reconcile(input).pipe(
              Effect.catchIf(
                (error): error is FactoryExecutionError => isFactoryExecutionError(error),
                (error) =>
                  error.reason === "not-quiescent" ? Effect.succeed(false) : Effect.fail(error),
              ),
            );
          return yield* new FactoryExecutionError({
            reason: claim.status === "held" ? "not-quiescent" : "grant-inactive",
          });
        }
        let owner = owners.get(input.runAttemptId);
        if (owner === undefined) {
          owner = { process: yield* processFactory.make(), claims: new Map() };
          owners.set(input.runAttemptId, owner);
        }
        if (input.phase === "capture") {
          const previous = owner.claims.get("capture");
          if (previous !== undefined && (!previous.joined || !previous.settled))
            return yield* new FactoryExecutionError({ reason: "not-quiescent" });
          owner.captureProcess = yield* processFactory.make();
        }
        const processOwner = input.phase === "capture" ? owner.captureProcess! : owner.process;
        const record = {
          claimantId,
          joined: false,
          settled: false,
          done: yield* Deferred.make<void>(),
        };
        owner.claims.set(input.phase, record);
        const result = yield* restore(
          work.pipe(
            Effect.provideService(OwnedProcess, processOwner.spawner),
            Effect.provideService(FactoryNativeAuthority, input.runAttemptId),
          ),
        ).pipe(Effect.exit);
        record.joined = true;
        yield* Deferred.succeed(record.done, undefined);
        if (Exit.isFailure(result)) {
          yield* store.requestNativeStop({
            threadId: input.threadId,
            runId: input.runId,
            detail:
              "Phase claimant failed or was interrupted; reconcile ownership before replacement.",
          });
          yield* reconcile(
            input,
            (!owner.claims.has("session") && !owner.claims.has("turn")) ||
              input.phase === "capture",
          );
          return yield* Effect.failCause(result.cause);
        }
        const current = yield* binding(input);
        if (current?.stopRequested)
          yield* reconcile(
            input,
            (!owner.claims.has("session") && !owner.claims.has("turn")) ||
              input.phase === "capture",
          );
        return result.value;
      }),
    );
  });
  return FactoryExecutionLifecycle.of({
    binding,
    guardCommand: Effect.fn("FactoryExecutionLifecycle.guardCommand")(function* (command) {
      const threadId =
        "threadId" in command
          ? command.threadId
          : "parentThreadId" in command
            ? command.parentThreadId
            : "targetThreadId" in command
              ? command.targetThreadId
              : undefined;
      if (threadId === undefined) return;
      let managed = yield* store.findNativeBinding({ threadId });
      if (managed === null && "sourceThreadId" in command)
        managed = yield* store.findNativeBinding({ threadId: command.sourceThreadId });
      if (managed === null) return;
      if (
        command.type === "thread.stop" ||
        command.type === "run.interrupt" ||
        command.type === "queued-run.cancel"
      ) {
        if (command.type !== "thread.stop" && command.runId !== managed.runId)
          return yield* new FactoryExecutionError({ reason: "task-conflict" });
        yield* store.requestNativeStop({
          threadId,
          runId: managed.runId,
          detail: "Ordinary native stop requested.",
        });
        return;
      }
      if (command.type === "prepared-run.fail" && command.runId === managed.runId) return;
      if (command.type === "thread.delete" && !managed.quiescent)
        return yield* new FactoryExecutionError({ reason: "not-quiescent" });
      if (command.type === "runtime-request.respond") {
        const sessionId = yield* FactoryRuntimeResponseSession;
        if (
          sessionId !== undefined &&
          command.decision !== "acceptForSession" &&
          command.decision !== "acceptAlways" &&
          (command.decision !== undefined || command.answers !== undefined)
        )
          return;
      }
      const authority = yield* FactoryNativeAuthority;
      if (
        authority === managed.runAttemptId &&
        (command.type === "prepared-run.release" ||
          command.type === "prepared-run.progress" ||
          command.type === "prepared-run.fail" ||
          command.type === "thread.metadata.update")
      )
        return;
      if (
        command.type === "message.dispatch" ||
        command.type.startsWith("queued-") ||
        command.type === "queue.resume" ||
        command.type.startsWith("prepared-run.") ||
        command.type === "runtime-request.respond" ||
        command.type.startsWith("delegated_task.") ||
        command.type === "provider.switch" ||
        command.type === "checkpoint.rollback" ||
        command.type === "thread.project.adopt-folder" ||
        command.type === "thread.fork" ||
        command.type === "thread.merge_back" ||
        command.type === "thread.model-selection.set" ||
        command.type === "thread.runtime-mode.set" ||
        command.type === "thread.interaction-mode.set" ||
        command.type === "thread.metadata.update"
      ) {
        return yield* new FactoryExecutionError({ reason: "grant-inactive" });
      }
    }),
    runPhase,
    respond: Effect.fn("FactoryExecutionLifecycle.respond")(function* <A, E, R>(
      input: Omit<FactoryExecutionStore.FactoryRuntimeResponseCheck, "expectedStatus">,
      work: Effect.Effect<A, E, R>,
    ) {
      const managed = yield* store.authorizeRuntimeResponse({
        ...input,
        expectedStatus: "resolved",
      });
      return yield* runPhase(
        { ...managed, phase: `response:${input.requestId}`, runtimeResponse: input },
        work,
      );
    }),
    recover: Effect.fn("FactoryExecutionLifecycle.recover")(function* (input) {
      const managed = yield* binding(input);
      if (managed === null || managed.quiescent) return;
      if (!managed.stopRequested && !(yield* store.hasNativeClaims(input.runAttemptId))) return;
      yield* reconcile(input, owners.get(input.runAttemptId) === undefined);
    }),
    stop: Effect.fn("FactoryExecutionLifecycle.stop")((input) =>
      reconcile(input, owners.get(input.runAttemptId) === undefined),
    ),
    quiesce: Effect.fn("FactoryExecutionLifecycle.quiesce")(function* (input) {
      const managed = yield* binding(input);
      if (managed === null) return true;
      yield* store.requestNativeStop({
        threadId: input.threadId,
        runId: input.runId,
        detail: "Join provider writers before retained capture; capacity stays reserved.",
      });
      const owner = owners.get(input.runAttemptId);
      if (owner === undefined) {
        if ((yield* store.readCapture(input.runAttemptId)) !== null) {
          yield* store.settleAttempt({
            runAttemptId: input.runAttemptId,
            observation: "quiescent",
            detail:
              "Reconciled retained capture and durable positive claimant/job observations; no native phase is replayed.",
          });
          return true;
        }
        if (!(yield* store.canBeginCapture(input.runAttemptId))) return false;
        const process = yield* processFactory.make();
        yield* quiesced(process);
        // The Store proves the prior provider joins; this sealed local group can never re-enter them.
        owners.set(input.runAttemptId, { process, claims: new Map() });
        return true;
      }
      yield* quiesced(owner.process);
      for (const [phase, claim] of owner.claims) {
        if (phase !== "capture") yield* Deferred.await(claim.done);
      }
      return yield* reconcile(input, false);
    }),
    complete: Effect.fn("FactoryExecutionLifecycle.complete")(function* (input) {
      const managed = yield* binding(input);
      if (managed === null) return true;
      yield* store.requestNativeStop({
        threadId: input.threadId,
        runId: input.runId,
        detail: "Observed terminal; prohibit all future native phases while joining claimants.",
      });
      const owner = owners.get(input.runAttemptId);
      if (owner !== undefined) {
        yield* quiesced(owner.process);
        for (const claim of owner.claims.values()) yield* Deferred.await(claim.done);
      }
      return yield* reconcile(input);
    }),
  });
});

export const layer = Layer.effect(FactoryExecutionLifecycle, make);
