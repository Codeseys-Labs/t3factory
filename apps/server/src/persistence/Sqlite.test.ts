// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeWorkerThreads from "node:worker_threads";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import * as oldBuild from "./test-fixtures/factoryMigrationsBeforeBand.ts";
import { databaseSnapshot } from "./test-fixtures/databaseSnapshot.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import {
  DATABASE_MIGRATIONS_STARTED_MESSAGE,
  DATABASE_MIGRATIONS_FINISHED_MESSAGE,
} from "@t3tools/shared/databaseMigrationLog";

const workerData = vi.hoisted((): Array<unknown> => []);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workerData.push(args[1]?.workerData);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

it.effect("publishes only successful transaction callbacks, dropping rolled-back savepoints", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const published: number[] = [];
    const publish = (value: number) =>
      SqlitePersistence.afterCommit(
        Effect.sync(() => {
          published.push(value);
        }),
      );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* publish(1);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* publish(2);
              return yield* Effect.fail("rollback savepoint");
            }),
          )
          .pipe(Effect.flip);
        yield* sql.withTransaction(publish(3));
        assert.deepEqual(published, []);
      }),
    );
    assert.deepEqual(published, [1, 3]);
    const ready = yield* Deferred.make<void>();
    const interrupted = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* publish(4);
          yield* Deferred.succeed(ready, undefined);
          return yield* Effect.never;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(ready);
    yield* Fiber.interrupt(interrupted);
    yield* sql.withTransaction(publish(5));
    assert.deepEqual(published, [1, 3, 5]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

// Linux names an open, already-deleted file "<path> (deleted)" in /proc/self/fd.
// SQLite names its temp files "etilqs_*" and, without TMPDIR, puts them in
// /var/tmp while os.tmpdir() is /tmp, so match the name, not the directory.
const openDeletedTempFiles = () =>
  NodeFS.readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = NodeFS.readlinkSync(`/proc/self/fd/${fd}`);
      return target.includes("/etilqs_") && target.endsWith(" (deleted)") ? [target] : [];
    } catch {
      return [];
    }
  });

