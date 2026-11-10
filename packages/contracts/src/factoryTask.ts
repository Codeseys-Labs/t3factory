import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
} from "./baseSchemas.ts";
import { FactoryWorkRef } from "./factoryWork.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

const LocalId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Description = Schema.String.check(Schema.isMaxLength(8000));
const ShortText = Schema.String.check(Schema.isMaxLength(512));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));
const Cursor = Schema.String.check(Schema.isMaxLength(8192));
const Url = Schema.String.check(Schema.isMaxLength(2048));

/**
 * A task is a local plan task. The root of a plan is a top-level task and every other plan task is
 * a sub-task. Title, description, parent and blockers live in the plan; everything a person sets
 * on the board lives beside it, so moving a card never changes the plan revision.
 */
export const FactoryTaskRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  rootId: LocalId,
  taskId: LocalId,
});
export type FactoryTaskRef = typeof FactoryTaskRef.Type;

/** `T-38` for a top-level task, `T-38.2` for its second sub-task. Local to one environment. */
export const FactoryTaskDisplayId = Schema.String.check(Schema.isPattern(/^T-\d+(\.\d+)*$/));
export type FactoryTaskDisplayId = typeof FactoryTaskDisplayId.Type;

/** Board column. `canceled` is kept off the board. */
export const FactoryTaskStatus = Schema.Literals([
  "backlog",
  "ready",
  "in-progress",
  "in-review",
  "done",
  "canceled",
]);
export type FactoryTaskStatus = typeof FactoryTaskStatus.Type;

/** The part of the status a person or a rule sets. The rest follows the task's runs. */
export const FactoryTaskLane = Schema.Literals(["backlog", "ready", "done", "canceled"]);
export type FactoryTaskLane = typeof FactoryTaskLane.Type;

export const FactoryTaskType = Schema.Literals(["task", "bug", "feature", "docs", "research"]);
export type FactoryTaskType = typeof FactoryTaskType.Type;

export const FactoryTaskWorkspace = Schema.Literals(["worktree", "root"]);
export type FactoryTaskWorkspace = typeof FactoryTaskWorkspace.Type;

/** Everything a run needs to know about who does the work and how. */
export const FactoryAgentSetup = Schema.Struct({
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspace: FactoryTaskWorkspace,
});
export type FactoryAgentSetup = typeof FactoryAgentSetup.Type;

export const FactoryTaskAssignment = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("unassigned") }),
  Schema.Struct({ mode: Schema.Literal("auto") }),
  Schema.Struct({ mode: Schema.Literal("profile"), profileId: LocalId }),
  Schema.Struct({ mode: Schema.Literal("pinned"), setup: FactoryAgentSetup }),
  // The owner does the work by hand. A task assigned to a person never starts a run.
  Schema.Struct({ mode: Schema.Literal("person") }),
]);
export type FactoryTaskAssignment = typeof FactoryTaskAssignment.Type;

/** Why an assignment resolved to its setup. `assignment` means the task names it directly. */
export const FactoryTaskAssigneeVia = Schema.Literals([
  "assignment",
  "parent",
  "profile-type",
  "project-default",
  "environment-default",
]);
export type FactoryTaskAssigneeVia = typeof FactoryTaskAssigneeVia.Type;

export const FactoryTaskAssignee = Schema.Struct({
  assignment: FactoryTaskAssignment,
  // Stable grouping and filter key: a profile id, `instanceId/model`, `unassigned` or `person`.
  key: ShortText,
  // What would run if the task started now. Null for unassigned, person, or nothing to resolve to.
  resolved: Schema.NullOr(
    Schema.Struct({
      profile: Schema.NullOr(Schema.Struct({ id: LocalId, name: ShortText })),
      setup: FactoryAgentSetup,
      via: FactoryTaskAssigneeVia,
    }),
  ),
});
export type FactoryTaskAssignee = typeof FactoryTaskAssignee.Type;

export const FactoryTaskSourceKind = Schema.Literals(["local", "issue", "feed", "schedule"]);
export type FactoryTaskSourceKind = typeof FactoryTaskSourceKind.Type;

/** Where a task came from. `label` is display text such as `GitHub #96`; source text is untrusted. */
export const FactoryTaskSource = Schema.Struct({
  kind: FactoryTaskSourceKind,
  label: ShortText,
  url: Schema.NullOr(Url),
  // Canonical origin key used to spot duplicates. Null for local tasks.
  key: Schema.NullOr(Url),
  workRef: Schema.NullOr(FactoryWorkRef),
});
export type FactoryTaskSource = typeof FactoryTaskSource.Type;

