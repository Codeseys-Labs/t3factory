import type {
  CommandId,
  FactoryAgentSetup,
  FactoryTaskAcceptInput,
  FactoryTaskActivityInput,
  FactoryTaskActivityResult,
  FactoryTaskAssignee,
  FactoryTaskAssignment,
  FactoryTaskByThreadInput,
  FactoryTaskByThreadResult,
  FactoryTaskChange,
  FactoryTaskCommentInput,
  FactoryTaskCommentResult,
  FactoryTaskCountInput,
  FactoryTaskCountResult,
  FactoryTaskCreateInput,
  FactoryTaskDetail,
  FactoryTaskError,
  FactoryTaskListInput,
  FactoryTaskListResult,
  FactoryTaskMutationResult,
  FactoryTaskReadInput,
  FactoryTaskRef,
  FactoryTaskReopenInput,
  FactoryTaskRequestChangesInput,
  FactoryTaskResultReadInput,
  FactoryTaskResultReadResult,
  FactoryTaskRetryInput,
  FactoryTaskSource,
  FactoryTaskSummary,
  FactoryTaskStartInput,
  FactoryTaskStopInput,
  FactoryTaskType,
  FactoryTaskUpdateInput,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";

/** Set by intake when a source, not a person typing, is where the task came from. */
export interface FactoryTaskOrigin {
  readonly source: FactoryTaskSource;
  readonly ruleName: string | null;
}

export class FactoryTaskService extends Context.Service<
  FactoryTaskService,
  {
    readonly list: (
      input: FactoryTaskListInput,
    ) => Effect.Effect<FactoryTaskListResult, FactoryTaskError>;
    readonly count: (
      input: FactoryTaskCountInput,
    ) => Effect.Effect<FactoryTaskCountResult, FactoryTaskError>;
    readonly read: (
      input: FactoryTaskReadInput,
    ) => Effect.Effect<FactoryTaskDetail, FactoryTaskError>;
    readonly create: (
      input: FactoryTaskCreateInput,
      actor: FactoryPlanActor,
      origin?: FactoryTaskOrigin,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly update: (
      input: FactoryTaskUpdateInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly start: (
      input: FactoryTaskStartInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly stop: (
      input: FactoryTaskStopInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly retry: (
      input: FactoryTaskRetryInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly accept: (
      input: FactoryTaskAcceptInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly requestChanges: (
      input: FactoryTaskRequestChangesInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly reopen: (
      input: FactoryTaskReopenInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly readResult: (
      input: FactoryTaskResultReadInput,
    ) => Effect.Effect<FactoryTaskResultReadResult, FactoryTaskError>;
    readonly comment: (
      input: FactoryTaskCommentInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskCommentResult, FactoryTaskError>;
    readonly activity: (
      input: FactoryTaskActivityInput,
    ) => Effect.Effect<FactoryTaskActivityResult, FactoryTaskError>;
    readonly findByThread: (
      input: FactoryTaskByThreadInput,
    ) => Effect.Effect<FactoryTaskByThreadResult, FactoryTaskError>;
    /** One element per committed change. Never replays the past. */
    readonly changes: Stream.Stream<FactoryTaskChange>;
    /** What `assignment` would run for a task of this type in this project, without storing it. */
    readonly resolveAssignee: (input: {
      readonly projectId: ProjectId;
      readonly type: FactoryTaskType;
      readonly assignment: FactoryTaskAssignment;
    }) => Effect.Effect<FactoryTaskAssignee, FactoryTaskError>;
    /** Adds sub-tasks and their blockers to one parent in a single plan revision. */
    readonly createSubtasks: (
      input: {
        readonly commandId: CommandId;
        readonly parent: FactoryTaskRef;
        readonly items: ReadonlyArray<{
          // Local to this call; `after` names the keys of items that must finish first.
          readonly key: string;
          readonly title: string;
          readonly description: string;
          readonly assignment: FactoryTaskAssignment;
          readonly after: ReadonlyArray<string>;
        }>;
      },
      actor: FactoryPlanActor,
    ) => Effect.Effect<
      {
        readonly parent: FactoryTaskSummary;
        readonly created: ReadonlyArray<{
          readonly key: string;
          readonly task: FactoryTaskSummary;
        }>;
      },
      FactoryTaskError
    >;
    /** Planning reports its run here so the task's runs, live state and activity include it. */
    readonly recordPlanningRun: (input: {
      readonly ref: FactoryTaskRef;
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly setup: FactoryAgentSetup;
    }) => Effect.Effect<void, FactoryTaskError>;
    /** Planning reports a proposal's state here; `proposed` raises the `plan` attention reason. */
    readonly recordProposal: (input: {
      readonly ref: FactoryTaskRef;
      readonly proposalId: string;
      readonly itemCount: number;
      readonly status: "proposed" | "approved" | "dismissed";
      readonly actor: FactoryPlanActor;
    }) => Effect.Effect<void, FactoryTaskError>;
  }
>()("t3/factory/FactoryTaskService") {}
