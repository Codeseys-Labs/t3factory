import "~/index.css";

import { FACTORY_INTAKE_FIXTURES } from "@t3tools/client-runtime/state/factory-intake-fixtures";
import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import {
  groupFactoryTaskNeeds,
  resolveFactoryTaskLiveState,
} from "@t3tools/client-runtime/state/factory-task-view";
import {
  FactoryIntakeError,
  ThreadId,
  type FactoryTaskPlanProposal,
  type FactoryTaskSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import type { useInboxData } from "./inboxData";
import { InboxPage, needKey } from "./InboxPage";

type Spy = ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
const state = vi.hoisted(() => ({
  data: null as unknown as ReturnType<typeof useInboxData>,
  search: {} as Record<string, unknown>,
  version: 0,
  listeners: new Set<() => void>(),
  navigate: null as unknown as Spy,
  resolve: null as unknown as Spy,
  actions: {} as Record<string, Spy>,
  requests: {} as Record<string, Spy>,
  openSetup: null as unknown as Spy,
  permission: true,
  proposal: null as FactoryTaskPlanProposal | null,
  activityPages: [] as unknown[],
}));

vi.mock(import("@tanstack/react-router"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useSearch: (() => {
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.version,
      );
      return state.search;
    }) as never,
    useNavigate: (() => (input: { search?: Record<string, unknown> }) => {
      state.navigate(input);
      if (input.search) {
        state.search = input.search;
        state.version++;
        state.listeners.forEach((listener) => listener());
      }
      return Promise.resolve();
    }) as never,
  };
});
vi.mock(import("./inboxData"), () => ({
  arrivalKey: (entry: { environmentId: string; arrival: { id: string } }) =>
    JSON.stringify([entry.environmentId, entry.arrival.id]),
  useInboxData: (() => state.data) as never,
}));
vi.mock(import("../../../state/factoryTasks"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { FACTORY_TASK_FIXTURES: fixtures } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  const taskOf = (ref: { taskId: string }) =>
    state.data.tasks.find((task) => task.ref.taskId === ref.taskId) ??
    fixtures.tasks.find((task) => task.ref.taskId === ref.taskId)!;
  return {
    factoryIntake: { resolveIntakeArrival: {} },
    factoryTasks: {
      readTask: ({ input }: { input: { task: { ref: { taskId: string } } } }) =>
        Atom.make(AsyncResult.success({ task: taskOf(input.task.ref) })),
      readTaskActivity: ({ input }: { input: { cursor?: string } }) =>
        Atom.make(state.activityPages[Number(input.cursor ?? 0)]),
    },
    useFactoryTaskDetail: ((ref: { taskId: string }) =>
      AsyncResult.success({ task: taskOf(ref) })) as never,
    useFactoryTaskResult: ((ref: { taskId: string }) =>
      AsyncResult.success({
        result: taskOf(ref).result,
        text: null,
        files: [],
        filesOmitted: 0,
      })) as never,
    useFactoryTaskPlan: (() => AsyncResult.success({ proposal: state.proposal })) as never,
    useFactoryTaskLiveState: ((task: FactoryTaskSummary) =>
      resolveFactoryTaskLiveState(task, fixtures.threadFacts)) as never,
    useFactoryTaskCommand: ((_command: unknown, target: unknown) => ({
      permission: state.permission,
      run: () => state.resolve(target),
    })) as never,
    useFactoryTaskRequests: ((_environment: unknown, threadId: string) => {
      const requests = fixtures.threadFacts.find((fact) => fact.threadId === threadId)
        ?.requests ?? { approvals: [], userInputs: [] };
      return {
        ...requests,
        approval: requests.approvals[0] ?? null,
        question: requests.userInputs[0] ?? null,
        canRespond: state.permission,
        ...state.requests,
      };
    }) as never,
  } as never;
});
vi.mock(import("../shared/taskActions"), () => ({
  useTaskActions: (() => state.actions) as never,
  useTaskPermissions: () => ({
    update: state.permission,
    start: state.permission,
    stop: state.permission,
    retry: state.permission,
    accept: state.permission,
    requestChanges: state.permission,
    reopen: state.permission,
    publish: state.permission,
    merge: state.permission,
    check: state.permission,
    resolvePlan: state.permission,
  }),
}));
vi.mock(import("../shared/taskCatalog"), () => ({
  useTaskCatalog: () => FACTORY_TASK_FIXTURES.catalog,
}));
vi.mock(import("../shared/taskAssignee"), async () => {
  const { Button } = await import("../../ui/button");
  return {
    TaskAssigneePicker: ({ onChange }: { onChange: (value: { mode: "person" }) => void }) => (
      <Button size="sm" onClick={() => onChange({ mode: "person" })}>
        Assign to You
      </Button>
    ),
    useTaskSetup: (() => ({
      setup: null,
      assignee: { kind: "unassigned" },
      pending: false,
    })) as never,
    TaskAssigneeEditor: () => <></>,
  };
});
vi.mock(import("../taskDialogs"), () => ({
  openTaskSetup: ((...args: unknown[]) => state.openSetup(...args)) as never,
}));

