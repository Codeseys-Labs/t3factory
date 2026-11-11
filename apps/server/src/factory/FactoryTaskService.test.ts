import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  FactoryDeliveryError,
  FactoryWorkError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  SourceControlProviderKind,
  ThreadId,
  type FactoryAgentSetup,
  type FactoryTaskError,
  type FactoryTaskChange,
  type FactoryTaskCreateInput,
  type FactoryTaskRun,
  type FactoryTaskSummary,
  type FactoryWorkReadResult,
  type ModelSelection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as DeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import * as ExecutionStore from "../persistence/FactoryExecutionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Processes from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Profiles from "./FactoryAgentProfileService.ts";
import * as Delivery from "./FactoryDeliveryService.ts";
import { canonicalExecutionJson, executionDigest } from "./FactoryExecutionDigest.ts";
import * as Executions from "./FactoryExecutionService.ts";
import * as Plans from "./FactoryPlanService.ts";
import * as Changes from "./FactoryTaskChanges.ts";
import * as Tasks from "./FactoryTaskService.ts";
import * as Work from "./FactoryWorkService.ts";

const environmentId = EnvironmentId.make("task-owner");
const projectId = ProjectId.make("task-project");
const otherProjectId = ProjectId.make("other-project");
const human = { kind: "human", sessionId: AuthSessionId.make("human") } as const;
const at = "2026-11-10T00:00:00.000Z";
const instanceId = ProviderInstanceId.make("devReplay");
const model = (name: string): ModelSelection => ({ instanceId, model: name });
const setupOf = (
  name = "replay",
  workspace: FactoryAgentSetup["workspace"] = "worktree",
): FactoryAgentSetup => ({
  modelSelection: model(name),
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspace,
});
const projectHead = "a".repeat(40);
const resultCommit = "b".repeat(40);
const command = (name: string) => CommandId.make(name);
const issueRef = { version: 1, environmentId, kind: "issue", id: "issue-96" } as const;
const retainedIssue: FactoryWorkReadResult = {
  item: {
    ref: issueRef,
    projectId,
    title: "GitHub #96",
    createdAt: at,
    sourceKey: null,
    sourceUrl: null,
    sourceState: null,
    revision: "issue-v1",
    supersededBy: null,
    originConflict: false,
    planningStage: null,
  },
  reviewTarget: { kind: "issue", issueNumber: 96 },
  snapshot: "Path separators differ on Windows.",
  snapshotTruncated: false,
  projectAvailable: true,
  reviewProjectId: projectId,
  projectCoordinatorThreadId: null,
  supersedes: null,
  fetchedAt: at,
};

const git = Layer.mock(Processes.ProcessRunner)({
  run: (input) =>
    Effect.succeed({
      stdout:
        input.args[0] === "rev-parse"
          ? `${projectHead}\n`
          : "180\t20\tsrc/board.ts\u00004\t0\tsrc/card.ts\u0000",
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
});
const adapters = Layer.effect(
  ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const adapter = yield* ProviderAdapter.ProviderAdapterV2;
    return {
      get: () => Effect.succeed(adapter),
      list: () => Effect.succeed([instanceId]),
    };
  }),
).pipe(
  Layer.provide(
    Layer.mock(ProviderAdapter.ProviderAdapterV2)({
      instanceId,
      driver: ProviderDriverKind.make("acpRegistry"),
      openSession: () => Effect.die("A started run is never executed in these tests"),
    }),
  ),
);
/** What the delivery fake was asked, and what a Check finds on the host. */
class DeliveryProbe extends Context.Service<
  DeliveryProbe,
  {
    readonly grants: Array<string>;
    readonly checks: Array<string>;
    found: Omit<DeliveryStore.FactoryDeliverySettlement, "updatedAt">;
  }
>()("t3/factory/FactoryTaskService.test/DeliveryProbe") {}
const pullUrl = "https://github.com/owner/repo/pull/12";
// The real store keeps the intents the task reads; the host side is the test's to settle.
const deliveries = Layer.effect(
  Delivery.FactoryDeliveryService,
  Effect.gen(function* () {
    const store = yield* DeliveryStore.FactoryDeliveryStore;
    const probe = yield* DeliveryProbe;
    const unused = () => Effect.die("tasks deliver through grantCommit and reconcile only");
    return Delivery.FactoryDeliveryService.of({
      prepare: unused,
      grant: unused,
      read: unused,
      execute: unused,
      grantCommit: (input) =>
        Effect.gen(function* () {
          probe.grants.push(input.kind);
          if (
            input.kind === "merge-pr" &&
            Option.getOrUndefined(yield* store.getLive(input.originKey, "publish-pr"))?.status !==
              "confirmed"
          )
            return yield* new FactoryDeliveryError({ reason: "not-published" });
          const granted = yield* store.grant(
            {
              id: `delivery:${input.commandId}`,
              originKey: input.originKey,
              threadId: input.threadId,
              projectId: input.projectId,
              kind: input.kind,
              acceptanceId: input.acceptanceId,
              repository: {
                provider: SourceControlProviderKind.make("github"),
                host: "github.com",
                repository: "owner/repo",
                canonicalKey: "github.com/owner/repo",
                url: "https://github.com/owner/repo",
              },
              baseRef: "refs/remotes/origin/main",
              baseBranch: "main",
              baseSha: "f".repeat(40),
              headSha: input.headSha,
              payload:
                input.kind === "publish-pr"
                  ? { ...input.publish, draft: false }
                  : { mergeMethod: "merge" },
              payloadDigest: "d".repeat(64),
              grantedBy: environmentId,
              grantedAt: at,
              requestCommandId: input.commandId,
              status: "pending",
              remote: input.kind === "merge-pr" ? { number: 12, url: pullUrl } : null,
              failure: null,
              updatedAt: at,
            },
            { recheck: input.recheck, enqueue: Effect.void },
          );
          return granted.intent.kind === "publish-artifact"
            ? yield* Effect.die("a task never delivers an artifact")
            : granted.intent;
        }),
      reconcile: (input) =>
        Effect.gen(function* () {
          probe.checks.push(input.intentId);
          const settled = yield* store.settle(input.intentId, { ...probe.found, updatedAt: at });
          return Option.getOrThrow(settled);
        }),
    });
  }),
).pipe(
  Layer.provideMerge(
    Layer.merge(
      DeliveryStore.layer,
      Layer.effect(
        DeliveryProbe,
        Effect.sync(() => ({
          grants: [],
          checks: [],
          found: { status: "unknown" as const, failure: null },
        })),
      ),
    ),
  ),
);
const eventStores = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provideMerge(OrchestrationEventStore.layer),
);
const dependencies = Layer.mergeAll(eventStores, ProjectionStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const layerWith = (environmentDefault: ModelSelection | null = null) => {
  const base = Layer.mergeAll(
    dependencies,
    EventSink.layer.pipe(Layer.provide(dependencies)),
    NodeCrypto.layer,
    NodeServices.layer,
    IdAllocator.layer,
    git,
    adapters,
    Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.succeed(HostProcess.Platform, "win32"),
    AuthSessions.layer.pipe(Layer.provide(dependencies)),
    ServerSettings.layerTest({ defaultModelSelection: environmentDefault }),
    Layer.mock(Work.FactoryWorkService)({
      read: ({ ref }) =>
        ref.id === issueRef.id
          ? Effect.succeed(retainedIssue)
          : Effect.fail(new FactoryWorkError({ reason: "missing-work" })),
    }),
  );
  const engine = Layer.mergeAll(
    Plans.layer,
    Executions.layer,
    ExecutionStore.layer,
    deliveries,
  ).pipe(Layer.provideMerge(base));
  return Layer.mergeAll(Tasks.layer, Profiles.layer, Changes.layer).pipe(
    Layer.provideMerge(engine),
  );
};

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of [projectId, otherProjectId])
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${id},${id},${`/${id}`},'[]',${at},${at})`;
  yield* (yield* AuthSessions.AuthSessionRepository).create({
    sessionId: human.sessionId,
    subject: human.sessionId,
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
    issuedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
    expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
  });
  const tasks = yield* Tasks.FactoryTaskService;
  const executions = yield* Executions.FactoryExecutionService;
  // Subscribed before any change, so no notice is missed.
  const feed = yield* (yield* Changes.FactoryTaskChanges).subscribe;

  const create = (title: string, extra: Partial<FactoryTaskCreateInput> = {}) =>
    tasks
      .create({ commandId: command(`create:${title}`), projectId, title, ...extra }, human)
      .pipe(Effect.map((result) => result.task));
  const subtask = (title: string, parent: FactoryTaskSummary, blockedBy: string[] = []) =>
    create(title, {
      parent: { rootId: parent.ref.rootId, taskId: parent.ref.taskId, blockedBy },
    });
  const summary = (task: FactoryTaskSummary) =>
    tasks.read({ task: { ref: task.ref } }).pipe(Effect.map((detail) => detail.task));
  const start = (task: FactoryTaskSummary, setup = setupOf()) =>
    Effect.gen(function* () {
      const current = yield* summary(task);
      return (yield* tasks.start(
        {
          commandId: command(`start:${task.displayId}:${current.version}`),
          ref: task.ref,
          expectedVersion: current.version,
          setup,
        },
        human,
      )).task;
    });
  const attemptOf = (run: FactoryTaskRun) =>
    sql<{
      attemptId: RunAttemptId;
    }>`SELECT attempt_id AS attemptId FROM factory_execution_bindings WHERE thread_id = ${run.threadId}`.pipe(
      Effect.map((rows) => rows[0]!.attemptId),
    );
  /** Ends a run the way the effect worker does: writers gone, then the captured outcome. */
  const finish = Effect.fn("test.finish")(function* (
    run: FactoryTaskRun,
    outcome: "sealed" | "failed",
    text = "",
  ) {
    const attemptId = yield* attemptOf(run);
    const native = outcome === "sealed" ? "completed" : "failed";
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = ${native}, payload_json = json_set(payload_json, '$.status', ${native}) WHERE run_id = ${run.runId}`;
    yield* sql`UPDATE factory_execution_bindings SET quiescent = 1, stop_requested = 1 WHERE attempt_id = ${attemptId}`;
    let checkpoint = null;
    if (outcome === "sealed" && run.setup.workspace === "worktree") {
      checkpoint = {
        commit: resultCommit,
        tree: "c".repeat(40),
        retainedRef: `refs/t3/factory/outputs/${executionDigest(attemptId)}`,
        verificationDigest: executionDigest(["verification", attemptId]),
      };
      yield* sql`INSERT INTO factory_execution_verifications(digest, attempt_id, repository_path, evidence_json) VALUES (${checkpoint.verificationDigest}, ${attemptId}, '/task-project', ${canonicalExecutionJson({ ...checkpoint, evidence: { code: 0 }, passed: true })})`;
    }
    yield* executions.observeResult({
      runId: run.runId,
      runAttemptId: attemptId,
      captureKey: "native-final/1",
      slot: "result",
      text,
      status: outcome,
      checkpoint,
    });
  });
  /** Waits on the change feed, never on time, until the task reads as expected. */
  const until = Effect.fn("test.until")(function* (
    task: FactoryTaskSummary,
    done: (current: FactoryTaskSummary) => boolean,
  ) {
    while (true) {
      const current = yield* summary(task);
      if (done(current)) return current;
      yield* PubSub.take(feed);
    }
  });
  /** Takes changes until one names the root, and returns every change taken on the way. */
  const changesUntil = Effect.fn("test.changesUntil")(function* (rootId: string) {
    const taken: FactoryTaskChange[] = [];
    while (true) {
      const change = yield* PubSub.take(feed);
      taken.push(change);
      if (change.rootIds.includes(rootId)) return taken;
    }
  });
  return {
    sql,
    tasks,
    executions,
    feed,
    create,
    subtask,
    summary,
    start,
    attemptOf,
    finish,
    until,
    changesUntil,
  };
});

