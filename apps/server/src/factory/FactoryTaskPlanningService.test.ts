import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  FactoryTaskError,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type FactoryAgentSetup,
  type FactoryTaskDetail,
  type FactoryTaskSummary,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { liveThreadShell, idleThreadProjection } from "../mcp/McpToolAccess.testkit.ts";
import * as Handlers from "../mcp/toolkits/factory/handlers.ts";
import { FactoryToolkit } from "../mcp/toolkits/factory/tools.ts";
import * as Tasks from "./FactoryTaskService.ts";
import * as Profiles from "./FactoryAgentProfileService.ts";
import * as Planning from "./FactoryTaskPlanningService.ts";

const ref = {
  environmentId: EnvironmentId.make("planning-env"),
  projectId: ProjectId.make("planning-project"),
  rootId: "root",
  taskId: "root",
};
const setup: FactoryAgentSetup = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspace: "worktree",
};
const human = { kind: "human", sessionId: AuthSessionId.make("planner-person") } as const;
const at = "2026-11-10T00:00:00.000Z";
const item = (key: string, after: ReadonlyArray<string> = []) => ({
  key,
  title: `Implement ${key}`,
  description: `Deliver ${key}`,
  after,
});
const assigned = (key: string, after: ReadonlyArray<string> = []) => ({
  ...item(key, after),
  assignment: { mode: "auto" as const },
});