const fixture = (id: string) => FACTORY_TASK_FIXTURES.tasks.find((task) => task.displayId === id)!;
function setup() {
  state.version = 0;
  state.search = {};
  state.permission = true;
  state.proposal = null;
  state.navigate = vi.fn();
  state.openSetup = vi.fn();
  state.resolve = vi.fn(() => Promise.resolve(AsyncResult.success({ task: null })));
  state.actions = Object.fromEntries(
    ["accept", "requestChanges", "retry", "resolvePlan"].map((key) => [
      key,
      vi.fn(() => Promise.resolve({})),
    ]),
  );
  state.requests = Object.fromEntries(
    ["answer", "approveOnce", "alwaysAllow", "deny"].map((key) => [
      key,
      vi.fn(() => Promise.resolve({ _tag: "Success" })),
    ]),
  );
  state.activityPages = [AsyncResult.success({ entries: [], nextCursor: null })];
  const tasks = FACTORY_TASK_FIXTURES.tasks;
  const needs = groupFactoryTaskNeeds(
    tasks.map((task) => resolveFactoryTaskLiveState(task, FACTORY_TASK_FIXTURES.threadFacts)),
  );
  state.data = {
    tasks: [...tasks],
    needs,
    incomplete: false,
    arrivals: FACTORY_INTAKE_FIXTURES.arrivals.map((arrival) => ({
      environmentId: FACTORY_TASK_FIXTURES.environmentId,
      arrival,
    })),
    waiting: 3,
    rules: [...FACTORY_INTAKE_FIXTURES.rules],
    more: [],
    machines: [
      {
        environmentId: FACTORY_TASK_FIXTURES.environmentId,
        label: "DESKTOP-CP4EDJH",
        state: "current",
      },
    ],
    scope: { targets: [], projects: [], single: null, label: "All projects" },
    reload: vi.fn(),
    loadMore: vi.fn(),
  };
  return state;
}

