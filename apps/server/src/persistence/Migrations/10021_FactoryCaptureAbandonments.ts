import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A person gave up the result of an attempt held by a failed capture. At most one per attempt.
  yield* sql`CREATE TABLE factory_execution_capture_abandonments (attempt_id TEXT PRIMARY KEY, capture_key TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, abandoned_at TEXT NOT NULL)`;
});
