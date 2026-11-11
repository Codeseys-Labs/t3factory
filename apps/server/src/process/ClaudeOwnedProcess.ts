// @effect-diagnostics nodeBuiltinImport:off -- the Claude SDK requires Node streams and events.
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as NodeEffectStream from "@effect/platform-node/NodeStream";
import * as NodeEffectSink from "@effect/platform-node/NodeSink";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { awaitConfirmedExit, spawnOwnedProcess } from "@t3tools/shared/ownedProcess";

// Bridge the SDK's synchronous spawn callback into the caller's owned Effect scope.
export const makeClaudeOwnedSpawner = Effect.fn("ClaudeOwnedProcess.makeSpawner")(function* () {
  const native = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const runFork = Effect.runForkWith(yield* Effect.context<Scope.Scope>());
  return (options: SpawnOptions, onStderr?: (text: string) => void): SpawnedProcess => {
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    let handle: ChildProcessSpawner.ChildProcessHandle | undefined;
    let killed = false;
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    const kill = (signal: NodeJS.Signals) => {
      killed = true;
      signalCode = signal;
      if (handle !== undefined) runFork(handle.kill({ killSignal: signal }).pipe(Effect.ignore));
      return true;
    };
    const events = new (class extends NodeEvents.EventEmitter {
      readonly stdin = stdin;
      readonly stdout = stdout;
      readonly kill = kill;
      get killed() {
        return killed;
      }
      get exitCode() {
        return exitCode;
      }
      get signalCode() {
        return signalCode;
      }
    })();
    const abort = () => kill("SIGTERM");
    runFork(
      Effect.gen(function* () {
        handle = yield* spawnOwnedProcess(
          native,
          ChildProcess.make(options.command, options.args, {
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            env: options.env,
            extendEnv: false,
          }),
        );
        if (killed || options.signal.aborted) abort();
        options.signal.addEventListener("abort", abort, { once: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            options.signal.removeEventListener("abort", abort);
            stdin.destroy();
            stdout.destroy();
          }),
        );
        yield* NodeEffectStream.fromReadable({
          evaluate: () => stdin,
          onError: (cause) => new Error("Owned process stream failed.", { cause }),
        }).pipe(Stream.run(handle.stdin), Effect.ignore, Effect.forkIn(scope));
        const output = yield* handle.stdout.pipe(
          Stream.run(
            NodeEffectSink.fromWritable({
              evaluate: () => stdout,
              onError: (cause) => new Error("Owned process stream failed.", { cause }),
            }),
          ),
          Effect.forkIn(scope),
        );
        const stderr = yield* handle.stderr.pipe(
          Stream.decodeText,
          Stream.runForEach((text) => Effect.sync(() => onStderr?.(text))),
          Effect.forkIn(scope),
        );
        const code = yield* awaitConfirmedExit(handle);
        // Descendants may retain the pipes after root exit, even if cleanup cannot stop them.
        yield* handle
          .kill({ killSignal: "SIGKILL" })
          .pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.all([Fiber.join(output), Fiber.join(stderr)], { concurrency: "unbounded" }),
            ),
            Effect.timeoutOption("500 millis"),
            Effect.ignore,
          );
        yield* Fiber.interrupt(output);
        yield* Fiber.interrupt(stderr);
        if (Option.isSome(code)) exitCode = Number(code.value);
        // Effect does not expose which signal ended it; the owner stops roots with SIGKILL.
        else signalCode ??= "SIGKILL";
        events.emit("exit", exitCode, signalCode);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            stdin.destroy();
            stdout.destroy();
            events.emit("error", new Error("Owned Claude process failed.", { cause }));
          }),
        ),
        Effect.forkIn(scope),
      ),
    );
    return events;
  };
});
