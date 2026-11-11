import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makePosixOwnedProcess, PosixCgroupController } from "./PosixOwnedProcess.ts";
import { ownedWriterPlatformRefusal, makeOwnedProcess } from "./OwnedProcess.ts";

const fixture = (
  mode: "empty" | "populated" | "unreadable" | "missing" = "empty",
  exit: "code" | "signal" = "code",
) => {
  const operations: string[] = [];
  const lease = {
    path: "/delegated/task",
    relativePath: "/task",
    contains: () => true,
    exists: () => mode !== "missing",
    kill: () => {
      operations.push("kill");
      if (mode === "missing") throw new Error("missing");
    },
    populated: () => {
      operations.push("observe");
      if (mode === "unreadable") throw new Error("denied");
      return mode === "populated";
    },
    remove: () => {
      operations.push("remove");
    },
  };
  const commands: ChildProcess.Command[] = [];
  const gates: string[] = [];
  const native = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      commands.push(command);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(100),
        // Node fails exitCode for a signal exit; the finished handle still reports it.
        exitCode:
          exit === "code"
            ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
            : Effect.fail(
                PlatformError.systemError({
                  module: "ChildProcess",
                  method: "exitCode",
                  _tag: "Unknown",
                  cause: new Error("Process interrupted due to receipt of signal: 'SIGKILL'"),
                }),
              ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () =>
          Sink.forEach((bytes: Uint8Array) =>
            Effect.sync(() => {
              gates.push(new TextDecoder().decode(bytes));
            }),
          ),
        getOutputFd: () => Stream.make(new TextEncoder().encode("contained\n")),
      });
    }),
  );
  return { operations, lease, commands, gates, native };
};

it.effect.each([
  { shell: false, exit: "code" },
  { shell: true, exit: "code" },
  { shell: false, exit: "signal" },
] as const)(
  "contains before exec, observes empty independently of root exit, and seals new spawns (shell $shell, exit $exit)",
  ({ shell, exit }) =>
    Effect.gen(function* () {
      const fake = fixture("empty", exit);
      const owner = yield* makePosixOwnedProcess().pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(PosixCgroupController, { create: () => fake.lease }),
      );
      const source = 'printf "%s" "$TOKEN" | cat';
      yield* owner.spawner.spawn(
        shell
          ? ChildProcess.make(source, [], { shell: process.execPath })
          : ChildProcess.make(process.execPath, ["argument"]),
        fake.native,
      );
      const command = fake.commands[0];
      assert.equal(command?._tag, "StandardCommand");
      if (command?._tag !== "StandardCommand") return;
      assert.isTrue(command.options.detached);
      assert.include(command.args.join(" "), "cgroup.procs");
      if (shell) assert.deepEqual(command.args.slice(-2), ["-c", source]);
      assert.deepEqual(fake.gates, ["resume\n"]);
      yield* owner.awaitRootExits;
      assert.deepEqual(fake.operations, []);
      assert.isTrue(yield* owner.quiesce());
      assert.deepEqual(fake.operations, ["kill", "observe", "remove"]);
      assert.equal(
        (yield* owner.spawner.spawn(ChildProcess.make("/late"), fake.native).pipe(Effect.flip))
          ._tag,
        "PlatformError",
      );
      assert.equal(fake.commands.length, 1);
    }).pipe(Effect.scoped),
);

it.effect("sends stop when sealing races an in-flight root acquisition", () =>
  Effect.gen(function* () {
    const fake = fixture();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const native = ChildProcessSpawner.make((command) =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(fake.native.spawn(command)),
      ),
    );
    const owner = yield* makeOwnedProcess().pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(PosixCgroupController, { create: () => fake.lease }),
    );
    const acquiring = yield* owner.spawner
      .spawn(ChildProcess.make(process.execPath), native)
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    assert.isFalse(yield* owner.quiesce());
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(acquiring);
    assert.deepEqual(fake.gates, ["stop\n"]);
    assert.isTrue(yield* owner.quiesce());
  }).pipe(Effect.scoped),
);

it.effect("closing one root scope leaves the attempt open for its next command", () =>
  Effect.gen(function* () {
    const fake = fixture();
    const owner = yield* makePosixOwnedProcess().pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(PosixCgroupController, { create: () => fake.lease }),
    );
    const scope = yield* Scope.make();
    yield* owner.spawner
      .spawn(ChildProcess.make(process.execPath), fake.native)
      .pipe(Effect.provideService(Scope.Scope, scope));
    yield* Scope.close(scope, yield* Effect.exit(Effect.void));
    yield* owner.spawner.spawn(ChildProcess.make(process.execPath), fake.native);
    assert.equal(fake.commands.length, 2);
    assert.isTrue(yield* owner.quiesce());
  }).pipe(Effect.scoped),
);

it.effect.each(["unreadable", "missing"] as const)(
  "keeps %s container observations unknown",
  (mode) =>
    Effect.gen(function* () {
      const fake = fixture(mode);
      const owner = yield* makePosixOwnedProcess().pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(PosixCgroupController, { create: () => fake.lease }),
      );
      yield* owner.spawner.spawn(ChildProcess.make(process.execPath), fake.native);
      yield* owner.awaitRootExits;
      assert.isFalse(yield* owner.quiesce());
      assert.notInclude(fake.operations, "remove");
    }).pipe(Effect.scoped),
);

it.effect(
  "refuses platforms without containment and Linux without delegation before spawning",
  () =>
    Effect.gen(function* () {
      for (const platform of ["darwin", "linux"] as const) {
        const fake = fixture();
        const owner = yield* makePosixOwnedProcess().pipe(
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(PosixCgroupController, { create: () => undefined }),
        );
        assert.equal(
          (yield* owner.spawner
            .spawn(ChildProcess.make(process.execPath), fake.native)
            .pipe(Effect.flip))._tag,
          "PlatformError",
        );
        assert.equal(fake.commands.length, 0);
        assert.isString(
          yield* ownedWriterPlatformRefusal().pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(PosixCgroupController, { create: () => undefined }),
          ),
        );
      }
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin"), Effect.scoped),
);

it.live("joins a Linux root and its detached writer through the cgroup", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "linux") return;
    if ((yield* ownedWriterPlatformRefusal()) !== undefined) return;
    const owner = yield* makePosixOwnedProcess();
    const native = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ready = yield* Deferred.make<void>();
    const script = `require('node:child_process').spawn(process.execPath,['-e',"console.log('writer-ready');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','inherit','inherit']}).unref()`;
    const child = yield* owner.spawner.spawn(
      ChildProcess.make(process.execPath, ["-e", script]),
      native,
    );
    const output = yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.runForEach((text) =>
        text.includes("writer-ready") ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    yield* owner.awaitRootExits;
    assert.isTrue(yield* owner.quiesce());
    yield* Fiber.join(output);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("never resumes a root whose container handshake is missing", () =>
  Effect.gen(function* () {
    const fake = fixture();
    const native = ChildProcessSpawner.make((command) =>
      fake.native
        .spawn(command)
        .pipe(Effect.map((handle) => ({ ...handle, getOutputFd: () => Stream.empty }))),
    );
    const owner = yield* makePosixOwnedProcess().pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(PosixCgroupController, { create: () => fake.lease }),
    );
    assert.equal(
      (yield* owner.spawner.spawn(ChildProcess.make(process.execPath), native).pipe(Effect.flip))
        ._tag,
      "PlatformError",
    );
    assert.deepEqual(fake.gates, []);
    assert.isFalse(yield* owner.quiesce());
  }).pipe(Effect.scoped),
);
