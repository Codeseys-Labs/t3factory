import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import type { FactoryTaskListTarget } from "@t3tools/client-runtime/state/factory-task-list";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useUiStateStore } from "../../uiStateStore";
import { useNeedsYou } from "../tasks/shared/taskScope";

const state = vi.hoisted(() => ({
  status: "ready" as "ready" | "backlog",
  incomplete: false,
  targets: [] as readonly FactoryTaskListTarget[],
}));

vi.mock(import("../../hooks/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: () => [],
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useAllEnvironmentProjectSnapshotsReady: () => true,
}));
vi.mock(import("../../state/environments"), async (original) => {
  const actual = await original();
  const { FACTORY_TASK_FIXTURES: fixtures } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  return {
    ...actual,
    useEnvironmentIdentities: (() => [{ environmentId: fixtures.environmentId }]) as never,
  };
});
vi.mock(import("../../state/projects"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentProjects: {
      ...actual.environmentProjects,
      projectConfigsReadyAtom: Atom.make(true),
    },
  };
});
vi.mock(import("../../state/factoryTasks"), async (original) => {
  const actual = await original();
  const { FACTORY_TASK_FIXTURES: fixtures } =
    await import("@t3tools/client-runtime/state/factory-task-fixtures");
  return {
    ...actual,
    useFactoryTasks: ((targets: readonly FactoryTaskListTarget[]) => {
      state.targets = targets;
      const task = fixtures.tasks.find((task) => task.displayId === "T-42")!;
      return {
        items: [
          {
            stale: false,
            task: {
              ...task,
              status: state.status,
              lane: state.status,
              attention: [
                {
                  reason: "plan",
                  taskId: task.ref.taskId,
                  displayId: task.displayId,
                  detail: "Plan ready",
                },
              ],
            },
          },
        ],
        more: [],
        incomplete: state.incomplete,
        loadMore: () => {},
      };
    }) as never,
  };
});

function Needs() {
  const { needs, incomplete } = useNeedsYou();
  return (
    <output>
      {needs.count} {needs.rows[0]?.reason} {incomplete ? "partial" : "complete"}
    </output>
  );
}

describe("Needs-you scope", () => {
  it.each(["ready", "backlog"] as const)(
    "includes a %s task waiting on a plan without a status filter",
    async (status) => {
      state.status = status;
      state.incomplete = false;
      state.targets = [];
      useUiStateStore.getState().setSidebarProjectScopeKeys([]);
      await using screen = await render(<Needs />);
      await expect.element(screen.getByRole("status")).toHaveTextContent("1 plan complete");
      expect(state.targets).toEqual([
        {
          environmentId: FACTORY_TASK_FIXTURES.environmentId,
          input: { scope: "all", attention: true },
        },
      ]);
    },
  );

  it("keeps a short list's count incomplete", async () => {
    state.status = "ready";
    state.incomplete = true;
    state.targets = [];
    useUiStateStore.getState().setSidebarProjectScopeKeys([]);
    await using screen = await render(<Needs />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("1 plan partial");
  });
});
