import { FACTORY_INTAKE_FIXTURES } from "@t3tools/client-runtime/state/factory-intake-fixtures";
import {
  EnvironmentId,
  FactoryIntakeError,
  type FactoryIntakeArrival,
  type FactoryIntakeRule,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { useInboxData } from "./inboxData";

const state = vi.hoisted(() => ({
  environments: [] as string[],
  projectIds: undefined as string[] | undefined,
  pages: {} as Record<
    string,
    { items: readonly FactoryIntakeArrival[]; waiting: number; nextCursor: string | null }
  >,
  rules: [] as FactoryIntakeRule[],
  failures: {} as Record<string, unknown>,
  phase: "connected",
  ownerStatus: "current",
  refreshTasks: null as unknown as ReturnType<typeof vi.fn>,
  taskQueries: null as unknown as ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>,
  arrivalQueries: null as unknown as ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>,
}));
vi.mock(import("../shared"), () => ({
  taskErrorMessage: () => "The source is unreachable. Try again later.",
}));
vi.mock(import("../shared/taskScope"), () => ({
  useTaskScope: (() => ({
    targets: state.environments.map((environmentId) => ({
      environmentId,
      input: state.projectIds ? { projectIds: state.projectIds } : {},
    })),
    projects: [],
    single: null,
    label: "All projects",
  })) as never,
  useNeedsYou: (() => ({
    tasks: [],
    needs: { rows: [], blocking: [], review: [], count: 0 },
    incomplete: false,
    list: {
      owners: state.environments.map((environmentId) => ({
        environmentId,
        status: state.ownerStatus,
      })),
      refresh: state.refreshTasks,
    },
  })) as never,
}));
vi.mock(import("../../../state/presentation"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      presentationAtom: (id: string) =>
        Atom.make({
          entry: { target: { label: id } },
          connection: { phase: state.phase },
          serverConfig: {},
        }),
    },
  } as never;
});
vi.mock(import("../../../state/session"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    environmentSession: { sessionStateAtom: () => Atom.make(AsyncResult.success({})) },
    sessionHasScope: () => true,
  } as never;
});
vi.mock(import("../../../state/factoryTasks"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    factoryTasks: {
      listTasks: (target: unknown) => {
        state.taskQueries(target);
        return Atom.make(AsyncResult.success({ items: [], nextCursor: null }));
      },
    },
    factoryIntake: {
      listIntakeArrivals: (target: {
        environmentId: string;
        input: { cursor?: string; states?: string[] };
      }) => {
        state.arrivalQueries(target);
        const failure = state.failures[target.environmentId];
        return Atom.make(
          failure ??
            AsyncResult.success(
              state.pages[
                `${target.environmentId}:${target.input.cursor ?? (target.input.states ? "snoozed" : "")}`
              ],
            ),
        );
      },
      listIntakeRules: () => Atom.make(AsyncResult.success({ rules: state.rules })),
      listIntakeSources: () =>
        Atom.make(AsyncResult.success({ sources: [FACTORY_INTAKE_FIXTURES.sources[0]] })),
    },
  } as never;
});

function setup() {
  state.environments = ["local", "remote"];
  state.projectIds = undefined;
  state.rules = [...FACTORY_INTAKE_FIXTURES.rules];
  state.failures = {};
  state.phase = "connected";
  state.ownerStatus = "current";
  state.refreshTasks = vi.fn();
  state.taskQueries = vi.fn();
  state.arrivalQueries = vi.fn();
  state.pages = {
    "local:": {
      items: [{ ...FACTORY_INTAKE_FIXTURES.arrivals[0]!, arrivedAt: "2026-11-09T17:00:00.000Z" }],
      waiting: 2,
      nextCursor: "older",
    },
    "local:older": {
      items: [{ ...FACTORY_INTAKE_FIXTURES.arrivals[2]!, arrivedAt: "2026-11-08T17:00:00.000Z" }],
      waiting: 2,
      nextCursor: null,
    },
    "remote:": {
      items: [{ ...FACTORY_INTAKE_FIXTURES.arrivals[1]!, arrivedAt: "2026-11-10T17:00:00.000Z" }],
      waiting: 1,
      nextCursor: null,
    },
  };
}

function Probe() {
  const [snoozed, setSnoozed] = useState(false);
  const data = useInboxData(snoozed);
  return (
    <div>
      <output aria-label="Arrivals">
        {data.arrivals.map((entry) => `${entry.environmentId}/${entry.arrival.id}`).join(",")}
      </output>
      <output aria-label="Waiting">{data.waiting}</output>
      <output aria-label="Rules">{data.rules.map((rule) => rule.id).join(",")}</output>
      <output aria-label="Machines">
        {data.machines.map((machine) => `${machine.environmentId}:${machine.state}`).join(",")}
      </output>
      <button type="button" onClick={() => data.loadMore(EnvironmentId.make("local"))}>
        Load local
      </button>
      <button type="button" onClick={data.reload}>
        Reload
      </button>
      <button type="button" onClick={() => setSnoozed(!snoozed)}>
        Snoozed
      </button>
    </div>
  );
}