/**
 * What the server knows about a run. The live words (Working, Awaiting Input, Pending Approval)
 * come from the run's thread on the client, as in the thread sidebar.
 */
export const FactoryTaskRunState = Schema.Literals([
  "running",
  "stopping",
  "held",
  "failed",
  "stopped",
  "completed",
]);
export type FactoryTaskRunState = typeof FactoryTaskRunState.Type;

export const FactoryTaskRun = Schema.Struct({
  ordinal: PositiveInt,
  threadId: ThreadId,
  runId: RunId,
  state: FactoryTaskRunState,
  purpose: Schema.Literals(["work", "planning"]),
  setup: FactoryAgentSetup,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  // Bounded reason for held or failed, such as `Tests failed on attempt 2`. Never raw output.
  note: Schema.NullOr(ShortText),
});
export type FactoryTaskRun = typeof FactoryTaskRun.Type;

/** A run that has not finished, on this task or one of its sub-tasks. Drives live state. */
export const FactoryTaskLiveRun = Schema.Struct({
  taskId: LocalId,
  displayId: FactoryTaskDisplayId,
  threadId: ThreadId,
  state: FactoryTaskRunState,
  startedAt: IsoDateTime,
});
export type FactoryTaskLiveRun = typeof FactoryTaskLiveRun.Type;

/**
 * Why a task waits on a person. The server reports `review`, `plan`, `changed`, `unconfirmed` and
 * `failed`. Clients add `question` and `approve` from the pending requests of the live runs'
 * threads, so both use one vocabulary.
 */
export const FactoryTaskAttentionReason = Schema.Literals([
  "question",
  "approve",
  "review",
  "plan",
  "changed",
  "unconfirmed",
  "failed",
]);
export type FactoryTaskAttentionReason = typeof FactoryTaskAttentionReason.Type;

export const FactoryTaskAttention = Schema.Struct({
  reason: FactoryTaskAttentionReason,
  // The task that raised it: this task or one of its sub-tasks.
  taskId: LocalId,
  displayId: FactoryTaskDisplayId,
  detail: ShortText,
});
export type FactoryTaskAttention = typeof FactoryTaskAttention.Type;

export const FactoryTaskResult = Schema.Struct({
  kind: Schema.Literals(["document", "code"]),
  // Counts the results this task has produced. Accepting names one revision.
  revision: PositiveInt,
  // One bounded line, such as `+184 −20 · 6 files`.
  summary: ShortText,
  // `changed` means an earlier revision was accepted and a newer one exists.
  state: Schema.Literals(["ready", "accepted", "changed"]),
  acceptedRevision: Schema.NullOr(PositiveInt),
  runOrdinal: PositiveInt,
  threadId: ThreadId,
  observedAt: IsoDateTime,
});
export type FactoryTaskResult = typeof FactoryTaskResult.Type;

const TaskPointer = Schema.Struct({
  taskId: LocalId,
  displayId: FactoryTaskDisplayId,
  title: Title,
  status: FactoryTaskStatus,
});

export const FactoryTaskSummary = Schema.Struct({
  ref: FactoryTaskRef,
  displayId: FactoryTaskDisplayId,
  parent: Schema.NullOr(Schema.Struct({ taskId: LocalId, displayId: FactoryTaskDisplayId })),
  title: Title,
  type: FactoryTaskType,
  status: FactoryTaskStatus,
  lane: FactoryTaskLane,
  assignee: FactoryTaskAssignee,
  source: FactoryTaskSource,
  // Unfinished tasks this one waits on. Advisory: it never starts or stops a run.
  blockedBy: Schema.Array(TaskPointer).check(Schema.isMaxLength(8)),
  // Direct sub-tasks, canceled ones left out. Null when there are none.
  progress: Schema.NullOr(Schema.Struct({ done: NonNegativeInt, total: PositiveInt })),
  run: Schema.NullOr(FactoryTaskRun),
  liveRuns: Schema.Array(FactoryTaskLiveRun).check(Schema.isMaxLength(16)),
  // Most urgent first. Holds this task's reasons and its sub-tasks'.
  attention: Schema.Array(FactoryTaskAttention).check(Schema.isMaxLength(16)),
  result: Schema.NullOr(FactoryTaskResult),
  // Compare-and-set token for `updateTask`. Plan edits and board edits both advance it.
  version: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryTaskSummary = typeof FactoryTaskSummary.Type;

const TaskFilterFields = {
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(128))),
  statuses: Schema.optional(Schema.Array(FactoryTaskStatus).check(Schema.isMaxLength(6))),
  types: Schema.optional(Schema.Array(FactoryTaskType).check(Schema.isMaxLength(5))),
  sourceKinds: Schema.optional(Schema.Array(FactoryTaskSourceKind).check(Schema.isMaxLength(4))),
  assigneeKeys: Schema.optional(Schema.Array(ShortText).check(Schema.isMaxLength(32))),
  // Matches the title and the display id.
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  // `roots` (default) lists top-level tasks; `all` also lists sub-tasks.
  scope: Schema.optional(Schema.Literals(["roots", "all"])),
  // Only tasks that wait on a person or have a run that has not finished. A parent counts when
  // one of its sub-tasks does.
  attention: Schema.optional(Schema.Literal(true)),
};

