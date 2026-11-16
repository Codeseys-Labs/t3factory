import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE factory_plan_heads (
    root_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    summary_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX factory_plan_project_roots ON factory_plan_heads(project_id, root_id)`;
  yield* sql`CREATE TABLE factory_plan_revisions (
    root_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    PRIMARY KEY(root_id, revision)
  )`;
  yield* sql`CREATE TABLE factory_plan_commands (
    command_id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    outcome_json TEXT NOT NULL
  )`;
});
