import type { FactoryTaskLabelOptions } from "@t3tools/client-runtime/state/factory-task-view";
import type { EnvironmentId, FactoryTaskAssignee } from "@t3tools/contracts";

import { AssigneeChip, type AssigneeChipProps } from "../kit";
import { taskAssigneeChipProps } from "./taskAssigneeModel";
import { useTaskCatalog } from "./taskCatalog";

export function useTaskAssigneeChip(
  assignee: FactoryTaskAssignee,
  environmentId: EnvironmentId,
  labelOptions?: FactoryTaskLabelOptions,
): AssigneeChipProps {
  return taskAssigneeChipProps(assignee, useTaskCatalog(environmentId), labelOptions);
}

export function TaskAssigneeChip({
  assignee,
  environmentId,
  labelOptions,
}: {
  assignee: FactoryTaskAssignee;
  environmentId: EnvironmentId;
  labelOptions?: FactoryTaskLabelOptions;
}) {
  return <AssigneeChip assignee={useTaskAssigneeChip(assignee, environmentId, labelOptions)} />;
}
