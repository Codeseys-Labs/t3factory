import * as NodeModule from "node:module";
import type { NavigationState } from "@react-navigation/native";
import { EnvironmentId, ProjectId, type FactoryWorkReadResult } from "@t3tools/contracts";
import { act, useState, type Context, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

type RouterAction = Parameters<ReturnType<typeof StackRouter>["getStateForAction"]>[1];

const harness = vi.hoisted(() => ({
  routeContext: null as Context<NavigationState["routes"][number] | null> | null,
  state: null as NavigationState | null,
  dispatch: (_action: RouterAction) => {},
  section: "work" as "work" | "issues",
  pending: null as { work: string; returnTo?: { work: string } } | null,
}));

vi.mock("@react-navigation/native", async () => {
  const { createContext, use } = await import("react");
  const routeContext = createContext<NavigationState["routes"][number] | null>(null);
  harness.routeContext = routeContext;
  const { createRequire } = await import("node:module");
  const requireNavigation = createRequire(
    createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  const { StackActions } = requireNavigation("@react-navigation/routers");
  return {
    StackActions,
    useNavigation: () => ({
      getState: () => harness.state,
      dispatch: harness.dispatch,
      goBack: () => harness.dispatch({ type: "GO_BACK" }),
      push: (name: string, params: object) => harness.dispatch(StackActions.push(name, params)),
    }),
    useRoute: () => use(routeContext),
    usePreventRemove: () => {},
  };
});
vi.mock("@effect/atom-react", async () => {
  const { createContext } = await import("react");
  return { RegistryContext: createContext({ refresh: vi.fn() }), useAtomValue: () => false };
});
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Linking: { openURL: vi.fn() },
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui/SegmentedControl", () => ({ SegmentedControl: () => null }));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => (
    <div data-native-scroll>{children}</div>
  ),
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../settings/SettingsScheduledTasksRouteScreen", () => ({
  FactoryScheduledTasksScreen: () => null,
}));
vi.mock("./FactoryBriefsRouteScreen", () => ({ FactoryBriefsRouteScreen: () => null }));
vi.mock("./FactoryIssuesRouteScreen", () => ({ FactoryIssuesRouteScreen: () => null }));
vi.mock("./FactoryOrchestratorPanel", () => ({ FactoryOrchestratorPanel: () => null }));
vi.mock("./FactoryWorkSection", () => ({
  FACTORY_LARGE_TEXT_SCALE: 1.3,
  FactoryWorkSection: () => null,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    {
      environmentId: "owner",
      id: "project",
      title: "Project",
      workspaceRoot: "/project",
      isScratch: false,
    },
  ],
  useThreadShells: () => [],
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    environments: [
      {
        environmentId: "owner",
        label: "Owner",
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: { factoryWork: true, factoryIssues: true } } },
      },
    ],
  }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/factory", () => ({
  factoryEnvironment: {
    readWork: (input: object) => ({ type: "detail", ...input }),
    readWorkHistory: () => ({ type: "history" }),
    start: { permissionAtom: () => null },
    startKnowledgeTask: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { type: string; input?: { ref: { id: string } } } | null) => ({
    data:
      query?.type === "detail"
        ? detail(query.input?.ref.id ?? "A")
        : { entries: [], nextCursor: null },
    error: null,
    failure: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("./useFactoryIssueActions", () => ({ useOpenFactoryThread: () => vi.fn() }));
vi.mock("./factoryIssues", () => ({ safeFactoryIssueUrl: () => null }));
vi.mock("./factory-inbox-state", () => ({
  useFactoryInboxSelection: () => ({
    environmentId: "owner",
    projectId: "project",
    section: harness.section,
    workReturn: harness.pending,
    taskId: null,
  }),
  useFactoryWorkView: () => ({ kind: "issue" }),
  factoryWorkHistoryFor: (_view: unknown, work: string) => ({
    work,
    selection: { section: "executions" },
    cursors: [],
  }),
  openFactoryWorkReview: (target: { work: string; returnTo?: { work: string } }) => {
    harness.pending = {
      work: target.work,
      ...(target.returnTo ? { returnTo: target.returnTo } : {}),
    };
    harness.section = "issues";
  },
  returnToFactoryWork: () => {
    const pending = harness.pending;
    harness.pending = null;
    harness.section = "work";
    return pending;
  },
  consumeFactoryWorkflowTarget: vi.fn(),
  selectFactoryScope: vi.fn(),
  selectFactorySection: vi.fn(),
  updateFactoryInboxSelection: vi.fn(),
  moveFactoryWorkHistoryPage: vi.fn(),
  selectFactoryWorkHistory: vi.fn(),
  selectFactoryWorkItem: vi.fn(),
}));
vi.mock("./FactoryWorkPrerequisites", () => ({
  FactoryWorkPrerequisites: function Probe() {
    const [expanded, setExpanded] = useState(false);
    const [page, setPage] = useState(0);
    return (
      <div>
        <button onClick={() => setExpanded(true)}>Show prerequisites</button>
        {expanded ? (
          <>
            <span>Prerequisites page {page}</span>
            <button onClick={() => setPage((current) => current + 1)}>Next prerequisites</button>
          </>
        ) : null}
      </div>
    );
  },
}));

import { FactoryRouteScreen } from "./FactoryRouteScreen";
import { FactoryWorkDetailRouteScreen } from "./FactoryWorkDetailRouteScreen";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, StackActions } = requireNavigation("@react-navigation/routers") as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  StackActions: typeof import("@react-navigation/native").StackActions;
};

