import type { RunAttemptId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as FactoryDeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import * as FactoryExecutionStore from "../persistence/FactoryExecutionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as FactoryDeliveryService from "./FactoryDeliveryService.ts";
import * as FactoryExecutionLifecycle from "./FactoryExecutionLifecycle.ts";

// The issue source's poll rate. Both states otherwise wait on a person indefinitely, and a full
// page of forge lookups every five minutes stays far inside API rate limits.
const INTERVAL = Duration.minutes(5);
const PER_TICK = 20;

// A full page resumes after its last key next tick, so a backlog larger than one page rotates.
const resumeAfter = <A, K>(page: ReadonlyArray<A>, key: (item: A) => K) =>
  page.length < PER_TICK ? null : key(page[page.length - 1]!);

const contained =
  (message: string, annotations?: { readonly [key: string]: string }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning(message, { ...annotations, cause }),
      ),
    );

const make = Effect.gen(function* () {
  const executionStore = yield* FactoryExecutionStore.FactoryExecutionStore;
  const lifecycle = yield* FactoryExecutionLifecycle.FactoryExecutionLifecycle;
  const deliveryStore = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const delivery = yield* FactoryDeliveryService.FactoryDeliveryService;
  let attemptCursor: RunAttemptId | null = null;
  let deliveryCursor: string | null = null;

  // Settles on durable proof or this server's own joined, quiet claims; never on a missing owner.
  const reconcileHeldAttempts = Effect.fn("FactoryWatchdog.reconcileHeldAttempts")(function* () {
    const held = yield* executionStore.listHeldAttempts({ after: attemptCursor, limit: PER_TICK });
    attemptCursor = resumeAfter(held, (attempt) => attempt.runAttemptId);
    for (const attempt of held)
      yield* lifecycle.retryHeld(attempt).pipe(
        contained("Factory watchdog could not reconcile a held attempt", {
          runAttemptId: attempt.runAttemptId,
        }),
      );
  });

  // The Check action's call: it reads the remote and settles, and never sends.
  const recheckUnconfirmedDeliveries = Effect.fn("FactoryWatchdog.recheckUnconfirmedDeliveries")(
    function* () {
      const unconfirmed = yield* deliveryStore.listUnconfirmed({
        after: deliveryCursor,
        limit: PER_TICK,
      });
      deliveryCursor = resumeAfter(unconfirmed, (intent) => intent.id);
      for (const intent of unconfirmed)
        yield* delivery
          .reconcile({ projectId: intent.projectId, intentId: intent.id })
          .pipe(
            contained("Factory watchdog could not re-check a delivery", { deliveryId: intent.id }),
          );
    },
  );

  const tick = Effect.fn("FactoryWatchdog.tick")(function* () {
    yield* reconcileHeldAttempts().pipe(contained("Factory watchdog could not list held attempts"));
    yield* recheckUnconfirmedDeliveries().pipe(
      contained("Factory watchdog could not list unconfirmed deliveries"),
    );
  });

  // Spaced, not fixed: the next tick starts only after this one ends, so ticks never overlap.
  yield* forkParked(tick().pipe(Effect.repeat(Schedule.spaced(INTERVAL))));
});

export const layer = Layer.effectDiscard(make);