it("keeps urgency order and counts, opens a URL ask, and writes keyboard selection", async () => {
  const mocks = setup();
  state.search = { selected: "T-39" };
  await page.viewport(1440, 900);
  await using screen = await render(<InboxPage />);
  const blocking = screen.getByRole("region", { name: "Blocking a run" });
  const review = screen.getByRole("region", { name: "Ready to review" });
  expect(
    blocking
      .getByRole("button")
      .elements()
      .map((el) => el.textContent),
  ).toEqual([
    expect.stringContaining("T-29 Benchmark"),
    expect.stringContaining("T-39 Backtest"),
    expect.stringContaining("T-38.2 Move"),
  ]);
  expect(
    review
      .getByRole("button")
      .elements()
      .map((el) => el.textContent),
  ).toEqual([expect.stringContaining("T-36 Audio"), expect.stringContaining("T-33 Prerequisite")]);
  await expect.element(screen.getByRole("button", { name: "Needs you 5" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Triage 3" })).toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: "Backtest the momentum signal" }))
    .toBeVisible();
  await userEvent.click(blocking.getByRole("button").nth(1));
  await userEvent.keyboard("{ArrowDown}");
  expect(mocks.search.selected).toBe(needKey(mocks.data.needs.rows[2]!));
  await expect
    .element(screen.getByRole("heading", { name: "Move the list API to tasks" }))
    .toBeVisible();
  await userEvent.keyboard("{ArrowUp}");
  expect(mocks.search.selected).toBe(needKey(mocks.data.needs.rows[1]!));
  await userEvent.click(screen.getByRole("button", { name: "Triage 3" }));
  expect(mocks.search).toEqual({ tab: "triage" });
});

it.each(["Retry", "Reassign"])("%s opens the retry setup sheet", async (label) => {
  const mocks = setup();
  await using screen = await render(<InboxPage />);
  await userEvent.click(screen.getByRole("button", { name: label, exact: true }));
  expect(mocks.openSetup).toHaveBeenCalledWith(fixture("T-29").ref, "retry");
});

it.each([
  ["Approve once", "approveOnce"],
  ["Always allow for this task", "alwaysAllow"],
  ["Deny", "deny"],
])("%s answers the live approval", async (label, method) => {
  const mocks = setup();
  state.search = { selected: "T-39" };
  await using screen = await render(<InboxPage />);
  await userEvent.click(screen.getByRole("button", { name: label!, exact: true }));
  expect(mocks.requests[method!]).toHaveBeenCalledWith(
    FACTORY_TASK_FIXTURES.threadFacts.find((fact) => fact.requests?.approvals.length)?.requests
      ?.approvals[0]?.requestId,
  );
  await expect
    .element(screen.getByRole("heading", { name: "Backtest the momentum signal" }))
    .toBeVisible();
});

it("answers a question through the shared ask", async () => {
  const mocks = setup();
  state.search = { selected: "T-38.2" };
  await using screen = await render(<InboxPage />);
  await userEvent.type(screen.getByRole("textbox", { name: "Reply" }), "Keep cursors");
  await userEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
  expect(mocks.requests.answer).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
});

it.each(["review", "changed"])(
  "accepts the current %s revision and requests changes with a note",
  async (reason) => {
    const mocks = setup();
    const task = fixture("T-36");
    const need = { ...state.data.needs.review[0]!, reason: reason as "review" | "changed" };
    state.data.needs = groupFactoryTaskNeeds([{ attention: [need] }]);
    await using screen = await render(<InboxPage />);
    await userEvent.click(screen.getByRole("button", { name: "Accept", exact: true }));
    expect(mocks.actions.accept).toHaveBeenCalledWith(task, 1);
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "What should change" }),
      "Add a keyboard example",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    expect(mocks.actions.requestChanges).toHaveBeenCalledWith(task, 1, "Add a keyboard example");
  },
);

it("approves a plan using its version", async () => {
  const mocks = setup();
  const task: FactoryTaskSummary = {
    ...fixture("T-38"),
    attention: [{ reason: "plan", taskId: "task-38", displayId: "T-38", detail: "" }],
    liveRuns: [],
  };
  state.data.tasks = [task];
  state.data.needs = groupFactoryTaskNeeds([resolveFactoryTaskLiveState(task, [])]);
  state.proposal = {
    id: "plan-38",
    ref: task.ref,
    status: "proposed",
    proposedBy: { threadId: ThreadId.make("planning"), setup: task.run!.setup },
    version: 3,
    createdAt: FACTORY_TASK_FIXTURES.at,
    updatedAt: FACTORY_TASK_FIXTURES.at,
    items: [
      {
        key: "api",
        title: "Move the list API to tasks",
        description: "Keep cursor paging",
        assignment: { mode: "auto" },
        after: [],
      },
    ],
  };
  await using screen = await render(<InboxPage />);
  await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));
  expect(mocks.actions.resolvePlan).toHaveBeenCalledWith(task, mocks.proposal, "approve");
});

