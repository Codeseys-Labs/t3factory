import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import { resolveFactoryTaskLiveState } from "@t3tools/client-runtime/state/factory-task-view";
import { EnvironmentId } from "@t3tools/contracts";
import type {
  FactoryTaskListTarget,
  FactoryTaskOwnerStatus,
} from "@t3tools/client-runtime/state/factory-task-list";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const dataMocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RefreshControl: () => null,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: {
    data: readonly unknown[];
    renderItem: (info: { item: unknown }) => ReactNode;
    ListEmptyComponent?: ReactNode;
    ListHeaderComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.length === 0 ? props.ListEmptyComponent : null}
      {props.data.map((item) => (
        <div key={(item as { key: string }).key}>{props.renderItem({ item })}</div>
      ))}
    </div>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: {},
  useNavigation: () => ({}),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: (props: { accessibilityLabel?: string }) => (
    <div role="progressbar" aria-label={props.accessibilityLabel} />
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: {
    title: string;
    detail: string;
    actionLabel?: string;
    onAction?: () => void;
  }) => (
    <section>
      <h2>{props.title}</h2>
      <p>{props.detail}</p>
      {props.actionLabel ? <button onClick={props.onAction}>{props.actionLabel}</button> : null}
    </section>
  ),
}));
vi.mock("../../state/factoryTasks", () => ({
  useFactoryTaskDetail: () => AsyncResult.initial(),
  useFactoryTasks: dataMocks.list,
  useFactoryTaskEntries: (summaries: typeof FACTORY_TASK_FIXTURES.tasks) =>
    summaries.map((task) => ({
      task,
      live: resolveFactoryTaskLiveState(task, FACTORY_TASK_FIXTURES.threadFacts),
    })),
  useFactoryTaskCatalogs: () => new Map(),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: FACTORY_TASK_FIXTURES.environmentId, label: "Test" }],
  }),
}));
vi.mock("../../lib/clock", () => ({
  useNowMinuteMs: () => Date.parse(FACTORY_TASK_FIXTURES.at),
}));

const { TasksListBody } = await import("./TasksList");
const { useTasksData } = await import("./useTasksData");
const { buildTasksListItems, buildTasksSections, resolveTasksListState, tasksListNotices } =
  await import("./taskPresentation");

const { tasks, threadFacts, at } = FACTORY_TASK_FIXTURES;
const sections = buildTasksSections(
  tasks.map((task) => ({ task, live: resolveFactoryTaskLiveState(task, threadFacts) })),
  Date.parse(at),
);

const empty = { ...sections, needs: [], blocking: [], review: [], groups: [], count: 0 };

async function render(
  statuses: readonly Parameters<typeof resolveTasksListState>[0]["owners"][number]["status"][],
  content: typeof sections = empty,
  onRefresh = vi.fn(),
  incomplete = false,
) {
  const owners = statuses.map((status, index) => ({
    environmentId: EnvironmentId.make(`environment-${index}`),
    status,
  }));
  const state = resolveTasksListState({
    owners,
    rowCount: content.needs.length + content.groups.length,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <TasksListBody
        items={buildTasksListItems(content)}
        notices={tasksListNotices(state, String)}
        state={state}
        refreshing={false}
        incomplete={incomplete}
        onRefresh={onRefresh}
        labelsFor={(task) => ({
          projectLabel: task.ref.projectId,
          assigneeLabel: "Codex · Sol",
          assigneeMonogram: "Cx",
        })}
        onOpen={() => {}}
      />,
    ),
  );
  onTestFinished(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, onRefresh };
}

