import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, FactoryTaskKind, type ProjectId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useEffect, useId, useRef, useState } from "react";

import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { createFactoryTask, startFactoryTask } from "./state";
import { StartFailure } from "./TaskPanel";
import { TASK_KIND_LABELS } from "./WorkBoard";

const NO_PROJECT = "";

/**
 * A task to add to the board of the environment it was opened on: what it is, its project, and
 * whether to start it right away.
 */
export function NewTaskDialog({
  environmentId,
  environmentLabel,
  connected,
  projects,
  projectId,
  onClose,
  onOpenTask,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /** Whether that environment is still connected; nothing is sent while it is not. */
  readonly connected: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** The project it starts in, or null for none. */
  readonly projectId: ProjectId | null;
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const id = useId();
  const canCreate = useAtomValue(createFactoryTask.permissionAtom(environmentId));
  const canStart = useAtomValue(startFactoryTask.permissionAtom(environmentId));
  const create = useAtomCommand(createFactoryTask, {
    label: "factory task create",
    reportFailure: false,
  });
  const start = useAtomCommand(startFactoryTask, {
    label: "factory task start",
    reportFailure: false,
  });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [project, setProject] = useState(projectId);
  const [kind, setKind] = useState<FactoryTaskKind>("software");
  const [startNow, setStartNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Set once the task exists but did not start, so submitting again opens it instead of a copy.
  const [created, setCreated] = useState<{
    readonly taskId: string;
    readonly error: unknown;
  } | null>(null);
  const pending = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- interrupts an in-flight create or start when the page closes the dialog, so nothing starts and nothing navigates after it is gone
  useEffect(() => () => pending.current?.abort(), []);
  const picked = projects.find((candidate) => candidate.id === project) ?? null;

  const submit = async () => {
    if (created !== null) return onOpenTask(created.taskId);
    const trimmed = title.trim();
    if (busy || !connected || trimmed === "") return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setProblem(null);
    const result = await create(
      {
        environmentId,
        input: {
          projectId: picked?.id ?? null,
          title: trimmed,
          ...(kind === "software" ? {} : { kind }),
          ...(description.trim() === "" ? {} : { description }),
        },
      },
      { signal: controller.signal },
    );
    if (controller.signal.aborted) return;
    if (result._tag === "Failure") {
      setBusy(false);
      if (!isAtomCommandInterrupted(result)) {
        setProblem(
          errorDisplayMessage(squashAtomCommandFailure(result), m) ??
            gt("Could not create the task."),
        );
      }
      return;
    }
    const taskId = result.value.id;
    if (!startNow) return onOpenTask(taskId);
    const started = await start(
      { environmentId, input: { taskId } },
      { signal: controller.signal },
    );
    if (controller.signal.aborted) return;
    setBusy(false);
    if (started._tag === "Success" || isAtomCommandInterrupted(started)) return onOpenTask(taskId);
    setCreated({ taskId, error: squashAtomCommandFailure(started) });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Once Create is pressed the dialog stays until create, and start when asked, settle.
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>New task</T>
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-title`}>
                  <T context="field: a task's title">Title</T>
                </Label>
                <Input
                  id={`${id}-title`}
                  value={title}
                  maxLength={200}
                  disabled={busy || created !== null}
                  onChange={(event) => setTitle(event.currentTarget.value)}
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
                  disabled={busy || created !== null}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">
                  <T context="field: what kind of work a task is">Kind</T>
                </span>
                <Select
                  value={kind}
                  disabled={busy || created !== null}
                  onValueChange={(value) =>
                    setKind(
                      FactoryTaskKind.literals.find((candidate) => candidate === value) ??
                        "software",
                    )
                  }
                >
                  <SelectTrigger
                    aria-label={gt("Kind", {
                      $context: "picker for what kind of work a new task is",
                    })}
                  >
                    <SelectValue>{m(TASK_KIND_LABELS[kind])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {FactoryTaskKind.literals.map((value) => (
                      <SelectItem key={value} value={value}>
                        {m(TASK_KIND_LABELS[value])}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">
                  <T context="field: the project a task belongs to">Project</T>
                </span>
                <Select
                  value={picked?.id ?? NO_PROJECT}
                  disabled={busy || created !== null}
                  onValueChange={(value) =>
                    setProject(projects.find((candidate) => candidate.id === value)?.id ?? null)
                  }
                >
                  <SelectTrigger
                    aria-label={gt("Project", { $context: "picker for a new task's project" })}
                  >
                    <SelectValue>{picked?.title ?? gt("No project")}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={NO_PROJECT}>
                      <T>No project</T>
                    </SelectItem>
                    {projects.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <Label>
                <Checkbox
                  checked={startNow}
                  disabled={!canStart || busy || created !== null}
                  onCheckedChange={(checked) => setStartNow(checked)}
                />
                <T context="checkbox: start the new task as soon as it is created">Start now</T>
              </Label>
              {connected ? null : (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {gt("{name} is not connected. Create the task once it reconnects.", {
                    name: environmentLabel,
                  })}
                </p>
              )}
              {problem === null ? null : (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {problem}
                </p>
              )}
              {created === null ? null : (
                <div className="flex flex-col gap-1">
                  <p className="text-sm">
                    <T>The task was created but did not start.</T>
                  </p>
                  <StartFailure error={created.error} />
                </div>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {created === null ? <T>Cancel</T> : <T context="verb, closes the dialog">Close</T>}
            </Button>
            <Button
              type="submit"
              disabled={
                created === null && (!connected || !canCreate || busy || title.trim() === "")
              }
            >
              {created === null ? <T>Create task</T> : <T>Open task</T>}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
