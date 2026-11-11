import type { OwnedProcessSpawner } from "@t3tools/shared/ownedProcess";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { awaitConfirmedExit } from "@t3tools/shared/ownedProcess";
import { wrapCommandForLinuxCgroup } from "@t3tools/provider-acp/server/AcpSessionRuntime";
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
  const probe = yield* Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* Effect.try(() => controller.create());
      if (lease === undefined) return false;
      yield* Effect.addFinalizer(() =>
        Effect.try(() => {
          lease.kill();
          if (!lease.populated()) lease.remove();
        }).pipe(Effect.ignore),
      );
      if (yield* Effect.try(() => lease.populated())) return false;
      const native = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
      if (Option.isNone(native)) return false;
      const wrapped = wrapCommandForLinuxCgroup(lease, "/bin/sh", ["-c", "printf 'contained\\n'"]);
      const child = yield* native.value.spawn(ChildProcess.make(wrapped.command, wrapped.args));
      const line = yield* child.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runHead);
      const code = yield* awaitConfirmedExit(child);
      return (
        Option.isSome(line) &&
        line.value === "contained" &&
        Option.isSome(code) &&
        Number(code.value) === 0
      );
    }).pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.map((result) => Option.getOrElse(result, () => false)),
      Effect.orElseSucceed(() => false),
    ),
  );
  return probe
    ? undefined
    : "Task runs require a writable delegated cgroup v2 with cgroup.kill on this Linux machine.";
});

export const makeOwnedProcess = Effect.fn("OwnedProcess.make")(function* () {
  return (yield* HostProcess.Platform) === "win32"
    ? yield* makeWindowsOwnedProcess()
    : yield* makePosixOwnedProcess();
});
