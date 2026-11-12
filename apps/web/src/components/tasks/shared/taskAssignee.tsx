import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  FactoryAgentSetup,
  FactoryTaskAssignee,
  FactoryTaskAssigneePreviewInput,
  FactoryTaskAssignment,
  FactoryTaskDetail,
  FactoryTaskSummary,
  FactoryTaskType,
  ProjectId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ReactElement, useState } from "react";

import { factoryTasks, useFactoryAgentProfiles } from "../../../state/factoryTasks";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { toastManager } from "../../ui/toast";
import {
  AssigneeChip,
  type AssigneeChipProps,
  AssigneePicker,
  type AssigneePickerValue,
} from "../kit";
import { useTaskActions } from "./taskActions";
import { useTaskAssigneeChip } from "./taskAssigneeChip";
import {
  autoDetailLine,
  pickerValue,
  pinnedAssignment,
  presentTaskSetup,
  type TaskAssigneeParent,
  taskAssigneeChipProps,
} from "./taskAssigneeModel";
import { useTaskCatalog } from "./taskCatalog";
import { useTaskDefaultRuntimeMode, useTaskModelChoices } from "./taskModelChoices";

type Result<A> = AsyncResult.AsyncResult<A, unknown>;
const NO_PREVIEW: Atom.Atom<Result<FactoryTaskAssignee>> = Atom.make(AsyncResult.initial(false));
const NO_DETAIL: Atom.Atom<Result<FactoryTaskDetail>> = Atom.make(AsyncResult.initial(false));

/** Reads a preview only when the current task's own resolution cannot answer. */
function usePreview(environmentId: EnvironmentId, input: FactoryTaskAssigneePreviewInput | null) {
  const atom: Atom.Atom<Result<FactoryTaskAssignee>> =
    input === null ? NO_PREVIEW : factoryTasks.previewTaskAssignee({ environmentId, input });
  return useAtomValue(atom);
}

/** Uses the task's resolution or a preview with its full ancestor context. */
export function useTaskSetup(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly type: FactoryTaskType;
  readonly assignment: FactoryTaskAssignment;
  readonly parent?: TaskAssigneeParent | undefined;
  readonly assignee?: FactoryTaskAssignee | undefined;
}): { setup: FactoryAgentSetup | null; assignee: AssigneeChipProps; pending: boolean } {
  const catalog = useTaskCatalog(input.environmentId);
  const { assignment } = input;
  const local =
    assignment.mode === "pinned"
      ? assignment.setup
      : assignment.mode === "person" || assignment.mode === "unassigned"
        ? null
        : null;
  const asksServer =
    input.assignee === undefined &&
    local === null &&
    (assignment.mode === "auto" || assignment.mode === "profile");
  const preview = usePreview(
    input.environmentId,
    asksServer
      ? {
          projectId: input.projectId,
          type: input.type,
          assignment,
          ...(input.parent?.ref ? { parent: input.parent.ref } : {}),
        }
      : null,
  );
  if (input.assignee !== undefined)
    return {
      setup: input.assignee.resolved?.setup ?? null,
      assignee: taskAssigneeChipProps(input.assignee, catalog),
      pending: false,
    };
  if (!asksServer) {
    const assignee: FactoryTaskAssignee = {
      assignment,
      key: "",
      resolved: local ? { profile: null, setup: local, via: "assignment" } : null,
    };
    return { setup: local, assignee: taskAssigneeChipProps(assignee, catalog), pending: false };
  }
  if (preview._tag !== "Success")
    return {
      setup: null,
      assignee: assignment.mode === "auto" ? { kind: "auto" } : { kind: "unassigned" },
      pending: preview._tag === "Initial",
    };
  return {
    setup: preview.value.resolved?.setup ?? null,
    assignee: taskAssigneeChipProps(preview.value, catalog),
    pending: false,
  };
}

function useAutoDetail(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly type: FactoryTaskType;
  readonly parent: TaskAssigneeParent | undefined;
  readonly autoResolution: TaskAssigneePickerProps["autoResolution"];
}): string {
  const catalog = useTaskCatalog(input.environmentId);
  const local = input.autoResolution !== undefined;
  const preview = usePreview(
    input.environmentId,
    local
      ? null
      : {
          projectId: input.projectId,
          type: input.type,
          assignment: { mode: "auto" },
          ...(input.parent?.ref ? { parent: input.parent.ref } : {}),
        },
  );
  const context = {
    type: input.type,
    catalog,
    parentDisplayId: input.autoResolution?.parentDisplayId ?? input.parent?.displayId,
  };
  if (input.autoResolution !== undefined)
    return autoDetailLine(input.autoResolution.resolved, context);
  if (preview._tag === "Success") return autoDetailLine(preview.value.resolved, context);
  return preview._tag === "Initial" ? "Looking up the agent…" : "Picks an agent when it starts";
}

export interface TaskAssigneePickerProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  type: FactoryTaskType;
  value: FactoryTaskAssignment;
  onChange: (assignment: FactoryTaskAssignment) => void;
  trigger: ReactElement;
  allowUnassigned?: boolean;
  /** For a sub-task: a parent with a profile or pinned agent decides what Auto runs. */
  parent?: TaskAssigneeParent;
  /** An existing Auto task's own resolution, which is authoritative over any preview. */
  autoResolution?: {
    resolved: FactoryTaskAssignee["resolved"];
    parentDisplayId?: string;
  };
}

