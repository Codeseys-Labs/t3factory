import type { OwnedProcessSpawner } from "@t3tools/shared/ownedProcess";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import { PosixCgroupController, makePosixOwnedProcess } from "./PosixOwnedProcess.ts";
import { makeWindowsOwnedProcess } from "./WindowsOwnedProcess.ts";

export interface OwnedProcessGroup {
  readonly spawner: OwnedProcessSpawner;
  readonly quiesce: () => Effect.Effect<boolean, PlatformError.PlatformError>;
  readonly awaitRootExits: Effect.Effect<void, PlatformError.PlatformError>;
}

export const ownedWriterPlatformRefusal = Effect.fn("OwnedProcess.platformRefusal")(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return undefined;
  if (platform !== "linux") {
    return "This machine cannot prove that detached agent processes have stopped; task runs require Windows Job Objects or a delegated Linux cgroup v2.";
  }
  const controller = yield* PosixCgroupController;
  const probe = yield* Effect.try(() => {
    const lease = controller.create();
    if (lease === undefined) return false;
    if (lease.populated()) return false;
    lease.remove();
    return true;
  }).pipe(Effect.orElseSucceed(() => false));
  return probe
    ? undefined
    : "Task runs require a writable delegated cgroup v2 with cgroup.kill on this Linux machine.";
});

export const makeOwnedProcess = Effect.fn("OwnedProcess.make")(function* () {
  return (yield* HostProcess.Platform) === "win32"
    ? yield* makeWindowsOwnedProcess()
    : yield* makePosixOwnedProcess();
});
