import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  type WorkflowRunNode,
} from "@t3tools/client-runtime/workflows";
import {
  type EnvironmentId,
  FactoryTaskError,
  type FactoryAttempt,
  type FactoryTask,
  type FactoryTaskLane,
  type FactoryTaskPatch,
  type FactoryTaskSummary,
  type WorkflowQuestion,
  type WorkflowRun,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages } from "gt-react";
import { PlayIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { RelativeLabel, WorkflowStateWord } from "../components/workflows/WorkflowRunFeed";
import { factoryTaskDetail, startFactoryTask, updateFactoryTask } from "./state";
import {
  currentDraft,
  draftAfterSave,
  draftConflict,
  draftFieldText,
  draftSave,
  editDraftField,
  editDraftNote,
  isDraftDirty,
  keepMine,
  takeTheirs,
  type TaskChange,
  type TaskDraft,
  type TaskDraftField,
  type TaskDraftSent,
} from "./taskDraft.logic";
import { taskNumber, WorkBadges } from "./WorkBoard";
import type { WorkCard } from "./workBoard.logic";

const isFactoryTaskError = Schema.is(FactoryTaskError);

const LANES: ReadonlyArray<{ readonly value: FactoryTaskLane; readonly label: string }> = [
  { value: "backlog", label: msg("Backlog", { $context: "task lane: not yet ready" }) },
  { value: "ready", label: msg("Ready", { $context: "task lane: ready to start" }) },
  { value: "doing", label: msg("Doing", { $context: "task lane: under way" }) },
  { value: "review", label: msg("Review", { $context: "task lane: in review" }) },
  { value: "done", label: msg("Done", { $context: "task lane: finished" }) },
  {
    value: "dropped",
    label: msg("Dropped", { $context: "task lane: no longer to be done, off the board" }),
  },
];

const CHANGE_LABELS: Record<TaskChange, string> = {
  title: msg("Title", { $context: "a field of a task that changed elsewhere" }),
  description: msg("Description", { $context: "a field of a task that changed elsewhere" }),
  assignee: msg("Assignee", { $context: "a field of a task that changed elsewhere" }),
  lane: msg("Lane", { $context: "a field of a task that changed elsewhere" }),
  parent: msg("Part of", { $context: "a task's parent, which changed elsewhere" }),
  blockers: msg("Blocked by", { $context: "a task's blockers, which changed elsewhere" }),
  model: msg("Model", { $context: "a field of a task that changed elsewhere" }),
  project: msg("Project", { $context: "a field of a task that changed elsewhere" }),
};

const NO_PARENT = "";

/** Unsaved edits by environment and task, so a dropped connection or a remount keeps them. */
const savedDrafts = new Map<string, TaskDraft>();

/** Which control a failed save belongs beside. */
type TaskControl = "fields" | "lane" | "parent" | "blockers" | "note";

/** Why a task did not start, with the way to fix it where there is one. */
export function StartFailure({ error }: { readonly error: unknown }) {
  const gt = useGT();
  const m = useMessages();
  return (
    <p role="alert" className="text-xs text-destructive-foreground">
      {isFactoryTaskError(error) && error.reason === "workflows-off" ? (
        <T>
          Workflows are off on this server. Turn them on in{" "}
          <Link to="/settings/labs" className="underline underline-offset-2">
            Settings → Labs
          </Link>
          , then start the task again.
        </T>
      ) : isFactoryTaskError(error) && error.reason === "workflow-missing" ? (
        <T>The Factory workflow pack is not installed on this server.</T>
      ) : (
        (errorDisplayMessage(error, m) ?? gt("Could not start the task."))
      )}
    </p>
  );
}

/** One task read from its server: its fields to edit, what it hangs on, its attempts and notes. */
export function TaskPanel({
  environmentId,
  taskId,
  card,
  tasks,
  runs,
  questions,
  onOpenTask,
  onOpenRun,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  /** The task's card on the board; null while the live list does not have it. */
  readonly card: WorkCard | null;
  readonly tasks: ReadonlyArray<FactoryTaskSummary>;
  readonly runs: ReadonlyArray<WorkflowRun>;
  readonly questions: ReadonlyArray<WorkflowQuestion>;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const id = useId();
  const detail = useEnvironmentQuery(factoryTaskDetail({ environmentId, input: { taskId } }));
  const canUpdate = useAtomValue(updateFactoryTask.permissionAtom(environmentId));
  const canStart = useAtomValue(startFactoryTask.permissionAtom(environmentId));
  const update = useAtomCommand(updateFactoryTask, {
    label: "factory task update",
    reportFailure: false,
  });
  const start = useAtomCommand(startFactoryTask, {
    label: "factory task start",
    reportFailure: false,
  });
  const draftKey = JSON.stringify([environmentId, taskId]);
  const [stored, setStored] = useState(() => savedDrafts.get(draftKey));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{
    readonly control: TaskControl;
    readonly message: string;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const [startFailure, setStartFailure] = useState<{ readonly error: unknown } | null>(null);
  // The blockers picked while their list is open; saved once it closes.
  const [blockerPick, setBlockerPick] = useState<ReadonlyArray<string> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus to the panel when it opens, and back to the card or row that opened it when it closes
  useEffect(() => {
    heading.current?.focus();
    return () => {
      const back =
        opener !== null && opener !== document.body && opener.isConnected
          ? opener
          : document.querySelector<HTMLElement>(`[data-work-task="${CSS.escape(taskId)}"]`);
      back?.focus();
    };
  }, [opener, taskId]);
  const store = (next: TaskDraft) => {
    savedDrafts.set(draftKey, next);
    setStored(next);
  };
  const loaded = detail.data;
  const shell = (label: ReactNode, body: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 border-b ps-4 pe-2">
        <h2
          ref={heading}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate font-mono text-sm font-medium outline-none"
        >
          {label}
        </h2>
        {card === null ? null : <WorkBadges badges={card.badges} />}
        <Button size="icon-sm" variant="ghost" aria-label={gt("Close the task")} onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {body}
    </div>
  );
  if (loaded === null) {
    const missing = isFactoryTaskError(detail.failure) && detail.failure.reason === "not-found";
    return shell(
      card === null ? null : taskNumber(card.task),
      <p
        role={detail.error === null ? "status" : "alert"}
        className="p-4 text-sm text-muted-foreground"
      >
        {missing ? (
          <T>This server has no task with that link.</T>
        ) : detail.error === null ? (
          <T>Loading the task…</T>
        ) : (
          detail.error
        )}
      </p>,
    );
  }
  const latest = loaded.task;
  const draft = currentDraft(stored, latest);
  const base = draft.base;
  // A save's own write lands in the read before its answer does; that is not another writer.
  const conflict = saving ? null : draftConflict(draft, latest);
  const dirty = isDraftDirty(draft);
  const locked = !canUpdate || saving || conflict !== null;
  const title = draftFieldText(draft, "title");
  const description = draftFieldText(draft, "description");
  const assignee = draftFieldText(draft, "assignee");
  const laneLabel = LANES.find((candidate) => candidate.value === base.lane)?.label;
  const others = tasks.filter((candidate) => candidate.id !== taskId);
  const nameOf = (otherId: string) => {
    const other = tasks.find((candidate) => candidate.id === otherId);
    return other === undefined ? otherId.slice(0, 8) : `${taskNumber(other)} ${other.title}`;
  };
  const blockers = blockerPick ?? base.blockedBy;
  const unlisted = [
    ...new Set([...(base.parentId === null ? [] : [base.parentId]), ...blockers]),
  ].filter((otherId) => !others.some((candidate) => candidate.id === otherId));
  const nodes = allWorkflowRunNodes(groupWorkflowRuns([], runs, questions));
  const latestAttempt = loaded.attempts.at(-1) ?? null;
  const latestRun =
    latestAttempt === null || latestAttempt.runId === null
      ? null
      : (runs.find((run) => run.runId === latestAttempt.runId) ?? null);
  const running = latestRun !== null && latestRun.endedAt === null;
  const problemFor = (control: TaskControl) =>
    problem === null || problem.control !== control ? null : (
      <p role="alert" className="text-xs text-destructive-foreground">
        {problem.message}
      </p>
    );

  const edit = (field: TaskDraftField, value: string) =>
    store(editDraftField(currentDraft(savedDrafts.get(draftKey), latest), field, value));
  const send = async (
    control: TaskControl,
    sent: TaskDraftSent,
    patch: FactoryTaskPatch,
    note?: string,
  ): Promise<FactoryTask | null> => {
    setSaving(true);
    setProblem(null);
    const result = await update({
      environmentId,
      input: { taskId, rev: sent.rev, patch, ...(note === undefined ? {} : { note }) },
    });
    setSaving(false);
    if (result._tag === "Success") {
      store(draftAfterSave(savedDrafts.get(draftKey), sent, result.value));
      return result.value;
    }
    if (isAtomCommandInterrupted(result)) return null;
    const error = squashAtomCommandFailure(result);
    if (isFactoryTaskError(error) && error.reason === "conflict") {
      detail.refresh();
      setProblem({
        control,
        message: gt("This task changed elsewhere and was reloaded. Try again."),
      });
      return null;
    }
    setProblem({
      control,
      message: errorDisplayMessage(error, m) ?? gt("Could not save the task."),
    });
    return null;
  };
  const saveFields = () => {
    const save = draftSave(currentDraft(savedDrafts.get(draftKey), latest));
    if (Object.keys(save.patch).length > 0) void send("fields", save.sent, save.patch);
  };
  const addNote = () => {
    const current = currentDraft(savedDrafts.get(draftKey), latest);
    const text = current.note.trim();
    if (text === "") return;
    void send("note", { rev: current.base.rev, fields: {}, note: current.note }, {}, text);
  };
  const undoDrop = async (dropped: FactoryTask, lane: FactoryTaskLane) => {
    const result = await update({
      environmentId,
      input: { taskId, rev: dropped.rev, patch: { lane } },
    });
    if (result._tag === "Success") {
      store(
        draftAfterSave(savedDrafts.get(draftKey), { rev: dropped.rev, fields: {} }, result.value),
      );
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title: gt("Could not put {task} back", { task: taskNumber(dropped) }),
      description:
        errorDisplayMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
    });
  };
  const moveLane = async (value: string | null) => {
    const lane = LANES.find((candidate) => candidate.value === value)?.value;
    if (lane === undefined || lane === base.lane) return;
    const previous = base.lane;
    const saved = await send("lane", { rev: base.rev, fields: {} }, { lane });
    if (saved === null || lane !== "dropped") return;
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: gt("{task} was dropped", { task: taskNumber(saved) }),
        actionProps: {
          children: gt("Undo", { $context: "verb, puts a dropped task back in its lane" }),
          onClick: () => void undoDrop(saved, previous),
        },
      }),
    );
  };
  const setParent = (value: string | null) => {
    const parentId = value === null || value === NO_PARENT ? null : value;
    if (parentId === base.parentId) return;
    void send("parent", { rev: base.rev, fields: {} }, { parentId });
  };
  const commitBlockers = (open: boolean) => {
    if (open || blockerPick === null) return;
    setBlockerPick(null);
    if (blockerPick.join("\n") === base.blockedBy.join("\n")) return;
    void send("blockers", { rev: base.rev, fields: {} }, { blockedBy: blockerPick });
  };
  const startTask = async () => {
    setStarting(true);
    setStartFailure(null);
    const result = await start({ environmentId, input: { taskId } });
    setStarting(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setStartFailure({ error: squashAtomCommandFailure(result) });
    }
  };
  const theirValue = (change: TaskChange, theirs: FactoryTask) => {
    switch (change) {
      case "title":
        return theirs.title;
      case "assignee":
        return theirs.assignee ?? gt("Nobody", { $context: "a task with no assignee" });
      case "lane": {
        const label = LANES.find((candidate) => candidate.value === theirs.lane)?.label;
        return label === undefined ? theirs.lane : m(label);
      }
      case "parent":
        return theirs.parentId === null
          ? gt("None", { $context: "a task that is part of no other" })
          : nameOf(theirs.parentId);
      default:
        return null;
    }
  };

  return shell(
    taskNumber(base),
    <div className="min-h-0 flex-1">
      <ScrollArea>
        <div className="flex flex-col gap-6 p-4">
          {conflict === null ? null : (
            <section
              role="alert"
              className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/8 p-3 text-sm"
            >
              <p className="font-medium">
                <T>This task changed elsewhere</T>
              </p>
              {conflict.changed.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  <T>Only its revision moved; none of its fields changed.</T>
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {conflict.changed.map((change) => {
                    const value = theirValue(change, conflict.theirs);
                    return (
                      <li key={change} className="wrap-anywhere">
                        <span className="font-medium text-foreground">
                          {m(CHANGE_LABELS[change])}
                        </span>
                        {value === null ? null : <span>: {value}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    store(
                      keepMine(currentDraft(savedDrafts.get(draftKey), latest), conflict.theirs),
                    )
                  }
                >
                  <T context="keep my unsaved edits over the other version of the task">
                    Keep mine
                  </T>
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    store(
                      takeTheirs(currentDraft(savedDrafts.get(draftKey), latest), conflict.theirs),
                    )
                  }
                >
                  <T context="drop my unsaved edits for the other version of the task">
                    Use theirs
                  </T>
                </Button>
              </div>
            </section>
          )}
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!locked && dirty && title.trim() !== "") saveFields();
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-title`}>
                <T context="field: a task's title">Title</T>
              </Label>
              <Input
                id={`${id}-title`}
                value={title}
                maxLength={200}
                disabled={!canUpdate}
                onChange={(event) => edit("title", event.currentTarget.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-description`}>
                <T context="field: a task's description">Description</T>
              </Label>
              <Textarea
                id={`${id}-description`}
                value={description}
                rows={4}
                maxLength={8000}
                disabled={!canUpdate}
                onChange={(event) => edit("description", event.currentTarget.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-assignee`}>
                <T context="field: who a task is assigned to">Assignee</T>
              </Label>
              <Input
                id={`${id}-assignee`}
                value={assignee}
                maxLength={100}
                placeholder={gt("Nobody", { $context: "a task with no assignee" })}
                disabled={!canUpdate}
                onChange={(event) => edit("assignee", event.currentTarget.value)}
              />
            </div>
            {problemFor("fields")}
            <div className="flex justify-end gap-2">
              {dirty ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => store({ ...draft, fields: {} })}
                >
                  <T context="verb, drops unsaved edits">Discard</T>
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={locked || !dirty || title.trim() === ""}>
                <T context="verb, saves the task">Save</T>
              </Button>
            </div>
          </form>

          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                <T context="field: the lane a task is in">Lane</T>
              </span>
              <Select
                value={base.lane}
                onValueChange={(value) => void moveLane(value)}
                disabled={locked}
              >
                <SelectTrigger aria-label={gt("Lane", { $context: "picker that moves a task" })}>
                  <SelectValue>{laneLabel === undefined ? base.lane : m(laneLabel)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {LANES.map((lane) => (
                    <SelectItem key={lane.value} value={lane.value}>
                      {m(lane.label)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {problemFor("lane")}
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                <T context="field: the task this one is part of">Part of</T>
              </span>
              <Select
                value={base.parentId ?? NO_PARENT}
                onValueChange={setParent}
                disabled={locked}
              >
                <SelectTrigger
                  aria-label={gt("Part of", {
                    $context: "picker for the task this one is part of",
                  })}
                >
                  <SelectValue>
                    {base.parentId === null
                      ? gt("None", { $context: "a task that is part of no other" })
                      : nameOf(base.parentId)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={NO_PARENT}>
                    <T context="a task that is part of no other">None</T>
                  </SelectItem>
                  {others.map((other) => (
                    <SelectItem key={other.id} value={other.id}>
                      {`${taskNumber(other)} ${other.title}`}
                    </SelectItem>
                  ))}
                  {unlisted.map((otherId) => (
                    <SelectItem key={otherId} value={otherId}>
                      {nameOf(otherId)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {base.parentId === null ? null : (
                <div className="flex flex-wrap gap-1.5">
                  <TaskChip taskId={base.parentId} tasks={tasks} onOpenTask={onOpenTask} />
                </div>
              )}
              {problemFor("parent")}
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                <T context="field: the tasks this one waits on">Blocked by</T>
              </span>
              <Select
                multiple
                value={blockers}
                onValueChange={(value) => setBlockerPick(value)}
                onOpenChange={commitBlockers}
                disabled={locked}
              >
                <SelectTrigger
                  aria-label={gt("Blocked by", {
                    $context: "picker for the tasks this one waits on",
                  })}
                >
                  <SelectValue>
                    {blockers.length === 0
                      ? gt("None", { $context: "a task that waits on no other" })
                      : blockers.map(nameOf).join(", ")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {others.map((other) => (
                    <SelectItem key={other.id} value={other.id}>
                      {`${taskNumber(other)} ${other.title}`}
                    </SelectItem>
                  ))}
                  {unlisted.map((otherId) => (
                    <SelectItem key={otherId} value={otherId}>
                      {nameOf(otherId)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {base.blockedBy.length === 0 ? null : (
                <div className="flex flex-wrap gap-1.5">
                  {base.blockedBy.map((blocker) => (
                    <TaskChip
                      key={blocker}
                      taskId={blocker}
                      tasks={tasks}
                      onOpenTask={onOpenTask}
                    />
                  ))}
                </div>
              )}
              {problemFor("blockers")}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
                <T context="the times work on a task was started">Attempts</T>
              </h3>
              <Button
                size="sm"
                variant="outline"
                disabled={!canStart || starting || running}
                onClick={() => void startTask()}
              >
                <PlayIcon />
                <T context="verb, starts work on the task">Start</T>
              </Button>
            </div>
            {startFailure === null ? null : <StartFailure error={startFailure.error} />}
            {loaded.attempts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>Not started yet.</T>
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {[...loaded.attempts].reverse().map((attempt) => (
                  <AttemptRow
                    key={attempt.n}
                    attempt={attempt}
                    node={
                      attempt.runId === null
                        ? null
                        : (nodes.find((node) => node.run.runId === attempt.runId) ?? null)
                    }
                    onOpenRun={onOpenRun}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              <T context="notes on a task">Notes</T>
            </h3>
            {loaded.notes.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>No notes yet.</T>
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {loaded.notes.map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-0.5">
                    <span className="flex gap-2 text-xs text-muted-foreground">
                      <span className="min-w-0 flex-1 truncate">
                        {entry.by === "client" ? (
                          <T context="the author of a note written on this page">You</T>
                        ) : (
                          entry.by
                        )}
                      </span>
                      <RelativeLabel value={entry.at} />
                    </span>
                    <p className="text-sm whitespace-pre-wrap wrap-anywhere">{entry.text}</p>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!locked) addNote();
              }}
            >
              <Textarea
                value={draft.note}
                rows={2}
                maxLength={4000}
                placeholder={gt("Add a note")}
                aria-label={gt("Note", { $context: "field: a note to add to the task" })}
                disabled={!canUpdate}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  store(editDraftNote(currentDraft(savedDrafts.get(draftKey), latest), value));
                }}
              />
              {problemFor("note")}
              <div className="flex justify-end">
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={locked || draft.note.trim() === ""}
                >
                  <T context="verb, adds a note to the task">Add note</T>
                </Button>
              </div>
            </form>
          </section>
        </div>
      </ScrollArea>
    </div>,
  );
}

function TaskChip({
  taskId,
  tasks,
  onOpenTask,
}: {
  readonly taskId: string;
  readonly tasks: ReadonlyArray<FactoryTaskSummary>;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const other = tasks.find((candidate) => candidate.id === taskId);
  return (
    <Badge variant="outline" render={<button type="button" onClick={() => onOpenTask(taskId)} />}>
      <span className="max-w-56 truncate">
        {other === undefined ? taskId.slice(0, 8) : `${taskNumber(other)} ${other.title}`}
      </span>
    </Badge>
  );
}

function AttemptRow({
  attempt,
  node,
  onOpenRun,
}: {
  readonly attempt: FactoryAttempt;
  /** Its run as the live list has it; null when the list does not have it. */
  readonly node: WorkflowRunNode | null;
  readonly onOpenRun: (runId: string) => void;
}) {
  const { runId } = attempt;
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      <span className="shrink-0 font-mono text-xs text-muted-foreground">#{attempt.n}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        <RelativeLabel value={attempt.startedAt} />
      </span>
      {node !== null ? (
        <WorkflowStateWord node={node} />
      ) : runId === null ? (
        <span className="text-xs text-muted-foreground">
          <T context="an attempt whose run never started">Did not start</T>
        </span>
      ) : null}
      {runId === null ? null : (
        <Button size="xs" variant="ghost" onClick={() => onOpenRun(runId)}>
          <T context="verb, opens the attempt's workflow run">Open run</T>
        </Button>
      )}
    </li>
  );
}
