import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  FactoryTaskError,
  type AuthSessionState,
  type FactoryTaskChange,
  type FactoryIntakeChange,
  type FactoryTaskReadInput,
  type FactoryTaskListInput,
  type FactoryTaskListResult,
  type FactoryTaskCountResult,
  type FactoryTaskAssigneePreviewInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createFactoryTaskEnvironmentAtoms } from "./factoryTasks.ts";
import { createFactoryIntakeEnvironmentAtoms } from "./factoryIntake.ts";
import {
  createFactoryTaskListAtoms,
  FACTORY_TASK_PAGE_CAP,
  factoryTaskConnectionStatus,
  type FactoryTaskOwnerStatus,
} from "./factoryTaskList.ts";
import { FACTORY_TASK_FIXTURES as fixtures } from "./factoryTaskFixtures.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.initial()),
);
const environmentId = fixtures.environmentId;
const makeHarness = Effect.fn("FactoryTasksTest.harness")(function* (
  client: Record<string, unknown>,
) {
  const session = { client } as unknown as RpcSession;
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Test",
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const service = {
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"];
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, service));
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.mount(sessions(environmentId));
  registry.set(
    sessions(environmentId),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      permissions: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    }),
  );
  return {
    registry,
    tasks: createFactoryTaskEnvironmentAtoms(runtime),
    intake: createFactoryIntakeEnvironmentAtoms(runtime),
  };
});

it.effect(
  "refreshes the changed root and lists, preserves other roots, and refreshes profiles only when flagged",
  () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<FactoryTaskChange>();
      const calls = yield* Queue.unbounded<string>();
      const seen: string[] = [];
      let recording = false;
      const record = (name: string) =>
        Effect.gen(function* () {
          seen.push(name);
          if (recording) yield* Queue.offer(calls, name);
        });
      const a = fixtures.tasks.find((task) => task.displayId === "T-38")!;
      const b = fixtures.tasks.find((task) => task.displayId === "T-41")!;
      const h = yield* makeHarness({
        [WS_METHODS.factorySubscribeTaskChanges]: () => Stream.fromQueue(changes),
        [WS_METHODS.factoryListTasks]: () =>
          record("list").pipe(
            Effect.as({ environmentId, items: [a, b], nextCursor: null, fetchedAt: fixtures.at }),
          ),
        [WS_METHODS.factoryCountTasks]: () =>
          record("count").pipe(Effect.as({ environmentId, byStatus: [], fetchedAt: fixtures.at })),
        [WS_METHODS.factoryReadTask]: (input: FactoryTaskReadInput) => {
          const task = (
            "ref" in input.task
              ? input.task.ref.rootId === a.ref.rootId
              : input.task.displayId === a.displayId
          )
            ? a
            : b;
          return record(task.displayId).pipe(
            Effect.as({
              task,
              description: "",
              ancestors: [],
              subtasks: [],
              blockedBy: [],
              blocks: [],
              runs: [],
              fetchedAt: fixtures.at,
            }),
          );
        },
        [WS_METHODS.factoryListAgentProfiles]: () =>
          record("profiles").pipe(Effect.as({ profiles: [], fetchedAt: fixtures.at })),
      });
      const queries: readonly Atom.Atom<AsyncResult.AsyncResult<unknown, Error>>[] = [
        h.tasks.listTasks({ environmentId, input: {} }),
        h.tasks.countTasks({ environmentId, input: {} }),
        h.tasks.readTask({ environmentId, input: { task: { ref: a.ref } } }),
        h.tasks.readTask({ environmentId, input: { task: { displayId: b.displayId } } }),
        h.tasks.listAgentProfiles({ environmentId, input: {} }),
      ];
      for (const query of queries) {
        h.registry.mount(query);
        yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
      }
      recording = true;
      seen.length = 0;
      yield* Queue.offer(changes, { environmentId, rootIds: [a.ref.rootId], profiles: false });
      const refreshed = yield* Effect.all([
        Queue.take(calls),
        Queue.take(calls),
        Queue.take(calls),
      ]);
      expect(refreshed.sort()).toEqual(["T-38", "count", "list"]);
      expect(seen.filter((name) => name === "T-41")).toHaveLength(0);
      expect(seen.filter((name) => name === "profiles")).toHaveLength(0);
      yield* Queue.offer(changes, { environmentId, rootIds: [], profiles: true });
      const profileRefresh = yield* Effect.all([
        Queue.take(calls),
        Queue.take(calls),
        Queue.take(calls),
        Queue.take(calls),
        Queue.take(calls),
      ]);
      expect(profileRefresh.sort()).toEqual(["T-38", "T-41", "count", "list", "profiles"]);
    }),
);

