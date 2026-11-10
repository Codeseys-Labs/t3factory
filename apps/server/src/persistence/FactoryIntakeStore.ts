import {
  AuthSessionId,
  FactoryIntakeArrival,
  FactoryIntakeError,
  FactoryIntakeRule,
  FactoryIntakeRuleMatch,
  FactoryIntakeSource,
  FactoryIntakeSourceConfig,
  FactoryTaskAssignment,
  FactoryTaskDisplayId,
  FactoryTaskRef,
  FactoryTaskType,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import type { FactoryPlanActor } from "../factory/FactoryPlanReducer.ts";

const Actor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("human"), sessionId: AuthSessionId }),
  Schema.Struct({ kind: Schema.Literal("agent"), threadId: ThreadId }),
]);

const StoredSuggestion = Schema.Struct({
  ruleId: FactoryIntakeRule.fields.id,
  ruleName: FactoryIntakeRule.fields.name,
  type: FactoryTaskType,
  assignment: FactoryTaskAssignment,
});
const ArrivalTask = Schema.Struct({ ref: FactoryTaskRef, displayId: FactoryTaskDisplayId });
const RuleAction = FactoryIntakeRule.fields.action;

const SourceRow = Schema.Struct({
  id: FactoryIntakeSource.fields.id,
  projectId: FactoryIntakeSource.fields.projectId,
  config: Schema.fromJsonString(FactoryIntakeSourceConfig),
  label: Schema.String,
  detail: Schema.String,
  enabled: Schema.BooleanFromBit,
  status: FactoryIntakeSource.fields.status,
  feedSourceId: Schema.NullOr(Schema.String),
  actor: Schema.fromJsonString(Actor),
  lastCheckedAt: Schema.NullOr(Schema.String),
  nextCheckAt: Schema.NullOr(Schema.String),
  lastSlotAt: Schema.NullOr(Schema.String),
  version: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export interface StoredSource extends Omit<typeof SourceRow.Type, "actor"> {
  readonly actor: FactoryPlanActor;
}

const RuleRow = Schema.Struct({
  id: FactoryIntakeRule.fields.id,
  name: FactoryIntakeRule.fields.name,
  match: Schema.fromJsonString(FactoryIntakeRuleMatch),
  action: Schema.fromJsonString(RuleAction),
  autonomy: FactoryIntakeRule.fields.autonomy,
  state: FactoryIntakeRule.fields.state,
  lastFiredAt: Schema.NullOr(Schema.String),
  firedCount: Schema.Number,
  version: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type StoredRule = FactoryIntakeRule;

const ArrivalRow = Schema.Struct({
  seq: Schema.Number,
  id: FactoryIntakeArrival.fields.id,
  sourceId: FactoryIntakeArrival.fields.sourceId,
  sourceKind: FactoryIntakeArrival.fields.sourceKind,
  projectId: FactoryIntakeArrival.fields.projectId,
  itemKey: Schema.String,
  originKey: Schema.String,
  label: Schema.String,
  title: Schema.String,
  body: Schema.String,
  bodyTruncated: Schema.BooleanFromBit,
  url: Schema.NullOr(Schema.String),
  labels: Schema.fromJsonString(Schema.Array(Schema.String)),
  arrivedAt: Schema.String,
  state: FactoryIntakeArrival.fields.state,
  snoozedUntil: Schema.NullOr(Schema.String),
  suggestion: Schema.NullOr(Schema.fromJsonString(StoredSuggestion)),
  task: Schema.NullOr(Schema.fromJsonString(ArrivalTask)),
  version: Schema.Number,
});
export type StoredArrival = typeof ArrivalRow.Type;
type NewArrival = Omit<StoredArrival, "seq">;

const CommandRow = Schema.Struct({
  operation: Schema.String,
  digest: Schema.String,
  result: Schema.String,
});
type CommandRow = typeof CommandRow.Type;

/** Keyset position of an arrival in the newest-first listing. */
export interface ArrivalPosition {
  readonly arrivedAt: string;
  readonly seq: number;
}

interface ArrivalFilter {
  readonly projectIds: ReadonlyArray<ProjectId> | undefined;
  // Undefined means the Triage view: `new` plus snoozed arrivals whose time has passed.
  readonly states: ReadonlyArray<StoredArrival["state"]> | undefined;
  readonly now: string;
}

export class FactoryIntakeStore extends Context.Service<
  FactoryIntakeStore,
  {
    readonly transact: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | FactoryIntakeError, R>;
    readonly getCommand: (
      commandId: string,
    ) => Effect.Effect<Option.Option<CommandRow>, FactoryIntakeError>;
    readonly putCommand: (input: {
      readonly commandId: string;
      readonly operation: string;
      readonly digest: string;
      readonly result: string;
    }) => Effect.Effect<void, FactoryIntakeError>;
    readonly listSources: (
      projectIds: ReadonlyArray<ProjectId> | undefined,
    ) => Effect.Effect<ReadonlyArray<StoredSource>, FactoryIntakeError>;
    readonly getSource: (
      id: string,
    ) => Effect.Effect<Option.Option<StoredSource>, FactoryIntakeError>;
    readonly countSources: Effect.Effect<number, FactoryIntakeError>;
    /** Another source of the same project that reads the same thing. */
    readonly findSameSource: (
      source: Pick<StoredSource, "id" | "projectId" | "config">,
    ) => Effect.Effect<boolean, FactoryIntakeError>;
    readonly putSource: (source: StoredSource) => Effect.Effect<void, FactoryIntakeError>;
    /** Removes the source and its rules; its arrivals stay. */
    readonly deleteSource: (id: string) => Effect.Effect<void, FactoryIntakeError>;
    readonly nextCheckAt: Effect.Effect<string | null, FactoryIntakeError>;
    readonly listDueSources: (
      now: string,
    ) => Effect.Effect<ReadonlyArray<StoredSource>, FactoryIntakeError>;
    readonly listRules: (
      sourceId: string | undefined,
    ) => Effect.Effect<ReadonlyArray<StoredRule>, FactoryIntakeError>;
    readonly getRule: (id: string) => Effect.Effect<Option.Option<StoredRule>, FactoryIntakeError>;
    readonly countRules: Effect.Effect<number, FactoryIntakeError>;
    readonly isRuleNameTaken: (input: {
      readonly name: string;
      readonly exceptId: string | undefined;
    }) => Effect.Effect<boolean, FactoryIntakeError>;
    readonly putRule: (rule: StoredRule) => Effect.Effect<void, FactoryIntakeError>;
    readonly deleteRule: (id: string) => Effect.Effect<void, FactoryIntakeError>;
    readonly existingItemKeys: (
      sourceId: string,
      itemKeys: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlySet<string>, FactoryIntakeError>;
    readonly insertArrival: (arrival: NewArrival) => Effect.Effect<void, FactoryIntakeError>;
    readonly getArrival: (
      id: string,
    ) => Effect.Effect<Option.Option<StoredArrival>, FactoryIntakeError>;
    readonly updateArrival: (
      arrival: Pick<StoredArrival, "id" | "state" | "snoozedUntil" | "task" | "version">,
    ) => Effect.Effect<void, FactoryIntakeError>;
    readonly listArrivals: (
      filter: ArrivalFilter & {
        readonly after: ArrivalPosition | undefined;
        readonly limit: number;
      },
    ) => Effect.Effect<ReadonlyArray<StoredArrival>, FactoryIntakeError>;
    readonly countArrivals: (filter: ArrivalFilter) => Effect.Effect<number, FactoryIntakeError>;
    readonly listArrivalsSince: (input: {
      readonly sourceId: string;
      readonly since: string;
    }) => Effect.Effect<ReadonlyArray<Pick<StoredArrival, "title" | "labels">>, FactoryIntakeError>;
  }
>()("t3/persistence/FactoryIntakeStore") {}

const isIntakeError = Schema.is(FactoryIntakeError);
const persistenceError = (cause: unknown) =>
  isIntakeError(cause) ? cause : new FactoryIntakeError({ reason: "persistence-failure", cause });
const decodeSources = Schema.decodeUnknownEffect(Schema.Array(SourceRow));
const decodeRules = Schema.decodeUnknownEffect(Schema.Array(RuleRow));
const decodeArrivals = Schema.decodeUnknownEffect(Schema.Array(ArrivalRow));
const decodeCommands = Schema.decodeUnknownEffect(Schema.Array(CommandRow));
const decodeTitles = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ title: ArrivalRow.fields.title, labels: ArrivalRow.fields.labels })),
);
const encodeConfig = Schema.encodeSync(SourceRow.fields.config);
const encodeActor = Schema.encodeSync(SourceRow.fields.actor);
const encodeMatch = Schema.encodeSync(RuleRow.fields.match);
const encodeAction = Schema.encodeSync(RuleRow.fields.action);
const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeSuggestion = Schema.encodeSync(Schema.fromJsonString(StoredSuggestion));
const encodeTask = Schema.encodeSync(Schema.fromJsonString(ArrivalTask));

// Two sources of one project must not read the same thing, or every item would arrive twice.
const dedupeKey = (config: FactoryIntakeSourceConfig) =>
  config.kind === "issues" ? "issues" : config.kind === "feed" ? `feed:${config.url}` : null;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sourceColumns = sql.literal(`source_id AS id, project_id AS projectId,
    config_json AS config, label, detail, enabled, status, feed_source_id AS feedSourceId,
    actor_json AS actor, last_checked_at AS lastCheckedAt, next_check_at AS nextCheckAt,
    last_slot_at AS lastSlotAt, version, created_at AS createdAt, updated_at AS updatedAt`);
  const ruleColumns = sql.literal(`rule_id AS id, name, match_json AS match,
    action_json AS action, autonomy, state, last_fired_at AS lastFiredAt,
    fired_count AS firedCount, version, created_at AS createdAt, updated_at AS updatedAt`);
  const arrivalColumns = sql.literal(`seq, arrival_id AS id, source_id AS sourceId,
    source_kind AS sourceKind, project_id AS projectId, item_key AS itemKey,
    origin_key AS originKey, label, title, body, body_truncated AS bodyTruncated, url,
    labels_json AS labels, arrived_at AS arrivedAt, state, snoozed_until AS snoozedUntil,
    suggestion_json AS suggestion, task_json AS task, version`);
  const projectsJson = (projectIds: ReadonlyArray<ProjectId> | undefined) =>
    projectIds === undefined ? null : encodeStrings(projectIds);

  const transact = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | FactoryIntakeError, R> =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          isSqlError(cause)
            ? new FactoryIntakeError({ reason: "persistence-failure", cause })
            : cause,
        ),
      );
  const getCommand = Effect.fn("FactoryIntakeStore.getCommand")(function* (commandId: string) {
    const rows = yield* decodeCommands(
      yield* sql`SELECT operation, digest, result_json AS result FROM factory_intake_commands
        WHERE command_id = ${commandId}`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const putCommand = Effect.fn("FactoryIntakeStore.putCommand")(function* (
    input: Parameters<FactoryIntakeStore["Service"]["putCommand"]>[0],
  ) {
    yield* sql`INSERT INTO factory_intake_commands (command_id, operation, digest, result_json)
      VALUES (${input.commandId}, ${input.operation}, ${input.digest}, ${input.result})`;
  }, Effect.mapError(persistenceError));

  const listSources = Effect.fn("FactoryIntakeStore.listSources")(function* (
    projectIds: ReadonlyArray<ProjectId> | undefined,
  ) {
    const projects = projectsJson(projectIds);
    return yield* decodeSources(
      yield* sql`SELECT ${sourceColumns} FROM factory_intake_sources
        WHERE (${projects} IS NULL OR project_id IN (SELECT value FROM json_each(${projects})))
        ORDER BY created_at, rowid`,
    );
  }, Effect.mapError(persistenceError));
  const getSource = Effect.fn("FactoryIntakeStore.getSource")(function* (id: string) {
    const rows = yield* decodeSources(
      yield* sql`SELECT ${sourceColumns} FROM factory_intake_sources WHERE source_id = ${id}`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const countSources = sql<{
    readonly count: number;
  }>`SELECT COUNT(*) AS count FROM factory_intake_sources`.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
    Effect.mapError(persistenceError),
    Effect.withSpan("FactoryIntakeStore.countSources"),
  );
  const findSameSource = Effect.fn("FactoryIntakeStore.findSameSource")(function* (
    source: Pick<StoredSource, "id" | "projectId" | "config">,
  ) {
    const key = dedupeKey(source.config);
    if (key === null) return false;
    const rows = yield* sql`SELECT 1 FROM factory_intake_sources
      WHERE project_id = ${source.projectId} AND dedupe_key = ${key} AND source_id <> ${source.id}`;
    return rows.length > 0;
  }, Effect.mapError(persistenceError));
  const putSource = Effect.fn("FactoryIntakeStore.putSource")(function* (source: StoredSource) {
    yield* sql`INSERT INTO factory_intake_sources (source_id, project_id, kind, dedupe_key,
      config_json, label, detail, enabled, status, feed_source_id, actor_json, last_checked_at,
      next_check_at, last_slot_at, version, created_at, updated_at)
      VALUES (${source.id}, ${source.projectId}, ${source.config.kind}, ${dedupeKey(source.config)},
      ${encodeConfig(source.config)}, ${source.label}, ${source.detail}, ${source.enabled ? 1 : 0},
      ${source.status}, ${source.feedSourceId}, ${encodeActor(source.actor)},
      ${source.lastCheckedAt}, ${source.nextCheckAt}, ${source.lastSlotAt}, ${source.version},
      ${source.createdAt}, ${source.updatedAt})
      ON CONFLICT (source_id) DO UPDATE SET project_id = excluded.project_id, kind = excluded.kind,
      dedupe_key = excluded.dedupe_key, config_json = excluded.config_json, label = excluded.label,
      detail = excluded.detail, enabled = excluded.enabled, status = excluded.status,
      feed_source_id = excluded.feed_source_id, actor_json = excluded.actor_json,
      last_checked_at = excluded.last_checked_at, next_check_at = excluded.next_check_at,
      last_slot_at = excluded.last_slot_at, version = excluded.version,
      updated_at = excluded.updated_at`;
  }, Effect.mapError(persistenceError));
  const deleteSource = Effect.fn("FactoryIntakeStore.deleteSource")(function* (id: string) {
    yield* sql`DELETE FROM factory_intake_rules WHERE source_id = ${id}`;
    yield* sql`DELETE FROM factory_intake_sources WHERE source_id = ${id}`;
  }, Effect.mapError(persistenceError));
  const nextCheckAt = sql<{ readonly next: string | null }>`
    SELECT MIN(next_check_at) AS next FROM factory_intake_sources
    WHERE next_check_at IS NOT NULL AND enabled = 1`.pipe(
    Effect.map((rows) => rows[0]?.next ?? null),
    Effect.mapError(persistenceError),
    Effect.withSpan("FactoryIntakeStore.nextCheckAt"),
  );
  const listDueSources = Effect.fn("FactoryIntakeStore.listDueSources")(function* (now: string) {
    return yield* decodeSources(
      yield* sql`SELECT ${sourceColumns} FROM factory_intake_sources
        WHERE next_check_at IS NOT NULL AND enabled = 1 AND next_check_at <= ${now}
        ORDER BY next_check_at, rowid`,
    );
  }, Effect.mapError(persistenceError));

  const listRules = Effect.fn("FactoryIntakeStore.listRules")(function* (
    sourceId: string | undefined,
  ) {
    const source = sourceId ?? null;
    return yield* decodeRules(
      yield* sql`SELECT ${ruleColumns} FROM factory_intake_rules
        WHERE (${source} IS NULL OR source_id = ${source}) ORDER BY created_at, rowid`,
    );
  }, Effect.mapError(persistenceError));
  const getRule = Effect.fn("FactoryIntakeStore.getRule")(function* (id: string) {
    const rows = yield* decodeRules(
      yield* sql`SELECT ${ruleColumns} FROM factory_intake_rules WHERE rule_id = ${id}`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const countRules = sql<{
    readonly count: number;
  }>`SELECT COUNT(*) AS count FROM factory_intake_rules`.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
    Effect.mapError(persistenceError),
    Effect.withSpan("FactoryIntakeStore.countRules"),
  );
  const isRuleNameTaken = Effect.fn("FactoryIntakeStore.isRuleNameTaken")(function* (input: {
    readonly name: string;
    readonly exceptId: string | undefined;
  }) {
    const rows = yield* sql`SELECT 1 FROM factory_intake_rules
      WHERE name = ${input.name} AND rule_id <> ${input.exceptId ?? ""}`;
    return rows.length > 0;
  }, Effect.mapError(persistenceError));
  const putRule = Effect.fn("FactoryIntakeStore.putRule")(function* (rule: StoredRule) {
    yield* sql`INSERT INTO factory_intake_rules (rule_id, source_id, name, match_json, action_json,
      autonomy, state, last_fired_at, fired_count, version, created_at, updated_at)
      VALUES (${rule.id}, ${rule.match.sourceId}, ${rule.name}, ${encodeMatch(rule.match)},
      ${encodeAction(rule.action)}, ${rule.autonomy}, ${rule.state}, ${rule.lastFiredAt},
      ${rule.firedCount}, ${rule.version}, ${rule.createdAt}, ${rule.updatedAt})
      ON CONFLICT (rule_id) DO UPDATE SET source_id = excluded.source_id, name = excluded.name,
      match_json = excluded.match_json, action_json = excluded.action_json,
      autonomy = excluded.autonomy, state = excluded.state, last_fired_at = excluded.last_fired_at,
      fired_count = excluded.fired_count, version = excluded.version,
      updated_at = excluded.updated_at`;
  }, Effect.mapError(persistenceError));
  const deleteRule = Effect.fn("FactoryIntakeStore.deleteRule")(function* (id: string) {
    yield* sql`DELETE FROM factory_intake_rules WHERE rule_id = ${id}`;
  }, Effect.mapError(persistenceError));

  const existingItemKeys = Effect.fn("FactoryIntakeStore.existingItemKeys")(function* (
    sourceId: string,
    itemKeys: ReadonlyArray<string>,
  ) {
    if (itemKeys.length === 0) return new Set<string>();
    const rows = yield* sql<{ readonly itemKey: string }>`SELECT item_key AS itemKey
      FROM factory_intake_arrivals WHERE source_id = ${sourceId}
      AND item_key IN (SELECT value FROM json_each(${encodeStrings(itemKeys)}))`;
    return new Set(rows.map((row) => row.itemKey));
  }, Effect.mapError(persistenceError));
  const insertArrival = Effect.fn("FactoryIntakeStore.insertArrival")(function* (
    arrival: NewArrival,
  ) {
    yield* sql`INSERT INTO factory_intake_arrivals (arrival_id, source_id, source_kind, project_id,
      item_key, origin_key, label, title, body, body_truncated, url, labels_json, arrived_at,
      state, snoozed_until, suggestion_json, task_json, version)
      VALUES (${arrival.id}, ${arrival.sourceId}, ${arrival.sourceKind}, ${arrival.projectId},
      ${arrival.itemKey}, ${arrival.originKey}, ${arrival.label}, ${arrival.title}, ${arrival.body},
      ${arrival.bodyTruncated ? 1 : 0}, ${arrival.url}, ${encodeStrings(arrival.labels)},
      ${arrival.arrivedAt}, ${arrival.state}, ${arrival.snoozedUntil},
      ${arrival.suggestion === null ? null : encodeSuggestion(arrival.suggestion)},
      ${arrival.task === null ? null : encodeTask(arrival.task)}, ${arrival.version})`;
  }, Effect.mapError(persistenceError));
  const getArrival = Effect.fn("FactoryIntakeStore.getArrival")(function* (id: string) {
    const rows = yield* decodeArrivals(
      yield* sql`SELECT ${arrivalColumns} FROM factory_intake_arrivals WHERE arrival_id = ${id}`,
    );
    return Option.fromNullishOr(rows[0]);
  }, Effect.mapError(persistenceError));
  const updateArrival = Effect.fn("FactoryIntakeStore.updateArrival")(function* (
    arrival: Pick<StoredArrival, "id" | "state" | "snoozedUntil" | "task" | "version">,
  ) {
    yield* sql`UPDATE factory_intake_arrivals SET state = ${arrival.state},
      snoozed_until = ${arrival.snoozedUntil},
      task_json = ${arrival.task === null ? null : encodeTask(arrival.task)},
      version = ${arrival.version} WHERE arrival_id = ${arrival.id}`;
  }, Effect.mapError(persistenceError));
  const filterSql = (filter: ArrivalFilter) => {
    const projects = projectsJson(filter.projectIds);
    const states = filter.states === undefined ? null : encodeStrings(filter.states);
    return sql`(${projects} IS NULL OR project_id IN (SELECT value FROM json_each(${projects})))
      AND (CASE WHEN ${states} IS NULL
        THEN state = 'new' OR (state = 'snoozed' AND snoozed_until <= ${filter.now})
        ELSE state IN (SELECT value FROM json_each(${states})) END)`;
  };
  const listArrivals = Effect.fn("FactoryIntakeStore.listArrivals")(function* (
    filter: Parameters<FactoryIntakeStore["Service"]["listArrivals"]>[0],
  ) {
    const after = filter.after;
    return yield* decodeArrivals(
      after === undefined
        ? yield* sql`SELECT ${arrivalColumns} FROM factory_intake_arrivals
            WHERE ${filterSql(filter)} ORDER BY arrived_at DESC, seq DESC LIMIT ${filter.limit}`
        : yield* sql`SELECT ${arrivalColumns} FROM factory_intake_arrivals
            WHERE ${filterSql(filter)}
            AND (arrived_at < ${after.arrivedAt} OR (arrived_at = ${after.arrivedAt} AND seq < ${after.seq}))
            ORDER BY arrived_at DESC, seq DESC LIMIT ${filter.limit}`,
    );
  }, Effect.mapError(persistenceError));
  const countArrivals = Effect.fn("FactoryIntakeStore.countArrivals")(function* (
    filter: ArrivalFilter,
  ) {
    const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
      FROM factory_intake_arrivals WHERE ${filterSql(filter)}`;
    return rows[0]?.count ?? 0;
  }, Effect.mapError(persistenceError));
  const listArrivalsSince = Effect.fn("FactoryIntakeStore.listArrivalsSince")(function* (input: {
    readonly sourceId: string;
    readonly since: string;
  }) {
    return yield* decodeTitles(
      yield* sql`SELECT title, labels_json AS labels FROM factory_intake_arrivals
        WHERE source_id = ${input.sourceId} AND arrived_at >= ${input.since}`,
    );
  }, Effect.mapError(persistenceError));

  return FactoryIntakeStore.of({
    transact,
    getCommand,
    putCommand,
    listSources,
    getSource,
    countSources,
    findSameSource,
    putSource,
    deleteSource,
    nextCheckAt,
    listDueSources,
    listRules,
    getRule,
    countRules,
    isRuleNameTaken,
    putRule,
    deleteRule,
    existingItemKeys,
    insertArrival,
    getArrival,
    updateArrival,
    listArrivals,
    countArrivals,
    listArrivalsSince,
  });
});

export const layer = Layer.effect(FactoryIntakeStore, make);
