import type { FactoryTaskChange, FactoryTaskError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Tasks from "../persistence/FactoryTaskStore.ts";

const MAX_ROOTS = 64;

/**
 * The one feed of task changes. A notice is written in the transaction that made the change and
 * delivered by a fiber that takes the write lock afterwards, so it is never heard before the
 * outermost transaction commits and never heard at all when that transaction rolls back.
 */
export class FactoryTaskChanges extends Context.Service<
  FactoryTaskChanges,
  {
    readonly announce: (change: {
      readonly rootIds: ReadonlyArray<string>;
      readonly profiles?: boolean;
    }) => Effect.Effect<void, FactoryTaskError>;
    /** Delivers notices another writer queued, such as the plan store on a plan revision. */
    readonly flush: Effect.Effect<void>;
    readonly stream: Stream.Stream<FactoryTaskChange>;
    /** Subscribes now, so a change made before the first take is kept. */
    readonly subscribe: Effect.Effect<PubSub.Subscription<FactoryTaskChange>, never, Scope.Scope>;
  }
>()("t3/factory/FactoryTaskChanges") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Tasks.FactoryTaskStore;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const hub = yield* PubSub.unbounded<FactoryTaskChange>();
  const wake = yield* Queue.sliding<void>(1);
  const flush = Queue.offer(wake, undefined).pipe(Effect.asVoid);

  const deliver = Effect.gen(function* () {
    // Waits behind any open transaction, then sees only what committed.
    const { rootIds, profiles } = yield* sql.withTransaction(store.takeAnnouncements);
    if (rootIds.length === 0 && profiles)
      yield* PubSub.publish(hub, { environmentId, rootIds: [], profiles });
    for (let index = 0; index < rootIds.length; index += MAX_ROOTS)
      yield* PubSub.publish(hub, {
        environmentId,
        rootIds: rootIds.slice(index, index + MAX_ROOTS),
        profiles,
      });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Task change notices could not be delivered").pipe(
        Effect.annotateLogs({ cause }),
      ),
    ),
    Effect.withSpan("FactoryTaskChanges.deliver"),
  );
  yield* Queue.take(wake).pipe(Effect.andThen(deliver), Effect.forever, Effect.forkScoped);
  // Notices a previous process committed and never delivered have no listener left.
  yield* flush;

  return FactoryTaskChanges.of({
    announce: Effect.fn("FactoryTaskChanges.announce")(function* (change) {
      yield* store.announce(change);
      yield* flush;
    }),
    flush,
    stream: Stream.fromPubSub(hub),
    subscribe: PubSub.subscribe(hub),
  });
});

export const layer = Layer.effect(FactoryTaskChanges, make).pipe(Layer.provide(Tasks.layer));
