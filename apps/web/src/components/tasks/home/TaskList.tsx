import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { factoryTaskKey } from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskStatus, FactoryTaskSummary } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, CornerDownRightIcon, PlusIcon } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { formatRelativeTime } from "../../../timestampFormat";
import { Button } from "../../ui/button";
import { CountBadge, ProjectChip, TASK_STATUS_VISUALS, TaskIdText, TaskStatusIcon } from "../kit";
import { TaskAssigneeChip, TaskStateMark } from "../shared";
import { taskItemKeyDown } from "./TaskCard";
import {
  isCreatableLane,
  laneAssignee,
  listResultText,
  listSections,
  type TaskListSection,
} from "./tasksHome.logic";

interface TaskListProps {
  readonly entries: readonly { readonly task: FactoryTaskSummary; readonly stale: boolean }[];
  readonly grouping: "status" | "assignee" | "project";
  readonly statuses: readonly FactoryTaskStatus[];
  /** Top-level counts from the server, for the status sections. */
  readonly counts: Readonly<Record<FactoryTaskStatus, number>>;
  readonly projectName: (task: FactoryTaskSummary) => string;
  readonly showProject: boolean;
  readonly peekKey: string | null;
  readonly onPeek: (task: FactoryTaskSummary) => void;
  readonly onOpen: (task: FactoryTaskSummary) => void;
  readonly onNewTask: (lane: "backlog" | "ready") => void;
}

type ListItem =
  | {
      readonly kind: "header";
      readonly key: string;
      readonly section: TaskListSection;
      readonly count: number;
      readonly open: boolean;
    }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly task: FactoryTaskSummary;
      readonly depth: number;
      readonly stale: boolean;
    };

const ROW_HEIGHT = 36;
const COLUMNS = {
  withProject: "grid-cols-[minmax(0,1fr)_132px_168px_168px_56px]",
  withoutProject: "grid-cols-[minmax(0,1fr)_168px_168px_56px]",
};

function focusIfListHasFocus(node: HTMLElement | null) {
  if (node === null) return;
  const active = document.activeElement;
  const list = node.closest("[data-task-list]");
  if (active === null || active === document.body || (list?.contains(active) ?? false))
    node.focus({ preventScroll: true });
}

