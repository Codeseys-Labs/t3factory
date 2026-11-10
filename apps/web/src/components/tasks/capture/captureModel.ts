import type { EnvironmentId, FactoryTaskAssignment, ProjectId } from "@t3tools/contracts";

export const TASK_TITLE_MAX = 512;
export const TASK_DESCRIPTION_MAX = 8000;

/** The first line is the title and the rest is the description. A first line past the limit spills over. */
export function splitTaskText(text: string): { title: string; description: string } {
  const trimmed = text.trim();
  const newline = trimmed.indexOf("\n");
  const first = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : trimmed.slice(newline + 1).trim();
  if (first.length <= TASK_TITLE_MAX) return { title: first, description: rest };
  const overflow = first.slice(TASK_TITLE_MAX).trim();
  return {
    title: first.slice(0, TASK_TITLE_MAX).trimEnd(),
    description: [overflow, rest].filter(Boolean).join("\n\n"),
  };
}

/** Only an agent runs a task: Unassigned and You never start one. */
export function assignmentRunsAgent(assignment: FactoryTaskAssignment): boolean {
  return assignment.mode !== "unassigned" && assignment.mode !== "person";
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .toSorted(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;

/** Whether two assignments name the same thing, whatever order their fields arrived in. */
export function sameAssignment(a: FactoryTaskAssignment, b: FactoryTaskAssignment): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export interface CaptureProject {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly machine: string | null;
}

export function captureProjectKey(environmentId: EnvironmentId, projectId: ProjectId) {
  return `${environmentId}/${projectId}`;
}

/** The project's name, followed by its machine when another machine holds a project of that name. */
export function captureProjectLabel(
  project: CaptureProject,
  all: readonly CaptureProject[],
): string {
  const shared = all.some(
    (other) => other.environmentId !== project.environmentId && other.name === project.name,
  );
  return shared && project.machine ? `${project.name} · ${project.machine}` : project.name;
}

/** The one project a dialog's defaults name, or null when they name none or several. */
export function matchDefaultProject(
  projects: readonly CaptureProject[],
  defaults: { readonly environmentId?: EnvironmentId; readonly projectId?: ProjectId },
): CaptureProject | null {
  if (defaults.environmentId === undefined && defaults.projectId === undefined) return null;
  const matches = projects.filter(
    (project) =>
      (defaults.environmentId === undefined || project.environmentId === defaults.environmentId) &&
      (defaults.projectId === undefined || project.projectId === defaults.projectId),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
