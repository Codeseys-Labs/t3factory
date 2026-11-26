import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  type FactoryTaskSummary,
  type ProjectId,
  type WorkflowQuestion,
  type WorkflowRun,
} from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Plural, T, useGT, Var } from "gt-react";
import { BotIcon, KanbanIcon, PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { isElectron } from "~/env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn } from "../lib/utils";
import { useProjects } from "../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset } from "../components/ui/sidebar";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useWorkflowEnvironmentIds } from "../components/workflows/useWorkflowEnvironmentIds";
import { useRememberWorkEnvironment } from "./FactoryWorkSidebarItem";
import { NewTaskDialog } from "./NewTaskDialog";
import { createFactoryTask, factoryTasksLive } from "./state";
import { TaskPanel } from "./TaskPanel";
import { WorkBoard, WorkNeedsYou } from "./WorkBoard";
import { deriveWorkCards, filterWorkCards, selectAttentionItems } from "./workBoard.logic";
import { WorkGraph } from "./WorkGraph";
import { WorkList } from "./WorkList";

export type WorkView = "board" | "list" | "graph";

export interface WorkSearch {
  readonly env?: string;
  readonly view?: WorkView;
  /** A project id, or `none` for the tasks that have no project. */
  readonly project?: string;
  readonly task?: string;
}

const NO_PROJECT = "none";
const EVERY_PROJECT = "";
const NO_TASKS: ReadonlyArray<FactoryTaskSummary> = [];
const NO_RUNS: ReadonlyArray<WorkflowRun> = [];
const NO_QUESTIONS: ReadonlyArray<WorkflowQuestion> = [];
// Sent to an agent as the first message of its thread, so it stays in English.
const ORCHESTRATOR_PROMPT =
  "You are the Orchestrator for this project in T3 Factory. Load the t3factory-orchestrator skill and follow it. Start by listing this project's tasks and telling me what waits on me.";

function WorkEmpty({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <KanbanIcon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

/** One environment's tasks across all its projects, as a board, list or graph, beside the open task. */
export function WorkPage() {
  const search = useSearch({ from: "/_chat/work" });
  const navigate = useNavigate();
  const gt = useGT();
  const handleNewThread = useNewThreadHandler();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const workflowIds = useWorkflowEnvironmentIds();
  const connected = environments.filter((environment) =>
    connectedIds.includes(environment.environmentId),
  );
  const asked = search.env === undefined ? null : EnvironmentId.make(search.env);
  // An environment the address names is kept while it is away: its tasks mean nothing on another.
  const environmentId =
    asked !== null
      ? (connected.find((environment) => environment.environmentId === asked)?.environmentId ??
        null)
      : (connected.find((environment) => environment.environmentId === primaryEnvironmentId)
          ?.environmentId ??
        connected[0]?.environmentId ??
        null);
  const away =
    asked !== null && environmentId === null
      ? (environments.find((environment) => environment.environmentId === asked)?.label ?? asked)
      : null;
  const live = useEnvironmentQuery(
    environmentId === null ? null : factoryTasksLive({ environmentId, input: {} }),
  );
  useRememberWorkEnvironment(environmentId);
  const workflowsOn = environmentId !== null && workflowIds.includes(environmentId);
  const workflows = useEnvironmentQuery(
    environmentId !== null && workflowIds.includes(environmentId)
      ? serverEnvironment.workflowsLive({ environmentId, input: {} })
      : null,
  );
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  const canCreate = useAtomValue(createFactoryTask.permissionAtom(environmentId));
  // The environment New task was opened on: the dialog stays on it whatever the page shows.
  const [creatingOn, setCreatingOn] = useState<EnvironmentId | null>(null);
  const [text, setText] = useState("");
  const [rollUp, setRollUp] = useState(false);

  const pinned = environmentId ?? search.env;
  const env = pinned === undefined ? {} : { env: pinned };
  const view = search.view ?? "board";
  const shown = {
    view,
    project: search.project ?? null,
    task: search.task ?? null,
  };
  const show = (next: typeof shown) =>
    void navigate({
      to: "/work",
      search: {
        ...env,
        ...(next.view === "board" ? {} : { view: next.view }),
        ...(next.project === null ? {} : { project: next.project }),
        ...(next.task === null ? {} : { task: next.task }),
      },
      replace: true,
    });
  const openRun = (runId: string) =>
    void navigate({ to: "/workflows", search: { ...env, run: runId } });
  // Cards are memoised on what they show, so the handler they hold keeps one identity.
  const openTask = useStableCallback((taskId: string) => show({ ...shown, task: taskId }));

  const snapshot = live.data;
  // A failing or switched-off workflows list leaves the board as the tasks say.
  const runsSnapshot = workflows.error === null ? workflows.data : null;
  const runsPending = workflowsOn && workflows.error === null && workflows.data === null;
  const runs = runsSnapshot?.runs ?? NO_RUNS;
  const questions = runsSnapshot?.questions ?? NO_QUESTIONS;
  const tasks = snapshot?.tasks ?? NO_TASKS;
  // Rolling up needs every child: a cut-off or unreadable list could be missing some.
  const complete = snapshot !== null && !snapshot.truncated && snapshot.damaged === 0;
  const cards = deriveWorkCards({ tasks, runs, questions, rollUpParents: rollUp && complete });
  const projectFilter =
    search.project === undefined
      ? undefined
      : search.project === NO_PROJECT
        ? null
        : search.project;
  const query = text.trim();
  const visible = filterWorkCards(cards, {
    ...(projectFilter === undefined ? {} : { projectId: projectFilter }),
    ...(query === "" ? {} : { text: query }),
  });
  const attention = selectAttentionItems({ cards: visible, runs, questions });
  const projectNames: ReadonlyMap<string, string> = new Map(
    projects.map((project) => [project.id, project.title] as const),
  );
  const ready = environmentId !== null && live.error === null && snapshot !== null;
  const openTaskId = environmentId === null || live.error !== null ? null : shown.task;
  const panelOpen = openTaskId !== null;
  const listedProject =
    projectFilter === undefined || projectFilter === null
      ? null
      : (projects.find((project) => project.id === projectFilter) ?? null);
  const openOrchestrator = (projectId: ProjectId) => {
    if (environmentId === null) return;
    const known = snapshot?.orchestrators.find((entry) => entry.projectId === projectId);
    if (known !== undefined) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, known.threadId)),
      });
      return;
    }
    // A null answer means the person went elsewhere meanwhile; only a throw is a failure.
    void handleNewThread(scopeProjectRef(environmentId, projectId), {
      prompt: ORCHESTRATOR_PROMPT,
    }).catch(() =>
      toastManager.add({ type: "error", title: gt("T3 Code could not open a new thread.") }),
    );
  };
  const openCreated = (createdOn: EnvironmentId, taskId: string) => {
    setCreatingOn(null);
    void navigate({
      to: "/work",
      search: {
        env: createdOn,
        ...(view === "board" ? {} : { view }),
        ...(createdOn === environmentId && search.project !== undefined
          ? { project: search.project }
          : {}),
        task: taskId,
      },
      replace: true,
    });
  };

  const notices: Array<{ readonly key: string; readonly body: ReactNode }> = [];
  if (ready && snapshot.damaged > 0) {
    notices.push({
      key: "damaged",
      body: (
        <T>
          <Plural
            n={snapshot.damaged}
            one={
              <>
                <Var>{snapshot.damaged}</Var> task record could not be read.
              </>
            }
            other={
              <>
                <Var>{snapshot.damaged}</Var> task records could not be read.
              </>
            }
          />
        </T>
      ),
    });
  }
  if (ready && snapshot.truncated) {
    notices.push({ key: "truncated", body: <T>Showing the newest 2,000 tasks.</T> });
  }
  if (ready && !workflowsOn) {
    notices.push({
      key: "workflows",
      body: (
        <T>
          Workflows are off on this server, so tasks cannot start. Turn them on in{" "}
          <Link to="/settings/labs" className="underline underline-offset-2">
            Settings → Labs
          </Link>
          .
        </T>
      ),
    });
  } else if (ready && workflows.error !== null) {
    notices.push({
      key: "workflows",
      body: (
        <T>
          Workflow runs could not load, so cards show no run state. Check workflows in{" "}
          <Link to="/settings/labs" className="underline underline-offset-2">
            Settings → Labs
          </Link>
          .
        </T>
      ),
    });
  } else if (ready && runsPending) {
    notices.push({
      key: "workflows",
      body: <T>Loading workflow runs. Tasks with a run may still change column.</T>,
    });
  }

  const body =
    away !== null ? (
      <WorkEmpty
        title={gt("{name} is not connected", { name: away })}
        description={gt(
          "Its tasks show again when it reconnects. Pick another environment to see its tasks.",
        )}
      />
    ) : environmentId === null ? (
      <WorkEmpty
        title={gt("No environment connected")}
        description={gt("Connect an environment to see its tasks.")}
      />
    ) : live.error !== null ? (
      <WorkEmpty title={gt("This server has no Work support")} description={live.error} />
    ) : snapshot === null ? (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        <T>Loading tasks…</T>
      </p>
    ) : cards.length === 0 ? (
      <WorkEmpty title={gt("No tasks yet")} description={gt("Add the first one with New task.")} />
    ) : view === "list" ? (
      <WorkList
        cards={visible}
        projectNames={projectNames}
        selectedTaskId={openTaskId}
        runsPending={runsPending}
        onOpenTask={openTask}
      />
    ) : view === "graph" ? (
      <WorkGraph
        cards={visible}
        tasks={tasks}
        selectedTaskId={openTaskId}
        runsPending={runsPending}
        onOpenTask={openTask}
      />
    ) : (
      <WorkBoard
        cards={visible}
        projectNames={projectNames}
        selectedTaskId={openTaskId}
        runsPending={runsPending}
        onOpenTask={openTask}
      />
    );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Below md there is room for one thing, and an open task is that thing. */}
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col bg-background",
            panelOpen ? "hidden md:flex" : "flex",
          )}
        >
          <WorkspacePageHeader
            electron={isElectron}
            reserveNativeControls={!panelOpen}
            className="border-b"
          >
            <WorkspaceBreadcrumb ariaLabel={gt("Work breadcrumb")} className="flex-1">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">
                  <T context="page title: the board of tasks">Work</T>
                </h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            {(connected.length > 1 && environmentId !== null) ||
            (away !== null && connected.length > 0) ? (
              <div className="w-44 shrink-0">
                <Select
                  value={environmentId ?? asked}
                  onValueChange={(value) => {
                    if (value !== null) {
                      void navigate({ to: "/work", search: { env: value }, replace: true });
                    }
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={gt("Environment", { $context: "a T3 Code server to pick" })}
                  >
                    <SelectValue>
                      {away ??
                        connected.find((environment) => environment.environmentId === environmentId)
                          ?.label ??
                        environmentId}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {connected.map((environment) => (
                      <SelectItem key={environment.environmentId} value={environment.environmentId}>
                        {environment.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <Button
              size="sm"
              disabled={!ready || !canCreate}
              onClick={() => setCreatingOn(environmentId)}
            >
              <PlusIcon />
              <T>New task</T>
            </Button>
          </WorkspacePageHeader>
          {ready ? (
            <WorkNeedsYou items={attention} onOpenTask={openTask} onOpenRun={openRun} />
          ) : null}
          {ready ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
              <ToggleGroup
                aria-label={gt("Show tasks as")}
                value={[view]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "board" || value === "list" || value === "graph") {
                    show({ ...shown, view: value });
                  }
                }}
              >
                <Toggle value="board">
                  <T context="show the tasks as a board of columns">Board</T>
                </Toggle>
                <Toggle value="list">
                  <T context="show the tasks as a list of rows">List</T>
                </Toggle>
                <Toggle value="graph">
                  <T context="show the tasks as a graph of what blocks what">Graph</T>
                </Toggle>
              </ToggleGroup>
              <div className="w-48 shrink-0">
                <Select
                  value={search.project ?? EVERY_PROJECT}
                  onValueChange={(value) =>
                    show({
                      ...shown,
                      project: value === null || value === EVERY_PROJECT ? null : value,
                    })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={gt("Project", { $context: "picker that filters tasks by project" })}
                  >
                    <SelectValue>
                      {projectFilter === undefined
                        ? gt("All projects")
                        : projectFilter === null
                          ? gt("No project")
                          : (listedProject?.title ?? projectFilter)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={EVERY_PROJECT}>
                      <T>All projects</T>
                    </SelectItem>
                    <SelectItem value={NO_PROJECT}>
                      <T>No project</T>
                    </SelectItem>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="min-w-40 flex-1 sm:max-w-72">
                <Input
                  type="search"
                  size="sm"
                  value={text}
                  placeholder={gt("Filter by title or T-number")}
                  aria-label={gt("Filter tasks")}
                  onChange={(event) => setText(event.currentTarget.value)}
                />
              </div>
              <Label>
                <Switch
                  size="sm"
                  checked={rollUp && complete}
                  disabled={!complete}
                  onCheckedChange={(checked) => setRollUp(checked)}
                />
                <T context="view setting: show a parent task in the column its subtasks add up to">
                  Roll up parents
                </T>
              </Label>
              {listedProject === null ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openOrchestrator(listedProject.id)}
                >
                  <BotIcon />
                  <T context="opens the agent thread that runs this project's tasks">
                    Orchestrator
                  </T>
                </Button>
              )}
            </div>
          ) : null}
          {notices.map((notice) => (
            <p
              key={notice.key}
              role="status"
              className="shrink-0 border-b px-4 py-1.5 text-xs text-muted-foreground"
            >
              {notice.body}
            </p>
          ))}
          {body}
        </div>
        {environmentId === null || openTaskId === null ? null : (
          <aside
            aria-label={gt("Task", { $context: "the open task beside the board" })}
            className="min-h-0 w-full max-w-full shrink-0 bg-background md:w-104 md:border-s"
          >
            <TaskPanel
              key={`${environmentId}:${openTaskId}`}
              environmentId={environmentId}
              taskId={openTaskId}
              card={cards.find((card) => card.task.id === openTaskId) ?? null}
              tasks={tasks}
              runs={runs}
              questions={questions}
              onOpenTask={openTask}
              onOpenRun={openRun}
              onClose={() => show({ ...shown, task: null })}
            />
          </aside>
        )}
      </div>
      {creatingOn === null ? null : (
        <NewTaskDialog
          environmentId={creatingOn}
          environmentLabel={
            environments.find((environment) => environment.environmentId === creatingOn)?.label ??
            creatingOn
          }
          connected={connectedIds.includes(creatingOn)}
          projects={allProjects.filter(
            (project) => project.environmentId === creatingOn && !project.archivedAt,
          )}
          projectId={creatingOn === environmentId ? (listedProject?.id ?? null) : null}
          onClose={() => setCreatingOn(null)}
          onOpenTask={(taskId) => openCreated(creatingOn, taskId)}
        />
      )}
    </SidebarInset>
  );
}
