import "~/index.css";

import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import {
  type FactoryTaskActivityEntry,
  type FactoryTaskDetail,
  FactoryTaskError,
  type FactoryTaskPlanProposal,
  type FactoryTaskResultReadResult,
  type FactoryTaskRun,
  type FactoryTaskSummary,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { validateTaskDetailSearch } from "../taskRoutes";
import { TaskDetailPage } from "./TaskDetailPage";

type Spy = ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
const state = vi.hoisted(() => ({
  details: new Map<string, unknown>(),
  activity: new Map<string, unknown>(),
  results: new Map<string, unknown>(),
  proposal: null as unknown,
  permissions: {} as Record<string, boolean>,
  actions: {} as Record<string, Spy>,
  commands: {} as Record<string, Spy>,
}));

vi.mock(import("../../../state/factoryTasks"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const { FACTORY_TASK_FIXTURES: fixtures } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  const { resolveFactoryTaskLiveState } =
    await import("@t3tools/client-runtime/state/factory-task-view");
  const requestsOf = (threadId: string) =>
    fixtures.threadFacts.find((fact) => fact.threadId === threadId)?.requests ?? {
      approvals: [],
      userInputs: [],
    };
  const queries: Record<string, (target: never) => unknown> = {
    readTaskPlanProposal: () => AsyncResult.success({ proposal: state.proposal }),
    readTask: (target: { input: { task: { ref: { taskId: string } } } }) =>
      state.details.get(target.input.task.ref.taskId) ?? AsyncResult.initial(true),
    previewTaskAssignee: () => AsyncResult.initial(true),
  };
  const atoms = Atom.family((key: string) => {
    const [name, target] = JSON.parse(key) as [string, never];
    return Atom.make(queries[name]!(target));
  });
  const factoryTasks = new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name in queries
          ? (target: unknown) => atoms(JSON.stringify([name, target]))
          : { permissionAtom: () => Atom.make(state.permissions[name] ?? true) },
    },
  );
  return {
    factoryTasks,
    useFactoryTaskDetailByDisplayId: (_environmentId: string, displayId: string) =>
      state.details.get(displayId) ??
      AsyncResult.failure(Cause.fail(new FactoryTaskError({ reason: "missing-task" }))),
    useFactoryTaskActivity: (ref: { taskId: string }) =>
      state.activity.get(ref.taskId) ??
      AsyncResult.success({ entries: [], nextCursor: null, fetchedAt: fixtures.at }),
    useFactoryTaskResult: (ref: { taskId: string }) =>
      state.results.get(ref.taskId) ?? AsyncResult.initial(true),
    useFactoryAgentProfiles: () =>
      AsyncResult.success({
        profiles: fixtures.profiles.map((profile) => ({ profile, tasksThisWeek: 0 })),
        fetchedAt: fixtures.at,
      }),
    useFactoryTaskLiveState: (task: FactoryTaskSummary) =>
      resolveFactoryTaskLiveState(task, fixtures.threadFacts),
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
vi.mock(import("../shared/taskActions"), () => ({
  useTaskActions: (() => state.actions) as never,
  useTaskPermissions: () => ({
    update: state.permissions.updateTask ?? true,
    start: true,
    stop: true,
    retry: true,
    accept: true,
    requestChanges: true,
    reopen: true,
    publish: state.permissions.publishTaskResult ?? true,
    merge: state.permissions.mergeTaskResult ?? true,
    check: true,
    resolvePlan: state.permissions.resolveTaskPlanProposal ?? true,
  }),
}));
vi.mock(import("../shared/taskPullRequest"), () => ({
  useTaskPullRequestChecks: () => "passing",
}));
vi.mock(import("./taskDetailCommands"), () => ({
  useTaskDetailCommands: (() => state.commands) as never,
}));
vi.mock(import("../taskDialogs"), () => ({ openNewTask: vi.fn(), openTaskSetup: vi.fn() }));
vi.mock(import("../shared/taskCatalog"), () => ({
  useTaskCatalog: () => FACTORY_TASK_FIXTURES.catalog,
}));
vi.mock(import("../../../state/presentation"), async (original) => ({
  ...(await original()),
  useEnvironmentPresentation: (() => ({
    isReady: true,
    presentation: {
      connection: { phase: "connected" },
      entry: { target: { label: "DESKTOP-CP4EDJH" } },
    },
  })) as never,
}));
vi.mock(import("../../../state/entities"), async (original) => ({
  ...(await original()),
  useProject: ((ref: { projectId: string }) => ({ title: ref.projectId })) as never,
}));
vi.mock(import("../../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../../hooks/useNowMinute"), () => ({
  useNowMinute: () => "2026-11-09T17:13",
}));

const { environmentId, at } = FACTORY_TASK_FIXTURES;
const fixture = (displayId: string) =>
  FACTORY_TASK_FIXTURES.tasks.find((task) => task.displayId === displayId)!;
const pointer = (task: FactoryTaskSummary) => ({
  taskId: task.ref.taskId,
  displayId: task.displayId,
  title: task.title,
  status: task.status,
});
const minutesAgo = (minutes: number) =>
  new Date(Date.parse(at) + (13 - minutes) * 60_000).toISOString();

const planTask: FactoryTaskSummary = {
  ...fixture("T-38"),
  liveRuns: [],
  progress: null,
  attention: [{ reason: "plan", taskId: "task-38", displayId: "T-38", detail: "" }],
};
const profileAssignment = (profileId: string) => ({ mode: "profile" as const, profileId });
const proposal: FactoryTaskPlanProposal = {
  id: "proposal-38",
  ref: planTask.ref,
  status: "proposed",
  proposedBy: { threadId: ThreadId.make("task-38-run"), setup: planTask.run!.setup },
  items: [
    ["contract", "Contract and migration", "architect", []],
    ["list-api", "Move the list API to tasks", "implementer", ["contract"]],
    ["mobile", "Update the mobile list", "scout", ["list-api"]],
    ["guide", "User guide for Tasks", "writer", ["contract"]],
  ].map(([key, title, profile, after]) => ({
    key: key as string,
    title: title as string,
    description: "",
    assignment: profileAssignment(profile as string),
    after: after as string[],
  })),
  version: 3,
  createdAt: at,
  updatedAt: at,
};

function detailOf(task: FactoryTaskSummary, extra: Partial<FactoryTaskDetail> = {}) {
  const parent = task.parent ? fixture(task.parent.displayId) : null;
  const detail: FactoryTaskDetail = {
    task,
    description: "",
    ancestors: parent ? [pointer(parent)] : [],
    subtasks: FACTORY_TASK_FIXTURES.tasks.filter(
      (candidate) => candidate.parent?.taskId === task.ref.taskId,
    ),
    blockedBy: task.blockedBy,
    blocks: FACTORY_TASK_FIXTURES.tasks
      .filter((candidate) => candidate.blockedBy.some((entry) => entry.taskId === task.ref.taskId))
      .map(pointer),
    runs: task.run ? [task.run] : [],
    fetchedAt: at,
    ...extra,
  };
  return detail;
}
const failedRun1: FactoryTaskRun = {
  ...fixture("T-29").run!,
  ordinal: 1,
  runId: RunId.make("run-29-1"),
  threadId: ThreadId.make("task-29-run-1"),
  startedAt: minutesAgo(66),
  endedAt: minutesAgo(60),
};

function entry(
  id: string,
  event: FactoryTaskActivityEntry["event"],
  actor: FactoryTaskActivityEntry["actor"] = { kind: "system", label: "T3 Factory" },
): FactoryTaskActivityEntry {
  return { id, at, actor, event };
}

function setup(path: string) {
  state.details = new Map();
  state.activity = new Map();
  state.results = new Map();
  state.proposal = null;
  state.permissions = {};
  state.actions = Object.fromEntries(
    ["update", "setLane", "cancel", "comment", "resolvePlan", "accept", "retry", "stop"].map(
      (name) => [name, vi.fn(() => Promise.resolve({}))],
    ),
  );
  state.commands = {
    savePlan: vi.fn(() => Promise.resolve(true)),
    messageAgent: vi.fn(() => Promise.resolve(true)),
  };
  const put = (detail: FactoryTaskDetail) => {
    state.details.set(detail.task.displayId, AsyncResult.success(detail));
    state.details.set(detail.task.ref.taskId, AsyncResult.success(detail));
  };
  for (const task of FACTORY_TASK_FIXTURES.tasks) put(detailOf(task));
  put(detailOf(fixture("T-29"), { runs: [fixture("T-29").run!, failedRun1] }));
  put(detailOf(fixture("T-38.1"), { blocks: [pointer(fixture("T-38.2"))] }));
  state.results.set(
    "task-36",
    AsyncResult.success({
      result: fixture("T-36").result!,
      text: null,
      files: [
        { path: "src/audio/ring.ts", additions: 72, deletions: 0 },
        { path: "src/components/AudioRing.tsx", additions: 58, deletions: 6 },
      ],
      filesOmitted: 4,
    } satisfies FactoryTaskResultReadResult),
  );
  state.activity.set(
    "task-29",
    AsyncResult.success({
      entries: [
        entry(
          "run-2-failed",
          {
            type: "run-ended",
            ordinal: 2,
            threadId: ThreadId.make("task-29-run"),
            outcome: "failed",
            note: "FAIL tests/test_index_paths.py::test_lookup_paths\nAssertionError: expected 3 index paths, got 2",
          },
          { kind: "agent", label: "Kimi · K3" },
        ),
      ],
      nextCursor: null,
      fetchedAt: at,
    }),
  );
  return { put, router: createDetailRouter(path) };
}

function createDetailRouter(path: string) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const blank = () => null;
  const routeTree = root.addChildren([
    chat.addChildren([
      createRoute({
        getParentRoute: () => chat,
        path: "tasks/$environmentId/$displayId",
        validateSearch: validateTaskDetailSearch,
        component: TaskDetailPage,
      }),
      createRoute({ getParentRoute: () => chat, path: "tasks", component: blank }),
      createRoute({
        getParentRoute: () => chat,
        path: "$environmentId/$threadId",
        component: blank,
      }),
    ]),
  ]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    disableGlobalCatchBoundary: true,
  });
}

