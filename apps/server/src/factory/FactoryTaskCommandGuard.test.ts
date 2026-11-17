import { assert, it } from "@effect/vitest";
import { AuthSessionId, CommandId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as CommandGuard from "./FactoryTaskCommandGuard.ts";

const layer = CommandGuard.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const id = CommandId.make("shared");

/** Holds `id` until the returned deferred is completed. */
const held = Effect.fn("test.held")(function* <A, E>(after: Effect.Effect<A, E>) {
  const guard = yield* CommandGuard.FactoryTaskCommandGuard;
  const holding = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const holder = yield* Effect.forkChild(
    guard.run(
      id,
      Deferred.succeed(holding, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(after),
      ),
    ),
  );
  yield* Deferred.await(holding);
  return { holder, release };
});

it.effect.each(["interrupted while it waits", "behind a holder that dies"] as const)(
  "an execution %s leaves nothing behind for the next one",
  (ending) =>
    Effect.gen(function* () {
      const guard = yield* CommandGuard.FactoryTaskCommandGuard;
      const { holder, release } = yield* held(
        ending === "behind a holder that dies" ? Effect.die("the holder broke") : Effect.void,
      );
      // Started at once, so it is waiting for the permit when the fork returns.
      const waiter = yield* Effect.forkChild(guard.run(id, Effect.succeed("waited")), {
        startImmediately: true,
      });
      if (ending === "interrupted while it waits") {
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(release, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(holder)));
      } else {
        yield* Deferred.succeed(release, undefined);
        assert.isTrue(Exit.hasDies(yield* Fiber.await(holder)));
        assert.equal(yield* Fiber.join(waiter), "waited");
      }
      assert.equal(yield* guard.pending, 0);
      assert.equal(yield* guard.run(id, Effect.succeed("next")), "next");
      assert.equal(yield* guard.pending, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("waits for an id only outside any transaction and any other execution", () =>
  Effect.gen(function* () {
    const guard = yield* CommandGuard.FactoryTaskCommandGuard;
    const sql = yield* SqlClient.SqlClient;
    const human = { kind: "human", sessionId: AuthSessionId.make("person") } as const;
    assert.isTrue(
      Exit.hasDies(yield* Effect.exit(sql.withTransaction(guard.run(id, Effect.void)))),
    );
    assert.isTrue(
      Exit.hasDies(
        yield* Effect.exit(guard.run(id, guard.run(CommandId.make("other"), Effect.void))),
      ),
    );
    assert.isTrue(Exit.hasDies(yield* Effect.exit(guard.begin("update", id, human, {}))));
    // Held first, then the transaction: a command nested under the same id is already in.
    const nested = guard.run(
      id,
      Effect.gen(function* () {
        const command = yield* guard.begin("update", id, human, {});
        return command.replayed;
      }),
    );
    assert.isFalse(yield* guard.run(id, sql.withTransaction(nested)));
    assert.equal(yield* guard.pending, 0);
  }).pipe(Effect.provide(layer)),
);
