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
