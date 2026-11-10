import "~/index.css";

import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import type { FactoryTaskPlanProposal, FactoryTaskSummary } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { TaskBanner } from "./TaskBanner";

type Spy = ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
const state = vi.hoisted(() => ({
  proposal: null as unknown,
  actions: {} as Record<string, Spy>,
  openTaskSetup: null as unknown as Spy,
  navigate: null as unknown as Spy,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));
vi.mock(import("../../../state/factoryTasks"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const { FACTORY_TASK_FIXTURES } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  const { resolveFactoryTaskLiveState } =
    await import("@t3tools/client-runtime/state/factory-task-view");
  const requestsOf = (threadId: string) =>
    FACTORY_TASK_FIXTURES.threadFacts.find((fact) => fact.threadId === threadId)?.requests ?? {
      approvals: [],
      userInputs: [],
    };
  return {
    factoryTasks: {
      readTaskPlanProposal: () => Atom.make(AsyncResult.success({ proposal: state.proposal })),
    },
    useFactoryTaskLiveState: (task: FactoryTaskSummary) =>
      resolveFactoryTaskLiveState(task, FACTORY_TASK_FIXTURES.threadFacts),
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
vi.mock(import("./taskActions"), () => ({
  useTaskActions: (() => state.actions) as never,
  useTaskPermissions: () => ({
    update: true,
    start: true,
    stop: true,
    retry: true,
    accept: true,
    requestChanges: true,
    reopen: true,
    resolvePlan: true,
  }),
}));
vi.mock(import("../taskDialogs"), () => ({
  openTaskSetup: ((...args: unknown[]) => state.openTaskSetup(...args)) as never,
}));
vi.mock(import("./taskCatalog"), () => ({
  useTaskCatalog: () => FACTORY_TASK_FIXTURES.catalog,
}));
vi.mock(import("../../../state/presentation"), async (original) => ({
  ...(await original()),
  useEnvironmentPresentation: (() => ({
    isReady: true,
    presentation: { entry: { target: { label: "DESKTOP-CP4EDJH" } } },
  })) as never,
}));
vi.mock(import("../../../hooks/useNowMinute"), () => ({
  useNowMinute: () => "2026-11-09T17:13",
}));

const fixture = (displayId: string) =>
  FACTORY_TASK_FIXTURES.tasks.find((task) => task.displayId === displayId)!;
const planTask: FactoryTaskSummary = {
  ...fixture("T-38"),
  liveRuns: [],
  progress: null,
  attention: [{ reason: "plan", taskId: "task-38", displayId: "T-38", detail: "" }],
};
const proposal: FactoryTaskPlanProposal = {
  id: "proposal-38",
  ref: planTask.ref,
  status: "proposed",
  proposedBy: { threadId: ThreadId.make("task-38-run"), setup: planTask.run!.setup },
  items: [
    "Contract and migration",
    "Move the list API to tasks",
    "Update the mobile list",
    "User guide for Tasks",
  ].map((title, index) => ({
    key: `item-${index}`,
    title,
    description: "",
    assignment: { mode: "auto" },
    after: [],
  })),
  version: 3,
  createdAt: FACTORY_TASK_FIXTURES.at,
  updatedAt: FACTORY_TASK_FIXTURES.at,
};

function setup() {
  state.proposal = proposal;
  state.openTaskSetup = vi.fn();
  state.navigate = vi.fn();
  state.actions = Object.fromEntries(
    ["retry", "stop", "accept", "requestChanges", "reopen", "resolvePlan"].map((name) => [
      name,
      vi.fn(() => Promise.resolve({})),
    ]),
  );
  return { ...state, onEditPlan: vi.fn() };
}
type Mocks = ReturnType<typeof setup>;
const taskPage = (displayId: string) => ({
  to: "/tasks/$environmentId/$displayId",
  params: { environmentId: FACTORY_TASK_FIXTURES.environmentId, displayId },
});

const BANNERS: {
  frame: string;
  task: FactoryTaskSummary;
  title: string;
  detail: string;
  actions: { label: string; called: (mocks: Mocks, task: FactoryTaskSummary) => void }[];
}[] = [
  {
    frame: "C1 backlog",
    task: fixture("T-43"),
    title: "Not started",
    detail: "Unassigned",
    actions: [
      {
        label: "Assign and start",
        called: (mocks, task) =>
          expect(mocks.openTaskSetup).toHaveBeenCalledWith(task.ref, "start"),
      },
    ],
  },
  {
    frame: "C2 blocked",
    task: fixture("T-38.3"),
    title: "Waiting on T-38.2",
    detail: "Can start when T-38.2 is done.",
    actions: [
      {
        label: "Open T-38.2",
        called: (mocks) => expect(mocks.navigate).toHaveBeenCalledWith(taskPage("T-38.2")),
      },
    ],
  },
  {
    frame: "C3 plan proposed",
    task: planTask,
    title: "Plan ready: 4 sub-tasks",
    detail: "Claude · Opus",
    actions: [
      {
        label: "Approve plan",
        called: (mocks, task) =>
          expect(mocks.actions.resolvePlan).toHaveBeenCalledWith(task, proposal, "approve"),
      },
      { label: "Edit", called: (mocks) => expect(mocks.onEditPlan).toHaveBeenCalledOnce() },
    ],
  },
  {
    frame: "C4 parent waits on a sub-task",
    task: fixture("T-38"),
    title: "T-38.2 is waiting on an answer",
    detail: "2 of 4 sub-tasks done",
    actions: [
      {
        label: "Answer",
        called: (mocks) => expect(mocks.navigate).toHaveBeenCalledWith(taskPage("T-38.2")),
      },
    ],
  },
  {
    frame: "C6 in review",
    task: fixture("T-36"),
    title: "Result ready: PR #112",
    detail: "+184 −20 · 6 files · checks pass",
    actions: [
      {
        label: "Accept",
        called: (mocks, task) => expect(mocks.actions.accept).toHaveBeenCalledWith(task, 1),
      },
      {
        label: "Request changes",
        called: (mocks) => expect(mocks.actions.requestChanges).not.toHaveBeenCalled(),
      },
    ],
  },
  {
    frame: "C7 done",
    task: fixture("T-38.1"),
    title: "Accepted · rev 1",
    detail: "PR #108 is open · +212 −48 · checks pass",
    actions: [],
  },
  {
    frame: "C8 failed",
    task: fixture("T-29"),
    title: "Run 2 failed: Tests failed on attempt 2",
    detail: "Run 2 · Kimi · K3 · DESKTOP-CP4EDJH",
    actions: [
      {
        label: "Retry",
        called: (mocks, task) => expect(mocks.actions.retry).toHaveBeenCalledWith(task),
      },
      {
        label: "Reassign",
        called: (mocks, task) =>
          expect(mocks.openTaskSetup).toHaveBeenCalledWith(task.ref, "retry"),
      },
    ],
  },
  {
    frame: "C9 working",
    task: fixture("T-41"),
    title: "Working · 13m",
    detail: "Codex · Sol · DESKTOP-CP4EDJH",
    actions: [
      {
        label: "Stop",
        called: (mocks, task) => expect(mocks.actions.stop).toHaveBeenCalledWith(task),
      },
    ],
  },
];

it.each(BANNERS)("$frame shows its title, detail and actions", async (banner) => {
  const mocks = setup();
  await using screen = await render(
    <TaskBanner task={banner.task} onEditPlan={mocks.onEditPlan} />,
  );
  const region = screen.getByRole("region", { name: banner.title });
  await expect.element(region).toBeVisible();
  await expect.element(region.getByText(banner.detail, { exact: true })).toBeVisible();
  expect(
    region
      .getByRole("button")
      .elements()
      .map((element) => element.textContent),
  ).toEqual(banner.actions.map((action) => action.label).toReversed());
  for (const action of banner.actions) {
    await userEvent.click(region.getByRole("button", { name: action.label }));
    action.called(mocks, banner.task);
  }
});

it("C6 asks for the note before requesting changes", async () => {
  const mocks = setup();
  const task = fixture("T-36");
  await page.viewport(1440, 900);
  await using screen = await render(<TaskBanner task={task} />);
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  expect(mocks.actions.requestChanges).not.toHaveBeenCalled();
  await userEvent.type(
    page.getByRole("textbox", { name: "What should change" }),
    "Keep the ring under 60fps",
  );
  await userEvent.click(page.getByRole("button", { name: "Send" }));
  expect(mocks.actions.requestChanges).toHaveBeenCalledExactlyOnceWith(
    task,
    1,
    "Keep the ring under 60fps",
  );
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it.each([
  {
    frame: "C5 question",
    displayId: "T-38.2",
    ask: "Codex · Sol asks",
    text: "Keep cursor paging or switch to offsets?",
  },
  {
    frame: "C10 approval",
    displayId: "T-39",
    ask: "Kimi · K3 wants to run a command",
    text: "python backtest.py --full",
  },
])("$frame puts the ask in the banner's place", async ({ displayId, ask, text }) => {
  setup();
  await using screen = await render(<TaskBanner task={fixture(displayId)} />);
  const card = screen.getByRole("region", { name: ask });
  await expect.element(card).toBeVisible();
  await expect.element(card.getByText(text)).toBeVisible();
  expect(screen.getByRole("region").elements()).toHaveLength(1);
});