const makeHarness = Effect.fn("FactoryTaskPlanningTest.makeHarness")(function* () {
  const base = Layer.mergeAll(Sqlite.layerMemory, NodeCrypto.layer);
  const context = yield* Layer.build(base);
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* sql`CREATE TABLE test_created_subtasks (command_id TEXT PRIMARY KEY, items_json TEXT NOT NULL)`;
  const sessions = yield* AuthSessions.AuthSessionRepository.pipe(
    Effect.provide(AuthSessions.layer),
    Effect.provide(context),
  );
  yield* sessions.create({
    sessionId: human.sessionId,
    subject: "planner",
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
  const summary: FactoryTaskSummary = {
    ref,
    displayId: "T-38",
    parent: null,
    title: "Unified task model",
    type: "feature",
    status: "backlog",
    lane: "backlog",
    assignee: { assignment: { mode: "unassigned" }, key: "unassigned", resolved: null },
    source: { kind: "local", label: "Local", url: null, key: null, workRef: null },
    blockedBy: [],
    progress: null,
    run: null,
    liveRuns: [],
    attention: [],
    result: null,
    version: 0,
    createdAt: at,
    updatedAt: at,
  };
  let detail: FactoryTaskDetail = {
    task: summary,
    description: "Unify the task views",
    ancestors: [],
    subtasks: [],
    blockedBy: [],
    blocks: [],
    runs: [],
    fetchedAt: at,
  };
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const launches: Array<Launch.ThreadLaunchInput> = [];
  const runs: Array<Parameters<Tasks.FactoryTaskService["Service"]["recordPlanningRun"]>[0]> = [];
  const proposals: Array<Parameters<Tasks.FactoryTaskService["Service"]["recordProposal"]>[0]> = [];
  const creates: Array<Parameters<Tasks.FactoryTaskService["Service"]["createSubtasks"]>[0]> = [];
  let failLaunch = false;
  let failRecord = false;
  let gate: {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null = null;
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(ref.environmentId),
    }),
    Layer.mock(Tasks.FactoryTaskService)({
      read: (input) =>
        Effect.suspend(() => {
          if (!("ref" in input.task) || input.task.ref.rootId !== ref.rootId)
            return Effect.fail(new FactoryTaskError({ reason: "missing-task" }));
          return Effect.succeed(
            input.task.ref.taskId === ref.taskId
              ? detail
              : { ...detail, task: { ...summary, ref: input.task.ref }, subtasks: [] },
          );
        }),
      recordPlanningRun: (input) =>
        Effect.sync(() => {
          runs.push(input);
          detail = {
            ...detail,
            runs: [
              {
                ...input,
                ordinal: runs.length,
                state: "running",
                purpose: "planning",
                startedAt: at,
                endedAt: null,
                note: null,
              },
            ],
          };
        }),
      recordProposal: (input) =>
        Effect.suspend(() => {
          if (failRecord)
            return Effect.fail(new FactoryTaskError({ reason: "persistence-failure" }));
          proposals.push(input);
          return Effect.void;
        }),
      createSubtasks: Effect.fn("FactoryTaskPlanningTest.createSubtasks")(function* (input) {
        creates.push(input);
        yield* sql`INSERT INTO test_created_subtasks(command_id, items_json) VALUES (${input.commandId}, ${JSON.stringify(input.items)})`.pipe(
          Effect.mapError(
            (cause) => new FactoryTaskError({ reason: "persistence-failure", cause }),
          ),
        );
        return { parent: summary, created: [] };
      }),
    }),
    Layer.mock(Profiles.FactoryAgentProfileService)({
      list: () =>
        Effect.succeed({
          profiles: [
            {
              profile: {
                id: "architect",
                name: "Architect",
                setup,
                handles: [],
                version: 0,
                createdAt: at,
                updatedAt: at,
              },
              tasksThisWeek: 0,
            },
          ],
          fetchedAt: at,
        }),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
    }),
    Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
        Effect.gen(function* () {
          if (gate !== null) {
            yield* Deferred.succeed(gate.entered, undefined);
            yield* Deferred.await(gate.release);
          }
          if (failLaunch)
            return yield* new Launch.ThreadLaunchError({
              operation: "dispatch-message",
              commandId: input.commandId,
              projectId: ref.projectId,
              threadId: input.threadId!,
              cause: "test",
            });
          launches.push(input);
          const shell = {
            ...liveThreadShell(input.threadId!),
            projectId: ref.projectId,
            ...setup,
            title: input.title,
          };
          shells.set(shell.id, shell);
          const projection = idleThreadProjection(shell);
          return {
            threadId: shell.id,
            resumed: false,
            projection: {
              ...projection,
              runs: [
                {
                  id: RunId.make(`run:${shell.id}`),
                  threadId: shell.id,
                  ordinal: 1,
                  providerInstanceId: setup.modelSelection.instanceId,
                  modelSelection: setup.modelSelection,
                  providerThreadId: null,
                  userMessageId: input.initialMessage!.messageId!,
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: "running",
                  requestedAt: shell.createdAt,
                  startedAt: shell.createdAt,
                  completedAt: null,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              ],
            },
          };
        }),
    }),
  );
  const serviceContext = yield* Layer.build(
    Planning.layer.pipe(Layer.provide(dependencies), Layer.provide(Layer.succeedContext(context))),
  );
  const service = Context.get(serviceContext, Planning.FactoryTaskPlanningService);
  const tool = Effect.fn("FactoryTaskPlanningTest.tool")(function* (
    input: typeof Planning.ProposeSubtasksInput.Type,
    threadId: ThreadId,
  ) {
    const deps = Layer.mergeAll(
      dependencies,
      Layer.succeed(Planning.FactoryTaskPlanningService, service),
      Layer.succeed(Invocation.McpInvocationContext, {
        environmentId: ref.environmentId,
        requestNamespace: "planning",
        thread: {
          threadId,
          providerSessionId: "test",
          providerInstanceId: setup.modelSelection.instanceId,
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
    );
    const toolkit = yield* FactoryToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(deps))),
    );
    return yield* toolkit
      .handle("factory_propose_subtasks", input)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps));
  });
  return {
    summary,
    service,
    sql,
    launches,
    runs,
    proposals,
    creates,
    shells,
    tool,
    secondService: Effect.map(
      Layer.build(
        Planning.layer.pipe(
          Layer.provide(dependencies),
          Layer.provide(Layer.succeedContext(context)),
        ),
      ),
      (built) => Context.get(built, Planning.FactoryTaskPlanningService),
    ),
    setDetail: (change: Partial<FactoryTaskDetail>) => {
      detail = { ...detail, ...change };
    },
    finishRuns: () => {
      detail = {
        ...detail,
        runs: detail.runs.map((run) => ({ ...run, state: "completed" as const, endedAt: at })),
      };
    },
    setStatus: (status: FactoryTaskSummary["status"]) => {
      detail = { ...detail, task: { ...detail.task, status } };
    },
    setFailLaunch: (value: boolean) => {
      failLaunch = value;
    },
    setFailRecord: (value: boolean) => {
      failRecord = value;
    },
    holdLaunch: Effect.fn("FactoryTaskPlanningTest.holdLaunch")(function* () {
      const held = {
        entered: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      gate = held;
      return held;
    }),
    request: { commandId: CommandId.make("breakdown"), ref, expectedVersion: 0, setup },
  };
});

