import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  type FactoryPlanApplyInput,
  type FactoryPlanSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  plan: null as FactoryPlanSnapshot | null,
  readFailure: null as Error | null,
  listFailure: null as Error | null,
  nextReadFailure: null as Error | null,
  nextListFailure: null as Error | null,
  readable: true,
  connected: true,
  sessionCurrent: true,
  version: 0,
  listeners: new Set<() => void>(),
  apply: vi.fn(),
}));

vi.mock(import("../../state/factory"), async () => {
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(true);
  const permissionAtom = () => permission;
  return {
    factoryEnvironment: {
      listPlans: () => "list",
      readPlan: () => "read",
      readPlanHistory: () => "history",
      createPlan: { key: "create", permissionAtom },
      applyPlan: { key: "apply", permissionAtom },
    },
  } as never;
});

vi.mock(import("../../state/query"), async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  };
  return {
    useEnvironmentQuery: ((key: string | null) => {
      useSyncExternalStore(subscribe, () => state.version);
      const failure =
        key === "read" ? state.readFailure : key === "list" ? state.listFailure : null;
      const plan = state.plan;
      return {
        data:
          key === "read"
            ? plan
            : key === "list" && plan
              ? {
                  items: [
                    {
                      ref: plan.ref,
                      revision: plan.revision,
                      title: "Root plan",
                      retired: false,
                      updatedAt: plan.updatedAt,
                    },
                  ],
                  nextRootId: null,
                }
              : key === "history"
                ? { items: [], nextBeforeRevision: null }
                : null,
        error: failure?.message ?? null,
        failure,
        dataUpdatedAt: 0,
        isPending: false,
        isSuccess: failure === null,
        refresh: () => {
          if (key === "read") state.readFailure = state.nextReadFailure;
          if (key === "list") state.listFailure = state.nextListFailure;
          state.version++;
          state.listeners.forEach((listener) => listener());
        },
      };
    }) as never,
  };
});

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => (input: unknown) => state.apply(input)) as never,
}));

vi.mock(import("../../state/entities"), () => ({
  useProjects: (() => [
    {
      environmentId: EnvironmentId.make("plan-owner"),
      id: ProjectId.make("plan-project"),
      title: "Plan checkout",
    },
  ]) as never,
  useThreadShellsForProjectRefs: () => [],
}));

vi.mock(import("../../state/environments"), async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  };
  return {
    useEnvironments: (() => {
      useSyncExternalStore(subscribe, () => state.version);
      return {
        isReady: true,
        environments: [
          {
            environmentId: EnvironmentId.make("plan-owner"),
            label: "Plan owner",
            connection: { phase: state.connected ? "connected" : "disconnected" },
            serverConfig: {
              environment: { capabilities: { factoryPlans: true, factoryWork: false } },
            },
          },
        ],
      };
    }) as never,
  };
});

vi.mock(import("../../state/session"), () => ({
  useEnvironmentScope: () => state.readable && state.connected && state.sessionCurrent,
  useEnvironmentSessionState: () => ({
    data: {
      authenticated: true,
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
        serverUiUrl: null,
      },
      permissions: state.readable ? [AuthOrchestrationReadScope] : [],
    },
    hasError: !state.connected || !state.sessionCurrent,
    isPending: false,
  }),
}));

vi.mock(import("../settings/SettingsScopeContext"), () => ({
  useSettingsScope: (() => ({
    scope: {
      kind: "checkout",
      environmentIds: [EnvironmentId.make("plan-owner")],
      members: [
        {
          environmentId: EnvironmentId.make("plan-owner"),
          id: ProjectId.make("plan-project"),
          physicalProjectKey: "plan-checkout",
        },
      ],
    },
    groups: [],
    selectScope: () => {},
  })) as never,
}));

import { act, render } from "../../../test/render";
import { FactoryPlanEditor } from "./FactoryPlanEditor";

