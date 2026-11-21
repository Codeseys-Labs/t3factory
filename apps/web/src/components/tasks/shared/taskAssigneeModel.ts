import {
  type FactoryTaskCatalog,
  type FactoryTaskLabelOptions,
  presentFactoryTaskAssignee,
} from "@t3tools/client-runtime/state/factory-task-view";
import type {
  FactoryAgentSetup,
  FactoryTaskAssignee,
  FactoryTaskAssignment,
  FactoryTaskRef,
  FactoryTaskType,
  RuntimeMode,
} from "@t3tools/contracts";

import { msg } from "gt-react";

import { m, type MessageResolver } from "../../../i18n/messages";
import type { AssigneeChipProps, AssigneePickerValue } from "../kit";

/** A task's parent, for resolving Auto the way the server does: the nearest pinned ancestor wins. */
export interface TaskAssigneeParent {
  readonly ref?: FactoryTaskRef;
  readonly displayId: string;
  readonly assignee: FactoryTaskAssignee;
}

/** `Codex · Sol` and `Cx` for a setup, from the environment's provider catalog. */
export function presentTaskSetup(
  setup: FactoryAgentSetup,
  catalog: FactoryTaskCatalog,
  labelOptions?: FactoryTaskLabelOptions,
) {
  const presented = presentFactoryTaskAssignee(
    { assignment: { mode: "pinned", setup }, key: "", resolved: null },
    catalog,
    labelOptions,
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
  labelOptions?: FactoryTaskLabelOptions,
): AssigneeChipProps {
  const mode = assignee.assignment.mode;
  if (mode === "person") return { kind: "person", label: msg("You") };
  const setup = mode === "unassigned" ? null : assigneeSetup(assignee);
  if (!setup) return { kind: "unassigned" };
  const { label, mono } = presentTaskSetup(setup, catalog, labelOptions);
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
  task: msg("tasks", { $context: "plural, tasks" }),
  bug: msg("bugs", { $context: "plural, bugs" }),
  feature: msg("features", { $context: "plural, features" }),
  docs: msg("docs", { $context: "plural, docs" }),
  research: msg("research", { $context: "plural, research" }),
};

/** Auto's detail line: what it picked and why. */
export function autoDetailLine(
  resolved: FactoryTaskAssignee["resolved"],
  context: {
    readonly type: FactoryTaskType;
    readonly catalog: FactoryTaskCatalog;
    readonly parentDisplayId?: string | undefined;
  },
  resolve: MessageResolver = m,
): string {
  if (!resolved) return resolve(msg("Set a default model to use Auto"));
  const { label } = presentTaskSetup(resolved.setup, context.catalog);
  switch (resolved.via) {
    case "parent":
      return resolve(
        msg("Follows {parent} · {label}", {
          parent: context.parentDisplayId ?? resolve(msg("the parent task")),
          label,
        }),
      );
    case "profile-type":
      return resolve(
        msg("Picks {label} for {kind}", {
          label,
          kind: resolve(TYPE_PLURALS[context.type]),
        }),
      );
    case "project-default":
      return resolve(msg("Picks {label} for this project", { label }));
    case "environment-default":
      return resolve(msg("Picks {label} on this machine", { label }));
    case "assignment":
      return resolve(msg("Picks {label}", { label }));
  }
}

export function pickerValue(assignment: FactoryTaskAssignment): AssigneePickerValue {
  return assignment.mode === "profile"
    ? { kind: "profile", profileId: assignment.profileId }
    : { kind: assignment.mode };
}

/** Pinning from the picker takes the project's default permissions, in a new worktree. */
export function pinnedSetupFor(
  modelSelection: FactoryAgentSetup["modelSelection"],
  runtimeMode: RuntimeMode,
): FactoryAgentSetup {
  return { modelSelection, runtimeMode, interactionMode: "default", workspace: "worktree" };
}
