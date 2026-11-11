import { useAtomValue } from "@effect/atom-react";
import type {
  FactoryTaskAssignee,
  FactoryTaskDetail,
  FactoryTaskPlanProposal,
  FactoryTaskSummary,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CircleIcon, LockIcon, SparklesIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { factoryTasks, useFactoryAgentProfiles } from "../../../state/factoryTasks";
import { InlineButton } from "../../ui/button";
import {
  AssigneeChip,
  type AssigneeChipProps,
  LivePill,
  NeedsYouBadge,
  SectionHeader,
  TaskIdText,
  TaskStatusIcon,
  TruncatedText,
} from "../kit";
import { resolveTaskStateMark, TaskAssigneeChip, useTaskCatalog, useTaskLive } from "../shared";
import { parentDecidedSetup, taskAssigneeChipProps } from "../shared/taskAssigneeModel";
import { LIVE_TONE_CLASSES } from "../kit/taskVisuals";
import { openNewTask, openTaskSetup } from "../taskDialogs";
import { planOrderNote } from "./taskPlanModel";

const ROW =
  "grid min-h-12 min-w-0 grid-cols-[1rem_3.5rem_minmax(0,1fr)_11rem_8rem] items-center gap-x-3 border-b border-border px-2 py-1.5";

/** Add sub-task and Ask an agent to propose sub-tasks, each unavailable without its permission. */
function useSubtaskEntries(task: FactoryTaskSummary) {
  const { environmentId } = task.ref;
  const canCreate = useAtomValue(factoryTasks.createTask.permissionAtom(environmentId));
  const canBreakDown = useAtomValue(
    factoryTasks.requestTaskBreakdown.permissionAtom(environmentId),
  );
  return {
    add: {
      label: "Add sub-task",
      onClick: () =>
        openNewTask({ environmentId, projectId: task.ref.projectId, parent: task.ref }),
      disabled: !canCreate,
    },
    breakDown: {
      label: "Ask an agent to propose sub-tasks…",
      onClick: () => openTaskSetup(task.ref, "break-down"),
      disabled: !canBreakDown,
    },
  };
}

/** The task's sub-tasks, or one quiet line with the two ways to make some. */
export function TaskSubtasks({ detail }: { detail: FactoryTaskDetail }) {
  const { task, subtasks } = detail;
  const entries = useSubtaskEntries(task);
  if (subtasks.length === 0)
    return (
      <section aria-label="Sub-tasks" className="flex flex-col gap-1">
        <SectionHeader title="Sub-tasks" />
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
          <InlineButton tone="muted" onClick={entries.add.onClick} disabled={entries.add.disabled}>
            {entries.add.label}
          </InlineButton>
          <span aria-hidden>·</span>
          <InlineButton
            tone="muted"
            onClick={entries.breakDown.onClick}
            disabled={entries.breakDown.disabled}
          >
            <SparklesIcon aria-hidden className="size-3.5" />
            {entries.breakDown.label}
          </InlineButton>
        </p>
      </section>
    );
  return (
    <section aria-label="Sub-tasks" className="flex flex-col">
      <SectionHeader
        title="Sub-tasks"
        {...(task.progress ? { meta: `${task.progress.done} of ${task.progress.total} done` } : {})}
        action={entries.add}
      />
      <ul className="flex flex-col">
        {subtasks.map((subtask) => (
          <li key={subtask.ref.taskId}>
            <SubtaskRow task={subtask} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One sub-task: status, id, title with its one note (the question it waits on, or its blocker),
 * assignee and live state. The row opens that task.
 */
function SubtaskRow({ task }: { task: FactoryTaskSummary }) {
  const { pill, needs } = useTaskLive(task);
  const own = needs.filter((need) => need.ref.taskId === task.ref.taskId);
  const ask = own.find((need) => need.reason === "question" || need.reason === "approve");
  const blocker = task.status === "ready" || task.status === "backlog" ? task.blockedBy[0] : null;
  const note = ask?.detail ?? (blocker ? `Blocked by ${blocker.displayId}` : null);
  // The blocker is the note here, so the mark speaks only for runs and asks.
  const mark = resolveTaskStateMark({ pill, needs: own, blockedBy: [] });
  return (
    <Link
      to="/tasks/$environmentId/$displayId"
      params={{ environmentId: task.ref.environmentId, displayId: task.displayId }}
      className={cn(
        ROW,
        "outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      {blocker ? (
        <LockIcon role="img" aria-label="Blocked" className="size-3.5 text-muted-foreground" />
      ) : (
        <TaskStatusIcon status={task.status} />
      )}
      <TaskIdText id={task.displayId} />
      <span className="flex min-w-0 flex-col">
        <TruncatedText text={task.title} className="text-sm" />
        {note ? (
          <span
            className={cn(
              "truncate text-xs",
              ask ? LIVE_TONE_CLASSES["awaiting-input"].text : "text-muted-foreground",
            )}
          >
            {note}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0">
        <TaskAssigneeChip assignee={task.assignee} environmentId={task.ref.environmentId} />
      </span>
      <span className="flex min-w-0 justify-end">
        {mark?.kind === "live" ? (
          <LivePill label={mark.pill.label} tone={mark.pill.tone} duration={mark.pill.duration} />
        ) : mark?.kind === "needs" ? (
          <NeedsYouBadge reason={mark.reason} />
        ) : null}
      </span>
    </Link>
  );
}

/** The sub-tasks an agent proposed, in order, before anyone approves them. */
export function ProposedSubtasks({
  task,
  proposal,
}: {
  task: FactoryTaskSummary;
  proposal: FactoryTaskPlanProposal;
}) {
  const chipFor = useProposalChips(task);
  return (
    <section aria-label="Sub-tasks" className="flex flex-col">
      <SectionHeader title="Sub-tasks" meta="Proposed" />
      <ol className="flex flex-col">
        {proposal.items.map((item, index) => (
          <li key={item.key} className={ROW}>
            <CircleIcon aria-hidden className="size-3.5 text-muted-foreground" />
            <TaskIdText id={String(index + 1)} />
            <span className="flex min-w-0 flex-col">
              <TruncatedText text={item.title} className="text-sm" />
              <span className="truncate text-muted-foreground text-xs">
                {planOrderNote(item, proposal.items)}
              </span>
            </span>
            <span className="flex min-w-0">
              <AssigneeChip assignee={chipFor(item.assignment)} />
            </span>
            <span aria-hidden />
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The chip a proposed item will have: a profile or pinned agent as named, and Auto as the parent
 * hands it down when the parent decides.
 */
export function useProposalChips(task: FactoryTaskSummary) {
  const catalog = useTaskCatalog(task.ref.environmentId);
  const profilesResult = useFactoryAgentProfiles(task.ref.environmentId);
  const profiles = profilesResult._tag === "Success" ? profilesResult.value.profiles : [];
  const inherited = parentDecidedSetup({ displayId: task.displayId, assignee: task.assignee });
  return (assignment: FactoryTaskAssignee["assignment"]): AssigneeChipProps => {
    const profile =
      assignment.mode === "profile"
        ? profiles.find((entry) => entry.profile.id === assignment.profileId)?.profile
        : undefined;
    const setup =
      assignment.mode === "pinned"
        ? assignment.setup
        : (profile?.setup ?? (assignment.mode === "auto" ? inherited : null));
    if (assignment.mode === "auto" && setup === null) return { kind: "auto" };
    return taskAssigneeChipProps(
      {
        assignment,
        key: "",
        resolved: setup
          ? {
              profile: profile ? { id: profile.id, name: profile.name } : null,
              setup,
              via: assignment.mode === "auto" ? "parent" : "assignment",
            }
          : null,
      },
      catalog,
    );
  };
}
