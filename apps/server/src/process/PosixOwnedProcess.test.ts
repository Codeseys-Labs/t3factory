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
  mode: "empty" | "populated" | "unreadable" | "missing" | "unkillable" = "empty",
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
      if (mode === "missing" || mode === "unkillable") throw new Error(mode);
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
    Effect.gen(function* () {
      commands.push(command);
      // Node's release signals the root and then waits for it without a bound.
      yield* Effect.addFinalizer(() => Effect.sync(() => operations.push("release")));
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
      // The wrapper must not load the command's environment before it joins the cgroup.
      const options = {
        extendEnv: false,
        env: { LD_PRELOAD: "/workspace/escape.so", TOKEN: "a'b\nc", "NOT-A-NAME": "x" },
      };
      yield* owner.spawner.spawn(
        shell
          ? ChildProcess.make(source, [], { ...options, shell: process.execPath })
          : ChildProcess.make(process.execPath, ["argument"], options),
        fake.native,
      );
      const command = fake.commands[0];
      assert.equal(command?._tag, "StandardCommand");
      if (command?._tag !== "StandardCommand") return;
      assert.isTrue(command.options.detached);
      assert.isFalse(command.options.extendEnv);
      assert.deepEqual(command.options.env, {});
      assert.include(command.args.join(" "), "cgroup.procs");
      assert.notInclude(command.args.join(" "), "escape.so");
      if (shell) assert.deepEqual(command.args.slice(-2), ["-c", source]);
      assert.deepEqual(fake.gates, [
        `resume\nLD_PRELOAD='/workspace/escape.so'\nTOKEN='a'\\''b'"$nl"'c'\n\n`,
      ]);
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
    assert.deepEqual(fake.operations, ["kill", "observe", "remove", "release"]);
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
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.native),
          ),
        );
      }
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin"), Effect.scoped),
);

it.effect.each(["migrated", "denied", "unconfirmed", "unkillable"] as const)(
  "admits Linux only after a contained migration probe: %s",
  (migration) =>
    Effect.gen(function* () {
      const fake = fixture(migration === "unkillable" ? "unkillable" : "empty");
      let probes = 0;
      const native = ChildProcessSpawner.make((command) => {
        probes++;
        return fake.native.spawn(command).pipe(
          Effect.map((handle) => ({
            ...handle,
            exitCode: Effect.succeed(
              ChildProcessSpawner.ExitCode(migration === "denied" ? 125 : 0),
            ),
            stdout:
              migration === "migrated" || migration === "unkillable"
                ? Stream.make(new TextEncoder().encode("contained\n"))
                : Stream.empty,
          })),
        );
      });
      const refusal = yield* ownedWriterPlatformRefusal().pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(PosixCgroupController, { create: () => fake.lease }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, native),
      );
      assert.equal(probes, 1);
      assert.equal(refusal === undefined, migration === "migrated");
      assert.include(fake.operations, "remove");
      assert.include(
        fake.commands[0]?._tag === "StandardCommand" ? fake.commands[0].args.join(" ") : "",
        "cgroup.procs",
      );
    }).pipe(Effect.scoped),
);

it.live("joins a Linux root and its detached writer through the cgroup", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "linux") return;
    if ((yield* ownedWriterPlatformRefusal()) !== undefined) return;
    const owner = yield* makePosixOwnedProcess();
    const native = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ready = yield* Deferred.make<void>();
    const probe = "a'b\nc $HOME";
    const lines: string[] = [];
    const script = `console.log(JSON.stringify(process.env.T3_PROBE));require('node:child_process').spawn(process.execPath,['-e',"console.log('writer-ready');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','inherit','inherit']}).unref()`;
    const child = yield* owner.spawner.spawn(
      ChildProcess.make(process.execPath, ["-e", script], { env: { T3_PROBE: probe } }),
      native,
    );
    const output = yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        line === "writer-ready"
          ? Deferred.succeed(ready, undefined)
          : Effect.sync(() => {
              lines.push(line);
            }),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    yield* owner.awaitRootExits;
    assert.isTrue(yield* owner.quiesce());
    yield* Fiber.join(output);
    assert.deepEqual(lines, [JSON.stringify(probe)]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// A failed spawn leaves no child, so an empty lease is released; anything unproven stays held.
it.effect.each([
  { failure: "handshake", mode: "empty", quiet: false },
  { failure: "spawn", mode: "empty", quiet: true },
  { failure: "spawn", mode: "unreadable", quiet: false },
] as const)(
  "never resumes a root whose acquisition failed ($failure, lease $mode)",
  ({ failure, mode, quiet }) =>
    Effect.gen(function* () {
      const fake = fixture(mode);
      const native = ChildProcessSpawner.make((command) =>
        failure === "spawn"
          ? Effect.fail(
              PlatformError.systemError({
                module: "ChildProcess",
                method: "spawn",
                _tag: "NotFound",
              }),
            )
          : fake.native
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
      assert.equal(fake.operations.includes("remove"), quiet);
      if (quiet) yield* owner.awaitRootExits;
      assert.equal(yield* owner.quiesce(), quiet);
    }).pipe(Effect.scoped),
);
