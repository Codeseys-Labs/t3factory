import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  list: null as unknown,
  detail: null as unknown,
  prerequisites: null as unknown,
  prerequisiteReads: 0,
  detailRevision: 0,
  detailPending: false,
  historyRevision: 0,
  navigations: [] as { search: Record<string, unknown> }[],
  environment: null as unknown,
  scope: null as unknown,
  environmentId: "",
  loading: false,
  readable: true,
  version: 0,
  targets: [] as string[],
  listeners: new Set<() => void>(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useSearch: (() => state.search) as never,
  useNavigate: (() => (options: { search: Record<string, unknown> }) => {
    state.navigations.push(options);
  }) as never,
}));
vi.mock(import("../../state/factory"), async () => {
  const { Atom } = await import("effect/reactivity");
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  };
  const permissionAtom = () => Atom.make(true);
  return {
    factoryEnvironment: {
      readWork: () => ({ kind: "detail" }),
      readWorkHistory: ({ input }: { input: unknown }) => ({ kind: "history", input }),
      readWorkPrerequisites: () => ({ kind: "prerequisites" }),
      start: { permissionAtom },
      admitFeedCandidate: { permissionAtom },
      startKnowledgeTask: { permissionAtom },
      launchResearchRun: { permissionAtom },
    },
    useFactoryWorkLists: (targets: unknown) => {
      state.targets.push(JSON.stringify(targets));
      useSyncExternalStore(subscribe, () => state.version);
      return {
        lists: [
          {
            environmentId: state.environmentId,
            result: state.loading ? AsyncResult.initial() : AsyncResult.success(state.list),
          },
        ],
        refresh: () => {},
      };
    },
  } as never;
});
vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: ((
    query: null | {
      kind: string;
      input?: { section: string; cursor?: string };
    },
  ) => {
    if (query?.kind === "prerequisites") {
      state.prerequisiteReads++;
      return { data: state.prerequisites, error: null, isPending: false };
    }
    return {
      data:
        query === null
          ? null
          : query.kind === "detail"
            ? {
                ...(state.detail as object),
                snapshot: state.detailRevision ? "Updated brief." : "Review this brief.",
              }
            : {
                entries: [
                  {
                    id: query.input?.cursor ? "attempt-second-page" : "history-first-page",
                    threadId: ThreadId.make("thread"),
                    runId: "run",
                    label: query.input?.cursor
                      ? state.historyRevision
                        ? "Updated second attempt page"
                        : "Second attempt page"
                      : "Retained execution",
                    state: "idle",
                    pin: null,
                    superseded: false,
                  },
                ],
                nextCursor: query.input?.cursor ? null : "next-history-page",
              },
      error: null,
      isPending: query?.kind === "detail" && state.detailPending,
      refresh: () => {
        if (query?.kind === "detail") {
          state.detailRevision++;
          state.detailPending = true;
        }
        if (query?.kind === "history") state.historyRevision++;
        state.version++;
        state.listeners.forEach((listener) => listener());
      },
    };
  }) as never,
}));
vi.mock(import("../../state/entities"), () => ({ useProjects: () => [] }));
vi.mock(import("../../state/environments"), () => ({
  useEnvironments: (() => ({ isReady: true, environments: [state.environment] })) as never,
}));
vi.mock(import("../../state/session"), () => ({
  useEnvironmentsWithScope: () =>
    new Set(state.readable ? [EnvironmentId.make(state.environmentId)] : []),
}));
vi.mock(import("../settings/SettingsScopeContext"), () => ({
  useSettingsScope: (() => ({
    scope: state.scope,
    groups: [
      {
        projectKey: "acme",
        memberProjects: [
          { environmentId: state.environmentId, id: "project", physicalProjectKey: "checkout" },
        ],
      },
    ],
  })) as never,
}));
vi.mock(import("./FactoryOverviewPage"), () => ({ FactoryOverviewPage: () => null }));
vi.mock(import("./FactoryPlanEditor"), () => ({ FactoryPlanEditor: () => <></> }));

