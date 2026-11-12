import "~/index.css";

import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import {
  FactoryTaskError,
  type FactoryTaskAssignment,
  type FactoryTaskAssigneePreviewInput,
  type FactoryTaskSummary,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { isMacPlatform } from "~/lib/utils";
import { render } from "../../../../test/render";
import { toastManager } from "../../ui/toast";
import { openNewTask, openTaskSetup, useTaskDialogStore } from "../taskDialogs";
import { TaskDialogsHost } from "./TaskDialogsHost";

const COMMANDS = [
  "createTask",
  "updateTask",
  "startTask",
  "retryTask",
  "requestTaskBreakdown",
] as const;
type CommandName = (typeof COMMANDS)[number];

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
  replies: {} as Record<string, unknown[]>,
  projects: [] as unknown[],
  scopeSingle: null as unknown,
  tasks: [] as FactoryTaskSummary[],
  previews: [] as FactoryTaskAssigneePreviewInput[],
}));

vi.mock(import("../../../state/factoryTasks"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const { FACTORY_TASK_FIXTURES } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  const command = (name: string) => ({
    label: name,
    run: (_registry: unknown, target: { input: Record<string, unknown> }) => {
      state.calls.push({ name, input: target.input });
      return Promise.resolve(state.replies[name]?.shift());
    },
    permissionAtom: () => Atom.make(true),
  });
  const detailOf = (taskId: string) => {
    const task = state.tasks.find((entry) => entry.ref.taskId === taskId)!;
    return {
      task,
      description: "",
      ancestors: [],
      subtasks: [],
      blockedBy: task.blockedBy,
      blocks: [],
      runs: [],
      fetchedAt: FACTORY_TASK_FIXTURES.at,
    };
  };
  const profileSetup = (id: string) =>
    FACTORY_TASK_FIXTURES.profiles.find((profile) => profile.id === id)!.setup;
  return {
    factoryTasks: {
      createTask: command("createTask"),
      updateTask: command("updateTask"),
      startTask: command("startTask"),
      retryTask: command("retryTask"),
      requestTaskBreakdown: command("requestTaskBreakdown"),
      readTask: (target: { input: { task: { ref: { taskId: string } } } }) =>
        Atom.make(AsyncResult.success(detailOf(target.input.task.ref.taskId))),
      previewTaskAssignee: (target: { input: FactoryTaskAssigneePreviewInput }) => {
        state.previews.push(target.input);
        const { assignment } = target.input;
        let parent = state.tasks.find((task) => task.ref.taskId === target.input.parent?.taskId);
        let inherited = null;
        while (parent) {
          const assigned = parent.assignee.assignment;
          if (assigned.mode === "pinned" || assigned.mode === "profile") {
            inherited =
              assigned.mode === "pinned" ? assigned.setup : profileSetup(assigned.profileId);
            break;
          }
          const parentId = parent.parent?.taskId;
          parent = state.tasks.find((task) => task.ref.taskId === parentId);
        }
        return Atom.make(
          AsyncResult.success({
            assignment,
            key: "",
            resolved:
              assignment.mode === "profile"
                ? {
                    profile: null,
                    setup: profileSetup(assignment.profileId ?? ""),
                    via: "assignment",
                  }
                : {
                    profile: null,
                    setup: inherited ?? profileSetup("implementer"),
                    via: inherited ? "parent" : "project-default",
                  },
          }),
        );
      },
    },
    useFactoryTaskDetail: (ref: { taskId: string }) => AsyncResult.success(detailOf(ref.taskId)),
    useFactoryAgentProfiles: () =>
      AsyncResult.success({
        profiles: FACTORY_TASK_FIXTURES.profiles.map((profile) => ({ profile, tasksThisWeek: 0 })),
        fetchedAt: FACTORY_TASK_FIXTURES.at,
      }),
  } as never;
});
vi.mock(import("./captureData"), () => ({
  useCaptureProjects: (() => state.projects) as never,
  useMachineLabel: () => "DESKTOP-CP4EDJH",
}));
vi.mock(import("../shared/taskScope"), () => ({
  useTaskScope: (() => ({ single: state.scopeSingle })) as never,
}));
vi.mock(import("../shared/taskCatalog"), () => ({
  useTaskCatalog: () => FACTORY_TASK_FIXTURES.catalog,
}));
vi.mock(import("../shared/taskModelChoices"), () => ({
  useTaskModelChoices: (() => ({
    instanceEntries: [{ instanceId: ProviderInstanceId.make("codex"), enabled: true }],
    modelOptionsByInstance: new Map(),
    normalize: (selection: unknown) => selection,
  })) as never,
  useTaskDefaultRuntimeMode: () => "full-access" as const,
}));
vi.mock(import("../../chat/ProviderModelPicker"), () => ({
  ProviderModelPicker: ((props: {
    onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        props.onInstanceModelChange(ProviderInstanceId.make("claudeAgent"), "claude-opus")
      }
    >
      Choose Claude Opus
    </button>
  )) as never,
}));

