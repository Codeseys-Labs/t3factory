import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  FactoryExecutionError,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type FactoryExecutionBinding,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Store from "../persistence/FactoryExecutionStore.ts";
import * as Lifecycle from "./FactoryExecutionLifecycle.ts";

const owner: FactoryExecutionBinding = {
  selection: {
    ref: {
      environmentId: EnvironmentId.make("local"),
      projectId: ProjectId.make("project"),
      rootId: "plan",
    },
    revision: 1,
    taskId: "root",
  },
  grantVersion: 1,
  taskVersion: 1,
  commandId: CommandId.make("admit"),
  threadId: ThreadId.make("managed"),
  runId: RunId.make("run"),
  runAttemptId: RunAttemptId.make("attempt"),
  driver: ProviderDriverKind.make("codex"),
  spec: {
    taskId: "root",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "luna" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    setup: "deny",
    output: { slot: "draft", kind: "sealed-draft" },
  },
  inputDigest: "a".repeat(64),
  inputText: "Frozen input",
  prerequisites: [],
  admittedAt: "2026-11-05T00:00:00.000Z",
  stopRequested: false,
  quiescent: false,
};

const harness = Effect.gen(function* () {
  let stopped = false;
  let released = false;
  let quiet = true;
  const claims = new Map<string, { claimantId: string; settled: boolean }>();
  const observations: string[] = [];
  const store = Layer.mock(Store.FactoryExecutionStore)({
    findNativeBinding: ({ threadId }) =>
      Effect.succeed(
        threadId === owner.threadId
          ? { ...owner, stopRequested: stopped, quiescent: released }
          : null,
      ),
    hasNativeClaims: () => Effect.succeed(claims.size > 0),
    readCapture: () => Effect.succeed(null),
    canBeginCapture: () => Effect.succeed(false),
    claimPhase: ({ phase, claimantId }) =>
      Effect.sync(() => {
        if (claims.has(phase)) return { status: "held" } as const;
        if (stopped && phase !== "capture") return { status: "suppressed" } as const;
        claims.set(phase, { claimantId, settled: false });
        observations.push(`claim:${phase}`);
        return { status: "claimed" } as const;
      }),
    requestNativeStop: () =>
      Effect.sync(() => {
        stopped = true;
        observations.push("stop");
      }),
    settlePhase: ({ phase, claimantId, observation }) =>
      Effect.gen(function* () {
        const claim = claims.get(phase);
        if (claim?.claimantId !== claimantId)
          return yield* new FactoryExecutionError({ reason: "task-conflict" });
        observations.push(`settle:${phase}:${observation}`);
        if (observation !== "unknown") claim.settled = true;
      }),
    settleAttempt: () =>
      Effect.gen(function* () {
        if (!stopped || [...claims.values()].some((claim) => !claim.settled))
          return yield* new FactoryExecutionError({ reason: "not-quiescent" });
        released = true;
        observations.push("release");
      }),
    expireOrphanClaims: () =>
      Effect.sync(() => {
        for (const [phase, claim] of claims)
          if (!claim.settled) {
            claim.settled = true;
            observations.push(`expire:${phase}`);
          }
      }),
  });
  const lifecycle = yield* Lifecycle.FactoryExecutionLifecycle.pipe(
    Effect.provide(Lifecycle.layer.pipe(Layer.provide(Layer.mergeAll(store, NodeCrypto.layer)))),
    Effect.provideService(Lifecycle.FactoryOwnedProcessFactory, {
      make: () =>
        Effect.succeed({
          awaitRootExits: Effect.void,
          spawner: { spawn: () => Effect.die("This test must not spawn a process.") },
          quiesce: () =>
            Effect.sync(() => {
              observations.push("observe-owned-job");
              return quiet;
            }),
        }),
    }),
  );
  return {
    lifecycle,
    observations,
    released: () => released,
    setQuiet: (value: boolean) => {
      quiet = value;
    },
    seedOrphan: (phase: string) => {
      claims.set(phase, { claimantId: `dead-${phase}`, settled: false });
      observations.push(`orphan:${phase}`);
    },
  };
});

