import { useAtomValue } from "@effect/atom-react";
import type {
  FactoryTaskAssignee,
  FactoryTaskAssignment,
  FactoryTaskRef,
  FactoryTaskSummary,
  FactoryTaskType,
} from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { FolderIcon } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { isMacPlatform } from "~/lib/utils";
import { factoryTasks, useFactoryTaskDetail } from "../../../state/factoryTasks";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { CommandDialog, CommandDialogPopup } from "../../ui/command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import { AssigneeChip, ProjectChip, TASK_TYPE_LABELS } from "../kit";
import { TaskAssigneePicker, useTaskSetup } from "../shared/taskAssignee";
import { useTaskScope } from "../shared/taskScope";
import { type TaskDialog, useTaskDialogStore } from "../taskDialogs";
import { useCaptureCommands } from "./captureCommands";
import { useCaptureProjects } from "./captureData";
import {
  assignmentRunsAgent,
  captureProjectKey,
  captureProjectLabel,
  type CaptureProject,
  matchDefaultProject,
  splitTaskText,
  TASK_DESCRIPTION_MAX,
} from "./captureModel";

type NewTaskDefaults = Omit<Extract<TaskDialog, { kind: "new-task" }>, "kind">;
const TASK_TYPES = Object.keys(TASK_TYPE_LABELS) as FactoryTaskType[];
const NO_PERMISSION = Atom.make(false);

interface ParentTask {
  readonly ref: FactoryTaskRef;
  readonly displayId: string;
  readonly assignee: FactoryTaskAssignee;
}

/** The capture composer. A sub-task reads its parent first, so Auto can follow it. */
export function NewTaskDialog({ defaults }: { defaults: NewTaskDefaults }) {
  return defaults.parent ? (
    <SubTaskGate defaults={defaults} parentRef={defaults.parent} />
  ) : (
    <NewTaskGate defaults={defaults} parent={null} />
  );
}

function SubTaskGate({
  defaults,
  parentRef,
}: {
  defaults: NewTaskDefaults;
  parentRef: FactoryTaskRef;
}) {
  const detail = useFactoryTaskDetail(parentRef);
  const gt = useGT();
  if (detail._tag === "Success")
    return (
      <NewTaskGate
        defaults={defaults}
        parent={{
          ref: parentRef,
          displayId: detail.value.task.displayId,
          assignee: detail.value.task.assignee,
        }}
      />
    );
  return (
    <MessageDialog
      title={gt("New sub-task")}
      message={
        detail._tag === "Failure"
          ? gt("The task could not be loaded. Try again.")
          : gt("Loading the task…")
      }
    />
  );
}

function NewTaskGate({
  defaults,
  parent,
}: {
  defaults: NewTaskDefaults;
  parent: ParentTask | null;
}) {
  const projects = useCaptureProjects();
  const gt = useGT();
  const fallback: CaptureProject | undefined = parent
    ? (projects.find(
        (candidate) =>
          candidate.environmentId === parent.ref.environmentId &&
          candidate.projectId === parent.ref.projectId,
      ) ?? {
        key: captureProjectKey(parent.ref.environmentId, parent.ref.projectId),
        environmentId: parent.ref.environmentId,
        projectId: parent.ref.projectId,
        name: "Project",
        machine: null,
      })
    : projects[0];
  if (fallback === undefined)
    return (
      <MessageDialog
        title={gt("New task")}
        message={gt("Add a project to the sidebar to create tasks in it.")}
      />
    );
  return (
    <NewTaskForm defaults={defaults} parent={parent} projects={projects} fallback={fallback} />
  );
}

/** The key hint inside the primary button. */
function ShortcutHint({ label }: { label: string }) {
  return (
    <kbd className="rounded bg-primary-foreground/16 px-1 font-sans text-primary-foreground/80 text-xs">
      {label}
    </kbd>
  );
}