async function renderDetail(path: string, before?: (mocks: ReturnType<typeof setup>) => void) {
  const mocks = setup(path);
  before?.(mocks);
  await page.viewport(1440, 900);
  await mocks.router.load();
  // The page reads its own route's params and search, so it needs the real route ids.
  const screen = await render(<RouterProvider router={mocks.router as never} />, { router: false });
  return { screen, ...mocks };
}
const taskPath = (displayId: string, search = "") =>
  `/tasks/${environmentId}/${displayId}${search}`;

const STATES: {
  frame: string;
  displayId: string;
  before?: (mocks: ReturnType<typeof setup>) => void;
  banner: string;
  subtasks: (string | RegExp)[];
  rail: string[];
  // Only an accepted code result with its pull request open offers Merge.
  merge?: string;
}[] = [
  {
    frame: "C1 backlog",
    displayId: "T-43",
    banner: "Not started",
    subtasks: ["Add sub-task", "Ask an agent to propose sub-tasks…"],
    rail: ["Backlog", "Unassigned", "GitHub #96", "Bug", "No runs yet"],
  },
  {
    frame: "C2 blocked",
    displayId: "T-38.3",
    banner: "Waiting on T-38.2",
    subtasks: ["Add sub-task"],
    rail: ["Ready", "Codex · Luna", "Parent", "Unified task model", "Blocked by"],
  },
  {
    frame: "C3 plan proposed",
    displayId: "T-38",
    before: ({ put }) => {
      put(detailOf(planTask, { subtasks: [] }));
      state.proposal = proposal;
    },
    banner: "Plan ready: 4 sub-tasks",
    subtasks: [
      "Proposed",
      "Contract and migration",
      "First",
      "After 1",
      "After 2",
      "Gemini · Flash",
    ],
    rail: ["In progress", "GitHub #62", "Run 1 · Claude · Opus", "Completed"],
  },
  {
    frame: "C4 parent waits on a sub-task",
    displayId: "T-38",
    banner: "T-38.2 is waiting on an answer",
    subtasks: [
      "2 of 4 done",
      "Keep cursor paging or switch to offsets?",
      "Blocked by T-38.2",
      /^Awaiting Input/,
      "User guide for Tasks",
    ],
    rail: ["In progress", "Claude · Opus", "Planning · 13m ago"],
  },
  {
    frame: "C5 question",
    displayId: "T-38.2",
    banner: "Codex · Sol asks",
    subtasks: ["Add sub-task"],
    rail: ["Run 1 · Codex · Sol", "Awaiting Input", "Parent", "Blocks", "Update the mobile list"],
  },
  {
    frame: "C6 in review",
    displayId: "T-36",
    banner: "Result ready: PR #112",
    subtasks: ["Add sub-task"],
    rail: ["In review", "website", "Completed"],
  },
  {
    frame: "C7 done",
    displayId: "T-38.1",
    banner: "Accepted · rev 1",
    subtasks: ["Add sub-task"],
    rail: ["Done", "Blocks", "Move the list API to tasks"],
    merge: "Merge PR #108",
  },
  {
    frame: "C8 failed",
    displayId: "T-29",
    banner: "Run 2 failed: Tests failed on attempt 2",
    subtasks: ["Add sub-task"],
    rail: [
      "In progress",
      "vigor",
      "Run 2 · Kimi · K3",
      "Run 1 · Kimi · K3",
      "6m · DESKTOP-CP4EDJH",
    ],
  },
  {
    frame: "C9 working",
    displayId: "T-41",
    banner: "Working · 13m",
    subtasks: ["Add sub-task"],
    rail: ["In progress", "Bug", "Run 1 · Codex · Sol", "Working"],
  },
  {
    frame: "C10 approval",
    displayId: "T-39",
    banner: "Kimi · K3 wants to run a command",
    subtasks: ["Add sub-task"],
    rail: ["In progress", "system-one-trader", "Pending Approval"],
  },
];