export const FactoryTaskListInput = Schema.Struct({
  ...TaskFilterFields,
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(Limit),
});
export type FactoryTaskListInput = typeof FactoryTaskListInput.Type;
/** Newest update first. The cursor is bound to the filter it was issued for. */
export const FactoryTaskListResult = Schema.Struct({
  environmentId: EnvironmentId,
  items: Schema.Array(FactoryTaskSummary).check(Schema.isMaxLength(50)),
  nextCursor: Schema.NullOr(Cursor),
  fetchedAt: IsoDateTime,
});
export type FactoryTaskListResult = typeof FactoryTaskListResult.Type;

export const FactoryTaskCountInput = Schema.Struct(TaskFilterFields);
export type FactoryTaskCountInput = typeof FactoryTaskCountInput.Type;
export const FactoryTaskCountResult = Schema.Struct({
  environmentId: EnvironmentId,
  byStatus: Schema.Array(Schema.Struct({ status: FactoryTaskStatus, count: NonNegativeInt })),
  fetchedAt: IsoDateTime,
});
export type FactoryTaskCountResult = typeof FactoryTaskCountResult.Type;

export const FactoryTaskLocator = Schema.Union([
  Schema.Struct({ ref: FactoryTaskRef }),
  Schema.Struct({ displayId: FactoryTaskDisplayId }),
]);
export type FactoryTaskLocator = typeof FactoryTaskLocator.Type;
export const FactoryTaskReadInput = Schema.Struct({ task: FactoryTaskLocator });
export type FactoryTaskReadInput = typeof FactoryTaskReadInput.Type;
export const FactoryTaskDetail = Schema.Struct({
  task: FactoryTaskSummary,
  description: Description,
  // Root first, the task's parent last. Empty for a top-level task.
  ancestors: Schema.Array(TaskPointer).check(Schema.isMaxLength(16)),
  subtasks: Schema.Array(FactoryTaskSummary).check(Schema.isMaxLength(64)),
  blockedBy: Schema.Array(TaskPointer).check(Schema.isMaxLength(64)),
  blocks: Schema.Array(TaskPointer).check(Schema.isMaxLength(64)),
  // Newest first.
  runs: Schema.Array(FactoryTaskRun).check(Schema.isMaxLength(32)),
  fetchedAt: IsoDateTime,
});
export type FactoryTaskDetail = typeof FactoryTaskDetail.Type;

export const FactoryTaskCreateInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  title: Title,
  description: Schema.optional(Description),
  type: Schema.optional(FactoryTaskType),
  // Default `backlog`.
  lane: Schema.optional(Schema.Literals(["backlog", "ready"])),
  // Default `unassigned` for a top-level task and `auto` for a sub-task.
  assignment: Schema.optional(FactoryTaskAssignment),
  // Makes a sub-task. Its blockers must be tasks of the same top-level task.
  parent: Schema.optional(
    Schema.Struct({
      rootId: LocalId,
      taskId: LocalId,
      blockedBy: Schema.optional(Schema.Array(LocalId).check(Schema.isMaxLength(16))),
    }),
  ),
  // Makes the task from retained Work and attaches it as the source.
  workRef: Schema.optional(FactoryWorkRef),
});
export type FactoryTaskCreateInput = typeof FactoryTaskCreateInput.Type;

