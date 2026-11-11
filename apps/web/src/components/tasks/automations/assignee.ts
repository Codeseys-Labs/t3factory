import {
  type FactoryTaskCatalog,
  presentFactoryTaskAssignee,
} from "@t3tools/client-runtime/state/factory-task-view";
import type {
  FactoryAgentProfile,
  FactoryAgentSetup,
  FactoryTaskAssignment,
} from "@t3tools/contracts";

/** `Codex · Sol`, the way cards and pickers name a setup. */
export function setupLabel(setup: FactoryAgentSetup, catalog: FactoryTaskCatalog) {
  return presentFactoryTaskAssignee(
    { assignment: { mode: "pinned", setup }, key: "", resolved: null },
    catalog,
  );
}

// Profile ids are free text, so they get a prefix that `auto` and `unassigned` cannot collide with.
function assignmentKey(assignment: FactoryTaskAssignment): string {
  return assignment.mode === "profile" ? `profile:${assignment.profileId}` : assignment.mode;
}

/** What a rule's Then column or a schedule names as its assignee. */
export function assignmentName(
  assignment: FactoryTaskAssignment,
  profiles: readonly FactoryAgentProfile[],
  catalog: FactoryTaskCatalog,
): string {
  switch (assignment.mode) {
    case "auto":
      return "Auto";
    case "person":
      return "You";
    case "pinned":
      return setupLabel(assignment.setup, catalog).label;
    case "profile":
      return profiles.find((profile) => profile.id === assignment.profileId)?.name ?? "Unassigned";
    case "unassigned":
      return "Unassigned";
  }
}

/**
 * The assignee select of a rule or a schedule, as E2 draws it: Auto, each profile with its setup,
 * Unassigned. An assignment the select does not offer (a pinned setup, a person, a deleted
 * profile) stays as its own item so saving does not change it.
 */
export function assigneeSelect(
  current: FactoryTaskAssignment,
  profiles: readonly FactoryAgentProfile[],
  catalog: FactoryTaskCatalog,
) {
  const items = [
    { value: "auto", label: "Auto", assignment: { mode: "auto" } as FactoryTaskAssignment },
    ...profiles.map((profile) => ({
      value: `profile:${profile.id}`,
      label: `${profile.name} · ${setupLabel(profile.setup, catalog).label}`,
      assignment: { mode: "profile", profileId: profile.id } as FactoryTaskAssignment,
    })),
    {
      value: "unassigned",
      label: "Unassigned",
      assignment: { mode: "unassigned" } as FactoryTaskAssignment,
    },
  ];
  const value = assignmentKey(current);
  if (!items.some((item) => item.value === value)) {
    items.push({
      value,
      label:
        current.mode === "profile" ? "Deleted profile" : assignmentName(current, profiles, catalog),
      assignment: current,
    });
  }
  return {
    value,
    items,
    pick: (key: string) => items.find((item) => item.value === key)?.assignment ?? current,
  };
}