type Provided =
  ReturnType<typeof layerWith> extends Layer.Layer<infer Services, infer _E, infer _R>
    ? Services
    : never;
const scenario = <A, E>(
  body: Effect.Effect<A, E, Provided | Scope.Scope>,
  environmentDefault: ModelSelection | null = null,
) => body.pipe(Effect.scoped, Effect.provide(layerWith(environmentDefault)));

it.effect("numbers top-level tasks, sub-tasks and nested sub-tasks once and never again", () =>
  scenario(
    Effect.gen(function* () {
      const { tasks, create, subtask, summary } = yield* harness;
      const first = yield* create("Unified task model");
      const second = yield* create("Light theme for the board");
      const contract = yield* subtask("Contract and migration", first);
      const api = yield* subtask("Move the list API to tasks", first, [contract.ref.taskId]);
      const nested = yield* subtask("Cursor paging", contract);
      assert.deepEqual(
        [first, second, contract, api, nested].map((task) => task.displayId),
        ["T-1", "T-2", "T-1.1", "T-1.2", "T-1.1.1"],
      );
      assert.deepEqual(api.parent, { taskId: first.ref.taskId, displayId: "T-1" });
      assert.deepEqual(
        [first.assignee.assignment.mode, api.assignee.assignment.mode, first.lane, first.status],
        ["unassigned", "auto", "backlog", "backlog"],
      );
      assert.deepEqual(
        api.blockedBy.map((blocker) => blocker.displayId),
        ["T-1.1"],
      );

      const canceled = yield* tasks.update(
        {
          commandId: command("cancel"),
          ref: api.ref,
          expectedVersion: api.version,
          lane: "canceled",
        },
        human,
      );
      assert.equal(canceled.task.status, "canceled");
      assert.equal((yield* subtask("Update the mobile list", first)).displayId, "T-1.3");

      const detail = yield* tasks.read({ task: { displayId: "T-1.1.1" } });
      assert.equal(detail.task.ref.taskId, nested.ref.taskId);
      assert.deepEqual(
        detail.ancestors.map((ancestor) => ancestor.displayId),
        ["T-1", "T-1.1"],
      );
      const parent = yield* tasks.read({ task: { ref: first.ref } });
      assert.deepEqual(
        parent.subtasks.map((task) => [task.displayId, task.status]),
        [
          ["T-1.1", "backlog"],
          ["T-1.2", "canceled"],
          ["T-1.3", "backlog"],
        ],
      );
      assert.deepEqual(parent.task.progress, { done: 0, total: 2 });
      assert.deepEqual(
        (yield* tasks.read({ task: { ref: contract.ref } })).blocks.map((task) => task.displayId),
        ["T-1.2"],
      );
      assert.equal((yield* summary(second)).progress, null);
      // A top-level task holds 64 tasks, itself included.
      assert.equal(
        (yield* tasks
          .createSubtasks(
            {
              commandId: command("too-many"),
              parent: second.ref,
              items: Array.from({ length: 64 }, (_, index) => ({
                key: `item-${index}`,
                title: `Sub-task ${index}`,
                description: "",
                assignment: { mode: "auto" } as const,
                after: [],
              })),
            },
            human,
          )
          .pipe(Effect.flip)).reason,
        "task-limit",
      );
    }),
  ),
);