function MessageDialog({ title, message }: { title: string; message: string }) {
  const close = useTaskDialogStore((state) => state.close);
  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <CommandDialogPopup aria-label={title}>
        <div className="flex flex-col gap-3 p-4">
          <p className="font-medium text-sm">{title}</p>
          <p className="text-muted-foreground text-sm">{message}</p>
          <div className="flex justify-end">
            <Button variant="outline" onClick={close}>
              <T>Close</T>
            </Button>
          </div>
        </div>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function NewTaskForm({
  defaults,
  parent,
  projects,
  fallback,
}: {
  defaults: NewTaskDefaults;
  parent: ParentTask | null;
  projects: readonly CaptureProject[];
  fallback: CaptureProject;
}) {
  const gt = useGT();
  const messages = useMessages();
  const close = useTaskDialogStore((state) => state.close);
  const scope = useTaskScope();
  const commands = useCaptureCommands();
  const navigate = useNavigate();
  const onTasksPage = useLocation({ select: (location) => location.pathname === "/tasks" });
  const headingId = useId();

  const [text, setText] = useState("");
  const [type, setType] = useState<FactoryTaskType>("task");
  const [assignment, setAssignment] = useState<FactoryTaskAssignment>(
    parent ? { mode: "auto" } : { mode: "unassigned" },
  );
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const defaultProject =
    matchDefaultProject(projects, defaults) ??
    projects.find(
      (candidate) =>
        candidate.environmentId === scope.single?.environmentId &&
        candidate.projectId === scope.single?.projectId,
    ) ??
    null;
  const chosen = projects.find((candidate) => candidate.key === chosenKey) ?? null;
  const project: CaptureProject | null = parent ? fallback : (chosen ?? defaultProject);

  // Without a project the hooks below read the first project's machine; nothing there is sent.
  const anchor = project ?? fallback;
  const { environmentId, projectId } = anchor;
  const setupState = useTaskSetup({
    environmentId,
    projectId,
    type,
    assignment,
    ...(parent
      ? { parent: { ref: parent.ref, displayId: parent.displayId, assignee: parent.assignee } }
      : {}),
  });
  const canCreate = useAtomValue(
    project ? factoryTasks.createTask.permissionAtom(project.environmentId) : NO_PERMISSION,
  );
  const canStart = useAtomValue(
    project ? factoryTasks.startTask.permissionAtom(project.environmentId) : NO_PERMISSION,
  );

  const { title, description } = splitTaskText(text);
  const tooLong = description.length > TASK_DESCRIPTION_MAX;
  const ready = project !== null && title.length > 0 && !tooLong && canCreate && !busy;
  const startable =
    assignmentRunsAgent(assignment) && setupState.setup !== null && canStart === true;
  const lane = defaults.lane ?? "backlog";
  const backlogLabel = lane === "ready" ? gt("Add to Ready") : gt("Add to backlog");
  const mac = isMacPlatform(navigator.platform);

  const requestClose = () => {
    if (busy) return;
    if (text.trim().length > 0) setConfirmingDiscard(true);
    else close();
  };

  const announce = (task: FactoryTaskSummary, refusal: string | null) => {
    if (refusal === null && onTasksPage) return;
    toastManager.add({
      title: gt("Added {displayId} to {where}", {
        displayId: task.displayId,
        where: lane === "ready" ? gt("Ready", { $context: "the Ready column" }) : gt("the backlog"),
      }),
      ...(refusal ? { description: refusal, type: "error" } : {}),
      ...(onTasksPage
        ? {}
        : {
            actionProps: {
              children: gt("Open {displayId}", { displayId: task.displayId }),
              onClick: () =>
                void navigate({
                  to: "/tasks/$environmentId/$displayId",
                  params: { environmentId: task.ref.environmentId, displayId: task.displayId },
                }),
            },
          }),
    });
  };

  const submit = async (kind: "backlog" | "start") => {
    if (!ready || project === null) return;
    setBusy(true);
    setError(null);
    const created = await commands.create(project.environmentId, {
      projectId: project.projectId,
      title,
      ...(description ? { description } : {}),
      type,
      ...(lane === "ready" ? { lane } : {}),
      assignment,
      ...(parent ? { parent: { rootId: parent.ref.rootId, taskId: parent.ref.taskId } } : {}),
    });
    if (!created.ok) {
      setBusy(false);
      setError(created.message);
      return;
    }
    const task = created.value.task;
    if (kind === "start" && setupState.setup) {
      const started = await commands.start(task, setupState.setup);
      close();
      if (!started.ok) announce(task, started.message);
      return;
    }
    close();
    announce(task, null);
  };

  const primary = () => void submit(startable ? "start" : "backlog");

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    primary();
  };

  const pickProject = (key: string) => {
    const next = projects.find((candidate) => candidate.key === key);
    if (!next) return;
    setChosenKey(key);
    if (
      next.environmentId !== project?.environmentId &&
      (assignment.mode === "profile" || assignment.mode === "pinned")
    )
      setAssignment({ mode: "unassigned" });
  };

  const assigneeTrigger = (
    <AssigneeChip
      assignee={setupState.assignee}
      render={<button type="button" disabled={project === null} />}
    />
  );
  const shortcut = mac ? "⌘↵" : "Ctrl ↵";

  return (
    <>
      <CommandDialog
        open
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <CommandDialogPopup
          className="max-w-3xl"
          {...(parent ? { "aria-labelledby": headingId } : { "aria-label": gt("New task") })}
        >
          <div className="flex flex-col" onKeyDown={onKeyDown}>
            {parent ? (
              <p id={headingId} className="px-3 pt-3 font-medium text-sm">
                <T>
                  New sub-task of <Var>{parent.displayId}</Var>
                </T>
              </p>
            ) : null}
            <Textarea
              unstyled
              autoFocus
              className="min-h-32 [&_textarea]:resize-none"
              aria-label={gt("What needs doing?")}
              placeholder={gt("What needs doing?")}
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
            />
            {error || tooLong ? (
              <p role="alert" className="px-4 pb-2 text-destructive-foreground text-xs">
                {error ?? gt("The description is over 8,000 characters.")}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {parent ? (
                  <ProjectChip name={project?.name ?? "Project"} />
                ) : (
                  <Select
                    value={project?.key ?? null}
                    onValueChange={(key) => key !== null && pickProject(key)}
                  >
                    <SelectTrigger
                      size="xs"
                      variant="ghost"
                      aria-label={gt("Project", { $context: "noun, the project picker" })}
                    >
                      <FolderIcon aria-hidden className="size-3 shrink-0" />
                      <SelectValue>
                        {project ? captureProjectLabel(project, projects) : gt("Choose a project")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {projects.map((candidate) => (
                        <SelectItem key={candidate.key} value={candidate.key}>
                          {captureProjectLabel(candidate, projects)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
                {project ? (
                  <TaskAssigneePicker
                    environmentId={project.environmentId}
                    projectId={project.projectId}
                    type={type}
                    value={assignment}
                    onChange={setAssignment}
                    trigger={assigneeTrigger}
                    allowUnassigned={parent === null}
                    {...(parent
                      ? {
                          parent: {
                            ref: parent.ref,
                            displayId: parent.displayId,
                            assignee: parent.assignee,
                          },
                        }
                      : {})}
                  />
                ) : (
                  assigneeTrigger
                )}
                <Select value={type} onValueChange={(value) => value !== null && setType(value)}>
                  <SelectTrigger
                    size="xs"
                    variant="ghost"
                    aria-label={gt("Type", { $context: "noun, the task type picker" })}
                  >
                    <SelectValue>{messages(TASK_TYPE_LABELS[type])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {TASK_TYPES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {messages(TASK_TYPE_LABELS[value])}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <Button
                variant={startable ? "outline" : "default"}
                disabled={!ready}
                onClick={() => void submit("backlog")}
              >
                {backlogLabel}
                {startable ? null : <ShortcutHint label={shortcut} />}
              </Button>
              <Button
                variant={startable ? "default" : "outline"}
                disabled={!ready || !startable}
                onClick={() => void submit("start")}
              >
                <T>Start now</T>
                {startable ? <ShortcutHint label={shortcut} /> : null}
              </Button>
            </div>
          </div>
        </CommandDialogPopup>
      </CommandDialog>
      <AlertDialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Discard this task?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>What you wrote is not saved yet.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Keep editing</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingDiscard(false);
                close();
              }}
            >
              <T>Discard</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
