import { useProjects } from "../../../state/entities";
import { useEnvironmentIdentities } from "../../../state/environments";
import { useEnvironmentPresentation } from "../../../state/presentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { type CaptureProject, captureProjectKey } from "./captureModel";

/** Every project a task can be created in, across the connected machines. */
export function useCaptureProjects(): readonly CaptureProject[] {
  const projects = useProjects();
  const labels = new Map(
    useEnvironmentIdentities().map((environment) => [environment.environmentId, environment.label]),
  );
  return projects
    .filter((project) => project.isScratch !== true)
    .map((project) => ({
      key: captureProjectKey(project.environmentId, project.id),
      environmentId: project.environmentId,
      projectId: project.id,
      name: project.title,
      machine: labels.get(project.environmentId) ?? null,
    }));
}

export function useMachineLabel(environmentId: EnvironmentId): string | null {
  return useEnvironmentPresentation(environmentId).presentation?.entry.target.label ?? null;
}
