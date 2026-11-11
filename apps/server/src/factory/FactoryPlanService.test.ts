import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  AuthSessionId,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  FactoryWorkError,
  ProjectId,
  ThreadId,
  type FactoryPlanApplyInput,
  type FactoryWorkReadResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Plans from "./FactoryPlanService.ts";
import * as Work from "./FactoryWorkService.ts";

const environmentId = EnvironmentId.make("plan-owner");
const projectId = ProjectId.make("plan-project");
const threadId = ThreadId.make("local-editor");
const human = { kind: "human", sessionId: AuthSessionId.make("human-one") } as const;
const otherHuman = { kind: "human", sessionId: AuthSessionId.make("human-two") } as const;
const agent = { kind: "agent", threadId } as const;
const at = "2026-11-05T00:00:00.000Z";
const workRef = { version: 1, environmentId, kind: "brief", id: "brief" } as const;
const observed: FactoryWorkReadResult = {
  item: {
    ref: workRef,
    projectId,
    title: "Concrete brief",
    createdAt: at,
    sourceKey: null,
    sourceUrl: null,
    sourceState: null,
    revision: "brief-v1",
    supersededBy: null,
    originConflict: false,
    planningStage: null,
  },
  reviewTarget: { kind: "brief", briefId: "brief" },
  snapshot: "Frozen brief text",
  snapshotTruncated: false,
  projectAvailable: true,
  reviewProjectId: projectId,
  projectCoordinatorThreadId: null,
  supersedes: null,
  fetchedAt: at,
};
const dependencies = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const base = (published: number[]) =>
  Layer.mergeAll(
    dependencies,
    EventSink.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          dependencies,
          Layer.effect(
            EventStore.EventStoreV2,
            Effect.map(EventStore.EventStoreV2, (store) => ({
              ...store,
              publishCommitted: (events) =>
                Effect.sync(() => {
                  published.push(...events.map((event) => event.sequence));
                }).pipe(Effect.andThen(store.publishCommitted(events))),
            })),
          ).pipe(Layer.provide(dependencies)),
        ),
      ),
    ),
    NodeCrypto.layer,
    Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    AuthSessions.layer.pipe(Layer.provide(dependencies)),
  );