it.effect(
  "launches one project-checkout planning thread, replays and refuses live or closed tasks",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = yield* h.service.requestBreakdown(h.request, human);
      assert.isFalse(result.replayed);
      assert.lengthOf(h.launches, 1);
      assert.deepInclude(h.launches[0], {
        projectId: ref.projectId,
        title: "T-38 Plan: Unified task model",
        workspaceStrategy: { type: "root" },
        modelSelection: setup.modelSelection,
        runtimeMode: setup.runtimeMode,
        interactionMode: setup.interactionMode,
      });
      assert.include(h.launches[0]!.initialMessage!.text, "factory_propose_subtasks exactly once");
      assert.include(h.launches[0]!.initialMessage!.text, "Unify the task views");
      assert.lengthOf(h.runs, 1);
      assert.deepEqual(h.runs[0]!.setup, { ...setup, workspace: "root" });
      assert.notProperty(h.launches[0], "workspace");
      assert.isTrue((yield* h.service.requestBreakdown(h.request, human)).replayed);
      assert.lengthOf(h.launches, 1);
      assert.equal(
        (yield* h.service
          .requestBreakdown({ ...h.request, commandId: CommandId.make("second") }, human)
          .pipe(Effect.flip)).reason,
        "run-active",
      );
      for (const status of ["done", "canceled"] as const) {
        h.setStatus(status);
        assert.equal(
          (yield* h.service
            .requestBreakdown({ ...h.request, commandId: CommandId.make(status) }, human)
            .pipe(Effect.flip)).reason,
          "invalid-transition",
        );
      }
      assert.equal(
        (yield* h.service
          .requestBreakdown({ ...h.request, setup: { ...setup, workspace: "root" } }, human)
          .pipe(Effect.flip)).reason,
        "command-conflict",
      );
    }),
);

it.effect(
  "resumes a persisted launch reservation after failure without changing thread identity",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.setFailLaunch(true);
      yield* h.service.requestBreakdown(h.request, human).pipe(Effect.flip);
      const before = yield* h.sql<{
        json: string;
      }>`SELECT request_json AS json FROM factory_task_breakdowns`;
      h.setFailLaunch(false);
      yield* h.service.requestBreakdown(h.request, human);
      assert.equal(h.launches[0]!.threadId, JSON.parse(before[0]!.json).threadId);
      assert.lengthOf(h.runs, 1);
    }),
);

