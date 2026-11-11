import {
  type FactoryTaskCatalog,
  presentFactoryTaskAssignee,
} from "@t3tools/client-runtime/state/factory-task-view";
import type {
  FactoryAgentSetup,
  FactoryTaskAssignee,
  FactoryTaskAssignment,
  FactoryTaskRef,
  FactoryTaskType,
} from "@t3tools/contracts";

import type { AssigneeChipProps, AssigneePickerValue } from "../kit";

/** A task's parent, for resolving Auto the way the server does: the nearest pinned ancestor wins. */
export interface TaskAssigneeParent {
  readonly ref?: FactoryTaskRef;
  readonly displayId: string;
  readonly assignee: FactoryTaskAssignee;
}

/** `Codex · Sol` and `Cx` for a setup, from the environment's provider catalog. */
export function presentTaskSetup(setup: FactoryAgentSetup, catalog: FactoryTaskCatalog) {
  const presented = presentFactoryTaskAssignee(
    { assignment: { mode: "pinned", setup }, key: "", resolved: null },
    catalog,
  );
  return { label: presented.label, mono: presented.monogram };
}

function assigneeSetup(assignee: FactoryTaskAssignee): FactoryAgentSetup | null {
  return (
    assignee.resolved?.setup ??
    (assignee.assignment.mode === "pinned" ? assignee.assignment.setup : null)
  );
}

/** The kit chip for an assignee. One that resolves to nothing, such as a deleted profile, is unassigned. */
export function taskAssigneeChipProps(
  assignee: FactoryTaskAssignee,
  catalog: FactoryTaskCatalog,
): AssigneeChipProps {
  const mode = assignee.assignment.mode;
  if (mode === "person") return { kind: "person", label: "You" };
  const setup = mode === "unassigned" ? null : assigneeSetup(assignee);
  if (!setup) return { kind: "unassigned" };
  const { label, mono } = presentTaskSetup(setup, catalog);
  return mode === "auto" ? { kind: "auto", label } : { kind: "agent", label, mono };
}

/** The setup a parent hands down to an Auto sub-task, or null when the parent does not decide. */
export function parentDecidedSetup(parent: TaskAssigneeParent | undefined) {
  if (!parent) return null;
  const { assignee } = parent;
  const decides =
    assignee.assignment.mode === "profile" ||
    assignee.assignment.mode === "pinned" ||
    assignee.resolved?.via === "parent";
  return decides ? assigneeSetup(assignee) : null;
}

const TYPE_PLURALS: Record<FactoryTaskType, string> = {
  task: "tasks",
  bug: "bugs",
  feature: "features",
  docs: "docs",
  research: "research",
};

/** Auto's detail line: what it picked and why. */
export function autoDetailLine(
  resolved: FactoryTaskAssignee["resolved"],
  context: {
    readonly type: FactoryTaskType;
    readonly catalog: FactoryTaskCatalog;
    readonly parentDisplayId?: string | undefined;
  },
): string {
  if (!resolved) return "Set a default model to use Auto";
  const { label } = presentTaskSetup(resolved.setup, context.catalog);
  switch (resolved.via) {
    case "parent":
      return `Follows ${context.parentDisplayId ?? "the parent task"} · ${label}`;
    case "profile-type":
      return `Picks ${label} for ${TYPE_PLURALS[context.type]}`;
    case "project-default":
      return `Picks ${label} for this project`;
    case "environment-default":
      return `Picks ${label} on this machine`;
    case "assignment":
      return `Picks ${label}`;
  }
}

export function pickerValue(assignment: FactoryTaskAssignment): AssigneePickerValue {
  return assignment.mode === "profile"
    ? { kind: "profile", profileId: assignment.profileId }
    : { kind: assignment.mode };
}

/** Pinning from the picker always asks first, in the default interaction, in a new worktree. */
export function pinnedAssignment(
  modelSelection: FactoryAgentSetup["modelSelection"],
): FactoryTaskAssignment {
  return {
    mode: "pinned",
    setup: {
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspace: "worktree",
    },
  };
}
