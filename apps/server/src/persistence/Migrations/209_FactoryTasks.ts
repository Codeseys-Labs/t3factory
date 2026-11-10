import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Only what numbering needs; the migration must keep reading plans after the contract moves on.
const decodePlan = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      tasks: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          parentId: Schema.NullOr(Schema.String),
          title: Schema.String,
          retired: Schema.Boolean,
        }),
      ),
      edges: Schema.Array(
        Schema.Struct({
          fromTaskId: Schema.String,
          toTaskId: Schema.String,
          retired: Schema.Boolean,
        }),
      ),
      createdAt: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
);

const LOCAL_SOURCE = '{"kind":"local","label":"Local","url":null,"key":null,"workRef":null}';

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE factory_tasks (
    root_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    parent_id TEXT,
    display_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    definition TEXT NOT NULL,
    plan_order INTEGER NOT NULL,
    retired INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'task',
    lane TEXT NOT NULL DEFAULT 'backlog',
    assignment_json TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'local',
    source_json TEXT NOT NULL,
    accepted_revision INTEGER,
    input_note TEXT,
    status TEXT NOT NULL DEFAULT 'backlog',
    assignee_key TEXT NOT NULL DEFAULT 'unassigned',
    version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (root_id, task_id)
  )`;
  yield* sql`CREATE INDEX factory_tasks_recent ON factory_tasks(updated_at DESC, root_id DESC, task_id DESC)`;
  yield* sql`CREATE INDEX factory_tasks_project ON factory_tasks(project_id, status)`;
  yield* sql`CREATE TABLE factory_task_counters (
    root_id TEXT NOT NULL,
    parent_id TEXT NOT NULL,
    next INTEGER NOT NULL,
    PRIMARY KEY (root_id, parent_id)
  )`;
  yield* sql`CREATE TABLE factory_task_blockers (
    root_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    blocker_id TEXT NOT NULL,
    PRIMARY KEY (root_id, task_id, blocker_id)
  )`;
  yield* sql`CREATE TABLE factory_task_runs (
    thread_id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    run_id TEXT NOT NULL,
    attempt_id TEXT,
    setup_json TEXT NOT NULL,
    profile_id TEXT,
    started_at TEXT NOT NULL,
    stop_requested INTEGER NOT NULL DEFAULT 0,
    ended_at TEXT,
    outcome TEXT,
    UNIQUE (root_id, task_id, ordinal)
  )`;
  yield* sql`CREATE INDEX factory_task_runs_profile ON factory_task_runs(profile_id, started_at)`;
  yield* sql`CREATE TABLE factory_task_launches (
    command_id TEXT PRIMARY KEY,
    profile_id TEXT,
    actor_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE factory_task_results (
    root_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    result_id TEXT NOT NULL UNIQUE,
    attempt_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    files_json TEXT NOT NULL,
    files_omitted INTEGER NOT NULL,
    commit_sha TEXT,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (root_id, task_id, revision)
  )`;
  yield* sql`CREATE TABLE factory_task_activity (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    at TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    event_json TEXT NOT NULL,
    dedupe_key TEXT UNIQUE
  )`;
  yield* sql`CREATE INDEX factory_task_activity_task ON factory_task_activity(root_id, task_id, seq)`;
  yield* sql`CREATE TABLE factory_task_proposals (
    proposal_id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX factory_task_proposals_task ON factory_task_proposals(root_id, task_id)`;
  yield* sql`CREATE TABLE factory_task_commands (
    command_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    digest TEXT NOT NULL,
    outcome_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE factory_agent_profiles (
    profile_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    setup_json TEXT NOT NULL,
    handles_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE factory_task_announcements (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT,
    profiles INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE factory_task_defaults (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    environment_model_json TEXT
  )`;

  // Plans that already exist become tasks, numbered in the order they were created.
  const heads = yield* sql<{
    rootId: string;
    projectId: string;
    snapshot: string;
  }>`SELECT root_id AS rootId, project_id AS projectId, snapshot_json AS snapshot FROM factory_plan_heads ORDER BY json_extract(snapshot_json, '$.createdAt'), rowid`;
  let nextRoot = 1;
  for (const head of heads) {
    const plan = yield* decodePlan(head.snapshot).pipe(Effect.orElseSucceed(() => null));
    // An unreadable plan gets its rows when it is next revised.
    if (plan === null) continue;
    const displayIds = new Map<string, string>();
    const counters = new Map<string, number>();
    let pending = plan.tasks.map((task, order) => ({ task, order }));
    while (pending.length > 0) {
      const waiting: typeof pending = [];
      for (const entry of pending) {
        const { task, order } = entry;
        const parentDisplayId = task.parentId === null ? null : displayIds.get(task.parentId);
        if (task.parentId !== null && parentDisplayId === undefined) {
          waiting.push(entry);
          continue;
        }
        let displayId: string;
        if (task.parentId === null) {
          displayId = `T-${nextRoot}`;
          nextRoot += 1;
        } else {
          const number = (counters.get(task.parentId) ?? 0) + 1;
          counters.set(task.parentId, number);
          displayId = `${parentDisplayId}.${number}`;
        }
        displayIds.set(task.id, displayId);
        yield* sql`INSERT INTO factory_tasks(root_id, task_id, project_id, parent_id, display_id, title, definition, plan_order, retired, assignment_json, source_json, created_at, updated_at) VALUES (${head.rootId}, ${task.id}, ${head.projectId}, ${task.parentId}, ${displayId}, ${task.title}, '', ${order}, ${task.retired ? 1 : 0}, ${task.parentId === null ? '{"mode":"unassigned"}' : '{"mode":"auto"}'}, ${LOCAL_SOURCE}, ${plan.createdAt}, ${plan.updatedAt})`;
      }
      // A plan whose parents never resolve is malformed; leave the rest for the first projection.
      if (waiting.length === pending.length) break;
      pending = waiting;
    }
    for (const [parentId, number] of counters)
      yield* sql`INSERT INTO factory_task_counters(root_id, parent_id, next) VALUES (${head.rootId}, ${parentId}, ${number + 1})`;
    for (const edge of plan.edges) {
      if (edge.retired) continue;
      yield* sql`INSERT OR IGNORE INTO factory_task_blockers(root_id, task_id, blocker_id) VALUES (${head.rootId}, ${edge.fromTaskId}, ${edge.toTaskId})`;
    }
  }
  yield* sql`INSERT INTO factory_task_counters(root_id, parent_id, next) VALUES ('', '', ${nextRoot})`;
});
