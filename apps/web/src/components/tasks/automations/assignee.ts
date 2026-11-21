import {
  type FactoryTaskCatalog,
  presentFactoryTaskAssignee,
} from "@t3tools/client-runtime/state/factory-task-view";
import type {
  FactoryAgentProfile,
  FactoryAgentSetup,
  FactoryTaskAssignment,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../../i18n/messages";

/** `Codex · Sol`, the way cards and pickers name a setup. */
export function setupLabel(
  setup: FactoryAgentSetup,
  catalog: FactoryTaskCatalog,
  resolve: MessageResolver = m,
) {
  return presentFactoryTaskAssignee(
    { assignment: { mode: "pinned", setup }, key: "", resolved: null },
    catalog,
    undefined,
    resolve,
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
  resolve: MessageResolver = m,
): string {
  switch (assignment.mode) {
    case "auto":
      return resolve(msg("Auto", { $context: "task assignee" }));
    case "person":
      return resolve(msg("You"));
    case "pinned":
      return setupLabel(assignment.setup, catalog, resolve).label;
    case "profile":
      return (
        profiles.find((profile) => profile.id === assignment.profileId)?.name ??
        resolve(msg("Unassigned", { $context: "task assignee" }))
      );
    case "unassigned":
      return resolve(msg("Unassigned", { $context: "task assignee" }));
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
  resolve: MessageResolver = m,
) {
  const items = [
    {
      value: "auto",
      label: resolve(msg("Auto", { $context: "task assignee" })),
      assignment: { mode: "auto" } as FactoryTaskAssignment,
    },
    ...profiles.map((profile) => ({
      value: `profile:${profile.id}`,
      label: `${profile.name} · ${setupLabel(profile.setup, catalog, resolve).label}`,
      assignment: { mode: "profile", profileId: profile.id } as FactoryTaskAssignment,
    })),
    {
      value: "unassigned",
      label: resolve(msg("Unassigned", { $context: "task assignee" })),
      assignment: { mode: "unassigned" } as FactoryTaskAssignment,
    },
  ];
  const value = assignmentKey(current);
  if (!items.some((item) => item.value === value)) {
    items.push({
      value,
      label:
        current.mode === "profile"
          ? resolve(msg("Deleted profile"))
          : assignmentName(current, profiles, catalog, resolve),
      assignment: current,
    });
  }
  return {
    value,
    items,
    pick: (key: string) => items.find((item) => item.value === key)?.assignment ?? current,
  };
}
