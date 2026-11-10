import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // `dedupe_key` is null for schedules, so a project can hold several of them.
  yield* sql`CREATE TABLE factory_intake_sources (
    source_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    dedupe_key TEXT,
    config_json TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    status TEXT NOT NULL,
    feed_source_id TEXT,
    actor_json TEXT NOT NULL,
    last_checked_at TEXT,
    next_check_at TEXT,
    last_slot_at TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, dedupe_key)
  )`;
  yield* sql`CREATE INDEX factory_intake_sources_due ON factory_intake_sources(next_check_at) WHERE next_check_at IS NOT NULL`;
  yield* sql`CREATE TABLE factory_intake_rules (
    rule_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    match_json TEXT NOT NULL,
    action_json TEXT NOT NULL,
    autonomy TEXT NOT NULL,
    state TEXT NOT NULL,
    last_fired_at TEXT,
    fired_count INTEGER NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX factory_intake_rules_source ON factory_intake_rules(source_id)`;
  yield* sql`CREATE TABLE factory_intake_arrivals (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    arrival_id TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    project_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    origin_key TEXT NOT NULL,
    label TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    body_truncated INTEGER NOT NULL,
    url TEXT,
    labels_json TEXT NOT NULL,
    arrived_at TEXT NOT NULL,
    state TEXT NOT NULL,
    snoozed_until TEXT,
    suggestion_json TEXT,
    task_json TEXT,
    version INTEGER NOT NULL,
    UNIQUE(source_id, item_key)
  )`;
  yield* sql`CREATE INDEX factory_intake_arrivals_state ON factory_intake_arrivals(state, arrived_at DESC, seq DESC)`;
  yield* sql`CREATE INDEX factory_intake_arrivals_source ON factory_intake_arrivals(source_id, arrived_at)`;
  yield* sql`CREATE TABLE factory_intake_commands (
    command_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    digest TEXT NOT NULL,
    result_json TEXT NOT NULL
  )`;
});