it.each(STATES)("$frame shows its banner, sub-tasks and rail", async (frame) => {
  const { screen } = await renderDetail(taskPath(frame.displayId), frame.before);
  await using _screen = screen;
  await expect.element(page.getByRole("region", { name: frame.banner })).toBeVisible();
  const subtasks = page.getByRole("region", { name: "Sub-tasks" });
  for (const text of frame.subtasks)
    await expect.element(subtasks.getByText(text, { exact: true }).first()).toBeVisible();
  const rail = page.getByRole("complementary", { name: "Properties" });
  for (const text of frame.rail)
    await expect.element(rail.getByText(text, { exact: true }).first()).toBeVisible();
  expect(
    page
      .getByRole("button", { name: /^Merge/ })
      .elements()
      .map((element) => element.textContent),
  ).toEqual(frame.merge ? [frame.merge] : []);
});

it("C8 shows the failed run's excerpt in Activity", async () => {
  const { screen } = await renderDetail(taskPath("T-29"));
  await using _screen = screen;
  const activity = page.getByRole("list", { name: "Activity" });
  await expect.element(activity.getByText("Run 2 failed: Tests failed on attempt 2")).toBeVisible();
  await expect
    .element(activity.getByText(/AssertionError: expected 3 index paths, got 2/))
    .toBeVisible();
});

