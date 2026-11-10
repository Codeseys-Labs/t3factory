import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryDeliveryError,
  FactoryFeedError,
  FactoryIssueError,
  FactoryPlanError,
  FactoryResearchError,
  FactoryResearchProtocolId,
  FactoryFeedSourceId,
  MessageId,
  ProjectId,
  FactoryOriginKey,
  FactoryWorkError,
  ProjectCoordinatorError,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type AuthMcpClientAccess,
  type FactoryIssueReadinessReadResult,
  type FactoryReadinessEdge,
  type OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { Tool } from "effect/ai";
import { ServerEnvironmentIdentity } from "../../../environment/ServerEnvironment.ts";
import * as Factory from "../../../factory/FactoryIssueService.ts";
import * as Relations from "../../../factory/FactoryIssueRelations.ts";
import * as Feeds from "../../../factory/FactoryFeedService.ts";
import * as Research from "../../../factory/FactoryResearchService.ts";
import * as Claims from "../../../factory/FactoryClaimsService.ts";
import * as Delivery from "../../../factory/FactoryDeliveryService.ts";
import * as Plans from "../../../factory/FactoryPlanService.ts";
import * as Work from "../../../factory/FactoryWorkService.ts";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Coordinators from "../../../project/ProjectCoordinatorService.ts";
import * as Bindings from "../../../persistence/ProjectCoordinators.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as Receipts from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../../../project/ProjectService.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { FactoryToolkit } from "./tools.ts";
it.effect.each([
  { caller: "local", operation: "task.update", invoked: true, code: "invalid_request" },
  { caller: "linked", operation: "task.update", invoked: false, code: "capability_denied" },
  {
    caller: "external",
    operation: "task.update",
    invoked: false,
    code: "thread_credential_required",
  },
  { caller: "idle", operation: "task.update", invoked: false, code: "parent_not_active" },
  { caller: "local", operation: "editor.grant", invoked: false, code: "capability_denied" },
  { caller: "local", operation: "editor.revoke", invoked: false, code: "capability_denied" },
] as const)(
  "plan $operation from $caller keeps editor authority server-owned",
  ({ caller, operation, invoked, code }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("editor");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const ref = {
        environmentId: EnvironmentId.make("owner"),
        projectId: ProjectId.make("project:mcp-test"),
        rootId: "root",
      };
      let called = false;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: ref.environmentId,
          requestNamespace: "plan-test",
          issuedAt: 0,
          thread:
            caller === "external"
              ? undefined
              : {
                  threadId,
                  providerSessionId: "session",
                  providerInstanceId,
                },
          client:
            caller === "external"
              ? {
                  sessionId: "outside",
                  label: "Outside",
                  access: "full-access",
                }
              : undefined,
          capabilities: new Set<Context.McpCapability>(["orchestration"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed({
              ...liveThreadShell(id, caller === "idle" ? { activeRunId: null } : {}),
              ...(caller === "linked"
                ? {
                    linkOrigin: {
                      sessionId: "peer",
                      label: "Peer",
                      access: "full-access" as const,
                    },
                  }
                : {}),
            }),
        }),
        Layer.mock(Plans.FactoryPlanService)({
          apply: (input, actor) => {
            called = true;
            assert.deepEqual(input.ref, ref);
            assert.deepEqual(actor, { kind: "agent", threadId });
            return Effect.fail(new FactoryPlanError({ reason: "forbidden" }));
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const operations =
        operation === "task.update"
          ? [{ type: operation, id: "root", title: "Updated brief" }]
          : [{ type: operation, threadId }];
      const outputs = yield* toolkit
        .handle("factory_apply_plan", {
          commandId: CommandId.make("edit"),
          ref,
          expectedRevision: 1,
          operations,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(outputs.at(-1)?.result, { code });
      assert.equal(called, invoked);
    }),
);

it.effect.each([
  {
    access: "read-only",
    capabilities: ["orchestration", "worktree"],
    requested: "approval-required",
    code: "capability_denied",
  },
  {
    access: "approval-required",
    capabilities: ["orchestration", "worktree"],
    requested: "full-access",
    code: "runtime_mode_escalation_denied",
  },
  {
    access: "full-access",
    capabilities: ["orchestration"],
    requested: "approval-required",
    code: "capability_denied",
  },
  {
    access: "full-access",
    capabilities: ["worktree"],
    requested: "approval-required",
    code: "capability_denied",
  },
] satisfies ReadonlyArray<{
  access: AuthMcpClientAccess;
  capabilities: ReadonlyArray<Context.McpCapability>;
  requested: "approval-required" | "full-access";
  code: OrchestratorMcpFailure["code"];
}>)(
  "refuses $access launch with $code before service invocation",
  ({ access, capabilities, requested, code }) =>
    Effect.gen(function* () {
      let called = false;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "factory-test",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access },
          capabilities: new Set(capabilities),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Coordinators.ProjectCoordinatorService)({}),
        Layer.mock(Research.FactoryResearchService)({
          launchRun: () => {
            called = true;
            return Effect.die("Unauthorized research launch reached the service");
          },
        }),
        Layer.mock(Feeds.FactoryFeedService)({
          admitCandidate: () => {
            called = true;
            return Effect.die("Unauthorized feed admission reached the service");
          },
        }),
        Layer.mock(Factory.FactoryIssueService)({
          start: () => {
            called = true;
            return Effect.die("Unauthorized factory start reached the service");
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_start_issue", {
          commandId: CommandId.make("start"),
          projectId: ProjectId.make("project"),
          issueNumber: 1,
          expectedRepositoryKey: "github.com/owner/repo",
          expectedIssueRevision: "0".repeat(64),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: requested,
          interactionMode: "default",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(outputs.at(-1)?.result, { code });
      assert.isFalse(called);
      const feedOutputs = yield* toolkit
        .handle("factory_admit_feed_candidate", {
          commandId: CommandId.make("feed-admit"),
          projectId: ProjectId.make("project"),
          sourceId: FactoryFeedSourceId.make("feed"),
          itemKey: "atom:item",
          expectedRepositoryKey: "github.com/owner/repo",
          expectedRevision: "reviewed",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: requested,
          interactionMode: "default",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(feedOutputs.at(-1)?.result, { code });
      assert.isFalse(called);
      const researchOutputs = yield* toolkit
        .handle("factory_launch_research_run", {
          commandId: CommandId.make("research-launch"),
          projectId: ProjectId.make("project"),
          protocolId: FactoryResearchProtocolId.make("protocol"),
          expectedRepositoryKey: "github.com/owner/repo",
          expectedProtocolRevision: "reviewed",
          role: "explore",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: requested,
          interactionMode: "default",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(researchOutputs.at(-1)?.result, { code });
      assert.isFalse(called);
    }),
);

it.effect("refuses a focused issue read without orchestration capability before fetching", () =>
  Effect.gen(function* () {
    let called = false;
    const dependencies = Layer.mergeAll(
      Layer.succeed(Context.McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "factory-read-test",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "test", label: "test", access: "full-access" },
        capabilities: new Set<Context.McpCapability>(["worktree"]),
      }),
      Layer.mock(Threads.ThreadManagementService)({}),
      Layer.mock(Coordinators.ProjectCoordinatorService)({}),
      Layer.mock(Factory.FactoryIssueService)({
        read: () => {
          called = true;
          return Effect.die("Unauthorized issue read reached the source");
        },
      }),
    );
    const toolkit = yield* FactoryToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const outputs = yield* toolkit
      .handle("factory_read_issue", {
        projectId: ProjectId.make("project"),
        issueNumber: 1,
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepInclude(outputs.at(-1)?.result, { code: "capability_denied" });
    assert.isFalse(called);
  }),
);

it.effect.each([true, false])(
  "read-only readiness requires orchestration capability: %s",
  (allowed) =>
    Effect.gen(function* () {
      let called = false;
      const result = {
        repository: {
          provider: SourceControlProviderKind.make("github"),
          host: "github.com",
          repository: "owner/repo",
          canonicalKey: "github.com/owner/repo",
          url: "https://github.com/owner/repo",
        },
        issueNumber: 12,
        readiness: {
          status: "ready" as const,
          reasons: [],
          edges: [],
          basis: "source" as const,
          overrides: [],
          complete: true,
          listedCount: 0,
          summaryTotal: 0,
          observedAt: "2026-10-25T00:00:00.000Z",
        },
      };
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "readiness-test",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "read-only" },
          capabilities: new Set<Context.McpCapability>(allowed ? ["orchestration"] : ["worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Relations.FactoryIssueRelations)({
          read: () =>
            Effect.sync(() => {
              called = true;
              return result;
            }),
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_read_issue_readiness", {
          projectId: ProjectId.make("project"),
          issueNumber: 12,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      if (allowed) assert.deepEqual(outputs.at(-1)?.result, result);
      else assert.deepInclude(outputs.at(-1)?.result, { code: "capability_denied" });
      assert.equal(called, allowed);
    }),
);

it.effect.each([
  {
    access: "read-only",
    capabilities: ["orchestration"],
    requestedRuntime: "approval-required",
    requestedInteraction: "default",
    code: "capability_denied",
  },
  {
    access: "approval-required",
    capabilities: ["orchestration"],
    requestedRuntime: "full-access",
    requestedInteraction: "default",
    code: "runtime_mode_escalation_denied",
  },
  {
    access: "full-access",
    capabilities: ["worktree"],
    requestedRuntime: "approval-required",
    requestedInteraction: "default",
    code: "capability_denied",
  },
  {
    access: "full-access",
    capabilities: ["orchestration"],
    requestedRuntime: "approval-required",
    requestedInteraction: "default",
    caller: { runtimeMode: "approval-required", interactionMode: "plan", active: true },
    code: "interaction_mode_escalation_denied",
  },
  {
    access: "full-access",
    capabilities: ["orchestration"],
    requestedRuntime: "approval-required",
    requestedInteraction: "default",
    caller: { runtimeMode: "approval-required", interactionMode: "default", active: false },
    code: "parent_not_active",
  },
] satisfies ReadonlyArray<{
  access: AuthMcpClientAccess;
  capabilities: ReadonlyArray<Context.McpCapability>;
  requestedRuntime: RuntimeMode;
  requestedInteraction: ProviderInteractionMode;
  caller?: {
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
    active: boolean;
  };
  code: OrchestratorMcpFailure["code"];
}>)(
  "denies orchestrator start with $code before reading or mutating its binding",
  ({ access, capabilities, requestedRuntime, requestedInteraction, caller, code }) =>
    Effect.gen(function* () {
      let called = false;
      const callerThreadId = ThreadId.make("caller");
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "factory-orchestrator-denied",
          issuedAt: 0,
          thread:
            caller === undefined
              ? undefined
              : {
                  threadId: callerThreadId,
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  providerSessionId: "session",
                },
          client: caller === undefined ? { sessionId: "test", label: "test", access } : undefined,
          capabilities: new Set(capabilities),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              liveThreadShell(threadId, {
                runtimeMode: caller?.runtimeMode ?? "approval-required",
                interactionMode: caller?.interactionMode ?? "default",
                ...(caller?.active === false ? { activeRunId: null } : {}),
              }),
            ),
        }),
        Layer.mock(Factory.FactoryIssueService)({}),
        Layer.mock(Coordinators.ProjectCoordinatorService)({
          get: () => {
            called = true;
            return Effect.die("Unauthorized orchestrator start read a binding");
          },
          ensure: () => {
            called = true;
            return Effect.die("Unauthorized orchestrator start reached the service");
          },
          assign: () => {
            called = true;
            return Effect.die("Unauthorized assignment reached the service");
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_start_orchestrator", {
          commandId: CommandId.make("orchestrator-denied"),
          projectId: ProjectId.make("project"),
          expectedThreadId: null,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: requestedRuntime,
          interactionMode: requestedInteraction,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(outputs.at(-1)?.result, { code });
      assert.isFalse(called);
      if (code === "capability_denied" || code === "parent_not_active") {
        const assignment = yield* toolkit
          .handle("factory_assign_orchestrator", {
            commandId: CommandId.make("assignment-denied"),
            projectId: ProjectId.make("project"),
            threadId: ThreadId.make("existing"),
            expectedRevision: 0,
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        assert.deepInclude(assignment.at(-1)?.result, { code });
        assert.isFalse(called);
      }
    }),
);

it.effect.each(["read-only", "full-access"] satisfies ReadonlyArray<AuthMcpClientAccess>)(
  "denies orchestrator read by a %s client without orchestration capability",
  (access) =>
    Effect.gen(function* () {
      let called = false;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "factory-orchestrator-read-denied",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access },
          capabilities: new Set<Context.McpCapability>(["worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Factory.FactoryIssueService)({}),
        Layer.mock(Coordinators.ProjectCoordinatorService)({
          get: () => {
            called = true;
            return Effect.die("Unauthorized orchestrator read reached the service");
          },
          ensure: () => {
            called = true;
            return Effect.die("An orchestrator read tried to start work");
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_get_orchestrator", { projectId: ProjectId.make("project") })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(outputs.at(-1)?.result, { code: "capability_denied" });
      assert.isFalse(called);
    }),
);

it.effect(
  "allows read-only orchestrator inspection without worktree authority or starting work",
  () =>
    Effect.gen(function* () {
      let starts = 0;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "factory-orchestrator-inspect",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "read-only" },
          capabilities: new Set<Context.McpCapability>(["orchestration"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Factory.FactoryIssueService)({}),
        Layer.mock(Coordinators.ProjectCoordinatorService)({
          get: () => Effect.succeed({ coordinator: null, fetchedAt: "2026-10-24T00:00:00.000Z" }),
          ensure: () => {
            starts += 1;
            return Effect.die("Passive inspection tried to create or resume an orchestrator");
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_get_orchestrator", { projectId: ProjectId.make("project") })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(outputs.at(-1)?.result, { coordinator: null });
      assert.equal(starts, 0);
    }),
);

it.effect(
  "allows root orientation without worktree authority, preserving service preflight denial",
  () =>
    Effect.gen(function* () {
      let admitted = false;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "factory-orchestrator-root",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "approval-required" },
          capabilities: new Set<Context.McpCapability>(["orchestration"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Factory.FactoryIssueService)({}),
        Layer.mock(Coordinators.ProjectCoordinatorService)({
          ensure: () => {
            admitted = true;
            return Effect.fail(new ProjectCoordinatorError({ reason: "provider-unavailable" }));
          },
          assign: () => Effect.fail(new ProjectCoordinatorError({ reason: "ineligible-thread" })),
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_start_orchestrator", {
          commandId: CommandId.make("orchestrator-root"),
          projectId: ProjectId.make("project"),
          expectedThreadId: null,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.isTrue(admitted);
      assert.deepInclude(outputs.at(-1)?.result, {
        code: "invalid_request",
        message: new ProjectCoordinatorError({ reason: "provider-unavailable" }).message,
      });
      const assignment = yield* toolkit
        .handle("factory_assign_orchestrator", {
          commandId: CommandId.make("assignment-root"),
          projectId: ProjectId.make("project"),
          threadId: ThreadId.make("existing"),
          expectedRevision: 0,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(assignment.at(-1)?.result, {
        code: "invalid_request",
        message: new ProjectCoordinatorError({ reason: "ineligible-thread" }).message,
      });
    }),
);

it.effect("denies replay of a stored broader launch before any launch or binding mutation", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project");
    const commandId = CommandId.make("reserved-request");
    const createdAt = "2026-10-24T00:00:00.000Z";
    const binding: Bindings.ProjectCoordinatorBinding = {
      revision: 1,
      kind: "launch",
      intent: {
        projectId,
        workspaceRoot: "/projects/target",
        requestCommandId: commandId,
        commandId: CommandId.make("reserved-launch"),
        threadId: ThreadId.make("reserved-thread"),
        messageId: MessageId.make("reserved-message"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        prompt: "Read-only orientation, then wait.",
        createdBy: "user",
        creationSource: "web",
        createdAt,
        previousThreadId: null,
      },
      accepted: 0,
      superseded: 0,
    };
    let sideEffects = 0;
    const base = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(Context.McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "factory-orchestrator-replay",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "test", label: "test", access: "approval-required" },
        capabilities: new Set<Context.McpCapability>(["orchestration"]),
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(null),
      }),
      Layer.mock(Factory.FactoryIssueService)({}),
      Layer.mock(Projects.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Target",
            workspaceRoot: binding.intent.workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
            deletedAt: null,
          }),
      }),
      Layer.mock(Receipts.CommandReceiptStoreV2)({
        getByCommandId: () => Effect.succeedNone,
      }),
      Layer.mock(Bindings.ProjectCoordinators)({
        getByRequest: () => Effect.succeedSome(binding),
        reserve: () => {
          sideEffects += 1;
          return Effect.die("A denied replay reserved another binding");
        },
        accept: () => {
          sideEffects += 1;
          return Effect.die("A denied replay accepted a launch");
        },
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: () => {
          sideEffects += 1;
          return Effect.die("A supervised caller resumed a stored full-access launch");
        },
      }),
    );
    const dependencies = Layer.merge(base, Coordinators.layer.pipe(Layer.provide(base)));
    const toolkit = yield* FactoryToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const outputs = yield* toolkit
      .handle("factory_start_orchestrator", {
        commandId,
        projectId,
        expectedThreadId: binding.intent.threadId,
        modelSelection: binding.intent.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepInclude(outputs.at(-1)?.result, { code: "runtime_mode_escalation_denied" });
    assert.equal(sideEffects, 0);
  }),
);

it.effect("allows read-only feed review without worktree authority or fetching intake", () =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      Layer.succeed(Context.McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "feed-review",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "test", label: "test", access: "read-only" },
        capabilities: new Set<Context.McpCapability>(["orchestration"]),
      }),
      Layer.mock(Threads.ThreadManagementService)({}),
      Layer.mock(Feeds.FactoryFeedService)({
        listCandidates: () =>
          Effect.succeed({
            repository: null,
            candidates: [],
            fetchedAt: "2026-10-24T00:00:00.000Z",
          }),
        readCandidate: () => Effect.fail(new FactoryFeedError({ reason: "missing-candidate" })),
        refreshSource: () => Effect.die("MCP cannot fetch intake"),
        admitCandidate: () => Effect.die("Passive review cannot admit work"),
      }),
    );
    const toolkit = yield* FactoryToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const listed = yield* toolkit
      .handle("factory_list_feed_candidates", { projectId: ProjectId.make("project") })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepInclude(listed.at(-1)?.result, { candidates: [] });
    const read = yield* toolkit
      .handle("factory_read_feed_candidate", {
        projectId: ProjectId.make("project"),
        sourceId: FactoryFeedSourceId.make("feed"),
        itemKey: "atom:item",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepInclude(read.at(-1)?.result, {
      code: "invalid_request",
      message: new FactoryFeedError({ reason: "missing-candidate" }).message,
    });
  }),
);

it.effect(
  "feed admission carries MCP attribution and the caller's mode ceiling to the service",
  () =>
    Effect.gen(function* () {
      let called = false;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "feed-admit",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "approval-required" },
          capabilities: new Set<Context.McpCapability>(["orchestration", "worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Feeds.FactoryFeedService)({
          admitCandidate: (input) =>
            Effect.gen(function* () {
              called = true;
              assert.equal(input.creationSource, "mcp");
              assert.equal(input.runtimeMode, "approval-required");
              assert.isDefined(yield* DispatchModeLimit);
              return yield* new FactoryFeedError({ reason: "launch-authority" });
            }),
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_admit_feed_candidate", {
          commandId: CommandId.make("admit"),
          projectId: ProjectId.make("project"),
          sourceId: FactoryFeedSourceId.make("feed"),
          itemKey: "atom:item",
          expectedRepositoryKey: "github.com/owner/repo",
          expectedRevision: "reviewed",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          creationSource: "web",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(outputs.at(-1)?.result, { code: "runtime_mode_escalation_denied" });
      assert.isTrue(called);
    }),
);

it.effect.each([true, false])(
  "read-only frontier requires orchestration capability: %s",
  (allowed) =>
    Effect.gen(function* () {
      let called = false;
      const result = {
        repository: {
          provider: SourceControlProviderKind.make("github"),
          host: "github.com",
          repository: "owner/repo",
          canonicalKey: "github.com/owner/repo",
          url: "https://github.com/owner/repo",
        },
        parentIssueNumber: 2,
        parentTitle: "Factory map",
        complete: false,
        summaryTotal: 2,
        children: [],
        observedAt: "2026-10-25T00:00:00.000Z",
      };
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "frontier-test",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "read-only" },
          capabilities: new Set<Context.McpCapability>(allowed ? ["orchestration"] : ["worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Relations.FactoryIssueRelations)({
          readFrontier: () =>
            Effect.sync(() => {
              called = true;
              return result;
            }),
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_read_issue_frontier", {
          projectId: ProjectId.make("project"),
          parentIssueNumber: 2,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      if (allowed) assert.deepEqual(outputs.at(-1)?.result, result);
      else assert.deepInclude(outputs.at(-1)?.result, { code: "capability_denied" });
      assert.equal(called, allowed);
      assert.notInclude(Object.keys(FactoryToolkit.tools), "factory_set_issue_readiness_override");
      assert.notInclude(
        Object.keys(FactoryToolkit.tools),
        "factory_revoke_issue_readiness_override",
      );
    }),
);

it.effect(
  "research MCP refuses verify, propagates explore caller and mode ceiling, and records only caller evidence",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("research-caller");
      const calls: string[] = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "research",
          issuedAt: 0,
          thread: {
            threadId,
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set<Context.McpCapability>(["orchestration", "worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(Research.FactoryResearchService)({
          listProtocols: () =>
            Effect.sync(() => {
              calls.push("list");
            }).pipe(
              Effect.andThen(Effect.fail(new FactoryResearchError({ reason: "missing-protocol" }))),
            ),
          readProtocol: () =>
            Effect.sync(() => {
              calls.push("read");
            }).pipe(
              Effect.andThen(Effect.fail(new FactoryResearchError({ reason: "missing-protocol" }))),
            ),
          launchRun: (input) =>
            Effect.gen(function* () {
              calls.push("explore");
              assert.equal(input.role, "explore");
              assert.equal(input.creationSource, "mcp");
              assert.equal(input.launchedByThreadId, threadId);
              assert.isDefined(yield* DispatchModeLimit);
              return yield* new FactoryResearchError({ reason: "budget-exhausted" });
            }),
          recordEvidence: (input, caller) =>
            Effect.sync(() => {
              calls.push("evidence");
              assert.equal(caller, threadId);
              assert.equal(input.threadId, ThreadId.make("other"));
            }).pipe(
              Effect.andThen(Effect.fail(new FactoryResearchError({ reason: "not-run-thread" }))),
            ),
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const input = {
        commandId: CommandId.make("research"),
        projectId: ProjectId.make("project"),
        protocolId: FactoryResearchProtocolId.make("protocol"),
        expectedRepositoryKey: "github.com/owner/repo",
        expectedProtocolRevision: "revision",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
      };
      const verify = yield* toolkit
        .handle("factory_launch_research_run", { ...input, role: "verify" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(verify.at(-1)?.result, {
        code: "invalid_request",
        message: new FactoryResearchError({ reason: "verify-requires-user" }).message,
      });
      assert.isEmpty(calls);
      yield* toolkit
        .handle("factory_launch_research_run", { ...input, role: "explore", creationSource: "web" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      yield* toolkit
        .handle("factory_list_research_protocols", { projectId: input.projectId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      yield* toolkit
        .handle("factory_read_research_protocol", {
          projectId: input.projectId,
          protocolId: input.protocolId,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const evidence = yield* toolkit
        .handle("factory_record_research_evidence", {
          projectId: input.projectId,
          threadId: ThreadId.make("other"),
          commit: "C1",
          citations: [{ path: "run.log", line: 2 }],
          missing: [],
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(evidence.at(-1)?.result, {
        code: "invalid_request",
        message: new FactoryResearchError({ reason: "not-run-thread" }).message,
      });
      assert.deepEqual(calls, ["explore", "list", "read", "evidence"]);
      assert.notInclude(Object.keys(FactoryToolkit.tools), "factory_seal_research_protocol");
      assert.notInclude(Object.keys(FactoryToolkit.tools), "factory_admit_research_implementation");
    }),
);

it.effect("research explore launch refuses a client outside a thread before the service", () =>
  Effect.gen(function* () {
    let called = false;
    const dependencies = Layer.mergeAll(
      Layer.succeed(Context.McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "research-threadless",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "test", label: "test", access: "full-access" },
        capabilities: new Set<Context.McpCapability>(["orchestration", "worktree"]),
      }),
      Layer.mock(Threads.ThreadManagementService)({}),
      Layer.mock(Research.FactoryResearchService)({
        launchRun: () => {
          called = true;
          return Effect.die("A threadless client launched research without a recorded launcher");
        },
      }),
    );
    const toolkit = yield* FactoryToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const outputs = yield* toolkit
      .handle("factory_launch_research_run", {
        commandId: CommandId.make("research-threadless"),
        projectId: ProjectId.make("project"),
        protocolId: FactoryResearchProtocolId.make("protocol"),
        expectedRepositoryKey: "github.com/owner/repo",
        expectedProtocolRevision: "revision",
        role: "explore",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
        runtimeMode: "approval-required",
        interactionMode: "default",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    assert.deepInclude(outputs.at(-1)?.result, { code: "thread_credential_required" });
    assert.isFalse(called);
  }),
);

it.effect.each([true, false])(
  "read-only claim listing requires orchestration capability: %s",
  (allowed) =>
    Effect.gen(function* () {
      let called = false;
      let refused = false;
      const result = {
        environmentId: EnvironmentId.make("claim-owner"),
        repository: {
          provider: SourceControlProviderKind.make("github"),
          host: "github.com",
          repository: "owner/repo",
          canonicalKey: "github.com/owner/repo",
          url: "https://github.com/owner/repo",
        },
        claims: [],
        fetchedAt: "2026-10-25T00:00:00.000Z",
      };
      const input = { projectId: ProjectId.make("project") };
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "claims-test",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "read-only" },
          capabilities: new Set<Context.McpCapability>(allowed ? ["orchestration"] : ["worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.succeed(Claims.FactoryClaimsService, {
          list: (received) => {
            called = true;
            assert.deepEqual(received, input);
            return refused
              ? Effect.fail(new FactoryIssueError({ reason: "missing-repository" }))
              : Effect.succeed(result);
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const outputs = yield* toolkit
        .handle("factory_list_claims", input)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.equal(called, allowed);
      if (allowed) {
        assert.deepEqual(outputs.at(-1)?.result, result);
        refused = true;
        const failure = yield* toolkit
          .handle("factory_list_claims", input)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        assert.deepInclude(failure.at(-1)?.result, { code: "invalid_request" });
      } else assert.deepInclude(outputs.at(-1)?.result, { code: "capability_denied" });
    }),
);

it.effect(
  "artifact delivery is proposed and read for a read-only client, and no tool can grant it",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const projectId = ProjectId.make("project");
      const threadId = ThreadId.make("brief-thread");
      const repository = {
        provider: SourceControlProviderKind.make("github"),
        host: "github.com",
        repository: "owner/repo",
        canonicalKey: "github.com/owner/repo",
        url: "https://github.com/owner/repo",
      };
      const body = "# Findings\n<!-- t3-factory-delivery acceptance=acceptance sha256=abc -->";
      const core = {
        threadId,
        projectId,
        acceptanceId: "acceptance",
        payloadDigest: "digest",
        grantedBy: EnvironmentId.make("person"),
        grantedAt: "2026-10-28T00:00:00.000Z",
        failure: null,
        updatedAt: "2026-10-28T00:00:01.000Z",
      };
      const artifactIntent = {
        ...core,
        id: "artifact-intent",
        originKey: FactoryOriginKey.make("knowledge:brief"),
        kind: "publish-artifact" as const,
        requestCommandId: "grant-artifact",
        status: "confirmed" as const,
        briefId: "brief",
        artifactPath: "deliverable.md",
        artifactSha256: "abc",
        artifactBytes: 10,
        repository,
        destinationKey: "comment:github:github.com/owner/repo#7",
        payload: { issueNumber: 7 },
        body,
        remote: { commentId: 6489487402, url: "https://github.com/owner/repo/issues/7#c" },
      };
      const commitIntent = {
        ...core,
        id: "commit-intent",
        originKey: FactoryOriginKey.make("github:github.com/owner/repo#3"),
        kind: "publish-pr" as const,
        requestCommandId: "grant-pr",
        status: "unknown" as const,
        repository,
        baseRef: "launch-snapshot",
        baseBranch: "main",
        baseSha: "base",
        headSha: "head",
        payload: { title: "Fix", body: "", draft: false },
        remote: null,
      };
      const prepared = {
        acceptance: {
          id: "acceptance",
          originKey: FactoryOriginKey.make("knowledge:brief"),
          briefId: "brief",
          threadId,
          projectId,
          artifactPath: "deliverable.md",
          sha256: "abc",
          bytes: 10,
          acceptedAt: "2026-10-27T00:00:00.000Z",
          acceptedBy: EnvironmentId.make("person"),
        },
        current: true,
        repository,
        destination: {
          number: 7,
          title: "Research question",
          state: "open" as const,
          url: "https://github.com/owner/repo/issues/7",
        },
        destinationKey: artifactIntent.destinationKey,
        attempt: "11111111-1111-4111-8111-111111111111",
        artifactSha256: "abc",
        artifactBytes: 10,
        body,
        payload: artifactIntent.payload,
        payloadDigest: "digest",
        existing: null,
      };
      const prepareInput = {
        projectId,
        threadId,
        kind: "publish-artifact" as const,
        payload: artifactIntent.payload,
      };
      let refusal: FactoryDeliveryError | null = null;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "delivery-test",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "read-only" },
          capabilities: new Set<Context.McpCapability>(["orchestration"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        // `grant` and `reconcile` are left unimplemented: reaching either from MCP dies the test.
        Layer.mock(Delivery.FactoryDeliveryService)({
          prepare: (received) => {
            calls.push("prepare");
            assert.deepEqual(received, prepareInput);
            return refusal === null ? Effect.succeed(prepared) : Effect.fail(refusal);
          },
          read: (received) => {
            calls.push("read");
            assert.deepEqual(received, { projectId, threadId });
            return Effect.succeed({ intents: [artifactIntent, commitIntent] });
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const proposed = yield* toolkit
        .handle("factory_prepare_delivery", prepareInput)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepEqual(proposed.at(-1)?.result, prepared);
      const read = yield* toolkit
        .handle("factory_read_deliveries", { projectId, threadId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepEqual(read.at(-1)?.result, { intents: [artifactIntent, commitIntent] });
      refusal = new FactoryDeliveryError({ reason: "destination-not-found" });
      const refused = yield* toolkit
        .handle("factory_prepare_delivery", prepareInput)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(refused.at(-1)?.result, {
        code: "invalid_request",
        message: refusal.message,
      });
      assert.deepEqual(calls, ["prepare", "read", "prepare"]);
      assert.deepEqual(
        Object.keys(FactoryToolkit.tools).filter((name) => /grant|reconcile/.test(name)),
        [],
      );
    }),
);

it.effect(
  "refuses Work listing and prerequisite reads without orchestration capability before fetching",
  () =>
    Effect.gen(function* () {
      let called = false;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "work-denied",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "full-access" },
          capabilities: new Set<Context.McpCapability>(["worktree"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(Work.FactoryWorkService)({
          list: () => {
            called = true;
            return Effect.die("An unauthorized Work listing reached the projection");
          },
          readPrerequisites: () => {
            called = true;
            return Effect.die("An unauthorized prerequisite read reached the projection");
          },
        }),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const listed = yield* toolkit
        .handle("factory_list_work", { projectIds: [ProjectId.make("project")] })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(listed.at(-1)?.result, { code: "capability_denied" });
      assert.isFalse(called);
      const prerequisites = yield* toolkit
        .handle("factory_read_work_prerequisites", {
          ref: {
            version: 1,
            environmentId: EnvironmentId.make("test"),
            kind: "issue",
            id: "issue-root",
          },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(prerequisites.at(-1)?.result, { code: "capability_denied" });
      assert.isFalse(called);
    }),
);

it.effect(
  "a read-only caller pages retained Work of every kind and follows a listed issue ref to a distinct retained blocker",
  () => {
    const observedAt = "2026-11-01T00:00:00.000Z";
    const answeringEnvironment = EnvironmentId.make("work-owner");
    const workProject = ProjectId.make("work-project");
    const blockerProject = ProjectId.make("blocker-project");
    const blocker = (
      targetRepository: string,
      targetNumber: number,
      fields: Partial<FactoryReadinessEdge> = {},
    ): FactoryReadinessEdge => ({
      targetId: targetNumber,
      targetHost: "github.com",
      targetRepository,
      targetNumber,
      targetUrl: `https://github.com/${targetRepository}/issues/${targetNumber}`,
      title: `Blocker ${targetNumber}`,
      state: "open",
      stateReason: null,
      closedAt: null,
      resolution: "open",
      status: "present",
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      fingerprint: `edge-${targetRepository}-${targetNumber}`,
      override: null,
      ...fields,
    });
    const observed = (edges: readonly FactoryReadinessEdge[]): FactoryIssueReadinessReadResult => ({
      repository: {
        provider: SourceControlProviderKind.make("github"),
        host: "github.com",
        repository: "test/repo",
        canonicalKey: "github.com/test/repo",
        url: "https://github.com/test/repo",
      },
      issueNumber: 1,
      readiness: {
        status: "blocked",
        reasons: ["open-blocker"],
        basis: null,
        edges,
        overrides: [],
        complete: true,
        listedCount: edges.length,
        summaryTotal: edges.length,
        observedAt,
      },
    });
    const calls: unknown[] = [];
    let threadReads = 0;
    const launch = (
      threadId: string,
      canonicalKey: string,
      issueNumber: number,
      options: { readonly projectId: ProjectId; readonly previous?: string },
    ) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO factory_issue_launches (thread_id, canonical_key, issue_number, request_command_id, intent_json, origin_key, superseded, accepted)
          VALUES (${threadId}, ${canonicalKey}, ${issueNumber}, ${threadId}, ${JSON.stringify({
            projectId: options.projectId,
            createdAt: observedAt,
            previousThreadId: options.previous ?? null,
            issue: {
              number: issueNumber,
              title: `Issue ${issueNumber}`,
              body: "",
              state: "open",
              url: `https://${canonicalKey}/issues/${issueNumber}`,
            },
          })}, ${`github:${canonicalKey}#${issueNumber}`}, ${options.previous === undefined ? 1 : 0}, 1)`;
      });
    // Retained roots of every kind plus a distinct retained blocker; the projection answers, not mocks.
    const seed = Effect.gen(function* () {
      yield* launch("issue-root", "github.com/test/repo", 1, { projectId: workProject });
      yield* launch("issue-live", "github.com/test/repo", 1, {
        projectId: workProject,
        previous: "issue-root",
      });
      yield* launch("blocker-root", "github.com/acme/blocker", 77, { projectId: blockerProject });
      yield* launch("blocker-live", "github.com/acme/blocker", 77, {
        projectId: blockerProject,
        previous: "blocker-root",
      });
      yield* launch("orphan-live", "github.com/acme/orphan", 8, {
        projectId: blockerProject,
        previous: "gone",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO factory_feed_launches (thread_id, source_id, item_key, request_command_id, intent_json, origin_key, origin_conflict)
        VALUES ('feed-one', 'feed-source', 'item', 'feed-one', ${JSON.stringify({
          projectId: workProject,
          createdAt: observedAt,
          previousThreadId: null,
          title: "Feed candidate",
          revision: "admitted-feed-revision",
          snapshot: { content: "Frozen feed content", link: "https://example.com/item" },
        })}, 'feed:feed-source', 0)`;
      yield* sql`INSERT INTO factory_knowledge_briefs (id, project_id, revision, brief_json, request_command_id, created_at, created_by)
        VALUES ('brief-one', ${workProject}, 'brief-revision', ${JSON.stringify({
          title: "Brief question",
          question: "How does paging behave?",
        })}, 'brief-one', ${observedAt}, 'author')`;
      yield* sql`INSERT INTO factory_research_protocols (protocol_id, canonical_key, project_id, request_command_id, protocol_json, revision, sealed_at)
        VALUES ('protocol-one', 'github.com/test/repo', ${workProject}, 'protocol-one', ${JSON.stringify(
          {
            hypothesis: "Improve the metric",
            repository: { url: "https://github.com/test/repo" },
          },
        )}, 'sealed-revision', ${observedAt})`;
    });
    return Effect.gen(function* () {
      const database = yield* Sqlite.layerMemory.pipe(Layer.build);
      yield* seed.pipe(Effect.provideContext(database), Effect.orDie);
      const dependencies = Layer.mergeAll(
        Layer.succeed(Context.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "work-discovery",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "test", label: "test", access: "read-only" },
          capabilities: new Set<Context.McpCapability>(["orchestration"]),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => {
            threadReads += 1;
            return Effect.die("Read-only Work discovery cannot start or inspect threads");
          },
        }),
        // Every ref the pages return is qualified by the answering environment, not the request.
        Work.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeedContext(database),
              Layer.succeed(ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(answeringEnvironment),
              }),
              Layer.mock(Relations.FactoryIssueRelations)({
                readAdmitted: (input) =>
                  Effect.sync(() => {
                    calls.push(input);
                    return observed([
                      blocker("acme/blocker", 77),
                      blocker("acme/orphan", 8),
                      blocker("acme/unadmitted", 4),
                      blocker("acme/stale", 9, { resolution: "unverified" }),
                    ]);
                  }),
              }),
            ),
          ),
        ),
      );
      const toolkit = yield* FactoryToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const firstOutputs = yield* toolkit
        .handle("factory_list_work", { projectIds: [workProject], limit: 2 })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const first = firstOutputs.at(-1)!.result as Tool.Success<
        (typeof FactoryToolkit.tools)["factory_list_work"]
      >;
      assert.equal(first.environmentId, answeringEnvironment);
      assert.deepEqual(
        first.items.map((item) => [
          item.ref.kind,
          item.ref.id,
          item.ref.environmentId,
          item.projectId,
        ]),
        [
          ["brief", "brief-one", answeringEnvironment, workProject],
          ["feed", "feed-one", answeringEnvironment, workProject],
        ],
      );
      assert.isNotNull(first.nextCursor);
      // A cursor is bound to its scope; another project's page cannot continue it.
      const refused = yield* toolkit
        .handle("factory_list_work", {
          projectIds: [ProjectId.make("another-project")],
          cursor: first.nextCursor ?? "",
          limit: 2,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(refused.at(-1)?.result, {
        code: "invalid_request",
        message: new FactoryWorkError({ reason: "invalid-cursor" }).message,
      });
      const secondOutputs = yield* toolkit
        .handle("factory_list_work", {
          projectIds: [workProject],
          cursor: first.nextCursor ?? "",
          limit: 2,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const second = secondOutputs.at(-1)!.result as Tool.Success<
        (typeof FactoryToolkit.tools)["factory_list_work"]
      >;
      assert.deepEqual(
        second.items.map((item) => [item.ref.kind, item.ref.id]),
        [
          ["issue", "issue-root"],
          ["protocol", "protocol-one"],
        ],
      );
      assert.isNull(second.nextCursor);
      const listedIssue = second.items.find((item) => item.ref.kind === "issue")?.ref;
      assert.isDefined(listedIssue);
      const prerequisiteOutputs = yield* toolkit
        .handle("factory_read_work_prerequisites", { ref: listedIssue! })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const prerequisites = prerequisiteOutputs.at(-1)!.result as Tool.Success<
        (typeof FactoryToolkit.tools)["factory_read_work_prerequisites"]
      >;
      assert.equal(prerequisites.status, "observed");
      if (prerequisites.status !== "observed") return;
      assert.deepEqual(calls, [
        { projectId: workProject, issueNumber: 1, canonicalKey: "github.com/test/repo" },
      ]);
      assert.equal(prerequisites.reviewProjectId, workProject);
      assert.deepEqual(
        prerequisites.prerequisites.map(({ edge, link }) => [edge.targetNumber, link]),
        [
          [
            77,
            {
              kind: "retained",
              ref: {
                version: 1,
                environmentId: answeringEnvironment,
                kind: "issue",
                id: "blocker-root",
              },
              projectId: blockerProject,
            },
          ],
          [8, { kind: "unresolved", reason: "missing-ancestry" }],
          [4, { kind: "none" }],
          [9, { kind: "not-current" }],
        ],
      );
      assert.equal(prerequisites.omittedCount, 0);
      // A foreign environment's ref is refused, never answered from this database.
      const foreign = yield* toolkit
        .handle("factory_read_work_prerequisites", {
          ref: { ...listedIssue!, environmentId: EnvironmentId.make("copied-database") },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepInclude(foreign.at(-1)?.result, {
        code: "invalid_request",
        message: new FactoryWorkError({ reason: "wrong-environment" }).message,
      });
      const outbox = yield* SqlClient.SqlClient.pipe(
        Effect.flatMap(
          (sql) =>
            sql<{
              readonly count: number;
            }>`SELECT count(*) AS count FROM orchestration_v2_effect_outbox`,
        ),
        Effect.provideContext(database),
      );
      assert.equal(outbox[0]?.count, 0);
      assert.equal(threadReads, 0);
    });
  },
);
