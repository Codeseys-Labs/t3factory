import { assert, it } from "@effect/vitest";
import {
  CommandId,
  OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { planNativeExecution } from "./NativeExecutionPlan.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { applyToProjection, emptyProjection } from "./ProjectionStore.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { validateNativeExecutionCapabilities } from "./NativeExecutionPlan.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { PosixCgroupController } from "../process/PosixOwnedProcess.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);
it.effect(
  "plans schema-valid native preparation and attempt binding without opening a provider",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("devReplay");
      const adapter = yield* ProviderAdapter.ProviderAdapterV2.pipe(
        Effect.provide(
          Layer.mock(ProviderAdapter.ProviderAdapterV2)({
            instanceId,
            driver: ProviderDriverKind.make("acpRegistry"),
            getCapabilities: () =>
              Effect.succeed({ ...CodexProviderCapabilitiesV2, ownedWriters: true }),
            openSession: () => Effect.die("Native planning must not open a session."),
          }),
        ),
      );
      const plan = yield* planNativeExecution({
        commandId: CommandId.make("admit-root"),
        threadId: ThreadId.make("native-root"),
        projectId: ProjectId.make("local"),
        title: "One supplied note",
        modelSelection: { instanceId, model: "replay" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        text: "Exact immutable input",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "server",
        now: DateTime.makeUnsafe("2026-11-05T00:00:00.000Z"),
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provide(IdAllocator.layer),
        Effect.provideService(ProviderAdapterRegistryV2, {
          get: () => Effect.succeed(adapter),
          list: () => Effect.succeed([instanceId]),
        }),
      );
      for (const event of plan.events) assert.isTrue(isDomainEvent(event));
      const created = plan.events.find((event) => event.type === "thread.created");
      if (created?.type !== "thread.created")
        return yield* Effect.die("Missing native thread event.");
      const projection = plan.events.reduce(applyToProjection, emptyProjection(created));
      assert.equal(projection.runs.length, 1);
      assert.equal(projection.attempts.length, 1);
      assert.equal(projection.runs[0]?.id, plan.runId);
      assert.equal(projection.runs[0]?.activeAttemptId, plan.runAttemptId);
      assert.equal(projection.runs[0]?.status, "preparing");
      assert.equal(projection.attempts[0]?.runId, plan.runId);
      assert.equal(projection.attempts[0]?.id, plan.runAttemptId);
      assert.equal(projection.providerThreads[0]?.driver, plan.driver);
      assert.equal(projection.providerSessions.length, 0);
      assert.equal(projection.providerTurns.length, 0);
      assert.equal(plan.effects.length, 1);
      assert.deepEqual(plan.effects[0]?.request, {
        type: "factory.execution.prepare",
        runId: plan.runId,
        runAttemptId: plan.runAttemptId,
      });
    }),
);

it.effect("refuses missing adapter ownership and admits Linux only with proven delegation", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex-without-ownership");
    for (const ownedWriters of [undefined, false, true]) {
      const adapter = yield* ProviderAdapter.ProviderAdapterV2.pipe(
        Effect.provide(
          Layer.mock(ProviderAdapter.ProviderAdapterV2)({
            instanceId,
            driver: ProviderDriverKind.make("codex"),
            getCapabilities: () =>
              Effect.succeed({
                ...CodexProviderCapabilitiesV2,
                ownedWriters: ownedWriters === true,
              }),
          }),
        ),
      );
      let removed = 0;
      const result = yield* validateNativeExecutionCapabilities(
        { modelSelection: { instanceId, model: "fixture" } },
        [],
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(PosixCgroupController, {
          create: () => ({
            path: "/delegated/probe",
            relativePath: "/probe",
            contains: () => false,
            exists: () => true,
            kill: () => {},
            populated: () => false,
            remove: () => {
              removed++;
            },
          }),
        }),
        Effect.provideService(ProviderAdapterRegistryV2, {
          get: () => Effect.succeed(adapter),
          list: () => Effect.succeed([instanceId]),
        }),
        Effect.result,
      );
      assert.equal(result._tag, ownedWriters === true ? "Success" : "Failure");
      assert.equal(removed, ownedWriters === true ? 1 : 0);
      if (result._tag === "Failure") assert.include(result.failure.message, "writers");
    }
  }),
);

it.effect("admits by owned-writer capability and refuses unsupported guarantees", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("another-account");
    for (const driver of [
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
      "antigravity",
      "acpRegistry",
      "pi",
    ] as const) {
      const adapter = yield* ProviderAdapter.ProviderAdapterV2.pipe(
        Effect.provide(
          Layer.mock(ProviderAdapter.ProviderAdapterV2)({
            instanceId,
            driver: ProviderDriverKind.make(driver),
            getCapabilities: () =>
              Effect.succeed({ ...CodexProviderCapabilitiesV2, ownedWriters: true }),
          }),
        ),
      );
      const validate = (
        required: ReadonlyArray<"owned-writers" | "hard-cost-limit" | "external-actions-denied">,
      ) =>
        validateNativeExecutionCapabilities(
          { modelSelection: { instanceId, model: "fixture" } },
          required,
        ).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(ProviderAdapterRegistryV2, {
            get: () => Effect.succeed(adapter),
            list: () => Effect.succeed([instanceId]),
          }),
        );
      yield* validate(["owned-writers"]);
      for (const capability of ["hard-cost-limit", "external-actions-denied"] as const) {
        assert.equal(
          (yield* validate([capability]).pipe(Effect.flip)).reason,
          "unsupported-capability",
        );
      }
    }
  }),
);
