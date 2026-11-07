import {
  CommandId,
  FactoryPlanError,
  FactoryExecutionError,
  EventId,
  type FactoryExecutionMutationResult,
  type FactoryPlanMutationResult,
  type OrchestrationV2Run,
  OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  OrchestrationV2StoredEvent,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  NodeId,
  type ProjectId,
  type ProviderApprovalOption,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { replayAndBufferProjectedLiveEvents } from "./LiveStreamBudget.ts";
import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";
import { makeRunOutcomeRecorder, type RunOutcome } from "./RunMetrics.ts";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as FactoryPlans from "../persistence/FactoryPlanStore.ts";
import * as FactoryExecutions from "../persistence/FactoryExecutionStore.ts";

const isFactoryPlanError = Schema.is(FactoryPlanError);
const isFactoryExecutionError = Schema.is(FactoryExecutionError);
const MANAGED_APPROVAL_OPTIONS = [
  { decision: "accept", label: "Allow once" },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Cancel" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export class EventSinkWriteError extends Schema.TaggedError<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedError<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

export interface EventSinkV2Shape {
  readonly commitFactoryExecutionCommand: (input: {
    readonly command: FactoryExecutions.FactoryExecutionCommit;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<FactoryExecutionMutationResult, FactoryExecutionError>;
  readonly commitFactoryPlanCommand: (
    input: FactoryPlans.FactoryPlanCommit,
  ) => Effect.Effect<FactoryPlanMutationResult, FactoryPlanError>;
  readonly write: (input: {
    /** Return no events if another thread owns this native session at commit time. */
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeWithEffects: (input: {
    /**
     * Rebuilds each run.updated from the stored row with only its delegatedCompletion replaced.
     * The batch must not also change that run's lifecycle.
     */
    readonly updateDelegatedCompletionOnly?: boolean;
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeIfRunCurrent: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedStatus: OrchestrationV2Run["status"];
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects?: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /** Commits only if the expected attempt and ordinal still own the provider thread, protecting newer attempts. */
  readonly writeIfProviderThreadOwner: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly providerThreadId: ProviderThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedLastRunOrdinal: number;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /** Commits only if the full provider row equals expected; some writers do not advance updatedAt. */
  readonly writeIfProviderThreadUnchanged: (input: {
    readonly expected: OrchestrationV2ProviderThread;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly commitCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
    /** Like writeWithEffects' updateDelegatedCompletionOnly, for this run's run.updated only. */
    readonly updateDelegatedCompletionOnlyRunId?: RunId;
  }) => Effect.Effect<
    {
      readonly receipt: CommandReceiptStore.CommandReceiptV2;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
      readonly committed: boolean;
      readonly cancelledEffectCount: number;
    },
    EventSinkV2Error
  >;
  readonly commitRejectedCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.CommandReceiptV2, EventSinkV2Error>;
  readonly commitProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly event: UnsequencedProjectEvent;
  }) => Effect.Effect<
    { readonly receipt: CommandReceiptStore.ProjectCommandReceiptV2; readonly committed: boolean },
    EventSinkV2Error
  >;
  readonly commitRejectedProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.ProjectCommandReceiptV2, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    /** Bound RPC subscribers; internal workers must not drop their subscription under load. */
    readonly bounded?: boolean;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "t3/orchestration-v2/EventSink/EventSinkV2",
) {}

const layerBase: Layer.Layer<
  EventSinkV2,
  never,
  | CommandReceiptStore.CommandReceiptStoreV2
  | EffectOutbox.EffectOutboxV2
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | SqlClient.SqlClient
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const factoryPlans = yield* FactoryPlans.FactoryPlanStore;
    const factoryExecutions = yield* FactoryExecutions.FactoryExecutionStore;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const liveEventsByType = new Map<
      OrchestrationV2DomainEvent["type"],
      PubSub.PubSub<OrchestrationV2StoredEvent>
    >();
    const publishLiveEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* PubSub.publishAll(liveEvents, events);
        for (const [type, pubsub] of liveEventsByType) {
          yield* PubSub.publishAll(
            pubsub,
            events.filter((stored) => stored.event.type === type),
          );
        }
      });
    const runOutcomes = makeRunOutcomeRecorder((threadId) =>
      // One payload row; unlike the shell, it still resolves a deleted child thread.
      projectionStore
        .getThread(threadId)
        .pipe(Effect.map((thread) => thread.lineage.relationshipToParent === "subagent")),
    );
    // Recorded before publication, so an interrupted publish cannot lose a committed outcome.
    const publishStoredEvents = (
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
      outcomes: ReadonlyArray<RunOutcome>,
    ) =>
      runOutcomes
        .record(outcomes)
        .pipe(
          Effect.andThen(eventStore.publishCommitted(events)),
          Effect.andThen(publishLiveEvents(events)),
        );

    // Serialize commit and publish; reordered publication makes clients drop earlier sequences.
    const publishLane = yield* Semaphore.make(1);
    const commitThenPublish = <A, E, R>(
      transaction: Effect.Effect<A, E, R>,
      publish: (committed: A) => Effect.Effect<void>,
    ) =>
      Effect.uninterruptibleMask((restore) => {
        let holdsLane = false;
        const takeLane = publishLane.take(1).pipe(
          Effect.andThen(
            Effect.sync(() => {
              holdsLane = true;
            }),
          ),
          Effect.uninterruptible,
        );
        // Cancellation may roll back the transaction's work. Once it commits,
        // every subscriber must hear about it before this writer can exit.
        // Otherwise a failed child run can leave its parent's task running.
        return sql
          .withTransaction(Effect.tap(restore(transaction), () => takeLane))
          .pipe(
            Effect.tap(publish),
            Effect.ensuring(
              Effect.suspend(() => (holdsLane ? publishLane.release(1) : Effect.void)),
            ),
          );
      });

    // A user can answer after terminal normalization reads the pending request.
    // Recheck inside the write transaction so stale cleanup cannot erase answers.
    const guardUserInputCancellations =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
        const staleRequests = new Set<RuntimeRequestId>();
        const staleNodes = new Set<NodeId>();
        for (const event of events) {
          if (
            event.type !== "runtime-request.updated" ||
            event.payload.kind !== "user_input" ||
            event.payload.status !== "cancelled"
          )
            continue;
          const current = yield* projectionStore.getRuntimeRequest(
            event.threadId,
            event.payload.id,
          );
          if (
            current?.status !== "pending" ||
            current.kind !== "user_input" ||
            current.providerTurnId !== event.payload.providerTurnId ||
            current.responseCapability.type === "message"
          ) {
            staleRequests.add(event.payload.id);
            staleNodes.add(event.payload.nodeId);
          }
        }
        return events.filter((event) => {
          switch (event.type) {
            case "runtime-request.updated":
              return event.payload.status !== "cancelled" || !staleRequests.has(event.payload.id);
            case "node.updated":
              return event.payload.status !== "cancelled" || !staleNodes.has(event.payload.id);
            case "turn-item.updated":
              return (
                event.payload.type !== "user_input_request" ||
                event.payload.status !== "cancelled" ||
                !staleRequests.has(event.payload.requestId)
              );
            default:
              return true;
          }
        });
      });

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const runOrdinals = new Map(
        events.flatMap((event) =>
          event.type === "run.created" || event.type === "run.updated"
            ? [[event.payload.id, event.payload.ordinal] as const]
            : [],
        ),
      );
      return Effect.forEach(
        events,
        (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> =>
          event.type !== "turn-item.updated"
            ? Effect.succeed(event)
            : Effect.gen(function* () {
                const payload = yield* turnItemPositions.normalize(
                  event.payload,
                  event.payload.runId === null ? undefined : runOrdinals.get(event.payload.runId),
                );
                if (
                  payload.type !== "approval_request" ||
                  (yield* factoryExecutions.findNativeBinding({ threadId: event.threadId })) ===
                    null
                )
                  return { ...event, payload };
                const options = (payload.options ?? MANAGED_APPROVAL_OPTIONS).filter(
                  (option) =>
                    option.decision !== "acceptForSession" && option.decision !== "acceptAlways",
                );
                return { ...event, payload: { ...payload, options } };
              }),
        { concurrency: 1 },
      );
    };

    const applyStoredEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* Effect.forEach(storedEvents, (stored) => projectionStore.apply(stored.event), {
          concurrency: 1,
        });
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }
        // Read lineage here, on the connection this transaction holds; see makeRunOutcomeRecorder.
        return yield* runOutcomes.prepare(storedEvents);
      });

    // The enclosing write or commit span already traces this per-event projection merge.
    const updateDelegatedCompletionOnly = Effect.fnUntraced(function* (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
      includesRun: (runId: RunId) => boolean,
    ) {
      return yield* Effect.forEach(events, (event) =>
        Effect.gen(function* () {
          if (event.type !== "run.updated" || !includesRun(event.payload.id)) return event;
          const { runs } = yield* projectionStore.getThreadRecords(event.threadId, ["runs"], {
            runIds: [event.payload.id],
          });
          const current = runs[0];
          return current === undefined
            ? event
            : {
                ...event,
                payload: { ...current, delegatedCompletion: event.payload.delegatedCompletion },
              };
        }),
      );
    });

    const writeEffect = Effect.fn("orchestrationV2.EventSink.write")(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
      });

      const { committed } = yield* commitThenPublish(
        Effect.gen(function* () {
          // Check ownership in the same transaction that claims the native session.
          const imported = input.unlessNativeThreadOwned;
          if (imported?.nativeThreadRef != null) {
            const owners = yield* sql`
              SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads
              WHERE driver = ${imported.driver}
                AND provider_instance_id = ${imported.providerInstanceId}
                AND thread_id IS NOT ${imported.appThreadId}
                AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${imported.nativeThreadRef.nativeId}
              LIMIT 1
            `;
            if (owners.length > 0) return { committed: [], outcomes: [] };
          }
          // Checkpoint capture can finish after a cohort writer reads its parent run.
          // Merge in this transaction so the event log and projection keep that completion.
          const events = input.updateDelegatedCompletionOnly
            ? yield* updateDelegatedCompletionOnly(input.events, () => true)
            : input.events;
          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(events)
              : events,
          );
          const committed = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          const outcomes = yield* applyStoredEvents(committed);
          yield* effectOutbox.enqueue(input.effects);
          return { committed, outcomes };
        }).pipe(Effect.withTracerEnabled(false)),
        ({ committed, outcomes }) =>
          Effect.gen(function* () {
            if (input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            yield* publishStoredEvents(committed, outcomes);
          }),
      );
      return committed;
    });

    const writeIfRunCurrentEffect = Effect.fn("orchestrationV2.EventSink.writeIfRunCurrent")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.command_id": input.commandId ?? null,
          "orchestration_v2.event_count": input.events.length,
          "orchestration_v2.run_id": input.runId,
          "orchestration_v2.thread_id": input.threadId,
        });

        return yield* commitThenPublish(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly status: string;
              readonly active_attempt_id: string | null;
            }>`
            SELECT
              status,
              json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.runId}
              AND thread_id = ${input.threadId}
            LIMIT 1
          `;
            const current = rows[0];
            if (
              current === undefined ||
              current.status !== input.expectedStatus ||
              current.active_attempt_id !== input.activeAttemptId
            ) {
              return {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }

            const normalized = yield* normalizeEvents(
              input.guardPendingUserInputCancellations === true
                ? yield* guardUserInputCancellations(input.events)
                : input.events,
            );
            const storedEvents = yield* eventStore.append({
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              events: normalized,
            });
            const outcomes = yield* applyStoredEvents(storedEvents);
            yield* effectOutbox.enqueue(input.effects ?? []);
            return { committed: true as const, storedEvents, outcomes };
          }),
          (result) =>
            Effect.gen(function* () {
              if (!result.committed) return;
              if (input.effects !== undefined && input.effects.length > 0) {
                yield* effectOutbox.notifyAvailable(input.effects.length);
              }
              yield* publishStoredEvents(result.storedEvents, result.outcomes);
            }),
        );
      },
    );

    const writeIfProviderThreadOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadOwner",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadOwner"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.providerThreadId,
        "orchestration_v2.run_id": input.runId,
        "orchestration_v2.active_attempt_id": input.activeAttemptId,
        "orchestration_v2.expected_last_run_ordinal": input.expectedLastRunOrdinal,
      });

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly active_attempt_id: string | null;
            readonly last_run_ordinal: number | null;
          }>`
            SELECT
              json_extract(r.payload_json, '$.activeAttemptId') AS active_attempt_id,
              p.last_run_ordinal
            FROM orchestration_v2_projection_provider_threads p
            JOIN orchestration_v2_projection_runs r
              ON r.run_id = ${input.runId}
             AND r.thread_id = p.thread_id
            WHERE p.provider_thread_id = ${input.providerThreadId}
            LIMIT 1
          `;
          const current = rows[0];
          if (
            current === undefined ||
            current.active_attempt_id !== input.activeAttemptId ||
            current.last_run_ordinal !== input.expectedLastRunOrdinal
          ) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(input.events)
              : input.events,
          );
          const storedEvents = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          const outcomes = yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents, outcomes };
        }),
        (result) =>
          result.committed
            ? publishStoredEvents(result.storedEvents, result.outcomes)
            : Effect.void,
      );
    });

    const writeIfProviderThreadUnchangedEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadUnchanged",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadUnchanged"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.expected.id,
      });
      const expectedJson = yield* ProjectionStore.encodeProviderThreadPayload(input.expected);

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${input.expected.id}
            LIMIT 1
          `;
          if (rows[0]?.payload_json !== expectedJson) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(input.events);
          const storedEvents = yield* eventStore.append({ events: normalized });
          const outcomes = yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents, outcomes };
        }),
        (result) =>
          result.committed
            ? publishStoredEvents(result.storedEvents, result.outcomes)
            : Effect.void,
      );
    });

    const existingCommandResult =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (commandId: CommandId) {
        const existing = yield* commandReceipts.getByCommandId(commandId);
        if (Option.isNone(existing)) {
          return yield* Effect.die(
            new Error(`Command receipt ${commandId} disappeared during its transaction.`),
          );
        }
        const storedEvents = yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        );
        return { receipt: existing.value, storedEvents };
      });

    const commitCommandEffect = Effect.fn("orchestrationV2.EventSink.commitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    ) {
      const result = yield* commitThenPublish(
        Effect.gen(function* () {
          const reserved = yield* commandReceipts.insertIfAbsent({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: 0,
            status: "accepted",
            error: null,
          });
          if (!reserved) {
            const existing = yield* existingCommandResult(input.commandId);
            return { ...existing, committed: false as const, cancelledEffectIds: [] };
          }
          for (const effect of input.effects) {
            if (effect.request.type !== "runtime-request.respond") continue;
            const managed = yield* factoryExecutions.findNativeBinding({
              threadId: effect.threadId,
            });
            if (managed === null) continue;
            const authorization = effect.request.factoryAuthorization;
            if (
              authorization === undefined ||
              effect.request.decision === "acceptForSession" ||
              effect.request.decision === "acceptAlways"
            )
              return yield* new FactoryExecutionError({ reason: "forbidden" });
            yield* factoryExecutions.authorizeRuntimeResponse({
              threadId: effect.threadId,
              requestId: effect.request.requestId,
              providerSessionId: effect.request.providerSessionId,
              authorization,
              expectedStatus: "pending",
            });
          }

          const runId = input.updateDelegatedCompletionOnlyRunId;
          const normalized = yield* normalizeEvents(
            runId === undefined
              ? input.events
              : yield* updateDelegatedCompletionOnly(input.events, (id) => id === runId),
          );
          const storedEvents = yield* eventStore.append({
            commandId: input.commandId,
            events: normalized,
          });
          // A Stop that changes nothing can still queue the stop of its delegated tasks.
          const sequence =
            storedEvents.at(-1)?.sequence ??
            (input.effects.length === 0
              ? undefined
              : yield* eventStore.latestSequence({ threadId: input.threadId }));
          if (sequence === undefined) {
            return yield* Effect.die(
              new Error(`Command ${input.commandId} produced no orchestration events.`),
            );
          }
          const outcomes = yield* applyStoredEvents(storedEvents);
          yield* effectOutbox.enqueue(input.effects);
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: sequence,
            status: "accepted",
            error: null,
          };
          yield* commandReceipts.upsert(receipt);
          const cancelledEffectIds =
            input.cancelUnsettledEffects === undefined
              ? []
              : yield* effectOutbox.cancelUnsettled({
                  threadId: input.threadId,
                  ...input.cancelUnsettledEffects,
                });
          return { receipt, storedEvents, outcomes, committed: true as const, cancelledEffectIds };
        }),
        (result) =>
          Effect.gen(function* () {
            yield* effectOutbox.signalCancellations(result.cancelledEffectIds);
            if (result.committed && input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            if (result.committed) yield* publishStoredEvents(result.storedEvents, result.outcomes);
          }),
      );
      return {
        receipt: result.receipt,
        storedEvents: result.storedEvents,
        committed: result.committed,
        cancelledEffectCount: result.cancelledEffectIds.length,
      };
    });

    const commitRejectedCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: sequence,
            status: "rejected",
            error: input.error,
          };
          const inserted = yield* commandReceipts.insertIfAbsent(receipt);
          if (inserted) {
            return receipt;
          }
          const existing = yield* commandReceipts.getByCommandId(input.commandId);
          return Option.getOrElse(existing, () => receipt);
        }),
      );
    });

    const commitFactoryPlanCommand = Effect.fn(
      "orchestrationV2.EventSink.commitFactoryPlanCommand",
    )(function* (input: FactoryPlans.FactoryPlanCommit) {
      const result = yield* commitThenPublish(
        Effect.gen(function* () {
          const decision = yield* factoryPlans.decide(input);
          if (decision.replayed) return { decision, event: undefined };
          const receipt: CommandReceiptStore.ProjectCommandReceiptV2 = {
            commandId: input.commandId,
            projectId: input.ref.projectId,
            commandType: "factory.plan.apply",
            acceptedAt: DateTime.makeUnsafe(input.occurredAt),
            resultSequence: 0,
            status: decision.status,
            error: decision.status === "rejected" ? decision.error.reason : null,
          };
          if (!(yield* commandReceipts.insertIfAbsent(receipt)))
            return yield* new FactoryPlanError({ reason: "command-conflict" });
          const event =
            decision.status === "accepted"
              ? yield* eventStore.appendProjectEvent({
                  eventId: input.eventId,
                  aggregateKind: "project",
                  aggregateId: input.ref.projectId,
                  occurredAt: input.occurredAt,
                  commandId: input.commandId,
                  causationEventId: null,
                  correlationId: input.commandId,
                  metadata: {},
                  type: "project.factory-plan-revised",
                  payload: {
                    projectId: input.ref.projectId,
                    expectedRevision: input.expectedRevision,
                    plan: decision.plan,
                    actor: input.actor,
                    requestDigest: input.requestDigest,
                  },
                })
              : undefined;
          if (event?.type === "project.factory-plan-revised") {
            yield* factoryPlans.project(event.payload.plan, event.payload.expectedRevision);
            yield* projectStore.apply(event);
            yield* commandReceipts.upsert({ ...receipt, resultSequence: event.sequence });
          }
          yield* factoryPlans.record(input, decision);
          return { decision, event };
        }),
        ({ event }) => (event === undefined ? Effect.void : eventStore.publishCommitted([event])),
      ).pipe(
        Effect.mapError((cause) =>
          isFactoryPlanError(cause)
            ? cause
            : new FactoryPlanError({ reason: "persistence-failure", cause }),
        ),
      );
      if (result.decision.status === "rejected") return yield* result.decision.error;
      return {
        plan: result.decision.plan,
        current: result.decision.currentRevision === result.decision.plan.revision,
        replayed: result.decision.replayed,
      };
    });

    const commitFactoryExecutionCommand = Effect.fn(
      "orchestrationV2.EventSink.commitFactoryExecutionCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitFactoryExecutionCommand"]>[0]) {
      const command = input.command;
      const committed = yield* commitThenPublish(
        Effect.gen(function* () {
          const decision = yield* factoryExecutions.decide(command);
          if (decision.replayed)
            return {
              decision,
              storedEvents: [],
              outcomes: [],
              projectEvent: undefined,
              effects: [],
            };
          const operation = command.operation;
          if (
            decision.executeNative &&
            (operation.type === "admit" || operation.type === "retry")
          ) {
            const binding = operation.binding;
            const occupied =
              yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${binding.threadId}`;
            const existingRun =
              yield* sql`SELECT run_id FROM orchestration_v2_projection_runs WHERE run_id = ${binding.runId}`;
            const thread = input.events.find((event) => event.type === "thread.created");
            const run = input.events.find((event) => event.type === "run.created");
            const attempt = input.events.find((event) => event.type === "run-attempt.created");
            if (
              occupied.length ||
              existingRun.length ||
              thread?.threadId !== binding.threadId ||
              run?.type !== "run.created" ||
              run.payload.id !== binding.runId ||
              run.payload.activeAttemptId !== binding.runAttemptId ||
              attempt?.type !== "run-attempt.created" ||
              attempt.payload.id !== binding.runAttemptId ||
              attempt.payload.runId !== binding.runId
            )
              return yield* new FactoryExecutionError({ reason: "task-conflict" });
          }
          const events = decision.executeNative ? input.events : [];
          if (decision.executeNative && operation.type === "retryCapture") {
            const captureKey = yield* factoryExecutions.captureKey(operation.input.runAttemptId);
            const finalize = input.effects.find(
              (effect) => effect.request.type === "factory.execution.finalize",
            );
            if (
              finalize?.request.type !== "factory.execution.finalize" ||
              finalize.request.runId !== operation.input.runId ||
              finalize.request.runAttemptId !== operation.input.runAttemptId ||
              captureKey !== `native-final/${finalize.request.captureGeneration ?? 1}`
            )
              return yield* new FactoryExecutionError({ reason: "task-conflict" });
          }
          const effects = [...(decision.executeNative ? input.effects : [])];
          if (
            decision.advance &&
            (operation.type === "observe" ||
              operation.type === "admit" ||
              operation.type === "retry")
          ) {
            const binding =
              operation.type === "observe"
                ? yield* factoryExecutions.getBinding(operation.input.runAttemptId)
                : operation.binding;
            effects.push({
              id: `effect:${command.commandId}:factory.execution.advance`,
              commandId: command.commandId,
              threadId: binding.threadId,
              request: {
                type: "factory.execution.advance",
                ref: command.ref,
                revision: command.revision,
              },
            });
          }
          const storedEvents = yield* eventStore.append({
            commandId: command.commandId,
            events: yield* normalizeEvents(events),
          });
          const outcomes = yield* applyStoredEvents(storedEvents);
          const projectEvent =
            decision.error === null
              ? yield* eventStore.appendProjectEvent({
                  eventId: EventId.make(`factory-execution:${command.commandId}`),
                  aggregateKind: "project",
                  aggregateId: command.ref.projectId,
                  occurredAt: command.now,
                  commandId: command.commandId,
                  causationEventId: null,
                  correlationId: command.commandId,
                  metadata: {},
                  type: "project.factory-execution-updated",
                  payload: {
                    projectId: command.ref.projectId,
                    ref: command.ref,
                    revision: command.revision,
                  },
                })
              : undefined;
          if (
            !(yield* commandReceipts.insertIfAbsent({
              commandId: command.commandId,
              projectId: command.ref.projectId,
              commandType: `factory.execution.${operation.type}`,
              acceptedAt: DateTime.makeUnsafe(command.now),
              resultSequence: projectEvent?.sequence ?? 0,
              status: decision.error === null ? "accepted" : "rejected",
              error: decision.error,
            }))
          )
            return yield* new FactoryExecutionError({ reason: "command-conflict" });
          yield* effectOutbox.enqueue(effects);
          return { decision, storedEvents, outcomes, projectEvent, effects };
        }),
        (result) =>
          Effect.gen(function* () {
            if (result.effects.length) yield* effectOutbox.notifyAvailable(result.effects.length);
            yield* publishStoredEvents(result.storedEvents, result.outcomes);
            if (result.projectEvent) yield* eventStore.publishCommitted([result.projectEvent]);
          }),
      ).pipe(
        Effect.mapError((cause) =>
          isFactoryExecutionError(cause)
            ? cause
            : new FactoryExecutionError({ reason: "persistence-failure", cause }),
        ),
      );
      if (committed.decision.error !== null)
        return yield* new FactoryExecutionError({ reason: committed.decision.error });
      return { execution: committed.decision.result!, replayed: committed.decision.replayed };
    });

    const existingProjectReceipt = (commandId: CommandId) =>
      commandReceipts.getProjectByCommandId(commandId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(`Command ${commandId} was already used by a thread command.` as const),
            onSome: Effect.succeed,
          }),
        ),
      );

    const commitProjectCommandEffect = Effect.fn("orchestrationV2.EventSink.commitProjectCommand")(
      function* (input: Parameters<EventSinkV2Shape["commitProjectCommand"]>[0]) {
        const result = yield* commitThenPublish(
          Effect.gen(function* () {
            const reserved: CommandReceiptStore.ProjectCommandReceiptV2 = {
              commandId: input.commandId,
              projectId: input.projectId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: 0,
              status: "accepted",
              error: null,
            };
            if (!(yield* commandReceipts.insertIfAbsent(reserved))) {
              return { receipt: yield* existingProjectReceipt(input.commandId), event: undefined };
            }
            const event = yield* eventStore.appendProjectEvent(input.event);
            yield* projectStore.apply(event);
            const receipt = { ...reserved, resultSequence: event.sequence };
            yield* commandReceipts.upsert(receipt);
            return { receipt, event };
          }),
          (result) =>
            result.event === undefined ? Effect.void : eventStore.publishCommitted([result.event]),
        );
        return { receipt: result.receipt, committed: result.event !== undefined };
      },
    );

    const commitRejectedProjectCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedProjectCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedProjectCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipt: CommandReceiptStore.ProjectCommandReceiptV2 = {
            commandId: input.commandId,
            projectId: input.projectId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: yield* eventStore.latestApplicationSequence,
            status: "rejected",
            error: input.error,
          };
          return (yield* commandReceipts.insertIfAbsent(receipt))
            ? receipt
            : yield* existingProjectReceipt(input.commandId);
        }),
      );
    });

    const catchUp = (input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly threadId?: ThreadId;
      readonly eventType?: OrchestrationV2DomainEvent["type"];
    }): Stream.Stream<OrchestrationV2StoredEvent, unknown> => {
      const pageSize = 256;
      const loop = (afterSequence: number): Stream.Stream<OrchestrationV2StoredEvent, unknown> =>
        Stream.unwrap(
          eventStore
            .read({
              afterSequence,
              throughSequence: input.throughSequence,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
              limit: pageSize,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.map((events) => {
                if (events.length === 0) {
                  return Stream.empty;
                }
                const current = Stream.fromIterable(events);
                const last = events.at(-1)?.sequence ?? input.throughSequence;
                return events.length < pageSize || last >= input.throughSequence
                  ? current
                  : Stream.concat(current, loop(last));
              }),
            ),
        );
      return loop(input.afterSequence);
    };

    const stream = (input?: Parameters<EventSinkV2Shape["stream"]>[0]) => {
      const afterSequence = input?.afterSequence ?? 0;
      const matches = (stored: OrchestrationV2StoredEvent) =>
        (input?.threadId === undefined || stored.event.threadId === input.threadId) &&
        (input?.eventType === undefined || stored.event.type === input.eventType);
      const replay = (throughSequence: number) =>
        catchUp({
          afterSequence,
          throughSequence,
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input?.eventType === undefined ? {} : { eventType: input.eventType }),
        }).pipe(Stream.filter(matches));
      return Stream.unwrap(
        Effect.gen(function* () {
          let pubsub = liveEvents;
          if (input?.eventType !== undefined) {
            const existing = liveEventsByType.get(input.eventType);
            if (existing !== undefined) {
              pubsub = existing;
            } else {
              const created = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
              pubsub = liveEventsByType.get(input.eventType) ?? created;
              liveEventsByType.set(input.eventType, pubsub);
            }
          }
          if (input?.bounded === true) {
            const managedThread =
              input.threadId !== undefined &&
              (yield* factoryExecutions.findNativeBinding({ threadId: input.threadId })) !== null;
            const managedWireOptions = managedThread ? { managedThread: true } : undefined;
            return replayAndBufferProjectedLiveEvents({
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: eventStore.latestSequence(),
              afterSequence,
              filter: matches,
              replay,
              project: (stored) => ({
                ...stored,
                event: projectDomainEventForWire(stored.event, managedWireOptions),
              }),
            });
          }
          const subscription = yield* PubSub.subscribe(pubsub);
          const highWater = yield* eventStore.latestSequence();
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > Math.max(highWater, afterSequence)),
            Stream.filter(matches),
          );
          return Stream.concat(replay(highWater), live);
        }),
      );
    };

    return EventSinkV2.of({
      commitFactoryPlanCommand,
      commitFactoryExecutionCommand,
      write: (input) =>
        writeEffect({ ...input, effects: [] }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeWithEffects: (input) =>
        writeEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfRunCurrent: (input) =>
        writeIfRunCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadOwner: (input) =>
        writeIfProviderThreadOwnerEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadUnchanged: (input) =>
        writeIfProviderThreadUnchangedEffect(input).pipe(
          Effect.mapError(
            (cause) => new EventSinkWriteError({ eventCount: input.events.length, cause }),
          ),
        ),
      commitCommand: (input) =>
        commitCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      commitRejectedCommand: (input) =>
        commitRejectedCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: 0,
                cause,
              }),
          ),
        ),
      commitProjectCommand: (input) =>
        commitProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 1, cause }),
          ),
        ),
      commitRejectedProjectCommand: (input) =>
        commitRejectedProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 0, cause }),
          ),
        ),
      stream: (input) =>
        stream(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
).pipe(Layer.provide(Layer.mergeAll(FactoryPlans.layer, FactoryExecutions.layer)));

/** Share the worker's outbox instance: enqueue wakeups are in-memory. */
export const layerFromStores = layerBase;

export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = layerBase.pipe(
  Layer.provide(
    Layer.mergeAll(
      CommandReceiptStore.layer,
      EffectOutbox.layer,
      ProjectStore.layer,
      TurnItemPositionStore.layer,
    ),
  ),
);