/** Only the given fields change. Moving to `done` or `canceled` is refused while a run is live. */
export const FactoryTaskUpdateInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryTaskRef,
  expectedVersion: NonNegativeInt,
  title: Schema.optional(Title),
  description: Schema.optional(Description),
  type: Schema.optional(FactoryTaskType),
  lane: Schema.optional(FactoryTaskLane),
  assignment: Schema.optional(FactoryTaskAssignment),
});
export type FactoryTaskUpdateInput = typeof FactoryTaskUpdateInput.Type;

export const FactoryTaskMutationResult = Schema.Struct({
  task: FactoryTaskSummary,
  replayed: Schema.Boolean,
});
export type FactoryTaskMutationResult = typeof FactoryTaskMutationResult.Type;

/**
 * Starting is a person's approval of this task, this setup and this plan revision. It starts one
 * task; a sub-task that becomes unblocked later still needs its own start.
 */
export const FactoryTaskStartInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryTaskRef,
  expectedVersion: NonNegativeInt,
  setup: FactoryAgentSetup,
});
export type FactoryTaskStartInput = typeof FactoryTaskStartInput.Type;
export const FactoryTaskStopInput = Schema.Struct({ commandId: CommandId, ref: FactoryTaskRef });
export type FactoryTaskStopInput = typeof FactoryTaskStopInput.Type;
/** Runs the task again after a failed or stopped run. `setup` reassigns it first. */
export const FactoryTaskRetryInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryTaskRef,
  expectedVersion: NonNegativeInt,
  setup: Schema.optional(FactoryAgentSetup),
});
export type FactoryTaskRetryInput = typeof FactoryTaskRetryInput.Type;
/** Accepting records a review of one result revision. It publishes nothing. */
export const FactoryTaskAcceptInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryTaskRef,
  revision: PositiveInt,
});
export type FactoryTaskAcceptInput = typeof FactoryTaskAcceptInput.Type;
/** Sends the note to the run's agent. The next result replaces the one under review. */
export const FactoryTaskRequestChangesInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryTaskRef,
  revision: PositiveInt,
  note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
});
export type FactoryTaskRequestChangesInput = typeof FactoryTaskRequestChangesInput.Type;
/** Reopens an accepted task. It keeps its history and starts nothing. */
export const FactoryTaskReopenInput = Schema.Struct({ commandId: CommandId, ref: FactoryTaskRef });
export type FactoryTaskReopenInput = typeof FactoryTaskReopenInput.Type;

export const FactoryTaskResultReadInput = Schema.Struct({
  ref: FactoryTaskRef,
  // Default: the latest revision.
  revision: Schema.optional(PositiveInt),
});
export type FactoryTaskResultReadInput = typeof FactoryTaskResultReadInput.Type;
export const FactoryTaskResultReadResult = Schema.Struct({
  result: FactoryTaskResult,
  // The document, for a `document` result.
  text: Schema.NullOr(Schema.String),
  // Changed files, for a `code` result.
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, additions: NonNegativeInt, deletions: NonNegativeInt }),
  ).check(Schema.isMaxLength(500)),
  filesOmitted: NonNegativeInt,
});
export type FactoryTaskResultReadResult = typeof FactoryTaskResultReadResult.Type;

const CommentBody = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000));
/** A comment is for the people on the task. Messages to the agent go to the run's thread. */
export const FactoryTaskCommentInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryTaskRef,
  body: CommentBody,
});
export type FactoryTaskCommentInput = typeof FactoryTaskCommentInput.Type;

const RunOutcome = Schema.Literals(["completed", "failed", "stopped"]);
export const FactoryTaskActivityEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("created"),
    source: FactoryTaskSource,
    ruleName: Schema.NullOr(ShortText),
  }),
  Schema.Struct({ type: Schema.Literal("comment"), body: CommentBody }),
  Schema.Struct({
    type: Schema.Literal("status"),
    from: FactoryTaskStatus,
    to: FactoryTaskStatus,
  }),
  Schema.Struct({ type: Schema.Literal("assigned"), assignee: FactoryTaskAssignee }),
  Schema.Struct({ type: Schema.Literal("edited") }),
  Schema.Struct({ type: Schema.Literal("subtasks-added"), count: PositiveInt }),
  Schema.Struct({ type: Schema.Literal("plan-proposed"), count: PositiveInt }),
  Schema.Struct({ type: Schema.Literal("plan-approved"), count: PositiveInt }),
  Schema.Struct({
    type: Schema.Literal("run-started"),
    ordinal: PositiveInt,
    threadId: ThreadId,
    setup: FactoryAgentSetup,
  }),
  Schema.Struct({
    type: Schema.Literal("run-ended"),
    ordinal: PositiveInt,
    threadId: ThreadId,
    outcome: RunOutcome,
    // Bounded excerpt of the failure, shown in monospace. Null when the run completed.
    note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
  }),
  Schema.Struct({
    type: Schema.Literal("result-ready"),
    revision: PositiveInt,
    summary: ShortText,
  }),
  Schema.Struct({ type: Schema.Literal("accepted"), revision: PositiveInt }),
  Schema.Struct({
    type: Schema.Literal("changes-requested"),
    revision: PositiveInt,
    note: CommentBody,
  }),
  Schema.Struct({ type: Schema.Literal("reopened") }),
]);
export type FactoryTaskActivityEvent = typeof FactoryTaskActivityEvent.Type;