it.effect("replays a command id, refuses it with other input, and reports a stale version", () =>
  scenario(
    Effect.gen(function* () {
      const { tasks } = yield* harness;
      const input = { commandId: command("once"), projectId, title: "Dark-mode contrast pass" };
      const created = yield* tasks.create(input, human);
      assert.isFalse(created.replayed);
      const again = yield* tasks.create(input, human);
      assert.isTrue(again.replayed);
      assert.deepEqual(again.task.ref, created.task.ref);
      assert.equal(
        (yield* tasks.create({ ...input, title: "Another title" }, human).pipe(Effect.flip)).reason,
        "command-conflict",
      );
      assert.equal(
        (yield* tasks
          .create(
            { ...input, commandId: command("agent") },
            { kind: "agent", threadId: ThreadId.make("agent") },
          )
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      assert.equal(
        (yield* tasks
          .create(
            { ...input, commandId: command("nowhere"), projectId: ProjectId.make("gone") },
            human,
          )
          .pipe(Effect.flip)).reason,
        "missing-project",
      );

      const ref = created.task.ref;
      const stale = yield* tasks
        .update(
          {
            commandId: command("stale"),
            ref,
            expectedVersion: created.task.version + 3,
            lane: "ready",
          },
          human,
        )
        .pipe(Effect.flip);
      assert.equal(stale.reason, "version-conflict");
      assert.equal(stale.currentVersion, created.task.version);
      const move = {
        commandId: command("move"),
        ref,
        expectedVersion: created.task.version,
        lane: "ready",
      } as const;
      const moved = yield* tasks.update(move, human);
      assert.equal(moved.task.status, "ready");
      assert.isAbove(moved.task.version, created.task.version);
      assert.isTrue((yield* tasks.update(move, human)).replayed);
      assert.equal(
        (yield* tasks.update({ ...move, lane: "backlog" }, human).pipe(Effect.flip)).reason,
        "command-conflict",
      );
      assert.equal(
        (yield* tasks
          .read({ task: { ref: { ...ref, environmentId: EnvironmentId.make("elsewhere") } } })
          .pipe(Effect.flip)).reason,
        "wrong-environment",
      );
      assert.equal(
        (yield* tasks.read({ task: { displayId: "T-99" } }).pipe(Effect.flip)).reason,
        "missing-task",
      );
    }),
  ),
);

it.effect("keeps title and description in the plan and everything on the board beside it", () =>
  scenario(
    Effect.gen(function* () {
      const { tasks, create } = yield* harness;
      const plans = yield* Plans.FactoryPlanService;
      const task = yield* create("Draft title", { description: "First words" });
      const other = yield* create("Another task");
      const planRef = { environmentId, projectId, rootId: task.ref.rootId };
      assert.equal((yield* plans.read({ ref: planRef })).revision, 1);

      const edited = yield* tasks.update(
        {
          commandId: command("edit"),
          ref: task.ref,
          expectedVersion: task.version,
          title: "Server Git tests fail on Windows",
          description: "Paths differ",
          type: "bug",
          lane: "ready",
        },
        human,
      );
      assert.deepEqual(
        [edited.task.title, edited.task.type, edited.task.lane, edited.task.status],
        ["Server Git tests fail on Windows", "bug", "ready", "ready"],
      );
      assert.equal((yield* tasks.read({ task: { ref: task.ref } })).description, "Paths differ");
      assert.equal((yield* plans.read({ ref: planRef })).revision, 2);

      // Moving a card or assigning it is not a plan edit.
      const assigned = yield* tasks.update(
        {
          commandId: command("assign"),
          ref: task.ref,
          expectedVersion: edited.task.version,
          lane: "backlog",
          assignment: { mode: "person" },
        },
        human,
      );
      assert.deepEqual([assigned.task.status, assigned.task.assignee.key], ["backlog", "person"]);
      assert.equal((yield* plans.read({ ref: planRef })).revision, 2);
      assert.equal(
        (yield* tasks
          .update(
            {
              commandId: command("ghost"),
              ref: task.ref,
              expectedVersion: assigned.task.version,
              assignment: { mode: "profile", profileId: "ghost" },
            },
            human,
          )
          .pipe(Effect.flip)).reason,
        "missing-profile",
      );

      const comment = { commandId: command("comment"), ref: task.ref, body: "Seen on CI too" };
      const written = yield* tasks.comment(comment, human);
      assert.deepEqual(yield* tasks.comment(comment, human), {
        entry: written.entry,
        replayed: true,
      });

      const firstPage = yield* tasks.activity({ ref: task.ref, limit: 3 });
      const secondPage = yield* tasks.activity({
        ref: task.ref,
        limit: 3,
        cursor: firstPage.nextCursor!,
      });
      assert.deepEqual(
        [...firstPage.entries, ...secondPage.entries].map((entry) =>
          entry.event.type === "status"
            ? `status:${entry.event.from}>${entry.event.to}`
            : entry.event.type,
        ),
        [
          "created",
          "edited",
          "status:backlog>ready",
          "status:ready>backlog",
          "assigned",
          "comment",
        ],
      );
      assert.equal(secondPage.nextCursor, null);
      assert.isTrue(firstPage.entries.every((entry) => entry.actor.label === "You"));
      assert.equal(
        (yield* tasks.activity({ ref: other.ref, cursor: firstPage.nextCursor! }).pipe(Effect.flip))
          .reason,
        "invalid-cursor",
      );
    }),
  ),
);

it.effect(
  "lists by status, project, type, source, assignee and text, in pages that agree with the counts",
  () =>
    scenario(
      Effect.gen(function* () {
        const { tasks, create, subtask } = yield* harness;
        const tick = TestClock.adjust("1 second");
        const backlog = yield* create("Light theme for the board");
        yield* tick;
        const bug = yield* tasks
          .create(
            {
              commandId: command("issue"),
              projectId,
              title: "Server Git tests fail on Windows",
              type: "bug",
              lane: "ready",
            },
            human,
            {
              source: {
                kind: "issue",
                label: "GitHub #96",
                url: "https://github.com/Codeseys-Labs/t3factory/issues/96",
                key: "github:codeseys-labs/t3factory#96",
                workRef: null,
              },
              ruleName: "Bugs from GitHub",
            },
          )
          .pipe(Effect.map((result) => result.task));
        yield* tick;
        const pinned = yield* create("Filter the board by assignee", {
          lane: "ready",
          assignment: { mode: "pinned", setup: setupOf("opus") },
        });
        yield* tick;
        const elsewhere = yield* create("Scholar page sync", { projectId: otherProjectId });
        yield* tick;
        const canceled = yield* create("Abandoned idea");
        yield* tasks.update(
          {
            commandId: command("cancel"),
            ref: canceled.ref,
            expectedVersion: canceled.version,
            lane: "canceled",
          },
          human,
        );
        yield* tick;
        const child = yield* subtask("Board filter chips", pinned);
        const ids = (items: ReadonlyArray<FactoryTaskSummary>) =>
          items.map((item) => item.displayId);

        // Newest update first. Gaining a sub-task is an update to the parent.
        assert.deepEqual(ids((yield* tasks.list({})).items), ["T-3", "T-4", "T-2", "T-1"]);
        const pages: string[][] = [];
        let cursor: string | undefined;
        do {
          const page = yield* tasks.list({ limit: 2, ...(cursor === undefined ? {} : { cursor }) });
          pages.push(ids(page.items));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        assert.deepEqual(pages, [
          ["T-3", "T-4"],
          ["T-2", "T-1"],
        ]);
        const firstPage = yield* tasks.list({ limit: 2 });
        assert.equal(
          (yield* tasks
            .list({ limit: 2, types: ["bug"], cursor: firstPage.nextCursor! })
            .pipe(Effect.flip)).reason,
          "invalid-cursor",
        );

        const listed = (filter: Parameters<typeof tasks.list>[0]) =>
          tasks.list(filter).pipe(Effect.map((result) => ids(result.items)));
        assert.deepEqual(yield* listed({ statuses: ["ready"] }), ["T-3", "T-2"]);
        assert.deepEqual(yield* listed({ statuses: ["canceled"] }), ["T-5"]);
        assert.deepEqual(yield* listed({ projectIds: [otherProjectId] }), ["T-4"]);
        assert.deepEqual(yield* listed({ types: ["bug"] }), ["T-2"]);
        assert.deepEqual(yield* listed({ sourceKinds: ["issue"] }), ["T-2"]);
        assert.deepEqual(yield* listed({ assigneeKeys: ["devReplay/opus"] }), ["T-3"]);
        assert.deepEqual(yield* listed({ assigneeKeys: ["unassigned"], projectIds: [projectId] }), [
          "T-2",
          "T-1",
        ]);
        assert.deepEqual(yield* listed({ text: "board" }), ["T-3", "T-1"]);
        assert.deepEqual(yield* listed({ text: "t-2" }), ["T-2"]);
        assert.deepEqual(yield* listed({ text: "100%" }), []);
        assert.deepEqual((yield* listed({ scope: "all", text: "board" })).toSorted(), [
          "T-1",
          "T-3",
          "T-3.1",
        ]);
        assert.deepEqual(yield* listed({ types: [] }), []);
        assert.equal(child.assignee.resolved?.via, "parent");
        assert.deepEqual(
          (yield* listed({ scope: "all", assigneeKeys: ["devReplay/opus"] })).toSorted(),
          ["T-3", "T-3.1"],
        );
        assert.deepEqual(bug.source.label, "GitHub #96");
        assert.equal(backlog.source.kind, "local");
        assert.equal(elsewhere.ref.projectId, otherProjectId);

        for (const filter of [{}, { projectIds: [projectId] }, { scope: "all" as const }]) {
          const counts = yield* tasks.count(filter);
          for (const { status, count } of counts.byStatus)
            assert.equal(
              (yield* tasks.list({ ...filter, statuses: [status] })).items.length,
              count,
              `${canonicalExecutionJson(filter)} ${status}`,
            );
        }
        assert.deepEqual(
          (yield* tasks.count({})).byStatus.map((entry) => [entry.status, entry.count]),
          [
            ["backlog", 2],
            ["ready", 2],
            ["in-progress", 0],
            ["in-review", 0],
            ["done", 0],
            ["canceled", 1],
          ],
        );
      }),
    ),
);

it.effect("lists only the tasks that wait on a person or have a run that has not finished", () =>
  scenario(
    Effect.gen(function* () {
      const { tasks, create, subtask, start, finish, until } = yield* harness;
      const proposed = yield* create("Unified task model");
      yield* tasks.recordProposal({
        ref: proposed.ref,
        proposalId: "proposal",
        itemCount: 4,
        status: "proposed",
        actor: human,
      });
      const working = yield* create("Thread still shows Working after reconnect", {
        lane: "ready",
      });
      yield* start(working);
      const parent = yield* create("Benchmark index paths");
      const child = yield* subtask("Run the benchmark", parent);
      yield* finish((yield* start(child)).run!, "failed");
      yield* until(child, (current) => current.attention.length > 0);
      const quiet = yield* create("Filter the board by assignee", { lane: "ready" });
      const done = yield* create("Rename repository identity", { lane: "ready" });
      yield* tasks.update(
        { commandId: command("done"), ref: done.ref, expectedVersion: done.version, lane: "done" },
        human,
      );

      const waiting = yield* tasks.list({ attention: true });
      assert.deepEqual(
        waiting.items
          .map((task) => [
            task.displayId,
            task.status,
            task.attention.map((entry) => `${entry.reason}:${entry.displayId}`).join(),
            task.liveRuns.length,
          ])
          .toSorted(),
        [
          [proposed.displayId, "backlog", `plan:${proposed.displayId}`, 0],
          [working.displayId, "in-progress", "", 1],
          [parent.displayId, "in-progress", `failed:${child.displayId}`, 0],
        ],
      );
      assert.isFalse(waiting.items.some((task) => task.displayId === quiet.displayId));
      // A parent counts for its sub-task, and the sub-task counts for itself.
      assert.deepEqual(
        (yield* tasks.list({ attention: true, scope: "all", statuses: ["in-progress"] })).items
          .map((task) => task.displayId)
          .toSorted(),
        [working.displayId, parent.displayId, child.displayId].toSorted(),
      );
      assert.deepEqual(
        (yield* tasks.list({ attention: true, statuses: ["backlog"] })).items.map(
          (task) => task.displayId,
        ),
        [proposed.displayId],
      );
      for (const filter of [{ attention: true }, { attention: true, scope: "all" }] as const) {
        const counts = yield* tasks.count(filter);
        for (const { status, count } of counts.byStatus)
          assert.equal(
            (yield* tasks.list({ ...filter, statuses: [status] })).items.length,
            count,
            `${canonicalExecutionJson(filter)} ${status}`,
          );
      }
      assert.deepEqual(
        (yield* tasks.count({ attention: true })).byStatus.flatMap((entry) =>
          entry.count === 0 ? [] : [[entry.status, entry.count]],
        ),
        [
          ["backlog", 1],
          ["in-progress", 2],
        ],
      );
      // The filter is part of what a cursor continues.
      const page = yield* tasks.list({ attention: true, limit: 1 });
      assert.equal(
        (yield* tasks.list({ attention: true, limit: 1, cursor: page.nextCursor! })).items.length,
        1,
      );
      assert.equal(
        (yield* tasks.list({ limit: 1, cursor: page.nextCursor! }).pipe(Effect.flip)).reason,
        "invalid-cursor",
      );

      // Dismissing the plan and ending the run take both tasks off the list again.
      yield* tasks.recordProposal({
        ref: proposed.ref,
        proposalId: "proposal",
        itemCount: 4,
        status: "dismissed",
        actor: human,
      });
      yield* tasks.update(
        {
          commandId: command("give-up"),
          ref: child.ref,
          expectedVersion: (yield* tasks.read({ task: { ref: child.ref } })).task.version,
          lane: "canceled",
        },
        human,
      );
      assert.deepEqual(
        (yield* tasks.list({ attention: true })).items.map((task) => task.displayId),
        [working.displayId],
      );
    }),
  ),
);

it.effect.each(
  (["retry", "requestChanges"] as const).flatMap((operation) =>
    (["person", "canceled", "done", "blocked"] as const).map((condition) => ({
      operation,
      condition,
    })),
  ),
)("$operation refuses a $condition task", ({ operation, condition }) =>
  scenario(
    Effect.gen(function* () {
      const { tasks, create, subtask, summary, start, finish, until } = yield* harness;
      const plans = yield* Plans.FactoryPlanService;

      const parent = yield* create(`${operation}:${condition}`);
      const task = yield* subtask("Work", parent);
      const blocker = yield* subtask("Prerequisite", parent);
      const running = yield* start(task);
      yield* finish(running.run!, operation === "retry" ? "failed" : "sealed", "Answer");
      yield* until(task, (current) =>
        operation === "retry" ? current.liveRuns.length === 0 : current.status === "in-review",
      );
      if (condition === "blocked") {
        const ref = { environmentId, projectId, rootId: task.ref.rootId };
        yield* plans.apply(
          {
            commandId: command(`block:${operation}`),
            ref,
            expectedRevision: (yield* plans.read({ ref })).revision,
            operations: [
              {
                type: "edge.add",
                id: "blocker",
                fromTaskId: task.ref.taskId,
                toTaskId: blocker.ref.taskId,
                requirement: "",
              },
            ],
          },
          human,
        );
      } else {
        const current = yield* summary(task);
        if (condition === "done" && operation === "requestChanges") {
          yield* tasks.accept(
            {
              commandId: command(`done:${operation}`),
              ref: task.ref,
              revision: current.result!.revision,
            },
            human,
          );
        } else {
          yield* tasks.update(
            {
              commandId: command(`change:${operation}:${condition}`),
              ref: task.ref,
              expectedVersion: current.version,
              ...(condition === "person"
                ? { assignment: { mode: "person" as const } }
                : { lane: condition }),
            },
            human,
          );
        }
      }
      const current = yield* summary(task);
      const before = yield* tasks.read({ task: { ref: task.ref } });
      const activity = yield* tasks.activity({ ref: task.ref });
      const input = { commandId: command(`refuse:${operation}:${condition}`), ref: task.ref };
      const error = yield* (
        operation === "retry"
          ? tasks.retry({ ...input, expectedVersion: current.version }, human)
          : tasks.requestChanges(
              { ...input, revision: current.result!.revision, note: "Try again" },
              human,
            )
      ).pipe(Effect.flip);
      assert.equal(
        error.reason,
        condition === "person"
          ? "assignee-unresolved"
          : condition === "blocked"
            ? "blocked"
            : "invalid-transition",
      );
      assert.deepEqual(yield* tasks.read({ task: { ref: task.ref } }), before);
      assert.deepEqual(yield* tasks.activity({ ref: task.ref }), activity);
    }),
  ),
);

it.effect("follows a run from start through failure, retry, review, acceptance and reopening", () =>
  scenario(
    Effect.gen(function* () {
      const { sql, tasks, create, subtask, summary, start, finish, until } = yield* harness;
      const task = yield* create("Thread still shows Working after reconnect", { lane: "ready" });
      const update = (name: string, lane: FactoryTaskSummary["lane"]) =>
        Effect.gen(function* () {
          const current = yield* summary(task);
          return yield* tasks
            .update(
              { commandId: command(name), ref: task.ref, expectedVersion: current.version, lane },
              human,
            )
            .pipe(
              Effect.flip,
              Effect.map((error) => error.reason),
            );
        });

      const parent = yield* create("Unified task model");
      const blocker = yield* subtask("Contract and migration", parent);
      const blocked = yield* subtask("Move the list API", parent, [blocker.ref.taskId]);
      assert.equal((yield* start(blocked).pipe(Effect.flip)).reason, "blocked");
      const byHand = yield* tasks.update(
        {
          commandId: command("by-hand"),
          ref: blocker.ref,
          expectedVersion: blocker.version,
          assignment: { mode: "person" },
        },
        human,
      );
      assert.equal((yield* start(byHand.task).pipe(Effect.flip)).reason, "assignee-unresolved");
      // A finished blocker stops blocking. The task it held stays where it was until a person starts it.
      yield* tasks.update(
        {
          commandId: command("blocker-done"),
          ref: blocker.ref,
          expectedVersion: byHand.task.version,
          lane: "done",
        },
        human,
      );
      const unblocked = yield* summary(blocked);
      assert.deepEqual(
        [unblocked.blockedBy, unblocked.status, unblocked.run, unblocked.liveRuns],
        [[], "backlog", null, []],
      );

      const started = yield* start(task);
      const firstRun = started.run!;
      assert.deepEqual(
        [started.status, firstRun.state, firstRun.ordinal, firstRun.purpose],
        ["in-progress", "running", 1, "work"],
      );
      assert.deepEqual(firstRun.setup, setupOf());
      assert.deepEqual(
        started.liveRuns.map((live) => [live.displayId, live.threadId, live.state]),
        [[task.displayId, firstRun.threadId, "running"]],
      );
      // "Assign and start": an unassigned task takes the setup it was started with.
      assert.deepEqual(
        [started.assignee.key, started.assignee.resolved?.via],
        ["devReplay/replay", "assignment"],
      );
      assert.deepEqual(
        yield* sql`SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ${firstRun.threadId}`,
        [{ title: `${task.displayId} ${task.title}` }],
      );
      assert.equal(
        (yield* tasks.findByThread({ threadId: firstRun.threadId })).task?.displayId,
        task.displayId,
      );
      assert.equal(
        (yield* tasks.findByThread({ threadId: ThreadId.make("unrelated") })).task,
        null,
      );
      assert.equal((yield* start(task).pipe(Effect.flip)).reason, "run-active");
      assert.equal(yield* update("done-live", "done"), "run-active");
      assert.equal(yield* update("cancel-live", "canceled"), "run-active");

      yield* finish(firstRun, "failed");
      const failed = yield* until(task, (current) => current.run?.state === "failed");
      // A failed run never moves the task; it asks for a person instead.
      assert.equal(failed.status, "in-progress");
      assert.deepEqual(
        failed.attention.map((entry) => [entry.reason, entry.displayId, entry.detail]),
        [["failed", task.displayId, "Run failed"]],
      );
      assert.deepEqual(failed.liveRuns, []);
      assert.equal(yield* update("back-failed", "backlog"), "invalid-transition");
      assert.equal(
        (yield* tasks
          .accept({ commandId: command("early"), ref: task.ref, revision: 1 }, human)
          .pipe(Effect.flip)).reason,
        "no-result",
      );

      const retried = (yield* tasks.retry(
        { commandId: command("retry"), ref: task.ref, expectedVersion: failed.version },
        human,
      )).task;
      const secondRun = retried.run!;
      assert.deepEqual(
        [retried.status, secondRun.state, secondRun.ordinal, retried.attention.length],
        ["in-progress", "running", 2, 0],
      );
      assert.deepEqual(secondRun.setup, firstRun.setup);

      yield* finish(secondRun, "sealed", "Reconnect now replays the last run state.");
      const review = yield* until(task, (current) => current.status === "in-review");
      assert.deepEqual(
        review.attention.map((entry) => entry.reason),
        ["review"],
      );
      assert.deepEqual(
        [
          review.result?.kind,
          review.result?.revision,
          review.result?.summary,
          review.result?.state,
        ],
        ["code", 1, "+184 −20 · 2 files", "ready"],
      );
      assert.deepEqual([review.result?.runOrdinal, review.run?.state], [2, "completed"]);
      const code = yield* tasks.readResult({ ref: task.ref });
      assert.equal(code.text, null);
      assert.deepEqual(code.files, [
        { path: "src/board.ts", additions: 180, deletions: 20 },
        { path: "src/card.ts", additions: 4, deletions: 0 },
      ]);
      assert.equal(yield* update("done-waiting", "done"), "invalid-transition");
      assert.equal(
        (yield* tasks
          .retry(
            { commandId: command("again"), ref: task.ref, expectedVersion: review.version },
            human,
          )
          .pipe(Effect.flip)).reason,
        "invalid-transition",
      );

      assert.equal(
        (yield* tasks
          .accept({ commandId: command("stale"), ref: task.ref, revision: 2 }, human)
          .pipe(Effect.flip)).reason,
        "result-conflict",
      );
      const accepted = (yield* tasks.accept(
        { commandId: command("accept"), ref: task.ref, revision: 1 },
        human,
      )).task;
      assert.deepEqual(
        [accepted.status, accepted.result?.state, accepted.result?.acceptedRevision, accepted.lane],
        ["done", "accepted", 1, "ready"],
      );
      assert.deepEqual(accepted.attention, []);
      assert.equal(yield* update("back-accepted", "backlog"), "invalid-transition");
      assert.equal(
        (yield* tasks
          .accept({ commandId: command("twice"), ref: task.ref, revision: 1 }, human)
          .pipe(Effect.flip)).reason,
        "invalid-transition",
      );

      const reopened = (yield* tasks.reopen({ commandId: command("reopen"), ref: task.ref }, human))
        .task;
      assert.deepEqual(
        [reopened.status, reopened.result?.state, reopened.attention[0]?.reason],
        ["in-review", "ready", "review"],
      );
      assert.equal(
        (yield* tasks
          .reopen({ commandId: command("reopen-2"), ref: task.ref }, human)
          .pipe(Effect.flip)).reason,
        "invalid-transition",
      );

      const detail = yield* tasks.read({ task: { ref: task.ref } });
      assert.deepEqual(
        detail.runs.map((run) => [run.ordinal, run.state]),
        [
          [2, "completed"],
          [1, "failed"],
        ],
      );
      assert.deepEqual(
        (yield* tasks.activity({ ref: task.ref })).entries.map((entry) =>
          entry.event.type === "run-ended"
            ? `run-ended:${entry.event.ordinal}:${entry.event.outcome}`
            : entry.event.type,
        ),
        [
          "created",
          "assigned",
          "run-started",
          "run-ended:1:failed",
          "run-started",
          "run-ended:2:completed",
          "result-ready",
          "accepted",
          "reopened",
        ],
      );
    }),
  ),
);

it.effect(
  "stopping a run shows Stopping until its writers are gone, then the task can be retried",
  () =>
    scenario(
      Effect.gen(function* () {
        const { sql, tasks, create, start, attemptOf, until } = yield* harness;
        const engine = yield* ExecutionStore.FactoryExecutionStore;
        const task = yield* create("Backtest the momentum signal", { lane: "ready" });
        assert.equal(
          (yield* tasks
            .stop({ commandId: command("idle"), ref: task.ref }, human)
            .pipe(Effect.flip)).reason,
          "no-run",
        );
        const run = (yield* start(task)).run!;
        const stop = { commandId: command("stop"), ref: task.ref };
        const stopping = (yield* tasks.stop(stop, human)).task;
        assert.deepEqual(
          [stopping.status, stopping.run?.state, stopping.liveRuns[0]?.state],
          ["in-progress", "stopping", "stopping"],
        );
        assert.isTrue((yield* tasks.stop(stop, human)).replayed);

        // The worker interrupts the thread's run, then confirms nothing of it is still writing.
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted', payload_json = json_set(payload_json, '$.status', 'interrupted') WHERE run_id = ${run.runId}`;
        yield* engine.settleAttempt({
          runAttemptId: yield* attemptOf(run),
          observation: "no-start",
          detail: "Stopped before the first turn.",
        });
        const stopped = yield* until(task, (current) => current.run?.endedAt != null);
        assert.deepEqual(
          [stopped.status, stopped.run?.state, stopped.liveRuns.length, stopped.attention.length],
          ["in-progress", "stopped", 0, 0],
        );
        const retried = (yield* tasks.retry(
          { commandId: command("retry"), ref: task.ref, expectedVersion: stopped.version },
          human,
        )).task;
        assert.deepEqual([retried.run?.ordinal, retried.run?.state], [2, "running"]);
        assert.deepEqual(
          (yield* tasks.activity({ ref: task.ref })).entries.flatMap((entry) =>
            entry.event.type === "run-ended" ? [[entry.event.ordinal, entry.event.outcome]] : [],
          ),
          [[1, "stopped"]],
        );
      }),
    ),
);

it.effect(
  "publishes an accepted code result, merges it, and settles an unconfirmed merge by checking",
  () =>
    scenario(
      Effect.gen(function* () {
        const { sql, tasks, create, start, finish, until } = yield* harness;
        const store = yield* DeliveryStore.FactoryDeliveryStore;
        const probe = yield* DeliveryProbe;
        const reason = <A>(effect: Effect.Effect<A, FactoryTaskError>) =>
          effect.pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          );
        const task = yield* create("Audio ring demo", { lane: "ready" });
        const deliver = (
          kind: "publish" | "merge",
          name: string,
          revision = 1,
          actor: Parameters<typeof tasks.publish>[1] = human,
        ) => tasks[kind]({ commandId: command(name), ref: task.ref, revision }, actor);
        const intentOf = (name: string) =>
          sql<{
            id: string;
          }>`SELECT id FROM factory_delivery_intents WHERE request_command_id = ${`factory-task:${name.startsWith("merge") ? "merge-pr" : "publish-pr"}:${name}`}`.pipe(
            Effect.map((rows) => rows[0]!.id),
          );
        yield* finish((yield* start(task)).run!, "sealed");
        yield* until(task, (current) => current.status === "in-review");

        // Accepting is not publishing: nothing goes out before it, and only a person sends it.
        assert.equal(yield* reason(deliver("publish", "early")), "not-accepted");
        yield* tasks.accept({ commandId: command("accept"), ref: task.ref, revision: 1 }, human);
        const agent = { kind: "agent", threadId: ThreadId.make("agent") } as const;
        assert.equal(yield* reason(deliver("publish", "by-agent", 1, agent)), "forbidden");
        assert.equal(yield* reason(deliver("publish", "unknown-revision", 2)), "no-result");
        assert.equal(yield* reason(deliver("merge", "merge-early")), "not-published");

        const sending = (yield* deliver("publish", "publish")).task;
        assert.deepEqual(
          [sending.status, sending.result?.pullRequest, sending.result?.delivery],
          ["done", null, { action: "publish", state: "sending", detail: null }],
        );
        assert.isTrue((yield* deliver("publish", "publish")).replayed);
        assert.equal(yield* reason(deliver("publish", "publish-again")), "delivery-active");
        assert.deepEqual(probe.grants, ["merge-pr", "publish-pr", "publish-pr"]);
        const publishId = yield* intentOf("publish");
        assert.deepEqual(
          yield* sql`SELECT json_extract(payload_json, '$.headBranch') AS branch, head_sha AS head FROM factory_delivery_intents WHERE id = ${publishId}`,
          [{ branch: "t3/T-1-audio-ring-demo", head: resultCommit }],
        );

        // The effect worker's outcome reaches the task without anyone asking.
        yield* store.settle(publishId, {
          status: "confirmed",
          remote: { number: 12, url: pullUrl },
          failure: null,
          updatedAt: at,
        });
        const open = yield* until(task, (current) => current.result?.pullRequest != null);
        assert.deepEqual(
          [open.result?.pullRequest, open.result?.delivery, open.attention],
          [
            {
              number: 12,
              url: pullUrl,
              host: "github.com",
              repository: "owner/repo",
              state: "open",
            },
            null,
            [],
          ],
        );

        yield* deliver("merge", "merge");
        const mergeId = yield* intentOf("merge");
        yield* store.markSending(mergeId, at);
        yield* store.settle(mergeId, {
          status: "unknown",
          failure: "response lost",
          updatedAt: at,
        });
        const unconfirmed = yield* until(task, (current) => current.attention.length > 0);
        assert.deepEqual(
          [
            unconfirmed.status,
            unconfirmed.attention.map((entry) => [entry.reason, entry.detail]),
            unconfirmed.result?.delivery,
          ],
          [
            "done",
            [["unconfirmed", "Merge of PR #12 sent · outcome unknown"]],
            { action: "merge", state: "unconfirmed", detail: null },
          ],
        );
        assert.deepEqual(
          (yield* tasks.list({ attention: true })).items.map((item) => item.displayId),
          [task.displayId],
        );

        // Check reads the host and never sends: here the merge did not happen.
        probe.found = { status: "failed", failure: "pull request is not merged" };
        const notMerged = (yield* tasks.check(
          { commandId: command("check-1"), ref: task.ref },
          human,
        )).task;
        assert.deepEqual(
          [notMerged.attention, notMerged.result?.pullRequest?.state, notMerged.result?.delivery],
          [[], "open", { action: "merge", state: "failed", detail: "pull request is not merged" }],
        );

        yield* deliver("merge", "merge-again");
        const againId = yield* intentOf("merge-again");
        yield* store.settle(againId, {
          status: "unknown",
          failure: "response lost",
          updatedAt: at,
        });
        // Here it did.
        probe.found = { status: "confirmed", remote: { number: 12, url: pullUrl }, failure: null };
        const merged = (yield* tasks.check({ commandId: command("check-2"), ref: task.ref }, human))
          .task;
        assert.deepEqual(
          [
            merged.status,
            merged.result?.pullRequest?.state,
            merged.result?.delivery,
            merged.attention,
          ],
          ["done", "merged", null, []],
        );
        assert.deepEqual(probe.checks, [mergeId, againId]);
        assert.deepEqual(probe.grants, [
          "merge-pr",
          "publish-pr",
          "publish-pr",
          "merge-pr",
          "merge-pr",
        ]);
        assert.deepEqual(
          (yield* tasks.activity({ ref: task.ref })).entries.flatMap((entry) =>
            entry.event.type === "pull-request"
              ? [`${entry.event.action} #${entry.event.number} rev ${entry.event.revision}`]
              : [],
          ),
          ["opened #12 rev 1", "merged #12 rev 1"],
        );
      }),
    ),
);

it.effect("a task made from retained Work carries it as its source", () =>
  scenario(
    Effect.gen(function* () {
      const { tasks, create } = yield* harness;
      const plans = yield* Plans.FactoryPlanService;
      const task = yield* create("Server Git tests fail on Windows", { workRef: issueRef });
      assert.deepEqual(task.source, {
        kind: "issue",
        label: "GitHub #96",
        url: null,
        key: null,
        workRef: issueRef,
      });
      const plan = yield* plans.read({
        ref: { environmentId, projectId, rootId: task.ref.rootId },
      });
      assert.deepEqual(
        plan.workContexts.map((context) => [context.taskId, context.snapshot]),
        [[task.ref.taskId, "Path separators differ on Windows."]],
      );
      assert.deepEqual(
        (yield* tasks.list({ sourceKinds: ["issue"] })).items.map((item) => item.displayId),
        [task.displayId],
      );
      const created = (yield* tasks.activity({ ref: task.ref })).entries[0]!.event;
      assert.deepEqual(created, { type: "created", source: task.source, ruleName: null });
      assert.equal(
        (yield* tasks
          .create(
            {
              commandId: command("gone"),
              projectId,
              title: "From nothing",
              workRef: { ...issueRef, id: "issue-404" },
            },
            human,
          )
          .pipe(Effect.flip)).reason,
        "invalid-input",
      );
      assert.deepEqual((yield* tasks.list({ text: "From nothing" })).items, []);
    }),
  ),
);

it.effect(
  "request changes runs the same assignee again and the next result replaces the one under review",
  () =>
    scenario(
      Effect.gen(function* () {
        const { sql, tasks, create, start, finish, until } = yield* harness;
        const task = yield* create("Audio ring demo", { lane: "ready" });
        const first = (yield* start(task, setupOf("opus"))).run!;
        yield* finish(first, "sealed");
        const review = yield* until(task, (current) => current.status === "in-review");

        const changing = (yield* tasks.requestChanges(
          { commandId: command("changes"), ref: task.ref, revision: 1, note: "Keep cursor paging" },
          human,
        )).task;
        const second = changing.run!;
        assert.deepEqual(
          [changing.status, second.ordinal, second.state, changing.assignee.key],
          ["in-progress", 2, "running", review.assignee.key],
        );
        assert.deepEqual(second.setup, first.setup);
        assert.deepEqual(changing.attention, []);
        // The sealed attempt cannot continue: the note and the result's commit start a new one.
        const bindings = yield* sql<{
          text: string;
          baseRef: string;
          revision: number;
        }>`SELECT json_extract(binding_json, '$.inputText') AS text, json_extract(binding_json, '$.spec.workspaceStrategy.baseRef') AS baseRef, revision FROM factory_execution_bindings WHERE thread_id = ${second.threadId}`;
        assert.include(
          bindings[0]!.text,
          "Changes requested on the previous result:\nKeep cursor paging",
        );
        assert.deepEqual([bindings[0]!.baseRef, bindings[0]!.revision], [resultCommit, 2]);
        assert.equal(
          (yield* tasks
            .accept({ commandId: command("mid-run"), ref: task.ref, revision: 1 }, human)
            .pipe(Effect.flip)).reason,
          "run-active",
        );

        yield* finish(second, "sealed");
        const replaced = yield* until(task, (current) => current.result?.revision === 2);
        assert.deepEqual(
          [replaced.status, replaced.result?.state, replaced.result?.runOrdinal],
          ["in-review", "ready", 2],
        );
        assert.deepEqual(
          yield* sql`SELECT input_note AS note FROM factory_tasks WHERE task_id = ${task.ref.taskId}`,
          [{ note: null }],
        );
        assert.equal(
          (yield* tasks
            .accept({ commandId: command("old"), ref: task.ref, revision: 1 }, human)
            .pipe(Effect.flip)).reason,
          "result-conflict",
        );
        assert.equal(
          (yield* tasks.accept({ commandId: command("new"), ref: task.ref, revision: 2 }, human))
            .task.status,
          "done",
        );
        // Publish names the revision its person saw accepted; an older one is refused.
        assert.equal(
          (yield* tasks
            .publish({ commandId: command("publish-old"), ref: task.ref, revision: 1 }, human)
            .pipe(Effect.flip)).reason,
          "result-conflict",
        );
        assert.equal((yield* tasks.readResult({ ref: task.ref, revision: 1 })).result.revision, 1);
      }),
    ),
);

it.effect.each([false, true])(
  "a document result uses the final answer (messages: %s)",
  (messages) =>
    scenario(
      Effect.gen(function* () {
        const { tasks, create, start, finish, until } = yield* harness;
        const task = yield* create("Prerequisite view docs", { lane: "ready", type: "docs" });
        const run = (yield* start(task, setupOf("flash", "root"))).run!;
        const text =
          "I will inspect the prerequisites.\n\n# Prerequisite view\nA sub-task waits on its blockers.";
        if (messages) {
          const projection = yield* ProjectionStore.ProjectionStoreV2;
          for (const [index, body] of [
            "I will inspect the prerequisites.",
            "# Prerequisite view\n\nA sub-task waits on its blockers.",
          ].entries()) {
            yield* projection.apply({
              id: EventId.make(`answer-${index}`),
              type: "message.updated",
              threadId: run.threadId,
              occurredAt: DateTime.makeUnsafe(at),
              payload: {
                id: MessageId.make(`answer-${index}`),
                threadId: run.threadId,
                runId: run.runId,
                nodeId: null,
                role: "assistant",
                text: body,
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: DateTime.makeUnsafe(at),
                updatedAt: DateTime.makeUnsafe(at),
              },
            });
          }
        }
        yield* finish(run, "sealed", text);
        const review = yield* until(task, (current) => current.status === "in-review");
        assert.deepEqual(
          [review.result?.kind, review.result?.summary],
          ["document", "Prerequisite view"],
        );
        const document = yield* tasks.readResult({ ref: task.ref });
        assert.equal(document.text, text);
        assert.deepEqual(document.files, []);
        assert.equal(
          (yield* tasks.readResult({ ref: task.ref, revision: 7 }).pipe(Effect.flip)).reason,
          "no-result",
        );
        yield* tasks.accept(
          { commandId: command("accept-doc"), ref: task.ref, revision: 1 },
          human,
        );
        assert.equal(
          (yield* tasks
            .publish({ commandId: command("publish-doc"), ref: task.ref, revision: 1 }, human)
            .pipe(Effect.flip)).reason,
          "not-code",
        );
      }),
    ),
);

it.effect(
  "a second start keeps the first run authorized, and a plan edit mid-run still ends in a result",
  () =>
    scenario(
      Effect.gen(function* () {
        const { sql, tasks, create, subtask, summary, start, attemptOf, finish, until } =
          yield* harness;
        const engine = yield* ExecutionStore.FactoryExecutionStore;
        const parent = yield* create("Unified task model");
        const contract = yield* subtask("Contract and migration", parent);
        const guide = yield* subtask("User guide for Tasks", parent);
        const selected = (task: FactoryTaskSummary) =>
          sql<{
            resultId: string | null;
          }>`SELECT selected_result_id AS resultId FROM factory_execution_tasks WHERE root_id = ${task.ref.rootId} AND task_id = ${task.ref.taskId} ORDER BY revision DESC LIMIT 1`.pipe(
            Effect.map((rows) => rows[0]!.resultId),
          );

        const contractRun = (yield* start(contract, setupOf("opus", "root"))).run!;
        const guideRun = (yield* start(guide, setupOf("flash", "root"))).run!;
        const running = yield* summary(parent);
        assert.deepEqual(
          [running.status, running.liveRuns.map((live) => live.displayId).sort()],
          ["in-progress", ["T-1.1", "T-1.2"]],
        );

        // The second start issued a new grant. The first run's result is still the engine's pick.
        yield* finish(contractRun, "sealed", "Contract drafted.");
        yield* until(contract, (current) => current.status === "in-review");
        assert.isNotNull(yield* selected(contract));
        const waiting = yield* summary(parent);
        assert.deepEqual(
          waiting.attention.map((entry) => [entry.reason, entry.displayId]),
          [["review", "T-1.1"]],
        );
        assert.deepEqual(
          [waiting.liveRuns.map((live) => live.displayId), waiting.progress],
          [["T-1.2"], { done: 0, total: 2 }],
        );

        // A title edit moves the plan revision under the running sibling. The engine stops
        // authorizing that run's later steps and does not pick its result.
        yield* tasks.update(
          {
            commandId: command("rename"),
            ref: parent.ref,
            expectedVersion: (yield* summary(parent)).version,
            title: "Unified task model, second draft",
          },
          human,
        );
        assert.deepEqual(
          yield* engine.claimPhase({
            runAttemptId: yield* attemptOf(guideRun),
            phase: "session",
            claimantId: "worker",
          }),
          { status: "suppressed" },
        );
        yield* finish(guideRun, "sealed", "Guide written.");
        const reviewed = yield* until(guide, (current) => current.status === "in-review");
        assert.isNull(yield* selected(guide));
        // The task keeps its run and its result across the revision.
        assert.deepEqual(
          [reviewed.run?.state, reviewed.result?.revision, reviewed.result?.summary],
          ["completed", 1, "Guide written."],
        );
        assert.equal(
          (yield* tasks.accept({ commandId: command("guide"), ref: guide.ref, revision: 1 }, human))
            .task.status,
          "done",
        );
        assert.deepEqual((yield* summary(parent)).progress, { done: 1, total: 2 });
      }),
    ),
);

it.effect(
  "auto resolves through the parent, a profile for the type, the project and the environment",
  () =>
    scenario(
      Effect.gen(function* () {
        const { sql, tasks, create, subtask } = yield* harness;
        const profiles = yield* Profiles.FactoryAgentProfileService;
        const auto = { mode: "auto" } as const;
        const resolved = (task: FactoryTaskSummary) => [
          task.assignee.resolved?.via,
          task.assignee.key,
        ];

        const environment = yield* create("Weekly dependency review", { assignment: auto });
        assert.deepEqual(resolved(environment), ["environment-default", "devReplay/environment"]);
        // Supervised, in a new worktree.
        assert.deepEqual(environment.assignee.resolved?.setup, setupOf("environment"));

        yield* sql`UPDATE projection_projects SET default_model_selection_json = ${canonicalExecutionJson(model("project"))} WHERE project_id = ${projectId}`;
        const project = yield* create("Benchmark index paths", { assignment: auto });
        assert.deepEqual(resolved(project), ["project-default", "devReplay/project"]);
        assert.deepEqual(
          resolved(
            yield* create("Scholar page sync", { assignment: auto, projectId: otherProjectId }),
          ),
          ["environment-default", "devReplay/environment"],
        );

        const implementer = (yield* profiles.save(
          {
            commandId: command("implementer"),
            name: "Implementer",
            setup: setupOf("sol"),
            handles: ["bug"],
          },
          human,
        )).profile!;
        const bug = yield* create("Board cards overflow at 1280", {
          assignment: auto,
          type: "bug",
        });
        assert.deepEqual(resolved(bug), ["profile-type", implementer.id]);
        assert.deepEqual(bug.assignee.resolved?.profile, {
          id: implementer.id,
          name: "Implementer",
        });
        assert.deepEqual(resolved(yield* create("Plain task", { assignment: auto })), [
          "project-default",
          "devReplay/project",
        ]);

        const parent = yield* create("Unified task model", {
          assignment: { mode: "pinned", setup: setupOf("opus", "root") },
        });
        const child = yield* subtask("Contract and migration", parent);
        assert.deepEqual(resolved(child), ["parent", "devReplay/opus"]);
        assert.deepEqual(child.assignee.resolved?.setup, setupOf("opus", "root"));
        assert.deepEqual(resolved(parent), ["assignment", "devReplay/opus"]);

        const intermediate = yield* create("Person-owned intermediate", {
          parent: { rootId: parent.ref.rootId, taskId: parent.ref.taskId },
          assignment: { mode: "person" },
        });
        const preview = yield* tasks.resolveAssignee({
          projectId,
          type: "bug",
          assignment: auto,
          parent: intermediate.ref,
        });
        assert.deepEqual(
          [preview.resolved?.via, preview.resolved?.setup],
          ["parent", setupOf("opus", "root")],
        );
        assert.equal(
          (yield* tasks
            .resolveAssignee({
              projectId: otherProjectId,
              type: "task",
              assignment: auto,
              parent: intermediate.ref,
            })
            .pipe(Effect.flip)).reason,
          "invalid-input",
        );

        const asked = yield* tasks.resolveAssignee({ projectId, type: "bug", assignment: auto });
        assert.deepEqual([asked.resolved?.via, asked.key], ["profile-type", implementer.id]);
        assert.deepEqual(
          yield* tasks.resolveAssignee({
            projectId,
            type: "task",
            assignment: { mode: "person" },
          }),
          { assignment: { mode: "person" }, key: "person", resolved: null },
        );
      }),
      model("environment"),
    ),
);

it.effect(
  "a plan edited outside the task service shows up in the list and on the change feed",
  () =>
    scenario(
      Effect.gen(function* () {
        const { tasks, changesUntil } = yield* harness;
        const plans = yield* Plans.FactoryPlanService;
        const created = yield* plans.create(
          { commandId: command("old-editor"), projectId, title: "Rename repository identity" },
          human,
        );
        const rootId = created.plan.ref.rootId;
        assert.isTrue((yield* changesUntil(rootId)).at(-1)!.rootIds.includes(rootId));
        assert.deepEqual(
          (yield* tasks.list({})).items.map((task) => [task.displayId, task.title, task.status]),
          [["T-1", "Rename repository identity", "backlog"]],
        );
        const before = (yield* tasks.list({})).items[0]!;

        yield* plans.apply(
          {
            commandId: command("old-editor-edit"),
            ref: created.plan.ref,
            expectedRevision: 1,
            operations: [
              { type: "task.update", id: rootId, title: "Rename the repository" },
              { type: "task.add", id: "docs", parentId: rootId, title: "Update the docs" },
            ],
          },
          human,
        );
        const announced = yield* changesUntil(rootId);
        assert.deepEqual(announced.at(-1), { environmentId, rootIds: [rootId], profiles: false });
        const listed = (yield* tasks.list({ scope: "all" })).items;
        assert.deepEqual(listed.map((task) => [task.displayId, task.title]).sort(), [
          ["T-1", "Rename the repository"],
          ["T-1.1", "Update the docs"],
        ]);
        // A plan edit advances the version an update must name.
        assert.isAbove(listed.find((task) => task.displayId === "T-1")!.version, before.version);
      }),
    ),
);

it.effect(
  "saves, renames and deletes agent profiles, and a task that named one falls back to unassigned",
  () =>
    scenario(
      Effect.gen(function* () {
        const { tasks, create, start, feed } = yield* harness;
        const profiles = yield* Profiles.FactoryAgentProfileService;
        const input = {
          commandId: command("save"),
          name: "Implementer",
          setup: setupOf("sol"),
          handles: ["bug", "feature"],
        } as const;
        const saved = yield* profiles.save(input, human);
        const implementer = saved.profile!;
        assert.deepEqual(
          [saved.replayed, implementer.version, implementer.name],
          [false, 0, "Implementer"],
        );
        assert.deepEqual(yield* profiles.save(input, human), {
          profile: implementer,
          replayed: true,
        });
        assert.equal(
          (yield* profiles.save({ ...input, name: "Other" }, human).pipe(Effect.flip)).reason,
          "command-conflict",
        );
        assert.equal(
          (yield* profiles
            .save({ ...input, commandId: command("clash"), name: "implementer" }, human)
            .pipe(Effect.flip)).reason,
          "name-taken",
        );
        assert.equal(
          (yield* profiles
            .save(input, { kind: "agent", threadId: ThreadId.make("agent") })
            .pipe(Effect.flip)).reason,
          "forbidden",
        );
        const scout = (yield* profiles.save(
          { commandId: command("scout"), name: "Scout", setup: setupOf("luna"), handles: [] },
          human,
        )).profile!;
        const rename = {
          commandId: command("rename"),
          id: scout.id,
          expectedVersion: scout.version,
          name: "Implementer",
          setup: scout.setup,
          handles: [],
        } as const;
        assert.equal((yield* profiles.save(rename, human).pipe(Effect.flip)).reason, "name-taken");
        const stale = yield* profiles
          .save(
            { ...rename, commandId: command("stale"), name: "Checker", expectedVersion: 4 },
            human,
          )
          .pipe(Effect.flip);
        assert.deepEqual([stale.reason, stale.currentVersion], ["version-conflict", 0]);
        const renamed = (yield* profiles.save(
          { ...rename, commandId: command("renamed"), name: "Checker" },
          human,
        )).profile!;
        assert.deepEqual([renamed.id, renamed.name, renamed.version], [scout.id, "Checker", 1]);

        const task = yield* create("Gate tooling fixes", {
          lane: "ready",
          assignment: { mode: "profile", profileId: implementer.id },
        });
        assert.deepEqual(
          [task.assignee.key, task.assignee.resolved?.profile?.name, task.assignee.resolved?.via],
          [implementer.id, "Implementer", "assignment"],
        );
        assert.deepEqual(
          (yield* tasks.list({ assigneeKeys: [implementer.id] })).items.map(
            (item) => item.displayId,
          ),
          ["T-1"],
        );
        const running = yield* start(task, implementer.setup);
        assert.equal(running.assignee.assignment.mode, "profile");
        assert.deepEqual(
          (yield* profiles.list()).profiles
            .map((entry) => `${entry.profile.name}:${entry.tasksThisWeek}`)
            .toSorted(),
          ["Checker:0", "Implementer:1"],
        );

        const removal = {
          commandId: command("delete"),
          id: implementer.id,
          expectedVersion: implementer.version,
        };
        assert.equal(
          (yield* profiles
            .delete({ ...removal, commandId: command("delete-stale"), expectedVersion: 9 }, human)
            .pipe(Effect.flip)).reason,
          "version-conflict",
        );
        assert.deepEqual(yield* profiles.delete(removal, human), {
          profile: null,
          replayed: false,
        });
        assert.deepEqual(yield* profiles.delete(removal, human), { profile: null, replayed: true });
        // Saving and deleting profiles says so on the feed, whatever else rode along.
        let change = yield* PubSub.take(feed);
        while (!change.profiles) change = yield* PubSub.take(feed);

        const orphan = (yield* tasks.read({ task: { ref: task.ref } })).task;
        assert.deepEqual(orphan.assignee, {
          assignment: { mode: "profile", profileId: implementer.id },
          key: "unassigned",
          resolved: null,
        });
        assert.deepEqual(
          (yield* tasks.list({ assigneeKeys: ["unassigned"] })).items.map((item) => item.displayId),
          ["T-1"],
        );
        assert.deepEqual(
          (yield* profiles.list()).profiles.map((entry) => entry.profile.name),
          ["Checker"],
        );
        assert.equal(
          (yield* profiles
            .delete({ ...removal, commandId: command("delete-gone") }, human)
            .pipe(Effect.flip)).reason,
          "missing-profile",
        );
      }),
    ),
);

it.effect(
  "work done inside a caller's transaction is undone with it, and announced only once it commits",
  () =>
    scenario(
      Effect.gen(function* () {
        const { sql, tasks, create, feed, changesUntil } = yield* harness;
        const plans = yield* Plans.FactoryPlanService;
        const parent = yield* create("Unified task model");
        const planRef = { environmentId, projectId, rootId: parent.ref.rootId };
        const approve = Effect.gen(function* () {
          const made = yield* tasks.createSubtasks(
            {
              commandId: command("approve-plan"),
              parent: parent.ref,
              items: [
                {
                  key: "first",
                  title: "Contract and migration",
                  description: "",
                  assignment: { mode: "auto" },
                  after: [],
                },
                {
                  key: "second",
                  title: "Move the list API",
                  description: "",
                  assignment: { mode: "auto" },
                  after: ["first"],
                },
              ],
            },
            human,
          );
          yield* tasks.recordProposal({
            ref: parent.ref,
            proposalId: "proposal",
            itemCount: 2,
            status: "approved",
            actor: human,
          });
          // The caller reads its own uncommitted work.
          const inside = yield* tasks.read({ task: { ref: parent.ref } });
          assert.deepEqual(
            inside.subtasks.map((task) => task.displayId),
            ["T-1.1", "T-1.2"],
          );
          return made;
        });
        const survivors = Effect.gen(function* () {
          const counted = yield* sql<{
            tasks: number;
            activity: number;
            proposals: number;
            receipts: number;
          }>`SELECT (SELECT count(*) FROM factory_tasks WHERE root_id = ${parent.ref.rootId} AND parent_id IS NOT NULL) AS tasks, (SELECT count(*) FROM factory_task_activity WHERE root_id = ${parent.ref.rootId} AND json_extract(event_json, '$.type') <> 'created') AS activity, (SELECT count(*) FROM factory_task_proposal_facts) AS proposals, (SELECT count(*) FROM factory_task_commands WHERE command_id = 'approve-plan') AS receipts`;
          return {
            ...counted[0]!,
            revision: (yield* plans.read({ ref: planRef })).revision,
            listed: (yield* tasks.list({ scope: "all", projectIds: [projectId] })).items.length,
          };
        });
        // Everything announced so far is taken, so what follows belongs to the transactions.
        const before = yield* create("Marker before");
        yield* changesUntil(before.ref.rootId);

        assert.equal(
          yield* sql
            .withTransaction(
              approve.pipe(Effect.andThen(Effect.fail("the caller's own step failed" as const))),
            )
            .pipe(Effect.flip),
          "the caller's own step failed",
        );
        assert.deepEqual(yield* survivors, {
          tasks: 0,
          activity: 0,
          proposals: 0,
          receipts: 0,
          revision: 1,
          listed: 2,
        });
        const afterRollback = yield* create("Marker after rollback");
        assert.isFalse(
          (yield* changesUntil(afterRollback.ref.rootId)).some((change) =>
            change.rootIds.includes(parent.ref.rootId),
          ),
        );

        // The same command commits this time, numbered as if the first try never happened.
        const made = yield* sql.withTransaction(
          approve.pipe(
            Effect.tap(() =>
              // Still open: nothing about this top-level task has been announced.
              PubSub.takeUpTo(feed, 64).pipe(
                Effect.map((early) =>
                  assert.isFalse(
                    early.some((change) => change.rootIds.includes(parent.ref.rootId)),
                  ),
                ),
              ),
            ),
          ),
        );
        assert.deepEqual(
          made.created.map((entry) => [
            entry.key,
            entry.task.displayId,
            entry.task.blockedBy.length,
          ]),
          [
            ["first", "T-1.1", 0],
            ["second", "T-1.2", 1],
          ],
        );
        assert.isTrue(
          (yield* changesUntil(parent.ref.rootId)).at(-1)!.rootIds.includes(parent.ref.rootId),
        );
        assert.deepEqual(yield* survivors, {
          tasks: 2,
          activity: 2,
          proposals: 1,
          receipts: 1,
          revision: 2,
          listed: 5,
        });
        assert.deepEqual(
          (yield* tasks.activity({ ref: parent.ref })).entries.map((entry) => entry.event.type),
          ["created", "subtasks-added", "plan-approved"],
        );
      }),
    ),
);

it.effect("a planning run and a waiting proposal show on the task and on its parent", () =>
  scenario(
    Effect.gen(function* () {
      const { sql, tasks, create, subtask, summary } = yield* harness;
      const parent = yield* create("Unified task model");
      const child = yield* subtask("Move the list API", parent);
      const planning = {
        ref: child.ref,
        threadId: ThreadId.make("planning-thread"),
        runId: RunId.make("planning-run"),
        setup: setupOf("opus"),
      };
      yield* tasks.recordPlanningRun(planning);
      yield* tasks.recordPlanningRun(planning);
      const live = yield* summary(child);
      // Planning is not work: the task stays where its lane put it.
      assert.deepEqual(
        [live.status, live.run?.purpose, live.run?.state, live.liveRuns.length],
        ["backlog", "planning", "running", 1],
      );
      assert.deepEqual(
        (yield* summary(parent)).liveRuns.map((run) => run.displayId),
        ["T-1.1"],
      );
      const currentParent = yield* summary(parent);
      assert.equal(
        (yield* tasks
          .update(
            {
              commandId: command("cancel-live-parent"),
              ref: parent.ref,
              expectedVersion: currentParent.version,
              lane: "canceled",
            },
            human,
          )
          .pipe(Effect.flip)).reason,
        "run-active",
      );
      assert.equal(
        (yield* tasks.findByThread({ threadId: planning.threadId })).task?.displayId,
        "T-1.1",
      );

      yield* tasks.recordProposal({
        ref: child.ref,
        proposalId: "proposal",
        itemCount: 3,
        status: "proposed",
        actor: { kind: "agent", threadId: planning.threadId },
      });
      assert.deepEqual(
        (yield* summary(parent)).attention.map((entry) => [
          entry.reason,
          entry.displayId,
          entry.detail,
        ]),
        [["plan", "T-1.1", "3 sub-tasks"]],
      );
      // A planning run is an ordinary thread: its state is the thread's run.
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_instance_id,provider_thread_id,status,requested_at,payload_json) VALUES (${planning.runId},${planning.threadId},1,'devReplay','devReplay','native','completed',${at},${canonicalExecutionJson({ status: "completed" })})`;
      yield* tasks.recordProposal({
        ref: child.ref,
        proposalId: "proposal",
        itemCount: 3,
        status: "dismissed",
        actor: human,
      });
      const settled = yield* summary(child);
      assert.deepEqual(
        [settled.run?.state, settled.liveRuns.length, settled.attention.length],
        ["completed", 0, 0],
      );
      assert.deepEqual(
        (yield* tasks.activity({ ref: child.ref })).entries.map((entry) => [
          entry.event.type,
          entry.actor.kind,
        ]),
        [
          ["created", "person"],
          ["run-started", "system"],
          ["plan-proposed", "agent"],
        ],
      );
    }),
  ),
);
