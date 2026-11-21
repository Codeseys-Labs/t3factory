import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationReadScope,
  sessionGrantsScope,
  type ScheduledTask,
} from "@t3tools/contracts";
import { Link, useSearch } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useEnvironmentShellStatus } from "../../state/shell";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RelativeTime } from "../RelativeTime";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { Button } from "../ui/button";
import { factoryScopeSearchForMember } from "./factoryScope";

type Checkout = {
  readonly group: SidebarProjectSnapshot;
  readonly member: SidebarProjectGroupMember;
};

export function FactoryOverviewPage() {
  const { scope, groups } = useSettingsScope();
  const { isReady, environments } = useEnvironments();
  if (scope.kind === "unavailable") return null;
  const relevantEnvironments = environments.filter((environment) =>
    scope.environmentIds.includes(environment.environmentId),
  );
  const checkouts = groups.flatMap((group) =>
    group.memberProjects.flatMap((member) => {
      const included =
        scope.kind === "project" || scope.kind === "checkout"
          ? scope.members.some(
              (selected) => selected.physicalProjectKey === member.physicalProjectKey,
            )
          : scope.environmentIds.includes(member.environmentId);
      return included ? [{ group, member }] : [];
    }),
  );
  return (
    <section className="min-w-0 space-y-6" aria-labelledby="factory-overview-title">
      <div className="space-y-1">
        <h2 id="factory-overview-title" className="font-medium text-lg">
          <T>Overview</T>
        </h2>
        <p className="text-muted-foreground text-sm">
          <T>
            Projects, sessions and scheduled agent prompts in this scope. Workflow status is the
            latest dispatch, not a completion signal or run history.
          </T>
        </p>
      </div>
      {!isReady ? (
        <p role="status" className="text-muted-foreground text-sm">
          <T>Loading environments…</T>
        </p>
      ) : relevantEnvironments.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <T>Connect an environment to see your projects and work.</T>
        </p>
      ) : (
        relevantEnvironments.map((environment) => (
          <FactoryOverviewEnvironment
            key={environment.environmentId}
            environment={environment}
            checkouts={checkouts.filter(
              ({ member }) => member.environmentId === environment.environmentId,
            )}
          />
        ))
      )}
    </section>
  );
}