it.effect(
  "a failed launch gives way to the next request, but not while a launch is still in flight",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const reservedThread = Effect.map(
        h.sql<{ json: string }>`SELECT request_json AS json FROM factory_task_breakdowns`,
        (rows) => ThreadId.make(JSON.parse(rows[0]!.json).threadId),
      );
      h.setFailLaunch(true);
      yield* h.service.requestBreakdown(h.request, human).pipe(Effect.flip);
      const failed = yield* reservedThread;
      h.shells.set(failed, { ...liveThreadShell(failed), status: "idle", activeRunId: null });
      assert.equal(
        (yield* h.service
          .requestBreakdown({ ...h.request, commandId: CommandId.make("after-failure") }, human)
          .pipe(Effect.flip)).reason,
        "persistence-failure",
      );
      h.setFailLaunch(false);
      const held = yield* h.holdLaunch();
      const other = {
        ...h.request,
        commandId: CommandId.make("other-agent"),
        setup: { ...setup, modelSelection: { ...setup.modelSelection, model: "gpt-6-sol" } },
      };
      const launching = yield* h.service.requestBreakdown(other, human).pipe(Effect.forkChild);
      yield* Deferred.await(held.entered);
      assert.equal(
        (yield* h.service
          .requestBreakdown({ ...h.request, commandId: CommandId.make("double-press") }, human)
          .pipe(Effect.flip)).reason,
        "run-active",
      );
      yield* Deferred.succeed(held.release, undefined);
      assert.isFalse((yield* Fiber.join(launching)).replayed);
      assert.lengthOf(h.launches, 1);
      assert.notEqual(h.launches[0]!.threadId, failed);
      assert.equal(h.launches[0]!.modelSelection.model, "gpt-6-sol");
      assert.equal(yield* reservedThread, h.launches[0]!.threadId);
      assert.lengthOf(h.runs, 1);
    }),
);

it.effect(
  "deleting a finished planning thread releases the request, but a missing live run still blocks it",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.service.requestBreakdown(h.request, human);
      const first = h.launches[0]!.threadId!;
      h.shells.delete(first);
      assert.equal(
        (yield* h.service
          .requestBreakdown({ ...h.request, commandId: CommandId.make("live-run") }, human)
          .pipe(Effect.flip)).reason,
        "run-active",
      );
      h.finishRuns();
      yield* h.service.requestBreakdown(
        { ...h.request, commandId: CommandId.make("again") },
        human,
      );
      assert.lengthOf(h.launches, 2);
      assert.notEqual(h.launches[1]!.threadId, first);
    }),
);

it.effect(
  "the real tool binds the caller to one task, resolves profiles and replaces the pending plan",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.service.requestBreakdown(h.request, human);
      const threadId = h.launches[0]!.threadId!;
      const wrong = ThreadId.make("other-planning-thread");
      h.shells.set(wrong, { ...liveThreadShell(wrong), projectId: ref.projectId });
      const input = {
        ref,
        items: [
          { ...item("contracts"), profile: "Architect" },
          { ...item("server", ["contracts"]), profile: "Unknown" },
          item("client", ["contracts"]),
        ],
      };
      assert.deepInclude((yield* h.tool(input, wrong)).at(-1)?.result, { code: "invalid_request" });
      assert.deepInclude(
        (yield* h.tool({ ...input, ref: { ...ref, taskId: "other-task" } }, threadId)).at(-1)
          ?.result,
        { code: "invalid_request" },
      );
      assert.isNull((yield* h.service.readProposal({ ref })).proposal);
      yield* h.tool(input, threadId);
      const first = (yield* h.service.readProposal({ ref })).proposal!;
      assert.deepEqual(
        first.items.map((entry) => entry.assignment),
        [{ mode: "profile", profileId: "architect" }, { mode: "auto" }, { mode: "auto" }],
      );
      yield* h.tool({ ref, items: [item("replacement")] }, threadId);
      const second = (yield* h.service.readProposal({ ref })).proposal!;
      assert.equal(second.id, first.id);
      assert.equal(second.version, first.version + 1);
      assert.deepEqual(
        second.items.map((entry) => entry.key),
        ["replacement"],
      );
      assert.deepEqual(
        h.proposals.map((entry) => entry.status),
        ["proposed", "proposed"],
      );
    }),
);

