import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { canonicalExecutionJson } from "../../factory/FactoryExecutionDigest.ts";
import { runMigrations } from "../Migrations.ts";

const task = (id: string, parentId: string | null, retired = false) => ({
  id,
  parentId,
  title: `Task ${id}`,
  context: "",
  order: 0,
  retired,
});

it.effect("existing plans become tasks numbered in the order they were created", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 208 });
    const insert = (
      rootId: string,
      createdAt: string,
      tasks: ReadonlyArray<ReturnType<typeof task>>,
      edges: ReadonlyArray<{ fromTaskId: string; toTaskId: string; retired: boolean }> = [],
    ) =>
      sql`INSERT INTO factory_plan_heads(root_id, project_id, revision, snapshot_json, summary_json) VALUES (${rootId}, 'project', 1, ${canonicalExecutionJson(
        {
          ref: { environmentId: "local", projectId: "project", rootId },
          revision: 1,
          tasks,
          edges: edges.map((edge, index) => ({
            id: `edge-${index}`,
            kind: "requires",
            requirement: "",
            ...edge,
          })),
          workContexts: [],
          editorThreadIds: [],
          createdAt,
          updatedAt: createdAt,
        },
      )}, '{}')`;
    // Stored newest first: numbering follows creation time, not row order.
    yield* insert("newer", "2026-11-02T00:00:00.000Z", [task("newer", null)]);
    yield* insert(
      "older",
      "2026-11-01T00:00:00.000Z",
      [
        // A sub-task moved under a task added after it still gets a number below that parent.
        task("moved", "second"),
        task("older", null),
        task("first", "older"),
        task("second", "older", true),
      ],
      [{ fromTaskId: "first", toTaskId: "second", retired: false }],
    );
    yield* runMigrations();

    const rows = yield* sql<{
      taskId: string;
      displayId: string;
      lane: string;
      assignment: string;
      retired: number;
    }>`SELECT task_id AS taskId, display_id AS displayId, lane, assignment_json AS assignment, retired FROM factory_tasks ORDER BY display_id`;
    assert.deepEqual(
      rows.map((row) => [row.taskId, row.displayId]),
      [
        ["older", "T-1"],
        ["first", "T-1.1"],
        ["second", "T-1.2"],
        ["moved", "T-1.2.1"],
        ["newer", "T-2"],
      ],
    );
    assert.deepEqual(
      rows.map((row) => row.assignment),
      [
        '{"mode":"unassigned"}',
        '{"mode":"auto"}',
        '{"mode":"auto"}',
        '{"mode":"auto"}',
        '{"mode":"unassigned"}',
      ],
    );
    assert.isTrue(rows.every((row) => row.lane === "backlog"));
    assert.equal(rows.find((row) => row.taskId === "second")!.retired, 1);
    assert.deepEqual(
      yield* sql`SELECT task_id AS taskId, blocker_id AS blockerId FROM factory_task_blockers`,
      [{ taskId: "first", blockerId: "second" }],
    );
    // The counters continue where the backfill stopped, so no number is handed out twice.
    assert.deepEqual(
      yield* sql`SELECT root_id AS rootId, parent_id AS parentId, next FROM factory_task_counters ORDER BY root_id, parent_id`,
      [
        { rootId: "", parentId: "", next: 3 },
        { rootId: "older", parentId: "older", next: 3 },
        { rootId: "older", parentId: "second", next: 2 },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
