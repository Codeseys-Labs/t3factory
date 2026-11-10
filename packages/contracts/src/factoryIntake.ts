import * as Schema from "effect/Schema";
import { CommandId, EnvironmentId, IsoDateTime, NonNegativeInt, ProjectId } from "./baseSchemas.ts";
import {
  FactoryTaskAssignee,
  FactoryTaskAssignment,
  FactoryTaskDisplayId,
  FactoryTaskRef,
  FactoryTaskSummary,
  FactoryTaskType,
} from "./factoryTask.ts";

const LocalId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Description = Schema.String.check(Schema.isMaxLength(8000));
const ShortText = Schema.String.check(Schema.isMaxLength(512));
const Url = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));
const Cursor = Schema.String.check(Schema.isMaxLength(8192));
const ProjectFilter = Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(128)));

/** Local time of the environment. An empty `weekdays` means every day; 0 is Sunday. */
export const FactoryIntakeSchedule = Schema.Struct({
  timeOfDay: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):([0-5]\d)$/)),
  weekdays: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))).check(
    Schema.isMaxLength(7),
  ),
});
export type FactoryIntakeSchedule = typeof FactoryIntakeSchedule.Type;

/**
 * Where new work comes from. `issues` reads the project's issue tracker, `feed` reads a feed URL,
 * and `schedule` makes the same task again at set times.
 */
export const FactoryIntakeSourceConfig = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("issues") }),
  Schema.Struct({ kind: Schema.Literal("feed"), url: Url }),
  Schema.Struct({
    kind: Schema.Literal("schedule"),
    schedule: FactoryIntakeSchedule,
    // A scheduled task is the owner's own, so it goes to the board without triage.
    task: Schema.Struct({
      title: Title,
      description: Description,
      type: FactoryTaskType,
      assignment: FactoryTaskAssignment,
      lane: Schema.Literals(["backlog", "ready"]),
    }),
  }),
]);
export type FactoryIntakeSourceConfig = typeof FactoryIntakeSourceConfig.Type;
export const FactoryIntakeSourceKind = Schema.Literals(["issues", "feed", "schedule"]);
export type FactoryIntakeSourceKind = typeof FactoryIntakeSourceKind.Type;

