import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  makeLinuxCgroupController,
  resolveLinuxCgroupTargetCommand,
  wrapCommandForLinuxCgroup,
  type AcpLinuxCgroupController,
  type AcpLinuxCgroupLease,
} from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { OwnedProcessGroup } from "./OwnedProcess.ts";

export const PosixCgroupController = Context.Reference<AcpLinuxCgroupController>(
  "t3/process/PosixCgroupController",
  { defaultValue: makeLinuxCgroupController },
);

const ownershipError = (cause: unknown) =>
  PlatformError.systemError({
    module: "ChildProcess",
    method: "spawnOwned",
    _tag: "Unknown",
    cause,
  });

export const makePosixOwnedProcess = Effect.fn("PosixOwnedProcess.make")(
  function* (): Effect.fn.Return<OwnedProcessGroup> {
    const controller = yield* PosixCgroupController;
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const cwd = yield* HostProcess.WorkingDirectory;
    const jobs: Array<{
      lease: AcpLinuxCgroupLease;
      exit?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
      empty: boolean;
      contained: boolean;
    }> = [];
    let sealed = false;
    let pending = 0;
    let unknown = false;
    const stopJob = Effect.fn("PosixOwnedProcess.stopJob")(function* (job: (typeof jobs)[number]) {
      if (job.empty) return true;
      // Disappearance is not an empty observation. Read the kernel counter after cgroup.kill.
      let empty = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const observed = yield* Effect.try(() => {
          job.lease.kill();
          return !job.lease.populated();
        }).pipe(Effect.exit);
        if (Exit.isFailure(observed)) return false;
        if (observed.value) {
          empty = true;
          break;
        }
        yield* Effect.sleep("10 millis");
      }
      if (!empty || !job.contained || job.exit === undefined) return false;
      if (Exit.isFailure(yield* Effect.exit(job.exit))) return false;
      const removed = yield* Effect.try(() => job.lease.remove()).pipe(Effect.exit);
      if (Exit.isFailure(removed)) return false;
      job.empty = true;
      return true;
    });
    const quiesce = Effect.fn("PosixOwnedProcess.quiesce")(function* () {
      sealed = true;
      let quiet = pending === 0 && !unknown;
      for (const job of jobs) if (!(yield* stopJob(job))) quiet = false;
      return quiet;
    });
    return {
      spawner: {
        spawn: Effect.fn("PosixOwnedProcess.spawn")(function* (command, native) {
          if (platform !== "linux" || sealed || command._tag !== "StandardCommand") {
            return yield* ownershipError("Owned process containment is unavailable or stopped.");
          }
          pending++;
          return yield* Effect.uninterruptibleMask(() =>
            Effect.gen(function* () {
              const commandEnvironment =
                command.options.extendEnv === false
                  ? { ...command.options.env }
                  : { ...environment, ...command.options.env };
              const invocation = command.options.shell
                ? {
                    command:
                      typeof command.options.shell === "string" ? command.options.shell : "/bin/sh",
                    args: ["-c", [command.command, ...command.args].join(" ")],
                  }
                : command;
              const target = resolveLinuxCgroupTargetCommand(
                invocation.command,
                command.options.cwd ?? cwd,
                commandEnvironment,
              );
              if (target === undefined)
                return yield* ownershipError("Contained executable could not be resolved.");
              const lease = yield* Effect.try({
                try: () => controller.create(),
                catch: ownershipError,
              });
              if (lease === undefined)
                return yield* ownershipError("Linux cgroup v2 delegation is required.");
              const job: (typeof jobs)[number] = { lease, empty: false, contained: false };
              jobs.push(job);
              yield* Effect.addFinalizer(() => stopJob(job).pipe(Effect.asVoid));
              let gateFd = 3;
              while (command.options.additionalFds?.[`fd${gateFd}`] !== undefined) gateFd++;
              let readyFd = gateFd + 1;
              while (command.options.additionalFds?.[`fd${readyFd}`] !== undefined) readyFd++;
              const wrapped = wrapCommandForLinuxCgroup(lease, target, invocation.args, {
                preserveEnvironment: true,
                beforeExec: [
                  `printf 'contained\\n' >&${readyFd} || exit 125`,
                  `exec ${readyFd}>&-`,
                  `IFS= read -r action <&${gateFd} || exit 125`,
                  '[ "$action" = resume ] || exit 125',
                  `exec ${gateFd}<&-`,
                ],
              });
              const acquired = yield* Effect.exit(
                native.spawn(
                  ChildProcess.make(wrapped.command, wrapped.args, {
                    ...command.options,
                    shell: false,
                    detached: true,
                    additionalFds: {
                      ...command.options.additionalFds,
                      [`fd${gateFd}`]: { type: "input" },
                      [`fd${readyFd}`]: { type: "output" },
                    },
                  }),
                ),
              );
              if (Exit.isFailure(acquired)) {
                unknown = true;
                return yield* Effect.failCause(acquired.cause);
              }
              job.exit = acquired.value.exitCode;
              const contained = acquired.value.getOutputFd(readyFd).pipe(
                Stream.decodeText,
                Stream.splitLines,
                Stream.runHead,
                Effect.flatMap((line) =>
                  Option.isSome(line) && line.value === "contained"
                    ? Effect.void
                    : Effect.fail(ownershipError("Container membership was not observed.")),
                ),
              );
              yield* Effect.raceFirst(
                contained,
                job.exit.pipe(
                  Effect.andThen(
                    Effect.fail(
                      ownershipError("Root exited before container membership was observed."),
                    ),
                  ),
                ),
              );
              job.contained = true;
              yield* Stream.make(new TextEncoder().encode(sealed ? "stop\n" : "resume\n")).pipe(
                Stream.run(acquired.value.getInputFd(gateFd)),
              );
              return {
                ...acquired.value,
                kill: () =>
                  Effect.try({ try: () => lease.kill(), catch: ownershipError }).pipe(
                    Effect.andThen(acquired.value.exitCode),
                    Effect.asVoid,
                  ),
              };
            }),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                pending--;
              }),
            ),
          );
        }),
      },
      quiesce,
      awaitRootExits: Effect.suspend(() =>
        Effect.forEach(
          jobs,
          (job) => job.exit ?? Effect.fail(ownershipError("Root acquisition was not observed.")),
        ).pipe(Effect.asVoid),
      ),
    };
  },
);
