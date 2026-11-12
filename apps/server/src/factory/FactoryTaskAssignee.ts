import type {
  FactoryAgentProfile,
  FactoryAgentSetup,
  FactoryTaskAssignee,
  FactoryTaskAssignment,
  FactoryTaskType,
  ModelSelection,
  RuntimeMode,
} from "@t3tools/contracts";

interface AssigneeContext {
  readonly type: FactoryTaskType;
  /** Assignments of the task's ancestors, nearest first. */
  readonly ancestors: ReadonlyArray<FactoryTaskAssignment>;
  /** In creation order: `auto` hands a type to the first profile that handles it. */
  readonly profiles: ReadonlyArray<FactoryAgentProfile>;
  readonly projectDefault: ModelSelection | null;
  readonly environmentDefault: ModelSelection | null;
  /** The project's Default permissions setting, for a run nobody chose a mode for. */
  readonly defaultRuntimeMode: RuntimeMode;
}

const UNASSIGNED = { key: "unassigned", resolved: null } as const;

export const setupKey = (setup: FactoryAgentSetup): string =>
  `${setup.modelSelection.instanceId}/${setup.modelSelection.model}`;

const defaultSetup = (
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
): FactoryAgentSetup => ({
  modelSelection,
  runtimeMode,
  interactionMode: "default",
  workspace: "worktree",
});

type Named = Omit<NonNullable<FactoryTaskAssignee["resolved"]>, "via"> & { readonly key: string };

function named(
  assignment: FactoryTaskAssignment,
  profiles: ReadonlyArray<FactoryAgentProfile>,
): Named | null {
  if (assignment.mode === "pinned")
    return { key: setupKey(assignment.setup), profile: null, setup: assignment.setup };
  if (assignment.mode !== "profile") return null;
  const profile = profiles.find((entry) => entry.id === assignment.profileId);
  return profile === undefined
    ? null
    : { key: profile.id, profile: { id: profile.id, name: profile.name }, setup: profile.setup };
}

/** What `assignment` would run, and which step of the `auto` order answered. */
export function resolveAssignee(
  assignment: FactoryTaskAssignment,
  context: AssigneeContext,
): FactoryTaskAssignee {
  if (assignment.mode === "person") return { assignment, key: "person", resolved: null };
  if (assignment.mode === "unassigned") return { assignment, ...UNASSIGNED };
  if (assignment.mode !== "auto") {
    // A task that names a deleted profile shows as unassigned until it is reassigned.
    const direct = named(assignment, context.profiles);
    if (direct === null) return { assignment, ...UNASSIGNED };
    const { key, ...resolved } = direct;
    return { assignment, key, resolved: { ...resolved, via: "assignment" } };
  }
  for (const ancestor of context.ancestors) {
    const inherited = named(ancestor, context.profiles);
    if (inherited === null) continue;
    const { key, ...resolved } = inherited;
    return { assignment, key, resolved: { ...resolved, via: "parent" } };
  }
  const handler = context.profiles.find((profile) => profile.handles.includes(context.type));
  if (handler !== undefined)
    return {
      assignment,
      key: handler.id,
      resolved: {
        profile: { id: handler.id, name: handler.name },
        setup: handler.setup,
        via: "profile-type",
      },
    };
  for (const [modelSelection, via] of [
    [context.projectDefault, "project-default"],
    [context.environmentDefault, "environment-default"],
  ] as const) {
    if (modelSelection === null) continue;
    const setup = defaultSetup(modelSelection, context.defaultRuntimeMode);
    return { assignment, key: setupKey(setup), resolved: { profile: null, setup, via } };
  }
  return { assignment, ...UNASSIGNED };
}
