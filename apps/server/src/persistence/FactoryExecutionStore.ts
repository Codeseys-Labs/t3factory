import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  FactoryExecutionError,
  FactoryExecutionGrant,
  FactoryExecutionBinding,
  FactoryExecutionOutput,
  FactoryExecutionAssembly,
  FactoryExecutionReadResult,
  FactoryPreparationAcceptance,
  OrchestrationV2RuntimeRequestJson,
  sessionGrantsScope,
  type FactoryExecutionAdmitInput,
  type FactoryExecutionRetryInput,
  type FactoryExecutionIssueGrantInput,
  type FactoryExecutionRevokeGrantInput,
  type FactoryExecutionStopInput,
  type FactoryPreparationAcceptInput,
  type FactoryExecutionRetryCaptureInput,
  type FactoryPreparationReopenInput,
  type FactoryExecutionReadInput,
  type FactoryExecutionOutputsInput,
  type FactoryExecutionOutputsResult,
  type FactoryExecutionOutputReadInput,
  type FactoryExecutionOutputReadResult,
  type FactoryExecutionInputPin,
  type FactoryExecutionTaskState,
  type FactoryPlanRef,
  type FactoryPlanSnapshot,
  type CommandId,
  type ThreadId,
  type RunId,
  type RunAttemptId,
  type RuntimeRequestId,
  type ProviderSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as AuthSessions from "./AuthSessions.ts";
import * as Plans from "./FactoryPlanStore.ts";
import type { FactoryPlanActor } from "../factory/FactoryPlanReducer.ts";
import {
  canonicalExecutionJson,
  executionBytesDigest,
  executionDigest,
} from "../factory/FactoryExecutionDigest.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";

export type FactoryExecutionActor = FactoryPlanActor | { readonly kind: "automation" };
export type FactoryExecutionPhase =
  | "workspace"
  | "setup"
  | "session"
  | "native-thread"
  | "turn"
  | "capture"
  | `response:${string}`;
export interface ObserveResultInput {
  readonly runId: RunId;
  readonly runAttemptId: RunAttemptId;
  readonly captureKey: string;
  readonly slot: string;
  readonly text: string;
  readonly status: "sealed" | "failed" | "held";
  readonly checkpoint: FactoryExecutionOutput["checkpoint"];
}
export type ExecutionOperation =
  | { readonly type: "grant"; readonly input: FactoryExecutionIssueGrantInput }
  | { readonly type: "revoke"; readonly input: FactoryExecutionRevokeGrantInput }
  | {
      readonly type: "admit";
      readonly input: FactoryExecutionAdmitInput;
      readonly binding: FactoryExecutionBinding;
    }
  | {
      readonly type: "retry";
      readonly input: FactoryExecutionRetryInput;
      readonly binding: FactoryExecutionBinding;
    }
  | { readonly type: "stop"; readonly input: FactoryExecutionStopInput }
  | { readonly type: "retryCapture"; readonly input: FactoryExecutionRetryCaptureInput }
  | { readonly type: "accept"; readonly input: FactoryPreparationAcceptInput }
  | { readonly type: "reopen"; readonly input: FactoryPreparationReopenInput }
  | { readonly type: "observe"; readonly input: ObserveResultInput }
  | { readonly type: "assemble"; readonly input: FactoryExecutionReadInput };