it.effect("intake change flags refresh only affected reads", () =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<FactoryIntakeChange>();
    const calls = yield* Queue.unbounded<string>();
    const seen: string[] = [];
    let recording = false;
    const record = (name: string) =>
      Effect.gen(function* () {
        seen.push(name);
        if (recording) yield* Queue.offer(calls, name);
      });
    const h = yield* makeHarness({
      [WS_METHODS.factorySubscribeIntakeChanges]: () => Stream.fromQueue(changes),
      [WS_METHODS.factoryListIntakeArrivals]: () =>
        record("arrivals").pipe(
          Effect.as({
            environmentId,
            items: [],
            nextCursor: null,
            waiting: 0,
            fetchedAt: fixtures.at,
          }),
        ),
      [WS_METHODS.factoryListIntakeSources]: () =>
        record("sources").pipe(Effect.as({ environmentId, sources: [], fetchedAt: fixtures.at })),
      [WS_METHODS.factoryListIntakeRules]: () =>
        record("rules").pipe(Effect.as({ environmentId, rules: [], fetchedAt: fixtures.at })),
    });
    const queries: readonly Atom.Atom<AsyncResult.AsyncResult<unknown, Error>>[] = [
      h.intake.listIntakeArrivals({ environmentId, input: {} }),
      h.intake.listIntakeSources({ environmentId, input: {} }),
      h.intake.listIntakeRules({ environmentId, input: {} }),
    ];
    for (const query of queries) {
      h.registry.mount(query);
      yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
    }
    recording = true;
    seen.length = 0;
    yield* Queue.offer(changes, { environmentId, arrivals: true, sources: false, rules: false });
    expect(yield* Queue.take(calls)).toBe("arrivals");
    expect(seen).toEqual(["arrivals"]);
  }),
);

it.effect("refreshes Auto previews when their parent's root changes", () =>
  Effect.gen(function* () {
    const parent = fixtures.tasks.find((task) => task.displayId === "T-38")!;
    const other = fixtures.tasks.find((task) => task.displayId === "T-41")!;
    let assignee = parent.assignee;
    const calls: string[] = [];
    const h = yield* makeHarness({
      [WS_METHODS.factorySubscribeTaskChanges]: () => Stream.never,
      [WS_METHODS.factoryPreviewTaskAssignee]: (input: FactoryTaskAssigneePreviewInput) =>
        Effect.sync(() => {
          calls.push(input.parent?.rootId ?? "profiles");
          return assignee;
        }),
    });
    const preview = (task?: typeof parent) =>
      h.tasks.previewTaskAssignee({
        environmentId,
        input: {
          projectId: parent.ref.projectId,
          type: "task",
          assignment: { mode: "auto" },
          ...(task ? { parent: task.ref } : {}),
        },
      });
    const queries = [preview(parent), preview(other), preview()];
    for (const query of queries) {
      h.registry.mount(query);
      yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
    }
    calls.length = 0;
    assignee = other.assignee;
    h.tasks.invalidate(h.registry, {
      environmentId,
      rootIds: [parent.ref.rootId],
      profiles: false,
    });
    expect(
      yield* AtomRegistry.getResult(h.registry, queries[0]!, { suspendOnWaiting: true }),
    ).toEqual(assignee);
    expect(calls).toEqual([parent.ref.rootId]);
    calls.length = 0;
    h.tasks.invalidate(h.registry, { environmentId, rootIds: [], profiles: true });
    for (const query of queries)
      yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
    expect(calls.sort()).toEqual([parent.ref.rootId, other.ref.rootId, "profiles"].sort());
  }),
);

it.effect(
  "hides retained reads and refuses task mutations after read and operate access is revoked",
  () =>
    Effect.gen(function* () {
      let writes = 0;
      const h = yield* makeHarness({
        [WS_METHODS.factorySubscribeTaskChanges]: () => Stream.never,
        [WS_METHODS.factoryListTasks]: () =>
          Effect.succeed({
            environmentId,
            items: fixtures.tasks,
            nextCursor: null,
            fetchedAt: fixtures.at,
          }),
        [WS_METHODS.factoryCreateTask]: () => {
          writes++;
          return Effect.fail(new FactoryTaskError({ reason: "invalid-input" }));
        },
      });
      const query = h.tasks.listTasks({ environmentId, input: {} });
      h.registry.mount(query);
      yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
      h.registry.set(
        sessions(environmentId),
        AsyncResult.success({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [],
          permissions: [],
        }),
      );
      expect(h.registry.get(query)._tag).toBe("Initial");
      const target = {
        environmentId,
        input: {
          commandId: CommandId.make("create"),
          projectId: fixtures.tasks[0]!.ref.projectId,
          title: "Task",
        },
      };
      const result = yield* Effect.promise(() => h.tasks.createTask.run(h.registry, target));
      expect(result._tag).toBe("Failure");
      expect(writes).toBe(0);
    }),
);

it.each([
  [undefined, "loading"],
  ["connecting", "loading"],
  ["available", "offline"],
  ["offline", "offline"],
  ["reconnecting", "offline"],
  ["error", "offline"],
  ["unsupported", "unsupported"],
  ["connected", null],
] as const)("reads a %s connection as %s for task lists", (phase, expected) => {
  expect(factoryTaskConnectionStatus(phase)).toBe(expected);
});