it("combines scoped machines newest first, keeps the full count, and follows a machine's cursor", async () => {
  setup();
  await using screen = await render(<Probe />);
  await expect
    .element(screen.getByRole("status", { name: "Arrivals" }))
    .toHaveTextContent("remote/vite-9,local/github-101");
  await expect.element(screen.getByRole("status", { name: "Waiting" })).toHaveTextContent("3");
  await userEvent.click(screen.getByRole("button", { name: "Load local" }));
  await expect
    .element(screen.getByRole("status", { name: "Arrivals" }))
    .toHaveTextContent("remote/vite-9,local/github-101,local/github-102");
  expect(state.arrivalQueries).toHaveBeenCalledWith({
    environmentId: "local",
    input: { cursor: "older" },
  });
  expect(state.taskQueries).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(state.refreshTasks).toHaveBeenCalledOnce();
  expect(state.taskQueries).not.toHaveBeenCalled();
});

it("uses project filters and only counts rules from those projects' sources", async () => {
  setup();
  state.environments = ["local"];
  state.projectIds = ["t3code-factory"];
  await using screen = await render(<Probe />);
  await expect
    .element(screen.getByRole("status", { name: "Rules" }))
    .toHaveTextContent("bugs,docs");
  expect(state.arrivalQueries).toHaveBeenCalledWith({
    environmentId: "local",
    input: { projectIds: ["t3code-factory"] },
  });
  expect(state.taskQueries).not.toHaveBeenCalled();
});

it("loads persisted snoozes with the project scope and keeps their cursors separate", async () => {
  setup();
  state.environments = ["local"];
  state.projectIds = ["t3code-factory"];
  state.pages["local:snoozed"] = {
    items: [{ ...FACTORY_INTAKE_FIXTURES.arrivals[1]!, state: "snoozed" }],
    waiting: 2,
    nextCursor: null,
  };
  await using screen = await render(<Probe />);
  await userEvent.click(screen.getByRole("button", { name: "Load local" }));
  await expect
    .element(screen.getByRole("status", { name: "Arrivals" }))
    .toHaveTextContent("local/github-101,local/github-102");
  state.arrivalQueries.mockClear();
  await userEvent.click(screen.getByRole("button", { name: "Snoozed" }));
  await expect
    .element(screen.getByRole("status", { name: "Arrivals" }))
    .toHaveTextContent("local/vite-9");
  expect(state.arrivalQueries).toHaveBeenCalledWith({
    environmentId: "local",
    input: { projectIds: ["t3code-factory"], states: ["snoozed"] },
  });
  expect(
    state.arrivalQueries.mock.calls.every(
      ([target]) => !(target as { input: { cursor?: string } }).input.cursor,
    ),
  ).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Reload" }));
  await expect.element(screen.getByRole("status", { name: "Waiting" })).toHaveTextContent("2");
});

it.each(["loading", "failed", "forbidden", "unsupported", "offline"])(
  "uses the shared attention owner's %s state",
  async (status) => {
    setup();
    state.environments = ["local"];
    state.ownerStatus = status;
    await using screen = await render(<Probe />);
    await expect
      .element(screen.getByRole("status", { name: "Machines" }))
      .toHaveTextContent(`local:${status}`);
    expect(state.taskQueries).not.toHaveBeenCalled();
  },
);

it.each([
  { reason: "forbidden", expected: "forbidden" },
  { reason: "source-unavailable", expected: "failed" },
] as const)(
  "preserves healthy machines when another returns $reason",
  async ({ reason, expected }) => {
    setup();
    state.failures.remote = AsyncResult.failure(Cause.fail(new FactoryIntakeError({ reason })));
    await using screen = await render(<Probe />);
    await expect
      .element(screen.getByRole("status", { name: "Arrivals" }))
      .toHaveTextContent("local/github-101");
    await expect
      .element(screen.getByRole("status", { name: "Machines" }))
      .toHaveTextContent(`local:current,remote:${expected}`);
  },
);

it.each([
  ["connecting", "loading"],
  ["reconnecting", "loading"],
  ["offline", "offline"],
  ["error", "failed"],
  ["unsupported", "unsupported"],
])("maps a %s connection to %s without reading an unavailable machine", async (phase, expected) => {
  setup();
  state.environments = ["local"];
  state.phase = phase!;
  await using screen = await render(<Probe />);
  await expect
    .element(screen.getByRole("status", { name: "Machines" }))
    .toHaveTextContent(`local:${expected}`);
  expect(state.arrivalQueries).not.toHaveBeenCalled();
});
