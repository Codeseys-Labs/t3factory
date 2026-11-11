import type { EnvironmentId, FactoryTaskSummary } from "@t3tools/contracts";
import { planFactoryTaskOwners } from "@t3tools/client-runtime/state/factory-task-list";
import {
  factoryTaskKey,
  presentFactoryTaskAssignee,
} from "@t3tools/client-runtime/state/factory-task-view";
import { useMemo, useState } from "react";

import { useNowMinuteMs } from "../../lib/clock";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  useFactoryTaskCatalogs,
  useFactoryTaskEntries,
  useFactoryTasks,
} from "../../state/factoryTasks";
import { buildTasksSections, resolveTasksListState } from "./taskPresentation";

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
  const attention = useFactoryTasks(
    owners.map(({ environmentId }) => ({
      environmentId,
      input: { scope: "all", attention: true },
    })),
    { loadAll: true },
  );
  const work = useFactoryTasks(
    owners.map(({ environmentId }) => ({
      environmentId,
      input: { scope: "all", statuses: ["in-progress", "in-review"] },
    })),
    { loadAll: true },
  );
  const tasks = useMemo(() => {
    const byKey = new Map<string, FactoryTaskSummary>();
    for (const { task } of [...attention.items, ...work.items]) {
      const key = factoryTaskKey(task.ref);
      const previous = byKey.get(key);
      if (
        !previous ||
        task.updatedAt > previous.updatedAt ||
        (task.updatedAt === previous.updatedAt && task.version > previous.version)
      )
        byKey.set(key, task);
    }
    return [...byKey.values()];
  }, [attention.items, work.items]);
  const entries = useFactoryTaskEntries(tasks);
  const catalogs = useFactoryTaskCatalogs(owners.map((owner) => owner.environmentId));
  const now = useNowMinuteMs();
  const sections = buildTasksSections(entries, now);
  const state = resolveTasksListState({
    owners: [...attention.owners, ...work.owners].map((owner) => ({
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
    owners: attention.owners.map((owner) => ({
      environmentId: owner.environmentId,
      status: owner.status,
    })),
    rowCount: sections.needs.length,
  });

  const [refreshRequested, setRefreshRequested] = useState(false);
  const loading = [...attention.owners, ...work.owners].some((owner) => owner.status === "loading");
  if (refreshRequested && !loading) setRefreshRequested(false);

  return {
    sections,
    state,
    inboxState,
    incomplete: attention.incomplete || work.incomplete,
    needsIncomplete: attention.incomplete,
    refreshing: refreshRequested && loading,
    refresh: () => {
      setRefreshRequested(true);
      attention.refresh();
      work.refresh();
    },
    environmentLabel,
    labelsFor,
    catalogs,
  };
}