export const FactoryTaskActivityEntry = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  at: IsoDateTime,
  actor: Schema.Struct({
    kind: Schema.Literals(["person", "agent", "rule", "system"]),
    // `You`, an agent label such as `Codex · Sol`, or a rule's name.
    label: ShortText,
  }),
  event: FactoryTaskActivityEvent,
});
export type FactoryTaskActivityEntry = typeof FactoryTaskActivityEntry.Type;

export const FactoryTaskActivityInput = Schema.Struct({
  ref: FactoryTaskRef,
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(Limit),
});
export type FactoryTaskActivityInput = typeof FactoryTaskActivityInput.Type;
/** Oldest first. */
export const FactoryTaskActivityResult = Schema.Struct({
  entries: Schema.Array(FactoryTaskActivityEntry).check(Schema.isMaxLength(50)),
  nextCursor: Schema.NullOr(Cursor),
  fetchedAt: IsoDateTime,
});
export type FactoryTaskActivityResult = typeof FactoryTaskActivityResult.Type;

export const FactoryTaskCommentResult = Schema.Struct({
  entry: FactoryTaskActivityEntry,
  replayed: Schema.Boolean,
});
export type FactoryTaskCommentResult = typeof FactoryTaskCommentResult.Type;

export const FactoryTaskByThreadInput = Schema.Struct({ threadId: ThreadId });
export type FactoryTaskByThreadInput = typeof FactoryTaskByThreadInput.Type;
export const FactoryTaskByThreadResult = Schema.Struct({
  task: Schema.NullOr(FactoryTaskSummary),
});
export type FactoryTaskByThreadResult = typeof FactoryTaskByThreadResult.Type;

/** Says which top-level tasks changed. Carries no task data: clients read what they show. */
export const FactoryTaskChange = Schema.Struct({
  environmentId: EnvironmentId,
  rootIds: Schema.Array(LocalId).check(Schema.isMaxLength(64)),
  // True when agent profiles changed, so resolved assignees may differ everywhere.
  profiles: Schema.Boolean,
});
export type FactoryTaskChange = typeof FactoryTaskChange.Type;