describe("TasksListBody", () => {
  it.each([
    [[], "No environments"],
    [["offline"], "Offline"],
    [["forbidden"], "No access"],
    [["unsupported"], "Update the server"],
    [["failed"], "Couldn't load tasks"],
    [["current"], "All caught up"],
  ] as const)("owners %j read as %s", async (statuses, title) => {
    const { host } = await render(statuses);
    expect(host.querySelector("h2")?.textContent).toBe(title);
  });

  it("never reads a failed or offline environment as all caught up", async () => {
    for (const statuses of [["failed"], ["offline", "failed"], ["forbidden"]] as const) {
      const { host } = await render(statuses);
      expect(host.textContent).not.toContain("All caught up");
    }
    const partial = await render(["current"], empty, vi.fn(), true);
    expect(partial.host.textContent).not.toContain("All caught up");
    expect(partial.host.textContent).toContain("More tasks may be waiting on you.");
  });

  it("shows a spinner while loading and no empty message", async () => {
    const { host } = await render(["loading"]);
    expect(host.querySelector("[role=progressbar]")?.getAttribute("aria-label")).toBe(
      "Loading tasks",
    );
    expect(host.querySelector("h2")).toBeNull();
  });

  it("offers Try again after a failed read", async () => {
    const { host, onRefresh } = await render(["failed"]);
    await act(async () => {
      host.querySelector("button")!.click();
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("lists the asks and names an environment that could not be read", async () => {
    const { host } = await render(["current", "offline"], sections);
    expect(host.querySelector("h2")).toBeNull();
    expect(host.textContent).toContain("environment-1 is offline");
    expect(host.textContent).toContain("Needs you · 5");
    expect(host.textContent).toContain("Move the list API to tasks");
    expect(host.textContent).toContain("Awaiting Input");
  });
});

function setupData(
  options: {
    attentionIncomplete?: boolean;
    workIncomplete?: boolean;
    status?: FactoryTaskOwnerStatus;
  } = {},
) {
  dataMocks.list.mockReset();
  const backlog = tasks.find((task) => task.displayId === "T-43")!;
  const plan = {
    ...backlog,
    attention: [
      {
        taskId: backlog.ref.taskId,
        displayId: backlog.displayId,
        reason: "plan" as const,
        detail: "Plan ready",
      },
    ],
  };
  const review = tasks.find((task) => task.displayId === "T-36")!;
  const source = [
    tasks.find((task) => task.displayId === "T-41")!,
    ...Array.from({ length: 501 }, (_, index) => ({
      ...backlog,
      ref: { ...backlog.ref, taskId: `ready-${index}` },
      status: "ready" as const,
    })),
    ...Array.from({ length: 60 }, (_, index) => ({
      ...review,
      ref: { ...review.ref, taskId: `review-${index}` },
      attention: [
        { ...review.attention[0]!, taskId: `review-${index}`, displayId: `T-${100 + index}` },
      ],
    })),
    tasks.find((task) => task.displayId === "T-39")!,
    plan,
  ];
  dataMocks.list.mockImplementation(
    (targets: readonly FactoryTaskListTarget[], paging?: { loadAll?: boolean }) => {
      const filter = targets[0]?.input;
      const matching = filter
        ? source.filter(
            (task) =>
              (!filter.statuses || filter.statuses.includes(task.status)) &&
              (!filter.attention || task.attention.length > 0 || task.liveRuns.length > 0),
          )
        : [];
      const items = matching.slice(0, paging?.loadAll ? 500 : 50);
      const status = options.status ?? "current";
      return {
        items: items.map((task) => ({ task, stale: status !== "current" })),
        owners: targets.map(({ environmentId }) => ({ environmentId, status, pages: [{ items }] })),
        incomplete:
          matching.length > items.length ||
          (filter?.attention ? options.attentionIncomplete : options.workIncomplete) === true,
        refresh: () => {
          options.status = "loading";
        },
      };
    },
  );
}

async function renderData() {
  let data: ReturnType<typeof useTasksData> | undefined;
  function Probe() {
    const current = useTasksData();
    useLayoutEffect(() => {
      data = current;
    });
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  onTestFinished(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return {
    read: () => data!,
    rerender: () => act(async () => root.render(<Probe />)),
  };
}

describe("useTasksData", () => {
  it("finds old approvals and backlog plans beyond 500 newer ready tasks", async () => {
    setupData();
    const { read } = await renderData();
    const needs = read().sections.needs.map((row) => [row.need.displayId, row.need.reason]);
    expect(needs).toContainEqual(["T-39", "approve"]);
    expect(needs).toContainEqual(["T-43", "plan"]);
    expect(needs).toHaveLength(62);
    expect(
      read().sections.groups.flatMap((group) => group.rows.map((row) => row.task.displayId)),
    ).toEqual(["T-41"]);
  });

  it.each([
    [true, false, true, true],
    [false, true, true, false],
    [false, false, false, false],
  ])(
    "keeps attention and work completeness separate (%s, %s)",
    async (attentionIncomplete, workIncomplete, incomplete, needsIncomplete) => {
      setupData({ attentionIncomplete, workIncomplete });
      const { read } = await renderData();
      expect(read()).toMatchObject({ incomplete, needsIncomplete });
    },
  );

  it("keeps the pull-to-refresh spinner off during background updates", async () => {
    setupData({ status: "loading" });
    const { read } = await renderData();
    expect(read().refreshing).toBe(false);
  });

  it("shows refresh only for a pull and resets it before the next background update", async () => {
    const options = { status: "current" as FactoryTaskOwnerStatus };
    setupData(options);
    const { read, rerender } = await renderData();
    await act(async () => read().refresh());
    expect(read().refreshing).toBe(true);
    options.status = "current";
    await rerender();
    expect(read().refreshing).toBe(false);
    options.status = "loading";
    await rerender();
    expect(read().refreshing).toBe(false);
  });
});
