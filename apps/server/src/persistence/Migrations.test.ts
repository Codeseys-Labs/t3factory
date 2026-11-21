// @effect-diagnostics nodeBuiltinImport:off -- Injects filesystem failures into migration backup publication.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import { vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { hasPendingMigrations, migrationManifest, runMigrations } from "./Migrations.ts";

import * as oldBuild from "./test-fixtures/factoryMigrationsBeforeBand.ts";

import FactoryMigration193 from "./Migrations/10001_FactoryIssueLaunches.ts";
import FactoryMigration194 from "./Migrations/10002_ProjectCoordinators.ts";
import FactoryMigration195 from "./Migrations/10003_FactoryFeeds.ts";
import FactoryMigration196 from "./Migrations/10004_FactoryIssueRelations.ts";
import FactoryMigration197 from "./Migrations/10005_FactoryReadinessOverrides.ts";
import FactoryMigration198 from "./Migrations/10006_FactoryResearch.ts";
import FactoryMigration199 from "./Migrations/10007_FactoryClaims.ts";
import FactoryMigration200 from "./Migrations/10008_FactoryAcceptances.ts";
import FactoryMigration201 from "./Migrations/10009_FactoryDeliveryIntents.ts";
import FactoryMigration202 from "./Migrations/10010_FactoryKnowledge.ts";
import FactoryMigration203 from "./Migrations/10011_FactoryArtifactDeliveries.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return { ...actual };
});

const legacyFactoryMigrations = [
  [69, "FactoryIssueLaunches", FactoryMigration193],
  [70, "ProjectCoordinators", FactoryMigration194],
  [71, "FactoryFeeds", FactoryMigration195],
  [72, "FactoryIssueRelations", FactoryMigration196],
  [73, "FactoryReadinessOverrides", FactoryMigration197],
  [74, "FactoryResearch", FactoryMigration198],
  [75, "FactoryClaims", FactoryMigration199],
  [200, "FactoryAcceptances", FactoryMigration200],
  [201, "FactoryDeliveryIntents", FactoryMigration201],
  [202, "FactoryKnowledge", FactoryMigration202],
  [203, "FactoryArtifactDeliveries", FactoryMigration203],
] as const;

