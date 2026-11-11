import "~/index.css";

import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import type { FactoryTaskListTarget } from "@t3tools/client-runtime/state/factory-task-list";
import { EnvironmentId, type FactoryTaskSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../../test/render";
import { TasksPage } from "./TasksPage";

type Spy = ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
const LAPTOP = EnvironmentId.make("laptop");
const state = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    search: {} as Record<string, unknown>,
    navigations: [] as { to?: string; search?: Record<string, unknown>; params?: unknown }[],
    version: 0,
    tasks: [] as FactoryTaskSummary[],
    environments: [] as string[],
    failed: new Set<string>(),
    targets: [] as unknown[],
    setLane: null as unknown as Spy,
    openTaskSetup: null as unknown as Spy,
    openNewTask: null as unknown as Spy,
    toast: null as unknown as Spy,
  };
});

vi.mock(import("@tanstack/react-router"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useSearch: (() => {
      useSyncExternalStore(state.subscribe, () => state.version);
      return state.search;
    }) as never,
    useNavigate: (() => (options: (typeof state.navigations)[number]) => {
      state.navigations.push(options);
      if (options.to === "/tasks") {
        state.search = options.search ?? {};
        state.version++;
        for (const listener of state.listeners) listener();
      }
    }) as never,
  };
});
vi.mock(import("../../../state/factoryTasks"), async () => {
  const { useSyncExternalStore } = await import("react");
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const { FACTORY_TASK_FIXTURES } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  const { resolveFactoryTaskLiveState } =
    await import("@t3tools/client-runtime/state/factory-task-view");
  const facts = FACTORY_TASK_FIXTURES.threadFacts;
  const requestsOf = (threadId: string) =>
    facts.find((fact) => fact.threadId === threadId)?.requests ?? {
      approvals: [],
      userInputs: [],
    };
  const matches = (input: FactoryTaskListTarget["input"]) => (task: FactoryTaskSummary) =>
    (input.scope === "all" || task.parent === null) &&
    (input.statuses ? input.statuses.includes(task.status) : task.status !== "canceled") &&
    (!input.types || input.types.includes(task.type)) &&
    (!input.sourceKinds || input.sourceKinds.includes(task.source.kind)) &&
    (!input.assigneeKeys || input.assigneeKeys.includes(task.assignee.key));
  const counted = (input: FactoryTaskListTarget["input"]) => (task: FactoryTaskSummary) =>
    matches({ ...input, statuses: input.statuses ?? [task.status] })(task);
  const detailOf = (task: FactoryTaskSummary) => ({
    task,
    description: "",
    ancestors: [],
    subtasks: [],
    blockedBy: [],
    blocks: [],
    runs: [],
    fetchedAt: FACTORY_TASK_FIXTURES.at,
  });
  const find = (ref: { taskId: string }) =>
    state.tasks.find((task) => task.ref.taskId === ref.taskId)!;
  return {
    factoryTasks: {
      updateTask: { permissionAtom: () => Atom.make(true) },
      readTask: ({ input }: { input: { task: { ref: { taskId: string } } } }) =>
        Atom.make(AsyncResult.success(detailOf(find(input.task.ref)))),
      readTaskPlanProposal: () => Atom.make(AsyncResult.success({ proposal: null })),
    },
    useFactoryTasks: (targets: readonly FactoryTaskListTarget[]) => {
      useSyncExternalStore(state.subscribe, () => state.version);
      state.targets.push(targets);
      const byStatus = {
        backlog: 0,
        ready: 0,
        "in-progress": 0,
        "in-review": 0,
        done: 0,
        canceled: 0,
      };
      const owners = targets.map((target) => {
        const failed = state.failed.has(target.environmentId);
        const own = state.tasks.filter((task) => task.ref.environmentId === target.environmentId);
        const items = failed ? [] : own.filter(matches(target.input));
        if (!failed) for (const task of own.filter(counted(target.input))) byStatus[task.status]++;
        return {
          environmentId: target.environmentId,
          status: failed ? "failed" : "current",
          countsStatus: failed ? "failed" : "current",
          pages: [{ environmentId: target.environmentId, items, nextCursor: null, fetchedAt: "" }],
          counts: failed
            ? null
            : { environmentId: target.environmentId, byStatus: [], fetchedAt: "" },
          nextCursor: null,
          capped: false,
        };
      });
      return {
        owners,
        items: owners.flatMap((owner) =>
          owner.pages[0]!.items.map((task) => ({ task, stale: false })),
        ),
        byStatus,
        countsComplete: owners.every((owner) => owner.countsStatus === "current"),
        incomplete: false,
        more: [],
        loadMore: () => undefined,
        refresh: () => undefined,
      };
    },
    useFactoryAgentProfiles: () =>
      AsyncResult.success({ profiles: FACTORY_TASK_FIXTURES.profiles }),
    useFactoryTaskDetail: (ref: { taskId: string }) => AsyncResult.success(detailOf(find(ref))),
    useFactoryTaskActivity: () =>
      AsyncResult.success({ entries: [], nextCursor: null, fetchedAt: FACTORY_TASK_FIXTURES.at }),
    useFactoryTaskLiveState: (task: FactoryTaskSummary) => resolveFactoryTaskLiveState(task, facts),
    useFactoryTaskRequests: (_environmentId: unknown, threadId: string) => {
      const requests = requestsOf(threadId);
      return {
        ...requests,
        question: requests.userInputs[0] ?? null,
        approval: requests.approvals[0] ?? null,
        canRespond: true,
        answer: vi.fn(),
        approveOnce: vi.fn(),
        alwaysAllow: vi.fn(),
        deny: vi.fn(),
      };
    },
  } as never;
});
vi.mock(import("../shared/taskScope"), async () => {
  const { useSyncExternalStore } = await import("react");
  const { FACTORY_TASK_FIXTURES } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  const { groupFactoryTaskNeeds, resolveFactoryTaskLiveState } =
    await import("@t3tools/client-runtime/state/factory-task-view");
  return {
    useTaskScope: (() => {
      useSyncExternalStore(state.subscribe, () => state.version);
      return {
        targets: state.environments.map((environmentId) => ({ environmentId, input: {} })),
        projects: FACTORY_TASK_FIXTURES.projects.map((project) => ({
          displayName: project.name,
          memberProjectRefs: [{ environmentId: project.environmentId, projectId: project.id }],
        })),
        single: null,
        label: "All projects",
      };
    }) as never,
    useNeedsYou: (() => {
      const tasks = state.tasks;
      const needs = groupFactoryTaskNeeds(
        tasks.map((task) => resolveFactoryTaskLiveState(task, FACTORY_TASK_FIXTURES.threadFacts)),
      );
      return { needs, tasks, incomplete: false };
    }) as never,
  };
});
vi.mock(import("../shared/taskActions"), () => ({
  useTaskActions: (() => ({ setLane: state.setLane, retry: vi.fn() })) as never,
  useTaskPermissions: () => ({
    update: true,
    start: true,
    stop: true,
    retry: true,
    breakDown: true,
    accept: true,
    requestChanges: true,
    reopen: true,
    publish: true,
    merge: true,
    check: true,
    resolvePlan: true,
  }),
}));
vi.mock(import("../shared/taskPullRequest"), () => ({
  useTaskPullRequestChecks: () => "passing",
}));
vi.mock(import("../taskDialogs"), () => ({
  openTaskSetup: ((...args: unknown[]) => state.openTaskSetup(...args)) as never,
  openNewTask: ((...args: unknown[]) => state.openNewTask(...args)) as never,
}));
vi.mock(import("../shared/taskCatalog"), () => ({
  useTaskCatalog: () => FACTORY_TASK_FIXTURES.catalog,
}));
vi.mock(import("../../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: (...args: unknown[]) => state.toast(...args) } as never,
}));
vi.mock(import("../../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual: Record<string, unknown> = await original();
  return { ...actual, primaryServerKeybindingsAtom: Atom.make([]) } as never;
});
vi.mock(import("../../../keybindings"), async (original) => ({
  ...(await original()),
  shortcutLabelForCommand: () => "C",
}));
vi.mock(import("../../../state/presentation"), async (original) => ({
  ...(await original()),
  useEnvironmentPresentation: ((environmentId: string) => ({
    isReady: true,
    presentation: {
      entry: { target: { label: environmentId === "laptop" ? "LAPTOP" : "DESKTOP-CP4EDJH" } },
    },
  })) as never,
}));
vi.mock(import("../../../hooks/useNowMinute"), () => ({
  useNowMinute: () => "2026-11-09T17:13",
}));