const MOD = isMacPlatform(navigator.platform) ? "Meta" : "Control";
const { environmentId } = FACTORY_TASK_FIXTURES;
const website = FACTORY_TASK_FIXTURES.projects[1]!;
const t3code = FACTORY_TASK_FIXTURES.projects[0]!;
const taskOf = (displayId: string) =>
  FACTORY_TASK_FIXTURES.tasks.find((task) => task.displayId === displayId)!;
const profile = (id: string) => FACTORY_TASK_FIXTURES.profiles.find((entry) => entry.id === id)!;
const callsOf = (name: CommandName) =>
  state.calls.filter((call) => call.name === name).map((call) => call.input);
const ok = (task: FactoryTaskSummary) => AsyncResult.success({ task, replayed: false });
const refused = (reason: FactoryTaskError["reason"]) =>
  AsyncResult.failure(Cause.fail(new FactoryTaskError({ reason })));
const created = (overrides: Partial<FactoryTaskSummary> = {}): FactoryTaskSummary => ({
  ...taskOf("T-43"),
  ref: { ...taskOf("T-43").ref, taskId: "task-47" },
  displayId: "T-47",
  version: 1,
  ...overrides,
});

function setup(replies: Partial<Record<CommandName, unknown[]>> = {}) {
  state.previews = [];
  state.tasks = [...FACTORY_TASK_FIXTURES.tasks];
  void page.viewport(1440, 900);
  state.calls.length = 0;
  for (const name of COMMANDS) state.replies[name] = [...(replies[name] ?? [])];
  state.projects = FACTORY_TASK_FIXTURES.projects.map((project) => ({
    key: `${project.environmentId}/${project.id}`,
    environmentId: project.environmentId,
    projectId: project.id,
    name: project.name,
    machine: FACTORY_TASK_FIXTURES.environmentName,
  }));
  state.scopeSingle = null;
  useTaskDialogStore.getState().close();
}

const composer = () => page.getByRole("textbox", { name: "What needs doing?" });

async function pickAssignee(from: RegExp, option: RegExp) {
  await userEvent.click(page.getByRole("button", { name: from }));
  await userEvent.click(page.getByRole("option", { name: option }));
}

