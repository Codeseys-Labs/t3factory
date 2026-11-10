import {
  FactoryPlanError,
  FactoryPlanSnapshot,
  AuthOrchestrationOperateScope,
  sessionGrantsScope,
  type FactoryPlanRef,
  FactoryPlanSummary,
  type FactoryPlanOperation,
  type FactoryPlanWorkContext,
  type FactoryPlanListInput,
  type FactoryPlanListResult,
  type FactoryPlanHistoryInput,
  type FactoryPlanHistoryResult,
  type FactoryPlanReadInput,
  type CommandId,
  type EventId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  canEditFactoryPlan,
  reduceFactoryPlan,
  type FactoryPlanActor,
} from "../factory/FactoryPlanReducer.ts";
import * as AuthSessions from "./AuthSessions.ts";
import * as Tasks from "./FactoryTaskStore.ts";

export interface FactoryPlanCommit {
  readonly commandId: CommandId;
  readonly eventId: EventId;
  readonly ref: FactoryPlanRef;
  readonly expectedRevision: number;
  readonly requestDigest: string;
  readonly actor: FactoryPlanActor;
  readonly create: { readonly title: string; readonly context: string } | null;
  readonly operations: ReadonlyArray<FactoryPlanOperation>;
  readonly contexts: ReadonlyArray<FactoryPlanWorkContext>;
  readonly resolutionFailed: boolean;
  readonly occurredAt: string;
}

const Outcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("accepted"), revision: Schema.Number }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    reason: FactoryPlanError.fields.reason,
    currentRevision: Schema.optional(Schema.Number),
  }),
]);
type Outcome = typeof Outcome.Type;
export type FactoryPlanDecision =
  | {
      readonly status: "accepted";
      readonly plan: FactoryPlanSnapshot;
      readonly currentRevision: number;
      readonly replayed: boolean;
    }
  | { readonly status: "rejected"; readonly error: FactoryPlanError; readonly replayed: boolean };

export class FactoryPlanStore extends Context.Service<
  FactoryPlanStore,
  {
    readonly requireProject: (projectId: ProjectId) => Effect.Effect<void, FactoryPlanError>;
    readonly requireHead: (
      ref: FactoryPlanRef,
      revision: number,
    ) => Effect.Effect<FactoryPlanSnapshot, FactoryPlanError>;
    readonly read: (
      input: FactoryPlanReadInput,
    ) => Effect.Effect<FactoryPlanSnapshot, FactoryPlanError>;
    readonly list: (
      input: FactoryPlanListInput,
    ) => Effect.Effect<FactoryPlanListResult, FactoryPlanError>;
    readonly history: (
      input: FactoryPlanHistoryInput,
    ) => Effect.Effect<FactoryPlanHistoryResult, FactoryPlanError>;
    readonly hasCommand: (commandId: CommandId) => Effect.Effect<boolean, FactoryPlanError>;
    readonly decide: (
      input: FactoryPlanCommit,
    ) => Effect.Effect<FactoryPlanDecision, FactoryPlanError>;
    readonly project: (
      plan: FactoryPlanSnapshot,
      expectedRevision: number,
    ) => Effect.Effect<void, FactoryPlanError>;
    readonly record: (
      input: FactoryPlanCommit,
      decision: FactoryPlanDecision,
    ) => Effect.Effect<void, FactoryPlanError>;
  }
>()("t3/persistence/FactoryPlanStore") {}

const encodePlan = Schema.encodeEffect(Schema.fromJsonString(FactoryPlanSnapshot));
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(FactoryPlanSummary));
const encodeOutcome = Schema.encodeEffect(Schema.fromJsonString(Outcome));