export function TaskList(props: TaskListProps) {
  const listRef = useRef<LegendListRef | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(["done"]));
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00Z`);
  const stale = new Set(
    props.entries.filter((entry) => entry.stale).map((entry) => factoryTaskKey(entry.task.ref)),
  );
  const sections = listSections(
    props.entries.map((entry) => entry.task),
    props.grouping,
    props.statuses,
  );
  const items: ListItem[] = [];
  for (const section of sections) {
    const open = !collapsed.has(section.key);
    items.push({
      kind: "header",
      key: `section:${section.key}`,
      section,
      count:
        section.status === null
          ? section.rows.filter((row) => row.depth === 0).length
          : props.counts[section.status],
      open,
    });
    if (open)
      for (const row of section.rows) {
        const key = factoryTaskKey(row.task.ref);
        items.push({ kind: "row", key, task: row.task, depth: row.depth, stale: stale.has(key) });
      }
  }
  const rowIndexes = items.flatMap((item, index) => (item.kind === "row" ? [index] : []));
  const tabIndex =
    focusIndex !== null && rowIndexes.includes(focusIndex) ? focusIndex : rowIndexes[0];

  const toggle = (key: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const row =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>("[data-row-index]")
        : null;
    if (row === null) return;
    const position = rowIndexes.indexOf(Number(row.dataset.rowIndex));
    if (position === -1) return;
    const nextPosition =
      event.key === "ArrowDown"
        ? position + 1
        : event.key === "ArrowUp"
          ? position - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? rowIndexes.length - 1
              : null;
    if (nextPosition === null) return;
    const next = rowIndexes[nextPosition];
    if (next === undefined) return;
    event.preventDefault();
    setFocusIndex(next);
    void listRef.current?.scrollIndexIntoView({ index: next, animated: false });
    event.currentTarget.querySelector<HTMLElement>(`[data-row-index="${next}"]`)?.focus();
  };

  const columns = props.showProject ? COLUMNS.withProject : COLUMNS.withoutProject;
  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-2">
      <div
        aria-hidden
        className={cn(
          "grid h-8 shrink-0 items-center gap-x-4 px-3 text-muted-foreground text-xs",
          columns,
        )}
      >
        <span className="flex gap-4">
          <span className="w-12">ID</span>
          <span>Title</span>
        </span>
        {props.showProject ? <span>Project</span> : null}
        <span>Assignee</span>
        <span>Result</span>
        <span className="text-end">Updated</span>
      </div>
      <div
        data-task-list
        role="region"
        aria-label="Task list"
        className="min-h-0 flex-1"
        onKeyDown={onKeyDown}
      >
        <LegendList<ListItem>
          ref={listRef}
          data={items}
          extraData={[props.peekKey, focusIndex, tabIndex, nowMs, props.showProject]}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.kind}
          getFixedItemSize={() => ROW_HEIGHT}
          estimatedItemSize={ROW_HEIGHT}
          drawDistance={720}
          className="h-full overflow-x-hidden"
          renderItem={({ item, index }) =>
            item.kind === "header" ? (
              <SectionHeader
                item={item}
                grouping={props.grouping}
                projectName={props.projectName}
                onToggle={toggle}
                onNewTask={props.onNewTask}
              />
            ) : (
              <TaskRow
                item={item}
                index={index}
                columns={columns}
                showProject={props.showProject}
                projectName={props.projectName}
                selected={item.key === props.peekKey}
                tabbable={index === tabIndex}
                focused={index === focusIndex}
                nowMs={nowMs}
                onFocus={setFocusIndex}
                onPeek={props.onPeek}
                onOpen={props.onOpen}
              />
            )
          }
        />
      </div>
    </div>
  );
}

function SectionHeader({
  item,
  grouping,
  projectName,
  onToggle,
  onNewTask,
}: {
  item: Extract<ListItem, { kind: "header" }>;
  grouping: TaskListProps["grouping"];
  projectName: (task: FactoryTaskSummary) => string;
  onToggle: (key: string) => void;
  onNewTask: (lane: "backlog" | "ready") => void;
}) {
  const { section } = item;
  const Chevron = item.open ? ChevronDownIcon : ChevronRightIcon;
  const status = section.status;
  return (
    <div className="flex h-9 min-w-0 items-center gap-2 border-border border-b bg-muted/40 px-2">
      <button
        type="button"
        aria-expanded={item.open}
        onClick={() => onToggle(section.key)}
        className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Chevron aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {status !== null ? (
          <>
            <TaskStatusIcon status={status} />
            <span className="truncate font-medium">{TASK_STATUS_VISUALS[status].label}</span>
          </>
        ) : section.sample === null ? null : grouping === "project" ? (
          <ProjectChip name={projectName(section.sample)} />
        ) : (
          <TaskAssigneeChip
            assignee={laneAssignee(section.rows.map((row) => row.task)) ?? section.sample.assignee}
            environmentId={section.sample.ref.environmentId}
          />
        )}
        <CountBadge count={item.count} />
      </button>
      {status !== null && isCreatableLane(status) ? (
        <Button
          variant="ghost-muted"
          size="icon-xs"
          className="ms-auto"
          aria-label={`New task in ${TASK_STATUS_VISUALS[status].label}`}
          onClick={() => onNewTask(status)}
        >
          <PlusIcon aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

function TaskRow({
  item,
  index,
  columns,
  showProject,
  projectName,
  selected,
  tabbable,
  focused,
  nowMs,
  onFocus,
  onPeek,
  onOpen,
}: {
  item: Extract<ListItem, { kind: "row" }>;
  index: number;
  columns: string;
  showProject: boolean;
  projectName: (task: FactoryTaskSummary) => string;
  selected: boolean;
  tabbable: boolean;
  focused: boolean;
  nowMs: number;
  onFocus: (index: number) => void;
  onPeek: (task: FactoryTaskSummary) => void;
  onOpen: (task: FactoryTaskSummary) => void;
}) {
  const { task, depth } = item;
  const updated = formatRelativeTime(task.updatedAt, nowMs)?.value ?? "";
  return (
    <button
      type="button"
      ref={focused ? focusIfListHasFocus : undefined}
      data-row-index={index}
      data-task-row
      aria-pressed={selected}
      tabIndex={tabbable ? 0 : -1}
      onFocus={() => onFocus(index)}
      onClick={() => onPeek(task)}
      onDoubleClick={() => onOpen(task)}
      onKeyDown={(event) => taskItemKeyDown(event, task, { onPeek, onOpen })}
      className={cn(
        "grid h-9 w-full min-w-0 cursor-pointer items-center gap-x-4 border-border border-b px-3 text-start text-sm outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        columns,
        selected && "bg-accent",
        item.stale && "opacity-70",
      )}
    >
      <span className="flex min-w-0 items-center gap-4">
        <span
          className="flex shrink-0 items-center gap-1.5"
          style={depth > 0 ? { paddingInlineStart: `${(depth - 1) * 20}px` } : undefined}
        >
          {depth > 0 ? (
            <CornerDownRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
          ) : null}
          <span className={depth > 0 ? undefined : "w-12"}>
            <TaskIdText id={task.displayId} />
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{task.title}</span>
          <TaskStateMark task={task} />
        </span>
      </span>
      {showProject ? (
        <span className="flex min-w-0">
          <ProjectChip name={projectName(task)} />
        </span>
      ) : null}
      <span className="flex min-w-0">
        <TaskAssigneeChip assignee={task.assignee} environmentId={task.ref.environmentId} />
      </span>
      <span className="min-w-0 truncate text-muted-foreground text-xs">{listResultText(task)}</span>
      <span className="text-end text-muted-foreground text-xs tabular-nums">{updated}</span>
    </button>
  );
}
