import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Work history finds a run by its unique id and lists a thread's runs through the
  // (thread_id, ordinal) index, so this index served no Factory read. Its run_id order made
  // SQLite merge a thread's active runs from every run of the thread instead of seeking the
  // (thread_id, status) index, so a delegated task's reads grew with the parent's history.
  yield* sql`DROP INDEX IF EXISTS factory_work_runs_history`;
});
