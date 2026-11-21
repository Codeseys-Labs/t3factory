import * as Effect from "effect/Effect";
import type { AsyncResult } from "effect/reactivity";

type Settled = AsyncResult.Success<unknown, Error> | AsyncResult.Failure<unknown, Error>;

/**
 * A mocked command's reply, shaped as the Effect an `AtomCommand.run` returns: a settled
 * success yields its value and a settled failure fails with its cause once the Effect runs.
 */
export function commandEffect(reply: PromiseLike<unknown>): Effect.Effect<unknown, Error> {
  return Effect.promise(() => reply).pipe(
    Effect.flatMap((result) => {
      const settled = result as Settled;
      return settled._tag === "Success"
        ? Effect.succeed(settled.value)
        : Effect.failCause(settled.cause);
    }),
  );
}
