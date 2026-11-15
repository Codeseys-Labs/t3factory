import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import {
  hasPendingMigrations,
  migrationManifest,
  runMigrations,
  skippedV2Migrations,
} from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import FactoryIssueLaunches from "./Migrations/193_FactoryIssueLaunches.ts";
import ProjectCoordinators from "./Migrations/194_ProjectCoordinators.ts";
import FactoryFeeds from "./Migrations/195_FactoryFeeds.ts";
import FactoryIssueRelations from "./Migrations/196_FactoryIssueRelations.ts";
import FactoryReadinessOverrides from "./Migrations/197_FactoryReadinessOverrides.ts";
import FactoryResearch from "./Migrations/198_FactoryResearch.ts";
import FactoryClaims from "./Migrations/199_FactoryClaims.ts";
import FactoryAcceptances from "./Migrations/200_FactoryAcceptances.ts";
import FactoryDeliveryIntents from "./Migrations/201_FactoryDeliveryIntents.ts";
import FactoryKnowledge from "./Migrations/202_FactoryKnowledge.ts";
import FactoryArtifactDeliveries from "./Migrations/203_FactoryArtifactDeliveries.ts";
import FactoryBaseBranches from "./Migrations/204_FactoryBaseBranches.ts";
import ProjectCoordinatorRevisions from "./Migrations/205_ProjectCoordinatorRevisions.ts";
import FactoryWorkReadIndexes from "./Migrations/206_FactoryWorkReadIndexes.ts";
import FactoryPlans from "./Migrations/207_FactoryPlans.ts";
import FactoryExecutions from "./Migrations/208_FactoryExecutions.ts";
import FactoryTasks from "./Migrations/209_FactoryTasks.ts";
import FactoryTaskProposals from "./Migrations/210_FactoryTaskProposals.ts";
import FactoryIntake from "./Migrations/211_FactoryIntake.ts";
import FactoryTaskDefaultModes from "./Migrations/212_FactoryTaskDefaultModes.ts";

const seedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 52 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2 }),
  });
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
    VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
  `;
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-09-15 00:00:00' WHERE migration_id = 53
  `;
});

// The seeded preview already holds 1..52 and 55 (recorded as 53); the upgrade applies the rest.
const expectedUpgradeLedger = migrationManifest.filter(([id]) => id >= 53 && id !== 55);

describe("V2 preview upgrade", () => {
  it.effect("upgrades a published preview without replaying V2 or losing import progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
      assert.deepStrictEqual(yield* runMigrations(), expectedUpgradeLedger);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 55`,
        [{ created_at: "2026-09-15 00:00:00" }],
      );
      yield* sql`
        INSERT INTO pull_request_files_viewed
          (provider, host, repository, number, viewer, path, revision, viewed_at)
        VALUES ('github', 'github.com', 'owner/repo', 1, 'viewer', 'file.ts', 'revision', '2026-09-17')
      `;
      assert.strictEqual((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades preview migration 54 with index cleanup %s",
    (withIndexes) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "53_PullRequestFilesViewed": PullRequestFilesViewed,
            "54_OrchestrationV2": OrchestrationV2,
            ...(withIndexes
              ? { "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes }
              : {}),
          }),
        });
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        assert.ok(columns.some((column) => column.name === "auto_settle_disabled_at"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`
        CREATE TRIGGER fail_preview_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'PullRequestFilesViewed'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53`,
        [{ migration_id: 53, name: "OrchestrationV2" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'`,
        [],
      );
      assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_legacy_imports`).length, 1);
      yield* sql`DROP TRIGGER fail_preview_upgrade`;
      assert.deepStrictEqual(yield* runMigrations(), expectedUpgradeLedger);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unexpected later migrations without modifying their history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

const factoryMigrations = {
  "193_FactoryIssueLaunches": FactoryIssueLaunches,
  "194_ProjectCoordinators": ProjectCoordinators,
  "195_FactoryFeeds": FactoryFeeds,
  "196_FactoryIssueRelations": FactoryIssueRelations,
  "197_FactoryReadinessOverrides": FactoryReadinessOverrides,
  "198_FactoryResearch": FactoryResearch,
  "199_FactoryClaims": FactoryClaims,
  "200_FactoryAcceptances": FactoryAcceptances,
  "201_FactoryDeliveryIntents": FactoryDeliveryIntents,
  "202_FactoryKnowledge": FactoryKnowledge,
  "203_FactoryArtifactDeliveries": FactoryArtifactDeliveries,
  "204_FactoryBaseBranches": FactoryBaseBranches,
  "205_ProjectCoordinatorRevisions": ProjectCoordinatorRevisions,
  "206_FactoryWorkReadIndexes": FactoryWorkReadIndexes,
  "207_FactoryPlans": FactoryPlans,
  "208_FactoryExecutions": FactoryExecutions,
  "209_FactoryTasks": FactoryTasks,
  "210_FactoryTaskProposals": FactoryTaskProposals,
  "211_FactoryIntake": FactoryIntake,
  "212_FactoryTaskDefaultModes": FactoryTaskDefaultModes,
};

const recordedHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

describe("Factory history upgrade", () => {
  // Fork databases record Factory ids above every upstream id the last sync knew.
  it.effect("installs the upstream migrations a sync added below recorded Factory ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });
      yield* Migrator.make({})({ loader: Migrator.fromRecord(factoryMigrations) });
      yield* sql`
        INSERT INTO factory_issue_launches
          (thread_id, canonical_key, issue_number, request_command_id, intent_json)
        VALUES ('factory-thread', 'github.com/owner/repo', 1, 'factory-command', '{}')
      `;
      const synced = migrationManifest.filter(([id]) => id > 73 && id < 193);
      assert.isAbove(synced.length, 0);
      const before = (yield* recordedHistory).map(([id, name]) => ({ id, name }));
      assert.deepStrictEqual(skippedV2Migrations(before), []);
      assert.isTrue(yield* hasPendingMigrations());

      assert.deepStrictEqual(yield* runMigrations(), synced);

      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.isFalse(yield* hasPendingMigrations());
      assert.deepStrictEqual(yield* recordedHistory, migrationManifest);
      assert.deepStrictEqual(yield* sql`SELECT thread_id FROM factory_issue_launches`, [
        { thread_id: "factory-thread" },
      ]);
      assert.strictEqual(
        (yield* sql`
          SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_turn_item_counts'
        `).length,
        1,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves the history unchanged when an install fails, then retries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });
      yield* Migrator.make({})({ loader: Migrator.fromRecord(factoryMigrations) });
      yield* sql`CREATE TABLE orchestration_v2_projection_turn_item_counts (thread_id TEXT)`;
      const before = yield* recordedHistory;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* recordedHistory, before);
      assert.deepStrictEqual(
        yield* sql`
          SELECT name FROM sqlite_master WHERE name = 'idx_orch_events_correlation_id'
        `,
        [{ name: "idx_orch_events_correlation_id" }],
      );

      yield* sql`DROP TABLE orchestration_v2_projection_turn_item_counts`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* recordedHistory, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