it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "keeps a write transaction's statement journal off the temp directory",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-temp-"));
    const persistence = SqlitePersistence.layerFromPath(
      NodePath.join(tempDir, "state.sqlite"),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE journal_probe(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`;
      for (let id = 0; id < 64; id++) {
        yield* sql`INSERT INTO journal_probe VALUES (${id}, ${"x".repeat(4096)})`;
      }
      const before = new Set(openDeletedTempFiles());
      const opened = yield* sql.withTransaction(
        Effect.gen(function* () {
          // A multi-row update can fail halfway, so SQLite journals every page
          // it changes, here well past the 64 KiB it holds in memory by default.
          yield* sql`UPDATE journal_probe SET payload = payload || 'y'`;
          return openDeletedTempFiles().filter((target) => !before.has(target));
        }),
      );
      assert.deepEqual(opened, []);
    }).pipe(
      Effect.provide(persistence),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("upgrades an existing database on a read-write worker connection", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-upgrade-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* runMigrations({ toMigrationInclusive: 81 });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
    const startedBefore = workerData.length;

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
    }).pipe(
      Effect.provide(
        SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
    assert.deepInclude(workerData.slice(startedBefore), {
      filename: dbPath,
      readOnly: false,
      requireWal: false,
      allowExtension: false,
      prepareCacheSize: 200,
    });
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("names a database file that is not SQLite", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-notadb-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  NodeFS.writeFileSync(dbPath, "not a db\n");

  return Effect.gen(function* () {
    const opened = yield* Effect.void.pipe(
      Effect.provide(
        SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
      Effect.result,
    );

    assert.equal(opened._tag, "Failure");
    if (opened._tag === "Failure") {
      assert.isTrue(SqlError.isSqlError(opened.failure));
      assert.include(opened.failure.message, dbPath);
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

const ownT3Home = Effect.fn(function* () {
  const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  // An empty home, so no boot service installed on this machine is read.
  const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  yield* ServerOwnership.acquireServerOwnership(serverRuntimeStatePath).pipe(
    Effect.provide(ProcessRunner.layer),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, {}),
  );
});

const migrateTo = (toMigrationInclusive?: number) =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* runMigrations({ toMigrationInclusive }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    );
  });

const latestRecordedMigrationId = Effect.gen(function* () {
  const { dbPath } = yield* ServerConfig.ServerConfig;
  const rows = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly id: number }>`
      SELECT MAX(migration_id) AS id FROM effect_sql_migrations
    `;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
  return rows[0]?.id;
});

const layerT3Home = ServerConfig.layerTest(process.cwd(), { prefix: "t3-sqlite-cli-" });

it.effect.each([212, 213])(
  "Factory band worker startup and faithful old-build restore through %s",
  (head) => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dbPath } = yield* ServerConfig.ServerConfig;
      const backupMetadata = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [schema] = yield* sql<{ schema_version: number }>`PRAGMA schema_version`;
        const [journal] = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`;
        return { schemaVersion: schema!.schema_version, journalMode: journal!.journal_mode };
      });
      const inspect = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ledger = yield* sql<{
          migration_id: number;
          name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        const rowids = yield* sql<{
          rowid: number;
          message_id: string;
        }>`SELECT rowid, message_id FROM orchestration_v2_projection_messages ORDER BY rowid`;
        const [version] = yield* sql<{ user_version: number }>`PRAGMA user_version`;
        const [application] = yield* sql<{ application_id: number }>`PRAGMA application_id`;
        const search = yield* Effect.flatMap(ThreadSearch.ThreadSearch, (service) =>
          service.search({ query: "needle" }),
        ).pipe(Effect.provide(ThreadSearch.layer));
        return {
          ledger: ledger.map((row) => [row.migration_id, row.name] as const),
          rowids: rowids.map((row) => [row.rowid, row.message_id]),
          userVersion: version?.user_version,
          applicationId: application?.application_id,
          search,
          database: yield* databaseSnapshot,
        };
      });
      const before = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* oldBuild.runMigrations({ toMigrationInclusive: head });
        yield* sql`PRAGMA user_version = 712`;
        yield* sql`PRAGMA application_id = 132`;
        yield* sql`CREATE TABLE unindexed_restore_probe (value TEXT)`;
        yield* sql`INSERT INTO unindexed_restore_probe(rowid, value) VALUES (1, 'one'), (3, 'three'), (5, 'five')`;
        yield* sql`CREATE TABLE sequence_restore_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)`;
        yield* sql`INSERT INTO sequence_restore_probe(id, value) VALUES (1, 'one'), (9, 'deleted')`;
        yield* sql`DELETE FROM sequence_restore_probe WHERE id = 9`;
        yield* sql`CREATE TABLE primary_key_restore_probe (a TEXT, b INTEGER, value TEXT, PRIMARY KEY(a, b)) WITHOUT ROWID`;
        yield* sql`INSERT INTO primary_key_restore_probe VALUES ('b', 2, 'two'), ('a', 1, 'one')`;
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('p', 'Project', '/scratch', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('t', 'p', 'Thread', 'codex', 'full-access', 'default', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '{}')`;
        for (const id of [1, 2, 3, 4, 5]) {
          yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES (${String(id)}, 't', 'user', 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', ${JSON.stringify({ text: `needle ${id}` })})`;
        }
        yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id IN ('2', '4')`;
        return yield* inspect;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      assert.deepStrictEqual(before.rowids, [
        [1, "1"],
        [3, "3"],
        [5, "5"],
      ]);
      assert.strictEqual(before.search.matches[0]?.hits, 3);
      const original = path.join(path.dirname(dbPath), "original.sqlite");
      yield* fs.copyFile(dbPath, original);
      const originalMetadata = yield* backupMetadata.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: original })),
      );
      assert.strictEqual(originalMetadata.journalMode, "wal");
      messages.length = 0;
      yield* ownT3Home();
      const startedBefore = workerData.length;
      yield* Effect.gen(function* () {
        const after = yield* inspect;
        assert.deepStrictEqual(after.ledger, migrationManifest);
        assert.deepStrictEqual(after.search, before.search);
        assert.deepStrictEqual(after.rowids, before.rowids);
      }).pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath)));
      assert.include(messages, DATABASE_MIGRATIONS_STARTED_MESSAGE);
      assert.include(messages, DATABASE_MIGRATIONS_FINISHED_MESSAGE);
      assert.deepInclude(workerData.slice(startedBefore), {
        filename: dbPath,
        readOnly: false,
        requireWal: false,
        allowExtension: false,
        prepareCacheSize: 200,
      });
      assert.deepInclude(workerData.slice(startedBefore), {
        filename: dbPath,
        readOnly: true,
        requireWal: true,
        allowExtension: false,
        prepareCacheSize: 200,
      });
      const backups = (yield* fs.readDirectory(path.dirname(dbPath))).filter((name) =>
        name.startsWith(`${path.basename(dbPath)}.before-factory-migration-band-`),
      );
      assert.lengthOf(backups, 1);
      const backup = path.join(path.dirname(dbPath), backups[0]!);
      assert.isTrue((yield* fs.stat(backup)).type === "File");
      assert.lengthOf(
        messages.filter((message) => message.includes(backup) && message.includes("older builds")),
        1,
      );
      const restored = path.join(path.dirname(dbPath), "restored.sqlite");
      yield* fs.copyFile(backup, restored);
      for (const suffix of ["-wal", "-shm"])
        yield* fs.remove(`${restored}${suffix}`, { force: true });
      const restoredBefore = yield* inspect.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: restored })),
      );
      assert.deepStrictEqual(restoredBefore, before);
      const restoredMetadata = yield* backupMetadata.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: restored })),
      );
      assert.deepStrictEqual(restoredMetadata, {
        schemaVersion: originalMetadata.schemaVersion + 1,
        journalMode: "delete",
      });
      const originalAfter = yield* Effect.gen(function* () {
        yield* oldBuild.runMigrations();
        return yield* inspect;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: original })));
      const restoredAfter = yield* Effect.gen(function* () {
        yield* oldBuild.runMigrations();
        return yield* inspect;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: restored })));
      assert.deepStrictEqual(restoredAfter, originalAfter);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`PRAGMA journal_mode`, [{ journal_mode: "wal" }]);
        const after = yield* inspect;
        assert.deepStrictEqual(after.search, before.search);
      }).pipe(Effect.provide(SqlitePersistence.layerFromPath(restored)));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerT3Home.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              Logger.layer([logger], { mergeWithExisting: false }),
            ),
          ),
        ),
      ),
    );
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("layerCliConfig", (it) => {
  it.effect.each([false, true])(
    "does not migrate a T3 home a running server owns (unconverted: %s)",
    (unconverted) =>
      Effect.gen(function* () {
        const recorded = unconverted ? 213 : Math.max(...migrationManifest.map(([id]) => id)) - 1;
        if (unconverted) {
          const { dbPath } = yield* ServerConfig.ServerConfig;
          yield* oldBuild
            .runMigrations()
            .pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        } else {
          yield* migrateTo(recorded);
        }
        yield* ownT3Home();

        const opened = yield* Effect.void.pipe(
          Effect.provide(SqlitePersistence.layerCliConfig),
          Effect.result,
        );

        assert.equal(yield* latestRecordedMigrationId, recorded);
        assert.equal(opened._tag, "Failure");
        if (opened._tag === "Failure") {
          assert.instanceOf(opened.failure, SqlitePersistence.ServerOwnsDatabaseError);
        }
      }).pipe(Effect.scoped, Effect.provide(layerT3Home)),
  );

  it.effect("opens a current T3 home while a running server owns it", () =>
    Effect.gen(function* () {
      yield* migrateTo();
      yield* ownT3Home();

      yield* Effect.void.pipe(Effect.provide(SqlitePersistence.layerCliConfig));
    }).pipe(Effect.scoped, Effect.provide(layerT3Home)),
  );
});