function setup(
  options: {
    search?: Record<string, unknown>;
    tasks?: FactoryTaskSummary[];
    failed?: string[];
  } = {},
) {
  state.search = options.search ?? {};
  state.navigations = [];
  state.version = 0;
  state.listeners.clear();
  state.tasks = options.tasks ?? [...FACTORY_TASK_FIXTURES.tasks];
  state.failed = new Set(options.failed ?? []);
  state.environments = [FACTORY_TASK_FIXTURES.environmentId, ...(options.failed ?? [])];
  state.targets = [];
  state.setLane = vi.fn(() => Promise.resolve({}));
  state.openTaskSetup = vi.fn();
  state.openNewTask = vi.fn();
  state.toast = vi.fn();
}
const fixture = (displayId: string) =>
  FACTORY_TASK_FIXTURES.tasks.find((task) => task.displayId === displayId)!;
const card = (displayId: string) =>
  page.getByRole("region", { name: "Task board" }).getByRole("button", {
    name: new RegExp(`^${displayId.replace(".", "\\.")} `),
  });
const column = (name: string) => page.getByRole("group", { name: new RegExp(`^${name}, `) });

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    isPrimary: true,
    pointerId: 1,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });
async function drag(from: HTMLElement, to: HTMLElement) {
  const start = from.getBoundingClientRect();
  const end = to.getBoundingClientRect();
  const [x, y] = [start.x + 24, start.y + 24];
  const [tx, ty] = [end.x + end.width / 2, end.y + 24];
  for (const [type, px, py] of [
    ["pointerdown", x, y],
    ["pointermove", x + 12, y + 12],
    ["pointermove", tx, ty],
    ["pointermove", tx + 1, ty + 1],
    ["pointerup", tx + 1, ty + 1],
  ] as const)
    await act(() => from.dispatchEvent(pointer(type, px, py)));
}

