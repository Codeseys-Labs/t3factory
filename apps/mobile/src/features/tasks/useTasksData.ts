import type { EnvironmentId, FactoryTaskSummary } from "@t3tools/contracts";
import { planFactoryTaskOwners } from "@t3tools/client-runtime/state/factory-task-list";
import { presentFactoryTaskAssignee } from "@t3tools/client-runtime/state/factory-task-view";
import { useMemo } from "react";

import { useNowMinuteMs } from "../../lib/clock";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  useFactoryTaskCatalogs,
  useFactoryTaskEntries,
  useFactoryTasks,
} from "../../state/factoryTasks";
import { buildTasksSections, resolveTasksListState } from "./taskPresentation";

/** Needs come from tasks that are not finished; done and canceled tasks never ask for anything. */
const OPEN_STATUSES = ["backlog", "ready", "in-progress", "in-review"] as const;

export interface TaskLabels {
  readonly projectLabel: string;
  readonly assigneeLabel: string;
  readonly assigneeMonogram: string;
}

/** The task list across environments, with its asks and the words each row needs. */
export function useTasksData() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const owners = planFactoryTaskOwners({
    environmentIds: environments.map((environment) => environment.environmentId),
    projects: null,
  });
  const list = useFactoryTasks(
    owners.map(({ environmentId }) => ({
      environmentId,
      input: { statuses: [...OPEN_STATUSES], scope: "all" },
    })),
    { loadAll: true },
  );
  const tasks = useMemo(() => list.items.map((item) => item.task), [list.items]);
  const entries = useFactoryTaskEntries(tasks);
  const catalogs = useFactoryTaskCatalogs(owners.map((owner) => owner.environmentId));
  const now = useNowMinuteMs();
  const sections = buildTasksSections(entries, now);
  const state = resolveTasksListState({
    owners: list.owners.map((owner) => ({
      environmentId: owner.environmentId,
      status: owner.status,
    })),
    rowCount: sections.needs.length + sections.groups.reduce((n, g) => n + g.rows.length, 0),
  });
  const environmentLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;
  const labelsFor = (task: FactoryTaskSummary): TaskLabels => {
    const assignee = presentFactoryTaskAssignee(
      task.assignee,
      catalogs.get(task.ref.environmentId) ?? [],
    );
    return {
      projectLabel:
        projects.find(
          (project) =>
            project.environmentId === task.ref.environmentId && project.id === task.ref.projectId,
        )?.title ?? task.ref.projectId,
      assigneeLabel: assignee.label,
      assigneeMonogram: assignee.monogram,
    };
  };

  const inboxState = resolveTasksListState({
    owners: list.owners.map((owner) => ({
      environmentId: owner.environmentId,
      status: owner.status,
    })),
    rowCount: sections.needs.length,
  });

  return {
    sections,
    state,
    inboxState,
    refreshing: list.owners.some((owner) => owner.status === "loading" && owner.pages.length > 0),
    refresh: list.refresh,
    environmentLabel,
    labelsFor,
    catalogs,
  };
}
