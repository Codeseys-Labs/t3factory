// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
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
