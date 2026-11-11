import { FACTORY_INTAKE_FIXTURES } from "@t3tools/client-runtime/state/factory-intake-fixtures";
import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import {
  FactoryIntakeError,
  FactoryTaskError,
  ProviderInstanceId,
  type FactoryAgentProfile,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigations: [] as { search: Record<string, unknown>; replace?: boolean }[],
  sources: null as unknown,
  rules: null as unknown,
  profiles: null as unknown,
  calls: [] as { command: string; input: Record<string, unknown> }[],
  refusals: [] as unknown[],
  version: 0,
  listeners: new Set<() => void>(),
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
    useNavigate: (() => (options: { search: Record<string, unknown>; replace?: boolean }) => {
      state.navigations.push(options);
      state.search = options.search;
      state.version++;
      state.listeners.forEach((listener) => listener());
    }) as never,
  };
});
vi.mock(import("../../../state/factoryTasks"), async () => {
  const { useSyncExternalStore } = await import("react");
  const { AsyncResult } = await import("effect/reactivity");
  const live = <T,>(read: () => T) => {
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => state.version,
    );
    return read();
  };
  const command = (label: string) => ({ label });
  return {
    factoryIntake: {
      saveIntakeSource: command("saveIntakeSource"),
      deleteIntakeSource: command("deleteIntakeSource"),
      saveIntakeRule: command("saveIntakeRule"),
      deleteIntakeRule: command("deleteIntakeRule"),
    },
    factoryTasks: {
      saveAgentProfile: command("saveAgentProfile"),
      deleteAgentProfile: command("deleteAgentProfile"),
    },
    useFactoryIntakeSources: () => live(() => state.sources),
    useFactoryIntakeRules: () => live(() => state.rules),
    useFactoryAgentProfiles: () => live(() => state.profiles),
    useFactoryIntakePreview: () => AsyncResult.success({ matchedLast30Days: 4 }),
    useFactoryTaskCommand: (
      target: { label: string },
      { input }: { input: Record<string, unknown> },
    ) => ({
      permission: true,
      run: async () => {
        state.calls.push({ command: target.label, input });
        return state.refusals.shift() ?? AsyncResult.success({ replayed: false });
      },
    }),
  } as never;
});
vi.mock(import("../../../state/environments"), () => ({
  useEnvironments: (() => ({
    isReady: true,
    environments: [
      {
        environmentId: FACTORY_TASK_FIXTURES.environmentId,
        label: FACTORY_TASK_FIXTURES.environmentName,
        connection: { phase: "connected" },
        serverConfig: {},
      },
    ],
  })) as never,
  usePrimaryEnvironmentId: () => FACTORY_TASK_FIXTURES.environmentId,
}));
vi.mock(import("../../../state/session"), () => ({
  useEnvironmentsWithScope: () => new Set([FACTORY_TASK_FIXTURES.environmentId]),
}));
vi.mock(import("../../../state/entities"), () => ({
  useProjects: (() =>
    FACTORY_TASK_FIXTURES.projects.map((project) => ({
      environmentId: project.environmentId,
      id: project.id,
      title: project.name,
    }))) as never,
}));
vi.mock(import("../../../state/factory"), () => ({
  useFactoryFeedsSupported: () => true,
  useFactoryResearchSupported: () => true,
  useFactoryKnowledgeSupported: () => true,
}));
vi.mock(import("../shared/taskCatalog"), () => ({
  useTaskCatalog: () => FACTORY_TASK_FIXTURES.catalog,
}));
vi.mock(import("./profileModels"), () => ({
  useProfileHarnesses: () => [
    {
      instanceId: ProviderInstanceId.make("codex"),
      label: "Codex",
      runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
      models: [
        {
          slug: "gpt-6.1-sol",
          label: "Sol",
          effort: {
            id: "reasoningEffort",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
            defaultId: "medium",
          },
        },
        { slug: "gpt-6-luna", label: "Luna", effort: null },
      ],
    },
  ],
}));

import "~/index.css";
import { act, fakeTimers, render } from "../../../../test/render";
import { AutomationsPage } from "./AutomationsPage";

const { at, sources, rules } = FACTORY_INTAKE_FIXTURES;
const { environmentId, profiles } = FACTORY_TASK_FIXTURES;

function setup(search: Record<string, unknown> = {}) {
  state.search = search;
  state.navigations = [];
  state.calls = [];
  state.refusals = [];
  state.version = 0;
  state.listeners.clear();
  state.sources = AsyncResult.success({ environmentId, sources, fetchedAt: at });
  state.rules = AsyncResult.success({ environmentId, rules, fetchedAt: at });
  setProfiles(profiles);
}

