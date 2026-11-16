import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE factory_execution_grants (root_id TEXT NOT NULL, version INTEGER NOT NULL, grant_json TEXT NOT NULL, PRIMARY KEY(root_id, version))`;
  yield* sql`CREATE TABLE factory_execution_tasks (root_id TEXT NOT NULL, revision INTEGER NOT NULL, task_id TEXT NOT NULL, version INTEGER NOT NULL, attempt_id TEXT NOT NULL, selected_result_id TEXT, PRIMARY KEY(root_id, revision, task_id))`;
  yield* sql`CREATE TABLE factory_execution_bindings (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL UNIQUE, root_id TEXT NOT NULL, revision INTEGER NOT NULL, task_id TEXT NOT NULL, grant_version INTEGER NOT NULL, binding_json TEXT NOT NULL, stop_requested INTEGER NOT NULL DEFAULT 0, quiescent INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE INDEX factory_execution_binding_root ON factory_execution_bindings(root_id, revision)`;
  yield* sql`CREATE TABLE factory_execution_commands (command_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, digest TEXT NOT NULL, outcome_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE factory_execution_phases (attempt_id TEXT NOT NULL, phase TEXT NOT NULL, claimant_id TEXT NOT NULL, observation TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY(attempt_id, phase))`;
  yield* sql`CREATE TABLE factory_execution_capture_retries (attempt_id TEXT NOT NULL, generation INTEGER NOT NULL, command_id TEXT NOT NULL UNIQUE, prior_phase_json TEXT NOT NULL, PRIMARY KEY(attempt_id, generation))`;
  yield* sql`CREATE TABLE factory_execution_results (result_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, capture_key TEXT NOT NULL, root_id TEXT NOT NULL, revision INTEGER NOT NULL, task_id TEXT NOT NULL, payload_digest TEXT NOT NULL, output_json TEXT NOT NULL, text_bytes BLOB NOT NULL, UNIQUE(attempt_id, capture_key))`;
  yield* sql`CREATE TABLE factory_execution_assemblies (digest TEXT PRIMARY KEY, root_id TEXT NOT NULL, revision INTEGER NOT NULL, manifest_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE factory_execution_verifications (digest TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, repository_path TEXT NOT NULL, evidence_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE factory_preparation_acceptances (command_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, revision INTEGER NOT NULL, acceptance_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE factory_preparation_settlements (root_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, reopened INTEGER NOT NULL, PRIMARY KEY(root_id, revision))`;
});