function summary(plan: FactoryPlanSnapshot): FactoryPlanSummary {
  const root = plan.tasks.find((task) => task.id === plan.ref.rootId)!;
  return {
    ref: plan.ref,
    revision: plan.revision,
    title: root.title,
    retired: root.retired,
    updatedAt: plan.updatedAt,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const tasks = yield* Tasks.FactoryTaskStore;
  const failure = (cause: unknown) =>
    new FactoryPlanError({ reason: "persistence-failure", cause });
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryPlanSnapshot));
  const decodeOutcome = Schema.decodeUnknownEffect(Schema.fromJsonString(Outcome));
  const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryPlanSummary));

  const requireProject = Effect.fn("FactoryPlanStore.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const rows =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`.pipe(
        Effect.mapError(failure),
      );
    if (rows.length === 0) return yield* new FactoryPlanError({ reason: "missing-project" });
  });
  const head = Effect.fn("FactoryPlanStore.head")(function* (ref: FactoryPlanRef) {
    const rows = yield* sql<{
      snapshot: string;
    }>`SELECT snapshot_json AS snapshot FROM factory_plan_heads WHERE root_id = ${ref.rootId} AND project_id = ${ref.projectId}`.pipe(
      Effect.mapError(failure),
    );
    if (rows[0] === undefined) return null;
    const plan = yield* decode(rows[0].snapshot).pipe(Effect.mapError(failure));
    if (plan.ref.environmentId !== ref.environmentId)
      return yield* new FactoryPlanError({ reason: "wrong-environment" });
    return plan;
  });
  const read = Effect.fn("FactoryPlanStore.read")(function* (input: FactoryPlanReadInput) {
    yield* requireProject(input.ref.projectId);
    const current = yield* head(input.ref);
    if (current === null) return yield* new FactoryPlanError({ reason: "missing-plan" });
    if (input.revision === undefined) return current;
    const rows = yield* sql<{
      snapshot: string;
    }>`SELECT snapshot_json AS snapshot FROM factory_plan_revisions WHERE root_id = ${input.ref.rootId} AND revision = ${input.revision}`.pipe(
      Effect.mapError(failure),
    );
    if (rows[0] === undefined) return yield* new FactoryPlanError({ reason: "missing-plan" });
    return yield* decode(rows[0].snapshot).pipe(Effect.mapError(failure));
  });
  const list = Effect.fn("FactoryPlanStore.list")(function* (input: FactoryPlanListInput) {
    yield* requireProject(input.projectId);
    const limit = input.limit ?? 20;
    const rows = yield* sql<{
      summary: string;
      rootId: string;
    }>`SELECT summary_json AS summary, root_id AS rootId FROM factory_plan_heads WHERE project_id = ${input.projectId} AND root_id > ${input.afterRootId ?? ""} ORDER BY root_id LIMIT ${limit + 1}`.pipe(
      Effect.mapError(failure),
    );
    const selected = rows.slice(0, limit);
    const plans = yield* Effect.forEach(selected, (row) =>
      decodeSummary(row.summary).pipe(Effect.mapError(failure)),
    );
    return { items: plans, nextRootId: rows.length > limit ? selected.at(-1)!.rootId : null };
  });
  const history = Effect.fn("FactoryPlanStore.history")(function* (input: FactoryPlanHistoryInput) {
    yield* read({ ref: input.ref });
    const limit = input.limit ?? 20;
    const rows = yield* sql<{
      summary: string;
    }>`SELECT summary_json AS summary FROM factory_plan_revisions WHERE root_id = ${input.ref.rootId} AND revision < ${input.beforeRevision ?? Number.MAX_SAFE_INTEGER} ORDER BY revision DESC LIMIT ${limit + 1}`.pipe(
      Effect.mapError(failure),
    );
    const plans = yield* Effect.forEach(rows.slice(0, limit), (row) =>
      decodeSummary(row.summary).pipe(Effect.mapError(failure)),
    );
    return {
      items: plans,
      nextBeforeRevision: rows.length > limit ? plans.at(-1)!.revision : null,
    };
  });
  const hasCommand = Effect.fn("FactoryPlanStore.hasCommand")(function* (commandId: CommandId) {
    return (
      (yield* sql`SELECT command_id FROM factory_plan_commands WHERE command_id = ${commandId}`.pipe(
        Effect.mapError(failure),
      )).length > 0
    );
  });
  const requireThread = Effect.fn("FactoryPlanStore.requireThread")(function* (
    threadId: ThreadId,
    projectId: ProjectId,
  ) {
    const rows =
      yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND project_id = ${projectId} AND deleted_at IS NULL`.pipe(
        Effect.mapError(failure),
      );
    if (rows.length === 0) return yield* new FactoryPlanError({ reason: "forbidden" });
  });
  const decide = Effect.fn("FactoryPlanStore.decide")(function* (
    input: FactoryPlanCommit,
  ): Effect.fn.Return<FactoryPlanDecision, FactoryPlanError> {
    if (input.actor.kind === "human") {
      const session = yield* sessions
        .getById({ sessionId: input.actor.sessionId })
        .pipe(Effect.mapError(failure));
      const now = yield* DateTime.now;
      if (
        Option.isNone(session) ||
        session.value.revokedAt !== null ||
        session.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
        !sessionGrantsScope(
          { authenticated: true, scopes: session.value.scopes },
          AuthOrchestrationOperateScope,
        )
      )
        return yield* new FactoryPlanError({ reason: "forbidden" });
    }
    yield* requireProject(input.ref.projectId);
    const current = yield* head(input.ref);
    if (input.actor.kind === "agent") {
      if (input.create !== null || current === null || !canEditFactoryPlan(current, input.actor))
        return yield* new FactoryPlanError({ reason: "forbidden" });
      yield* requireThread(input.actor.threadId, input.ref.projectId);
    }
    const receipts = yield* sql<{
      rootId: string;
      digest: string;
      outcome: string;
    }>`SELECT root_id AS rootId, request_digest AS digest, outcome_json AS outcome FROM factory_plan_commands WHERE command_id = ${input.commandId}`.pipe(
      Effect.mapError(failure),
    );
    const receipt = receipts[0];
    if (receipt !== undefined) {
      if (receipt.rootId !== input.ref.rootId || receipt.digest !== input.requestDigest)
        return yield* new FactoryPlanError({ reason: "command-conflict" });
      const outcome = yield* decodeOutcome(receipt.outcome).pipe(Effect.mapError(failure));
      if (outcome.status === "rejected")
        return {
          status: "rejected",
          error: new FactoryPlanError({
            reason: outcome.reason,
            ...(outcome.currentRevision === undefined
              ? {}
              : { currentRevision: outcome.currentRevision }),
          }),
          replayed: true,
        };
      const plan = yield* read({ ref: input.ref, revision: outcome.revision });
      return { status: "accepted", plan, currentRevision: current!.revision, replayed: true };
    }
    const reject = (reason: FactoryPlanError["reason"]): FactoryPlanDecision => ({
      status: "rejected",
      error: new FactoryPlanError({
        reason,
        ...(current === null ? {} : { currentRevision: current.revision }),
      }),
      replayed: false,
    });
    if ((current?.revision ?? 0) !== input.expectedRevision) return reject("revision-conflict");
    if (input.resolutionFailed) return reject("context-unavailable");
    if (input.create !== null) {
      if (current !== null) return reject("revision-conflict");
      const plan: FactoryPlanSnapshot = {
        ref: input.ref,
        revision: 1,
        tasks: [
          {
            id: input.ref.rootId,
            parentId: null,
            title: input.create.title,
            context: input.create.context,
            order: 0,
            retired: false,
          },
        ],
        edges: [],
        workContexts: [],
        editorThreadIds: [],
        createdAt: input.occurredAt,
        updatedAt: input.occurredAt,
      };
      return { status: "accepted", plan, currentRevision: 1, replayed: false };
    }
    if (current === null) return reject("missing-plan");
    for (const op of input.operations) {
      if (op.type !== "editor.grant") continue;
      if (input.actor.kind !== "human") return reject("forbidden");
      const allowed = yield* requireThread(op.threadId, input.ref.projectId).pipe(Effect.result);
      if (Result.isFailure(allowed)) {
        if (allowed.failure.reason !== "forbidden") return yield* allowed.failure;
        return reject("forbidden");
      }
    }
    const result = reduceFactoryPlan(
      current,
      input.operations,
      input.actor,
      input.contexts,
      input.occurredAt,
    );
    return Result.isFailure(result)
      ? { status: "rejected", error: result.failure, replayed: false }
      : {
          status: "accepted",
          plan: result.success,
          currentRevision: result.success.revision,
          replayed: false,
        };
  });
  const project = Effect.fn("FactoryPlanStore.project")(function* (
    plan: FactoryPlanSnapshot,
    expectedRevision: number,
  ) {
    const json = yield* encodePlan(plan).pipe(Effect.mapError(failure));
    const summaryJson = yield* encodeSummary(summary(plan)).pipe(Effect.mapError(failure));
    const rows =
      expectedRevision === 0
        ? yield* sql`INSERT INTO factory_plan_heads(root_id, project_id, revision, snapshot_json, summary_json) VALUES (${plan.ref.rootId}, ${plan.ref.projectId}, ${plan.revision}, ${json}, ${summaryJson}) ON CONFLICT(root_id) DO NOTHING RETURNING root_id`.pipe(
            Effect.mapError(failure),
          )
        : yield* sql`UPDATE factory_plan_heads SET revision = ${plan.revision}, snapshot_json = ${json}, summary_json = ${summaryJson} WHERE root_id = ${plan.ref.rootId} AND project_id = ${plan.ref.projectId} AND revision = ${expectedRevision} RETURNING root_id`.pipe(
            Effect.mapError(failure),
          );
    if (rows.length !== 1) return yield* new FactoryPlanError({ reason: "revision-conflict" });
    yield* sql`INSERT INTO factory_plan_revisions(root_id, revision, snapshot_json, summary_json) VALUES (${plan.ref.rootId}, ${plan.revision}, ${json}, ${summaryJson})`.pipe(
      Effect.mapError(failure),
    );
    // Every plan task is a task on the board, whoever edited the plan.
    yield* tasks.projectPlan(plan).pipe(Effect.mapError(failure));
  });
  const record = Effect.fn("FactoryPlanStore.record")(function* (
    input: FactoryPlanCommit,
    decision: FactoryPlanDecision,
  ) {
    const outcome: Outcome =
      decision.status === "accepted"
        ? { status: "accepted", revision: decision.plan.revision }
        : {
            status: "rejected",
            reason: decision.error.reason,
            ...(decision.error.currentRevision === undefined
              ? {}
              : { currentRevision: decision.error.currentRevision }),
          };
    const outcomeJson = yield* encodeOutcome(outcome);
    yield* sql`INSERT INTO factory_plan_commands(command_id, root_id, request_digest, outcome_json) VALUES (${input.commandId}, ${input.ref.rootId}, ${input.requestDigest}, ${outcomeJson})`;
  }, Effect.mapError(failure));
  return FactoryPlanStore.of({
    requireHead: Effect.fn("FactoryPlanStore.requireHead")(function* (ref, revision) {
      yield* requireProject(ref.projectId);
      const current = yield* head(ref);
      if (current === null) return yield* new FactoryPlanError({ reason: "missing-plan" });
      if (current.revision !== revision)
        return yield* new FactoryPlanError({ reason: "revision-conflict" });
      return current;
    }),
    requireProject,
    read,
    list,
    history,
    hasCommand,
    decide,
    project,
    record,
  });
});
export const layer = Layer.effect(FactoryPlanStore, make).pipe(
  Layer.provide(Layer.merge(AuthSessions.layer, Tasks.layer)),
);