it.effect.each([
  { name: "duplicate", items: [item("a"), item("a")] },
  { name: "missing dependency", items: [item("a", ["missing"])] },
  { name: "self", items: [item("a", ["a"])] },
  { name: "cycle", items: [item("a", ["b"]), item("b", ["a"])] },
  { name: "too many", items: Array.from({ length: 33 }, (_, n) => item(`item-${n}`)) },
  { name: "empty", items: [] },
])("rejects $name at submission and update without storing it", ({ items }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.service.requestBreakdown(h.request, human);
    assert.equal(
      (yield* h.service.propose({ ref, items }, h.launches[0]!.threadId!).pipe(Effect.flip)).reason,
      "invalid-input",
    );
    assert.isNull((yield* h.service.readProposal({ ref })).proposal);
    const valid = (yield* h.service.propose(
      { ref, items: [item("valid")] },
      h.launches[0]!.threadId!,
    )).proposal;
    assert.equal(
      (yield* h.service
        .updateProposal(
          {
            commandId: CommandId.make("invalid-update"),
            ref,
            proposalId: valid.id,
            expectedVersion: valid.version,
            items: items.map((entry) => ({ ...entry, assignment: { mode: "auto" as const } })),
          },
          human,
        )
        .pipe(Effect.flip)).reason,
      "invalid-input",
    );
    assert.deepEqual((yield* h.service.readProposal({ ref })).proposal, valid);
  }),
);

it.effect("rechecks the whole plan limit at submission and approval", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.service.requestBreakdown(h.request, human);
    const threadId = h.launches[0]!.threadId!;
    const proposal = (yield* h.service.propose(
      { ref, items: [item("a"), item("b", ["a"])] },
      threadId,
    )).proposal;
    h.setDetail({
      subtasks: Array.from({ length: 62 }, (_, n) => ({
        ...h.request.ref,
        taskId: `existing-${n}`,
      })).map((childRef) => ({ ...h.summary, ref: childRef })),
    });
    assert.equal(
      (yield* h.service.propose({ ref, items: [item("a"), item("b")] }, threadId).pipe(Effect.flip))
        .reason,
      "task-limit",
    );
    assert.equal(
      (yield* h.service
        .resolveProposal(
          {
            commandId: CommandId.make("over-limit"),
            ref,
            proposalId: proposal.id,
            expectedVersion: proposal.version,
            action: "approve",
          },
          human,
        )
        .pipe(Effect.flip)).reason,
      "task-limit",
    );
    assert.lengthOf(h.creates, 0);
    assert.deepEqual((yield* h.service.readProposal({ ref })).proposal, proposal);
  }),
);

it.effect("edits with CAS and payload-bound replay, then approves all items exactly once", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.service.requestBreakdown(h.request, human);
    const first = (yield* h.service.propose({ ref, items: [item("a")] }, h.launches[0]!.threadId!))
      .proposal;
    const update = {
      commandId: CommandId.make("edit"),
      ref,
      proposalId: first.id,
      expectedVersion: first.version,
      items: [
        assigned("contracts"),
        {
          ...assigned("server", ["contracts"]),
          assignment: { mode: "profile" as const, profileId: "architect" },
        },
      ],
    };
    assert.equal(
      (yield* h.service
        .updateProposal({ ...update, expectedVersion: first.version + 1 }, human)
        .pipe(Effect.flip)).reason,
      "version-conflict",
    );
    const edited = yield* h.service.updateProposal(update, human);
    assert.isTrue((yield* h.service.updateProposal(update, human)).replayed);
    assert.equal(
      (yield* h.service
        .updateProposal({ ...update, items: [assigned("changed")] }, human)
        .pipe(Effect.flip)).reason,
      "command-conflict",
    );
    const resolve = {
      commandId: CommandId.make("approve"),
      ref,
      proposalId: first.id,
      expectedVersion: edited.proposal.version,
      action: "approve" as const,
    };
    const approved = yield* h.service.resolveProposal(resolve, human);
    assert.equal(approved.proposal.status, "approved");
    assert.lengthOf(h.creates, 1);
    assert.deepEqual(h.creates[0], {
      commandId: resolve.commandId,
      parent: ref,
      items: update.items,
    });
    assert.isTrue((yield* h.service.resolveProposal(resolve, human)).replayed);
    assert.lengthOf(h.creates, 1);
    assert.equal(
      (yield* h.service
        .resolveProposal({ ...resolve, commandId: CommandId.make("again") }, human)
        .pipe(Effect.flip)).reason,
      "invalid-transition",
    );
    assert.isNull((yield* h.service.readProposal({ ref })).proposal);
    assert.equal(
      (yield* h.service
        .propose({ ref, items: [item("late")] }, h.launches[0]!.threadId!)
        .pipe(Effect.flip)).reason,
      "forbidden",
    );
  }),
);