it.effect(
  "keeps a stopped claimant owned until its delayed work joins, and suppresses a subsequent phase",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const work = h.lifecycle.runPhase(
        { ...owner, phase: "workspace" },
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(resume);
          h.observations.push("claimant-joined");
        }),
      );
      const fiber = yield* work.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      assert.isFalse(yield* h.lifecycle.stop(owner));
      assert.isFalse(h.released());
      let started = false;
      const denied = yield* h.lifecycle
        .runPhase(
          { ...owner, phase: "session" },
          Effect.sync(() => {
            started = true;
          }),
        )
        .pipe(Effect.flip);
      assert.equal(denied.reason, "grant-inactive");
      assert.isFalse(started);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(fiber);
      assert.isTrue(h.released());
      assert.isBelow(h.observations.indexOf("claimant-joined"), h.observations.indexOf("release"));
    }),
);

it.effect(
  "does not interpret a terminal callback or completed phase as owned writer quiescence",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.lifecycle.runPhase({ ...owner, phase: "turn" }, Effect.void);
      h.setQuiet(false);
      assert.isFalse(yield* h.lifecycle.complete(owner));
      assert.isFalse(h.released());
      assert.isFalse(h.observations.some((observation) => observation.endsWith(":quiescent")));
      assert.isTrue(h.observations.includes("settle:turn:unknown"));
      h.setQuiet(true);
      assert.isTrue(yield* h.lifecycle.complete(owner));
      assert.isTrue(h.released());
    }),
);

it.effect(
  "never reruns an acquired phase and never grants ordinary sends on a terminal managed thread",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      let calls = 0;
      yield* h.lifecycle.runPhase(
        { ...owner, phase: "session" },
        Effect.sync(() => {
          calls++;
        }),
      );
      const replay = yield* h.lifecycle
        .runPhase(
          { ...owner, phase: "session" },
          Effect.sync(() => {
            calls++;
          }),
        )
        .pipe(Effect.flip);
      assert.equal(replay.reason, "not-quiescent");
      assert.equal(calls, 1);
      yield* h.lifecycle.complete(owner);
      const command = {
        type: "prepared-run.retry",
        commandId: CommandId.make("fresh-key"),
        threadId: owner.threadId,
        runId: owner.runId,
      } as const;
      assert.equal(
        (yield* h.lifecycle.guardCommand(command).pipe(Effect.flip)).reason,
        "grant-inactive",
      );
      yield* h.lifecycle.guardCommand({ ...command, threadId: ThreadId.make("unrelated") });
      const mismatch = yield* h.lifecycle
        .binding({ ...owner, runAttemptId: RunAttemptId.make("foreign") })
        .pipe(Effect.flip);
      assert.equal(mismatch.reason, "task-conflict");
    }),
);

it.effect(
  "joins provider writers without releasing the reservation before the separately claimed capture",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.lifecycle.runPhase({ ...owner, phase: "turn" }, Effect.void);
      assert.isTrue(yield* h.lifecycle.quiesce(owner));
      assert.isFalse(h.released());
      assert.isFalse(h.observations.includes("release"));
      let captured = false;
      yield* h.lifecycle.runPhase(
        { ...owner, phase: "capture" },
        Effect.sync(() => {
          assert.isFalse(h.released());
          captured = true;
          h.observations.push("retained-capture");
        }),
      );
      assert.isTrue(captured);
      assert.isTrue(h.released());
      assert.isBelow(h.observations.indexOf("retained-capture"), h.observations.indexOf("release"));
    }),
);

it.effect(
  "recovers a committed but entirely unclaimed obligation without inventing cancellation or a second attempt",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.lifecycle.recover(owner);
      assert.isFalse(h.observations.includes("stop"));
      assert.isFalse(h.released());
      let began = false;
      yield* h.lifecycle.runPhase(
        { ...owner, phase: "workspace" },
        Effect.sync(() => {
          began = true;
        }),
      );
      assert.isTrue(began);
      assert.deepEqual(h.observations, ["claim:workspace"]);
    }),
);

it.effect("expires orphaned claims from a dead process and settles the attempt on recovery", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    h.seedOrphan("workspace");
    h.seedOrphan("native-thread");
    yield* h.lifecycle.recover(owner);
    assert.isTrue(h.observations.includes("stop"));
    assert.isTrue(h.observations.includes("expire:workspace"));
    assert.isTrue(h.observations.includes("expire:native-thread"));
    assert.isTrue(h.released());
  }),
);
