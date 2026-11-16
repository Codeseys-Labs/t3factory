import * as HostProcess from "@t3tools/shared/HostProcess";
import { OwnedProcess } from "@t3tools/shared/ownedProcess";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Processes from "../processRunner.ts";

const SETUP_TIME_LIMIT = Duration.minutes(15);
const TAIL_LINES = 20;
const LINE_CHARS = 400;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export class FactoryWorktreeSetupError extends Schema.TaggedError<FactoryWorktreeSetupError>()(
  "FactoryWorktreeSetupError",
  {
    reason: Schema.Literals(["unowned", "start", "exit", "timeout"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface FactoryWorktreeSetupInput {
  readonly command: string;
  readonly worktreePath: string;
  readonly onOutputLine?: ((line: string) => Effect.Effect<void>) | undefined;
}

/** Runs a task run's pinned setup command in its worktree, as a process the run owns. */
export class FactoryWorktreeSetup extends Context.Service<
  FactoryWorktreeSetup,
  {
    readonly run: (
      input: FactoryWorktreeSetupInput,
    ) => Effect.Effect<void, FactoryWorktreeSetupError>;
  }
>()("t3/factory/FactoryWorktreeSetup") {}

/** The last lines of stdout and stderr together, kept as chunks arrive so a timeout keeps them. */
const makeTail = (emit: (line: string) => void) => {
  const lines: string[] = [];
  const push = (raw: string) => {
    // A carriage return inside a line redraws it; only what it ends showing counts.
    const ended = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const line = ended
      .slice(ended.lastIndexOf("\r") + 1)
      .replace(ANSI, "")
      .trimEnd();
    // The Job Object helper's marker for serialized error output; `-OutputFormat Text` keeps
    // the setup shell's own errors readable.
    if (line.length === 0 || line === "#< CLIXML") return;
    const bounded = line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line;
    lines.push(bounded);
    if (lines.length > TAIL_LINES) lines.shift();
    emit(bounded);
  };
  const stream = () => {
    const decoder = new TextDecoder();
    let partial = "";
    return {
      chunk: (bytes: Uint8Array) => {
        const parts = (partial + decoder.decode(bytes, { stream: true })).split("\n");
        partial = parts.pop()!.slice(-LINE_CHARS * 4);
        for (const part of parts) push(part);
      },
      flush: () => {
        push(partial + decoder.decode());
        partial = "";
      },
    };
  };
  const stdout = stream();
  const stderr = stream();
  return {
    stdout: stdout.chunk,
    stderr: stderr.chunk,
    text: () => {
      stdout.flush();
      stderr.flush();
      return lines.join("\n");
    },
  };
};

const withTail = (summary: string, tail: string) =>
  tail.length === 0 ? summary : `${summary}\nLast output:\n${tail}`;

const make = Effect.gen(function* () {
  const processes = yield* Processes.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const shell = Effect.fn("FactoryWorktreeSetup.shell")(function* (command: string) {
    if ((yield* HostProcess.Platform) === "win32") {
      // Upstream's terminal runner reports the exit code the same way.
      const script = `$global:LASTEXITCODE = $null; & {\n${command}\n}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } elseif ($?) { exit 0 } else { exit 1 }`;
      return {
        command: (yield* isCommandAvailable("pwsh.exe").pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ))
          ? "pwsh.exe"
          : "powershell.exe",
        args: [
          "-OutputFormat",
          "Text",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
      };
    }
    const userShell = (yield* HostProcess.Environment).SHELL?.trim();
    return { command: userShell || "/bin/sh", args: ["-c", command] };
  });

  const run = Effect.fn("FactoryWorktreeSetup.run")(function* (input: FactoryWorktreeSetupInput) {
    if ((yield* OwnedProcess) === undefined)
      return yield* new FactoryWorktreeSetupError({
        reason: "unowned",
        detail: "Setup runs only inside a task run, as a process the run owns.",
      });
    const lines = yield* Queue.sliding<string, Cause.Done>(256);
    const forward = yield* Stream.fromQueue(lines).pipe(
      Stream.runForEach((line) => input.onOutputLine?.(line) ?? Effect.void),
      Effect.forkScoped,
    );
    const tail = makeTail((line) => {
      Queue.offerUnsafe(lines, line);
    });
    const invocation = yield* shell(input.command);
    const result = yield* processes
      .run({
        ...invocation,
        cwd: input.worktreePath,
        // A task run links no development env files, so the server's own root must not leak in.
        env: { T3CODE_WORKTREE_PATH: input.worktreePath, T3CODE_PROJECT_ROOT: undefined },
        stdin: "",
        timeout: SETUP_TIME_LIMIT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
        onStdoutChunk: tail.stdout,
        onStderrChunk: tail.stderr,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new FactoryWorktreeSetupError({
              reason: "start",
              detail: withTail(`Setup script could not run: ${cause.message}`, tail.text()),
            }),
        ),
      );
    const last = tail.text();
    yield* Queue.end(lines);
    yield* Fiber.join(forward);
    if (result.timedOut)
      return yield* new FactoryWorktreeSetupError({
        reason: "timeout",
        detail: withTail(
          `Setup script did not finish within ${Duration.toMinutes(SETUP_TIME_LIMIT)} minutes.`,
          last,
        ),
      });
    if (result.code !== 0)
      return yield* new FactoryWorktreeSetupError({
        reason: "exit",
        detail: withTail(`Setup script exited with ${result.code ?? "no exit code"}.`, last),
      });
  }, Effect.scoped);

  return FactoryWorktreeSetup.of({ run });
});

export const layer = Layer.effect(FactoryWorktreeSetup, make);
