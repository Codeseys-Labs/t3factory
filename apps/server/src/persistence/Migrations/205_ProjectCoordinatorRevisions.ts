import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_coordinators RENAME TO project_coordinators_legacy`;
  yield* sql`DROP INDEX project_coordinators_current`;
  yield* sql`
    CREATE TABLE project_coordinators (
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      request_command_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      kind TEXT NOT NULL DEFAULT 'launch' CHECK (kind IN ('launch', 'assignment')),
      intent_json TEXT NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
      superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
      UNIQUE (project_id, revision)
    )
  `;
  yield* sql`
    INSERT INTO project_coordinators
      (thread_id, project_id, request_command_id, revision, intent_json, accepted, superseded)
    SELECT thread_id, project_id, request_command_id,
      ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY superseded DESC, rowid),
      intent_json, accepted, superseded
    FROM project_coordinators_legacy
  `;
  yield* sql`DROP TABLE project_coordinators_legacy`;
  yield* sql`
    CREATE UNIQUE INDEX project_coordinators_current
    ON project_coordinators (project_id) WHERE superseded = 0
  `;
});
