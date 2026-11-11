import { FACTORY_TASK_FIXTURES as fixtures } from "@t3tools/client-runtime/state/factory-task-fixtures";
import {
  EnvironmentId,
  sessionGrantsScope,
  type AuthSessionState,
  type FactoryTaskActivityResult,
  type FactoryTaskDetail,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  activity: vi.fn(),
  detail: vi.fn(),
  presentation: vi.fn(),
  session: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: mocks.read, useAtomRefresh: () => vi.fn() }));
vi.mock("./factory", () => ({
  factoryTaskEnvironment: { readTaskActivity: mocks.activity, readTask: mocks.detail },
}));
vi.mock("./presentation", () => ({
  environmentPresentations: { presentationAtom: mocks.presentation },
}));
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: mocks.session },
  sessionHasScope: (
    result: AsyncResult.AsyncResult<AuthSessionState>,
    scope: Parameters<typeof sessionGrantsScope>[1],
  ) => result._tag === "Success" && sessionGrantsScope(result.value, scope),
}));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    get catalogValueAtom() {
      return mocks.catalog();
    },
  },
}));
vi.mock("./server", () => ({ serverEnvironment: {} }));
vi.mock("./threads", () => ({
  environmentThreadDetails: {},
  environmentThreadShells: {},
  threadEnvironment: {},
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: vi.fn() }));

const { useFactoryTaskActivity, useFactoryTaskDetailByDisplayId } = await import("./factoryTasks");

function setup() {
  const registry = AtomRegistry.make();
  onTestFinished(() => registry.dispose());
  mocks.catalog.mockReturnValue(Atom.make({ isReady: false }));
  mocks.read.mockImplementation((atom: Atom.Atom<unknown>) => {
    registry.mount(atom);
    return registry.get(atom);
  });
  mocks.activity.mockReset();
  mocks.detail.mockReset();
  mocks.presentation.mockReset();
  mocks.session.mockReset();
  return registry;
}

it("reads only the newest six activity entries and displays them chronologically", () => {
  const registry = setup();
  const ref = fixtures.tasks[0]!.ref;
  const entries = Array.from({ length: 6 }, (_, index) => ({
    id: String(106 - index),
    at: fixtures.at,
    actor: { kind: "person" as const, label: "You" },
    event: { type: "comment" as const, body: `Comment ${106 - index}` },
  }));
  const latest = Atom.make<AsyncResult.AsyncResult<FactoryTaskActivityResult, Error>>(
    AsyncResult.success({ entries, nextCursor: "older", fetchedAt: fixtures.at }),
  );
  mocks.activity.mockReturnValue(latest);
  function Probe() {
    const result = useFactoryTaskActivity(ref);
    return createElement(
      "output",
      { "data-status": result._tag },
      AsyncResult.getOrElse(result, () => ({ entries: [] }))
        .entries.map((entry) => entry.id)
        .join(","),
    );
  }
  const read = () => renderToString(createElement(Probe));
  expect(read()).toBe('<output data-status="Success">101,102,103,104,105,106</output>');
  expect(mocks.activity).toHaveBeenCalledWith({
    environmentId: ref.environmentId,
    input: { ref, order: "newest", limit: 6 },
  });
  expect(mocks.activity.mock.calls.every(([target]) => target.input.cursor === undefined)).toBe(
    true,
  );
  registry.set(
    latest,
    AsyncResult.success({
      entries: [{ ...entries[0]!, id: "107" }, ...entries.slice(0, 5)],
      nextCursor: "older",
      fetchedAt: fixtures.at,
    }),
  );
  expect(read()).toBe('<output data-status="Success">102,103,104,105,106,107</output>');
  registry.set(latest, AsyncResult.initial(false));
  expect(read()).toBe('<output data-status="Initial"></output>');
  registry.set(latest, AsyncResult.failure(Cause.fail(new Error("No access"))));
  expect(read()).toBe('<output data-status="Failure"></output>');
});

it.each(["forbidden", "offline", "unsupported", "loading", "current"] as const)(
  "resolves a task link's %s state from its owner",
  (status) => {
    setup();
    const environmentId = EnvironmentId.make("task-owner");
    mocks.presentation.mockReturnValue(
      Atom.make({
        connection: {
          phase:
            status === "offline"
              ? "offline"
              : status === "unsupported"
                ? "unsupported"
                : "connected",
        },
        serverConfig: {},
      }),
    );
    mocks.session.mockReturnValue(
      Atom.make(
        status === "loading"
          ? AsyncResult.initial()
          : AsyncResult.success({
              authenticated: true,
              scopes: status === "forbidden" ? [] : ["orchestration:read"],
            }),
      ),
    );
    mocks.detail.mockReturnValue(Atom.make(AsyncResult.initial<FactoryTaskDetail>(false)));
    function Probe() {
      const result = useFactoryTaskDetailByDisplayId(environmentId, "T-99");
      return createElement("output", null, result.status);
    }
    expect(renderToString(createElement(Probe))).toBe(
      `<output>${status === "current" ? "loading" : status}</output>`,
    );
    expect(mocks.presentation).toHaveBeenCalledWith(environmentId);
  },
);

it.each([false, true])("resolves an unknown machine after catalog ready %s", (isReady) => {
  setup();
  mocks.catalog.mockReturnValue(Atom.make({ isReady }));
  mocks.presentation.mockReturnValue(Atom.make(null));
  mocks.detail.mockReturnValue(Atom.make(AsyncResult.initial<FactoryTaskDetail>(false)));
  function Probe() {
    return createElement(
      "output",
      null,
      useFactoryTaskDetailByDisplayId(EnvironmentId.make("unknown"), "T-99").status,
    );
  }
  expect(renderToString(createElement(Probe))).toBe(
    `<output>${isReady ? "offline" : "loading"}</output>`,
  );
});
