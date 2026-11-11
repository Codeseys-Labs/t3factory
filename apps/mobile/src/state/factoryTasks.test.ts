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

it("reads every activity cursor before showing the latest six and follows later-page updates", () => {
  const registry = setup();
  const ref = fixtures.tasks[0]!.ref;
  const entries = Array.from({ length: 107 }, (_, index) => ({
    id: String(index),
    at: fixtures.at,
    actor: { kind: "person" as const, label: "You" },
    event: { type: "comment" as const, body: `Comment ${index}` },
  }));
  const pages = [0, 50, 100].map((start, index) =>
    Atom.make<AsyncResult.AsyncResult<FactoryTaskActivityResult, Error>>(
      AsyncResult.success({
        entries: entries.slice(start, start + 50),
        nextCursor: index === 2 ? null : String(start + 50),
        fetchedAt: fixtures.at,
      }),
    ),
  );
  mocks.activity.mockImplementation(
    ({ input }: { input: { cursor?: string } }) =>
      pages[input.cursor ? Number(input.cursor) / 50 : 0],
  );
  function Probe() {
    const result = useFactoryTaskActivity(ref);
    const entries = AsyncResult.getOrElse(result, () => ({ entries: [] })).entries;
    return createElement(
      "output",
      { "data-status": result._tag },
      entries
        .slice(-6)
        .map((entry) => entry.id)
        .join(","),
    );
  }
  const read = () => renderToString(createElement(Probe));
  expect(read()).toBe('<output data-status="Success">101,102,103,104,105,106</output>');
  registry.set(pages[1]!, AsyncResult.waiting(registry.get(pages[1]!)));
  registry.set(
    pages[2]!,
    AsyncResult.success({
      entries: [...entries.slice(100), { ...entries[106]!, id: "107" }],
      nextCursor: null,
      fetchedAt: fixtures.at,
    }),
  );
  expect(read()).toBe('<output data-status="Success">102,103,104,105,106,107</output>');
  registry.set(pages[1]!, AsyncResult.initial(false));
  expect(read()).toBe('<output data-status="Initial"></output>');
  registry.set(pages[1]!, AsyncResult.failure(Cause.fail(new Error("No access"))));
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
              ? "disconnected"
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
