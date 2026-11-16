import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Expression encodings are pinned here; older binaries can leave these read-only indexes intact.
  for (const table of ["factory_issue_launches", "factory_feed_launches"]) {
    const at =
      "json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.createdAt')";
    const project =
      "json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.projectId')";
    const previous =
      "json_extract(CASE WHEN json_valid(intent_json) THEN intent_json ELSE '{}' END, '$.previousThreadId')";
    yield* sql.unsafe(
      `CREATE INDEX ${table}_work_order ON ${table} (${at}, thread_id) WHERE ${previous} IS NULL`,
    );
    yield* sql.unsafe(
      `CREATE INDEX ${table}_work_project ON ${table} (${project}, ${at}, thread_id) WHERE ${previous} IS NULL`,
    );
    yield* sql.unsafe(`CREATE INDEX ${table}_work_previous ON ${table} (${previous}, thread_id)`);
  }
  yield* sql`CREATE INDEX factory_knowledge_briefs_work_order ON factory_knowledge_briefs (created_at, id)`;
  yield* sql`CREATE INDEX factory_knowledge_briefs_work_project ON factory_knowledge_briefs (project_id, created_at, id)`;
  yield* sql`CREATE INDEX factory_knowledge_briefs_work_lineage ON factory_knowledge_briefs (superseded_by, id)`;
  yield* sql`CREATE INDEX factory_knowledge_launches_work_history ON factory_knowledge_launches (brief_id, thread_id)`;
  yield* sql`CREATE INDEX factory_research_protocols_work_order ON factory_research_protocols (sealed_at, protocol_id)`;
  yield* sql`CREATE INDEX factory_research_protocols_work_project ON factory_research_protocols (project_id, sealed_at, protocol_id)`;
  yield* sql`CREATE INDEX factory_research_launches_work_history ON factory_research_launches (protocol_id, thread_id)`;
  yield* sql`CREATE INDEX factory_work_runs_history ON orchestration_v2_projection_runs (thread_id, run_id)`;
  yield* sql`CREATE INDEX factory_work_attempts_history ON orchestration_v2_projection_run_attempts (run_id, thread_id, attempt_id)`;
  yield* sql`CREATE INDEX factory_feed_launches_work_conflicts ON factory_feed_launches (origin_key, origin_conflict)`;
});
