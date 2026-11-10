import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import { resolveFactoryTaskLiveState } from "@t3tools/client-runtime/state/factory-task-view";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

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
}));

const { TasksListBody } = await import("./TasksList");
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
