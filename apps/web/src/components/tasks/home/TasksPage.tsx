import { useAtomValue } from "@effect/atom-react";
import type { FactoryTaskListTarget } from "@t3tools/client-runtime/state/factory-task-list";
import type { FactoryTaskViewState } from "@t3tools/client-runtime/state/factory-task-url";
import { factoryTaskKey } from "@t3tools/client-runtime/state/factory-task-view";
import {
  type FactoryTaskCountInput,
  type FactoryTaskRef,
  FactoryTaskStatus,
  type FactoryTaskSummary,
} from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CommandIcon, PlusIcon, ZapIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { shortcutLabelForCommand } from "../../../keybindings";
import { useFactoryTasks } from "../../../state/factoryTasks";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { Button } from "../../ui/button";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { PageHeader, TaskEmptyState } from "../kit";
import { useTaskActions } from "../shared";
import { useTaskScope } from "../shared/taskScope";
import { openNewTask, openTaskSetup } from "../taskDialogs";
import { TaskPageFrame } from "../TaskPageFrame";
import { tasksSearch, tasksViewState } from "../taskRoutes";
import { NeedsYouStrip } from "./NeedsYouStrip";
import { OwnerNotices } from "./OwnerNotices";
import { TaskBoard } from "./TaskBoard";
import { TaskList } from "./TaskList";
import { TaskPeek } from "./TaskPeek";
import { type AssigneeOption, TasksToolbar } from "./TasksToolbar";
import {
  activeFilterCount,
  boardStatuses,
  countShownTasks,
  toggleTaskFilter,
} from "./tasksHome.logic";

type TaskList = ReturnType<typeof useFactoryTasks>;

/** The person's filters as the server takes them. The project is the sidebar's scope, not a filter. */
function serverFilters(filters: FactoryTaskCountInput): FactoryTaskCountInput {
  const { projectIds: _projectIds, scope: _scope, attention: _attention, ...rest } = filters;
  return rest;
}

const withFilters = (
  targets: readonly FactoryTaskListTarget[],
  filters: FactoryTaskCountInput,
  scope: "roots" | "all",
): readonly FactoryTaskListTarget[] =>
  targets.map((target) => ({
    environmentId: target.environmentId,
    input: { ...target.input, ...filters, ...(scope === "all" ? { scope } : {}) },
  }));

function ownerStates(list: TaskList) {
  return list.owners.map((owner) => ({
    environmentId: owner.environmentId,
    status: owner.status,
    hasTasks: owner.pages.some((page) => page.items.length > 0),
  }));
}