const layerWith = (
  read: Work.FactoryWorkService["Service"]["read"] = () =>
    Effect.fail(new FactoryWorkError({ reason: "missing-work" })),
  published: number[] = [],
) =>
  Plans.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(base(published), Layer.mock(Work.FactoryWorkService)({ read })),
    ),
  );
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Plan project','/plan-project','[]',${at},${at})`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${threadId},${projectId},'Local editor','codex','codex','approval-required','default',${at},${at},'{}')`;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  for (const actor of [human, otherHuman])
    yield* sessions.create({
      sessionId: actor.sessionId,
      subject: actor.sessionId,
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
const createInput = { commandId: CommandId.make("create-plan"), projectId, title: "One outcome" };

it.effect(
  "serializes whole-plan revisions across service instances and preserves payload-bound replay outcomes",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const plans = yield* Plans.FactoryPlanService;
      const second = yield* Plans.FactoryPlanService.pipe(Effect.provide(Plans.layer));
      const created = yield* plans.create(createInput, human);
      const ref = created.plan.ref;
      const input: FactoryPlanApplyInput = {
        commandId: CommandId.make("first-edit"),
        ref,
        expectedRevision: 1,
        operations: [{ type: "task.update", id: ref.rootId, title: "First title" }],
      };
      const other = {
        ...input,
        commandId: CommandId.make("second-edit"),
        operations: [{ type: "task.update" as const, id: ref.rootId, title: "Second title" }],
      };
      const outcomes = yield* Effect.all(
        [
          plans.apply(input, human).pipe(Effect.result),
          second.apply(other, human).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(outcomes.filter(Result.isSuccess).length, 1);
      const loser = outcomes.find(Result.isFailure)!;
      assert.equal(loser.failure.reason, "revision-conflict");
      const winnerInput = Result.isSuccess(outcomes[0]!) ? input : other;
      const won = yield* plans.read({ ref });
      assert.equal(won.revision, 2);
      yield* plans.apply(
        {
          commandId: CommandId.make("newer"),
          ref,
          expectedRevision: 2,
          operations: [{ type: "task.update", id: ref.rootId, context: "Later context" }],
        },
        human,
      );
      const replay = yield* second.apply(winnerInput, human);
      assert.equal(replay.plan.revision, 2);
      assert.equal(replay.current, false);
      assert.equal(replay.replayed, true);
      assert.equal(
        (yield* plans
          .apply(
            {
              ...winnerInput,
              operations: [{ type: "task.update", id: ref.rootId, title: "Different payload" }],
            },
            human,
          )
          .pipe(Effect.flip)).reason,
        "command-conflict",
      );
      assert.equal(
        (yield* plans
          .create({ ...createInput, title: "Different create" }, human)
          .pipe(Effect.flip)).reason,
        "command-conflict",
      );
      assert.equal(
        (yield* plans.create(createInput, otherHuman).pipe(Effect.flip)).reason,
        "command-conflict",
      );
      const history = yield* plans.history({ ref, limit: 2 });
      assert.deepEqual(
        history.items.map((entry) => entry.revision),
        [3, 2],
      );
      assert.equal(history.nextBeforeRevision, 2);
      assert.deepEqual(
        (yield* plans.history({ ref, beforeRevision: 2 })).items.map((entry) => entry.revision),
        [1],
      );
      assert.equal("tasks" in history.items[0]!, false);
      assert.equal((yield* plans.read({ ref, revision: 1 })).tasks[0]!.title, "One outcome");
      assert.equal((yield* plans.list({ projectId })).items[0]!.ref.rootId, ref.rootId);
    }).pipe(Effect.provide(layerWith())),
);

it.effect(
  "requires explicit grants, prevents agent enlargement, and checks current authority even for replay",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const plans = yield* Plans.FactoryPlanService;
      assert.equal((yield* plans.create(createInput, agent).pipe(Effect.flip)).reason, "forbidden");
      const { plan } = yield* plans.create(createInput, human);
      const input: FactoryPlanApplyInput = {
        commandId: CommandId.make("agent-edit"),
        ref: plan.ref,
        expectedRevision: 2,
        operations: [
          { type: "task.add", id: "child", parentId: plan.ref.rootId, title: "A bounded child" },
        ],
      };
      assert.equal((yield* plans.apply(input, agent).pipe(Effect.flip)).reason, "forbidden");
      yield* plans.apply(
        {
          commandId: CommandId.make("grant"),
          ref: plan.ref,
          expectedRevision: 1,
          operations: [{ type: "editor.grant", threadId }],
        },
        human,
      );
      assert.equal(
        (yield* plans
          .apply(
            {
              ...input,
              commandId: CommandId.make("self-grant"),
              operations: [{ type: "editor.grant", threadId }],
            },
            agent,
          )
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      yield* plans.apply(input, agent);
      yield* plans.apply(
        {
          commandId: CommandId.make("revoke"),
          ref: plan.ref,
          expectedRevision: 3,
          operations: [{ type: "editor.revoke", threadId }],
        },
        human,
      );
      assert.equal((yield* plans.apply(input, agent).pipe(Effect.flip)).reason, "forbidden");
      assert.equal(
        (yield* plans
          .read({ ref: { ...plan.ref, environmentId: EnvironmentId.make("elsewhere") } })
          .pipe(Effect.flip)).reason,
        "wrong-environment",
      );
      assert.equal(
        (yield* plans
          .apply({ ...input, ref: { ...plan.ref, projectId: ProjectId.make("missing") } }, human)
          .pipe(Effect.flip)).reason,
        "missing-project",
      );
      const sessions = yield* AuthSessions.AuthSessionRepository;
      yield* sessions.revoke({ sessionId: human.sessionId, revokedAt: DateTime.makeUnsafe(at) });
      assert.equal((yield* plans.create(createInput, human).pipe(Effect.flip)).reason, "forbidden");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET deleted_at = ${at} WHERE project_id = ${projectId}`;
      assert.equal(
        (yield* plans.create(createInput, otherHuman).pipe(Effect.flip)).reason,
        "missing-project",
      );
    }).pipe(Effect.provide(layerWith())),
);

it.effect(
  "revocation wins against an edit waiting for context and captured context survives retirement and restoration",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        yield* seed;
        const plans = yield* Plans.FactoryPlanService;
        const { plan } = yield* plans.create(createInput, human);
        yield* plans.apply(
          {
            commandId: CommandId.make("grant"),
            ref: plan.ref,
            expectedRevision: 1,
            operations: [{ type: "editor.grant", threadId }],
          },
          human,
        );
        const input: FactoryPlanApplyInput = {
          commandId: CommandId.make("attach"),
          ref: plan.ref,
          expectedRevision: 2,
          operations: [
            { type: "context.attachWork", id: "context", taskId: plan.ref.rootId, ref: workRef },
          ],
        };
        const editing = yield* plans.apply(input, agent).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* plans.apply(
          {
            commandId: CommandId.make("revoke"),
            ref: plan.ref,
            expectedRevision: 2,
            operations: [{ type: "editor.revoke", threadId }],
          },
          human,
        );
        yield* Deferred.succeed(released, undefined);
        const refused = yield* Fiber.join(editing);
        assert.equal(Result.isFailure(refused) && refused.failure.reason, "forbidden");
        const attached = yield* plans.apply(
          { ...input, commandId: CommandId.make("human-attach"), expectedRevision: 3 },
          human,
        );
        const context = attached.plan.workContexts[0]!;
        assert.equal(context.revision, "brief-v1");
        assert.equal(context.observedAt, at);
        assert.equal(context.snapshot, observed.snapshot);
        assert.match(context.sha256, /^[a-f0-9]{64}$/);
        yield* plans.apply(
          {
            commandId: CommandId.make("retire-context"),
            ref: plan.ref,
            expectedRevision: 4,
            operations: [{ type: "context.retire", id: "context" }],
          },
          human,
        );
        const restored = yield* plans.apply(
          {
            commandId: CommandId.make("restore-context"),
            ref: plan.ref,
            expectedRevision: 5,
            operations: [{ type: "context.restore", id: "context" }],
          },
          human,
        );
        assert.deepEqual(restored.plan.workContexts[0], context);
        const history = yield* plans.read({ ref: plan.ref, revision: 4 });
        assert.deepEqual(history.workContexts[0], context);
        assert.equal(
          (yield* plans
            .apply(
              {
                commandId: CommandId.make("missing-retired-context"),
                ref: plan.ref,
                expectedRevision: 6,
                operations: [
                  {
                    type: "context.attachWork",
                    id: "missing-context",
                    taskId: "missing",
                    ref: workRef,
                  },
                  { type: "context.retire", id: "missing-context" },
                ],
              },
              human,
            )
            .pipe(Effect.flip)).reason,
          "invalid-operation",
        );
        assert.equal((yield* plans.read({ ref: plan.ref })).revision, 6);
      }).pipe(
        Effect.provide(
          layerWith(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(released)),
              Effect.as(observed),
            ),
          ),
        ),
      );
    }),
);

it.effect(
  "validates the complete rooted tree and DAG and restores retained identities without changing endpoints",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const plans = yield* Plans.FactoryPlanService;
      const { plan } = yield* plans.create(createInput, human);
      const ref = plan.ref;
      yield* plans.apply(
        {
          commandId: CommandId.make("children"),
          ref,
          expectedRevision: 1,
          operations: [
            { type: "task.add", id: "a", parentId: ref.rootId, title: "A" },
            { type: "task.add", id: "b", parentId: "a", title: "B" },
            {
              type: "edge.add",
              id: "ab",
              fromTaskId: "a",
              toTaskId: "b",
              requirement: "Reviewed draft",
            },
          ],
        },
        human,
      );
      const invalidOperations: FactoryPlanApplyInput["operations"][] = [
        [
          {
            type: "edge.add",
            id: "retired-dangling",
            fromTaskId: "missing",
            toTaskId: "missing",
            requirement: "Retained",
          },
          { type: "edge.retire", id: "retired-dangling" },
        ],
        [
          { type: "edge.retire", id: "ab" },
          {
            type: "edge.add",
            id: "retained-cycle",
            fromTaskId: "b",
            toTaskId: "a",
            requirement: "Reverse dependency",
          },
        ],
        [{ type: "task.move", id: "a", parentId: "b" }],
        [{ type: "task.add", id: "orphan", parentId: "missing", title: "Orphan" }],
        [
          {
            type: "edge.add",
            id: "ba",
            fromTaskId: "b",
            toTaskId: "a",
            requirement: "Other output",
          },
        ],
        [{ type: "task.retire", id: "a" }],
        [{ type: "edge.add", id: "self", fromTaskId: "a", toTaskId: "a", requirement: "Self" }],
      ];
      for (const [index, operations] of invalidOperations.entries())
        assert.equal(
          (yield* plans
            .apply(
              {
                commandId: CommandId.make(`invalid-${index}`),
                ref,
                expectedRevision: 2,
                operations,
              },
              human,
            )
            .pipe(Effect.flip)).reason,
          "invalid-plan",
        );
      yield* plans.apply(
        {
          commandId: CommandId.make("retire"),
          ref,
          expectedRevision: 2,
          operations: [
            { type: "edge.retire", id: "ab" },
            { type: "task.retire", id: "b" },
          ],
        },
        human,
      );
      assert.equal(
        (yield* plans
          .apply(
            {
              commandId: CommandId.make("reuse"),
              ref,
              expectedRevision: 3,
              operations: [
                { type: "task.add", id: "b", parentId: ref.rootId, title: "Replacement" },
              ],
            },
            human,
          )
          .pipe(Effect.flip)).reason,
        "invalid-operation",
      );
      const restored = yield* plans.apply(
        {
          commandId: CommandId.make("restore"),
          ref,
          expectedRevision: 3,
          operations: [
            { type: "task.restore", id: "b" },
            { type: "edge.restore", id: "ab" },
          ],
        },
        human,
      );
      assert.deepEqual(restored.plan.edges[0], {
        id: "ab",
        kind: "requires",
        fromTaskId: "a",
        toTaskId: "b",
        requirement: "Reviewed draft",
        retired: false,
      });
      assert.equal(restored.plan.tasks.find((task) => task.id === "b")!.parentId, "a");
      const oversized = Array.from({ length: 40 }, (_, index) => ({
        type: "task.add" as const,
        id: `large-${index}`,
        parentId: ref.rootId,
        title: "Large",
        context: "x".repeat(8000),
      }));
      assert.equal(
        (yield* plans
          .apply(
            {
              commandId: CommandId.make("oversized"),
              ref,
              expectedRevision: 4,
              operations: oversized,
            },
            human,
          )
          .pipe(Effect.flip)).reason,
        "invalid-plan",
      );
      assert.equal((yield* plans.read({ ref })).revision, 4);
    }).pipe(Effect.provide(layerWith())),
);

it.effect(
  "rolls back event, head, history and receipts together and never enqueues execution",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const plans = yield* Plans.FactoryPlanService;
      const sql = yield* SqlClient.SqlClient;
      const { plan } = yield* plans.create(createInput, human);
      yield* sql`CREATE TRIGGER fail_plan_receipt BEFORE INSERT ON factory_plan_commands WHEN NEW.command_id = 'crash' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`;
      const input: FactoryPlanApplyInput = {
        commandId: CommandId.make("crash"),
        ref: plan.ref,
        expectedRevision: 1,
        operations: [{ type: "task.update", id: plan.ref.rootId, title: "Must roll back" }],
      };
      assert.equal(
        (yield* plans.apply(input, human).pipe(Effect.flip)).reason,
        "persistence-failure",
      );
      assert.equal((yield* plans.read({ ref: plan.ref })).revision, 1);
      assert.equal((yield* sql`SELECT root_id FROM factory_plan_revisions`).length, 1);
      assert.equal(
        (yield* sql`SELECT command_id FROM factory_plan_commands WHERE command_id = 'crash'`)
          .length,
        0,
      );
      assert.equal(
        (yield* sql`SELECT command_id FROM orchestration_command_receipts WHERE command_id = 'crash'`)
          .length,
        0,
      );
      assert.equal(
        (yield* sql`SELECT sequence FROM orchestration_events WHERE command_id = 'crash'`).length,
        0,
      );
      yield* sql`DROP TRIGGER fail_plan_receipt`;
      assert.equal((yield* plans.apply(input, human)).plan.revision, 2);
      assert.equal((yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`).length, 0);
      assert.equal(
        (yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`).length,
        1,
      );
      assert.equal((yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`).length, 0);
    }).pipe(Effect.provide(layerWith())),
);

