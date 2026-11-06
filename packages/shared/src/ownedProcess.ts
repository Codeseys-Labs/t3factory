import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import type * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export interface OwnedProcessSpawner {
  readonly spawn: (
    command: ChildProcess.Command,
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError, Scope.Scope>;
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