export function TaskAssigneePicker({
  environmentId,
  projectId,
  type,
  value,
  onChange,
  trigger,
  allowUnassigned = false,
  parent,
  autoResolution,
}: TaskAssigneePickerProps) {
  const catalog = useTaskCatalog(environmentId);
  const profilesResult = useFactoryAgentProfiles(environmentId);
  const autoDetail = useAutoDetail({ environmentId, projectId, type, parent, autoResolution });
  const choices = useTaskModelChoices(environmentId, projectId);
  const defaultMode = useTaskDefaultRuntimeMode(environmentId, projectId);
  const [pinning, setPinning] = useState(false);
  const profiles =
    profilesResult._tag === "Success"
      ? profilesResult.value.profiles.map(({ profile }) => {
          const { label, mono } = presentTaskSetup(profile.setup, catalog);
          return { id: profile.id, name: profile.name, mono, detail: label };
        })
      : [];
  const pinnedSetup = value.mode === "pinned" ? value.setup : null;
  const pinned = pinnedSetup ? presentTaskSetup(pinnedSetup, catalog) : null;
  const activeInstanceId =
    pinnedSetup?.modelSelection.instanceId ??
    choices.instanceEntries.find((entry) => entry.enabled)?.instanceId ??
    null;

  const select = (picked: AssigneePickerValue) => {
    switch (picked.kind) {
      case "profile":
        return onChange({ mode: "profile", profileId: picked.profileId });
      case "pinned":
        return onChange(value);
      default:
        return onChange({ mode: picked.kind });
    }
  };
  const pin = () => {
    if (activeInstanceId === null) {
      toastManager.add({ type: "error", title: "Add a provider in Settings to pin a model." });
      return;
    }
    setPinning(true);
  };

  return (
    <>
      <AssigneePicker
        trigger={trigger}
        auto={{ detail: autoDetail }}
        profiles={profiles}
        person={{ label: "You", initials: "Y", detail: "Person" }}
        pinned={pinned}
        allowUnassigned={allowUnassigned}
        selected={pickerValue(value)}
        onSelect={select}
        onPin={pin}
      />
      {pinning && activeInstanceId !== null ? (
        <ProviderModelPicker
          environmentId={environmentId}
          open
          onOpenChange={(open) => {
            if (!open) setPinning(false);
          }}
          activeInstanceId={activeInstanceId}
          model={pinnedSetup?.modelSelection.model ?? ""}
          lockedProvider={null}
          instanceEntries={choices.instanceEntries}
          modelOptionsByInstance={choices.modelOptionsByInstance}
          isComposerOwned={false}
          onInstanceModelChange={(instanceId, model) => {
            setPinning(false);
            onChange(pinnedAssignment(choices.normalize({ instanceId, model }), defaultMode));
          }}
        />
      ) : null}
    </>
  );
}

/** The parent's assignee, read only while the sub-task's own assignment is not Auto. */
function useParentAssignee(task: FactoryTaskSummary): TaskAssigneeParent | undefined {
  const parent = task.assignee.assignment.mode === "auto" ? null : task.parent;
  const atom: Atom.Atom<Result<FactoryTaskDetail>> =
    parent === null
      ? NO_DETAIL
      : factoryTasks.readTask({
          environmentId: task.ref.environmentId,
          input: { task: { ref: { ...task.ref, taskId: parent.taskId } } },
        });
  const detail = useAtomValue(atom);
  return parent !== null && detail._tag === "Success"
    ? {
        ref: detail.value.task.ref,
        displayId: parent.displayId,
        assignee: detail.value.task.assignee,
      }
    : undefined;
}

/** The task's assignee chip, which opens the picker and saves the choice. */
export function TaskAssigneeEditor({ task }: { task: FactoryTaskSummary }) {
  const { environmentId, projectId } = task.ref;
  const chip = useTaskAssigneeChip(task.assignee, environmentId);
  const canUpdate = useAtomValue(factoryTasks.updateTask.permissionAtom(environmentId));
  const parent = useParentAssignee(task);
  const actions = useTaskActions();
  const running =
    task.liveRuns.some((run) => run.taskId === task.ref.taskId) ||
    task.run?.state === "running" ||
    task.run?.state === "stopping";
  if (running || !canUpdate) return <AssigneeChip assignee={chip} />;
  const autoResolution =
    task.assignee.assignment.mode === "auto"
      ? {
          resolved: task.assignee.resolved,
          ...(task.parent ? { parentDisplayId: task.parent.displayId } : {}),
        }
      : undefined;
  return (
    <TaskAssigneePicker
      environmentId={environmentId}
      projectId={projectId}
      type={task.type}
      value={task.assignee.assignment}
      onChange={(assignment) => void actions.update(task, { assignment })}
      trigger={<AssigneeChip assignee={chip} render={<button type="button" />} />}
      allowUnassigned
      {...(parent ? { parent } : {})}
      {...(autoResolution ? { autoResolution } : {})}
    />
  );
}
