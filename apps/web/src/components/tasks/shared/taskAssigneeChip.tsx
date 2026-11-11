import type { EnvironmentId, FactoryTaskAssignee } from "@t3tools/contracts";

import { AssigneeChip, type AssigneeChipProps } from "../kit";
import { taskAssigneeChipProps } from "./taskAssigneeModel";
import { useTaskCatalog } from "./taskCatalog";

export function useTaskAssigneeChip(
  assignee: FactoryTaskAssignee,
  environmentId: EnvironmentId,
): AssigneeChipProps {
  return taskAssigneeChipProps(assignee, useTaskCatalog(environmentId));
}

export function TaskAssigneeChip({
  assignee,
  environmentId,
}: {
  assignee: FactoryTaskAssignee;
  environmentId: EnvironmentId;
}) {
  return <AssigneeChip assignee={useTaskAssigneeChip(assignee, environmentId)} />;
}
