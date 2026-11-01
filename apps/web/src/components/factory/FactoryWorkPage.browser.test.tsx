import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  list: null as unknown,
  detail: null as unknown,
  environment: null as unknown,
  scope: null as unknown,
  environmentId: "",
  loading: false,
  readable: true,
  version: 0,
  listeners: new Set<() => void>(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useSearch: (() => state.search) as never,
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
      start: { permissionAtom },
      admitFeedCandidate: { permissionAtom },
      startKnowledgeTask: { permissionAtom },
      launchResearchRun: { permissionAtom },
    },
    useFactoryWorkLists: () => {
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
  ) => ({
    data:
      query === null
        ? null
        : query.kind === "detail"
          ? state.detail
          : {
              entries: [
                {
                  id: query.input?.cursor ? "attempt-second-page" : "history-first-page",
                  threadId: ThreadId.make("thread"),
                  runId: "run",
                  label: query.input?.cursor ? "Second attempt page" : "Retained execution",
                  state: "idle",
                  pin: null,
                  superseded: false,
                },
              ],
              nextCursor: query.input?.cursor ? null : "next-history-page",
            },
    error: null,
    isPending: false,
  })) as never,
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
  useSettingsScope: (() => ({ scope: state.scope, groups: [] })) as never,
}));
vi.mock(import("./FactoryOverviewPage"), () => ({ FactoryOverviewPage: () => null }));

import { act, render } from "../../../test/render";
import { FactoryWorkPage } from "./FactoryWorkPage";

function setup() {
  state.listeners.clear();
  state.version = 0;
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
    serverConfig: { environment: { capabilities: { factoryWork: true, factoryKnowledge: true } } },
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

  await act(() => {
    state.loading = true;
    state.version++;
    state.listeners.forEach((listener) => listener());
  });
  await expect.element(screen.getByText(/Second attempt page/)).toBeVisible();
  await act(() => {
    state.loading = false;
    state.version++;
    state.listeners.forEach((listener) => listener());
  });
  await expect.element(screen.getByText(/Second attempt page/)).toBeVisible();

  await act(() => {
    state.readable = false;
    state.version++;
    state.listeners.forEach((listener) => listener());
  });
  await expect.element(screen.getByText(/Second attempt page/)).not.toBeInTheDocument();
  await expect.element(screen.getByText("Review this brief.")).not.toBeInTheDocument();
});