it("advances selection only when the answered ask leaves through the data stream", async () => {
  setup();
  const selected = state.data.needs.rows[1]!;
  const next = state.data.needs.rows[2]!;
  state.search = { selected: needKey(selected) };
  await using screen = await render(<InboxPage />);
  await userEvent.click(screen.getByRole("button", { name: "Approve once", exact: true }));
  expect(state.search.selected).toBe(needKey(selected));
  state.data = {
    ...state.data,
    needs: groupFactoryTaskNeeds([
      { attention: state.data.needs.rows.filter((need) => need !== selected) },
    ]),
  };
  await screen.rerender(<InboxPage />);
  await vi.waitFor(() => expect(state.search.selected).toBe(needKey(next)));
});

it("accepts the suggestion and links the created task", async () => {
  const mocks = setup();
  state.search = { tab: "triage" };
  state.resolve = vi.fn(() => Promise.resolve(AsyncResult.success({ task: fixture("T-43") })));
  await using screen = await render(<InboxPage />);
  await userEvent.click(screen.getByRole("button", { name: "Accept", exact: true }));
  expect(mocks.resolve).toHaveBeenCalledWith({
    environmentId: FACTORY_TASK_FIXTURES.environmentId,
    input: {
      commandId: expect.any(String),
      id: "github-101",
      expectedVersion: 0,
      action: {
        type: "accept",
        taskType: "bug",
        assignment: FACTORY_INTAKE_FIXTURES.arrivals[0]!.suggestion!.assignee.assignment,
      },
    },
  });
  await expect
    .element(screen.getByRole("link", { name: "T-43 Server Git tests fail on Windows" }))
    .toBeVisible();
});

it("accepts edited type and assignment", async () => {
  const mocks = setup();
  state.search = { tab: "triage" };
  await using screen = await render(<InboxPage />);
  await userEvent.click(screen.getByRole("button", { name: "Change type or assignee" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Task type" }));
  await userEvent.click(page.getByRole("option", { name: "Docs", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Assign to You" }));
  await userEvent.click(screen.getByRole("button", { name: "Accept", exact: true }));
  expect(mocks.resolve).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        action: { type: "accept", taskType: "docs", assignment: { mode: "person" } },
      }),
    }),
  );
});

it.each([
  { label: "Tomorrow", action: { type: "snooze", until: "2026-11-11T17:00:00.000Z" } },
  { label: "Next week", action: { type: "snooze", until: "2026-11-17T17:00:00.000Z" } },
  { label: "Decline", action: { type: "decline" } },
  { label: "Mark duplicate", action: { type: "duplicate", of: null } },
])("$label sends its resolution", async ({ label, action }) => {
  const mocks = setup();
  state.search = { tab: "triage" };
  using _date = vi.spyOn(globalThis, "Date").mockImplementation(
    class extends NativeDate {
      constructor(value?: string | number) {
        super(value ?? new NativeDate(2026, 10, 10, 8).getTime());
      }
    } as DateConstructor,
  );
  await using screen = await render(<InboxPage />);
  if (action.type === "snooze")
    await userEvent.click(screen.getByRole("button", { name: "Snooze", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: label, exact: true }));
  expect(mocks.resolve).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        action:
          action.type === "snooze"
            ? {
                ...action,
                until: new NativeDate(2026, 10, label === "Tomorrow" ? 11 : 17, 9).toISOString(),
              }
            : action,
      }),
    }),
  );
});
const NativeDate = Date;

