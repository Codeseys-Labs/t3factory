import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

export const databaseSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_message_search(orchestration_v2_message_search, rank) VALUES ('integrity-check', 1)`;
  const schema = yield* sql`
    SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name
  `.values;
  const tableList = yield* sql<{ name: string; wr: number }>`PRAGMA table_list`;
  const tables = yield* sql<{ name: string }>`
    SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
  `;
  const contents: Record<string, ReadonlyArray<ReadonlyArray<unknown>>> = {};
  for (const { name } of tables) {
    const withoutRowid = tableList.find((table) => table.name === name)?.wr === 1;
    const columns = yield* sql.unsafe<{ name: string; pk: number }>(
      `PRAGMA table_info(${identifier(name)})`,
    );
    const order = withoutRowid
      ? columns
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => identifier(column.name))
          .join(", ")
      : "rowid";
    contents[name] = yield* sql
      .unsafe(
        `SELECT ${withoutRowid ? "*" : "rowid, *"} FROM ${identifier(name)} ORDER BY ${order}`,
      )
      .values.pipe(Effect.provideService(SqlClient.SafeIntegers, true));
  }
  const pragmas: Record<string, ReadonlyArray<ReadonlyArray<unknown>>> = {};
  for (const name of ["page_size", "auto_vacuum", "encoding", "user_version", "application_id"])
    pragmas[name] = yield* sql.unsafe(`PRAGMA ${name}`).values;
  return { schema, contents, pragmas };
});
