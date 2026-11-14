import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as CommandLine from "effect/process/CommandLine";

// Owned spawners build the real command line themselves, so they reveal what Effect redacts.
export const revealCommandWord = (word: CommandLine.Word): string =>
  Redacted.isRedacted(word) ? Redacted.value(word) : word;

// A string built from several words stays redacted when any of them was.
export const redactIfAnyRedacted = (
  words: ReadonlyArray<CommandLine.Word>,
  value: string,
): CommandLine.Word => (words.some(Redacted.isRedacted) ? Redacted.make(value) : value);

export interface OwnedProcessSpawner {
  readonly spawn: (
    command: ChildProcess.Command,
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  ) => Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError,
    Scope.Scope
  >;
}

// Effect 4 Reference is a function: one call, unlike the Service class constructor.
export class OwnedProcess extends Context.Reference<OwnedProcessSpawner | undefined>(
  "t3/OwnedProcess",
  { defaultValue: (): OwnedProcessSpawner | undefined => undefined },
) {}

export const spawnOwnedProcess = Effect.fn("OwnedProcess.spawn")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.Command,
) {
  const owner = yield* OwnedProcess;
  return yield* owner === undefined ? spawner.spawn(command) : owner.spawn(command, spawner);
});

// Effect fails exitCode for a signal exit; a handle that stopped running still confirms it.
// None means the process ended by signal.
export const awaitConfirmedExit = Effect.fn("OwnedProcess.awaitConfirmedExit")(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
) {
  return yield* handle.exitCode.pipe(
    Effect.asSome,
    Effect.catch((error) =>
      Effect.flatMap(handle.isRunning, (running) =>
        running ? Effect.fail(error) : Effect.succeedNone,
      ),
    ),
  );
});