export function TasksPage() {
  const search = useSearch({ from: "/_chat/tasks/" });
  const navigate = useNavigate();
  const view = tasksViewState(search);
  const scope = useTaskScope();
  const actions = useTaskActions();
  const filters = serverFilters(view.filters);
  const statuses = boardStatuses(filters);
  const roots = useFactoryTasks(withFilters(scope.targets, filters, "roots"));
  const [filterOpen, setFilterOpen] = useState(false);
  const assigneeTasks = useFactoryTasks(
    filterOpen ? withFilters(scope.targets, { statuses: FactoryTaskStatus.literals }, "all") : [],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loads the scoped task cursor pages so assignee choices include sub-tasks and survive view filters.
  useEffect(() => {
    for (const owner of assigneeTasks.more)
      if (owner.available) assigneeTasks.loadMore(owner.environmentId);
  }, [assigneeTasks]);
  const [stripOpen, setStripOpen] = useState({ board: true, list: false });

  const projectNames = new Map(
    scope.projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (ref) => [`${ref.environmentId}\u0000${ref.projectId}`, project.displayName] as const,
      ),
    ),
  );
  const projectName = (task: FactoryTaskSummary) =>
    projectNames.get(`${task.ref.environmentId}\u0000${task.ref.projectId}`) ??
    String(task.ref.projectId);
  const showProject = scope.projects.length !== 1;

  const setView = (change: Partial<FactoryTaskViewState>, replace = false) =>
    void navigate({ to: "/tasks", search: tasksSearch({ ...view, ...change }), replace });
  const peek = (ref: FactoryTaskRef) => setView({ peek: ref }, true);
  const closePeek = () => setView({ peek: null }, true);
  const open = (task: FactoryTaskSummary) =>
    void navigate({
      to: "/tasks/$environmentId/$displayId",
      params: { environmentId: task.ref.environmentId, displayId: task.displayId },
    });
  const newTask = (lane?: "backlog" | "ready") =>
    openNewTask({ ...scope.single, ...(lane ? { lane } : {}) });
  const peekTask = (task: FactoryTaskSummary) => peek(task.ref);

  const filtered = activeFilterCount(filters) > 0;
  const allCounted = roots.owners.every((owner) => owner.countsStatus === "current");
  const total = (Object.values(roots.byStatus) as number[]).reduce((sum, count) => sum + count, 0);
  const settled = roots.owners.every((owner) => owner.status === "current");
  const empty = !filtered && settled && allCounted && total === 0 && roots.items.length === 0;
  const waiting =
    roots.items.length === 0 &&
    roots.owners.length > 0 &&
    roots.owners.every((owner) => owner.status === "loading");

  if (empty || waiting)
    return (
      <TaskPageFrame header={<PageHeader title="Tasks" />}>
        {waiting ? (
          <p role="status" className="px-6 py-4 text-muted-foreground text-sm">
            Loading tasks…
          </p>
        ) : (
          <EmptyTasks
            onNewTask={() => newTask()}
            onConnectSource={() =>
              void navigate({ to: "/automations", search: { sheet: "source" } })
            }
          />
        )}
      </TaskPageFrame>
    );

  const shown = countShownTasks(roots.byStatus, statuses);
  const countLabel = roots.owners.some((owner) => owner.counts !== null)
    ? `${shown}${roots.countsComplete ? "" : "+"} ${shown === 1 ? "task" : "tasks"}`
    : null;
  const assignees = assigneeOptions(assigneeTasks.items.map((entry) => entry.task));
  const peekKey = view.peek ? factoryTaskKey(view.peek) : null;
  const layout = view.layout;

  return (
    <TaskPageFrame
      header={
        <PageHeader
          title="Tasks"
          view={
            <ToggleGroup
              aria-label="Layout"
              value={[layout]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "board" || value === "list") setView({ layout: value });
              }}
            >
              <Toggle value="board">Board</Toggle>
              <Toggle value="list">List</Toggle>
            </ToggleGroup>
          }
          actions={
            <Button size="sm" onClick={() => newTask()}>
              <PlusIcon aria-hidden />
              New task
            </Button>
          }
        />
      }
    >
      <TasksToolbar
        filters={filters}
        grouping={view.grouping}
        assignees={assignees}
        onFilterOpenChange={setFilterOpen}
        countLabel={countLabel}
        onToggleFilter={(field, value) =>
          setView({ filters: toggleTaskFilter(filters, field, value) })
        }
        onClearFilters={() => setView({ filters: {} })}
        onGroupingChange={(grouping) => setView({ grouping })}
      />
      <div className="flex min-h-0 flex-1 flex-col border-border border-t pt-4">
        <NeedsYouStrip
          open={stripOpen[layout]}
          onOpenChange={(next) => setStripOpen((previous) => ({ ...previous, [layout]: next }))}
          onPeek={peek}
        />
        {layout === "board" ? (
          <>
            <OwnerNotices
              owners={ownerStates(roots)}
              more={roots.more}
              onRetry={roots.refresh}
              onLoadMore={roots.loadMore}
            />
            {filtered && roots.items.length === 0 && settled ? <NoMatches /> : null}
            <TaskBoard
              entries={roots.items}
              grouping={view.grouping}
              statuses={statuses}
              counts={roots.byStatus}
              projectName={projectName}
              showProject={showProject}
              peekKey={peekKey}
              onPeek={peekTask}
              onOpen={open}
              onNewTask={newTask}
              onMove={(task, lane) => void actions.setLane(task, lane)}
              onStart={(task) => openTaskSetup(task.ref, "start")}
            />
          </>
        ) : (
          <ListView
            targets={withFilters(scope.targets, filters, "all")}
            grouping={view.grouping}
            statuses={statuses}
            counts={roots.byStatus}
            filtered={filtered}
            projectName={projectName}
            showProject={showProject}
            peekKey={peekKey}
            onPeek={peekTask}
            onOpen={open}
            onNewTask={newTask}
          />
        )}
      </div>
      {view.peek ? (
        <TaskPeek
          key={peekKey ?? undefined}
          peekRef={view.peek}
          summary={
            roots.items.find((entry) => factoryTaskKey(entry.task.ref) === peekKey)?.task ?? null
          }
          projectName={projectName}
          onClose={closePeek}
          onOpen={open}
        />
      ) : null}
    </TaskPageFrame>
  );
}

function ListView({
  targets,
  filtered,
  ...props
}: Omit<Parameters<typeof TaskList>[0], "entries"> & {
  targets: readonly FactoryTaskListTarget[];
  filtered: boolean;
  statuses: readonly FactoryTaskStatus[];
}) {
  const list = useFactoryTasks(targets);
  const settled = list.owners.every((owner) => owner.status === "current");
  return (
    <>
      <OwnerNotices
        owners={ownerStates(list)}
        more={list.more}
        onRetry={list.refresh}
        onLoadMore={list.loadMore}
      />
      {filtered && list.items.length === 0 && settled ? <NoMatches /> : null}
      <TaskList entries={list.items} {...props} />
    </>
  );
}

function NoMatches() {
  return (
    <p role="status" className="shrink-0 px-6 pb-3 text-muted-foreground text-sm">
      No tasks match these filters.
    </p>
  );
}

function assigneeOptions(tasks: readonly FactoryTaskSummary[]): readonly AssigneeOption[] {
  const options = new Map<string, AssigneeOption>();
  for (const task of tasks)
    if (!options.has(task.assignee.key))
      options.set(task.assignee.key, {
        key: task.assignee.key,
        assignee: task.assignee,
        environmentId: task.ref.environmentId,
      });
  return [...options.values()];
}

function EmptyTasks({
  onNewTask,
  onConnectSource,
}: {
  onNewTask: () => void;
  onConnectSource: () => void;
}) {
  const shortcut = shortcutLabelForCommand(useAtomValue(primaryServerKeybindingsAtom), "tasks.new");
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex flex-col items-center gap-10">
        <TaskEmptyState
          icon="tasks"
          title="No tasks yet"
          body="A task is a piece of work you can hand to an agent, follow on the board and review when it is done."
          primary={{ label: "New task", onClick: onNewTask }}
          {...(shortcut ? { shortcut } : {})}
          secondary={{ label: "Connect a source", onClick: onConnectSource }}
        />
        <ul className="flex flex-col items-center gap-3 text-muted-foreground text-sm">
          {shortcut ? (
            <li className="flex items-center gap-2">
              <CommandIcon aria-hidden className="size-3.5" />
              {`Press ${shortcut} anywhere to add a task`}
            </li>
          ) : null}
          <li className="flex items-center gap-2">
            <ZapIcon aria-hidden className="size-3.5" />
            Rules can add tasks from GitHub issues and feeds
          </li>
        </ul>
      </div>
    </div>
  );
}