function FactoryOverviewEnvironment({
  environment,
  checkouts,
}: {
  readonly environment: EnvironmentPresentation;
  readonly checkouts: ReadonlyArray<Checkout>;
}) {
  const gt = useGT();
  const m = useMessages();
  const search = useSearch({ from: "/_chat/factory" });
  const session = useEnvironmentSessionState(environment.environmentId);
  const shellStatus = useEnvironmentShellStatus(environment.environmentId);
  const threads = useQuietThreadShells();
  const connected = environment.connection.phase === "connected";
  const canRead =
    session.data !== null &&
    !session.hasError &&
    sessionGrantsScope(session.data, AuthOrchestrationReadScope);
  const readable = connected && environment.serverConfig !== null && canRead;
  const coordinatorSupported =
    environment.serverConfig?.environment.capabilities.projectCoordinators === true;
  const workflows = useEnvironmentQuery(
    readable
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const coordinators = useEnvironmentQuery(
    readable && coordinatorSupported
      ? factoryEnvironment.coordinatorsList({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  const accessMessage = !connected
    ? gt("Offline. Reconnect to load current work.")
    : environment.serverConfig === null
      ? gt("Server capabilities unknown.")
      : session.hasError
        ? gt("Connection permissions unavailable.")
        : session.data === null
          ? gt("Loading connection permissions…")
          : !canRead
            ? gt("Read access denied for this connection.")
            : null;
  const inventoryLive = readable && shellStatus === "live";
  const workflowMessage =
    accessMessage ??
    (workflows.error !== null
      ? gt("Workflows unavailable: {error}", { error: workflows.error })
      : workflows.data === null
        ? gt("Loading workflows…")
        : null);
  const coordinatorMessage =
    accessMessage ??
    (!coordinatorSupported
      ? gt("Project orchestrators unsupported by this server.")
      : coordinators.error !== null
        ? gt("Orchestrators unavailable: {error}", { error: coordinators.error })
        : coordinators.data === null
          ? gt("Loading orchestrators…")
          : null);

  return (
    <section className="space-y-3" aria-label={gt("{label} work", { label: environment.label })}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">{environment.label}</h3>
        {readable ? (
          <Button
            size="sm"
            variant="outline"
            disabled={workflows.isPending || coordinators.isPending}
            onClick={() => {
              workflows.refresh();
              if (coordinatorSupported) coordinators.refresh();
            }}
          >
            <T>Refresh</T>
          </Button>
        ) : null}
      </div>
      {accessMessage !== null ? (
        <p role="status" className="text-muted-foreground text-sm">
          {accessMessage}
        </p>
      ) : null}
      {checkouts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {inventoryLive
            ? gt("No project checkouts in this scope.")
            : gt(
                "Project inventory unavailable until this environment is connected and synchronized.",
              )}
        </p>
      ) : (
        checkouts.map(({ member, group }) => {
          const exactSearch = {
            ...search,
            ...factoryScopeSearchForMember(member, group),
            taskId: undefined,
          };
          const projectThreads = threads.filter(
            (thread) =>
              thread.environmentId === environment.environmentId &&
              thread.projectId === member.id &&
              thread.deletedAt === null,
          );
          const tasks =
            workflowMessage === null
              ? workflows.data?.tasks.filter((task) => task.projectId === member.id)
              : undefined;
          const coordinator =
            coordinatorMessage === null
              ? coordinators.data?.coordinators.find((item) => item.projectId === member.id)
              : undefined;
          return (
            <article
              key={member.physicalProjectKey}
              className="min-w-0 space-y-4 rounded-lg border p-4"
            >
              <div className="space-y-1">
                <Link
                  to="/factory"
                  search={exactSearch}
                  className="font-medium text-sm underline-offset-4 hover:underline"
                >
                  {group.displayName}
                </Link>
                <p className="text-muted-foreground text-xs">{environment.label}</p>
                <p className="break-all text-muted-foreground text-xs">{member.workspaceRoot}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <h4 className="font-medium text-xs">
                    <T>Sessions</T>
                  </h4>
                  <p className="text-muted-foreground text-sm">
                    {inventoryLive
                      ? gt(
                          "{count, plural, one {{count} thread} other {{count} threads}} · {running} running",
                          {
                            count: projectThreads.length,
                            running: projectThreads.filter((thread) =>
                              threadRuntimeIsActive(thread.runtime),
                            ).length,
                          },
                        )
                      : gt("Current thread and running counts unavailable.")}
                  </p>
                </div>
                <div className="space-y-1">
                  <h4 className="font-medium text-xs">
                    <T>Project orchestrator</T>
                  </h4>
                  <p className="text-muted-foreground text-sm">
                    {coordinatorMessage ?? (coordinator ? coordinator.status : gt("Not created"))}
                  </p>
                  {coordinatorMessage === null ? (
                    coordinator &&
                    coordinator.status !== "missing" &&
                    coordinator.status !== "launching" ? (
                      <Link
                        to="/$environmentId/$threadId"
                        params={buildThreadRouteParams(
                          scopeThreadRef(environment.environmentId, coordinator.threadId),
                        )}
                        className="text-sm underline underline-offset-4"
                      >
                        <T>Open orchestrator</T>
                      </Link>
                    ) : (
                      <Link
                        to="/factory/orchestrator"
                        search={exactSearch}
                        className="text-sm underline underline-offset-4"
                      >
                        {coordinator?.status === "launching"
                          ? gt("Review orchestrator startup")
                          : coordinator
                            ? gt("Review missing orchestrator")
                            : gt("Set up orchestrator")}
                      </Link>
                    )
                  ) : null}
                </div>
              </div>
              <div className="space-y-2">
                <Link
                  to="/factory/workflows"
                  search={exactSearch}
                  className="font-medium text-sm underline-offset-4 hover:underline"
                >
                  <T>Workflows</T>
                  {tasks !== undefined ? ` · ${tasks.length}` : ""}
                </Link>
                {workflowMessage !== null ? (
                  <p role="status" className="text-muted-foreground text-sm">
                    {workflowMessage}
                  </p>
                ) : tasks?.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    <T>No scheduled workflows.</T>
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {tasks?.map((task) => (
                      <li
                        key={task.id}
                        className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
                      >
                        <Link
                          to="/factory/workflows"
                          search={{ ...exactSearch, taskId: task.id }}
                          className="min-w-0 break-words underline underline-offset-4"
                        >
                          {task.title}
                        </Link>
                        <span className="text-muted-foreground text-xs">
                          {task.enabled ? gt("Enabled") : gt("Paused")} ·{" "}
                          {latestDispatchLabel(task, m)}
                          {task.lastRunAt !== null ? (
                            <>
                              {" "}
                              · <RelativeTime timestamp={task.lastRunAt} />
                            </>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <Link
                  to="/factory/issues"
                  search={exactSearch}
                  className="inline-block text-sm underline underline-offset-4"
                >
                  <T>Open issue inbox</T>
                </Link>
                {environment.serverConfig?.environment.capabilities.factoryFeeds === true ? (
                  <Link
                    to="/factory/sources"
                    search={exactSearch}
                    className="inline-block text-sm underline underline-offset-4"
                  >
                    <T>Open feed sources</T>
                  </Link>
                ) : null}
                {environment.serverConfig?.environment.capabilities.factoryResearch === true ? (
                  <Link
                    to="/factory/research"
                    search={exactSearch}
                    className="inline-block text-sm underline underline-offset-4"
                  >
                    <T>Open research protocols</T>
                  </Link>
                ) : null}
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}

function latestDispatchLabel(task: ScheduledTask, resolve: MessageResolver = m): string {
  switch (task.lastRunStatus) {
    case "never":
      return resolve(msg("Never dispatched"));
    case "running":
      return resolve(msg("Dispatching"));
    case "succeeded":
      return resolve(msg("Dispatch accepted"));
    case "failed":
      return resolve(msg("Dispatch failed"));
  }
}
