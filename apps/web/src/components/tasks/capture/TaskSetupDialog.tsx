import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  FactoryTaskAssignee,
  FactoryTaskAssignment,
  FactoryTaskDetail,
  FactoryTaskRef,
  FactoryTaskSummary,
  FactoryTaskWorkspace,
  RuntimeMode,
} from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ComponentProps, useContext, useState } from "react";

import {
  factoryTasks,
  useFactoryAgentProfiles,
  useFactoryTaskDetail,
} from "../../../state/factoryTasks";
import { runtimeModeConfig } from "../../chat/runtimeModeConfig";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import {
  Select,
  SelectButton,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { toastManager } from "../../ui/toast";
import { assigneeText } from "../kit";
import { TaskAssigneePicker, useTaskSetup } from "../shared/taskAssignee";
import { useTaskCatalog } from "../shared/taskCatalog";
import { autoDetailLine, type TaskAssigneeParent } from "../shared/taskAssigneeModel";
import { useTaskDefaultRuntimeMode } from "../shared/taskModelChoices";
import { useTaskDialogStore } from "../taskDialogs";
import { useCaptureCommands } from "./captureCommands";
import { useMachineLabel } from "./captureData";
import { assignmentRunsAgent, sameAssignment } from "./captureModel";

type Intent = "start" | "retry" | "break-down";
type Result<A> = AsyncResult.AsyncResult<A, unknown>;
const NO_DETAIL: Atom.Atom<Result<FactoryTaskDetail>> = Atom.make(AsyncResult.initial(false));
const NO_PREVIEW: Atom.Atom<Result<FactoryTaskAssignee>> = Atom.make(AsyncResult.initial(false));

const INTENT_COPY: Record<
  Intent,
  { title: (id: string) => string; primary: string; wait: string }
> = {
  start: { title: (id) => `Start ${id}`, primary: "Start", wait: "Can start when" },
  retry: { title: (id) => `Run ${id} again`, primary: "Retry", wait: "Can run again when" },
  "break-down": {
    title: (id) => `Break down ${id}`,
    primary: "Ask for a plan",
    wait: "Can start when",
  },
};
const RUNTIME_MODES = Object.keys(runtimeModeConfig) as RuntimeMode[];
const WORKSPACES: ReadonlyArray<{ value: FactoryTaskWorkspace; label: string }> = [
  { value: "worktree", label: "New worktree" },
  { value: "root", label: "Project checkout" },
];

/** The "who runs this and how" sheet for one task: start it, run it again, or ask for a breakdown. */
export function TaskSetupDialog({ taskRef, intent }: { taskRef: FactoryTaskRef; intent: Intent }) {
  const detail = useFactoryTaskDetail(taskRef);
  const close = useTaskDialogStore((state) => state.close);
  if (detail._tag === "Success") return <ParentGate task={detail.value.task} intent={intent} />;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-120">
        <DialogHeader>
          <DialogTitle>{intent === "break-down" ? "Break down task" : "Start task"}</DialogTitle>
          <DialogDescription>
            {detail._tag === "Failure" ? "The task could not be loaded." : "Loading the task…"}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A sub-task's parent can decide what Auto runs, so it is read before the sheet opens. */
function ParentGate({ task, intent }: { task: FactoryTaskSummary; intent: Intent }) {
  const parent = task.parent;
  const atom: Atom.Atom<Result<FactoryTaskDetail>> =
    parent === null
      ? NO_DETAIL
      : factoryTasks.readTask({
          environmentId: task.ref.environmentId,
          input: { task: { ref: { ...task.ref, taskId: parent.taskId } } },
        });
  const parentDetail = useAtomValue(atom);
  if (parent !== null && parentDetail._tag === "Initial") return null;
  return (
    <TaskSetupForm
      task={task}
      intent={intent}
      parent={
        parent !== null && parentDetail._tag === "Success"
          ? {
              ref: parentDetail.value.task.ref,
              displayId: parent.displayId,
              assignee: parentDetail.value.task.assignee,
            }
          : undefined
      }
    />
  );
}

function initialAssignment(task: FactoryTaskSummary): FactoryTaskAssignment {
  const { assignment } = task.assignee;
  return assignment.mode === "unassigned" || assignment.mode === "person"
    ? { mode: "auto" }
    : assignment;
}

function AssigneeField({ label, ...props }: { label: string } & ComponentProps<"button">) {
  return <SelectButton {...props}>{label}</SelectButton>;
}

/** Why Auto picked what it did, or the profile in use. Reads the same preview the setup does. */
function useAssigneeLine(input: {
  task: FactoryTaskSummary;
  assignment: FactoryTaskAssignment;
  parent: TaskAssigneeParent | undefined;
}): string | null {
  const { task, assignment, parent } = input;
  const { environmentId, projectId } = task.ref;
  const catalog = useTaskCatalog(environmentId);
  const profiles = useFactoryAgentProfiles(environmentId);
  const unchangedAuto =
    assignment.mode === "auto" && sameAssignment(assignment, task.assignee.assignment);
  const asksServer = assignment.mode === "auto" && !unchangedAuto;
  const preview = useAtomValue(
    asksServer
      ? factoryTasks.previewTaskAssignee({
          environmentId,
          input: {
            projectId,
            type: task.type,
            assignment,
            ...(parent?.ref ? { parent: parent.ref } : {}),
          },
        })
      : NO_PREVIEW,
  );
  if (assignment.mode === "profile") {
    const name =
      profiles._tag === "Success"
        ? profiles.value.profiles.find(({ profile }) => profile.id === assignment.profileId)
            ?.profile.name
        : undefined;
    return name ? `Uses the ${name} profile` : null;
  }
  if (assignment.mode !== "auto") return null;
  const context = { type: task.type, catalog, parentDisplayId: parent?.displayId };
  if (unchangedAuto) return autoDetailLine(task.assignee.resolved, context);
  if (preview._tag === "Success") return autoDetailLine(preview.value.resolved, context);
  return preview._tag === "Initial" ? "Looking up the agent…" : "Picks an agent when it starts";
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label render={<span />}>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

function TaskSetupForm({
  task,
  intent,
  parent,
}: {
  task: FactoryTaskSummary;
  intent: Intent;
  parent: TaskAssigneeParent | undefined;
}) {
  const close = useTaskDialogStore((state) => state.close);
  const registry = useContext(RegistryContext);
  const commands = useCaptureCommands();
  const navigate = useNavigate();
  const here = useLocation({ select: (location) => location.pathname });
  const machine = useMachineLabel(task.ref.environmentId);
  const { environmentId, projectId } = task.ref;
  const copy = INTENT_COPY[intent];

  const lastRun = intent === "retry" ? (task.run?.setup ?? null) : null;
  const defaultMode = useTaskDefaultRuntimeMode(environmentId, projectId);
  const [assignment, setAssignment] = useState(() => initialAssignment(task));
  const [mode, setMode] = useState<RuntimeMode | null>(lastRun?.runtimeMode ?? null);
  const [workspace, setWorkspace] = useState<FactoryTaskWorkspace | null>(
    lastRun?.workspace ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolved = useTaskSetup({
    environmentId,
    projectId,
    type: task.type,
    assignment,
    assignee: sameAssignment(assignment, task.assignee.assignment) ? task.assignee : undefined,
    ...(parent ? { parent } : {}),
  });
  const line = useAssigneeLine({ task, assignment, parent });
  const permitted = useAtomValue(
    (intent === "start"
      ? factoryTasks.startTask
      : intent === "retry"
        ? factoryTasks.retryTask
        : factoryTasks.requestTaskBreakdown
    ).permissionAtom(environmentId),
  );
  const canUpdate = useAtomValue(factoryTasks.updateTask.permissionAtom(environmentId));

  const planning = intent === "break-down";
  const base = assignmentRunsAgent(assignment) ? resolved.setup : null;
  const setup = base
    ? {
        ...base,
        runtimeMode: mode ?? base.runtimeMode,
        workspace: planning ? "root" : (workspace ?? base.workspace),
      }
    : null;
  const shownMode = setup?.runtimeMode ?? mode ?? defaultMode;
  const shownWorkspace = setup?.workspace ?? workspace ?? "worktree";
  const blockers = planning ? [] : task.blockedBy.map((blocker) => blocker.displayId);
  const changedAssignment = !sameAssignment(assignment, task.assignee.assignment);
  const ready =
    setup !== null &&
    permitted === true &&
    blockers.length === 0 &&
    !busy &&
    (intent !== "start" || !changedAssignment || canUpdate === true);

  const pick = (next: FactoryTaskAssignment) => {
    setAssignment(next);
    // Another assignee brings its own mode and workspace; a pin's new model does not.
    if (next.mode === "pinned" && assignment.mode === "pinned") return;
    setMode(null);
    setWorkspace(null);
  };

  const refused = (message: string, conflict: boolean) => {
    setBusy(false);
    setError(message);
    if (conflict)
      registry.refresh(
        factoryTasks.readTask({ environmentId, input: { task: { ref: task.ref } } }),
      );
  };

  const submit = async () => {
    if (!ready || setup === null) return;
    setBusy(true);
    setError(null);
    if (intent === "start") {
      let current = task;
      if (changedAssignment) {
        const updated = await commands.updateAssignment(task, assignment);
        if (!updated.ok) return refused(updated.message, updated.conflict);
        current = updated.value.task;
      }
      const started = await commands.start(current, setup);
      if (!started.ok) return refused(started.message, started.conflict);
    } else if (intent === "retry") {
      const retried = await commands.retry(task, setup);
      if (!retried.ok) return refused(retried.message, retried.conflict);
    } else {
      const asked = await commands.requestBreakdown(task, setup);
      if (!asked.ok) return refused(asked.message, asked.conflict);
      const path = `/tasks/${task.ref.environmentId}/${task.displayId}`;
      toastManager.add({
        title: `Asked for a plan for ${task.displayId}`,
        description: "Review it on the task page.",
        ...(here === path
          ? {}
          : {
              actionProps: {
                children: `Open ${task.displayId}`,
                onClick: () =>
                  void navigate({
                    to: "/tasks/$environmentId/$displayId",
                    params: { environmentId: task.ref.environmentId, displayId: task.displayId },
                  }),
              },
            }),
      });
    }
    close();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="max-w-120">
        <DialogHeader>
          <DialogTitle>{copy.title(task.displayId)}</DialogTitle>
          <DialogDescription>{task.title}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {blockers.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              <p className="font-medium text-sm">Waiting on {blockers.join(", ")}</p>
              <p className="text-muted-foreground text-xs">
                {copy.wait} {blockers.join(", ")} {blockers.length === 1 ? "is" : "are"} done.
              </p>
            </div>
          ) : null}
          <Field label="Assignee" hint={line}>
            <TaskAssigneePicker
              environmentId={environmentId}
              projectId={projectId}
              type={task.type}
              value={assignment}
              onChange={pick}
              trigger={<AssigneeField label={assigneeText(resolved.assignee)} />}
              {...(parent ? { parent } : {})}
              {...(assignment.mode === "auto" &&
              sameAssignment(assignment, task.assignee.assignment)
                ? {
                    autoResolution: {
                      resolved: task.assignee.resolved,
                      ...(parent ? { parentDisplayId: parent.displayId } : {}),
                    },
                  }
                : {})}
            />
          </Field>
          <Field label="Mode" hint={runtimeModeConfig[shownMode].description}>
            <Select
              value={shownMode}
              disabled={base === null}
              onValueChange={(value) => value !== null && setMode(value)}
            >
              <SelectTrigger aria-label="Mode">
                <SelectValue>{runtimeModeConfig[shownMode].label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {RUNTIME_MODES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {runtimeModeConfig[value].label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="Workspace">
            {planning ? (
              <Input readOnly aria-label="Workspace" value="Project checkout" />
            ) : (
              <Select
                value={shownWorkspace}
                disabled={base === null}
                onValueChange={(value) => value !== null && setWorkspace(value)}
              >
                <SelectTrigger aria-label="Workspace">
                  <SelectValue>
                    {WORKSPACES.find((entry) => entry.value === shownWorkspace)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {WORKSPACES.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </Field>
          <Field label="Machine">
            <Input readOnly aria-label="Machine" value={machine ?? ""} />
          </Field>
          {error ? (
            <p role="alert" className="text-destructive-foreground text-xs">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={!ready} onClick={() => void submit()}>
            {copy.primary}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