import { act, render } from "../../../test/render";
import { FactoryWorkPage } from "./FactoryWorkPage";

const publish = (change: () => void) =>
  act(() => {
    change();
    state.version++;
    state.listeners.forEach((listener) => listener());
  });

function setup() {
  state.listeners.clear();
  state.version = 0;
  state.targets = [];
  state.navigations = [];
  state.prerequisiteReads = 0;
  state.detailRevision = 0;
  state.detailPending = false;
  state.historyRevision = 0;
  const environmentId = EnvironmentId.make("owner");
  const reference = { version: 1, environmentId, kind: "brief", id: "brief" };
  const item = {
    ref: reference,
    projectId: ProjectId.make("project"),
    title: "Selected brief",
    createdAt: "2026-11-01T00:00:00.000Z",
    sourceKey: null,
    sourceUrl: null,
    sourceState: null,
    revision: "brief-revision",
    supersededBy: null,
    originConflict: false,
    planningStage: null,
  };
  state.environmentId = environmentId;
  state.loading = false;
  state.readable = true;
  state.search = { work: JSON.stringify(reference) };
  state.environment = {
    environmentId,
    label: "Owner",
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        capabilities: { factoryWork: true, factoryWorkPrerequisites: true, factoryKnowledge: true },
      },
    },
  };
  state.scope = { kind: "global", environmentIds: [environmentId], members: [] };
  state.list = {
    environmentId,
    items: [item],
    nextCursor: "next-list-page",
    fetchedAt: item.createdAt,
  };
  state.detail = {
    item,
    reviewTarget: { kind: "brief", briefId: "brief" },
    snapshot: "Review this brief.",
    snapshotTruncated: false,
    projectAvailable: true,
    reviewProjectId: item.projectId,
    projectCoordinatorThreadId: null,
    supersedes: null,
    fetchedAt: item.createdAt,
  };
}

it("retains selected history through collection paging but removes protected detail on revocation", async () => {
  setup();
  await using screen = await render(<FactoryWorkPage />, { router: "/factory" });
  await userEvent.click(screen.getByRole("button", { name: "V2 runs", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Retry attempts", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Next history page", exact: true }));
  await expect.element(screen.getByText(/Second attempt page/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Refresh selected work", exact: true }));
  await expect.element(screen.getByText("Loading selected work…", { exact: true })).toBeVisible();
  await publish(() => {
    state.detailPending = false;
  });
  await expect.element(screen.getByText("Updated brief.", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/Updated second attempt page/)).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Previous history page", exact: true }))
    .toBeEnabled();

  await act(() => {
    state.loading = true;
    state.version++;
    state.listeners.forEach((listener) => listener());
  });
  await expect.element(screen.getByText(/Updated second attempt page/)).toBeVisible();
  await act(() => {
    state.loading = false;
    state.version++;
    state.listeners.forEach((listener) => listener());
  });
  await expect.element(screen.getByText(/Updated second attempt page/)).toBeVisible();

  await act(() => {
    state.readable = false;
    state.version++;
    state.listeners.forEach((listener) => listener());
  });
  await expect.element(screen.getByText(/Updated second attempt page/)).not.toBeInTheDocument();
  await expect.element(screen.getByText("Updated brief.")).not.toBeInTheDocument();
});

it("switches List, Table and Board over the same pages without clearing selection or detail", async () => {
  setup();
  state.search = { ...state.search, view: "list" };
  await using screen = await render(<FactoryWorkPage />, { router: "/factory" });
  await expect
    .element(screen.getByRole("heading", { name: "Selected work", exact: true }))
    .toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "V2 runs", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Retry attempts", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Next history page", exact: true }));
  await expect.element(screen.getByText(/Second attempt page/)).toBeVisible();

  for (const view of ["table", "board", "list"]) {
    await publish(() => {
      state.search = { ...state.search, view };
    });
    await expect.element(screen.getByText(/Second attempt page/)).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Selected brief", pressed: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Next page", exact: true }))
      .toBeEnabled();
    if (view === "board") {
      await expect
        .element(screen.getByRole("region", { name: "Authored brief, 1 loaded" }))
        .toBeVisible();
      await expect.element(screen.getByText(/Showing loaded pages only/)).toBeVisible();
    }
  }
  expect(new Set(state.targets).size).toBe(1);
});

