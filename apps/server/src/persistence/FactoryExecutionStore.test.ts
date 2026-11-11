import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RunAttemptId,
  ThreadId,
  NodeId,
  ProviderSessionId,
  ProviderTurnId,
  RuntimeRequestId,
  TurnItemId,
  type ProviderApprovalOption,
  type FactoryExecutionPolicy,
  type FactoryExecutionRetryInput,
  type FactoryExecutionAdmitInput,
  type FactoryPlanSnapshot,
  type FactoryExecutionBinding,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./FactoryExecutionStore.ts";
import * as Sqlite from "./Sqlite.ts";
import * as AuthSessions from "./AuthSessions.ts";
import { canonicalExecutionJson, executionDigest } from "../factory/FactoryExecutionDigest.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { planNativeExecution } from "../orchestration-v2/NativeExecutionPlan.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";

const ref = {
  environmentId: EnvironmentId.make("local"),
  projectId: ProjectId.make("project"),
  rootId: "root",
};
const selection = { ref, revision: 1, taskId: "root" };
const human = { kind: "human", sessionId: AuthSessionId.make("human") } as const;
const at = "2026-11-05T00:00:00.000Z";
const policy: FactoryExecutionPolicy = {
  version: 1,
  requesterThreadIds: [],
  tasks: [
    {
      taskId: "root",
      modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "replay" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      setup: "deny",
      output: { slot: "draft", kind: "sealed-draft" },
    },
  ],
  edges: [],
  maxAttempts: 3,
  maxConcurrent: 1,
  maxRetriesPerTask: 2,
  expiresAt: "2099-01-01T00:00:00.000Z",
  requiredCapabilities: [],
};
const plan: FactoryPlanSnapshot = {
  ref,
  revision: 1,
  tasks: [
    {
      id: "root",
      parentId: null,
      title: "Supplied note",
      context: "Exact local note",
      order: 0,
      retired: false,
    },
  ],
  edges: [],
  workContexts: [],
  editorThreadIds: [],
  createdAt: at,
  updatedAt: at,
};
const layer = Layer.mergeAll(Store.layer, AuthSessions.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${ref.projectId},'Local','/local','[]',${at},${at})`;
  const snapshot = canonicalExecutionJson(plan);
  const summary = canonicalExecutionJson({
    ref,
    revision: 1,
    title: "Supplied note",
    retired: false,
    updatedAt: at,
  });
  yield* sql`INSERT INTO factory_plan_heads(root_id,project_id,revision,snapshot_json,summary_json) VALUES ('root',${ref.projectId},1,${snapshot},${summary})`;
  yield* sql`INSERT INTO factory_plan_revisions(root_id,revision,snapshot_json,summary_json) VALUES ('root',1,${snapshot},${summary})`;
  yield* (yield* AuthSessions.AuthSessionRepository).create({
    sessionId: human.sessionId,
    subject: "human",
    scopes: [AuthOrchestrationOperateScope],
    method: "browser-session-cookie",
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
    issuedAt: DateTime.makeUnsafe(at),
    expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
  });
});
const decide = Effect.fn("test.decide")(function* (
  operation: Store.ExecutionOperation,
  actor: Store.FactoryExecutionActor = human,
) {
  const store = yield* Store.FactoryExecutionStore;
  const sql = yield* SqlClient.SqlClient;
  const commandId =
    "commandId" in operation.input
      ? operation.input.commandId
      : CommandId.make(`observe:${executionDigest(operation.input)}`);
  return yield* sql.withTransaction(
    store.decide({
      commandId,
      ref,
      revision: 1,
      actor,
      now: at,
      digest: executionDigest(operation.input),
      operation,
    }),
  );
});
const grant = decide({
  type: "grant",
  input: {
    commandId: CommandId.make("grant"),
    ref,
    expectedRevision: 1,
    expectedGrantVersion: 0,
    policy,
  },
});
const bindingFor = Effect.fn("test.bindingFor")(function* (command = "start", version = 0) {
  const store = yield* Store.FactoryExecutionStore;
  const input = {
    commandId: CommandId.make(command),
    selection,
    grantVersion: 1,
    expectedTaskVersion: version,
  };
  const prepared = yield* store.prepareAdmission(input, human, at);
  const binding: FactoryExecutionBinding = {
    selection,
    grantVersion: 1,
    taskVersion: prepared.taskVersion,
    commandId: input.commandId,
    threadId: ThreadId.make(`thread:${command}`),
    runId: RunId.make(`run:${command}`),
    runAttemptId: RunAttemptId.make(`attempt:${command}`),
    driver: ProviderDriverKind.make("acpRegistry"),
    spec: prepared.spec,
    inputText: prepared.inputText,
    inputDigest: prepared.inputDigest,
    prerequisites: prepared.prerequisites,
    admittedAt: at,
    stopRequested: false,
    quiescent: false,
  };
  return { input, binding };
});
const nativeTerminal = Effect.fn("test.nativeTerminal")(function* (
  binding: FactoryExecutionBinding,
  status: "failed" | "completed" = "completed",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,provider_thread_id,status,requested_at,payload_json) VALUES (${binding.runId},${binding.threadId},1,'devReplay','devReplay','native',${status},${at},${canonicalExecutionJson({ status })})`;
  yield* sql`INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_instance_id,provider_thread_id,status,payload_json) VALUES (${binding.runAttemptId},${binding.threadId},${binding.runId},1,'root-node','devReplay','devReplay','native',${status},${canonicalExecutionJson({ status })})`;
});

