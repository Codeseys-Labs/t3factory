import type {
  EnvironmentId,
  FactoryTaskAssignee,
  FactoryTaskCountInput,
  FactoryTaskSourceKind,
  FactoryTaskStatus,
  FactoryTaskType,
} from "@t3tools/contracts";
import { ChevronDownIcon, FilterIcon } from "lucide-react";

import { Button } from "../../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { Separator } from "../../ui/separator";
import { assigneeText, CountBadge, TASK_STATUS_VISUALS, TASK_TYPE_LABELS } from "../kit";
import { useTaskAssigneeChip } from "../shared";
import { activeFilterCount, type TaskFilterField } from "./tasksHome.logic";

const STATUS_OPTIONS: readonly FactoryTaskStatus[] = [
  "backlog",
  "ready",
  "in-progress",
  "in-review",
  "done",
  "canceled",
];
const TYPE_OPTIONS = Object.keys(TASK_TYPE_LABELS) as FactoryTaskType[];
const SOURCE_OPTIONS: readonly { value: FactoryTaskSourceKind; label: string }[] = [
  { value: "local", label: "Local" },
  { value: "issue", label: "Issue" },
  { value: "feed", label: "Feed" },
  { value: "schedule", label: "Schedule" },
];
const GROUP_LABELS = { status: "Status", assignee: "Assignee", project: "Project" } as const;
type TaskGrouping = keyof typeof GROUP_LABELS;

export interface AssigneeOption {
  readonly key: string;
  readonly assignee: FactoryTaskAssignee;
  readonly environmentId: EnvironmentId;
}

export function TasksToolbar({
  filters,
  grouping,
  assignees,
  countLabel,
  onToggleFilter,
  onClearFilters,
  onGroupingChange,
}: {
  filters: FactoryTaskCountInput;
  grouping: TaskGrouping;
  assignees: readonly AssigneeOption[];
  countLabel: string | null;
  onToggleFilter: (field: TaskFilterField, value: string) => void;
  onClearFilters: () => void;
  onGroupingChange: (grouping: TaskGrouping) => void;
}) {
  const active = activeFilterCount(filters);
  const checked = (field: TaskFilterField, value: string) =>
    (filters[field] as readonly string[] | undefined)?.includes(value) ?? false;
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 px-6">
      <Menu>
        <MenuTrigger render={<Button variant="outline" size="xs" />}>
          <FilterIcon aria-hidden />
          Filter
          {active > 0 ? <CountBadge count={active} /> : null}
        </MenuTrigger>
        <MenuPopup align="start" className="max-h-[min(32rem,var(--available-height))]">
          <MenuGroup>
            <MenuGroupLabel>Status</MenuGroupLabel>
            {STATUS_OPTIONS.map((status) => (
              <MenuCheckboxItem
                key={status}
                checked={checked("statuses", status)}
                onCheckedChange={() => onToggleFilter("statuses", status)}
              >
                {TASK_STATUS_VISUALS[status].label}
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Type</MenuGroupLabel>
            {TYPE_OPTIONS.map((type) => (
              <MenuCheckboxItem
                key={type}
                checked={checked("types", type)}
                onCheckedChange={() => onToggleFilter("types", type)}
              >
                {TASK_TYPE_LABELS[type]}
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Source</MenuGroupLabel>
            {SOURCE_OPTIONS.map((source) => (
              <MenuCheckboxItem
                key={source.value}
                checked={checked("sourceKinds", source.value)}
                onCheckedChange={() => onToggleFilter("sourceKinds", source.value)}
              >
                {source.label}
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
          {assignees.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Assignee</MenuGroupLabel>
                {assignees.map((option) => (
                  <AssigneeFilterItem
                    key={option.key}
                    option={option}
                    checked={checked("assigneeKeys", option.assignee.key)}
                    onToggle={() => onToggleFilter("assigneeKeys", option.assignee.key)}
                  />
                ))}
              </MenuGroup>
            </>
          ) : null}
          {active > 0 ? (
            <>
              <MenuSeparator />
              <MenuItem onClick={onClearFilters}>Clear filters</MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      <Separator orientation="vertical" className="h-5" />
      <Menu>
        <MenuTrigger render={<Button variant="ghost-muted" size="xs" />}>
          Group
          <span className="text-foreground">{GROUP_LABELS[grouping]}</span>
          <ChevronDownIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuRadioGroup
            value={grouping}
            onValueChange={(value: TaskGrouping) => onGroupingChange(value)}
          >
            {(Object.keys(GROUP_LABELS) as TaskGrouping[]).map((value) => (
              <MenuRadioItem key={value} value={value} closeOnClick>
                {GROUP_LABELS[value]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      {countLabel ? (
        <span className="ms-auto text-muted-foreground text-xs tabular-nums">{countLabel}</span>
      ) : null}
    </div>
  );
}

function AssigneeFilterItem({
  option,
  checked,
  onToggle,
}: {
  option: AssigneeOption;
  checked: boolean;
  onToggle: () => void;
}) {
  const chip = useTaskAssigneeChip(option.assignee, option.environmentId);
  return (
    <MenuCheckboxItem checked={checked} onCheckedChange={onToggle}>
      {assigneeText(chip)}
    </MenuCheckboxItem>
  );
}