it("shows the five columns with their counts, and a parent's progress and sub-task ask", async () => {
  setup();
  await page.viewport(1440, 900);
  await using _screen = await render(<TasksPage />);
  for (const [name, count] of [
    ["Backlog", 3],
    ["Ready", 2],
    ["In progress", 4],
    ["In review", 2],
    ["Done", 3],
  ] as const)
    await expect.element(column(name)).toHaveAccessibleName(`${name}, ${count} tasks`);
  await expect.element(page.getByText("14 tasks")).toBeVisible();
  const parent = card("T-38");
  await expect.element(parent.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "2 of 4");
  expect(parent.element().textContent).toContain("Awaiting Input13m");
  const strip = page.getByRole("region", { name: "Needs you" });
  await expect.element(strip.getByText("T-38.2 Move the list API to tasks")).toBeVisible();
  await expect.element(strip.getByText("2 more to review")).toBeVisible();
  expect(page.getByRole("button", { name: /^New task in / }).elements()).toHaveLength(2);
});

it("saves a drop on Ready, opens the setup for In progress, and refuses a drop it cannot make", async () => {
  setup();
  await page.viewport(1440, 900);
  await using _screen = await render(<TasksPage />);
  await drag(card("T-45").element() as HTMLElement, column("Ready").element() as HTMLElement);
  expect(state.setLane).toHaveBeenCalledExactlyOnceWith(fixture("T-45"), "ready");

  await drag(card("T-42").element() as HTMLElement, column("In progress").element() as HTMLElement);
  expect(state.openTaskSetup).toHaveBeenCalledExactlyOnceWith(fixture("T-42").ref, "start");
  expect(state.setLane).toHaveBeenCalledOnce();

  await drag(card("T-36").element() as HTMLElement, column("Done").element() as HTMLElement);
  expect(state.setLane).toHaveBeenCalledOnce();
  expect(state.toast).toHaveBeenCalledExactlyOnceWith({
    type: "warning",
    title: "Accept the result first.",
  });
});

