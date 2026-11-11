import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { buildPlanningPrompt } from "../../apps/server/src/factory/FactoryTaskPlanningPrompt.ts";
import { ProposeSubtasksInput } from "../../apps/server/src/factory/FactoryTaskPlanningService.ts";

export const planningPrompt = buildPlanningPrompt({
  task: {
    ref: {
      environmentId: EnvironmentId.make("env-acme"),
      projectId: ProjectId.make("project-acme"),
      rootId: "task-export",
      taskId: "task-export",
    },
    title: "Export the task list as CSV",
  },
  description:
    "Plan the API and client changes for CSV export, then tests for escaped commas and newlines. The API must be available before the client can use it. Available agent profile: Implementer. Submit the remaining work for review.",
  subtasks: [{ title: "Define the CSV column names", status: "done" }],
});

const isSubmission = Schema.is(ProposeSubtasksInput);

export function usablePlanningSubmission(input: unknown): boolean {
  if (!isSubmission(input)) return false;
  const items = input.items;
  const byKey = new Map(items.map((item) => [item.key, item]));
  if (byKey.size !== items.length || !items.some((item) => item.after.length > 0)) return false;
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (key: string): boolean => {
    const item = byKey.get(key);
    if (item === undefined || active.has(key)) return false;
    if (visited.has(key)) return true;
    active.add(key);
    if (!item.after.every(visit)) return false;
    active.delete(key);
    visited.add(key);
    return true;
  };
  return items.every(
    (item) => item.title.trim().length > 0 && item.description.trim().length > 0 && visit(item.key),
  );
}
