import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  FactoryTaskType,
  type FactoryTaskDetail,
  type FactoryTaskStatus,
  type FactoryTaskSummary,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, BanIcon, FolderIcon, LockIcon, type LucideIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";

import { useNowMinute } from "../../../hooks/useNowMinute";
import { useProject } from "../../../state/entities";
import { useFactoryTaskLiveState } from "../../../state/factoryTasks";
import { useEnvironmentPresentation } from "../../../state/presentation";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import {
  PropertyList,
  PropertyRow,
  RunRow,
  SectionHeader,
  TASK_STATUS_VISUALS,
  TASK_TYPE_LABELS,
  TaskStatusLabel,
} from "../kit";
import { SOURCE_ICONS } from "../kit/taskVisuals";
import { TaskAssigneeEditor, useTaskActions, useTaskCatalog, useTaskPermissions } from "../shared";
import { presentTaskSetup } from "../shared/taskAssigneeModel";
import { runDetailLine, runStateWord } from "./taskRuns";

/** The properties rail: what the task is, its runs, and the tasks it sits between. */
export function TaskRail({ detail }: { detail: FactoryTaskDetail }) {
  const { task } = detail;
  const { environmentId } = task.ref;
  const project = useProject(scopeProjectRef(environmentId, task.ref.projectId));
  const SourceIcon = SOURCE_ICONS[task.source.kind];
  const parent = detail.ancestors.at(-1);
  const gt = useGT();
  const related = [
    ...(parent
      ? [{ kind: msg("Parent", { $context: "task lineage" }), Icon: ArrowUpIcon, task: parent }]
      : []),
    ...detail.blockedBy.map((blocker) => ({
      kind: msg("Blocked by", { $context: "task lineage" }),
      Icon: LockIcon,
      task: blocker,
    })),
    ...detail.blocks.map((blocked) => ({
      kind: msg("Blocks", { $context: "task lineage" }),
      Icon: BanIcon,
      task: blocked,
    })),
  ];
  return (
    <aside aria-label={gt("Properties")} className="flex min-w-0 flex-col gap-6">
      <PropertyList>
        <PropertyRow label={gt("Status")}>
          <TaskStatusLabel status={task.status} />
        </PropertyRow>
        <PropertyRow label={gt("Assignee")}>
          <TaskAssigneeEditor task={task} />
        </PropertyRow>
        <PropertyRow label={gt("Owner")}>
          <T>You</T>
        </PropertyRow>
        <PropertyRow label={gt("Project")}>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{project?.title ?? task.ref.projectId}</span>
          </span>
        </PropertyRow>
        <PropertyRow label={gt("Source")}>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <SourceIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            {task.source.url ? (
              <a
                href={task.source.url}
                target="_blank"
                rel="noreferrer"
                className="truncate underline-offset-4 hover:underline"
              >
                {task.source.label}
              </a>
            ) : (
              <span className="truncate">{task.source.label}</span>
            )}
          </span>
        </PropertyRow>
        <PropertyRow label={gt("Type")}>
          <TaskTypeSelect task={task} />
        </PropertyRow>
      </PropertyList>
      <section aria-label={gt("Runs")} className="flex flex-col gap-2">
        <SectionHeader title={gt("Runs")} />
        <TaskRuns detail={detail} />
      </section>
      {related.length > 0 ? (
        <section aria-label={gt("Related")} className="flex flex-col gap-2">
          <SectionHeader title={gt("Related")} />
          <ul className="flex flex-col gap-2">
            {related.map((entry) => (
              <li key={`${entry.kind}:${entry.task.taskId}`}>
                <LineageRow
                  environmentId={environmentId}
                  kind={entry.kind}
                  Icon={entry.Icon}
                  task={entry.task}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

function TaskTypeSelect({ task }: { task: FactoryTaskSummary }) {
  const { update: canUpdate } = useTaskPermissions(task.ref.environmentId);
  const actions = useTaskActions();
  const gt = useGT();
  const messages = useMessages();
  return (
    <Select
      value={task.type}
      disabled={!canUpdate}
      onValueChange={(next) => {
        if (next !== null && next !== task.type) void actions.update(task, { type: next });
      }}
    >
      <SelectTrigger size="xs" variant="ghost" aria-label={gt("Type")}>
        <SelectValue>{messages(TASK_TYPE_LABELS[task.type])}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {FactoryTaskType.literals.map((type) => (
          <SelectItem key={type} value={type}>
            {messages(TASK_TYPE_LABELS[type])}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** One row per run, newest first; each opens that run's thread. */
function TaskRuns({ detail }: { detail: FactoryTaskDetail }) {
  const { task } = detail;
  const { environmentId } = task.ref;
  const live = useFactoryTaskLiveState(task);
  const catalog = useTaskCatalog(environmentId);
  const machine = useEnvironmentPresentation(environmentId).presentation?.entry.target.label;
  const navigate = useNavigate();
  const nowMinute = useNowMinute();
  const messages = useMessages();
  const now = Date.parse(`${nowMinute}:00Z`);
  if (detail.runs.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        <T>No runs yet</T>
      </p>
    );
  return (
    <ul className="flex flex-col gap-2">
      {detail.runs.map((run) => {
        const pill = live.liveRuns.find((entry) => entry.threadId === run.threadId)?.pill ?? null;
        const state = runStateWord(run, pill?.label ?? null, messages);
        return (
          <li key={run.runId}>
            <RunRow
              label={messages(
                msg("Run {ordinal} · {label}", {
                  ordinal: String(run.ordinal),
                  label: presentTaskSetup(run.setup, catalog).label,
                }),
              )}
              detail={runDetailLine(run, now, machine, messages)}
              stateLabel={state.label}
              tone={state.tone}
              onOpen={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(environmentId, run.threadId)),
                })
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

/** Parent, Blocked by or Blocks: the related task's id, title and status, linking to it. */
function LineageRow({
  environmentId,
  kind,
  Icon,
  task,
}: {
  environmentId: FactoryTaskSummary["ref"]["environmentId"];
  kind: string;
  Icon: LucideIcon;
  task: { displayId: string; title: string; status: FactoryTaskStatus };
}) {
  const messages = useMessages();
  return (
    <Link
      to="/tasks/$environmentId/$displayId"
      params={{ environmentId, displayId: task.displayId }}
      className="flex min-w-0 flex-col gap-0.5 rounded-md outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="flex-1">{messages(kind)}</span>
        <span>{messages(TASK_STATUS_VISUALS[task.status].label)}</span>
      </span>
      <span className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {task.displayId}
        </span>
        <span className="truncate">{task.title}</span>
      </span>
    </Link>
  );
}
