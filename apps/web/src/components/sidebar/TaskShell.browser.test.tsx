import { createMemoryHistory } from "@tanstack/react-router";
import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import type { FactoryTaskSummary } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { AppRoot } from "../../AppRoot";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { getRouter } from "../../router";
import { openCommandPalette } from "../../commandPaletteBus";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useTaskDialogStore } from "../tasks/taskDialogs";
import {
  installFakeEnvironment,
  threadWithHistory,
  ENVIRONMENT_ID,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  tasks: [] as readonly FactoryTaskSummary[],
  lookups: [] as string[],
}));

vi.mock("../../../../../packages/client-runtime/src/connection/driver.ts", async (original) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    original<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
vi.mock(import("../../rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));
vi.mock(import("../tasks/shared/taskCatalog"), async () => {
  const { FACTORY_TASK_FIXTURES: fixtures } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  return { useTaskCatalog: () => fixtures.catalog };
});
vi.mock(import("../../state/factoryTasks"), async (original) => {
  const actual = await original();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { groupFactoryTaskNeeds, resolveFactoryTaskLiveState } =
    await import("@t3tools/client-runtime/state/factory-task-view");
  const { FACTORY_TASK_FIXTURES: fixtures } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  const byThread = Atom.family((threadId: string) =>
    Atom.make(
      AsyncResult.success({
        task: state.tasks.find((task) => task.run?.threadId === threadId) ?? null,
      }),
    ),
  );
  return {
    ...actual,
    factoryTasks: {
      ...actual.factoryTasks,
      findTaskByThread: ((target: { input: { threadId: string } }) => {
        state.lookups.push(target.input.threadId);
        return byThread(target.input.threadId);
      }) as never,
    },
    useFactoryTasks: ((
      targets: readonly {
        environmentId: string;
        input: { text?: string; statuses?: readonly string[] };
      }[],
    ) => {
      const tasks =
        targets.length === 0
          ? []
          : state.tasks.filter((task) => {
              const input = targets.find(
                (target) => target.environmentId === task.ref.environmentId,
              )?.input;
              return (
                input &&
                (!input.statuses || input.statuses.includes(task.status)) &&
                (!input.text ||
                  `${task.displayId} ${task.title}`
                    .toLowerCase()
                    .includes(input.text.toLowerCase()))
              );
            });
      return {
        items: tasks.map((task) => ({ task, stale: false })),
        owners: [],
        more: [],
        incomplete: false,
        countsComplete: true,
        byStatus: {},
        loadMore: () => {},
        refresh: () => {},
      };
    }) as never,
    useFactoryTaskNeeds: (tasks) =>
      groupFactoryTaskNeeds(
        tasks.map((task) => resolveFactoryTaskLiveState(task, fixtures.threadFacts)),
      ),
  };
});

function setup() {
  state.lookups = [];
  state.tasks = FACTORY_TASK_FIXTURES.tasks.map((task) => ({
    ...task,
    ref: { ...task.ref, environmentId: ENVIRONMENT_ID },
  }));
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  useTaskDialogStore.getState().close();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const runTasks = ["T-41", "T-38.2", "T-39", "T-36", "T-33"].map((id) =>
    state.tasks.find((task) => task.displayId === id)!,
  );
  const threads = runTasks.map((task) => ({
    ...threadWithHistory(task.run!.threadId, 1),
    title: `${task.displayId} ${task.title}`,
  }));
  return installFakeEnvironment([...threads, threadWithHistory("plain-thread", 1)]);
}

describe("Tasks shell", () => {
  it("keeps thread navigation on task and legacy routes, creates from the palette and links a run to its task", async () => {
    using _environment = setup();
    await page.viewport(1440, 900);
    const router = getRouter(createMemoryHistory({ initialEntries: ["/tasks"] }));
    await router.load();
    // AppRoot supplies its own router and atom registry.
    await using _screen = await render(<AppRoot router={router} />, { router: false });
    await expect.element(page.getByRole("link", { name: "T3 Factory home" })).toBeVisible();
    await expect
      .element(page.getByRole("navigation", { name: "Threads", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Tasks", exact: true }))
      .toHaveAttribute("aria-current", "page");
    expect(state.lookups).toEqual([]);

    await page
      .getByRole("navigation", { name: "Threads", exact: true })
      .getByRole("button", { name: /New task/ })
      .click();
    expect(useTaskDialogStore.getState().dialog?.kind).toBe("new-task");
    useTaskDialogStore.getState().close();
    openCommandPalette({ query: "" });
    await expect.element(page.getByRole("option", { name: /New task/ }).first()).toBeVisible();
    await page
      .getByRole("option", { name: /New task/ })
      .first()
      .click();
    expect(useTaskDialogStore.getState().dialog?.kind).toBe("new-task");
    useTaskDialogStore.getState().close();

    openCommandPalette({ query: "reconnect" });
    await page
      .getByRole("option", { name: /T-41 Thread still shows Working after reconnect/ })
      .first()
      .click();
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/tasks/${ENVIRONMENT_ID}/T-41`),
    );

    const task = state.tasks.find((task) => task.displayId === "T-41")!;
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: task.run!.threadId },
    });
    const chip = page.getByRole("link", { name: "T-41 · In progress", exact: true });
    await expect.element(chip).toBeVisible();
    await expect.element(chip).toHaveAttribute("href", `/tasks/${ENVIRONMENT_ID}/T-41`);
    expect(new Set(state.lookups)).toEqual(new Set([task.run!.threadId]));

    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: "plain-thread" },
    });
    await expect.element(chip).not.toBeInTheDocument();
    await router.navigate({ to: "/factory", search: { state: "open", view: "list" } });
    await expect
      .element(page.getByRole("navigation", { name: "Threads", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Automations", exact: true }))
      .toBeVisible();
  });
});
