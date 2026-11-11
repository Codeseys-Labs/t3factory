import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE factory_task_breakdowns (task_key TEXT PRIMARY KEY, request_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE factory_task_proposals (proposal_id TEXT PRIMARY KEY, task_key TEXT NOT NULL, status TEXT NOT NULL, proposal_json TEXT NOT NULL)`;
  yield* sql`CREATE UNIQUE INDEX factory_task_open_proposal ON factory_task_proposals(task_key) WHERE status = 'proposed'`;
  yield* sql`CREATE TABLE factory_task_proposal_commands (command_id TEXT PRIMARY KEY, digest TEXT NOT NULL, request_json TEXT, result_json TEXT)`;
});
