import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import {
  type FactoryTaskAssignee,
  type FactoryTaskAssignment,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { TaskAssigneePicker } from "./taskAssignee";
import type { TaskAssigneeParent } from "./taskAssigneeModel";

const state = vi.hoisted(() => ({
  previewReads: [] as unknown[],
  preview: null as unknown,
}));

vi.mock(import("../../../state/factoryTasks"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const { FACTORY_TASK_FIXTURES } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  return {
    factoryTasks: {
      previewTaskAssignee: (target: unknown) => {
        state.previewReads.push(target);
        return Atom.make(AsyncResult.success(state.preview));
      },
    },
    useFactoryAgentProfiles: () =>
      AsyncResult.success({
        profiles: FACTORY_TASK_FIXTURES.profiles.map((profile) => ({ profile, tasksThisWeek: 0 })),
        fetchedAt: FACTORY_TASK_FIXTURES.at,
      }),
  } as never;
});
vi.mock(import("./taskCatalog"), () => ({
  useTaskCatalog: () => FACTORY_TASK_FIXTURES.catalog,
}));
vi.mock(import("./taskModelChoices"), () => ({
  useTaskModelChoices: (() => ({
    instanceEntries: [{ instanceId: "codex", enabled: true }],
    modelOptionsByInstance: new Map(),
    normalize: (selection: unknown) => selection,
  })) as never,
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

const profile = (id: string) => FACTORY_TASK_FIXTURES.profiles.find((entry) => entry.id === id)!;

function setup(preview: FactoryTaskAssignee | null = null) {
  state.previewReads.length = 0;
  state.preview = preview ?? {
    assignment: { mode: "auto" },
    key: "implementer",
    resolved: { profile: null, setup: profile("implementer").setup, via: "project-default" },
  };
  return { onChange: vi.fn<(assignment: FactoryTaskAssignment) => void>() };
}

async function openPicker(
  onChange: (assignment: FactoryTaskAssignment) => void,
  parent?: TaskAssigneeParent,
) {
  const screen = await render(
    <TaskAssigneePicker
      environmentId={FACTORY_TASK_FIXTURES.environmentId}
      projectId={ProjectId.make("t3code-factory")}
      type="task"
      value={{ mode: "unassigned" }}
      onChange={onChange}
      trigger={<button type="button">Assignee</button>}
      allowUnassigned
      {...(parent ? { parent } : {})}
    />,
  );
  await using stack = new AsyncDisposableStack();
  stack.use(screen);
  await userEvent.click(screen.getByRole("button", { name: "Assignee" }));
  await expect.element(page.getByRole("option", { name: /Implementer/ })).toBeVisible();
  return stack.move();
}

it.each([
  { option: /^Auto/, expected: { mode: "auto" } },
  { option: /Implementer/, expected: { mode: "profile", profileId: "implementer" } },
  { option: /Person/, expected: { mode: "person" } },
  { option: /Nobody yet/, expected: { mode: "unassigned" } },
])("choosing $option emits $expected.mode", async ({ option, expected }) => {
  const { onChange } = setup();
  await using _screen = await openPicker(onChange);
  await userEvent.click(page.getByRole("option", { name: option }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith(expected);
});

it("pins the model chosen in the model picker, supervised in a new worktree", async () => {
  const { onChange } = setup();
  await using _screen = await openPicker(onChange);
  await userEvent.click(page.getByRole("option", { name: /Pin a harness and model/ }));
  await userEvent.click(page.getByRole("button", { name: "Choose Claude Opus" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith({
    mode: "pinned",
    setup: {
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspace: "worktree",
    },
  });
});

it("resolves a pinned parent through the server with its full context", async () => {
  const setupOfArchitect = profile("architect").setup;
  const { onChange } = setup({
    assignment: { mode: "auto" },
    key: "architect",
    resolved: { profile: null, setup: setupOfArchitect, via: "parent" },
  });
  const parent = FACTORY_TASK_FIXTURES.tasks.find((task) => task.displayId === "T-38")!;
  await using _screen = await openPicker(onChange, {
    ref: parent.ref,
    displayId: "T-38",
    assignee: {
      assignment: { mode: "pinned", setup: setupOfArchitect },
      key: "claudeAgent/claude-opus",
      resolved: { profile: null, setup: setupOfArchitect, via: "assignment" },
    },
  });
  await expect.element(page.getByText("Follows T-38 · Claude · Opus")).toBeVisible();
  expect(state.previewReads).toContainEqual({
    environmentId: parent.ref.environmentId,
    input: {
      projectId: "t3code-factory",
      type: "task",
      assignment: { mode: "auto" },
      parent: parent.ref,
    },
  });
});

it("asks the server when the parent does not decide", async () => {
  const { onChange } = setup();
  await using _screen = await openPicker(onChange, {
    displayId: "T-38",
    assignee: { assignment: { mode: "unassigned" }, key: "unassigned", resolved: null },
  });
  await expect.element(page.getByText("Picks Codex · Sol for this project")).toBeVisible();
  expect(state.previewReads).toContainEqual({
    environmentId: FACTORY_TASK_FIXTURES.environmentId,
    input: { projectId: "t3code-factory", type: "task", assignment: { mode: "auto" } },
  });
});