it("adds to the backlog with the project, type and assignee chosen", async () => {
  setup({ createTask: [ok(created())] });
  openNewTask({ environmentId, projectId: website.id });
  await using _screen = await render(<TaskDialogsHost />);
  using toast = vi.spyOn(toastManager, "add");
  await composer().fill("Fix the list\nIt overflows at 1280");
  await pickAssignee(/^Unassigned/, /Implementer/);
  await userEvent.click(page.getByRole("combobox", { name: "Type" }));
  await userEvent.click(page.getByRole("option", { name: "Bug" }));
  await userEvent.click(page.getByRole("button", { name: /Add to backlog/ }));
  await vi.waitFor(() => expect(callsOf("createTask")).toHaveLength(1));
  expect(callsOf("createTask")[0]).toMatchObject({
    projectId: website.id,
    title: "Fix the list",
    description: "It overflows at 1280",
    type: "bug",
    assignment: { mode: "profile", profileId: "implementer" },
  });
  expect(callsOf("createTask")[0]).not.toHaveProperty("lane");
  expect(callsOf("startTask")).toEqual([]);
  await expect.element(composer()).not.toBeInTheDocument();
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Added T-47 to the backlog",
      actionProps: expect.objectContaining({ children: "Open T-47" }),
    }),
  );
});

it("offers no link when the task is added from the Tasks page", async () => {
  setup({ createTask: [ok(created())] });
  openNewTask({ environmentId, projectId: website.id });
  await using _screen = await render(<TaskDialogsHost />, { router: "/tasks" });
  using toast = vi.spyOn(toastManager, "add");
  await composer().fill("Light theme");
  await userEvent.click(page.getByRole("button", { name: /Add to backlog/ }));
  await expect.element(composer()).not.toBeInTheDocument();
  expect(toast).not.toHaveBeenCalled();
});

it("asks for a project when none is given", async () => {
  setup({ createTask: [ok(created())] });
  openNewTask();
  await using _screen = await render(<TaskDialogsHost />);
  await composer().fill("Rename the board");
  await expect.element(page.getByRole("button", { name: /Add to backlog/ })).toBeDisabled();
  await userEvent.click(page.getByRole("combobox", { name: "Project" }));
  await userEvent.click(page.getByRole("option", { name: "vigor" }));
  await userEvent.click(page.getByRole("button", { name: /Add to backlog/ }));
  await vi.waitFor(() => expect(callsOf("createTask")).toHaveLength(1));
  expect(callsOf("createTask")[0]).toMatchObject({ projectId: "vigor" });
});

it("starts now with the setup the assignee resolves to, and the shortcut runs it", async () => {
  setup({ createTask: [ok(created())], startTask: [ok(created())] });
  openNewTask({ environmentId, projectId: t3code.id });
  await using _screen = await render(<TaskDialogsHost />);
  await composer().fill("Show run cost on each task card");
  await pickAssignee(/^Unassigned/, /^Auto/);
  await userEvent.keyboard(`{${MOD}>}{Enter}{/${MOD}}`);
  await vi.waitFor(() => expect(callsOf("startTask")).toHaveLength(1));
  expect(callsOf("createTask")[0]).toMatchObject({ assignment: { mode: "auto" } });
  expect(callsOf("startTask")[0]).toMatchObject({
    ref: created().ref,
    expectedVersion: 1,
    setup: profile("implementer").setup,
  });
  expect(state.calls.map((call) => call.name)).toEqual(["createTask", "startTask"]);
});

it("cannot start while unassigned, and the shortcut adds to the backlog", async () => {
  setup({ createTask: [ok(created())] });
  openNewTask({ environmentId, projectId: t3code.id });
  await using _screen = await render(<TaskDialogsHost />);
  await composer().fill("Dark-mode contrast pass");
  await expect.element(page.getByRole("button", { name: /^Start now/ })).toBeDisabled();
  await userEvent.keyboard(`{${MOD}>}{Enter}{/${MOD}}`);
  await vi.waitFor(() => expect(callsOf("createTask")).toHaveLength(1));
  expect(callsOf("startTask")).toEqual([]);
});