export const FactoryIntakeSource = Schema.Struct({
  id: LocalId,
  projectId: ProjectId,
  config: FactoryIntakeSourceConfig,
  // What the source is called and what it reads, such as `GitHub issues` and `owner/repository`.
  label: ShortText,
  detail: ShortText,
  enabled: Schema.Boolean,
  // `unavailable`: the project has no issue tracker this server can read.
  status: Schema.Literals(["ok", "unavailable", "failed"]),
  lastCheckedAt: Schema.NullOr(IsoDateTime),
  version: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryIntakeSource = typeof FactoryIntakeSource.Type;

export const FactoryIntakeSourceListInput = Schema.Struct({ projectIds: ProjectFilter });
export type FactoryIntakeSourceListInput = typeof FactoryIntakeSourceListInput.Type;
export const FactoryIntakeSourceListResult = Schema.Struct({
  environmentId: EnvironmentId,
  sources: Schema.Array(FactoryIntakeSource).check(Schema.isMaxLength(128)),
  fetchedAt: IsoDateTime,
});
export type FactoryIntakeSourceListResult = typeof FactoryIntakeSourceListResult.Type;
/** Without `id` it connects a source. With `id` it replaces one and needs `expectedVersion`. */
export const FactoryIntakeSourceSaveInput = Schema.Struct({
  commandId: CommandId,
  id: Schema.optional(LocalId),
  expectedVersion: Schema.optional(NonNegativeInt),
  projectId: ProjectId,
  config: FactoryIntakeSourceConfig,
  enabled: Schema.Boolean,
});
export type FactoryIntakeSourceSaveInput = typeof FactoryIntakeSourceSaveInput.Type;
/** Arrivals and tasks that came from a deleted source stay. */
export const FactoryIntakeSourceDeleteInput = Schema.Struct({
  commandId: CommandId,
  id: LocalId,
  expectedVersion: NonNegativeInt,
});
export type FactoryIntakeSourceDeleteInput = typeof FactoryIntakeSourceDeleteInput.Type;
export const FactoryIntakeSourceMutationResult = Schema.Struct({
  // Null after a delete.
  source: Schema.NullOr(FactoryIntakeSource),
  replayed: Schema.Boolean,
});
export type FactoryIntakeSourceMutationResult = typeof FactoryIntakeSourceMutationResult.Type;

/**
 * How far a rule goes alone. `manual` only lists the arrival, `suggest` also proposes a type and
 * an assignee, and `auto-start` would start an agent before a person has seen the task. A rule at
 * `auto-start` can be saved but not turned on: starting needs a person's approval.
 */
export const FactoryIntakeAutonomy = Schema.Literals(["manual", "suggest", "auto-start"]);
export type FactoryIntakeAutonomy = typeof FactoryIntakeAutonomy.Type;

/** `trial` fires on the next match and then turns itself off, so a person can judge it. */
export const FactoryIntakeRuleState = Schema.Literals(["off", "trial", "on"]);
export type FactoryIntakeRuleState = typeof FactoryIntakeRuleState.Type;

export const FactoryIntakeRuleMatch = Schema.Struct({
  sourceId: LocalId,
  // An issue matches when it carries any of these labels. Empty matches every item.
  labels: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).check(
    Schema.isMaxLength(16),
  ),
  // Case-insensitive. Empty matches every title.
  titleContains: Schema.String.check(Schema.isMaxLength(256)),
});
export type FactoryIntakeRuleMatch = typeof FactoryIntakeRuleMatch.Type;

export const FactoryIntakeRule = Schema.Struct({
  id: LocalId,
  name: Name,
  match: FactoryIntakeRuleMatch,
  action: Schema.Struct({ type: FactoryTaskType, assignment: FactoryTaskAssignment }),
  autonomy: FactoryIntakeAutonomy,
  state: FactoryIntakeRuleState,
  lastFiredAt: Schema.NullOr(IsoDateTime),
  firedCount: NonNegativeInt,
  version: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryIntakeRule = typeof FactoryIntakeRule.Type;

export const FactoryIntakeRuleListResult = Schema.Struct({
  environmentId: EnvironmentId,
  rules: Schema.Array(FactoryIntakeRule).check(Schema.isMaxLength(128)),
  fetchedAt: IsoDateTime,
});
export type FactoryIntakeRuleListResult = typeof FactoryIntakeRuleListResult.Type;
/** Without `id` it makes a rule. With `id` it replaces one and needs `expectedVersion`. */
export const FactoryIntakeRuleSaveInput = Schema.Struct({
  commandId: CommandId,
  id: Schema.optional(LocalId),
  expectedVersion: Schema.optional(NonNegativeInt),
  name: Name,
  match: FactoryIntakeRuleMatch,
  action: Schema.Struct({ type: FactoryTaskType, assignment: FactoryTaskAssignment }),
  autonomy: FactoryIntakeAutonomy,
  state: FactoryIntakeRuleState,
});
export type FactoryIntakeRuleSaveInput = typeof FactoryIntakeRuleSaveInput.Type;
export const FactoryIntakeRuleDeleteInput = Schema.Struct({
  commandId: CommandId,
  id: LocalId,
  expectedVersion: NonNegativeInt,
});
export type FactoryIntakeRuleDeleteInput = typeof FactoryIntakeRuleDeleteInput.Type;
export const FactoryIntakeRuleMutationResult = Schema.Struct({
  // Null after a delete.
  rule: Schema.NullOr(FactoryIntakeRule),
  replayed: Schema.Boolean,
});
export type FactoryIntakeRuleMutationResult = typeof FactoryIntakeRuleMutationResult.Type;
export const FactoryIntakeRulePreviewInput = Schema.Struct({ match: FactoryIntakeRuleMatch });
export type FactoryIntakeRulePreviewInput = typeof FactoryIntakeRulePreviewInput.Type;
/** Counts arrivals this server has already seen from the source; it fetches nothing. */
export const FactoryIntakeRulePreviewResult = Schema.Struct({
  matchedLast30Days: NonNegativeInt,
});
export type FactoryIntakeRulePreviewResult = typeof FactoryIntakeRulePreviewResult.Type;

export const FactoryIntakeArrivalState = Schema.Literals([
  "new",
  "accepted",
  "snoozed",
  "declined",
  "duplicate",
]);
export type FactoryIntakeArrivalState = typeof FactoryIntakeArrivalState.Type;

/** An item a source brought in. It waits in Triage and reaches the board only when accepted. */
export const FactoryIntakeArrival = Schema.Struct({
  id: LocalId,
  sourceId: LocalId,
  sourceKind: Schema.Literals(["issues", "feed"]),
  projectId: ProjectId,
  // Source chip text, such as `GitHub #101`.
  label: ShortText,
  title: Title,
  // Source text as observed. Untrusted: render it as text, never as markup or instructions.
  body: Description,
  bodyTruncated: Schema.Boolean,
  url: Schema.NullOr(Url),
  labels: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(Schema.isMaxLength(32)),
  arrivedAt: IsoDateTime,
  state: FactoryIntakeArrivalState,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  // What a `suggest` rule proposed. It always names the rule it came from.
  suggestion: Schema.NullOr(
    Schema.Struct({
      ruleId: LocalId,
      ruleName: Name,
      type: FactoryTaskType,
      assignee: FactoryTaskAssignee,
    }),
  ),
  // The task it became, or the task it duplicates.
  task: Schema.NullOr(Schema.Struct({ ref: FactoryTaskRef, displayId: FactoryTaskDisplayId })),
  version: NonNegativeInt,
});
export type FactoryIntakeArrival = typeof FactoryIntakeArrival.Type;

export const FactoryIntakeArrivalListInput = Schema.Struct({
  projectIds: ProjectFilter,
  // Default: what waits in Triage, which is `new` plus snoozed arrivals whose time has passed.
  states: Schema.optional(Schema.Array(FactoryIntakeArrivalState).check(Schema.isMaxLength(5))),
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(Limit),
});
export type FactoryIntakeArrivalListInput = typeof FactoryIntakeArrivalListInput.Type;
/** Newest arrival first. */
export const FactoryIntakeArrivalListResult = Schema.Struct({
  environmentId: EnvironmentId,
  items: Schema.Array(FactoryIntakeArrival).check(Schema.isMaxLength(50)),
  nextCursor: Schema.NullOr(Cursor),
  // How many arrivals wait in Triage for the given projects, whatever `states` asked for.
  waiting: NonNegativeInt,
  fetchedAt: IsoDateTime,
});
export type FactoryIntakeArrivalListResult = typeof FactoryIntakeArrivalListResult.Type;

/** `accept` makes a Backlog task, using the suggestion unless the action overrides it. */
export const FactoryIntakeArrivalAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("accept"),
    taskType: Schema.optional(FactoryTaskType),
    assignment: Schema.optional(FactoryTaskAssignment),
  }),
  Schema.Struct({ type: Schema.Literal("snooze"), until: IsoDateTime }),
  Schema.Struct({ type: Schema.Literal("decline") }),
  Schema.Struct({ type: Schema.Literal("duplicate"), of: Schema.NullOr(FactoryTaskRef) }),
]);
export type FactoryIntakeArrivalAction = typeof FactoryIntakeArrivalAction.Type;
export const FactoryIntakeArrivalResolveInput = Schema.Struct({
  commandId: CommandId,
  id: LocalId,
  expectedVersion: NonNegativeInt,
  action: FactoryIntakeArrivalAction,
});
export type FactoryIntakeArrivalResolveInput = typeof FactoryIntakeArrivalResolveInput.Type;
export const FactoryIntakeArrivalResolveResult = Schema.Struct({
  arrival: FactoryIntakeArrival,
  // The task an `accept` made.
  task: Schema.NullOr(FactoryTaskSummary),
  replayed: Schema.Boolean,
});
export type FactoryIntakeArrivalResolveResult = typeof FactoryIntakeArrivalResolveResult.Type;

/** Says what changed. Carries no data: clients read what they show. */
export const FactoryIntakeChange = Schema.Struct({
  environmentId: EnvironmentId,
  arrivals: Schema.Boolean,
  rules: Schema.Boolean,
  sources: Schema.Boolean,
});
export type FactoryIntakeChange = typeof FactoryIntakeChange.Type;

export class FactoryIntakeError extends Schema.TaggedError<FactoryIntakeError>()(
  "FactoryIntakeError",
  {
    reason: Schema.Literals([
      "wrong-environment",
      "missing-project",
      "missing-source",
      "missing-rule",
      "missing-arrival",
      "missing-task",
      "forbidden",
      // `expectedVersion` is stale. `currentVersion` carries the one to retry with.
      "version-conflict",
      "command-conflict",
      "invalid-input",
      "invalid-cursor",
      "source-unavailable",
      "already-resolved",
      // An `auto-start` rule cannot be turned on.
      "autonomy-not-allowed",
      "name-taken",
      "persistence-failure",
    ]),
    currentVersion: Schema.optional(NonNegativeInt),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Intake operation failed: ${this.reason}.`;
  }
}