function detail(id: string): FactoryWorkReadResult {
  return {
    item: {
      ref: { version: 1, environmentId: EnvironmentId.make("owner"), kind: "issue", id },
      projectId: ProjectId.make("project"),
      title: id,
      createdAt: "2026-11-05T12:00:00Z",
      sourceKey: null,
      sourceUrl: null,
      sourceState: "open",
      revision: null,
      supersededBy: null,
      originConflict: false,
      planningStage: null,
    },
    reviewTarget: { kind: "issue", issueNumber: id === "A" ? 1 : 2 },
    snapshot: "Read-only fixture",
    snapshotTruncated: false,
    projectAvailable: true,
    reviewProjectId: ProjectId.make("project"),
    projectCoordinatorThreadId: null,
    supersedes: null,
    fetchedAt: "2026-11-05T12:00:00Z",
  };
}

it("keeps mounted prerequisite context through native review and returns through the same detail routes", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.section = "work";
  harness.pending = null;
  const router = StackRouter({});
  const options = {
    routeNames: ["SettingsFactoryIssues", "SettingsFactoryWork"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = router.getInitialState(options);
  const dispatch = (action: RouterAction) => {
    const next = router.getStateForAction(state, action, options);
    if (!next) throw new Error(`Rejected ${action.type}`);
    state = router.getRehydratedState(next, options);
    harness.state = state;
  };
  const a = { work: JSON.stringify(detail("A").item.ref) };
  const b = { work: JSON.stringify(detail("B").item.ref), returnTo: a };
  dispatch(StackActions.push("SettingsFactoryWork", a));
  dispatch(StackActions.push("SettingsFactoryWork", b));
  const [origin, routeA, routeB] = state.routes;
  const container = document.createElement("div");
  const root = createRoot(container);
  onTestFinished(() => act(() => root.unmount()));
  const RouteContext = harness.routeContext!;
  function Route({ route }: { route: (typeof state.routes)[number] }) {
    return (
      <RouteContext value={route}>
        <div data-route={route.key}>
          {route.name === "SettingsFactoryWork" ? (
            <FactoryWorkDetailRouteScreen />
          ) : (
            <FactoryRouteScreen />
          )}
        </div>
      </RouteContext>
    );
  }
  const render = () =>
    act(() =>
      root.render(
        <>
          {state.routes.map((route) => (
            <Route key={route.key} route={route} />
          ))}
        </>,
      ),
    );
  harness.dispatch = (action) => {
    dispatch(action);
    render();
  };
  render();
  const routeElement = (key: string) => {
    const element = container.querySelector(`[data-route="${key}"]`);
    if (!(element instanceof HTMLDivElement)) throw new Error(`Missing route ${key}`);
    return element;
  };
  const press = (element: Element, label: string) => {
    const button = Array.from(element.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === label,
    );
    if (!button) throw new Error(`Missing button ${label}`);
    act(() => button.click());
  };
  const mountedA = routeElement(routeA!.key);
  const mountedB = routeElement(routeB!.key);
  press(mountedA, "Show prerequisites");
  press(mountedA, "Next prerequisites");
  const scroll = mountedA.querySelector("[data-native-scroll]")!;
  scroll.scrollTop = 240;
  press(mountedB, "Find #2 in Issues");
  expect(state.routes.map((route) => route.name)).toEqual([
    "SettingsFactoryIssues",
    "SettingsFactoryWork",
    "SettingsFactoryWork",
    "SettingsFactoryIssues",
  ]);
  expect(state.routes.slice(0, 3)).toEqual([origin, routeA, routeB]);
  expect(routeElement(routeA!.key)).toBe(mountedA);
  expect(routeElement(routeB!.key)).toBe(mountedB);
  expect(mountedA.textContent).toContain("Prerequisites page 1");
  expect(scroll.scrollTop).toBe(240);
  press(routeElement(state.routes.at(-1)!.key), "Back to Work");
  expect(state.routes.map((route) => route.key)).toEqual([origin!.key, routeA!.key, routeB!.key]);
  expect(state.routes.at(-1)?.params).toEqual(b);
  expect(routeElement(routeB!.key)).toBe(mountedB);
  press(mountedB, "Return to previous selection");
  expect(state.routes.map((route) => route.key)).toEqual([origin!.key, routeA!.key]);
  expect(state.routes.at(-1)?.params).toEqual(a);
  expect(routeElement(routeA!.key)).toBe(mountedA);
  expect(mountedA.textContent).toContain("Prerequisites page 1");
  expect(scroll.scrollTop).toBe(240);
});