const ProfileName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
/** A named setup. Tasks and rules pick the name; cards and rows show what it resolves to. */
export const FactoryAgentProfile = Schema.Struct({
  id: LocalId,
  name: ProfileName,
  setup: FactoryAgentSetup,
  // Task types `auto` hands to this profile.
  handles: Schema.Array(FactoryTaskType).check(Schema.isMaxLength(5)),
  version: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryAgentProfile = typeof FactoryAgentProfile.Type;

export const FactoryAgentProfileListResult = Schema.Struct({
  profiles: Schema.Array(
    Schema.Struct({ profile: FactoryAgentProfile, tasksThisWeek: NonNegativeInt }),
  ).check(Schema.isMaxLength(64)),
  fetchedAt: IsoDateTime,
});
export type FactoryAgentProfileListResult = typeof FactoryAgentProfileListResult.Type;

/** Without `id` it makes a profile. With `id` it replaces one and needs `expectedVersion`. */
export const FactoryAgentProfileSaveInput = Schema.Struct({
  commandId: CommandId,
  id: Schema.optional(LocalId),
  expectedVersion: Schema.optional(NonNegativeInt),
  name: ProfileName,
  setup: FactoryAgentSetup,
  handles: Schema.Array(FactoryTaskType).check(Schema.isMaxLength(5)),
});
export type FactoryAgentProfileSaveInput = typeof FactoryAgentProfileSaveInput.Type;
/** Tasks and rules that named a deleted profile show as unassigned until reassigned. */
export const FactoryAgentProfileDeleteInput = Schema.Struct({
  commandId: CommandId,
  id: LocalId,
  expectedVersion: NonNegativeInt,
});
export type FactoryAgentProfileDeleteInput = typeof FactoryAgentProfileDeleteInput.Type;
export const FactoryAgentProfileMutationResult = Schema.Struct({
  // Null after a delete.
  profile: Schema.NullOr(FactoryAgentProfile),
  replayed: Schema.Boolean,
});
export type FactoryAgentProfileMutationResult = typeof FactoryAgentProfileMutationResult.Type;

const ProposalItem = Schema.Struct({
  // Local to the proposal. Approving turns each item into a sub-task.
  key: LocalId,
  title: Title,
  description: Description,
  assignment: FactoryTaskAssignment,
  // Keys of items in this proposal that must finish first.
  after: Schema.Array(LocalId).check(Schema.isMaxLength(16)),
});
/** Sub-tasks an agent proposed for a task. Nothing exists until a person approves it. */
export const FactoryTaskPlanProposal = Schema.Struct({
  id: LocalId,
  ref: FactoryTaskRef,
  status: Schema.Literals(["proposed", "approved", "dismissed"]),
  proposedBy: Schema.Struct({ threadId: ThreadId, setup: FactoryAgentSetup }),
  items: Schema.Array(ProposalItem).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  version: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryTaskPlanProposal = typeof FactoryTaskPlanProposal.Type;

/** Asks the chosen agent to propose sub-tasks and their order. It creates none. */
export const FactoryTaskBreakdownInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryTaskRef,
  expectedVersion: NonNegativeInt,
  setup: FactoryAgentSetup,
});
export type FactoryTaskBreakdownInput = typeof FactoryTaskBreakdownInput.Type;
export const FactoryTaskPlanProposalReadInput = Schema.Struct({ ref: FactoryTaskRef });
export type FactoryTaskPlanProposalReadInput = typeof FactoryTaskPlanProposalReadInput.Type;
export const FactoryTaskPlanProposalReadResult = Schema.Struct({
  // The proposal waiting on a person, if any.
  proposal: Schema.NullOr(FactoryTaskPlanProposal),
});
export type FactoryTaskPlanProposalReadResult = typeof FactoryTaskPlanProposalReadResult.Type;
export const FactoryTaskPlanProposalUpdateInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryTaskRef,
  proposalId: LocalId,
  expectedVersion: NonNegativeInt,
  items: Schema.Array(ProposalItem).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type FactoryTaskPlanProposalUpdateInput = typeof FactoryTaskPlanProposalUpdateInput.Type;
/** `approve` creates the sub-tasks, their assignees and their order in one step. */
export const FactoryTaskPlanProposalResolveInput = Schema.Struct({
  commandId: CommandId,
  ref: FactoryTaskRef,
  proposalId: LocalId,
  expectedVersion: NonNegativeInt,
  action: Schema.Literals(["approve", "dismiss"]),
});
export type FactoryTaskPlanProposalResolveInput = typeof FactoryTaskPlanProposalResolveInput.Type;
export const FactoryTaskPlanProposalMutationResult = Schema.Struct({
  proposal: FactoryTaskPlanProposal,
  task: FactoryTaskSummary,
  replayed: Schema.Boolean,
});
export type FactoryTaskPlanProposalMutationResult =
  typeof FactoryTaskPlanProposalMutationResult.Type;

export class FactoryTaskError extends Schema.TaggedError<FactoryTaskError>()("FactoryTaskError", {
  reason: Schema.Literals([
    "wrong-environment",
    "missing-project",
    "missing-task",
    "missing-profile",
    "missing-proposal",
    "forbidden",
    // `expectedVersion` is stale. `currentVersion` carries the one to retry with.
    "version-conflict",
    "command-conflict",
    "invalid-input",
    "invalid-cursor",
    // The lane move is not allowed from the task's current status.
    "invalid-transition",
    "run-active",
    // The task waits on an unfinished task and cannot start yet.
    "blocked",
    "no-run",
    "no-result",
    // The named result revision is not the latest one.
    "result-conflict",
    "assignee-unresolved",
    "provider-unavailable",
    "unsupported-capability",
    // A top-level task holds at most 64 tasks.
    "task-limit",
    "name-taken",
    "persistence-failure",
  ]),
  currentVersion: Schema.optional(NonNegativeInt),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `Task operation failed: ${this.reason}.`;
  }
}