it("reads prerequisites only when expanded, resets on selection change and returns from an off-filter link", async () => {
  setup();
  const environmentId = EnvironmentId.make(state.environmentId);
  const subject = JSON.stringify({ version: 1, environmentId, kind: "issue", id: "issue-root" });
  const blocker = { version: 1 as const, environmentId, kind: "issue" as const, id: "other-root" };
  const at = "2026-11-01T00:00:00.000Z";
  state.search = { project: "acme", view: "board", workGroup: "project", work: subject };
  state.scope = {
    kind: "project",
    environmentIds: [environmentId],
    members: [{ environmentId, id: ProjectId.make("project"), physicalProjectKey: "checkout" }],
  };
  state.prerequisites = {
    status: "observed",
    reviewProjectId: ProjectId.make("project"),
    repository: {
      provider: "github",
      host: "github.com",
      repository: "acme/app",
      canonicalKey: "github.com/acme/app",
      url: "https://github.com/acme/app",
    },
    issueNumber: 1,
    readiness: {
      status: "blocked",
      reasons: ["open-blocker"],
      basis: null,
      overrides: [],
      complete: true,
      listedCount: 1,
      summaryTotal: 1,
      observedAt: at,
    },
    prerequisites: [
      {
        edge: {
          targetId: 9,
          targetHost: "github.com",
          targetRepository: "acme/other",
          targetNumber: 9,
          targetUrl: "https://github.com/acme/other/issues/9",
          title: "Admitted elsewhere",
          state: "open",
          stateReason: null,
          closedAt: null,
          resolution: "open",
          status: "present",
          firstObservedAt: at,
          lastObservedAt: at,
          fingerprint: "edge",
          override: null,
        },
        link: { kind: "retained", ref: blocker, projectId: ProjectId.make("other-project") },
      },
    ],
    omittedCount: 0,
    fetchedAt: at,
  };
  await using screen = await render(<FactoryWorkPage />, { router: "/factory" });
  await expect.element(screen.getByText("Selected work", { exact: true })).toBeVisible();
  expect(state.prerequisiteReads).toBe(0);

  await userEvent.click(screen.getByRole("button", { name: "Show prerequisites", exact: true }));
  await expect
    .element(screen.getByRole("img", { name: /Diagram of 1 direct prerequisites/ }))
    .toBeVisible();
  expect(state.prerequisiteReads).toBeGreaterThan(0);
  await userEvent.click(
    screen.getByRole("button", { name: "Open retained Work (outside current filter)" }),
  );
  const opened = state.navigations.at(-1)?.search ?? {};
  expect(opened).toMatchObject({
    project: "acme",
    view: "board",
    workGroup: "project",
    work: JSON.stringify(blocker),
    workFrom: subject,
  });

  await publish(() => {
    state.search = opened;
  });
  await expect
    .element(screen.getByRole("button", { name: "Show prerequisites", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await expect
    .element(screen.getByRole("list", { name: "Direct prerequisites" }))
    .not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Open exact native review / start / resume" }),
  );
  expect(JSON.parse(String(state.navigations.at(-1)?.search.workReturn))).toMatchObject({
    work: JSON.stringify(blocker),
    workFrom: subject,
    view: "board",
  });
  await userEvent.click(screen.getByRole("button", { name: "Return to previous selection" }));
  expect(state.navigations.at(-1)?.search).toMatchObject({
    view: "board",
    workGroup: "project",
    work: subject,
    workFrom: undefined,
  });
});