it("keeps separate cursor chains, caps pages and removes protected cached rows on revocation", () => {
  const registry = AtomRegistry.make();
  try {
    const second = EnvironmentId.make("second");
    const access = Atom.family((_id: EnvironmentId) =>
      Atom.make<FactoryTaskOwnerStatus>("current"),
    );
    // A live subscription: it emitted once and stays waiting until it ends.
    const changes = Atom.family((_id: EnvironmentId) =>
      Atom.make<AsyncResult.AsyncResult<unknown, Error>>(AsyncResult.success(0, { waiting: true })),
    );
    const requested: string[] = [];
    const pages = Atom.family((key: string) => {
      const [id, cursor] = JSON.parse(key) as [EnvironmentId, string | null];
      const index = cursor === null ? 0 : Number(cursor.split(":")[1]);
      requested.push(key);
      return Atom.make(
        AsyncResult.success<FactoryTaskListResult>({
          environmentId: id,
          items: [
            {
              ...fixtures.tasks[0]!,
              ref: { ...fixtures.tasks[0]!.ref, environmentId: id, taskId: `page-${index}` },
            },
          ],
          nextCursor: `${id}:${index + 1}`,
          fetchedAt: fixtures.at,
        }),
      );
    });
    const counts = Atom.family((id: EnvironmentId) =>
      Atom.make(
        AsyncResult.success<FactoryTaskCountResult>({
          environmentId: id,
          byStatus: [{ status: "backlog", count: 500 }],
          fetchedAt: fixtures.at,
        }),
      ),
    );
    const lists = createFactoryTaskListAtoms({
      accessAtom: access,
      changesAtom: (id) => changes(id),
      listTasks: ({ environmentId, input }) =>
        pages(JSON.stringify([environmentId, input.cursor ?? null])),
      countTasks: ({ environmentId }) => counts(environmentId),
    });
    const first = { environmentId, input: {} satisfies FactoryTaskListInput };
    const other = { environmentId: second, input: {} };
    const atom = lists.listAtom([first, other]);
    registry.mount(atom);
    registry.get(atom);
    for (let index = 0; index < FACTORY_TASK_PAGE_CAP + 2; index++) {
      lists.loadMore(registry, first);
      registry.get(atom);
    }
    const result = registry.get(atom);
    expect(result.items).toHaveLength(FACTORY_TASK_PAGE_CAP + 1);
    expect(result.byStatus.backlog).toBe(1000);
    expect(result.more[0]?.capped).toBe(true);
    expect(requested.filter((key) => key.includes('"second"'))).toHaveLength(1);
    expect(result.owners.map((owner) => [owner.status, owner.countsStatus])).toEqual([
      ["current", "current"],
      ["current", "current"],
    ]);
    expect(result.countsComplete).toBe(true);
    const firstPage = pages(JSON.stringify([environmentId, null]));
    const firstResult = registry.get(firstPage);
    registry.set(firstPage, AsyncResult.waiting(firstResult));
    const refreshing = registry.get(atom);
    expect(refreshing.items).toHaveLength(FACTORY_TASK_PAGE_CAP + 1);
    expect(refreshing.owners[0]?.pages).toHaveLength(FACTORY_TASK_PAGE_CAP);
    expect(refreshing.owners[0]?.status).toBe("loading");
    const laterPage = pages(JSON.stringify([environmentId, `${environmentId}:1`]));
    const laterResult = registry.get(laterPage);
    registry.set(laterPage, AsyncResult.waiting(laterResult));
    registry.set(firstPage, firstResult);
    expect(registry.get(atom).items).toHaveLength(FACTORY_TASK_PAGE_CAP + 1);
    expect(registry.get(atom).owners[0]?.status).toBe("loading");
    registry.set(laterPage, laterResult);
    expect(registry.get(atom).owners[0]?.status).toBe("current");
    registry.set(changes(environmentId), AsyncResult.initial());
    expect(registry.get(atom).owners[0]?.status).toBe("current");
    registry.set(
      changes(environmentId),
      AsyncResult.failure(Cause.fail(new Error("Stream disconnected"))),
    );
    expect(registry.get(atom).owners[0]?.status).toBe("failed");
    expect(registry.get(atom).countsComplete).toBe(false);
    registry.set(
      changes(environmentId),
      AsyncResult.failure(Cause.die("Unknown request tag: factory.subscribeTaskChanges")),
    );
    expect(registry.get(atom).owners[0]?.status).toBe("unsupported");
    expect(registry.get(atom).items).toHaveLength(1);
    registry.set(access(environmentId), "forbidden");
    expect(registry.get(atom).items).toHaveLength(1);
    registry.set(access(second), "offline");
    expect(registry.get(atom).items[0]?.stale).toBe(true);
  } finally {
    registry.dispose();
  }
});