it("saves only the edited title", async () => {
  const { screen } = await renderDetail(taskPath("T-43"));
  await using _screen = screen;
  await userEvent.click(page.getByRole("button", { name: "Server Git tests fail on Windows" }));
  const input = page.getByRole("textbox", { name: "Title" });
  await userEvent.clear(input);
  await userEvent.type(input, "Git tests fail on Windows runners{Enter}");
  expect(state.actions.update).toHaveBeenCalledExactlyOnceWith(fixture("T-43"), {
    title: "Git tests fail on Windows runners",
  });
});

it("offers no title editing without permission", async () => {
  const { screen } = await renderDetail(taskPath("T-43"), () => {
    state.permissions.updateTask = false;
  });
  await using _screen = screen;
  await expect
    .element(page.getByRole("heading", { name: "Server Git tests fail on Windows" }))
    .toBeVisible();
  expect(
    page.getByRole("button", { name: "Server Git tests fail on Windows" }).elements(),
  ).toHaveLength(0);
});

it("refuses a plan with a loop and sends the edited items", async () => {
  const { screen } = await renderDetail(taskPath("T-38"), ({ put }) => {
    put(detailOf(planTask, { subtasks: [] }));
    state.proposal = proposal;
  });
  await using _screen = screen;
  await userEvent.click(page.getByRole("button", { name: "Edit" }));
  await userEvent.click(page.getByRole("button", { name: "What sub-task 1 comes after" }));
  await userEvent.click(
    page.getByRole("menuitemcheckbox", { name: "2. Move the list API to tasks" }),
  );
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Sub-tasks 1, 2 each wait on another, so none can start.");
  await expect.element(page.getByRole("button", { name: "Save plan" })).toBeDisabled();

  await userEvent.click(page.getByRole("button", { name: "What sub-task 1 comes after" }));
  await userEvent.click(
    page.getByRole("menuitemcheckbox", { name: "2. Move the list API to tasks" }),
  );
  await userEvent.keyboard("{Escape}");
  await userEvent.click(page.getByRole("button", { name: "Remove sub-task 4" }));
  const title = page.getByRole("textbox", { name: "Title of sub-task 3" });
  await userEvent.clear(title);
  await userEvent.type(title, "Update the phone list");
  await userEvent.click(page.getByRole("button", { name: "Save plan" }));
  expect(state.commands.savePlan).toHaveBeenCalledExactlyOnceWith(
    planTask,
    proposal,
    proposal.items
      .slice(0, 3)
      .map((item) => (item.key === "mobile" ? { ...item, title: "Update the phone list" } : item)),
  );
});

