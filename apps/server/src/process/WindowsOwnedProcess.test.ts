// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CommandLine from "effect/process/CommandLine";
import { makeWindowsOwnedProcess } from "./WindowsOwnedProcess.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.live(
  "contains a detached writer before resume and observes job empty independently of root exit",
  () =>
    Effect.gen(function* () {
      if (windowsHost !== true) return;
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-owned-writer-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const outputPath = NodePath.join(directory, "descendant-after-root.txt");
      const forbiddenPath = NodePath.join(directory, "must-not-start.txt");
      const retainedBytes = "descendant filesystem write after independently observed root exit\n";
      const pipeName = `t3-owned-fixture-${NodeCrypto.randomUUID()}`;
      const pipePath = `\\\\.\\pipe\\${pipeName}`;
      const sockets = new Set<NodeNet.Socket>();
      let child: NodeNet.Socket | undefined;
      let resolveChild!: () => void;
      const childReady = new Promise<void>((resolve) => {
        resolveChild = resolve;
      });
      let resolveRootExit!: () => void;
      const rootExit = new Promise<void>((resolve) => {
        resolveRootExit = resolve;
      });
      let resolveWrite!: () => void;
      const write = new Promise<void>((resolve) => {
        resolveWrite = resolve;
      });
      const server = NodeNet.createServer((socket) => {
        sockets.add(socket);
        socket.setEncoding("utf8");
        let input = "";
        socket.on("data", (data: string) => {
          input += data;
          let end: number;
          while ((end = input.indexOf("\n")) >= 0) {
            const line = input.slice(0, end);
            input = input.slice(end + 1);
            if (line === "child") {
              child = socket;
              resolveChild();
            }
            if (line === "write-after-root") resolveWrite();
            if (line === "root") socket.once("close", () => resolveRootExit());
          }
        });
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(pipePath, resolve);
            }),
        ),
        () =>
          Effect.sync(() => {
            for (const socket of sockets) socket.destroy();
            server.close();
          }),
      );
      const descendant = `const s=require('node:net').connect(${JSON.stringify(pipePath)},()=>s.write('child\\n'));s.setEncoding('utf8');s.on('data',()=>{require('node:fs').appendFileSync(${JSON.stringify(outputPath)},${JSON.stringify(retainedBytes)});s.write('write-after-root\\n');});`;
      const root = `const n=require('node:net');const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','ignore','inherit']});c.unref();const s=n.connect(${JSON.stringify(pipePath)},()=>{s.write('root\\n',()=>process.exit(7));});`;
      const observations: string[] = [];
      let resolveHelperExit!: () => void;
      const helperExit = new Promise<void>((resolve) => {
        resolveHelperExit = resolve;
      });
      const owner = yield* makeWindowsOwnedProcess({
        onObservation: (event) => {
          observations.push(event);
          if (event.startsWith("helper-exit:")) resolveHelperExit();
          process.stderr.write(`[owned-observation] ${event}\n`);
        },
      });
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* owner.spawner.spawn(
        ChildProcess.make(process.execPath, ["-e", root]),
        native,
      );
      const stdout = yield* handle.stdout.pipe(Stream.runDrain, Effect.forkChild);
      const stderr = yield* handle.stderr.pipe(
        Stream.decodeText,
        Stream.runCollect,
        Effect.forkChild,
      );
      const milestone = (name: string, signal: Promise<void>) =>
        Effect.promise(() => signal).pipe(
          Effect.raceFirst(
            Effect.promise(() => helperExit).pipe(
              Effect.flatMap(() =>
                Effect.gen(function* () {
                  const error = yield* Fiber.join(stderr);
                  return yield* Effect.die(
                    new Error(
                      `Owned helper exited before ${name}: stages=${JSON.stringify(observations)}; stderr=${Array.from(error).join("")}`,
                    ),
                  );
                }),
              ),
            ),
          ),
        );
      yield* milestone("descendant-ready", childReady);
      yield* milestone("root-socket-closed", rootExit);
      yield* owner.awaitRootExits;
      child!.write("write\n");
      yield* milestone("retained-filesystem-write", write);
      const actualBytes = yield* Effect.promise(() => NodeFSP.readFile(outputPath));
      assert.deepEqual([...actualBytes], [...Buffer.from(retainedBytes, "utf8")]);
      // The handle is the root: it reports the root's exit while the writer keeps the job open.
      assert.isFalse(yield* handle.isRunning);
      assert.equal(yield* handle.exitCode, 7);
      assert.notInclude(observations, "empty");
      assert.isTrue(yield* owner.quiesce());
      yield* Fiber.join(stderr);
      yield* Fiber.join(stdout);
      const afterStop = yield* owner.spawner
        .spawn(
          ChildProcess.make(process.execPath, [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(forbiddenPath)},'forbidden')`,
          ]),
          native,
        )
        .pipe(Effect.flip);
      assert.equal(afterStop._tag, "PlatformError");
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.access(forbiddenPath).then(
            () => true,
            () => false,
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("hands the native spawner redacted arguments still redacted", () =>
  Effect.gen(function* () {
    if (windowsHost !== true) return;
    const secret = "s3cr3t-arg";
    const commands: ChildProcess.Command[] = [];
    const native = ChildProcessSpawner.make((command) => {
      commands.push(command);
      return Effect.fail(
        PlatformError.systemError({ module: "ChildProcess", method: "spawn", _tag: "Unknown" }),
      );
    });
    const owner = yield* makeWindowsOwnedProcess();
    yield* owner.spawner
      .spawn(ChildProcess.make(process.execPath, ["plain", Redacted.make(secret)]), native)
      .pipe(Effect.flip);
    const command = commands[0];
    assert.equal(command?._tag, "StandardCommand");
    if (command?._tag !== "StandardCommand") return;
    assert.notInclude(CommandLine.display([command.command, ...command.args]), secret);
    // The payload carries the secret, so the PowerShell payload word must be the redacted one.
    const payload = command.args.at(-1);
    assert.isTrue(Redacted.isRedacted(payload));
    assert.isFalse(command.args.some((arg) => typeof arg === "string" && arg.includes(secret)));
  }).pipe(Effect.scoped),
);

it.live.each([
  {
    name: "inherits the host environment",
    options: {},
    expected: {
      env: {
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_2: "core.longpaths",
        GIT_CONFIG_VALUE_2: "true",
      },
      extendEnv: true,
    },
  },
  {
    name: "extends the host environment",
    options: { env: { EXTRA: "1" }, extendEnv: true },
    expected: {
      env: {
        EXTRA: "1",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_2: "core.longpaths",
        GIT_CONFIG_VALUE_2: "true",
      },
      extendEnv: true,
    },
  },
  {
    name: "replaces the host environment",
    options: {
      env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Ada" },
    },
    expected: {
      env: {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Ada",
        GIT_CONFIG_KEY_1: "core.longpaths",
        GIT_CONFIG_VALUE_1: "true",
      },
      extendEnv: false,
    },
  },
  {
    name: "redacts its Git settings",
    options: {
      env: {
        GIT_CONFIG_COUNT: Redacted.make("1"),
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Ada",
      },
    },
    expected: {
      env: {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Ada",
        GIT_CONFIG_KEY_1: "core.longpaths",
        GIT_CONFIG_VALUE_1: "true",
      },
      extendEnv: false,
    },
  },
])("turns on Git long paths for a command that $name", ({ options, expected }) =>
  Effect.gen(function* () {
    if (windowsHost !== true) return;
    const commands: ChildProcess.Command[] = [];
    const native = ChildProcessSpawner.make((command) => {
      commands.push(command);
      return Effect.fail(
        PlatformError.systemError({ module: "ChildProcess", method: "spawn", _tag: "Unknown" }),
      );
    });
    const owner = yield* makeWindowsOwnedProcess();
    yield* owner.spawner
      .spawn(ChildProcess.make(process.execPath, ["plain"], options), native)
      .pipe(Effect.flip);
    const command = commands[0];
    assert.equal(command?._tag, "StandardCommand");
    if (command?._tag !== "StandardCommand") return;
    assert.deepStrictEqual(command.options.env, expected.env);
    assert.equal(command.options.extendEnv === true, expected.extendEnv);
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.Environment, {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "init.defaultBranch",
      GIT_CONFIG_VALUE_1: "main",
    }),
  ),
);

it.live.each([0, 3])(
  "does not kill the tree of a command that ended on its own (exit code %s) when its scope closes",
  (exitCode) => {
    const started: string[] = [];
    return Effect.gen(function* () {
      if (windowsHost !== true) return;
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const owner = yield* makeWindowsOwnedProcess();
      const code = yield* owner.spawner
        .spawn(ChildProcess.make(process.execPath, ["-e", `process.exit(${exitCode})`]), native)
        .pipe(
          Effect.flatMap((handle) => handle.exitCode),
          Effect.scoped,
        );
      // The native spawner tree-kills a helper it has not seen exit, which costs about two seconds.
      assert.deepEqual(
        [code, yield* owner.quiesce(), started.filter((command) => command === "taskkill")],
        [exitCode, true, []],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        NodeChildProcessSpawner.layerWithSpawn((command, args, options) => {
          started.push(command);
          return NodeChildProcess.spawn(command, [...args], options);
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);