it.effect("publishes plan events only after the outermost transaction commits", () => {
  const published: number[] = [];
  return Effect.gen(function* () {
    yield* seed;
    const plans = yield* Plans.FactoryPlanService;
    const sql = yield* SqlClient.SqlClient;
    const { plan } = yield* plans.create(createInput, human);
    published.length = 0;
    const before = yield* (yield* EventStore.EventStoreV2).latestApplicationSequence;
    const outerInput: FactoryPlanApplyInput = {
      commandId: CommandId.make("outer-crash"),
      ref: plan.ref,
      expectedRevision: 1,
      operations: [{ type: "task.update", id: plan.ref.rootId, title: "Outer rollback" }],
    };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* plans.apply(outerInput, human);
          return yield* Effect.fail("outer failure");
        }),
      )
      .pipe(Effect.flip);
    assert.equal(published.length, 0);
    assert.equal((yield* plans.read({ ref: plan.ref })).revision, 1);
    assert.equal(yield* (yield* EventStore.EventStoreV2).latestApplicationSequence, before);
    assert.equal(
      (yield* sql`SELECT command_id FROM factory_plan_commands WHERE command_id = 'outer-crash'`)
        .length,
      0,
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* plans.apply(outerInput, human);
        yield* plans.apply(
          { ...outerInput, commandId: CommandId.make("second-nested"), expectedRevision: 2 },
          human,
        );
        assert.equal(published.length, 0);
      }),
    );
    assert.deepEqual(published, [before + 1, before + 2]);
    assert.equal((yield* plans.read({ ref: plan.ref })).revision, 3);
  }).pipe(Effect.provide(layerWith(undefined, published)));
});
