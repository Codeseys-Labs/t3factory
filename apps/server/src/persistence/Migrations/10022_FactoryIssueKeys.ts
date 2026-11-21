import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No affinity preserves legacy integer identities exactly, while admitting native text keys.
  // These tables have no foreign keys. The migrator's transaction restores them on failure.
  for (const table of [
    "factory_issue_launches",
    "factory_issue_relation_observations",
    "factory_issue_relation_edges",
    "factory_issue_readiness_overrides",
  ]) {
    const definitions = yield* sql<{ readonly type: string; readonly sql: string }>`
      SELECT type, sql FROM sqlite_master WHERE tbl_name = ${table} AND sql IS NOT NULL
      ORDER BY type DESC, name`;
    const definition = definitions.find((row) => row.type === "table");
    if (definition === undefined) return yield* Effect.die(new Error(`Missing ${table}`));
    const widened = definition.sql.replace(
      /issue_number INTEGER NOT NULL(?: CHECK \(issue_number > 0\))?/,
      "issue_number NOT NULL CHECK ((typeof(issue_number) = 'integer' AND issue_number > 0) OR (typeof(issue_number) = 'text' AND length(issue_number) > 0))",
    );
    if (widened === definition.sql)
      return yield* Effect.die(new Error(`Unexpected ${table} schema: ${definition.sql}`));
    yield* sql.unsafe(widened.replace(table, `${table}_keys`));
    yield* sql.unsafe(
      `INSERT INTO ${table}_keys (rowid, ${(yield* sql.unsafe<{ readonly name: string }>(
        `PRAGMA table_info(${table})`,
      ))
        .map((column) => column.name)
        .join(", ")}) SELECT rowid, * FROM ${table}`,
    );
    yield* sql.unsafe(`DROP TABLE ${table}`);
    yield* sql.unsafe(`ALTER TABLE ${table}_keys RENAME TO ${table}`);
    for (const index of definitions.filter((row) => row.type === "index")) {
      yield* sql.unsafe(index.sql);
    }
  }
});