it.effect("dismisses a plan and rolls back a failed record", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.service.requestBreakdown(h.request, human);
    const first = (yield* h.service.propose({ ref, items: [item("a")] }, h.launches[0]!.threadId!))
      .proposal;
    const resolve = {
      commandId: CommandId.make("dismiss"),
      ref,
      proposalId: first.id,
      expectedVersion: first.version,
      action: "dismiss" as const,
    };
    h.setFailRecord(true);
    yield* h.service.resolveProposal(resolve, human).pipe(Effect.flip);
    assert.deepEqual((yield* h.service.readProposal({ ref })).proposal, first);
    h.setFailRecord(false);
    assert.equal((yield* h.service.resolveProposal(resolve, human)).proposal.status, "dismissed");
    assert.isNull((yield* h.service.readProposal({ ref })).proposal);
    assert.lengthOf(h.creates, 0);
    assert.equal(
      (yield* h.service
        .resolveProposal({ ...resolve, commandId: CommandId.make("again") }, human)
        .pipe(Effect.flip)).reason,
      "invalid-transition",
    );
  }),
);

it.effect(
  "serializes approval across service instances and rolls back task creation with the plan",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.service.requestBreakdown(h.request, human);
      const proposal = (yield* h.service.propose(
        { ref, items: [item("a"), item("b", ["a"])] },
        h.launches[0]!.threadId!,
      )).proposal;
      const second = yield* h.secondService;
      assert.deepEqual((yield* second.readProposal({ ref })).proposal, proposal);
      const input = {
        commandId: CommandId.make("atomic-approve"),
        ref,
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        action: "approve" as const,
      };
      h.setFailRecord(true);
      yield* second.resolveProposal(input, human).pipe(Effect.flip);
      assert.deepEqual((yield* h.service.readProposal({ ref })).proposal, proposal);
      assert.lengthOf(yield* h.sql`SELECT * FROM test_created_subtasks`, 0);
      h.setFailRecord(false);
      const outcomes = yield* Effect.all(
        [
          h.service.resolveProposal(input, human).pipe(Effect.result),
          second
            .resolveProposal({ ...input, commandId: CommandId.make("racing-approve") }, human)
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.lengthOf(outcomes.filter(Result.isSuccess), 1);
      assert.equal(outcomes.find(Result.isFailure)!.failure.reason, "invalid-transition");
      assert.lengthOf(yield* h.sql`SELECT * FROM test_created_subtasks`, 1);
    }),
);

it.effect(
  "keeps planning person-authorized and scoped to this environment and current task version",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      assert.equal(
        (yield* h.service
          .requestBreakdown(h.request, { kind: "agent", threadId: ThreadId.make("agent") })
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      assert.equal(
        (yield* h.service
          .requestBreakdown(h.request, { kind: "human", sessionId: AuthSessionId.make("unknown") })
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      assert.equal(
        (yield* h.service
          .requestBreakdown(
            { ...h.request, ref: { ...ref, environmentId: EnvironmentId.make("elsewhere") } },
            human,
          )
          .pipe(Effect.flip)).reason,
        "wrong-environment",
      );
      assert.equal(
        (yield* h.service
          .requestBreakdown({ ...h.request, expectedVersion: 1 }, human)
          .pipe(Effect.flip)).reason,
        "version-conflict",
      );
      assert.lengthOf(h.launches, 0);
      assert.lengthOf(yield* h.sql`SELECT * FROM factory_task_breakdowns`, 0);
      assert.lengthOf(yield* h.sql`SELECT * FROM factory_task_proposal_commands`, 0);
    }),
);