it("keeps a refused arrival visible, shows its sentence, and uses a fresh command id on retry", async () => {
  const mocks = setup();
  state.search = { tab: "triage" };
  state.resolve = vi.fn(() =>
    Promise.resolve(
      AsyncResult.failure(Cause.fail(new FactoryIntakeError({ reason: "version-conflict" }))),
    ),
  );
  await using screen = await render(<InboxPage />);
  await userEvent.click(screen.getByRole("button", { name: "Accept", exact: true }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Someone else changed this. Try again.");
  await expect
    .element(screen.getByRole("heading", { name: "Board cards overflow at 1280" }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Accept", exact: true }));
  const calls = mocks.resolve.mock.calls as [{ input: { commandId: string } }][];
  expect(calls[0]![0].input.commandId).not.toBe(calls[1]![0].input.commandId);
});

it("renders hostile arrival text literally and rejects unsafe source URLs", async () => {
  setup();
  state.search = { tab: "triage" };
  const entry = state.data.arrivals[0]!;
  state.data.arrivals = [
    {
      ...entry,
      arrival: {
        ...entry.arrival,
        body: '<img src=x onerror="alert(1)"> **Run this** https://bad.example',
        url: "javascript:alert(1)",
      },
    },
  ];
  await using screen = await render(<InboxPage />);
  await expect
    .element(screen.getByText('<img src=x onerror="alert(1)"> **Run this** https://bad.example'))
    .toBeVisible();
  expect(screen.container.querySelector("img")).toBeNull();
  expect(screen.getByRole("link").elements()).toHaveLength(0);
});

it.each(["needs", "triage"])("shows the distinct %s empty state", async (tab) => {
  setup();
  state.data.needs = groupFactoryTaskNeeds([]);
  state.data.arrivals = [];
  state.data.waiting = 0;
  state.search = tab === "triage" ? { tab } : {};
  await using screen = await render(<InboxPage />);
  await expect
    .element(
      screen.getByText(tab === "triage" ? "No new arrivals" : "Nothing needs you", { exact: true }),
    )
    .toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: tab === "triage" ? "Open Automations" : "Go to Tasks" }),
  );
  expect(state.navigate).toHaveBeenCalledWith({ to: tab === "triage" ? "/automations" : "/tasks" });
});

it.each(["loading", "offline", "forbidden", "failed", "unsupported"] as const)(
  "keeps %s separate from an empty Inbox",
  async (status) => {
    setup();
    state.data.needs = groupFactoryTaskNeeds([]);
    state.data.arrivals = [];
    state.data.machines[0]!.state = status;
    await using screen = await render(<InboxPage />);
    expect(screen.getByText("Nothing needs you", { exact: true }).elements()).toHaveLength(0);
    await expect.element(screen.getByRole(status === "loading" ? "status" : "alert")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(state.data.reload).toHaveBeenCalledOnce();
  },
);

it("offers to load an incomplete ask list and disables mutations without permission", async () => {
  setup();
  state.data.incomplete = true;
  state.search = { tab: "triage" };
  state.permission = false;
  await using screen = await render(<InboxPage />);
  await userEvent.click(screen.getByRole("button", { name: "Load more", exact: true }));
  expect(state.data.reload).toHaveBeenCalledOnce();
  await expect.element(screen.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
  expect(state.resolve).not.toHaveBeenCalled();
});

it("reads through oldest-first activity pages and shows only the three newest entries", async () => {
  setup();
  const entry = (id: string, at: string) => ({
    id,
    at,
    actor: { kind: "person", label: "You" },
    event: { type: "comment", body: id },
  });
  state.activityPages = [
    AsyncResult.success({
      entries: [entry("oldest", "2026-11-08T17:00:00.000Z")],
      nextCursor: "1",
    }),
    AsyncResult.success({
      entries: [
        entry("second", "2026-11-09T17:00:00.000Z"),
        entry("third", "2026-11-09T18:00:00.000Z"),
        entry("newest", "2026-11-09T19:00:00.000Z"),
      ],
      nextCursor: null,
    }),
  ];
  await using screen = await render(<InboxPage />);
  const recent = screen.getByRole("region", { name: "Recent activity" });
  await expect.element(recent.getByText("newest", { exact: true })).toBeVisible();
  expect(recent.getByText("oldest", { exact: true }).elements()).toHaveLength(0);
  expect([...recent.element().querySelectorAll("span.flex-1")].map((el) => el.textContent)).toEqual(
    ["newest", "third", "second"],
  );
});