export interface FactoryExecutionCommit {
  readonly commandId: CommandId;
  readonly ref: FactoryPlanRef;
  readonly revision: number;
  readonly actor: FactoryExecutionActor;
  readonly digest: string;
  readonly now: string;
  readonly operation: ExecutionOperation;
}
export interface FactoryExecutionDecision {
  readonly replayed: boolean;
  readonly executeNative: boolean;
  readonly advance: boolean;
  readonly result: FactoryExecutionReadResult | null;
  readonly error: FactoryExecutionError["reason"] | null;
}
export interface PreparedAdmission {
  readonly spec: FactoryExecutionBinding["spec"];
  readonly inputText: string;
  readonly inputDigest: string;
  readonly prerequisites: ReadonlyArray<FactoryExecutionInputPin>;
  readonly taskVersion: number;
  readonly title: string;
}
type BindingLookup = {
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly runAttemptId?: RunAttemptId;
};
export type FactoryRuntimeResponseAuthorization = {
  readonly sessionId: AuthSessionId;
  readonly runAttemptId: RunAttemptId;
};
export type FactoryRuntimeResponseCheck = {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly providerSessionId: ProviderSessionId;
  readonly authorization: FactoryRuntimeResponseAuthorization;
  readonly expectedStatus: "pending" | "resolved";
};
type Claim = {
  readonly runAttemptId: RunAttemptId;
  readonly phase: FactoryExecutionPhase;
  readonly claimantId: string;
  readonly captureGeneration?: number;
  readonly runtimeResponse?: Omit<FactoryRuntimeResponseCheck, "expectedStatus">;
};
type Observation = "no-start" | "quiescent" | "unknown";
export class FactoryExecutionStore extends Context.Service<
  FactoryExecutionStore,
  {
    readonly readExecution: (
      input: FactoryExecutionReadInput,
    ) => Effect.Effect<FactoryExecutionReadResult, FactoryExecutionError>;
    readonly readOutputs: (
      input: FactoryExecutionOutputsInput,
    ) => Effect.Effect<FactoryExecutionOutputsResult, FactoryExecutionError>;
    readonly readOutput: (
      input: FactoryExecutionOutputReadInput,
    ) => Effect.Effect<FactoryExecutionOutputReadResult, FactoryExecutionError>;
    readonly prepareAdmission: (
      input: FactoryExecutionAdmitInput | FactoryExecutionRetryInput,
      actor: FactoryExecutionActor,
      now: string,
    ) => Effect.Effect<PreparedAdmission, FactoryExecutionError>;
    readonly decide: (
      input: FactoryExecutionCommit,
    ) => Effect.Effect<FactoryExecutionDecision, FactoryExecutionError>;
    readonly replay: (input: {
      readonly commandId: CommandId;
      readonly digest: string;
      readonly ref: FactoryPlanRef;
      readonly actor: FactoryExecutionActor;
    }) => Effect.Effect<FactoryExecutionReadResult | null, FactoryExecutionError>;
    readonly findNativeBinding: (
      input: BindingLookup,
    ) => Effect.Effect<FactoryExecutionBinding | null, FactoryExecutionError>;
    readonly getBinding: (
      attemptId: RunAttemptId,
    ) => Effect.Effect<FactoryExecutionBinding, FactoryExecutionError>;
    readonly authorizeRuntimeResponse: (
      input: FactoryRuntimeResponseCheck,
    ) => Effect.Effect<FactoryExecutionBinding, FactoryExecutionError>;
    readonly hasNativeClaims: (
      attemptId: RunAttemptId,
    ) => Effect.Effect<boolean, FactoryExecutionError>;
    /** Told to stop, writers not yet confirmed gone, and no outbox effect working on the thread. */
    readonly listHeldAttempts: (input: {
      readonly after: RunAttemptId | null;
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly runAttemptId: RunAttemptId;
      }>,
      FactoryExecutionError
    >;
    readonly canBeginCapture: (
      attemptId: RunAttemptId,
    ) => Effect.Effect<boolean, FactoryExecutionError>;
    readonly claimPhase: (
      input: Claim,
    ) => Effect.Effect<
      { readonly status: "claimed" | "suppressed" | "held" },
      FactoryExecutionError
    >;
    readonly settlePhase: (
      input: Claim & { readonly observation: Observation; readonly detail: string },
    ) => Effect.Effect<void, FactoryExecutionError>;
    readonly settleAttempt: (input: {
      readonly runAttemptId: RunAttemptId;
      readonly observation: Observation;
      readonly detail: string;
    }) => Effect.Effect<void, FactoryExecutionError>;
    readonly expireOrphanClaims: (input: {
      readonly runAttemptId: RunAttemptId;
    }) => Effect.Effect<void, FactoryExecutionError>;
    readonly requestNativeStop: (input: {
      readonly threadId: ThreadId;
      readonly runId?: RunId;
      readonly detail: string;
    }) => Effect.Effect<void, FactoryExecutionError>;
    readonly retainCapture: (
      input: ObserveResultInput,
    ) => Effect.Effect<void, FactoryExecutionError>;
    readonly readCapture: (
      attemptId: RunAttemptId,
    ) => Effect.Effect<ObserveResultInput | null, FactoryExecutionError>;
    readonly captureKey: (attemptId: RunAttemptId) => Effect.Effect<string, FactoryExecutionError>;
    readonly preparationHistory: (
      input: FactoryExecutionReadInput,
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<FactoryPreparationAcceptance> },
      FactoryExecutionError
    >;
    /** One element each time an attempt's writers are confirmed gone. Never replays the past. */
    readonly settlements: Stream.Stream<RunAttemptId>;
  }
>()("t3/persistence/FactoryExecutionStore") {}

const isFactoryExecutionError = Schema.is(FactoryExecutionError);
const failure = (cause: unknown) =>
  isFactoryExecutionError(cause)
    ? cause
    : new FactoryExecutionError({ reason: "persistence-failure", cause });
const decodeBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionBinding));
const decodeGrant = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionGrant));
const decodeRuntimeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJson),
);
const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionOutput));
const decodeAssembly = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionAssembly));
const decodeAcceptance = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FactoryPreparationAcceptance),
);
const decodeOutcome = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.NullOr(FactoryExecutionReadResult),
      error: Schema.NullOr(FactoryExecutionError.fields.reason),
    }),
  ),
);
type PrerequisiteProvenance = {
  readonly checkpoint: NonNullable<FactoryExecutionOutput["checkpoint"]>;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly baseRef: string | null;
};
const prerequisiteInputText = (
  edge: FactoryPlanSnapshot["edges"][number],
  output: FactoryExecutionOutput,
  text: string,
  provenance: PrerequisiteProvenance | null,
) =>
  [
    `Prerequisite ${edge.id} from task ${edge.toTaskId}: ${output.kind} output in slot ${output.slot}, status ${output.status}.`,
    ...(provenance
      ? [
          "Checkpoint:",
          `commit: ${provenance.checkpoint.commit}`,
          `tree: ${provenance.checkpoint.tree}`,
          `retainedRef: ${provenance.checkpoint.retainedRef}`,
          `verification: ${provenance.passed ? "passed" : "failed"} (exit code ${provenance.exitCode ?? "none"})`,
          `The commit is reachable from any worktree of this repository: git show ${provenance.checkpoint.commit}${provenance.baseRef ? `; git diff ${provenance.baseRef}..${provenance.checkpoint.commit}` : ""}`,
          "The retained text below is the producer's own account; the checkpoint above is authoritative when they disagree.",
        ]
      : []),
    `Retained text digest: ${output.digest}`,
    text,
  ].join("\n");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const plans = yield* Plans.FactoryPlanStore;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const settled = yield* PubSub.unbounded<RunAttemptId>();
  const requireSession = Effect.fn("FactoryExecutionStore.requireSession")(function* (
    sessionId: Parameters<typeof sessions.getById>[0]["sessionId"],
  ) {
    const session = yield* sessions.getById({ sessionId }).pipe(Effect.mapError(failure));
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
      return yield* new FactoryExecutionError({ reason: "forbidden" });
  });
  const getGrant = Effect.fn("FactoryExecutionStore.getGrant")(function* (ref: FactoryPlanRef) {
    const rows = yield* sql<{
      json: string;
    }>`SELECT grant_json AS json FROM factory_execution_grants WHERE root_id = ${ref.rootId} ORDER BY version DESC LIMIT 1`;
    return rows[0] ? yield* decodeGrant(rows[0].json) : null;
  }, Effect.mapError(failure));
  const getBinding = Effect.fn("FactoryExecutionStore.getBinding")(function* (
    attemptId: RunAttemptId,
  ) {
    const rows = yield* sql<{
      json: string;
      stopped: number;
      quiet: number;
    }>`SELECT binding_json AS json, stop_requested AS stopped, quiescent AS quiet FROM factory_execution_bindings WHERE attempt_id = ${attemptId}`;
    if (!rows[0]) return yield* new FactoryExecutionError({ reason: "task-conflict" });
    return {
      ...(yield* decodeBinding(rows[0].json)),
      stopRequested: rows[0].stopped === 1,
      quiescent: rows[0].quiet === 1,
    };
  }, Effect.mapError(failure));
  const findNativeBinding = Effect.fn("FactoryExecutionStore.findNativeBinding")(function* (
    input: BindingLookup,
  ) {
    const rows = yield* sql<{
      id: RunAttemptId;
    }>`SELECT attempt_id AS id FROM factory_execution_bindings WHERE thread_id = ${input.threadId}`;
    return rows[0] ? yield* getBinding(rows[0].id) : null;
  }, Effect.mapError(failure));
  const liveGrant = Effect.fn("FactoryExecutionStore.liveGrant")(function* (
    ref: FactoryPlanRef,
    revision: number,
    version: number,
    now: string,
    admitted?: RunAttemptId,
  ) {
    const plan = yield* plans.requireHead(ref, revision).pipe(
      Effect.mapError(
        (cause) =>
          new FactoryExecutionError({
            reason: cause.reason === "revision-conflict" ? "revision-conflict" : "missing-plan",
            cause,
          }),
      ),
    );
    const grant = yield* getGrant(ref);
    // A newer grant replaces the one before it, except for the attempts it names.
    const continued = admitted !== undefined && grant?.policy.continues?.includes(admitted);
    if (!grant || grant.revision !== revision || (grant.version !== version && !continued))
      return yield* new FactoryExecutionError({ reason: "grant-conflict" });
    if (grant.revokedAt !== null)
      return yield* new FactoryExecutionError({ reason: "grant-inactive" });
    if (Date.parse(grant.policy.expiresAt) <= Date.parse(now))
      return yield* new FactoryExecutionError({ reason: "grant-expired" });
    yield* requireSession(AuthSessionId.make(grant.issuerSessionId));
    return { grant, plan };
  });
  const authorize = Effect.fn("FactoryExecutionStore.authorize")(function* (
    actor: FactoryExecutionActor,
    ref: FactoryPlanRef,
    humanOnly: boolean,
  ) {
    yield* plans.requireProject(ref.projectId).pipe(Effect.mapError(failure));
    if (actor.kind === "human") return yield* requireSession(actor.sessionId);
    if (humanOnly) return yield* new FactoryExecutionError({ reason: "forbidden" });
    if (actor.kind === "agent") {
      const grant = yield* getGrant(ref);
      const rows =
        yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${actor.threadId} AND project_id = ${ref.projectId} AND deleted_at IS NULL`;
      if (!grant?.policy.requesterThreadIds.includes(actor.threadId) || rows.length !== 1)
        return yield* new FactoryExecutionError({ reason: "forbidden" });
    }
  }, Effect.mapError(failure));
  const outputById = Effect.fn("FactoryExecutionStore.outputById")(function* (id: string) {
    const rows = yield* sql<{
      json: string;
    }>`SELECT output_json AS json FROM factory_execution_results WHERE result_id = ${id}`;
    return rows[0] ? yield* decodeOutput(rows[0].json) : null;
  }, Effect.mapError(failure));
  const taskRows = Effect.fn("FactoryExecutionStore.taskRows")(function* (
    input: FactoryExecutionReadInput,
  ) {
    return yield* sql<{
      taskId: string;
      version: number;
      attemptId: RunAttemptId;
      resultId: string | null;
    }>`SELECT task_id AS taskId, version, attempt_id AS attemptId, selected_result_id AS resultId FROM factory_execution_tasks WHERE root_id = ${input.ref.rootId} AND revision = ${input.revision}`;
  }, Effect.mapError(failure));
  const authorizeRuntimeResponse = Effect.fn("FactoryExecutionStore.authorizeRuntimeResponse")(
    function* (input: FactoryRuntimeResponseCheck) {
      yield* requireSession(input.authorization.sessionId);
      const binding = yield* getBinding(input.authorization.runAttemptId);
      if (binding.threadId !== input.threadId)
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      if (binding.stopRequested || binding.quiescent)
        return yield* new FactoryExecutionError({ reason: "grant-inactive" });
      const { plan, grant } = yield* liveGrant(
        binding.selection.ref,
        binding.selection.revision,
        binding.grantVersion,
        DateTime.formatIso(yield* DateTime.now),
        binding.runAttemptId,
      );
      if (
        !plan.tasks.some((task) => task.id === binding.selection.taskId && !task.retired) ||
        !grant.policy.tasks.some((task) => task.taskId === binding.selection.taskId)
      )
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      const tasks = yield* taskRows({
        ref: binding.selection.ref,
        revision: binding.selection.revision,
      });
      const current = tasks.find((task) => task.taskId === binding.selection.taskId);
      if (current?.attemptId !== binding.runAttemptId || current.version !== binding.taskVersion)
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      const rows = yield* sql<{ json: string }>`
        SELECT request.payload_json AS json
        FROM orchestration_v2_projection_runtime_requests AS request
        JOIN orchestration_v2_projection_nodes AS node
          ON node.node_id = request.node_id
          AND node.thread_id = request.thread_id
          AND node.provider_turn_id = request.provider_turn_id
        JOIN orchestration_v2_projection_provider_turns AS turn
          ON turn.provider_turn_id = request.provider_turn_id
          AND turn.thread_id = request.thread_id
          AND turn.provider_thread_id = node.provider_thread_id
        JOIN orchestration_v2_projection_run_attempts AS attempt
          ON attempt.attempt_id = turn.run_attempt_id
          AND attempt.thread_id = request.thread_id
          AND attempt.run_id = node.run_id
          AND attempt.provider_thread_id = turn.provider_thread_id
        JOIN orchestration_v2_projection_runs AS run
          ON run.run_id = attempt.run_id
          AND run.thread_id = request.thread_id
          AND run.provider_thread_id = attempt.provider_thread_id
          AND json_extract(run.payload_json, '$.activeAttemptId') = attempt.attempt_id
        JOIN orchestration_v2_projection_provider_threads AS native
          ON native.provider_thread_id = attempt.provider_thread_id
          AND native.thread_id = request.thread_id
          AND native.provider_session_id = ${input.providerSessionId}
        JOIN orchestration_v2_projection_provider_session_bindings AS session_binding
          ON session_binding.thread_id = request.thread_id
          AND session_binding.provider_session_id = native.provider_session_id
        JOIN orchestration_v2_projection_provider_sessions AS session
          ON session.provider_session_id = session_binding.provider_session_id
        WHERE request.runtime_request_id = ${input.requestId}
          AND request.thread_id = ${input.threadId}
          AND request.status = ${input.expectedStatus}
          AND run.run_id = ${binding.runId}
          AND attempt.attempt_id = ${binding.runAttemptId}
          AND run.status IN ('starting', 'running', 'waiting')
          AND attempt.status IN ('pending', 'running')
          AND turn.status IN ('pending', 'running')
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_provider_turns AS newer
            WHERE newer.run_attempt_id = attempt.attempt_id
              AND newer.provider_thread_id = turn.provider_thread_id
              AND newer.ordinal > turn.ordinal
          )
          AND session.status IN ('ready', 'running', 'waiting')
          AND native.status IN ('idle', 'active')
      `;
      if (!rows[0]) return yield* new FactoryExecutionError({ reason: "task-conflict" });
      const request = yield* decodeRuntimeRequest(rows[0].json);
      if (
        request.id !== input.requestId ||
        request.status !== input.expectedStatus ||
        request.responseCapability.type !== "live" ||
        request.responseCapability.providerSessionId !== input.providerSessionId ||
        (input.expectedStatus === "resolved" &&
          (request.decision === "acceptForSession" || request.decision === "acceptAlways"))
      )
        return yield* new FactoryExecutionError({ reason: "forbidden" });
      return binding;
    },
    Effect.mapError(failure),
  );
  const latestCapture = Effect.fn("FactoryExecutionStore.latestCapture")(function* (
    attemptId: RunAttemptId,
  ) {
    const rows = yield* sql<{
      json: string;
    }>`SELECT output_json AS json FROM factory_execution_results WHERE attempt_id = ${attemptId} ORDER BY rowid DESC LIMIT 1`;
    return rows[0] ? yield* decodeOutput(rows[0].json) : null;
  }, Effect.mapError(failure));
  const nativeStatus = Effect.fn("FactoryExecutionStore.nativeStatus")(function* (
    binding: FactoryExecutionBinding,
  ) {
    const rows = yield* sql<{
      status: string;
    }>`SELECT json_extract(payload_json, '$.status') AS status FROM orchestration_v2_projection_runs WHERE run_id = ${binding.runId} AND thread_id = ${binding.threadId}`;
    return rows[0]?.status ?? "unknown";
  }, Effect.mapError(failure));
  const isFailed = (status: string) => ["failed", "interrupted", "cancelled"].includes(status);
  const prepareAdmission = Effect.fn("FactoryExecutionStore.prepareAdmission")(function* (
    input: FactoryExecutionAdmitInput | FactoryExecutionRetryInput,
    actor: FactoryExecutionActor,
    now: string,
  ): Effect.fn.Return<PreparedAdmission, FactoryExecutionError> {
    const { ref, revision, taskId } = input.selection;
    yield* authorize(actor, ref, false);
    const { grant, plan } = yield* liveGrant(ref, revision, input.grantVersion, now);
    const spec = grant.policy.tasks.find((entry) => entry.taskId === taskId);
    const task = plan.tasks.find((entry) => entry.id === taskId && !entry.retired);
    if (!spec || !task) return yield* new FactoryExecutionError({ reason: "invalid-input" });
    const limit = yield* DispatchModeLimit;
    if (actor.kind === "agent" && (!limit || exceededDispatchModeLimit(limit, spec)))
      return yield* new FactoryExecutionError({ reason: "forbidden" });
    const rows = yield* taskRows({ ref, revision });
    const row = rows.find((entry) => entry.taskId === taskId);
    if ((row?.version ?? 0) !== input.expectedTaskVersion)
      return yield* new FactoryExecutionError({ reason: "task-conflict" });
    if (row && !("intent" in input))
      return yield* new FactoryExecutionError({ reason: "task-conflict" });
    if ("intent" in input) {
      if (!row) return yield* new FactoryExecutionError({ reason: "task-conflict" });
      const prior = yield* getBinding(row.attemptId);
      const result = yield* latestCapture(row.attemptId);
      if (
        prior.runId !== input.priorRunId ||
        prior.runAttemptId !== input.priorRunAttemptId ||
        (result?.resultId ?? null) !== input.priorResultId
      )
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      if (!prior.quiescent) return yield* new FactoryExecutionError({ reason: "not-quiescent" });
      if (
        (!isFailed(yield* nativeStatus(prior)) && result?.status !== "failed") ||
        result?.status === "sealed"
      )
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      if (row.version > grant.policy.maxRetriesPerTask)
        return yield* new FactoryExecutionError({ reason: "budget-exhausted" });
    }
    const counts = yield* sql<{
      total: number;
      active: number;
    }>`SELECT count(*) AS total, coalesce(sum(CASE WHEN quiescent = 0 THEN 1 ELSE 0 END), 0) AS active FROM factory_execution_bindings WHERE root_id = ${ref.rootId} AND grant_version = ${grant.version}`.pipe(
      Effect.mapError(failure),
    );
    const allActive = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM factory_execution_bindings WHERE root_id = ${ref.rootId} AND quiescent = 0`.pipe(
      Effect.mapError(failure),
    );
    if (
      counts[0]!.total >= grant.policy.maxAttempts ||
      allActive[0]!.count >= grant.policy.maxConcurrent
    )
      return yield* new FactoryExecutionError({ reason: "budget-exhausted" });
    const prerequisites: FactoryExecutionInputPin[] = [];
    const board = yield* sql<{
      displayId: string;
      note: string | null;
      accepted: number | null;
    }>`SELECT display_id AS displayId, input_note AS note, accepted_revision AS accepted FROM factory_tasks WHERE root_id = ${ref.rootId} AND task_id = ${taskId}`.pipe(
      Effect.mapError(failure),
    );
    // Read where the binding is written: a task accepted on the board is done, and Accept sees
    // every run admitted before it, so the two never both land.
    if ((board[0]?.accepted ?? null) !== null)
      return yield* new FactoryExecutionError({ reason: "task-conflict" });
    const inputs: string[] = [
      task.title,
      task.context,
      ...plan.workContexts
        .filter((entry) => entry.taskId === taskId && !entry.retired)
        .map((entry) => entry.snapshot),
      // What a reviewer asked for on the previous result.
      ...(board[0]?.note ? [board[0].note] : []),
    ];
    for (const edge of plan.edges.filter(
      (entry) => !entry.retired && entry.fromTaskId === taskId,
    )) {
      const rule = grant.policy.edges.find((entry) => entry.edgeId === edge.id);
      if (!rule && grant.policy.advisoryEdges === true) continue;
      const predecessor = rows.find((entry) => entry.taskId === edge.toTaskId);
      const result = predecessor?.resultId ? yield* outputById(predecessor.resultId) : null;
      if (
        !rule ||
        !result ||
        result.status !== "sealed" ||
        result.kind !== rule.rule ||
        result.slot !== rule.slot
      )
        return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
      const producer = yield* getBinding(result.runAttemptId);
      if (!producer.quiescent || producer.selection.revision !== revision)
        return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
      const retained = yield* readOutput({
        selection: producer.selection,
        resultId: result.resultId,
      });
      prerequisites.push({
        edgeId: edge.id,
        taskId: edge.toTaskId,
        resultId: result.resultId,
        digest: result.digest,
        runId: result.runId,
        runAttemptId: result.runAttemptId,
      });
      let provenance: PrerequisiteProvenance | null = null;
      if (result.kind === "verified-code" && result.checkpoint) {
        const evidence = yield* sql<{
          passed: number | null;
          code: number | null;
        }>`SELECT json_extract(evidence_json, '$.passed') AS passed, json_extract(evidence_json, '$.evidence.code') AS code FROM factory_execution_verifications WHERE digest = ${result.checkpoint.verificationDigest} AND attempt_id = ${result.runAttemptId}`.pipe(
          Effect.mapError(failure),
        );
        if (!evidence[0]) return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
        provenance = {
          checkpoint: result.checkpoint,
          passed: evidence[0].passed === 1,
          exitCode: evidence[0].code,
          baseRef:
            producer.spec.workspaceStrategy.type === "worktree"
              ? producer.spec.workspaceStrategy.baseRef
              : null,
        };
      }
      inputs.push(prerequisiteInputText(edge, result, retained.text, provenance));
    }
    const inputText = inputs.join("\n\n");
    return {
      spec,
      inputText,
      prerequisites,
      inputDigest: executionDigest({ selection: input.selection, spec, inputText, prerequisites }),
      taskVersion: (row?.version ?? 0) + 1,
      // The thread sidebar lists a run under its task, as `T-41` followed by the title.
      title: board[0] ? `${board[0].displayId} ${task.title}` : task.title,
    };
  });
  const readOutputs = Effect.fn("FactoryExecutionStore.readOutputs")(function* (
    input: FactoryExecutionOutputsInput,
  ) {
    yield* plans.read({ ref: input.ref, revision: input.revision }).pipe(Effect.mapError(failure));
    const limit = input.limit ?? 20;
    const rows = yield* sql<{
      json: string;
    }>`SELECT output_json AS json FROM factory_execution_results WHERE root_id = ${input.ref.rootId} AND revision = ${input.revision} AND task_id = ${input.taskId} AND result_id < ${input.beforeResultId ?? "g"} ORDER BY result_id DESC LIMIT ${limit + 1}`;
    const items = yield* Effect.forEach(rows.slice(0, limit), (row) => decodeOutput(row.json));
    return { items, nextBeforeResultId: rows.length > limit ? items.at(-1)!.resultId : null };
  }, Effect.mapError(failure));
  const readOutput = Effect.fn("FactoryExecutionStore.readOutput")(function* (
    input: FactoryExecutionOutputReadInput,
  ) {
    yield* plans
      .read({ ref: input.selection.ref, revision: input.selection.revision })
      .pipe(Effect.mapError(failure));
    const rows = yield* sql<{
      json: string;
      bytes: Uint8Array;
    }>`SELECT output_json AS json, text_bytes AS bytes FROM factory_execution_results WHERE result_id = ${input.resultId} AND root_id = ${input.selection.ref.rootId} AND revision = ${input.selection.revision} AND task_id = ${input.selection.taskId}`;
    if (!rows[0]) return yield* new FactoryExecutionError({ reason: "missing-result" });
    const output = yield* decodeOutput(rows[0].json);
    if (executionBytesDigest(rows[0].bytes) !== output.digest)
      return yield* new FactoryExecutionError({ reason: "capture-conflict" });
    return {
      output,
      text: new TextDecoder("utf-8", { fatal: true }).decode(rows[0].bytes),
      binding: yield* getBinding(output.runAttemptId),
    };
  }, Effect.mapError(failure));
  const preparationHistory = Effect.fn("FactoryExecutionStore.preparationHistory")(function* (
    input: FactoryExecutionReadInput,
  ) {
    yield* plans.read(input).pipe(Effect.mapError(failure));
    const rows = yield* sql<{
      json: string;
    }>`SELECT acceptance_json AS json FROM factory_preparation_acceptances WHERE root_id = ${input.ref.rootId} AND revision = ${input.revision} ORDER BY rowid DESC LIMIT 50`;
    return { items: yield* Effect.forEach(rows, (row) => decodeAcceptance(row.json)) };
  }, Effect.mapError(failure));
  const readExecution = Effect.fn("FactoryExecutionStore.readExecution")(function* (
    input: FactoryExecutionReadInput,
  ): Effect.fn.Return<FactoryExecutionReadResult, FactoryExecutionError> {
    const plan = yield* plans.read(input).pipe(Effect.mapError(failure));
    const head = yield* plans.read({ ref: input.ref }).pipe(Effect.mapError(failure));
    const grant = yield* getGrant(input.ref);
    const rows = yield* taskRows(input);
    const tasks: FactoryExecutionTaskState[] = [];
    for (const task of plan.tasks) {
      const row = rows.find((entry) => entry.taskId === task.id);
      const binding = row ? yield* getBinding(row.attemptId) : null;
      const selectedResult = row?.resultId ? yield* outputById(row.resultId) : null;
      const captured = binding ? yield* latestCapture(binding.runAttemptId) : null;
      const status = binding ? yield* nativeStatus(binding) : null;
      const dependencyMissing =
        !binding &&
        plan.edges.some(
          (edge) =>
            !edge.retired &&
            edge.fromTaskId === task.id &&
            !rows.some(
              (predecessor) =>
                predecessor.taskId === edge.toTaskId && predecessor.resultId !== null,
            ),
        );
      const hold = task.retired
        ? "retired"
        : dependencyMissing
          ? "prerequisite-held"
          : binding &&
              !binding.quiescent &&
              (binding.stopRequested ||
                captured ||
                status === "completed" ||
                isFailed(status ?? ""))
            ? "writer-quiescence-unconfirmed"
            : captured?.status === "held"
              ? "capture-held"
              : null;
      tasks.push({
        taskId: task.id,
        version: row?.version ?? 0,
        binding,
        selectedResult,
        status: selectedResult
          ? "sealed"
          : hold
            ? "held"
            : binding
              ? isFailed(status ?? "") || captured?.status === "failed"
                ? "failed"
                : "running"
              : "idle",
        hold,
      });
    }
    const assemblies = yield* sql<{
      json: string;
    }>`SELECT manifest_json AS json FROM factory_execution_assemblies WHERE root_id = ${input.ref.rootId} AND revision = ${input.revision} ORDER BY rowid DESC LIMIT 1`.pipe(
      Effect.mapError(failure),
    );
    const settlements = yield* sql<{
      reopened: number;
    }>`SELECT reopened FROM factory_preparation_settlements WHERE root_id = ${input.ref.rootId} AND revision = ${input.revision}`.pipe(
      Effect.mapError(failure),
    );
    return {
      ...input,
      currentRevision: head.revision,
      grant,
      tasks,
      assembly: assemblies[0]
        ? yield* decodeAssembly(assemblies[0].json).pipe(Effect.mapError(failure))
        : null,
      acceptance: (yield* preparationHistory(input)).items[0] ?? null,
      reopened: settlements[0]?.reopened === 1,
    };
  });
  const assemble = Effect.fn("FactoryExecutionStore.assemble")(function* (
    input: FactoryExecutionReadInput,
    now: string,
  ) {
    const state = yield* readExecution(input);
    if (!state.grant) return;
    yield* liveGrant(input.ref, input.revision, state.grant.version, now);
    const required = state.grant.policy.tasks.map((entry) => entry.taskId);
    const outputs = state.tasks.flatMap((task) =>
      required.includes(task.taskId) && task.selectedResult ? [task.selectedResult] : [],
    );
    const inputs = state.tasks.flatMap((task) =>
      task.selectedResult && task.binding
        ? [
            {
              taskId: task.taskId,
              runId: task.binding.runId,
              runAttemptId: task.binding.runAttemptId,
              inputDigest: task.binding.inputDigest,
              prerequisites: task.binding.prerequisites,
            },
          ]
        : [],
    );
    const missingTaskIds = required.filter(
      (id) => !outputs.some((output) => output.selection.taskId === id),
    );
    const body = {
      ...input,
      outputs,
      inputs,
      missingTaskIds,
      edges: state.grant.policy.edges,
      complete: missingTaskIds.length === 0,
      scope: "local-preparation" as const,
    };
    const manifest: FactoryExecutionAssembly = {
      ...body,
      digest: executionDigest(body),
      createdAt: now,
    };
    yield* sql`INSERT INTO factory_execution_assemblies(digest, root_id, revision, manifest_json) VALUES (${manifest.digest}, ${input.ref.rootId}, ${input.revision}, ${canonicalExecutionJson(manifest)}) ON CONFLICT(digest) DO NOTHING`;
  }, Effect.mapError(failure));
  const retainCapture = Effect.fn("FactoryExecutionStore.retainCapture")(
    function* (input: ObserveResultInput) {
      const binding = yield* getBinding(input.runAttemptId);
      if (binding.runId !== input.runId || binding.spec.output.slot !== input.slot)
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      const bytes = new TextEncoder().encode(input.text);
      if (
        bytes.length > 2 * 1024 * 1024 ||
        input.text !== new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      )
        return yield* new FactoryExecutionError({ reason: "invalid-input" });
      const payloadDigest = executionDigest(input);
      const existing = yield* sql<{
        digest: string;
      }>`SELECT payload_digest AS digest FROM factory_execution_results WHERE attempt_id = ${input.runAttemptId} AND capture_key = ${input.captureKey}`;
      if (existing[0]) {
        if (existing[0].digest !== payloadDigest)
          return yield* new FactoryExecutionError({ reason: "capture-conflict" });
        return;
      }
      if (binding.spec.output.kind === "verified-code" && input.status === "sealed") {
        if (!input.checkpoint)
          return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
        const evidence =
          yield* sql`SELECT digest FROM factory_execution_verifications WHERE digest = ${input.checkpoint.verificationDigest} AND attempt_id = ${input.runAttemptId} AND json_extract(evidence_json, '$.passed') = 1 AND json_extract(evidence_json, '$.commit') = ${input.checkpoint.commit} AND json_extract(evidence_json, '$.tree') = ${input.checkpoint.tree} AND json_extract(evidence_json, '$.retainedRef') = ${input.checkpoint.retainedRef}`;
        if (evidence.length !== 1)
          return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
      }
      const output: FactoryExecutionOutput = {
        resultId: executionDigest([input.runAttemptId, input.captureKey, payloadDigest]),
        selection: binding.selection,
        runId: input.runId,
        runAttemptId: input.runAttemptId,
        captureKey: input.captureKey,
        slot: input.slot,
        kind: binding.spec.output.kind,
        digest: executionBytesDigest(bytes),
        byteLength: bytes.length,
        status: input.status,
        checkpoint: input.checkpoint,
        observedAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* sql`INSERT INTO factory_execution_results(result_id, attempt_id, capture_key, root_id, revision, task_id, payload_digest, output_json, text_bytes) VALUES (${output.resultId}, ${input.runAttemptId}, ${input.captureKey}, ${binding.selection.ref.rootId}, ${binding.selection.revision}, ${binding.selection.taskId}, ${payloadDigest}, ${canonicalExecutionJson(output)}, ${bytes})`;
    },
    (effect) => sql.withTransaction(effect),
    Effect.mapError(failure),
  );
  const readCapture = Effect.fn("FactoryExecutionStore.readCapture")(function* (
    attemptId: RunAttemptId,
  ) {
    const key = yield* captureKey(attemptId);
    const rows = yield* sql<{
      json: string;
    }>`SELECT output_json AS json FROM factory_execution_results WHERE attempt_id = ${attemptId} AND capture_key = ${key}`.pipe(
      Effect.mapError(failure),
    );
    const output = rows[0]
      ? yield* decodeOutput(rows[0].json).pipe(Effect.mapError(failure))
      : null;
    if (!output) return null;
    const retained = yield* readOutput({ selection: output.selection, resultId: output.resultId });
    return {
      runId: output.runId,
      runAttemptId: output.runAttemptId,
      captureKey: output.captureKey,
      slot: output.slot,
      text: retained.text,
      status: output.status,
      checkpoint: output.checkpoint,
    };
  });
  const captureKey = Effect.fn("FactoryExecutionStore.captureKey")(function* (
    attemptId: RunAttemptId,
  ) {
    const rows = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM factory_execution_capture_retries WHERE attempt_id = ${attemptId}`;
    return `native-final/${rows[0]!.count + 1}`;
  }, Effect.mapError(failure));
  const validatePolicy = (
    plan: FactoryPlanSnapshot,
    input: FactoryExecutionIssueGrantInput,
  ): boolean => {
    const policy = input.policy;
    const tasks = new Set(policy.tasks.map((entry) => entry.taskId));
    if (
      tasks.size !== policy.tasks.length ||
      !policy.maxAttempts ||
      !policy.maxConcurrent ||
      policy.maxConcurrent > policy.maxAttempts ||
      policy.requiredCapabilities.some((capability) => capability !== "owned-writers")
    )
      return false;
    if (
      policy.tasks.some(
        (entry) =>
          !plan.tasks.some((task) => task.id === entry.taskId && !task.retired) ||
          (entry.output.kind === "verified-code" &&
            (!entry.verification || entry.workspaceStrategy.type !== "worktree")),
      )
    )
      return false;
    const granted = plan.edges.filter((entry) => !entry.retired && tasks.has(entry.fromTaskId));
    const edges =
      policy.advisoryEdges === true
        ? granted.filter((edge) => policy.edges.some((rule) => rule.edgeId === edge.id))
        : granted;
    return (
      edges.length === policy.edges.length &&
      new Set(policy.edges.map((entry) => entry.edgeId)).size === edges.length &&
      edges.every(
        (edge) =>
          tasks.has(edge.toTaskId) &&
          policy.edges.some(
            (rule) =>
              rule.edgeId === edge.id &&
              policy.tasks.some(
                (task) =>
                  task.taskId === edge.toTaskId &&
                  task.output.slot === rule.slot &&
                  task.output.kind === rule.rule,
              ),
          ),
      )
    );
  };
  const apply = Effect.fn("FactoryExecutionStore.apply")(function* (
    commit: FactoryExecutionCommit,
  ): Effect.fn.Return<{ executeNative: boolean; advance: boolean }, FactoryExecutionError> {
    const op = commit.operation;
    if (op.type === "grant") {
      const plan = yield* plans
        .requireHead(commit.ref, op.input.expectedRevision)
        .pipe(Effect.mapError(failure));
      const prior = yield* getGrant(commit.ref);
      if ((prior?.version ?? 0) !== op.input.expectedGrantVersion)
        return yield* new FactoryExecutionError({ reason: "grant-conflict" });
      if (
        commit.actor.kind !== "human" ||
        !validatePolicy(plan, op.input) ||
        Date.parse(op.input.policy.expiresAt) <= Date.parse(commit.now)
      )
        return yield* new FactoryExecutionError({ reason: "invalid-input" });
      for (const attemptId of op.input.policy.continues ?? []) {
        const rows = yield* sql<{
          json: string;
        }>`SELECT binding_json AS json FROM factory_execution_bindings WHERE attempt_id = ${attemptId} AND root_id = ${commit.ref.rootId} AND revision = ${commit.revision}`.pipe(
          Effect.mapError(failure),
        );
        const spec = rows[0]
          ? canonicalExecutionJson(
              (yield* decodeBinding(rows[0].json).pipe(Effect.mapError(failure))).spec,
            )
          : null;
        // Continuing an attempt never changes what it was admitted to do.
        if (!op.input.policy.tasks.some((entry) => canonicalExecutionJson(entry) === spec))
          return yield* new FactoryExecutionError({ reason: "invalid-input" });
      }
      for (const threadId of op.input.policy.requesterThreadIds) {
        const rows =
          yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND project_id = ${commit.ref.projectId} AND deleted_at IS NULL`.pipe(
            Effect.mapError(failure),
          );
        if (rows.length !== 1) return yield* new FactoryExecutionError({ reason: "forbidden" });
      }
      const grant: FactoryExecutionGrant = {
        ref: commit.ref,
        revision: commit.revision,
        version: (prior?.version ?? 0) + 1,
        issuerSessionId: commit.actor.sessionId,
        issuedAt: commit.now,
        revokedAt: null,
        policy: op.input.policy,
      };
      yield* sql`INSERT INTO factory_execution_grants(root_id, version, grant_json) VALUES (${commit.ref.rootId}, ${grant.version}, ${canonicalExecutionJson(grant)})`.pipe(
        Effect.mapError(failure),
      );
    } else if (op.type === "revoke") {
      const grant = yield* getGrant(commit.ref);
      if (
        !grant ||
        grant.version !== op.input.expectedGrantVersion ||
        grant.revision !== op.input.expectedRevision
      )
        return yield* new FactoryExecutionError({ reason: "grant-conflict" });
      yield* sql`UPDATE factory_execution_grants SET grant_json = ${canonicalExecutionJson({ ...grant, revokedAt: commit.now })} WHERE root_id = ${commit.ref.rootId} AND version = ${grant.version}`.pipe(
        Effect.mapError(failure),
      );
    } else if (op.type === "admit" || op.type === "retry") {
      const prepared = yield* prepareAdmission(op.input, commit.actor, commit.now);
      const binding = op.binding;
      if (
        binding.inputDigest !== prepared.inputDigest ||
        canonicalExecutionJson(binding.spec) !== canonicalExecutionJson(prepared.spec) ||
        canonicalExecutionJson(binding.prerequisites) !==
          canonicalExecutionJson(prepared.prerequisites) ||
        binding.inputText !== prepared.inputText ||
        binding.taskVersion !== prepared.taskVersion ||
        canonicalExecutionJson(binding.selection) !== canonicalExecutionJson(op.input.selection) ||
        binding.grantVersion !== op.input.grantVersion ||
        binding.commandId !== commit.commandId
      )
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      yield* sql`INSERT INTO factory_execution_bindings(attempt_id, run_id, thread_id, root_id, revision, task_id, grant_version, binding_json) VALUES (${binding.runAttemptId}, ${binding.runId}, ${binding.threadId}, ${commit.ref.rootId}, ${commit.revision}, ${binding.selection.taskId}, ${binding.grantVersion}, ${canonicalExecutionJson(binding)})`.pipe(
        Effect.mapError(failure),
      );
      yield* sql`INSERT INTO factory_execution_tasks(root_id, revision, task_id, version, attempt_id, selected_result_id) VALUES (${commit.ref.rootId}, ${commit.revision}, ${binding.selection.taskId}, ${binding.taskVersion}, ${binding.runAttemptId}, NULL) ON CONFLICT(root_id, revision, task_id) DO UPDATE SET version = excluded.version, attempt_id = excluded.attempt_id, selected_result_id = NULL`.pipe(
        Effect.mapError(failure),
      );
      return { executeNative: true, advance: true };
    } else if (op.type === "retryCapture") {
      const binding = yield* getBinding(op.input.runAttemptId);
      const state = yield* readExecution({ ref: commit.ref, revision: commit.revision });
      const current = state.tasks.find((task) => task.taskId === binding.selection.taskId);
      const latest = yield* latestCapture(binding.runAttemptId);
      if (
        binding.runId !== op.input.runId ||
        canonicalExecutionJson(binding.selection) !== canonicalExecutionJson(op.input.selection) ||
        current?.binding?.runAttemptId !== binding.runAttemptId ||
        current.selectedResult !== null ||
        state.acceptance ||
        state.reopened ||
        (latest?.resultId ?? null) !== op.input.expectedResultId ||
        latest?.status === "sealed"
      )
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      const phases = yield* sql<{
        phase: string;
        claimantId: string;
        observation: string;
        detail: string;
      }>`SELECT phase, claimant_id AS claimantId, observation, detail FROM factory_execution_phases WHERE attempt_id = ${binding.runAttemptId}`.pipe(
        Effect.mapError(failure),
      );
      const capture = phases.find((phase) => phase.phase === "capture");
      if (
        !binding.stopRequested ||
        !capture ||
        phases.some((phase) => !["quiescent", "no-start"].includes(phase.observation))
      )
        return yield* new FactoryExecutionError({ reason: "not-quiescent" });
      const originalGrantRows = yield* sql<{
        json: string;
      }>`SELECT grant_json AS json FROM factory_execution_grants WHERE root_id = ${commit.ref.rootId} AND version = ${binding.grantVersion}`.pipe(
        Effect.mapError(failure),
      );
      const originalGrant = yield* decodeGrant(originalGrantRows[0]!.json).pipe(
        Effect.mapError(failure),
      );
      const retries = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM factory_execution_capture_retries WHERE attempt_id = ${binding.runAttemptId}`.pipe(
        Effect.mapError(failure),
      );
      if (retries[0]!.count >= originalGrant.policy.maxRetriesPerTask)
        return yield* new FactoryExecutionError({ reason: "budget-exhausted" });
      const active = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM factory_execution_bindings WHERE root_id = ${commit.ref.rootId} AND quiescent = 0`.pipe(
        Effect.mapError(failure),
      );
      if (binding.quiescent && active[0]!.count >= originalGrant.policy.maxConcurrent)
        return yield* new FactoryExecutionError({ reason: "budget-exhausted" });
      yield* sql`INSERT INTO factory_execution_capture_retries(attempt_id,generation,command_id,prior_phase_json) VALUES (${binding.runAttemptId},${retries[0]!.count + 1},${commit.commandId},${canonicalExecutionJson(capture)})`.pipe(
        Effect.mapError(failure),
      );
      yield* sql`DELETE FROM factory_execution_phases WHERE attempt_id = ${binding.runAttemptId} AND phase = 'capture'`.pipe(
        Effect.mapError(failure),
      );
      yield* sql`UPDATE factory_execution_bindings SET quiescent = 0 WHERE attempt_id = ${binding.runAttemptId}`.pipe(
        Effect.mapError(failure),
      );
      return { executeNative: true, advance: false };
    } else if (op.type === "stop") {
      const binding = yield* getBinding(op.input.runAttemptId);
      if (
        binding.runId !== op.input.runId ||
        canonicalExecutionJson(binding.selection) !== canonicalExecutionJson(op.input.selection)
      )
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      yield* sql`UPDATE factory_execution_bindings SET stop_requested = 1 WHERE attempt_id = ${binding.runAttemptId}`.pipe(
        Effect.mapError(failure),
      );
      return { executeNative: true, advance: false };
    } else if (op.type === "observe") {
      yield* retainCapture(op.input);
      const binding = yield* getBinding(op.input.runAttemptId);
      const observed = yield* sql<{
        json: string;
      }>`SELECT output_json AS json FROM factory_execution_results WHERE attempt_id = ${binding.runAttemptId} AND capture_key = ${op.input.captureKey}`.pipe(
        Effect.mapError(failure),
      );
      const output = observed[0]
        ? yield* decodeOutput(observed[0].json).pipe(Effect.mapError(failure))
        : null;
      const eligible = yield* liveGrant(
        commit.ref,
        commit.revision,
        binding.grantVersion,
        commit.now,
        binding.runAttemptId,
      ).pipe(Effect.result);
      const state = yield* readExecution({ ref: commit.ref, revision: commit.revision });
      const currentCaptureKey = yield* captureKey(binding.runAttemptId);
      const currentCapture =
        !op.input.captureKey.startsWith("native-final/") ||
        op.input.captureKey === currentCaptureKey;
      if (
        Result.isSuccess(eligible) &&
        currentCapture &&
        binding.quiescent &&
        output?.status === "sealed" &&
        !state.acceptance &&
        !state.reopened
      ) {
        const row = (yield* taskRows({ ref: commit.ref, revision: commit.revision })).find(
          (entry) => entry.taskId === binding.selection.taskId,
        );
        if (row?.attemptId === binding.runAttemptId && row.resultId === null) {
          yield* sql`UPDATE factory_execution_tasks SET selected_result_id = ${output.resultId} WHERE root_id = ${commit.ref.rootId} AND revision = ${commit.revision} AND task_id = ${binding.selection.taskId} AND attempt_id = ${binding.runAttemptId} AND selected_result_id IS NULL`.pipe(
            Effect.mapError(failure),
          );
          yield* assemble({ ref: commit.ref, revision: commit.revision }, commit.now);
          return { executeNative: false, advance: true };
        }
      }
    } else if (op.type === "assemble") {
      yield* assemble(op.input, commit.now);
    } else {
      const state = yield* readExecution({ ref: commit.ref, revision: commit.revision });
      yield* plans.requireHead(commit.ref, commit.revision).pipe(Effect.mapError(failure));
      if (
        op.input.selection.taskId !== commit.ref.rootId ||
        state.assembly?.digest !== op.input.expectedDigest ||
        !state.assembly.complete
      )
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      for (const output of state.assembly.outputs)
        yield* readOutput({ selection: output.selection, resultId: output.resultId });
      const { digest: recordedDigest, createdAt: _createdAt, ...manifestBody } = state.assembly;
      if (executionDigest(manifestBody) !== recordedDigest)
        return yield* new FactoryExecutionError({ reason: "capture-conflict" });
      if (op.type === "accept") {
        const actor = commit.actor;
        if (actor.kind !== "human")
          return yield* new FactoryExecutionError({ reason: "forbidden" });
        const acceptance: FactoryPreparationAcceptance = {
          selection: op.input.selection,
          digest: op.input.expectedDigest,
          commandId: commit.commandId,
          issuerSessionId: actor.sessionId,
          acceptedAt: commit.now,
          scope: op.input.scope,
          delivery: op.input.delivery,
        };
        yield* sql`INSERT INTO factory_preparation_acceptances(command_id, root_id, revision, acceptance_json) VALUES (${commit.commandId}, ${commit.ref.rootId}, ${commit.revision}, ${canonicalExecutionJson(acceptance)})`.pipe(
          Effect.mapError(failure),
        );
      } else if (!state.acceptance || state.acceptance.digest !== op.input.expectedDigest)
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      yield* sql`INSERT INTO factory_preparation_settlements(root_id, revision, digest, reopened) VALUES (${commit.ref.rootId}, ${commit.revision}, ${op.input.expectedDigest}, ${op.type === "reopen" ? 1 : 0}) ON CONFLICT(root_id, revision) DO UPDATE SET digest = excluded.digest, reopened = excluded.reopened`.pipe(
        Effect.mapError(failure),
      );
    }
    return { executeNative: false, advance: false };
  });
  const decide = Effect.fn("FactoryExecutionStore.decide")(function* (
    commit: FactoryExecutionCommit,
  ): Effect.fn.Return<FactoryExecutionDecision, FactoryExecutionError> {
    yield* authorize(
      commit.actor,
      commit.ref,
      ["grant", "revoke", "accept", "reopen", "retryCapture"].includes(commit.operation.type),
    );
    const receipts = yield* sql<{
      digest: string;
      root: string;
      json: string;
    }>`SELECT digest, root_id AS root, outcome_json AS json FROM factory_execution_commands WHERE command_id = ${commit.commandId}`.pipe(
      Effect.mapError(failure),
    );
    if (receipts[0]) {
      if (receipts[0].digest !== commit.digest || receipts[0].root !== commit.ref.rootId)
        return yield* new FactoryExecutionError({ reason: "command-conflict" });
      const outcome = yield* decodeOutcome(receipts[0].json).pipe(Effect.mapError(failure));
      return { ...outcome, replayed: true, executeNative: false, advance: false };
    }
    // A savepoint rolls back a rejected operation before its immutable rejection receipt is written.
    const applied = yield* sql
      .withTransaction(apply(commit))
      .pipe(Effect.mapError(failure), Effect.result);
    const result = Result.isSuccess(applied)
      ? yield* readExecution({ ref: commit.ref, revision: commit.revision })
      : null;
    const error = Result.isFailure(applied) ? applied.failure.reason : null;
    yield* sql`INSERT INTO factory_execution_commands(command_id, root_id, digest, outcome_json) VALUES (${commit.commandId}, ${commit.ref.rootId}, ${commit.digest}, ${canonicalExecutionJson({ result, error })})`.pipe(
      Effect.mapError(failure),
    );
    return {
      result,
      error,
      replayed: false,
      executeNative: Result.isSuccess(applied) && applied.success.executeNative,
      advance: Result.isSuccess(applied) && applied.success.advance,
    };
  });
  const replay = Effect.fn("FactoryExecutionStore.replay")(function* (input: {
    readonly commandId: CommandId;
    readonly digest: string;
    readonly ref: FactoryPlanRef;
    readonly actor: FactoryExecutionActor;
  }) {
    yield* authorize(input.actor, input.ref, false);
    const rows = yield* sql<{
      digest: string;
      root: string;
      json: string;
    }>`SELECT digest, root_id AS root, outcome_json AS json FROM factory_execution_commands WHERE command_id = ${input.commandId}`;
    if (!rows[0]) return null;
    if (rows[0].digest !== input.digest || rows[0].root !== input.ref.rootId)
      return yield* new FactoryExecutionError({ reason: "command-conflict" });
    const outcome = yield* decodeOutcome(rows[0].json);
    if (outcome.error !== null) return yield* new FactoryExecutionError({ reason: outcome.error });
    return outcome.result;
  }, Effect.mapError(failure));
  const requestNativeStop = Effect.fn("FactoryExecutionStore.requestNativeStop")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly runId?: RunId;
      readonly detail: string;
    }) {
      const binding = yield* findNativeBinding(input);
      if (!binding) return;
      if (input.runId !== undefined && binding.runId !== input.runId)
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      yield* sql`UPDATE factory_execution_bindings SET stop_requested = 1 WHERE attempt_id = ${binding.runAttemptId}`;
    },
    (effect) => sql.withTransaction(effect),
    Effect.mapError(failure),
  );
  const claimPhase = Effect.fn("FactoryExecutionStore.claimPhase")(
    function* (
      input: Claim,
    ): Effect.fn.Return<{ status: "claimed" | "suppressed" | "held" }, FactoryExecutionError> {
      const binding = yield* getBinding(input.runAttemptId);
      if (input.phase.startsWith("response:")) {
        const response = input.runtimeResponse;
        if (
          response === undefined ||
          input.phase !== `response:${response.requestId}` ||
          input.runAttemptId !== response.authorization.runAttemptId
        )
          return yield* new FactoryExecutionError({ reason: "forbidden" });
        yield* authorizeRuntimeResponse({ ...response, expectedStatus: "resolved" });
        const existing =
          yield* sql`SELECT phase FROM factory_execution_phases WHERE attempt_id = ${input.runAttemptId} AND phase = ${input.phase}`.pipe(
            Effect.mapError(failure),
          );
        if (existing.length > 0) return { status: "held" };
        yield* sql`INSERT INTO factory_execution_phases(attempt_id, phase, claimant_id, observation, detail) VALUES (${input.runAttemptId}, ${input.phase}, ${input.claimantId}, 'claimed', '')`.pipe(
          Effect.mapError(failure),
        );
        return { status: "claimed" };
      }
      if (
        input.phase === "capture" &&
        (yield* captureKey(input.runAttemptId)) !== `native-final/${input.captureGeneration ?? 1}`
      )
        return { status: "held" };
      const rows =
        yield* sql`SELECT phase FROM factory_execution_phases WHERE attempt_id = ${input.runAttemptId} AND phase = ${input.phase}`.pipe(
          Effect.mapError(failure),
        );
      if (rows.length > 0 || binding.quiescent) return { status: "held" };
      const now = DateTime.formatIso(yield* DateTime.now);
      const allowed = yield* liveGrant(
        binding.selection.ref,
        binding.selection.revision,
        binding.grantVersion,
        now,
        binding.runAttemptId,
      ).pipe(Effect.result);
      const attempts = yield* sql<{
        status: string;
      }>`SELECT json_extract(payload_json, '$.status') AS status FROM orchestration_v2_projection_run_attempts WHERE attempt_id = ${input.runAttemptId} AND run_id = ${binding.runId}`.pipe(
        Effect.mapError(failure),
      );
      const capture =
        input.phase === "capture" &&
        ["completed", "failed", "interrupted", "cancelled"].includes(attempts[0]?.status ?? "");
      if (input.phase === "capture" && !capture) return { status: "held" };
      if (capture) {
        const outstanding =
          yield* sql`SELECT phase FROM factory_execution_phases WHERE attempt_id = ${input.runAttemptId} AND phase <> 'capture' AND observation NOT IN ('no-start','quiescent')`.pipe(
            Effect.mapError(failure),
          );
        if (outstanding.length > 0) return { status: "held" };
      }
      const suppressed = !capture && (binding.stopRequested || Result.isFailure(allowed));
      yield* sql`INSERT INTO factory_execution_phases(attempt_id, phase, claimant_id, observation, detail) VALUES (${input.runAttemptId}, ${input.phase}, ${input.claimantId}, ${suppressed ? "no-start" : "claimed"}, ${suppressed ? "authorization-suppressed" : ""})`.pipe(
        Effect.mapError(failure),
      );
      return { status: suppressed ? "suppressed" : "claimed" };
    },
    (effect) => sql.withTransaction(effect),
    Effect.mapError(failure),
  );
  const settlePhase = Effect.fn("FactoryExecutionStore.settlePhase")(
    function* (input: Claim & { readonly observation: Observation; readonly detail: string }) {
      const rows =
        yield* sql`UPDATE factory_execution_phases SET observation = ${input.observation}, detail = ${input.detail.slice(0, 512)} WHERE attempt_id = ${input.runAttemptId} AND phase = ${input.phase} AND claimant_id = ${input.claimantId} AND observation IN ('claimed','unknown',${input.observation}) RETURNING attempt_id`;
      if (rows.length !== 1) return yield* new FactoryExecutionError({ reason: "task-conflict" });
    },
    (effect) => sql.withTransaction(effect),
    Effect.mapError(failure),
  );
  const settleAttempt = Effect.fn("FactoryExecutionStore.settleAttempt")(
    function* (input: {
      readonly runAttemptId: RunAttemptId;
      readonly observation: Observation;
      readonly detail: string;
    }) {
      if (input.observation === "unknown") return;
      const binding = yield* getBinding(input.runAttemptId);
      if (!binding.stopRequested)
        return yield* new FactoryExecutionError({ reason: "not-quiescent" });
      const phases = yield* sql<{
        phase: string;
        observation: string;
      }>`SELECT phase, observation FROM factory_execution_phases WHERE attempt_id = ${input.runAttemptId}`;
      if (phases.some((phase) => !["no-start", "quiescent"].includes(phase.observation)))
        return yield* new FactoryExecutionError({ reason: "not-quiescent" });
      const captured =
        phases.some((phase) => phase.phase === "capture" && phase.observation === "quiescent") &&
        (yield* readCapture(input.runAttemptId)) !== null;
      if (
        phases.some((phase) => phase.phase === "turn" && phase.observation !== "no-start") &&
        !captured
      )
        return yield* new FactoryExecutionError({ reason: "not-quiescent" });
      const pending = yield* sql<{
        type: string;
      }>`SELECT effect_type AS type FROM orchestration_v2_effect_outbox WHERE thread_id = ${binding.threadId} AND status IN ('pending','running')`;
      const fenced = new Set([
        "factory.execution.prepare",
        "provider-turn.start",
        "factory.execution.stop",
        "factory.execution.advance",
      ]);
      if (
        pending.some((effect) =>
          effect.type === "factory.execution.finalize" ? !captured : !fenced.has(effect.type),
        )
      )
        return yield* new FactoryExecutionError({ reason: "not-quiescent" });
      // The stop tombstone and settled claims retire replayable phase effects; retained capture is read-only on replay.
      yield* sql`UPDATE factory_execution_bindings SET quiescent = 1 WHERE attempt_id = ${input.runAttemptId}`;
    },
    (effect) => sql.withTransaction(effect),
    Effect.mapError(failure),
    // After the commit, so a listener reads the settled attempt.
    (effect, input) =>
      input.observation === "unknown"
        ? effect
        : Effect.tap(effect, () => PubSub.publish(settled, input.runAttemptId)),
  );
  // Claimants exist only in the owning process. With no owner registered, outstanding
  // claimed/unknown rows belong to a dead process; settleAttempt's all-settled gate
  // would otherwise wedge the attempt forever after a restart.
  const expireOrphanClaims = Effect.fn("FactoryExecutionStore.expireOrphanClaims")(
    function* (input: { readonly runAttemptId: RunAttemptId }) {
      yield* sql`UPDATE factory_execution_phases SET observation = 'no-start', detail = 'Claimant process exited without settling; expired by recovery.' WHERE attempt_id = ${input.runAttemptId} AND observation IN ('claimed','unknown')`;
    },
    (effect) => sql.withTransaction(effect),
    Effect.mapError(failure),
  );
  const hasNativeClaims = Effect.fn("FactoryExecutionStore.hasNativeClaims")(function* (
    attemptId: RunAttemptId,
  ) {
    return (
      (yield* sql`SELECT phase FROM factory_execution_phases WHERE attempt_id = ${attemptId} LIMIT 1`)
        .length > 0
    );
  }, Effect.mapError(failure));
  const listHeldAttempts = Effect.fn("FactoryExecutionStore.listHeldAttempts")(function* (input: {
    readonly after: RunAttemptId | null;
    readonly limit: number;
  }) {
    return yield* sql<{
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly runAttemptId: RunAttemptId;
    }>`SELECT thread_id AS threadId, run_id AS runId, attempt_id AS runAttemptId FROM factory_execution_bindings b WHERE stop_requested = 1 AND quiescent = 0 AND attempt_id > ${input.after ?? ""} AND NOT EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox e WHERE e.thread_id = b.thread_id AND e.status IN ('pending','running')) ORDER BY attempt_id LIMIT ${input.limit}`;
  }, Effect.mapError(failure));
  const canBeginCapture = Effect.fn("FactoryExecutionStore.canBeginCapture")(function* (
    attemptId: RunAttemptId,
  ) {
    const binding = yield* getBinding(attemptId);
    if (!binding.stopRequested || binding.quiescent) return false;
    const retries =
      yield* sql`SELECT attempt_id FROM factory_execution_capture_retries WHERE attempt_id = ${attemptId} LIMIT 1`;
    const phases = yield* sql<{
      phase: string;
      observation: string;
    }>`SELECT phase, observation FROM factory_execution_phases WHERE attempt_id = ${attemptId}`;
    return (
      retries.length === 1 &&
      !phases.some(
        (phase) =>
          phase.phase === "capture" || !["quiescent", "no-start"].includes(phase.observation),
      )
    );
  }, Effect.mapError(failure));
  return FactoryExecutionStore.of({
    readExecution,
    readOutputs,
    readOutput,
    prepareAdmission,
    decide,
    replay,
    getBinding,
    hasNativeClaims,
    listHeldAttempts,
    canBeginCapture,
    findNativeBinding,
    authorizeRuntimeResponse,
    claimPhase,
    settlePhase,
    settleAttempt,
    expireOrphanClaims,
    requestNativeStop,
    retainCapture,
    readCapture,
    captureKey,
    preparationHistory,
    settlements: Stream.fromPubSub(settled),
  });
});
export const layer = Layer.effect(FactoryExecutionStore, make).pipe(
  Layer.provide(Layer.mergeAll(Plans.layer, AuthSessions.layer)),
);