it("moves across cards and columns with the arrows; Space peeks, Enter opens, Escape closes", async () => {
  setup();
  await page.viewport(1440, 900);
  await using _screen = await render(<TasksPage />);
  (card("T-45").element() as HTMLElement).focus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(card("T-44")).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(card("T-40")).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(card("T-41")).toHaveFocus();
  await userEvent.keyboard(" ");
  expect(state.navigations.at(-1)?.search).toEqual({ peek: fixture("T-41").ref });
  await expect
    .element(
      page.getByRole("complementary", { name: "T-41 Thread still shows Working after reconnect" }),
    )
    .toBeVisible();
  await expect.element(card("T-41")).toHaveAttribute("aria-pressed", "true");
  (card("T-41").element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(state.navigations.at(-1)).toEqual({
    to: "/tasks/$environmentId/$displayId",
    params: { environmentId: FACTORY_TASK_FIXTURES.environmentId, displayId: "T-41" },
  });
  await userEvent.keyboard("{Escape}");
  expect(state.navigations.at(-1)?.search).toEqual({});
  await expect.element(page.getByRole("complementary")).not.toBeInTheDocument();
});

it("nests sub-tasks under their parent in the list and starts with Done collapsed", async () => {
  setup({ search: { layout: "list" } });
  await page.viewport(1440, 900);
  await using _screen = await render(<TasksPage />);
  const list = page.getByRole("region", { name: "Task list" });
  await expect.element(list.getByRole("button", { name: /^T-38\.1 / })).toBeVisible();
  const rows = list
    .getByRole("button", { name: /^T-\d/ })
    .elements()
    .map((element) => element.textContent?.match(/^T-[\d.]+/)?.[0]);
  expect(rows.slice(0, 5)).toEqual(["T-38", "T-38.1", "T-38.2", "T-38.3", "T-38.4"]);
  await expect
    .element(list.getByRole("button", { name: /^Done/ }))
    .toHaveAttribute("aria-expanded", "false");
  expect(rows).not.toContain("T-35");
  expect(state.targets.at(-1)).toEqual([
    { environmentId: FACTORY_TASK_FIXTURES.environmentId, input: { scope: "all" } },
  ]);
});

it("writes layout, grouping and filters to the URL, and that URL restores the view", async () => {
  setup();
  await page.viewport(1440, 900);
  {
    await using _screen = await render(<TasksPage />);
    await userEvent.click(page.getByRole("button", { name: "List" }));
    expect(state.navigations.at(-1)?.search).toEqual({ layout: "list" });
    await userEvent.click(page.getByRole("button", { name: /^Group/ }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "Assignee" }));
    expect(state.navigations.at(-1)?.search).toEqual({ layout: "list", group: "assignee" });
    await userEvent.click(page.getByRole("button", { name: /^Filter/ }));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Bug" }));
    expect(state.navigations.at(-1)?.search).toEqual({
      layout: "list",
      group: "assignee",
      filters: { types: ["bug"] },
    });
  }
  const search = state.search;
  setup({ search });
  await using _screen = await render(<TasksPage />);
  const list = page.getByRole("region", { name: "Task list" });
  await expect.element(list).toBeVisible();
  expect(state.targets.at(-1)).toEqual([
    {
      environmentId: FACTORY_TASK_FIXTURES.environmentId,
      input: { types: ["bug"], scope: "all" },
    },
  ]);
  await expect.element(list.getByRole("button", { name: /^T-43 / })).toBeVisible();
  await expect.element(list.getByRole("button", { name: /^T-41 / })).toBeVisible();
  expect(list.getByRole("button", { name: /^T-45 / }).elements()).toHaveLength(0);
  await expect.element(list.getByRole("button", { name: /Unassigned/ }).first()).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: /^Group/ }))
    .toHaveAccessibleName("Group Assignee");
});

it("shows a failed machine beside the tasks that loaded, and A4 when there are no tasks", async () => {
  setup({ failed: [LAPTOP] });
  await page.viewport(1440, 900);
  {
    await using _screen = await render(<TasksPage />);
    await expect
      .element(page.getByRole("alert").getByText("Tasks from LAPTOP failed to load."))
      .toBeVisible();
    await expect.element(card("T-45")).toBeVisible();
    expect(page.getByText("No tasks yet").elements()).toHaveLength(0);
  }
  setup({ tasks: [] });
  await using _screen = await render(<TasksPage />);
  await expect.element(page.getByText("No tasks yet")).toBeVisible();
  await expect.element(page.getByText("Press C anywhere to add a task")).toBeVisible();
  expect(page.getByRole("button", { name: "List" }).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: /^Filter/ }).elements()).toHaveLength(0);
  await userEvent.click(page.getByRole("button", { name: "Connect a source" }));
  expect(state.navigations.at(-1)).toEqual({ to: "/automations", search: { sheet: "source" } });
});

it.each(["board", "list"] as const)(
  "keeps sub-task assignees available through filters in %s",
  async (layout) => {
    const parent = fixture("T-43");
    const child: FactoryTaskSummary = {
      ...fixture("T-38.3"),
      parent: { taskId: parent.ref.taskId, displayId: parent.displayId },
      ref: { ...fixture("T-38.3").ref, rootId: parent.ref.rootId },
      assignee: fixture("T-34").assignee,
    };
    setup({ tasks: [parent, child], search: { layout, filters: { types: ["bug"] } } });
    await using _screen = await render(<TasksPage />);
    await userEvent.click(page.getByRole("button", { name: /^Filter/ }));
    const assignee = page.getByRole("menuitemcheckbox", { name: "Claude · Sonnet" });
    await expect.element(assignee).toBeVisible();
    await userEvent.click(assignee);
    await expect.element(assignee).toHaveAttribute("aria-checked", "true");
    await userEvent.click(assignee);
    await expect.element(assignee).toHaveAttribute("aria-checked", "false");
  },
);