it.effect(
  "grants a human root-only note without a requester or Git while denying self-grant and unlisted agents",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.FactoryExecutionStore;
      assert.equal((yield* grant).error, null);
      assert.equal((yield* store.readExecution({ ref, revision: 1 })).tasks[0]!.version, 0);
      const prepared = yield* bindingFor();
      assert.include(prepared.binding.inputText, "Exact local note");
      const agent = { kind: "agent", threadId: ThreadId.make("unlisted") } as const;
      assert.isTrue(
        Result.isFailure(
          yield* store.prepareAdmission(prepared.input, agent, at).pipe(Effect.result),
        ),
      );
      assert.isTrue(
        Result.isFailure(
          yield* decide(
            {
              type: "grant",
              input: {
                commandId: CommandId.make("self-grant"),
                ref,
                expectedRevision: 1,
                expectedGrantVersion: 1,
                policy,
              },
            },
            agent,
          ).pipe(Effect.result),
        ),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "serializes competing task admissions, retains terminal dedup and rejects payload reuse",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* grant;
      const first = yield* bindingFor("first");
      const second = yield* bindingFor("second");
      const outcomes = yield* Effect.all(
        [decide({ type: "admit", ...first }), decide({ type: "admit", ...second })],
        { concurrency: "unbounded" },
      );
      assert.equal(outcomes.filter((entry) => entry.error === null).length, 1);
      const winner = outcomes[0]!.error === null ? first : second;
      yield* nativeTerminal(winner.binding);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE factory_execution_bindings SET quiescent = 1, stop_requested = 1`;
      assert.isTrue((yield* decide({ type: "admit", ...winner })).replayed);
      const fresh = yield* decide({
        type: "admit",
        input: { ...winner.input, commandId: CommandId.make("new-key"), expectedTaskVersion: 1 },
        binding: { ...winner.binding, commandId: CommandId.make("new-key"), taskVersion: 2 },
      });
      assert.equal(fresh.error, "task-conflict");
      const conflict = yield* decide({
        type: "admit",
        input: { ...winner.input, grantVersion: 2 },
        binding: winner.binding,
      }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(conflict));
      assert.equal((yield* sql`SELECT attempt_id FROM factory_execution_bindings`).length, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "holds repeated and unknown phase claims and suppresses revoked or edited heads without releasing capacity",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* grant;
      const admitted = yield* bindingFor();
      yield* decide({ type: "admit", ...admitted });
      const store = yield* Store.FactoryExecutionStore;
      const claim = {
        runAttemptId: admitted.binding.runAttemptId,
        phase: "workspace",
        claimantId: "owner",
      } as const;
      assert.equal((yield* store.claimPhase(claim)).status, "claimed");
      assert.equal((yield* store.claimPhase(claim)).status, "held");
      yield* store.requestNativeStop({ threadId: admitted.binding.threadId, detail: "stop" });
      yield* store.settlePhase({ ...claim, observation: "unknown", detail: "lost handle" });
      assert.isTrue(
        Result.isFailure(
          yield* store
            .settleAttempt({
              runAttemptId: claim.runAttemptId,
              observation: "no-start",
              detail: "no PID",
            })
            .pipe(Effect.result),
        ),
      );
      assert.equal((yield* store.claimPhase({ ...claim, phase: "session" })).status, "suppressed");
      assert.isFalse((yield* store.getBinding(claim.runAttemptId)).quiescent);
      assert.isTrue(
        Result.isFailure(
          yield* store
            .settlePhase({
              ...claim,
              claimantId: "other",
              observation: "quiescent",
              detail: "wrong owner",
            })
            .pipe(Effect.result),
        ),
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE factory_plan_heads SET revision = 2, snapshot_json = ${canonicalExecutionJson({ ...plan, revision: 2 })}`;
      assert.equal((yield* store.claimPhase({ ...claim, phase: "turn" })).status, "suppressed");
      assert.equal(
        (yield* store.findNativeBinding({
          threadId: admitted.binding.threadId,
          runId: RunId.make("wrong"),
        }))!.runId,
        admitted.binding.runId,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "expires orphaned phase claims from a dead claimant so recovery settles the attempt",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* grant;
      const admitted = yield* bindingFor("orphan");
      yield* decide({ type: "admit", ...admitted });
      const store = yield* Store.FactoryExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      const workspace = {
        runAttemptId: admitted.binding.runAttemptId,
        phase: "workspace",
        claimantId: "dead-process",
      } as const;
      const session = { ...workspace, phase: "session" } as const;
      assert.equal((yield* store.claimPhase(workspace)).status, "claimed");
      assert.equal((yield* store.claimPhase(session)).status, "claimed");
      yield* store.requestNativeStop({ threadId: admitted.binding.threadId, detail: "restart" });
      yield* store.settlePhase({ ...workspace, observation: "unknown", detail: "lost handle" });
      yield* store.settlePhase({ ...session, observation: "quiescent", detail: "joined" });
      assert.isTrue(
        Result.isFailure(
          yield* store
            .settleAttempt({
              runAttemptId: workspace.runAttemptId,
              observation: "no-start",
              detail: "orphan",
            })
            .pipe(Effect.result),
        ),
      );
      yield* store.expireOrphanClaims({ runAttemptId: workspace.runAttemptId });
      const phases = yield* sql<{
        phase: string;
        observation: string;
      }>`SELECT phase, observation FROM factory_execution_phases WHERE attempt_id = ${workspace.runAttemptId} ORDER BY phase`;
      assert.deepEqual(
        phases.map((row) => [row.phase, row.observation]),
        [
          ["session", "quiescent"],
          ["workspace", "no-start"],
        ],
      );
      const first = yield* store.settlements.pipe(
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* store.settleAttempt({
        runAttemptId: RunAttemptId.make("attempt:unobserved"),
        observation: "unknown",
        detail: "Not observed yet.",
      });
      yield* store.settleAttempt({
        runAttemptId: workspace.runAttemptId,
        observation: "no-start",
        detail: "Claimant process exited without settling; expired by recovery.",
      });
      assert.isTrue((yield* store.getBinding(workspace.runAttemptId)).quiescent);
      assert.deepEqual(yield* Fiber.join(first), Option.some(workspace.runAttemptId));
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "retains exact large UTF-8 bytes, separates old results from selection, and accepts revoked-grant preparation then reopens idle",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* grant;
      const admitted = yield* bindingFor();
      yield* decide({ type: "admit", ...admitted });
      yield* nativeTerminal(admitted.binding);
      const store = yield* Store.FactoryExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE factory_execution_bindings SET quiescent = 1, stop_requested = 1`;
      const observation: Store.ObserveResultInput = {
        runId: admitted.binding.runId,
        runAttemptId: admitted.binding.runAttemptId,
        captureKey: "final",
        slot: "draft",
        text: "α\r\n ".repeat(300),
        status: "sealed",
        checkpoint: null,
      };
      const selected = yield* decide(
        { type: "observe", input: observation },
        { kind: "automation" },
      );
      assert.isTrue(selected.advance);
      const output = selected.result!.tasks[0]!.selectedResult!;
      assert.isAbove(output.byteLength, 256);
      assert.equal(
        (yield* store.readOutput({ selection, resultId: output.resultId })).text,
        observation.text,
      );
      assert.isTrue(
        Result.isFailure(
          yield* store.retainCapture({ ...observation, text: "changed" }).pipe(Effect.result),
        ),
      );
      yield* decide({
        type: "revoke",
        input: {
          commandId: CommandId.make("revoke"),
          ref,
          expectedRevision: 1,
          expectedGrantVersion: 1,
        },
      });
      const digest = selected.result!.assembly!.digest;
      const accepted = yield* decide({
        type: "accept",
        input: {
          commandId: CommandId.make("accept"),
          selection,
          expectedDigest: digest,
          scope: "local-preparation",
          delivery: "outstanding",
        },
      });
      assert.equal(accepted.error, null);
      const late = yield* decide(
        { type: "observe", input: { ...observation, captureKey: "late", text: "late bytes" } },
        { kind: "automation" },
      );
      assert.isFalse(late.advance);
      assert.equal(late.result!.tasks[0]!.selectedResult!.resultId, output.resultId);
      assert.equal(late.result!.acceptance!.digest, digest);
      const reopened = yield* decide({
        type: "reopen",
        input: { commandId: CommandId.make("reopen"), selection, expectedDigest: digest },
      });
      assert.isTrue(reopened.result!.reopened);
      assert.isFalse(reopened.executeNative);
      assert.equal((yield* sql`SELECT attempt_id FROM factory_execution_bindings`).length, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "CASes nullable retry result against every captured result, including unselected failure captures",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* grant;
      const admitted = yield* bindingFor();
      yield* decide({ type: "admit", ...admitted });
      yield* nativeTerminal(admitted.binding, "failed");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE factory_execution_bindings SET quiescent = 1, stop_requested = 1`;
      const store = yield* Store.FactoryExecutionStore;
      const retry = {
        commandId: CommandId.make("retry"),
        selection,
        grantVersion: 1,
        expectedTaskVersion: 1,
        priorRunId: admitted.binding.runId,
        priorRunAttemptId: admitted.binding.runAttemptId,
        priorResultId: null,
        intent: "retry",
      } as const;
      assert.equal((yield* store.prepareAdmission(retry, human, at)).taskVersion, 2);
      yield* store.retainCapture({
        runId: admitted.binding.runId,
        runAttemptId: admitted.binding.runAttemptId,
        captureKey: "late-failure",
        slot: "draft",
        text: "failed preparation",
        status: "failed",
        checkpoint: null,
      });
      const changed = yield* store.prepareAdmission(retry, human, at).pipe(Effect.result);
      assert.isTrue(Result.isFailure(changed));
      if (Result.isFailure(changed)) assert.equal(changed.failure.reason, "task-conflict");
    }).pipe(Effect.provide(layer)),
);

const eventDependencies = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const atomicLayer = Layer.mergeAll(Store.layer, AuthSessions.layer, EventSink.layer).pipe(
  Layer.provideMerge(eventDependencies),
);
it.effect(
  "commits native IDs, preparation obligation and admission together, and rolls all of them back on invalid native events",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* grant;
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const prepared = yield* bindingFor("atomic");
      const instanceId = ProviderInstanceId.make("devReplay");
      const adapter = yield* ProviderAdapter.ProviderAdapterV2.pipe(
        Effect.provide(
          Layer.mock(ProviderAdapter.ProviderAdapterV2)({
            instanceId,
            driver: ProviderDriverKind.make("acpRegistry"),
            openSession: () => Effect.die("Preparation must not execute during admission"),
          }),
        ),
      );
      const native = yield* planNativeExecution({
        commandId: prepared.input.commandId,
        threadId: prepared.binding.threadId,
        projectId: ref.projectId,
        title: "Root",
        modelSelection: prepared.binding.spec.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        text: prepared.binding.inputText,
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "server",
        now: DateTime.makeUnsafe(at),
      }).pipe(
        Effect.provide(IdAllocator.layer),
        Effect.provideService(ProviderAdapterRegistryV2, {
          get: () => Effect.succeed(adapter),
          list: () => Effect.succeed([instanceId]),
        }),
      );
      const binding = {
        ...prepared.binding,
        runId: native.runId,
        runAttemptId: native.runAttemptId,
      };
      const command: Store.FactoryExecutionCommit = {
        commandId: prepared.input.commandId,
        ref,
        revision: 1,
        actor: human,
        now: at,
        digest: executionDigest(prepared.input),
        operation: { type: "admit", input: prepared.input, binding },
      };
      const invalid = yield* sink
        .commitFactoryExecutionCommand({ command, events: [], effects: native.effects })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(invalid));
      assert.deepEqual(yield* sql`SELECT attempt_id FROM factory_execution_bindings`, []);
      assert.deepEqual(
        yield* sql`SELECT command_id FROM factory_execution_commands WHERE command_id = ${command.commandId}`,
        [],
      );
      assert.deepEqual(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, []);
      const committed = yield* sink.commitFactoryExecutionCommand({
        command,
        events: native.events,
        effects: native.effects,
      });
      assert.equal(committed.execution.tasks[0]!.binding!.runAttemptId, native.runAttemptId);
      assert.equal(
        (yield* sql`SELECT attempt_id FROM orchestration_v2_projection_run_attempts WHERE attempt_id = ${native.runAttemptId}`)
          .length,
        1,
      );
      assert.equal(
        (yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE effect_type = 'factory.execution.prepare'`)
          .length,
        1,
      );
      assert.isTrue(
        (yield* sink.commitFactoryExecutionCommand({
          command,
          events: native.events,
          effects: native.effects,
        })).replayed,
      );
      assert.equal((yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`).length, 2);
      const approvalOptions: ReadonlyArray<ProviderApprovalOption> = [
        { decision: "accept", label: "Allow once", warning: "Review the command" },
        { decision: "acceptForSession", label: "Allow session" },
        { decision: "acceptAlways", label: "Always allow" },
        { decision: "decline", label: "Decline" },
        { decision: "cancel", label: "Cancel" },
      ];
      for (const options of [approvalOptions, undefined]) {
        const itemId = TurnItemId.make(`approval:${options ? "advertised" : "default"}`);
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${itemId}`),
              threadId: binding.threadId,
              type: "turn-item.updated",
              occurredAt: DateTime.makeUnsafe(at),
              payload: {
                id: itemId,
                threadId: binding.threadId,
                runId: native.runId,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "waiting",
                title: null,
                startedAt: DateTime.makeUnsafe(at),
                completedAt: null,
                updatedAt: DateTime.makeUnsafe(at),
                type: "approval_request",
                requestId: RuntimeRequestId.make(`request:${itemId}`),
                requestKind: "command",
                ...(options === undefined ? {} : { options }),
              },
            },
          ],
        });
        const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          binding.threadId,
        );
        const approval = projection.turnItems.find((item) => item.id === itemId);
        assert.equal(approval?.type, "approval_request");
        if (approval?.type === "approval_request") {
          assert.deepEqual(
            approval.options?.map((option) => option.decision),
            ["accept", "decline", "cancel"],
          );
          if (options !== undefined) assert.deepEqual(approval.options?.[0], approvalOptions[0]);
        }
      }
      const threadEvent = native.events.find((event) => event.type === "thread.created");
      if (threadEvent?.type !== "thread.created")
        return yield* Effect.die("Native admission must create a thread");
      const ordinaryThreadId = ThreadId.make("ordinary-approval");
      const managedProjection =
        yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(binding.threadId);
      const item = managedProjection.turnItems.find((entry) => entry.type === "approval_request");
      if (item?.type !== "approval_request")
        return yield* Effect.die("Managed approval must remain inspectable");
      yield* sink.write({
        events: [
          {
            ...threadEvent,
            id: EventId.make("ordinary-thread"),
            threadId: ordinaryThreadId,
            payload: {
              ...threadEvent.payload,
              id: ordinaryThreadId,
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: ordinaryThreadId,
              },
            },
          },
          {
            id: EventId.make("ordinary-approval"),
            threadId: ordinaryThreadId,
            type: "turn-item.updated",
            occurredAt: DateTime.makeUnsafe(at),
            payload: { ...item, threadId: ordinaryThreadId, runId: null, options: approvalOptions },
          },
        ],
      });
      const ordinaryProjection =
        yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(ordinaryThreadId);
      const ordinaryApproval = ordinaryProjection.turnItems.find(
        (entry) => entry.type === "approval_request",
      );
      assert.equal(ordinaryApproval?.type, "approval_request");
      if (ordinaryApproval?.type === "approval_request")
        assert.deepEqual(ordinaryApproval.options, approvalOptions);
    }).pipe(Effect.provide(atomicLayer)),
);

it.effect(
  "retries capture on the same native attempt only after positive claimant settlement and preserves old bytes",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* grant;
      const admitted = yield* bindingFor();
      yield* decide({ type: "admit", ...admitted });
      yield* nativeTerminal(admitted.binding);
      const store = yield* Store.FactoryExecutionStore;
      const id = admitted.binding.runAttemptId;
      yield* store.requestNativeStop({
        threadId: admitted.binding.threadId,
        detail: "provider joined",
      });
      const claim = { runAttemptId: id, phase: "capture", claimantId: "capture-one" } as const;
      assert.equal((yield* store.claimPhase(claim)).status, "claimed");
      yield* store.retainCapture({
        runId: admitted.binding.runId,
        runAttemptId: id,
        captureKey: "native-final/1",
        slot: "draft",
        text: "Retained incomplete evidence",
        status: "held",
        checkpoint: null,
      });
      const result = (yield* store.readOutputs({ ref, revision: 1, taskId: "root" })).items[0]!;
      const input = {
        commandId: CommandId.make("recapture"),
        selection,
        runId: admitted.binding.runId,
        runAttemptId: id,
        expectedResultId: result.resultId,
      };
      const unknown = yield* decide({ type: "retryCapture", input });
      assert.equal(unknown.error, "not-quiescent");
      yield* store.settlePhase({
        ...claim,
        observation: "quiescent",
        detail: "Capture claimant joined; owned jobs independently empty",
      });
      yield* store.settleAttempt({
        runAttemptId: id,
        observation: "quiescent",
        detail: "Complete capture proof",
      });
      const retry = yield* decide({
        type: "retryCapture",
        input: { ...input, commandId: CommandId.make("recapture-after-proof") },
      });
      assert.equal(retry.error, null);
      assert.isTrue(retry.executeNative);
      assert.isTrue(yield* store.canBeginCapture(id));
      assert.equal(yield* store.captureKey(id), "native-final/2");
      assert.equal(
        (yield* store.claimPhase({
          ...claim,
          claimantId: "old-finalize-replay",
          captureGeneration: 1,
        })).status,
        "held",
      );
      assert.equal(yield* store.readCapture(id), null);
      assert.equal(
        (yield* store.readOutput({ selection, resultId: result.resultId })).text,
        "Retained incomplete evidence",
      );
      assert.equal((yield* store.getBinding(id)).runId, admitted.binding.runId);
      assert.isFalse((yield* store.getBinding(id)).quiescent);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "refuses sealed code without retained verification for that exact attempt, commit and tree",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const codePolicy: FactoryExecutionPolicy = {
        ...policy,
        tasks: [
          {
            ...policy.tasks[0]!,
            workspaceStrategy: { type: "worktree", baseRef: "a".repeat(40) },
            output: { slot: "code", kind: "verified-code" },
            verification: { command: "node", args: ["--test", "focused.test.js"] },
          },
        ],
      };
      yield* decide({
        type: "grant",
        input: {
          commandId: CommandId.make("code-grant"),
          ref,
          expectedRevision: 1,
          expectedGrantVersion: 0,
          policy: codePolicy,
        },
      });
      const admitted = yield* bindingFor();
      yield* decide({ type: "admit", ...admitted });
      yield* nativeTerminal(admitted.binding);
      const store = yield* Store.FactoryExecutionStore;
      const checkpoint = {
        commit: "b".repeat(40),
        tree: "c".repeat(40),
        retainedRef: "refs/t3/factory/outputs/test",
        verificationDigest: "d".repeat(64),
      };
      const input: Store.ObserveResultInput = {
        runId: admitted.binding.runId,
        runAttemptId: admitted.binding.runAttemptId,
        captureKey: "native-final/1",
        slot: "code",
        text: "A model says tests passed",
        status: "sealed",
        checkpoint,
      };
      assert.isTrue(Result.isFailure(yield* store.retainCapture(input).pipe(Effect.result)));
      const sql = yield* SqlClient.SqlClient;
      const evidence = canonicalExecutionJson({
        commit: checkpoint.commit,
        tree: checkpoint.tree,
        retainedRef: checkpoint.retainedRef,
        passed: true,
      });
      yield* sql`INSERT INTO factory_execution_verifications(digest,attempt_id,repository_path,evidence_json) VALUES (${checkpoint.verificationDigest},'foreign-attempt','/fixture',${evidence})`;
      assert.isTrue(Result.isFailure(yield* store.retainCapture(input).pipe(Effect.result)));
      assert.deepEqual(yield* sql`SELECT result_id FROM factory_execution_results`, []);
      yield* sql`UPDATE factory_execution_verifications SET attempt_id = ${admitted.binding.runAttemptId}`;
      yield* store.retainCapture(input);
      assert.equal(
        (yield* store.readCapture(admitted.binding.runAttemptId))!.checkpoint!.tree,
        checkpoint.tree,
      );
      assert.equal(
        (yield* store.readExecution({ ref, revision: 1 })).tasks[0]!.selectedResult,
        null,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "holds R plus failed C prerequisites and pins only sealed exact outputs into D after an explicit C retry",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const mixed = {
        ...plan,
        tasks: [
          ...plan.tasks,
          ...["R", "C", "D"].map((id) => ({
            id,
            parentId: "root",
            title: id,
            context: `${id} task`,
            order: 0,
            retired: false,
          })),
        ],
        edges: [
          {
            id: "D-R",
            kind: "requires" as const,
            fromTaskId: "D",
            toTaskId: "R",
            requirement: "research",
            retired: false,
          },
          {
            id: "D-C",
            kind: "requires" as const,
            fromTaskId: "D",
            toTaskId: "C",
            requirement: "verified prototype",
            retired: false,
          },
        ],
      };
      yield* sql`UPDATE factory_plan_heads SET snapshot_json = ${canonicalExecutionJson(mixed)}`;
      yield* sql`UPDATE factory_plan_revisions SET snapshot_json = ${canonicalExecutionJson(mixed)}`;
      const mixedPolicy: FactoryExecutionPolicy = {
        ...policy,
        maxConcurrent: 2,
        maxAttempts: 4,
        tasks: [
          { ...policy.tasks[0]!, taskId: "R" },
          {
            ...policy.tasks[0]!,
            taskId: "C",
            workspaceStrategy: { type: "worktree", baseRef: "a".repeat(40) },
            verification: { command: "node", args: ["--test"] },
            output: { slot: "code", kind: "verified-code" },
          },
          { ...policy.tasks[0]!, taskId: "D" },
        ],
        edges: [
          { edgeId: "D-R", slot: "draft", rule: "sealed-draft" },
          { edgeId: "D-C", slot: "code", rule: "verified-code" },
        ],
      };
      yield* decide({
        type: "grant",
        input: {
          commandId: CommandId.make("mixed-grant"),
          ref,
          expectedRevision: 1,
          expectedGrantVersion: 0,
          policy: mixedPolicy,
        },
      });
      const store = yield* Store.FactoryExecutionStore;
      const admitTask = Effect.fn("test.admitTask")(function* (
        taskId: string,
        command: string,
        prior?: FactoryExecutionBinding,
      ) {
        const taskSelection = { ...selection, taskId };
        const input = prior
          ? {
              commandId: CommandId.make(command),
              selection: taskSelection,
              grantVersion: 1,
              expectedTaskVersion: 1,
              intent: "retry" as const,
              priorRunId: prior.runId,
              priorRunAttemptId: prior.runAttemptId,
              priorResultId: (yield* store.readOutputs({ ref, revision: 1, taskId })).items.find(
                (entry) => entry.runAttemptId === prior.runAttemptId,
              )!.resultId,
            }
          : {
              commandId: CommandId.make(command),
              selection: taskSelection,
              grantVersion: 1,
              expectedTaskVersion: 0,
            };
        const prepared = yield* store.prepareAdmission(input, human, at);
        const binding: FactoryExecutionBinding = {
          selection: taskSelection,
          grantVersion: 1,
          taskVersion: prepared.taskVersion,
          commandId: input.commandId,
          threadId: ThreadId.make(command),
          runId: RunId.make(command),
          runAttemptId: RunAttemptId.make(command),
          driver: ProviderDriverKind.make("acpRegistry"),
          spec: prepared.spec,
          inputText: prepared.inputText,
          inputDigest: prepared.inputDigest,
          prerequisites: prepared.prerequisites,
          admittedAt: at,
          stopRequested: false,
          quiescent: false,
        };
        const decision = yield* decide(
          "intent" in input
            ? { type: "retry" as const, input: input as FactoryExecutionRetryInput, binding }
            : { type: "admit" as const, input: input as FactoryExecutionAdmitInput, binding },
        );
        assert.equal(decision.error, null);
        return binding;
      });
      const research = yield* admitTask("R", "research");
      const code = yield* admitTask("C", "code");
      const finish = Effect.fn("test.finish")(function* (
        binding: FactoryExecutionBinding,
        status: "sealed" | "failed",
        checkpoint: Store.ObserveResultInput["checkpoint"] = null,
      ) {
        yield* nativeTerminal(binding, status === "sealed" ? "completed" : "failed");
        yield* sql`UPDATE factory_execution_bindings SET quiescent = 1, stop_requested = 1 WHERE attempt_id = ${binding.runAttemptId}`;
        return yield* decide(
          {
            type: "observe",
            input: {
              runId: binding.runId,
              runAttemptId: binding.runAttemptId,
              captureKey: "native-final/1",
              slot: binding.spec.output.slot,
              text: binding.selection.taskId + " exact bytes",
              status,
              checkpoint,
            },
          },
          { kind: "automation" },
        );
      });
      yield* finish(research, "sealed");
      yield* finish(code, "failed");
      const before = yield* store.readExecution({ ref, revision: 1 });
      const researchResult = before.tasks.find((task) => task.taskId === "R")!.selectedResult!
        .resultId;
      assert.isTrue(Result.isFailure(yield* admitTask("D", "held-draft").pipe(Effect.result)));
      const retried = yield* admitTask("C", "code-retry", code);
      const checkpoint = {
        commit: "b".repeat(40),
        tree: "c".repeat(40),
        retainedRef: `refs/t3/factory/outputs/${executionDigest(retried.runAttemptId)}`,
        verificationDigest: "d".repeat(64),
      };
      yield* sql`INSERT INTO factory_execution_verifications(digest,attempt_id,repository_path,evidence_json) VALUES (${checkpoint.verificationDigest},${retried.runAttemptId},'/fixture',${canonicalExecutionJson({ ...checkpoint, evidence: { code: 0, timedOut: false }, passed: true })})`;
      yield* finish(retried, "sealed", checkpoint);
      yield* sql`UPDATE factory_execution_verifications SET attempt_id = 'foreign-attempt'`;
      const draftInput = {
        commandId: CommandId.make("draft"),
        selection: { ...selection, taskId: "D" },
        grantVersion: 1,
        expectedTaskVersion: 0,
      };
      assert.equal(
        (yield* store.prepareAdmission(draftInput, human, at).pipe(Effect.flip)).reason,
        "prerequisite-held",
      );
      yield* sql`UPDATE factory_execution_verifications SET attempt_id = ${retried.runAttemptId}`;
      const draft = yield* admitTask("D", "draft");
      assert.equal(draft.prerequisites.length, 2);
      const [researchPin, codePin] = draft.prerequisites;
      assert.equal(researchPin!.resultId, researchResult);
      assert.equal(codePin!.runAttemptId, retried.runAttemptId);
      assert.equal(
        draft.inputText,
        [
          "D",
          "D task",
          [
            "Prerequisite D-R from task R: sealed-draft output in slot draft, status sealed.",
            `Retained text digest: ${researchPin!.digest}`,
            "R exact bytes",
          ].join("\n"),
          [
            "Prerequisite D-C from task C: verified-code output in slot code, status sealed.",
            "Checkpoint:",
            `commit: ${checkpoint.commit}`,
            `tree: ${checkpoint.tree}`,
            `retainedRef: ${checkpoint.retainedRef}`,
            "verification: passed (exit code 0)",
            `The commit is reachable from any worktree of this repository: git show ${checkpoint.commit}; git diff ${"a".repeat(40)}..${checkpoint.commit}`,
            "The retained text below is the producer's own account; the checkpoint above is authoritative when they disagree.",
            `Retained text digest: ${codePin!.digest}`,
            "C exact bytes",
          ].join("\n"),
        ].join("\n\n"),
      );
      const complete = yield* finish(draft, "sealed");
      assert.isTrue(complete.result!.assembly!.complete);
      assert.equal(
        complete.result!.assembly!.inputs.find((entry) => entry.taskId === "D")!.prerequisites
          .length,
        2,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "claims a live runtime response phase only through an authorized human response on the exact attempt",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(at));
      yield* seed;
      yield* grant;
      const admitted = yield* bindingFor("respond");
      yield* decide({ type: "admit", ...admitted });
      const store = yield* Store.FactoryExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      const binding = admitted.binding;
      const unscoped = AuthSessionId.make("human-unscoped");
      const responder = AuthSessionId.make("human-responder");
      const sessions = yield* AuthSessions.AuthSessionRepository;
      for (const sessionId of [unscoped, responder])
        yield* sessions.create({
          sessionId,
          subject: sessionId,
          scopes: sessionId === responder ? [AuthOrchestrationOperateScope] : [],
          method: "browser-session-cookie",
          client: {
            label: null,
            ipAddress: null,
            userAgent: null,
            deviceType: "unknown",
            os: null,
            browser: null,
          },
          issuedAt: DateTime.makeUnsafe(at),
          expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
        });
      const providerSessionId = ProviderSessionId.make("session-live");
      const providerThreadId = "provider-thread-live";
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,model,updated_at,payload_json) VALUES (${providerSessionId},${binding.threadId},'devReplay','ready','replay',${at},${canonicalExecutionJson({ status: "ready" })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings(provider_session_id,thread_id) VALUES (${providerSessionId},${binding.threadId})`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,owner_node_id,provider,provider_session_id,status,first_run_ordinal,last_run_ordinal,updated_at,payload_json) VALUES (${providerThreadId},${binding.threadId},NULL,'devReplay',${providerSessionId},'active',1,1,${at},${canonicalExecutionJson({ status: "active" })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,provider_thread_id,status,requested_at,payload_json) VALUES (${binding.runId},${binding.threadId},1,'devReplay','devReplay',${providerThreadId},'running',${at},${canonicalExecutionJson({ status: "running", activeAttemptId: binding.runAttemptId })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_instance_id,provider_thread_id,status,payload_json) VALUES (${binding.runAttemptId},${binding.threadId},${binding.runId},1,'root-node','devReplay','devReplay',${providerThreadId},'running',${canonicalExecutionJson({ status: "running", providerTurnId: null })})`;
      let turnOrdinal = 0;
      const seedRuntimeRequest = Effect.fn("test.seedRuntimeRequest")(function* (input: {
        readonly name: string;
        readonly runId: string | null;
        readonly linked: boolean;
        readonly kind: "command" | "user_input";
        readonly capability:
          | { readonly type: "live"; readonly providerSessionId: string }
          | { readonly type: "message" };
        readonly status?: "pending" | "resolved";
        readonly decision?: "acceptForSession" | "acceptAlways";
      }) {
        const requestId = RuntimeRequestId.make(`request:${input.name}`);
        const nodeId = NodeId.make(`node:${input.name}`);
        const providerTurnId = input.linked ? ProviderTurnId.make(`turn:${input.name}`) : null;
        if (providerTurnId !== null) {
          const ordinal = ++turnOrdinal;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,started_at,completed_at,payload_json) VALUES (${providerTurnId},${binding.threadId},${providerThreadId},${nodeId},${binding.runAttemptId},${ordinal},'running',${at},NULL,${canonicalExecutionJson({ id: providerTurnId, threadId: binding.threadId, providerThreadId, nodeId, runAttemptId: binding.runAttemptId, ordinal, status: "running", startedAt: at, completedAt: null })})`;
        }
        const node = {
          id: nodeId,
          threadId: binding.threadId,
          runId: input.runId,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind:
            input.kind === "command"
              ? ("approval_request" as const)
              : ("user_input_request" as const),
          status: "waiting" as const,
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: at,
          completedAt: null,
        };
        yield* sql`INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,runtime_request_id,checkpoint_scope_id,started_at,completed_at,payload_json) VALUES (${nodeId},${binding.threadId},${input.runId},NULL,${nodeId},${node.kind},${node.status},${providerThreadId},${providerTurnId},NULL,NULL,${at},NULL,${canonicalExecutionJson(node)})`;
        const request = {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: {
            driver: "acpRegistry",
            nativeId: input.name,
            strength: "strong" as const,
          },
          kind: input.kind,
          status: input.status ?? "resolved",
          responseCapability:
            input.capability.type === "live"
              ? { type: "live" as const, providerSessionId: input.capability.providerSessionId }
              : { type: "message" as const },
          createdAt: at,
          resolvedAt: at,
          ...(input.decision === undefined ? {} : { decision: input.decision }),
        };
        yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,provider_turn_id,kind,status,created_at,resolved_at,payload_json) VALUES (${requestId},${binding.threadId},${nodeId},${providerTurnId},${input.kind},${request.status},${at},${at},${canonicalExecutionJson(request)})`;
        return requestId;
      });
      const claimResponse = Effect.fn("test.claimResponse")(function* (input: {
        readonly requestId: RuntimeRequestId;
        readonly authorization?: {
          readonly sessionId: AuthSessionId;
          readonly runAttemptId: RunAttemptId;
        };
      }) {
        const runtimeResponse =
          input.authorization === undefined
            ? undefined
            : {
                threadId: binding.threadId,
                requestId: input.requestId,
                providerSessionId,
                authorization: input.authorization,
              };
        return yield* store.claimPhase({
          runAttemptId: binding.runAttemptId,
          phase: `response:${input.requestId}`,
          claimantId: "responder",
          ...(runtimeResponse === undefined ? {} : { runtimeResponse }),
        });
      });
      const durable = (requestId: RuntimeRequestId) =>
        sql`SELECT phase FROM factory_execution_phases WHERE attempt_id = ${binding.runAttemptId} AND phase = ${`response:${requestId}`}`;
      // An ordinary caller without response authorization must not claim the response phase.
      const ordinary = yield* seedRuntimeRequest({
        name: "ordinary",
        runId: binding.runId,
        linked: true,
        kind: "command",
        capability: { type: "live", providerSessionId },
      });
      assert.isTrue(
        Result.isFailure(yield* claimResponse({ requestId: ordinary }).pipe(Effect.result)),
      );
      assert.deepEqual(yield* durable(ordinary), []);
      // A session without orchestration-operate scope cannot authorize its own response.
      const unscopedRequest = yield* seedRuntimeRequest({
        name: "unscoped",
        runId: binding.runId,
        linked: true,
        kind: "command",
        capability: { type: "live", providerSessionId },
      });
      assert.isTrue(
        Result.isFailure(
          yield* claimResponse({
            requestId: unscopedRequest,
            authorization: { sessionId: unscoped, runAttemptId: binding.runAttemptId },
          }).pipe(Effect.result),
        ),
      );
      assert.deepEqual(yield* durable(unscopedRequest), []);
      // A historical request from an earlier run of the thread stays rejected.
      const stale = yield* seedRuntimeRequest({
        name: "stale",
        runId: RunId.make("run:old"),
        linked: false,
        kind: "command",
        capability: { type: "live", providerSessionId },
      });
      assert.isTrue(
        Result.isFailure(
          yield* claimResponse({
            requestId: stale,
            authorization: { sessionId: human.sessionId, runAttemptId: binding.runAttemptId },
          }).pipe(Effect.result),
        ),
      );
      assert.deepEqual(yield* durable(stale), []);
      // Message-mode questions are answered by chat, never by a runtime response claim.
      const question = yield* seedRuntimeRequest({
        name: "question",
        runId: binding.runId,
        linked: true,
        kind: "user_input",
        capability: { type: "message" },
      });
      assert.isTrue(
        Result.isFailure(
          yield* claimResponse({
            requestId: question,
            authorization: { sessionId: human.sessionId, runAttemptId: binding.runAttemptId },
          }).pipe(Effect.result),
        ),
      );
      assert.deepEqual(yield* durable(question), []);
      // The authorization must name the exact admitted attempt.
      const foreign = yield* seedRuntimeRequest({
        name: "foreign",
        runId: binding.runId,
        linked: true,
        kind: "command",
        capability: { type: "live", providerSessionId },
      });
      assert.isTrue(
        Result.isFailure(
          yield* claimResponse({
            requestId: foreign,
            authorization: {
              sessionId: human.sessionId,
              runAttemptId: RunAttemptId.make("attempt:foreign"),
            },
          }).pipe(Effect.result),
        ),
      );
      assert.deepEqual(yield* durable(foreign), []);
      // The exact authorized response claims once; the durable phase row holds every replay.
      const live = yield* seedRuntimeRequest({
        name: "live",
        runId: binding.runId,
        linked: true,
        kind: "command",
        capability: { type: "live", providerSessionId },
      });
      const authorized = {
        requestId: live,
        authorization: { sessionId: human.sessionId, runAttemptId: binding.runAttemptId },
      } as const;
      assert.equal((yield* claimResponse(authorized)).status, "claimed");
      assert.equal((yield* claimResponse(authorized)).status, "held");
      assert.deepEqual(yield* durable(live), [{ phase: `response:${live}` }]);
      const responseAuthorization = { sessionId: responder, runAttemptId: binding.runAttemptId };
      const grantRows = yield* sql<{ json: string }>`
        SELECT grant_json AS json FROM factory_execution_grants WHERE root_id = ${ref.rootId}
      `;
      const grantJson = grantRows[0]!.json;
      const restoreGrant = sql`UPDATE factory_execution_grants SET grant_json = ${grantJson} WHERE root_id = ${ref.rootId}`;
      const runPayload = canonicalExecutionJson({
        status: "running",
        activeAttemptId: binding.runAttemptId,
      });
      const cases = [
        {
          name: "revoked-grant",
          change: sql`UPDATE factory_execution_grants SET grant_json = json_set(grant_json, '$.revokedAt', ${at}) WHERE root_id = ${ref.rootId}`,
          restore: restoreGrant,
          reason: "grant-inactive",
        },
        {
          name: "expired-grant",
          change: sql`UPDATE factory_execution_grants SET grant_json = json_set(grant_json, '$.policy.expiresAt', ${at}) WHERE root_id = ${ref.rootId}`,
          restore: restoreGrant,
          reason: "grant-expired",
        },
        {
          name: "grant-version",
          change: sql`UPDATE factory_execution_grants SET grant_json = json_set(grant_json, '$.version', 2) WHERE root_id = ${ref.rootId}`,
          restore: restoreGrant,
          reason: "grant-conflict",
        },
        {
          name: "changed-plan-head",
          change: sql`UPDATE factory_plan_heads SET revision = 2, snapshot_json = ${canonicalExecutionJson({ ...plan, revision: 2 })} WHERE root_id = ${ref.rootId}`,
          restore: sql`UPDATE factory_plan_heads SET revision = 1, snapshot_json = ${canonicalExecutionJson(plan)} WHERE root_id = ${ref.rootId}`,
          reason: "revision-conflict",
        },
        {
          name: "stopping",
          change: sql`UPDATE factory_execution_bindings SET stop_requested = 1 WHERE attempt_id = ${binding.runAttemptId}`,
          restore: sql`UPDATE factory_execution_bindings SET stop_requested = 0 WHERE attempt_id = ${binding.runAttemptId}`,
          reason: "grant-inactive",
        },
        {
          name: "quiescent",
          change: sql`UPDATE factory_execution_bindings SET quiescent = 1 WHERE attempt_id = ${binding.runAttemptId}`,
          restore: sql`UPDATE factory_execution_bindings SET quiescent = 0 WHERE attempt_id = ${binding.runAttemptId}`,
          reason: "grant-inactive",
        },
        {
          name: "replaced-task",
          change: sql`UPDATE factory_execution_tasks SET attempt_id = 'replacement' WHERE root_id = ${ref.rootId}`,
          restore: sql`UPDATE factory_execution_tasks SET attempt_id = ${binding.runAttemptId} WHERE root_id = ${ref.rootId}`,
          reason: "task-conflict",
        },
        {
          name: "changed-task-version",
          change: sql`UPDATE factory_execution_tasks SET version = version + 1 WHERE root_id = ${ref.rootId}`,
          restore: sql`UPDATE factory_execution_tasks SET version = ${binding.taskVersion} WHERE root_id = ${ref.rootId}`,
          reason: "task-conflict",
        },
        {
          name: "replaced-active-attempt",
          change: sql`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.activeAttemptId', 'replacement') WHERE run_id = ${binding.runId}`,
          restore: sql`UPDATE orchestration_v2_projection_runs SET payload_json = ${runPayload} WHERE run_id = ${binding.runId}`,
          reason: "task-conflict",
        },
        ...["completed", "failed", "interrupted", "cancelled", "rolled_back"].map((status) => ({
          name: `terminal-run-${status}`,
          change: sql`UPDATE orchestration_v2_projection_runs SET status = ${status}, payload_json = json_set(payload_json, '$.status', ${status}) WHERE run_id = ${binding.runId}`,
          restore: sql`UPDATE orchestration_v2_projection_runs SET status = 'running', payload_json = ${runPayload} WHERE run_id = ${binding.runId}`,
          reason: "task-conflict",
        })),
        ...["completed", "failed", "interrupted", "cancelled", "superseded"].map((status) => ({
          name: `terminal-attempt-${status}`,
          change: sql`UPDATE orchestration_v2_projection_run_attempts SET status = ${status}, payload_json = json_set(payload_json, '$.status', ${status}) WHERE attempt_id = ${binding.runAttemptId}`,
          restore: sql`UPDATE orchestration_v2_projection_run_attempts SET status = 'running', payload_json = ${canonicalExecutionJson({ status: "running", providerTurnId: null })} WHERE attempt_id = ${binding.runAttemptId}`,
          reason: "task-conflict",
        })),
        ...["completed", "failed", "interrupted", "cancelled"].map((status) => ({
          name: `terminal-turn-${status}`,
          change: sql`UPDATE orchestration_v2_projection_provider_turns SET status = ${status} WHERE run_attempt_id = ${binding.runAttemptId}`,
          restore: sql`UPDATE orchestration_v2_projection_provider_turns SET status = 'running' WHERE run_attempt_id = ${binding.runAttemptId}`,
          reason: "task-conflict",
        })),
        {
          name: "request-linked-to-foreign-attempt",
          change: sql`UPDATE orchestration_v2_projection_provider_turns SET run_attempt_id = 'replacement' WHERE run_attempt_id = ${binding.runAttemptId}`,
          restore: sql`UPDATE orchestration_v2_projection_provider_turns SET run_attempt_id = ${binding.runAttemptId} WHERE run_attempt_id = 'replacement'`,
          reason: "task-conflict",
        },
        {
          name: "revoked-responder",
          change: sessions.revoke({ sessionId: responder, revokedAt: DateTime.makeUnsafe(at) }),
          restore: sql`UPDATE auth_sessions SET revoked_at = NULL WHERE session_id = ${responder}`,
          reason: "forbidden",
        },
        {
          name: "revoked-issuer",
          change: sessions.revoke({
            sessionId: human.sessionId,
            revokedAt: DateTime.makeUnsafe(at),
          }),
          restore: sql`UPDATE auth_sessions SET revoked_at = NULL WHERE session_id = ${human.sessionId}`,
          reason: "forbidden",
        },
        {
          name: "expired-responder",
          change: sql`UPDATE auth_sessions SET expires_at = ${at} WHERE session_id = ${responder}`,
          restore: sql`UPDATE auth_sessions SET expires_at = '2099-01-01T00:00:00.000Z' WHERE session_id = ${responder}`,
          reason: "forbidden",
        },
        {
          name: "expired-issuer",
          change: sql`UPDATE auth_sessions SET expires_at = ${at} WHERE session_id = ${human.sessionId}`,
          restore: sql`UPDATE auth_sessions SET expires_at = '2099-01-01T00:00:00.000Z' WHERE session_id = ${human.sessionId}`,
          reason: "forbidden",
        },
        {
          name: "rebound-native-session",
          change: sql`UPDATE orchestration_v2_projection_provider_threads SET provider_session_id = 'replacement' WHERE provider_thread_id = ${providerThreadId}`,
          restore: sql`UPDATE orchestration_v2_projection_provider_threads SET provider_session_id = ${providerSessionId} WHERE provider_thread_id = ${providerThreadId}`,
          reason: "task-conflict",
        },
        {
          name: "detached-native-session",
          change: sql`DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id = ${providerSessionId}`,
          restore: sql`INSERT INTO orchestration_v2_projection_provider_session_bindings(provider_session_id,thread_id) VALUES (${providerSessionId},${binding.threadId})`,
          reason: "task-conflict",
        },
        {
          name: "stopped-native-session",
          change: sql`UPDATE orchestration_v2_projection_provider_sessions SET status = 'stopped' WHERE provider_session_id = ${providerSessionId}`,
          restore: sql`UPDATE orchestration_v2_projection_provider_sessions SET status = 'ready' WHERE provider_session_id = ${providerSessionId}`,
          reason: "task-conflict",
        },
      ];
      for (const scenario of cases) {
        const requestId = yield* seedRuntimeRequest({
          name: scenario.name,
          runId: binding.runId,
          linked: true,
          kind: "command",
          capability: { type: "live", providerSessionId },
        });
        yield* store.authorizeRuntimeResponse({
          threadId: binding.threadId,
          requestId,
          providerSessionId,
          authorization: responseAuthorization,
          expectedStatus: "resolved",
        });
        yield* scenario.change;
        const denied = yield* claimResponse({
          requestId,
          authorization: responseAuthorization,
        }).pipe(Effect.flip);
        assert.equal(denied.reason, scenario.reason, scenario.name);
        assert.deepEqual(yield* durable(requestId), [], scenario.name);
        yield* scenario.restore;
      }
      for (const scenario of [
        {
          name: "missing-attempt-link",
          linked: false,
          capability: { type: "live", providerSessionId },
        },
        {
          name: "foreign-capability",
          linked: true,
          capability: { type: "live", providerSessionId: ProviderSessionId.make("foreign") },
        },
        {
          name: "pending",
          linked: true,
          status: "pending",
          capability: { type: "live", providerSessionId },
        },
        {
          name: "session-approval",
          linked: true,
          decision: "acceptForSession",
          capability: { type: "live", providerSessionId },
        },
        {
          name: "permanent-approval",
          linked: true,
          decision: "acceptAlways",
          capability: { type: "live", providerSessionId },
        },
      ] as const) {
        const requestId = yield* seedRuntimeRequest({
          ...scenario,
          runId: binding.runId,
          kind: "command",
        });
        if (scenario.name === "pending")
          assert.equal(
            (yield* store.authorizeRuntimeResponse({
              threadId: binding.threadId,
              requestId,
              providerSessionId,
              authorization: responseAuthorization,
              expectedStatus: "pending",
            })).runAttemptId,
            binding.runAttemptId,
          );
        assert.isTrue(
          Result.isFailure(
            yield* claimResponse({ requestId, authorization: responseAuthorization }).pipe(
              Effect.result,
            ),
          ),
          scenario.name,
        );
        assert.deepEqual(yield* durable(requestId), [], scenario.name);
      }
      const answers = yield* seedRuntimeRequest({
        name: "live-answers",
        runId: binding.runId,
        linked: true,
        kind: "user_input",
        capability: { type: "live", providerSessionId },
      });
      const response = {
        threadId: binding.threadId,
        requestId: answers,
        providerSessionId,
        authorization: responseAuthorization,
      };
      assert.isTrue(
        Result.isFailure(
          yield* store
            .claimPhase({
              runAttemptId: binding.runAttemptId,
              phase: "response:another-request",
              claimantId: "mismatched-request",
              runtimeResponse: response,
            })
            .pipe(Effect.result),
        ),
      );
      assert.isTrue(
        Result.isFailure(
          yield* store
            .authorizeRuntimeResponse({
              ...response,
              threadId: ThreadId.make("another-thread"),
              expectedStatus: "resolved",
            })
            .pipe(Effect.result),
        ),
      );
      assert.isTrue(
        Result.isFailure(
          yield* store
            .authorizeRuntimeResponse({
              ...response,
              expectedStatus: "pending",
            })
            .pipe(Effect.result),
        ),
      );
      assert.deepEqual(yield* durable(answers), []);
      assert.equal(
        (yield* claimResponse({ requestId: answers, authorization: responseAuthorization })).status,
        "claimed",
      );
      const historical = yield* seedRuntimeRequest({
        name: "historical-same-attempt",
        runId: binding.runId,
        linked: true,
        kind: "command",
        status: "pending",
        capability: { type: "live", providerSessionId },
      });
      yield* store.authorizeRuntimeResponse({
        ...response,
        requestId: historical,
        expectedStatus: "pending",
      });
      const next = yield* seedRuntimeRequest({
        name: "next-turn-same-attempt",
        runId: binding.runId,
        linked: true,
        kind: "command",
        capability: { type: "live", providerSessionId },
      });
      assert.equal(
        (yield* store
          .authorizeRuntimeResponse({
            ...response,
            requestId: historical,
            expectedStatus: "pending",
          })
          .pipe(Effect.flip)).reason,
        "task-conflict",
      );
      assert.deepEqual(yield* durable(historical), []);
      assert.equal(
        (yield* claimResponse({ requestId: next, authorization: responseAuthorization })).status,
        "claimed",
      );
      yield* store.requestNativeStop({
        threadId: binding.threadId,
        runId: binding.runId,
        detail: "Join response claims.",
      });
      const settleAttempt = store.settleAttempt({
        runAttemptId: binding.runAttemptId,
        observation: "quiescent",
        detail: "All response work joined.",
      });
      assert.equal((yield* settleAttempt.pipe(Effect.flip)).reason, "not-quiescent");
      for (const requestId of [live, answers, next])
        yield* store.settlePhase({
          runAttemptId: binding.runAttemptId,
          phase: `response:${requestId}`,
          claimantId: "responder",
          observation: "quiescent",
          detail: "Response claimant joined.",
        });
      yield* settleAttempt;
      assert.isTrue((yield* store.getBinding(binding.runAttemptId)).quiescent);
    }).pipe(Effect.provide(layer)),
);