function setup() {
  state.listeners.clear();
  state.version = 0;
  state.readFailure = null;
  state.listFailure = null;
  state.nextReadFailure = null;
  state.nextListFailure = null;
  state.readable = true;
  state.connected = true;
  state.sessionCurrent = true;
  state.apply.mockReset();
  state.apply.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Save response lost"))));
  state.plan = {
    ref: {
      environmentId: EnvironmentId.make("plan-owner"),
      projectId: ProjectId.make("plan-project"),
      rootId: "root-task",
    },
    revision: 1,
    tasks: [
      {
        id: "root-task",
        parentId: null,
        title: "Root plan",
        context: "Private root context",
        order: 0,
        retired: false,
      },
    ],
    edges: [],
    workContexts: [],
    editorThreadIds: [],
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

const publish = (change: () => void) =>
  act(() => {
    change();
    state.version++;
    state.listeners.forEach((listener) => listener());
  });

it.each(["read", "list"] as const)(
  "clears the uncertain request on an explicit %s authorization denial",
  async (kind) => {
    setup();
    await using screen = await render(<FactoryPlanEditor />, { router: "/factory" });
    await userEvent.click(
      screen.getByRole("button", { name: "Root plan · revision 1", exact: true }),
    );
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Title", exact: true }),
      "Revoked private draft",
    );
    await userEvent.click(screen.getByRole("button", { name: "Queue new task", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Apply queued edits", exact: true }));
    await expect
      .element(screen.getByRole("button", { name: "Retry same save", exact: true }))
      .toBeEnabled();

    const denied = new EnvironmentAuthorizationError({
      message: "Plan read access revoked",
      requiredScope: AuthOrchestrationReadScope,
    });
    await publish(() => {
      if (kind === "read") state.readFailure = denied;
      else state.listFailure = denied;
    });
    await expect
      .element(screen.getByText("Plan read access revoked", { exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("region", { name: "Plan editor", exact: true }))
      .not.toBeInTheDocument();
    await publish(() => {
      state.readFailure = null;
      state.listFailure = null;
    });
    await expect
      .element(screen.getByRole("button", { name: "Apply queued edits", exact: true }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Retry same save", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText(/Revoked private draft/)).not.toBeInTheDocument();
  },
);

it("retains queued edits and the uncertain save across read failures and reconnect, then clears them on read revocation", async () => {
  setup();
  await using screen = await render(<FactoryPlanEditor />, { router: "/factory" });
  await userEvent.click(
    screen.getByRole("button", { name: "Root plan · revision 1", exact: true }),
  );
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Title", exact: true }),
    "Retained child task",
  );
  await userEvent.click(screen.getByRole("button", { name: "Queue new task", exact: true }));
  await expect.element(screen.getByText("Queued edits (1/128)", { exact: true })).toBeVisible();

  state.nextReadFailure = new Error("Temporary plan read failure");
  await userEvent.click(screen.getByRole("button", { name: "Read current revision", exact: true }));
  await expect
    .element(screen.getByText("Temporary plan read failure", { exact: true }))
    .toBeVisible();
  await publish(() => {
    state.readFailure = null;
    state.nextReadFailure = null;
  });
  await expect.element(screen.getByText("Queued edits (1/128)", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/Add Retained child task under Root plan/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Apply queued edits", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Retry same save", exact: true }))
    .toBeEnabled();
  const first = state.apply.mock.calls[0]?.[0] as {
    environmentId: EnvironmentId;
    input: FactoryPlanApplyInput;
  };
  const originalInput = structuredClone(first.input);
  expect(originalInput.expectedRevision).toBe(1);
  expect(first.input.operations).toHaveLength(1);
  expect(first.input.operations[0]).toMatchObject({
    type: "task.add",
    title: "Retained child task",
    parentId: "root-task",
  });

  state.nextReadFailure = new Error("Read failed after uncertain save");
  await userEvent.click(screen.getByRole("button", { name: "Read current revision", exact: true }));
  await expect
    .element(screen.getByText("Read failed after uncertain save", { exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Retry same save", exact: true }))
    .toBeDisabled();
  await publish(() => {
    state.readFailure = null;
    state.nextReadFailure = null;
    state.plan = { ...state.plan!, revision: 2 };
  });
  await expect
    .element(screen.getByText(/Current revision is 2. Your draft still targets revision 1/))
    .toBeVisible();
  await expect
    .element(
      screen.getByRole("button", { name: "Rebase queued edits onto revision 2", exact: true }),
    )
    .toBeDisabled();

  state.nextListFailure = new Error("Temporary plan list failure");
  await userEvent.click(screen.getByRole("button", { name: "Refresh plans", exact: true }));
  await expect
    .element(screen.getByText("Temporary plan list failure", { exact: true }))
    .toBeVisible();
  await publish(() => {
    state.listFailure = null;
    state.nextListFailure = null;
  });
  await expect
    .element(screen.getByRole("button", { name: "Retry same save", exact: true }))
    .toBeEnabled();

  await publish(() => {
    state.connected = false;
    state.sessionCurrent = false;
  });
  await expect
    .element(screen.getByText("Reconnect this environment to read plans.", { exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Plan editor", exact: true, includeHidden: true }))
    .not.toBeVisible();
  await expect.element(screen.getByText(/Retained child task/)).not.toBeVisible();
  await publish(() => {
    state.connected = true;
  });
  await expect
    .element(screen.getByText("Waiting for read access to be verified…", { exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Plan editor", exact: true, includeHidden: true }))
    .not.toBeVisible();
  await publish(() => {
    state.sessionCurrent = true;
  });
  await expect
    .element(screen.getByRole("button", { name: "Retry same save", exact: true }))
    .toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Retry same save", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Retry same save", exact: true }))
    .toBeEnabled();
  expect(state.apply.mock.calls).toHaveLength(2);
  const retry = state.apply.mock.calls[1]?.[0] as typeof first;
  expect(retry.input).toBe(first.input);
  expect(retry.input.commandId).toBe(first.input.commandId);
  expect(retry.input).toEqual(originalInput);

  await publish(() => {
    state.readable = false;
  });
  await expect
    .element(screen.getByText("Read access is required to view plans.", { exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Plan editor", exact: true }))
    .not.toBeInTheDocument();
  await publish(() => {
    state.readable = true;
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Root plan · revision 2", exact: true }),
  );
  await expect
    .element(screen.getByText("Queued edits (1/128)", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Retry same save", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Apply queued edits", exact: true }))
    .toBeDisabled();
});