function setProfiles(list: readonly FactoryAgentProfile[]) {
  state.profiles = AsyncResult.success({
    profiles: list.map((profile) => ({ profile, tasksThisWeek: 12 })),
    fetchedAt: at,
  });
}

const publish = (change: () => void) =>
  act(() => {
    change();
    state.version++;
    state.listeners.forEach((listener) => listener());
  });

async function choose(field: string, option: string | RegExp) {
  await userEvent.click(page.getByRole("combobox", { name: field }));
  await userEvent.click(page.getByRole("option", { name: option }));
}

it("saves a new rule with the drawn fields, as a trial, and Auto-start saves it off", async () => {
  setup({ sheet: "rule" });
  await using screen = await render(<AutomationsPage />, { router: "/automations" });
  await userEvent.fill(page.getByLabelText("Name"), "Crashes");
  await userEvent.fill(page.getByLabelText("Labels"), "bug, crash, bug");
  await userEvent.fill(page.getByLabelText("Title contains"), " startup ");
  await choose("Type", "Bug");
  await choose("Assignee", "Implementer · Codex · Sol");
  await expect
    .element(page.getByText("In the last 30 days this would have matched 4 issues."))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Save rule" }));
  expect(state.calls).toEqual([
    {
      command: "saveIntakeRule",
      input: {
        commandId: expect.any(String),
        name: "Crashes",
        match: { sourceId: "github", labels: ["bug", "crash"], titleContains: "startup" },
        action: { type: "bug", assignment: { mode: "profile", profileId: "implementer" } },
        autonomy: "suggest",
        state: "trial",
      },
    },
  ]);
  expect(state.navigations.at(-1)).toEqual({
    to: "/automations",
    search: {},
    replace: true,
  });

  await publish(() => {
    state.search = { sheet: "rule" };
  });
  await userEvent.fill(page.getByLabelText("Name"), "Docs");
  await userEvent.click(page.getByRole("radio", { name: /^Auto-start/ }));
  const trial = page.getByRole("checkbox", { name: "Try once on the next match, then ask me" });
  await expect.element(trial).toBeDisabled();
  await expect.element(trial).not.toBeChecked();
  await expect
    .element(page.getByRole("dialog").getByText("Every start needs a person."))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Save rule" }));
  expect(state.calls[1]?.input).toMatchObject({ autonomy: "auto-start", state: "off" });

  await expect.element(screen.getByRole("switch", { name: "Docs label" })).toBeDisabled();
  await expect.element(screen.getByRole("switch", { name: "Bugs from GitHub" })).toBeEnabled();
});

it("says when each rule last fired", async () => {
  setup();
  using _clock = fakeTimers({ now: Date.parse(at) + 12 * 60_000 });
  await using screen = await render(<AutomationsPage />, { router: "/automations" });
  // Assert synchronously: expect.element polls on the timers this test fakes.
  const row = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`^When ${name}`) }).element().textContent;
  expect(row("Bugs from GitHub")).toContain("Fired 12m ago");
  expect(row("Feed items")).toContain("Try once");
  expect(row("Feed items")).toContain("Waiting for its first match");
  expect(row("Docs label")).toContain("Never fired");
});

it("saves a schedule's time, weekdays and task, and a source switch saves enabled", async () => {
  setup();
  await using screen = await render(<AutomationsPage />, { router: "/automations" });
  await userEvent.click(screen.getByRole("switch", { name: "GitHub issues" }));
  expect(state.calls[0]).toEqual({
    command: "saveIntakeSource",
    input: {
      commandId: expect.any(String),
      id: "github",
      expectedVersion: 0,
      projectId: "t3code-factory",
      config: { kind: "issues" },
      enabled: false,
    },
  });

  await userEvent.click(screen.getByRole("button", { name: "Add source" }));
  await choose("Kind", "Schedule");
  await choose("Project", "website");
  await userEvent.fill(page.getByLabelText("Time"), "07:30");
  await userEvent.click(page.getByRole("button", { name: "Mondays" }));
  await userEvent.click(page.getByRole("button", { name: "Fridays" }));
  await userEvent.click(page.getByRole("button", { name: "Wednesdays" }));
  await userEvent.fill(page.getByLabelText("Title"), "Weekly triage");
  await userEvent.fill(page.getByLabelText("Description"), "Sort the new issues.");
  await choose("Type", "Research");
  await choose("Assignee", "Scout · Codex · Luna");
  await choose("Status", "Ready");
  await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Add source" }));
  expect(state.calls[1]).toEqual({
    command: "saveIntakeSource",
    input: {
      commandId: expect.any(String),
      projectId: "website",
      config: {
        kind: "schedule",
        schedule: { timeOfDay: "07:30", weekdays: [3, 5] },
        task: {
          title: "Weekly triage",
          description: "Sort the new issues.",
          type: "research",
          assignment: { mode: "profile", profileId: "scout" },
          lane: "ready",
        },
      },
      enabled: true,
    },
  });
});

