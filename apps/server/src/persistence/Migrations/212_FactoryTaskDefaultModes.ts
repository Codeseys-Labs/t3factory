import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Default permissions per project, mirrored from settings beside the default model.
  yield* sql`ALTER TABLE factory_task_defaults ADD COLUMN runtime_modes_json TEXT`;
});
