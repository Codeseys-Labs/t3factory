import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryDeliveryError,
  FactoryOriginKey,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  SourceControlProviderKind,
  ThreadId,
  type FactoryCommitDeliveryIntent,
  type FactoryExecutionBinding,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as DeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import * as ExecutionStore from "../persistence/FactoryExecutionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as FactoryDeliveryService from "./FactoryDeliveryService.ts";
import { canonicalExecutionJson } from "./FactoryExecutionDigest.ts";
import * as FactoryExecutionLifecycle from "./FactoryExecutionLifecycle.ts";
import * as FactoryWatchdog from "./FactoryWatchdog.ts";

const at = "2026-11-05T00:00:00.000Z";

const binding = (name: string): FactoryExecutionBinding => ({
  selection: {
    ref: {
      environmentId: EnvironmentId.make("local"),
      projectId: ProjectId.make("project"),
      rootId: "plan",
    },
    revision: 1,
    taskId: name,
  },
  grantVersion: 1,
  taskVersion: 1,
  commandId: CommandId.make(`admit:${name}`),
  threadId: ThreadId.make(`thread:${name}`),
  runId: RunId.make(`run:${name}`),
  runAttemptId: RunAttemptId.make(`attempt:${name}`),
  driver: ProviderDriverKind.make("codex"),
  spec: {
    taskId: name,
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
  admittedAt: at,
  stopRequested: true,
  quiescent: false,
});

// A stopped attempt whose one claimant, from a process that is gone, left this observation.
const holdAttempt = (name: string, observation: "unknown" | "quiescent") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const held = binding(name);
    yield* sql`INSERT INTO factory_execution_bindings(attempt_id, run_id, thread_id, root_id, revision, task_id, grant_version, binding_json, stop_requested) VALUES (${held.runAttemptId}, ${held.runId}, ${held.threadId}, 'plan', 1, ${name}, 1, ${canonicalExecutionJson(held)}, 1)`;
    yield* sql`INSERT INTO factory_execution_phases(attempt_id, phase, claimant_id, observation, detail) VALUES (${held.runAttemptId}, 'workspace', 'claimant', ${observation}, '')`;
    return held;
  });

const intent = (id: string): FactoryCommitDeliveryIntent => ({
  id,
  originKey: FactoryOriginKey.make(`github:github.com/owner/repo#${id}`),
  threadId: ThreadId.make(`thread:${id}`),
  projectId: ProjectId.make("project"),
  kind: "publish-pr",
  acceptanceId: `acceptance:${id}`,
  repository: {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    repository: "owner/repo",
    canonicalKey: "github.com/owner/repo",
    url: "https://github.com/owner/repo",
  },
  baseRef: "main",
  baseBranch: "main",
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  payload: { title: "Title", body: "Body", draft: false },
  payloadDigest: "d".repeat(64),
  grantedBy: EnvironmentId.make("environment"),
  grantedAt: at,
  requestCommandId: `command:${id}`,
  status: "pending",
  remote: null,
  failure: null,
  updatedAt: at,
});

const deliver = (id: string, settlement: DeliveryStore.FactoryDeliverySettlement) =>
  Effect.gen(function* () {
    const store = yield* DeliveryStore.FactoryDeliveryStore;
    yield* store.grant(intent(id), { recheck: Effect.void, enqueue: Effect.void });
    yield* store.settle(id, settlement);
  });
const unconfirmed = { status: "unknown", failure: "response lost", updatedAt: at } as const;

const storage = Layer.mergeAll(ExecutionStore.layer, DeliveryStore.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Sqlite.layerMemory, NodeCrypto.layer)),
);
const watchdog = (
  reconcile: FactoryDeliveryService.FactoryDeliveryService["Service"]["reconcile"],
) =>
  FactoryWatchdog.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FactoryExecutionLifecycle.layer,
        Layer.mock(FactoryDeliveryService.FactoryDeliveryService)({ reconcile }),
      ),
    ),
  );

it.effect(
  "retries held attempts every tick, settling only on durable proof and leaving the worker's alone",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* holdAttempt("proven-later", "unknown");
      yield* holdAttempt("never-proven", "unknown");
      // Its phases already prove quiescence, but its stop effect is still running.
      const stopping = yield* holdAttempt("stopping", "quiescent");
      yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, attempt_count, available_at, created_at, updated_at) VALUES ('effect:stop', 'command:stop', ${stopping.threadId}, 'factory.execution.stop', '{}', 'running', 1, ${at}, ${at}, ${at})`;
      yield* deliver("marker", unconfirmed);
      const settled = Effect.gen(function* () {
        const rows = yield* sql<{
          readonly id: string;
        }>`SELECT attempt_id AS id FROM factory_execution_bindings WHERE quiescent = 1 ORDER BY attempt_id`;
        return rows.map((row) => row.id);
      });
      // Attempts go before deliveries, so the marker's re-check ends a tick's attempt pass.
      const attemptsDone = yield* Queue.unbounded<string>();

      yield* Effect.gen(function* () {
        yield* Queue.take(attemptsDone);
        assert.deepEqual(yield* settled, []);

        yield* sql`UPDATE factory_execution_phases SET observation = 'quiescent' WHERE attempt_id = 'attempt:proven-later'`;
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE effect_id = 'effect:stop'`;
        yield* TestClock.adjust("5 minutes");
        yield* Queue.take(attemptsDone);
        assert.deepEqual(yield* settled, ["attempt:proven-later", "attempt:stopping"]);
      }).pipe(
        Effect.provide(
          watchdog((input) =>
            Queue.offer(attemptsDone, input.intentId).pipe(Effect.as(intent(input.intentId))),
          ),
        ),
      );
    }).pipe(
      Effect.provide(storage),
      // Linux cgroups can outlive the server, so a missing owner never expires a claim here.
      Effect.provideService(HostProcess.Platform, "linux"),
    ),
);

it.effect("re-checks unconfirmed deliveries one page per tick and keeps going past failures", () =>
  Effect.gen(function* () {
    const ids = Array.from({ length: 21 }, (_, i) => `delivery-${String(i).padStart(2, "0")}`);
    for (const id of ids) yield* deliver(id, unconfirmed);
    // Ids that sort first, so listing either would shift the first page.
    yield* deliver("closed-confirmed", {
      status: "confirmed",
      remote: { number: 1, url: "https://github.com/owner/repo/pull/1" },
      failure: null,
      updatedAt: at,
    });
    yield* deliver("closed-failed", { status: "failed", failure: "rejected", updatedAt: at });
    const checked = yield* Queue.unbounded<readonly [number, string]>();

    yield* Effect.gen(function* () {
      const first = yield* Queue.takeN(checked, 20);
      const start = first[0]![0];
      assert.deepEqual(first, ids.slice(0, 20).map((id) => [start, id] as const));
      yield* TestClock.adjust("5 minutes");
      assert.deepEqual(yield* Queue.take(checked), [start + 300_000, ids[20]!] as const);
      yield* TestClock.adjust("5 minutes");
      assert.deepEqual(yield* Queue.take(checked), [start + 600_000, ids[0]!] as const);
    }).pipe(
      Effect.provide(
        watchdog((input) =>
          Effect.gen(function* () {
            yield* Queue.offer(checked, [yield* Clock.currentTimeMillis, input.intentId] as const);
            if (input.intentId === ids[0])
              return yield* new FactoryDeliveryError({ reason: "worktree-unavailable" });
            if (input.intentId === ids[1]) return yield* Effect.die("forge client crashed");
            return intent(input.intentId);
          }),
        ),
      ),
    );
  }).pipe(Effect.provide(storage)),
);