it("keeps an existing source in its project while allowing a new source to choose one", async () => {
  setup({ sheet: "source", id: "github" });
  await using screen = await render(<AutomationsPage />, { router: "/automations" });
  await expect.element(page.getByRole("combobox", { name: "Project" })).toBeDisabled();
  await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
  expect(state.calls[0]?.input).toMatchObject({ id: "github", projectId: "t3code-factory" });
  await userEvent.click(screen.getByRole("button", { name: "Add source", exact: true }));
  await expect.element(page.getByRole("combobox", { name: "Project" })).toBeEnabled();
  await choose("Project", "website");
  await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Add source" }));
  expect(state.calls[1]?.input).toMatchObject({ projectId: "website" });
});

it("saves a profile's setup and Used for, and reloads it after a version conflict", async () => {
  setup({ sheet: "profile", id: "implementer" });
  state.refusals = [
    AsyncResult.failure(
      Cause.fail(new FactoryTaskError({ reason: "version-conflict", currentVersion: 1 })),
    ),
  ];
  await using _screen = await render(<AutomationsPage />, { router: "/automations" });
  await expect.element(page.getByRole("heading", { name: "Implementer" })).toBeVisible();
  await choose("Effort", "High");
  await choose("Mode", "Full access");
  await userEvent.click(page.getByRole("checkbox", { name: "Docs" }));
  await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
  const setupInput = {
    modelSelection: {
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
  };
  expect(state.calls[0]?.input).toEqual({
    commandId: expect.any(String),
    id: "implementer",
    expectedVersion: 0,
    name: "Implementer",
    setup: { ...setupInput, workspace: "worktree" },
    handles: ["bug", "feature", "docs"],
  });
  await expect.element(page.getByText(/Loading the latest version/)).toBeVisible();
  expect(state.navigations).toEqual([]);

  await publish(() =>
    setProfiles(
      profiles.map((profile) =>
        profile.id === "implementer"
          ? {
              ...profile,
              name: "Builder",
              setup: { ...profile.setup, workspace: "root" },
              version: 1,
            }
          : profile,
      ),
    ),
  );
  await expect.element(page.getByText(/It now shows that version/)).toBeVisible();
  await expect.element(page.getByLabelText("Name")).toHaveValue("Builder");
  await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
  expect(state.calls[1]?.input).toEqual({
    commandId: expect.any(String),
    id: "implementer",
    expectedVersion: 1,
    name: "Builder",
    setup: { ...setupInput, workspace: "root" },
    handles: ["bug", "feature", "docs"],
  });
});

it("opens the profile the URL names and clears the search when the sheet closes", async () => {
  setup({ sheet: "profile", id: "scout" });
  await using _screen = await render(<AutomationsPage />, { router: "/automations" });
  await expect.element(page.getByRole("heading", { name: "Scout" })).toBeVisible();
  await expect.element(page.getByLabelText("Name")).toHaveValue("Scout");
  await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  expect(state.navigations).toEqual([{ to: "/automations", search: {}, replace: true }]);
  await expect.element(page.getByRole("heading", { name: "Scout" })).not.toBeInTheDocument();
});

it("shows a failed list as a failure, not as empty", async () => {
  setup();
  state.rules = AsyncResult.failure(
    Cause.fail(new FactoryIntakeError({ reason: "persistence-failure" })),
  );
  state.sources = AsyncResult.success({ environmentId, sources: [], fetchedAt: at });
  await using screen = await render(<AutomationsPage />, { router: "/automations" });
  await expect.element(screen.getByText(/Couldn't load rules/)).toBeVisible();
  await expect.element(screen.getByText(/Add a rule to decide/)).not.toBeInTheDocument();
  await expect.element(screen.getByText(/Add a source to bring in/)).toBeVisible();
});
