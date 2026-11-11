import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";

const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

class CommitCallbacks extends Context.Service<CommitCallbacks, Array<Effect.Effect<void>>>()(
  "t3/persistence/Sqlite/CommitCallbacks",
) {}

export const afterCommit = Effect.fn("Sqlite.afterCommit")(function* (effect: Effect.Effect<void>) {
  const callbacks = yield* Effect.serviceOption(CommitCallbacks);
  if (Option.isSome(callbacks)) callbacks.value.push(effect);
  else yield* effect;
});

const layerTransactions = Layer.effect(
  SqlClient.SqlClient,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const withTransaction = sql.withTransaction;
    // Keep publication ordered with commits, including transactions opened outside the event sink.
    // Read-only transactions write nothing to publish and must not queue behind writers.
    const commits = yield* Semaphore.make(1);
    const ordered = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const parent = yield* Effect.serviceOption(CommitCallbacks);
          const callbacks: Array<Effect.Effect<void>> = [];
          const transaction = withTransaction(
            restore(effect).pipe(Effect.provideService(CommitCallbacks, callbacks)),
          ).pipe(
            Effect.tap(() =>
              Option.isSome(parent)
                ? Effect.sync(() => {
                    parent.value.push(...callbacks);
                  })
                : Effect.forEach(callbacks, (callback) => callback, { discard: true }),
            ),
          );
          if (Option.isSome(parent)) return yield* transaction;
          yield* restore(commits.take(1));
          return yield* transaction.pipe(Effect.ensuring(commits.release(1)));
        }),
      );
    return Object.assign(sql, {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.flatMap(NodeSqliteClient.isReadOnly, (readOnly) =>
          readOnly ? withTransaction(effect) : ordered(effect),
        ),
    });
  }),
);

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    // Existing databases need doctor's offline VACUUM to add pointer maps for this mode.
    const tables = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
    if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // FULL fsyncs every event commit on the main thread; NORMAL syncs only at WAL checkpoints.
    // App crashes lose nothing; OS crashes or power loss can roll back post-checkpoint commits without corruption.
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // macOS fsync misses drive caches; F_FULLFSYNC flushes them at checkpoints and is ignored elsewhere.
    yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
    // Keep statement journals and sort spills off the main thread's disk path.
    // Large statements and open savepoints can increase peak memory use.
    yield* sql`PRAGMA temp_store = MEMORY;`;
    // PASSIVE checkpoints retain peak WAL size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* runMigrations();
    // Collecting stats scans every page, and stale small-table stats cause scans after growth; use indexes by default.
    // Connections cache stats; reload after deleting them.
    const statTables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'`;
    if (statTables.length > 0) {
      yield* sql`DELETE FROM sqlite_stat1;`;
      yield* sql`ANALYZE sqlite_schema;`;
    }
  }),
);

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    layerSetup,
    layerTransactions.pipe(
      Layer.provide(
        NodeSqliteClient.layer({
          filename: dbPath,
          readerWorker: true,
          // Run checkpoint fsyncs off the event loop so slow disk flushes cannot stall clients.
          checkpointWorker: true,
          spanAttributes: {
            "db.name": path.basename(dbPath),
            "service.name": "t3code-server",
          },
        }),
      ),
    ),
  );
}, Layer.unwrap);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  layerTransactions.pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);
