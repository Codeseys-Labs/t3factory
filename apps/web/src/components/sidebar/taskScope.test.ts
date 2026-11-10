import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import { resolveTaskScope } from "../tasks/shared/taskScope";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const settings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function project(environmentId = local): Project {
  return {
    id: ProjectId.make(`project-${environmentId}`),
    environmentId,
    title: "t3code-factory",
    workspaceRoot: "/workspace/t3code-factory",
    repositoryIdentity: {
      canonicalKey: "github.com/codeseys-labs/t3factory",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/Codeseys-Labs/t3factory.git",
      },
    },
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    scripts: [],
  };
}

function groups(projects: readonly Project[]) {
  return buildSidebarProjectSnapshots({
    projects,
    settings,
    primaryEnvironmentId: local,
    resolveEnvironmentLabel: () => null,
  });
}

describe("task project scope", () => {
  it("queries every owner without a project filter for All projects", () => {
    const scope = resolveTaskScope({
      groups: groups([project()]),
      keys: [],
      environmentIds: [remote, local, local],
    });
    expect(scope.targets).toEqual([
      { environmentId: local, input: {} },
      { environmentId: remote, input: {} },
    ]);
    expect(scope.single).toBeNull();
    expect(scope.label).toBe("All projects");
  });

  it("prefills one physical project", () => {
    const snapshots = groups([project()]);
    const scope = resolveTaskScope({
      groups: snapshots,
      keys: [snapshots[0]!.projectKey],
      environmentIds: [local, remote],
    });
    expect(scope.targets).toEqual([
      { environmentId: local, input: { projectIds: [project().id] } },
    ]);
    expect(scope.single).toEqual({ environmentId: local, projectId: project().id });
    expect(scope.label).toBe("t3code-factory");
  });

  it("queries both physical owners of one logical project without choosing a default", () => {
    const snapshots = groups([project(), project(remote)]);
    expect(snapshots).toHaveLength(1);
    const scope = resolveTaskScope({
      groups: snapshots,
      keys: [snapshots[0]!.projectKey],
      environmentIds: [local, remote],
    });
    expect(scope.targets).toEqual([
      { environmentId: local, input: { projectIds: [project().id] } },
      { environmentId: remote, input: { projectIds: [project(remote).id] } },
    ]);
    expect(scope.single).toBeNull();
  });

  it("holds a missing scope until snapshots settle, then follows the sidebar to All projects", () => {
    const input = { groups: groups([project()]), keys: ["gone"], environmentIds: [local, remote] };
    expect(resolveTaskScope(input).targets).toEqual([]);
    const scope = resolveTaskScope({ ...input, canClearMissingScope: true });
    expect(scope.targets).toEqual([
      { environmentId: local, input: {} },
      { environmentId: remote, input: {} },
    ]);
    expect(scope.label).toBe("All projects");
    expect(scope.single).toBeNull();
  });
});
