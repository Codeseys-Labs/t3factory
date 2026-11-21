import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import {
  type FactoryTaskAssignee,
  type FactoryTaskAssignment,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { TaskAssigneeEditor, TaskAssigneePicker } from "./taskAssignee";
import type { TaskAssigneeParent } from "./taskAssigneeModel";

const state = vi.hoisted(() => ({
  previewReads: [] as unknown[],
  preview: null as unknown,
  server: {
    version: 0,
    arrivals: 0,
    applied: [] as { setup: { modelSelection: { model: string; options?: unknown } } }[],
    release: null as (() => void) | null,
  },
}));

vi.mock(import("../../../state/factoryTasks"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const { FACTORY_TASK_FIXTURES } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  const { FactoryTaskError } = await import("@t3tools/contracts");
  const Cause = await import("effect/Cause");
  const { commandEffect } = await import("../../../../test/commandEffect");
  // A task server: a save lands on the version it names, else it answers with the current one.
  // The second save to arrive is slow, so it is answered only once the test releases it.
  const answer = (input: { expectedVersion: number; assignment: unknown }) => {
    if (input.expectedVersion !== state.server.version)
      return AsyncResult.failure(
        Cause.fail(
          new FactoryTaskError({
            reason: "version-conflict",
            currentVersion: state.server.version,
          }),
        ),
      );
    state.server.version += 1;
    state.server.applied.push(input.assignment as never);
    return AsyncResult.success({ replayed: false });
  };
  return {
    factoryTasks: {
      updateTask: {
        label: "test",
        permissionAtom: () => Atom.make(true),
        run: (_registry: unknown, target: { input: Parameters<typeof answer>[0] }) => {
          const slow = state.server.arrivals++ === 1;
          return commandEffect(
            slow
              ? new Promise((resolve) => {
                  state.server.release = () => resolve(answer(target.input));
                })
              : Promise.resolve(answer(target.input)),
          );
        },
      },
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
    instanceEntries: [
      {
        instanceId: "codex",
        driverKind: "codex",
        enabled: true,
        models: [
          {
            slug: "terra",
            name: "Terra",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select",
                  options: [
                    { id: "low", label: "Low", isDefault: true },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
    modelOptionsByInstance: new Map(),
    normalize: (selection: unknown) => selection,
  })) as never,
  useTaskDefaultRuntimeMode: () => "auto-accept-edits" as const,
}));
vi.mock(import("../../chat/ProviderModelPicker"), async () => ({
  DockedPickerContext: (await import("react")).createContext({ modelLabel: "" }),
  ProviderModelPicker: ((props: {
    onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
    effortColumn: ReactNode;
    footer: ReactNode;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          props.onInstanceModelChange(ProviderInstanceId.make("claudeAgent"), "claude-opus")
        }
      >
        Choose Claude Opus
      </button>
      <button
        type="button"
        onClick={() => props.onInstanceModelChange(ProviderInstanceId.make("codex"), "terra")}
      >
        Choose Terra
      </button>
      {props.effortColumn}
      {props.footer}
    </>
  )) as never,
}));

const profile = (id: string) => FACTORY_TASK_FIXTURES.profiles.find((entry) => entry.id === id)!;

function setup(preview: FactoryTaskAssignee | null = null) {
  state.previewReads.length = 0;
  Object.assign(state.server, { version: 0, arrivals: 0, release: null });
  state.server.applied.length = 0;
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
  value: FactoryTaskAssignment = { mode: "unassigned" },
) {
  const screen = await render(
    <TaskAssigneePicker
      environmentId={FACTORY_TASK_FIXTURES.environmentId}
      projectId={ProjectId.make("t3code-factory")}
      type="task"
      value={value}
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

const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" };
const supervisedInCheckout = {
  ...profile("implementer").setup,
  runtimeMode: "approval-required",
  workspace: "root",
} as const;
it.each([
  {
    name: "a first pin takes the project's default permissions, in a new worktree",
    value: { mode: "unassigned" },
    setup: {
      modelSelection: opus,
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      workspace: "worktree",
    },
  },
  {
    name: "a pin's new model keeps the permissions and workspace it already chose",
    value: { mode: "pinned", setup: supervisedInCheckout },
    setup: { ...supervisedInCheckout, modelSelection: opus },
  },
] satisfies { name: string; value: FactoryTaskAssignment; setup: unknown }[])(
  "$name",
  async ({ value, setup: pinned }) => {
    const { onChange } = setup();
    await using _screen = await openPicker(onChange, undefined, value);
    await userEvent.click(page.getByRole("option", { name: /Pin a harness and model/ }));
    await userEvent.click(page.getByRole("button", { name: "Choose Claude Opus" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ mode: "pinned", setup: pinned });
  },
);

it("pins a model with the effort chosen for it, and clears it back to the model's default", async () => {
  const { onChange } = setup();
  await using _screen = await openPicker(onChange);
  const pinned = (options?: { id: string; value: string | boolean }[]) => ({
    mode: "pinned",
    setup: {
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "terra",
        ...(options ? { options } : {}),
      },
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      workspace: "worktree",
    },
  });
  await userEvent.click(page.getByRole("option", { name: /Pin a harness and model/ }));
  await userEvent.click(page.getByRole("button", { name: "Choose Terra" }));
  await userEvent.click(page.getByRole("radio", { name: "High" }));
  await userEvent.click(page.getByRole("button", { name: "Use model defaults" }));
  expect(onChange.mock.calls.map(([assignment]) => assignment)).toEqual([
    pinned(),
    pinned([{ id: "reasoningEffort", value: "high" }]),
    pinned(),
  ]);
  await expect.element(page.getByRole("button", { name: "Use model defaults" })).toBeDisabled();
});

it("keeps the saved pin's other fields when a pick follows a change made elsewhere", async () => {
  const { onChange } = setup();
  const picker = (value: FactoryTaskAssignment) => (
    <TaskAssigneePicker
      environmentId={FACTORY_TASK_FIXTURES.environmentId}
      projectId={ProjectId.make("t3code-factory")}
      type="task"
      value={value}
      onChange={onChange}
      trigger={<button type="button">Assignee</button>}
    />
  );
  await using screen = await render(picker({ mode: "pinned", setup: supervisedInCheckout }));
  await userEvent.click(screen.getByRole("button", { name: "Assignee" }));
  await userEvent.click(page.getByRole("option", { name: /Pin a harness and model/ }));
  await userEvent.click(page.getByRole("button", { name: "Choose Terra" }));
  // Another screen moves the task to full access while this popup is still open.
  await screen.rerender(
    picker({
      mode: "pinned",
      setup: { ...supervisedInCheckout, runtimeMode: "full-access", workspace: "worktree" },
    }),
  );
  await userEvent.click(page.getByRole("button", { name: "Choose Claude Opus" }));
  expect(onChange).toHaveBeenLastCalledWith({
    mode: "pinned",
    setup: {
      ...supervisedInCheckout,
      runtimeMode: "full-access",
      workspace: "worktree",
      modelSelection: opus,
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

it.each([
  { name: "in one editor", remount: false },
  { name: "after the editor is unmounted and mounted again", remount: true },
])(
  "ends on the last model chosen even when an earlier save is slow, $name",
  async ({ remount }) => {
    setup();
    const task = {
      ...FACTORY_TASK_FIXTURES.tasks.find((entry) => entry.displayId === "T-41")!,
      assignee: { assignment: { mode: "unassigned" }, key: "unassigned", resolved: null },
      liveRuns: [],
      run: null,
      parent: null,
      version: 0,
    } as unknown as Parameters<typeof TaskAssigneeEditor>[0]["task"];
    await using screen = await render(<TaskAssigneeEditor task={task} />);
    await userEvent.click(screen.getByRole("button", { name: /Unassigned/ }));
    await userEvent.click(page.getByRole("option", { name: /Pin a harness and model/ }));
    await userEvent.click(page.getByRole("button", { name: "Choose Terra" }));
    await userEvent.click(page.getByRole("radio", { name: "High" }));
    await vi.waitFor(() => expect(state.server.release).not.toBeNull());
    if (remount) await screen.unmount();
    await using again = remount ? await render(<TaskAssigneeEditor task={task} />) : null;
    if (again !== null) {
      await userEvent.click(again.getByRole("button", { name: /Unassigned/ }));
      await userEvent.click(page.getByRole("option", { name: /Pin a harness and model/ }));
    }
    await userEvent.click(page.getByRole("button", { name: "Choose Claude Opus" }));
    state.server.release?.();
    await vi.waitFor(() => expect(state.server.applied).toHaveLength(3));
    expect(state.server.applied.map((assignment) => assignment.setup.modelSelection)).toMatchObject(
      [
        { model: "terra" },
        { model: "terra", options: [{ id: "reasoningEffort", value: "high" }] },
        { model: "claude-opus" },
      ],
    );
  },
);
