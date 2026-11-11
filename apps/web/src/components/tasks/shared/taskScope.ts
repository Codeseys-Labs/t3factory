import { useAtomValue } from "@effect/atom-react";
import {
  planFactoryTaskOwners,
  type FactoryTaskListTarget,
} from "@t3tools/client-runtime/state/factory-task-list";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { getClientSettings, useClientSettings } from "../../../hooks/useSettings";
import { useSidebarProjectGroups } from "../../../hooks/useSidebarProjectGroups";
import { appAtomRegistry } from "../../../rpc/atomRegistry";
import {
  buildSidebarProjectSnapshots,
  resolveSidebarProjectScopeKeys,
  type SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import { readProjects, useAllEnvironmentProjectSnapshotsReady } from "../../../state/entities";
import { useEnvironmentIdentities } from "../../../state/environments";
import { useFactoryTaskNeeds, useFactoryTasks } from "../../../state/factoryTasks";
import { environmentPresentations } from "../../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../../state/primaryEnvironment";
import { allEnvironmentProjectSnapshotsReadyAtom } from "../../../state/shell";
import { environmentProjects } from "../../../state/projects";
import { useUiStateStore } from "../../../uiStateStore";

export function resolveTaskScope(
  input: Parameters<typeof resolveSidebarProjectScopeKeys>[0] & {
    readonly environmentIds: readonly EnvironmentId[];
  },
) {
  const keys = resolveSidebarProjectScopeKeys(input);
  const selected = input.groups.filter((group) => keys.includes(group.projectKey));
  const projects = keys.length === 0 ? input.groups : selected;
  const refs = projects.flatMap((group) => group.memberProjectRefs);
  const owners = planFactoryTaskOwners({
    environmentIds: keys.length === 0 ? input.environmentIds : refs.map((ref) => ref.environmentId),
    projects:
      keys.length === 0
        ? null
        : refs.map((ref) => ({ environmentId: ref.environmentId, id: ref.projectId })),
  });
  const targets: readonly FactoryTaskListTarget[] = owners.map(({ environmentId, projectIds }) => ({
    environmentId,
    input: projectIds === undefined ? {} : { projectIds },
  }));
  const unique = new Map(refs.map((ref) => [JSON.stringify(ref), ref]));
  return {
    targets,
    projects,
    single: keys.length > 0 && unique.size === 1 ? [...unique.values()][0]! : null,
    label:
      keys.length === 0
        ? "All projects"
        : projects.map((project) => project.displayName).join(", ") || "Selected projects",
  };
}

export function useTaskScope() {
  const groups = useSidebarProjectGroups();
  const keys = useUiStateStore((state) => state.sidebarProjectScopeKeys);
  const settings = useClientSettings(selectProjectGroupingSettings);
  const environments = useEnvironmentIdentities();
  const snapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const configsReady = useAtomValue(environmentProjects.projectConfigsReadyAtom);
  return resolveTaskScope({
    groups,
    keys,
    settings,
    environmentIds: environments.map((environment) => environment.environmentId),
    canClearMissingScope: snapshotsReady && configsReady,
  });
}

export function readTaskScope() {
  const settings = selectProjectGroupingSettings(getClientSettings());
  const environments = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  const groups: SidebarProjectSnapshot[] = buildSidebarProjectSnapshots({
    projects: readProjects(),
    settings,
    groupScratchProjects: true,
    primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    resolveEnvironmentLabel: () => null,
  });
  return resolveTaskScope({
    groups,
    settings,
    keys: useUiStateStore.getState().sidebarProjectScopeKeys,
    environmentIds: [...environments.keys()],
    canClearMissingScope:
      appAtomRegistry.get(allEnvironmentProjectSnapshotsReadyAtom) &&
      appAtomRegistry.get(environmentProjects.projectConfigsReadyAtom),
  });
}

export function useNeedsYou() {
  const scope = useTaskScope();
  const snapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const configsReady = useAtomValue(environmentProjects.projectConfigsReadyAtom);
  const targets: readonly FactoryTaskListTarget[] = scope.targets.map((target) => ({
    ...target,
    input: { ...target.input, scope: "all", attention: true },
  }));
  const list = useFactoryTasks(targets);
  const tasks = list.items.map((item) => item.task);
  const needs = useFactoryTaskNeeds(tasks);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the remaining RPC cursor pages so every consumer counts the same asks
  useEffect(() => {
    for (const owner of list.more) if (owner.available) list.loadMore(owner.environmentId);
  }, [list]);
  return { needs, tasks, list, incomplete: list.incomplete || !snapshotsReady || !configsReady };
}