const legacyFactoryDatabase = (throughId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 68 });
    for (const [id, name, migration] of legacyFactoryMigrations) {
      if (id > throughId) continue;
      yield* migration;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      if (id === 69) {
        yield* sql`INSERT INTO factory_issue_launches
        (thread_id, canonical_key, issue_number, request_command_id, intent_json)
        VALUES ('legacy-thread', 'github.com/owner/repo', 1, 'legacy-command', '{}')`;
      }
    }
  });

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId =
  Math.max(...migrationManifest.filter(([id]) => id < 10001).map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

const oldBuildIds = new Set<number>(oldBuild.migrationManifest.map(([id]) => id));
// Upstream migrations a later sync added install below the converted Factory ids.
const expectedBandHistory = [
  ...oldBuild.migrationManifest.map(([id, name]) => [id >= 193 ? id + 9808 : id, name] as const),
  ...migrationManifest.filter(([id]) => id < 10001 && !oldBuildIds.has(id)),
].toSorted(([left], [right]) => left - right);

const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`;
});

describe("Factory migration band", () => {
  it.effect.each([
    "success",
    "stale cleanup failure",
    "folder sync failure",
    "publish failure",
    "cleanup failure",
    "vacuum failure",
    "unknown history",
  ])("publishes one complete backup before conversion: %s", (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-band-" });
      const filename = path.join(root, "statev2.sqlite");
      const stale = path.join(
        root,
        "statev2.sqlite.partial-factory-band-backup-20261116T000000Z-deadbeef",
      );
      yield* fs.writeFileString(stale, "interrupted backup");
      const backups = () =>
        fs
          .readDirectory(root)
          .pipe(
            Effect.map((names) =>
              names.filter((name) => name.includes(".before-factory-migration-band")),
            ),
          );
      assert.deepStrictEqual(yield* backups(), []);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* oldBuild.runMigrations();
        if (scenario === "unknown history") {
          yield* sql`UPDATE effect_sql_migrations SET name = 'UnrecognizedMigration' WHERE migration_id = 200`;
        }
        const before = yield* history;
        const originalOpen = NodeFSP.open;
        using open = vi.spyOn(NodeFSP, "open");
        using rename = vi.spyOn(NodeFSP, "rename");
        const originalRm = NodeFSP.rm;
        using rm = vi.spyOn(NodeFSP, "rm");
        if (scenario === "cleanup failure") {
          rm.mockImplementation(async (...args) => {
            if (String(args[0]) !== stale) throw new Error("injected cleanup failure");
            return originalRm(...args);
          });
        }
        if (scenario === "stale cleanup failure") {
          rm.mockImplementation(async (...args) => {
            if (String(args[0]) === stale) throw new Error("stale cleanup denied");
            return originalRm(...args);
          });
        }
        if (scenario === "publish failure" || scenario === "cleanup failure") {
          rename.mockRejectedValueOnce(
            Object.assign(new Error("backup device full"), { code: "ENOSPC" }),
          );
        }
        if (scenario === "vacuum failure") {
          open.mockImplementationOnce(async (...args) => {
            const file = await originalOpen(...args);
            await file.writeFile("injected interrupted vacuum output");
            return file;
          });
        }
        if (scenario === "folder sync failure") {
          open.mockImplementation(async (...args) => {
            if (String(args[0]) === path.dirname(filename))
              throw Object.assign(new Error("folder sync refused"), { code: "EINVAL" });
            return originalOpen(...args);
          });
        }
        const warnings: string[] = [];
        const exit = yield* Effect.exit(
          scenario === "folder sync failure"
            ? runMigrations().pipe(Effect.provideService(HostProcess.Platform, "linux"))
            : runMigrations(),
        ).pipe(
          Effect.provide(
            Logger.layer(
              [
                Logger.make(({ logLevel, message }) => {
                  if (logLevel === "Warn") warnings.push(String(message));
                }),
              ],
              { mergeWithExisting: false },
            ),
          ),
        );
        if (scenario === "cleanup failure" || scenario === "stale cleanup failure")
          assert.isTrue(
            warnings.some((message) =>
              message.includes("Cannot remove the staged Factory migration backup"),
            ),
          );
        if (scenario === "folder sync failure")
          assert.isTrue(
            warnings.some((message) =>
              message.includes("Could not sync the folder of the Factory migration backup"),
            ),
          );
        if (
          scenario !== "success" &&
          scenario !== "stale cleanup failure" &&
          scenario !== "folder sync failure"
        ) {
          assert.isTrue(Exit.isFailure(exit));
          if (scenario === "cleanup failure" && Exit.isFailure(exit)) {
            assert.deepStrictEqual(exit.cause.reasons.filter(Cause.isDieReason), []);
            assert.lengthOf(exit.cause.reasons, 1);
            assert.include(String(exit), "backup device full");
            rm.mockRestore();
          }
          assert.deepStrictEqual(yield* history, before);
          assert.deepStrictEqual(yield* backups(), []);
          if (scenario === "unknown history") return;
          assert.include(String(exit), filename);
          assert.include(String(exit), "retry");
          yield* runMigrations();
        } else assert.isTrue(Exit.isSuccess(exit));
        const names = yield* backups();
        assert.lengthOf(names, 1);
        assert.match(
          names[0]!,
          /^statev2\.sqlite\.before-factory-migration-band-\d{8}T\d{6}Z-[a-f0-9]{8}$/,
        );
        assert.isFalse(names[0]!.endsWith(".staging"));
        assert.strictEqual(yield* fs.exists(stale), scenario === "stale cleanup failure");
        assert.deepStrictEqual(
          (yield* fs.readDirectory(root)).filter((name) =>
            name.startsWith("statev2.sqlite.partial-"),
          ),
          scenario === "stale cleanup failure" ? [path.basename(stale)] : [],
        );
        const backup = path.join(root, names[0]!);
        assert.isTrue((yield* fs.stat(backup)).type === "File");
        yield* Effect.gen(function* () {
          const backupSql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* history, before);
          assert.deepStrictEqual(yield* backupSql`PRAGMA integrity_check`, [
            { integrity_check: "ok" },
          ]);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: backup, readonly: true })));
        assert.deepStrictEqual(yield* history, expectedBandHistory);
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.isFalse(yield* hasPendingMigrations());
        assert.deepStrictEqual(yield* backups(), names);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes stale staged backups without overwriting an existing final name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-band-collision-" });
      const filename = path.join(root, "statev2.sqlite");
      const existing = path.join(
        root,
        "statev2.sqlite.before-factory-migration-band-19700101T000000Z-deadbeef",
      );
      const stale = path.join(
        root,
        "statev2.sqlite.partial-factory-band-backup-19691231T235959Z-deadbeef",
      );
      const unrelated = path.join(
        root,
        "other.sqlite.partial-factory-band-backup-19691231T235959Z-deadbeef",
      );
      yield* fs.writeFileString(existing, "previous finished backup");
      yield* fs.writeFileString(stale, "interrupted backup");
      yield* fs.writeFileString(unrelated, "another database's file");
      using _random = vi
        .spyOn(NodeCrypto, "randomUUID")
        .mockReturnValueOnce("deadbeef-0000-4000-8000-000000000000")
        .mockReturnValueOnce("cafebabe-0000-4000-8000-000000000000");
      yield* Effect.gen(function* () {
        yield* oldBuild.runMigrations();
        yield* runMigrations();
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      assert.strictEqual(yield* fs.readFileString(existing), "previous finished backup");
      assert.isFalse(yield* fs.exists(stale));
      assert.strictEqual(yield* fs.readFileString(unrelated), "another database's file");
      assert.deepStrictEqual(
        (yield* fs.readDirectory(root))
          .filter((name) => name.startsWith("statev2.sqlite.before-factory-migration-band-"))
          .sort(),
        [
          "statev2.sqlite.before-factory-migration-band-19700101T000000Z-cafebabe",
          path.basename(existing),
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["failed translation", "restored backup"])(
    "takes a distinct current backup after %s",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-band-retry-" });
        const filename = path.join(root, "statev2.sqlite");
        const withDatabase = <A, E, R>(program: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
          program.pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
        const backups = () =>
          fs
            .readDirectory(root)
            .pipe(
              Effect.map((names) =>
                names
                  .filter((name) =>
                    name.startsWith("statev2.sqlite.before-factory-migration-band-"),
                  )
                  .sort(),
              ),
            );
        yield* withDatabase(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* oldBuild.runMigrations();
            yield* sql`CREATE TABLE retained_work (id INTEGER PRIMARY KEY, text TEXT)`;
            yield* sql`INSERT INTO retained_work VALUES (1, 'before')`;
            if (scenario === "failed translation") {
              yield* sql`CREATE TRIGGER fail_translation BEFORE UPDATE OF migration_id ON effect_sql_migrations WHEN NEW.migration_id = 10002 BEGIN SELECT RAISE(ABORT, 'interrupted translation'); END`;
              assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
              yield* sql`DROP TRIGGER fail_translation`;
            } else yield* runMigrations();
          }),
        );
        const first = yield* backups();
        assert.lengthOf(first, 1);
        if (scenario === "restored backup") {
          yield* fs.copyFile(path.join(root, first[0]!), filename);
          for (const suffix of ["-wal", "-shm"])
            yield* fs.remove(`${filename}${suffix}`, { force: true });
        }
        yield* withDatabase(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(yield* oldBuild.runMigrations(), []);
            yield* sql`INSERT INTO retained_work VALUES (2, 'between upgrades')`;
            yield* runMigrations();
          }),
        );
        const second = yield* backups();
        assert.lengthOf(second, 2);
        const newer = second.find((name) => name !== first[0])!;
        assert.strictEqual(newer.slice(0, -8), first[0]!.slice(0, -8));
        for (const [name, count] of [
          [first[0]!, 1],
          [newer, 2],
        ] as const) {
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(yield* sql`SELECT count(*) AS count FROM retained_work`, [
              { count },
            ]);
            assert.deepStrictEqual(yield* history, oldBuild.migrationManifest);
          }).pipe(
            Effect.provide(
              NodeSqliteClient.layer({ filename: path.join(root, name), readonly: true }),
            ),
          );
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back when a translation update changes no row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* oldBuild.runMigrations();
      yield* sql`CREATE TRIGGER ignore_translation BEFORE UPDATE OF migration_id ON effect_sql_migrations WHEN NEW.migration_id = 10002 BEGIN SELECT RAISE(IGNORE); END`;
      const before = yield* history;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
      yield* sql`DROP TRIGGER ignore_translation`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, expectedBandHistory);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("gives a fresh database the default branch's schema once upgraded", () =>
    Effect.gen(function* () {
      const upgradedSchema = yield* Effect.gen(function* () {
        yield* oldBuild.runMigrations();
        yield* runMigrations();
        return yield* schema;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
      yield* runMigrations();
      assert.deepStrictEqual(yield* schema, upgradedSchema);
      assert.deepStrictEqual(yield* history, expectedBandHistory);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([193, 199, 203, 212, 213])("converts recorded high history through %s", (id) =>
    Effect.gen(function* () {
      yield* oldBuild.runMigrations({ toMigrationInclusive: id });
      const before = yield* history;
      assert.isTrue(yield* hasPendingMigrations());
      assert.deepStrictEqual(yield* history, before);
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, expectedBandHistory);
      assert.isFalse(yield* hasPendingMigrations());
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back an interrupted translation and converts on the next start", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* oldBuild.runMigrations();
      yield* sql`CREATE TRIGGER interrupt_translation BEFORE UPDATE OF migration_id ON effect_sql_migrations
        WHEN NEW.migration_id = 10002 BEGIN SELECT RAISE(ABORT, 'interrupted translation'); END`;
      const before = yield* history;
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "interrupted translation");
      assert.deepStrictEqual(yield* history, before);
      yield* sql`DROP TRIGGER interrupt_translation`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, expectedBandHistory);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each(["unknown", "duplicate"])("refuses %s unconverted history unchanged", (kind) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* oldBuild.runMigrations();
      if (kind === "unknown") {
        yield* sql`UPDATE effect_sql_migrations SET name = 'UnrecognizedMigration' WHERE migration_id = 200`;
      } else {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (10001, 'FactoryIssueLaunches')`;
      }
      const before = yield* history;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses a Factory migration newer than this build", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (10022, 'FutureFactoryMigration')`;
      const before = yield* history;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "old build refuses converted history with pending upstream: %s",
    (pending) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* oldBuild.runMigrations();
        yield* runMigrations();
        assert.deepStrictEqual(yield* history, expectedBandHistory);
        if (pending) yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 96`;
        const before = yield* history;
        const exit = yield* Effect.exit(oldBuild.runMigrations());
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "193_FactoryIssueLaunches (recorded: nothing)");
        assert.include(String(exit), "highest recorded id (10021)");
        assert.strictEqual(
          oldBuild.preflightRows(before.map(([id, name]) => ({ id, name }))).status,
          "blocked",
        );
        assert.deepStrictEqual(yield* history, before);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

describe("runMigrations", () => {
  it.effect(
    "adds planning tables and unset delivery destinations without rewriting retained work",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 10011 });
        const snapshot = JSON.stringify({ baseRef: "a".repeat(40) });
        yield* sql`INSERT INTO factory_issue_launches
        (thread_id, canonical_key, issue_number, request_command_id, intent_json)
        VALUES ('thread', 'github.com/owner/repo', 1, 'launch', ${snapshot})`;
        yield* sql`INSERT INTO factory_acceptances
        (id, origin_key, thread_id, project_id, head_sha, base_ref, base_sha, accepted_at, accepted_by, evidence_json)
        VALUES ('acceptance', 'origin', 'thread', 'project', 'head', 'snapshot', 'snapshot', 'at', 'env', '[]')`;
        yield* sql`INSERT INTO factory_delivery_intents
        (id, origin_key, thread_id, project_id, kind, acceptance_id, repository_json, base_ref, base_sha,
         head_sha, payload_json, payload_digest, granted_by, granted_at, request_command_id, status, updated_at)
        VALUES ('delivery', 'origin', 'thread', 'project', 'publish-pr', 'acceptance', '{}', 'snapshot', 'snapshot',
          'head', '{}', 'digest', 'env', 'at', 'grant', 'pending', 'at')`;
        yield* runMigrations();
        assert.deepEqual(yield* sql`SELECT * FROM factory_plan_heads`, []);
        assert.deepEqual(yield* sql`SELECT * FROM factory_plan_revisions`, []);
        assert.deepEqual(yield* sql`SELECT * FROM factory_plan_commands`, []);
        assert.deepEqual(yield* sql`SELECT * FROM factory_execution_bindings`, []);
        assert.deepEqual(yield* sql`SELECT * FROM factory_execution_commands`, []);
        assert.deepEqual(yield* sql`SELECT * FROM factory_execution_results`, []);
        assert.deepEqual(yield* sql`SELECT * FROM factory_preparation_acceptances`, []);
        assert.deepEqual(yield* sql`SELECT intent_json FROM factory_issue_launches`, [
          { intent_json: snapshot },
        ]);
        assert.deepEqual(
          yield* sql`SELECT base_ref, base_sha, head_sha, base_branch FROM factory_acceptances`,
          [{ base_ref: "snapshot", base_sha: "snapshot", head_sha: "head", base_branch: null }],
        );
        assert.deepEqual(
          yield* sql`SELECT base_ref, base_sha, head_sha, base_branch, payload_digest, status FROM factory_delivery_intents`,
          [
            {
              base_ref: "snapshot",
              base_sha: "snapshot",
              head_sha: "head",
              base_branch: null,
              payload_digest: "digest",
              status: "pending",
            },
          ],
        );
        assert.deepEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("adds the place to record a given-up result beside a held run, in place", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 10020 });
      yield* sql`INSERT INTO factory_execution_bindings(attempt_id, run_id, thread_id, root_id, revision, task_id, grant_version, binding_json, stop_requested) VALUES ('attempt', 'run', 'thread', 'root', 1, 'task', 1, '{}', 1)`;
      yield* sql`INSERT INTO factory_execution_phases(attempt_id, phase, claimant_id, observation, detail) VALUES ('attempt', 'capture', 'worker', 'quiescent', '')`;
      const held = Effect.gen(function* () {
        return [
          yield* sql`SELECT attempt_id, stop_requested, quiescent FROM factory_execution_bindings`,
          yield* sql`SELECT attempt_id, phase, observation FROM factory_execution_phases`,
        ];
      });
      const before = yield* held;
      assert.deepStrictEqual(yield* runMigrations(), [[10021, "FactoryCaptureAbandonments"]]);
      assert.deepStrictEqual(yield* held, before);
      yield* sql`INSERT INTO factory_execution_capture_abandonments(attempt_id, capture_key, command_id, session_id, abandoned_at) VALUES ('attempt', 'native-final/1', 'give-up', 'session', 'at')`;
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            sql`INSERT INTO factory_execution_capture_abandonments(attempt_id, capture_key, command_id, session_id, abandoned_at) VALUES ('attempt', 'native-final/1', 'give-up-again', 'session', 'at')`,
          ),
        ),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "upgrades known legacy Factory histories without replaying their schema or losing data",
    () =>
      Effect.forEach([69, 72, 75, 200, 202, 203], (throughId) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* legacyFactoryDatabase(throughId);
          const before = yield* history;
          assert.isTrue(yield* hasPendingMigrations());
          assert.deepStrictEqual(yield* history, before);
          yield* runMigrations();
          assert.deepStrictEqual(yield* history, expectedBandHistory);
          assert.isFalse(yield* hasPendingMigrations());
          assert.deepStrictEqual(yield* sql`SELECT thread_id FROM factory_issue_launches`, [
            { thread_id: "legacy-thread" },
          ]);
          assert.strictEqual(
            (yield* sql`SELECT name FROM sqlite_master WHERE name = 'peer_environment_links'`)
              .length,
            1,
          );
          assert.deepStrictEqual(yield* runMigrations(), []);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
  );

  it.effect("refuses an unrecognized legacy Factory history without rewriting it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* legacyFactoryDatabase(75);
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (200, 'UnrecognizedMigration')`;
      const before = yield* history;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(
        (yield* sql`SELECT name FROM sqlite_master WHERE name = 'peer_environment_links'`).length,
        0,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations.filter(([id]) => id < newerMigrationId)) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54, then rechecks it without a write lock", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);

      // query_only rejects BEGIN IMMEDIATE, which CLI startup would otherwise take on the live database.
      yield* sql`PRAGMA query_only = ON`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the migrations that finished before a later one failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });
      yield* sql`CREATE TABLE orchestration_v2_projection_turn_item_counts (thread_id TEXT)`;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(
        yield* history,
        migrationManifest.filter(([id]) => id <= 84),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("reapplies peer link migrations whose ledger rows are missing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id BETWEEN 70 AND 72`;

      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 70),
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