it("keeps the task in the backlog and shows the sentence when the start is refused", async () => {
  setup({ createTask: [ok(created())], startTask: [refused("provider-unavailable")] });
  openNewTask({ environmentId, projectId: t3code.id });
  await using _screen = await render(<TaskDialogsHost />);
  using toast = vi.spyOn(toastManager, "add");
  await composer().fill("Benchmark index paths");
  await pickAssignee(/^Unassigned/, /Implementer/);
  await userEvent.click(page.getByRole("button", { name: /^Start now/ }));
  await expect.element(composer()).not.toBeInTheDocument();
  expect(callsOf("createTask")).toHaveLength(1);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Added T-47 to the backlog",
      description: "That agent is unavailable on this machine. Pick another one.",
      type: "error",
    }),
  );
});

it("adds a sub-task that follows its parent, and says so", async () => {
  const parent = taskOf("T-38");
  setup({
    createTask: [
      ok(created({ displayId: "T-38.5", parent: { taskId: "task-38", displayId: "T-38" } })),
    ],
  });
  openNewTask({ parent: parent.ref });
  await using _screen = await render(<TaskDialogsHost />);
  await expect.element(page.getByText("New sub-task of T-38")).toBeVisible();
  await composer().fill("Document the contract");
  await userEvent.click(page.getByRole("button", { name: /Auto/ }));
  await expect.element(page.getByText("Follows T-38 · Claude · Opus")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(page.getByRole("button", { name: /Add to backlog/ }));
  await vi.waitFor(() => expect(callsOf("createTask")).toHaveLength(1));
  expect(callsOf("createTask")[0]).toMatchObject({
    projectId: parent.ref.projectId,
    parent: { rootId: parent.ref.rootId, taskId: parent.ref.taskId },
    assignment: { mode: "auto" },
  });
});

it("creates in Ready when the dialog opens in that lane", async () => {
  setup({ createTask: [ok(created())] });
  openNewTask({ environmentId, projectId: t3code.id, lane: "ready" });
  await using _screen = await render(<TaskDialogsHost />);
  await composer().fill("Filter the board by assignee");
  await userEvent.click(page.getByRole("button", { name: /Add to Ready/ }));
  await vi.waitFor(() => expect(callsOf("createTask")).toHaveLength(1));
  expect(callsOf("createTask")[0]).toMatchObject({ lane: "ready" });
});

it("asks before discarding text, and closes at once without any", async () => {
  setup();
  openNewTask({ environmentId, projectId: t3code.id });
  await using _screen = await render(<TaskDialogsHost />);
  await composer().fill("Half a thought");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("Discard this task?")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Keep editing" }));
  await expect.element(composer()).toHaveValue("Half a thought");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(page.getByRole("button", { name: "Discard" }));
  await expect.element(composer()).not.toBeInTheDocument();

  openNewTask({ environmentId, projectId: t3code.id });
  await expect.element(composer()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(composer()).not.toBeInTheDocument();
});

const assignedTo = (assignment: FactoryTaskAssignment, task: FactoryTaskSummary) =>
  expect(callsOf("updateTask")[0]).toMatchObject({ assignment, ref: task.ref });

it("saves a changed assignee before starting, with the mode and workspace chosen", async () => {
  const task = taskOf("T-43");
  const saved = { ...task, version: 1 };
  setup({ updateTask: [ok(saved)], startTask: [ok(saved)] });
  openTaskSetup(task.ref, "start");
  await using _screen = await render(<TaskDialogsHost />);
  await expect.element(page.getByText("Start T-43")).toBeVisible();
  await expect.element(page.getByText("Server Git tests fail on Windows")).toBeVisible();
  await pickAssignee(/^Auto/, /Implementer/);
  await userEvent.click(page.getByRole("combobox", { name: "Mode" }));
  await userEvent.click(page.getByRole("option", { name: "Full access" }));
  await userEvent.click(page.getByRole("combobox", { name: "Workspace" }));
  await userEvent.click(page.getByRole("option", { name: "Project checkout" }));
  await userEvent.click(page.getByRole("button", { name: "Start", exact: true }));
  await vi.waitFor(() => expect(callsOf("startTask")).toHaveLength(1));
  assignedTo({ mode: "profile", profileId: "implementer" }, task);
  expect(callsOf("startTask")[0]).toMatchObject({
    ref: task.ref,
    expectedVersion: 1,
    setup: { ...profile("implementer").setup, runtimeMode: "full-access", workspace: "root" },
  });
  expect(state.calls.map((call) => call.name)).toEqual(["updateTask", "startTask"]);
  await expect.element(page.getByText("Start T-43")).not.toBeInTheDocument();
});

it("keeps the mode picked in the start sheet when only the pinned model changes", async () => {
  const pinned = { ...profile("implementer").setup, runtimeMode: "full-access" as const };
  const task: FactoryTaskSummary = {
    ...taskOf("T-43"),
    assignee: {
      assignment: { mode: "pinned", setup: pinned },
      key: "codex/gpt-6.1-sol",
      resolved: { profile: null, setup: pinned, via: "assignment" },
    },
  };
  const saved = { ...task, version: 1 };
  setup({ updateTask: [ok(saved)], startTask: [ok(saved)] });
  state.tasks = state.tasks.map((entry) => (entry.ref.taskId === task.ref.taskId ? task : entry));
  openTaskSetup(task.ref, "start");
  await using _screen = await render(<TaskDialogsHost />);
  await expect.element(page.getByText("Start T-43")).toBeVisible();
  await userEvent.click(page.getByRole("combobox", { name: "Mode" }));
  await userEvent.click(page.getByRole("option", { name: "Supervised" }));
  await pickAssignee(/Codex/, /Pin a harness and model/);
  await userEvent.click(page.getByRole("button", { name: "Choose Claude Opus" }));
  await userEvent.click(page.getByRole("button", { name: "Start", exact: true }));
  await vi.waitFor(() => expect(callsOf("startTask")).toHaveLength(1));
  expect(callsOf("startTask")[0]).toMatchObject({
    setup: {
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus" },
      runtimeMode: "approval-required",
    },
  });
});

it("runs a task again with the setup of its last run", async () => {
  const task = taskOf("T-29");
  setup({ retryTask: [ok(task)] });
  openTaskSetup(task.ref, "retry");
  await using _screen = await render(<TaskDialogsHost />);
  await expect.element(page.getByText("Run T-29 again")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(callsOf("retryTask")).toHaveLength(1));
  expect(callsOf("retryTask")[0]).toMatchObject({
    ref: task.ref,
    expectedVersion: task.version,
    setup: task.run!.setup,
  });
  expect(callsOf("updateTask")).toEqual([]);
});

it("starts unchanged Auto with the task's server resolution through a person parent", async () => {
  const original = taskOf("T-38.2");
  const task: FactoryTaskSummary = {
    ...original,
    status: "ready",
    run: null,
    liveRuns: [],
    attention: [],
    assignee: {
      assignment: { mode: "auto" },
      key: "architect",
      resolved: { profile: null, setup: profile("architect").setup, via: "parent" },
    },
  };
  setup({ startTask: [ok(task)] });
  state.tasks = state.tasks.map((entry) =>
    entry.ref.taskId === task.ref.taskId
      ? task
      : entry.ref.taskId === task.parent!.taskId
        ? { ...entry, assignee: { assignment: { mode: "person" }, key: "person", resolved: null } }
        : entry,
  );
  openTaskSetup(task.ref, "start");
  await using _screen = await render(<TaskDialogsHost />);
  await userEvent.click(page.getByRole("button", { name: "Start", exact: true }));
  await vi.waitFor(() => expect(callsOf("startTask")).toHaveLength(1));
  expect(callsOf("startTask")[0]).toMatchObject({ setup: profile("architect").setup });
  expect(callsOf("updateTask")).toEqual([]);
});

it.each(["changed assignment", "new sub-task"] as const)(
  "previews the full ancestor context for a %s",
  async (kind) => {
    const root = taskOf("T-38");
    const intermediate: FactoryTaskSummary = {
      ...root,
      ref: { ...root.ref, taskId: "intermediate" },
      displayId: "T-38.9",
      parent: { taskId: root.ref.taskId, displayId: root.displayId },
      assignee: { assignment: { mode: "person" }, key: "person", resolved: null },
    };
    const task: FactoryTaskSummary = {
      ...taskOf("T-38.2"),
      run: null,
      liveRuns: [],
      parent: { taskId: intermediate.ref.taskId, displayId: intermediate.displayId },
      assignee: {
        assignment: { mode: "pinned", setup: profile("implementer").setup },
        key: "implementer",
        resolved: { profile: null, setup: profile("implementer").setup, via: "assignment" },
      },
    };
    setup({ createTask: [ok(task)], updateTask: [ok(task)], startTask: [ok(task)] });
    state.tasks = [
      ...state.tasks.filter((entry) => entry.ref.taskId !== task.ref.taskId),
      task,
      intermediate,
    ];
    if (kind === "new sub-task") openNewTask({ parent: intermediate.ref });
    else openTaskSetup(task.ref, "start");
    await using _screen = await render(<TaskDialogsHost />);
    if (kind === "new sub-task") await composer().fill("Nested task");
    else await pickAssignee(/^Codex · Sol/, /^Auto/);
    await userEvent.click(
      page.getByRole("button", {
        name: kind === "new sub-task" ? /^Start now/ : "Start",
        exact: kind !== "new sub-task",
      }),
    );
    await vi.waitFor(() => expect(callsOf("startTask")).toHaveLength(1));
    expect(
      state.previews.some(
        (input) =>
          input.assignment.mode === "auto" && input.parent?.taskId === intermediate.ref.taskId,
      ),
    ).toBe(true);
    expect(callsOf("startTask")[0]).toMatchObject({ setup: root.assignee.resolved!.setup });
  },
);

it("asks for a plan without creating anything", async () => {
  const task = taskOf("T-43");
  setup({ requestTaskBreakdown: [ok(task)] });
  openTaskSetup(task.ref, "break-down");
  await using _screen = await render(<TaskDialogsHost />);
  using toast = vi.spyOn(toastManager, "add");
  await expect.element(page.getByText("Break down T-43")).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Workspace" }))
    .toHaveValue("Project checkout");
  await userEvent.click(page.getByRole("button", { name: "Ask for a plan" }));
  await vi.waitFor(() => expect(callsOf("requestTaskBreakdown")).toHaveLength(1));
  expect(callsOf("requestTaskBreakdown")[0]).toMatchObject({
    ref: task.ref,
    setup: { ...profile("implementer").setup, workspace: "root" },
  });
  expect(state.calls.map((call) => call.name)).toEqual(["requestTaskBreakdown"]);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Asked for a plan for T-43" }),
  );
});

it("cannot start a blocked task and says what it waits on", async () => {
  const task = taskOf("T-38.3");
  setup();
  openTaskSetup(task.ref, "start");
  await using _screen = await render(<TaskDialogsHost />);
  await expect.element(page.getByText("Waiting on T-38.2")).toBeVisible();
  await expect.element(page.getByText("Can start when T-38.2 is done.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
});

it("keeps what was chosen when the task changed underneath", async () => {
  const task = taskOf("T-43");
  setup({ updateTask: [ok(task)], startTask: [refused("version-conflict")] });
  openTaskSetup(task.ref, "start");
  await using _screen = await render(<TaskDialogsHost />);
  await pickAssignee(/^Auto/, /Architect/);
  await userEvent.click(page.getByRole("button", { name: "Start", exact: true }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Someone else changed this. Try again.");
  await expect.element(page.getByRole("button", { name: /Claude · Opus/ })).toBeVisible();
  expect(callsOf("startTask")).toHaveLength(1);
});