it("refuses to save a plan whose item comes after a removed one", async () => {
  const { screen } = await renderDetail(taskPath("T-38"), ({ put }) => {
    put(detailOf(planTask, { subtasks: [] }));
    state.proposal = proposal;
  });
  await using _screen = screen;
  await userEvent.click(page.getByRole("button", { name: "Edit" }));
  await userEvent.click(page.getByRole("button", { name: "Remove sub-task 1" }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Sub-task 1 comes after a sub-task that was removed.");
  await expect.element(page.getByRole("button", { name: "Save plan" })).toBeDisabled();
});

it("dismisses a waiting plan from the page menu", async () => {
  const { screen } = await renderDetail(taskPath("T-38"), ({ put }) => {
    put(detailOf(planTask, { subtasks: [] }));
    state.proposal = proposal;
  });
  await using _screen = screen;
  await userEvent.click(page.getByRole("button", { name: "Task actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Dismiss plan" }));
  expect(state.actions.resolvePlan).toHaveBeenCalledExactlyOnceWith(planTask, proposal, "dismiss");
});

it("saves a comment for the people on the task", async () => {
  const { screen } = await renderDetail(taskPath("T-43"));
  await using _screen = screen;
  await userEvent.type(page.getByRole("textbox", { name: "Comment" }), "Seen on CI too");
  await userEvent.click(page.getByRole("button", { name: "Comment", exact: true }).last());
  expect(state.actions.comment).toHaveBeenCalledExactlyOnceWith(
    fixture("T-43").ref,
    "Seen on CI too",
  );
});

it("messages only a live planning run's agent", async () => {
  const planning: FactoryTaskRun = { ...fixture("T-38").run!, state: "running", endedAt: null };
  const planningTask: FactoryTaskSummary = {
    ...planTask,
    attention: [],
    run: planning,
    liveRuns: [
      {
        taskId: "task-38",
        displayId: "T-38",
        threadId: planning.threadId,
        state: "running",
        startedAt: at,
      },
    ],
  };
  const { screen } = await renderDetail(taskPath("T-38"), ({ put }) =>
    put(detailOf(planningTask, { subtasks: [] })),
  );
  await using _screen = screen;
  await userEvent.click(page.getByRole("button", { name: "Message agent" }));
  await expect
    .element(page.getByText("Goes to the agent and steers the current run"))
    .toBeVisible();
  await userEvent.type(
    page.getByRole("textbox", { name: "Message Claude · Opus" }),
    "Split the migration out",
  );
  await userEvent.click(page.getByRole("button", { name: "Send to agent" }));
  expect(state.commands.messageAgent).toHaveBeenCalledExactlyOnceWith(
    planningTask,
    planning,
    "Split the migration out",
  );
  expect(state.actions.comment).not.toHaveBeenCalled();
});

it.each([
  {
    run: "a work run",
    displayId: "T-41",
    line: "A working run takes replies through its questions and Request changes.",
  },
  {
    run: "no live run",
    displayId: "T-43",
    line: "Message agent opens while a planning run is live.",
  },
])("keeps Message agent unavailable with $run", async ({ displayId, line }) => {
  const { screen } = await renderDetail(taskPath(displayId));
  await using _screen = screen;
  await expect.element(page.getByRole("button", { name: "Message agent" })).toBeDisabled();
  await expect.element(page.getByText(line)).toBeVisible();
});

it("selects the tab named in the URL and writes the chosen tab back", async () => {
  const { screen, router } = await renderDetail(taskPath("T-36", "?tab=result"));
  await using _screen = screen;
  await expect
    .element(page.getByRole("tab", { name: "Result" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByText("src/components/AudioRing.tsx")).toBeVisible();
  await expect.element(page.getByText("And 4 more files.")).toBeVisible();

  await userEvent.click(page.getByRole("tab", { name: "Activity" }));
  await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
  await userEvent.click(page.getByRole("tab", { name: "Result" }));
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ tab: "result" }));
});

it.each([
  {
    state: "published and in review (C6)",
    displayId: "T-36",
    pullRequest: "open" as const,
    title: "PR #112 · Audio ring demo",
    meta: "+184 −20 · 6 files · checks pass",
  },
  {
    state: "accepted, not published",
    displayId: "T-38.1",
    pullRequest: null,
    title: "Contract and migration",
    meta: "+212 −48 · 7 files",
  },
  {
    state: "merged",
    displayId: "T-35",
    pullRequest: "merged" as const,
    title: "PR #99 · Gate tooling fixes",
    meta: "+64 −12 · 3 files · merged",
  },
])("the Result tab shows a code result $state", async (row) => {
  const task = fixture(row.displayId);
  const result = {
    ...task.result!,
    pullRequest:
      row.pullRequest === null ? null : { ...task.result!.pullRequest!, state: row.pullRequest },
  };
  const { screen } = await renderDetail(taskPath(row.displayId, "?tab=result"), (mocks) => {
    mocks.put(detailOf({ ...task, result }));
    state.results.set(
      task.ref.taskId,
      AsyncResult.success({
        result,
        text: null,
        files: [{ path: "src/tasks/contract.ts", additions: 12, deletions: 3 }],
        filesOmitted: 0,
      } satisfies FactoryTaskResultReadResult),
    );
  });
  await using _screen = screen;
  const tab = page.getByRole("tabpanel");
  await expect.element(tab.getByText(row.title, { exact: true })).toBeVisible();
  await expect.element(tab.getByText(row.meta, { exact: true })).toBeVisible();
  await expect.element(tab.getByText("src/tasks/contract.ts")).toBeVisible();
});

it.each(["T-99", "not-a-task"])("shows %s as a task that does not exist", async (displayId) => {
  const { screen } = await renderDetail(taskPath(displayId));
  await using _screen = screen;
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(`There is no task ${displayId} on this machine.`);
  expect(page.getByRole("status").elements()).toHaveLength(0);
});
