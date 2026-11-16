// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics processEnvInEffect:off - the server's own environment is what the case sets.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { OwnedProcess, type OwnedProcessSpawner } from "@t3tools/shared/ownedProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Processes from "../processRunner.ts";
import * as Setup from "./FactoryWorktreeSetup.ts";

// Satisfies the ownership check; real containment is the lifecycle's, tested with it.
const passThroughOwner: OwnedProcessSpawner = { spawn: (command, native) => native.spawn(command) };
const live = Setup.layer.pipe(
  Layer.provideMerge(Processes.layer),
  Layer.provideMerge(NodeServices.layer),
);
const encoder = new TextEncoder();

const runSetup = (command: string, worktreePath: string) =>
  Effect.gen(function* () {
    const lines: string[] = [];
    const exit = yield* (yield* Setup.FactoryWorktreeSetup)
      .run({
        command,
        worktreePath,
        onOutputLine: (line) => Effect.sync(() => void lines.push(line)),
      })
      .pipe(Effect.provideService(OwnedProcess, passThroughOwner), Effect.flip, Effect.option);
    return { lines, error: exit._tag === "Some" ? exit.value : null };
  });

const tempWorktree = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-setup-"))),
  (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
);

it.effect("refuses to run setup no task run owns", () =>
  Effect.gen(function* () {
    const error = yield* (yield* Setup.FactoryWorktreeSetup)
      .run({ command: "vp i", worktreePath: "/worktree" })
      .pipe(Effect.flip);
    assert.equal(error.reason, "unowned");
  }).pipe(
    Effect.provide(
      Setup.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Processes.ProcessRunner)({
              run: () => Effect.die("an unowned setup must not start a process"),
            }),
            NodeServices.layer,
          ),
        ),
      ),
    ),
  ),
);

it.live("runs in the worktree without the server's project root", () =>
  Effect.gen(function* () {
    const worktree = yield* tempWorktree;
    const previous = process.env.T3CODE_PROJECT_ROOT;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.T3CODE_PROJECT_ROOT = "/main-checkout";
      }),
      () =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.T3CODE_PROJECT_ROOT;
          else process.env.T3CODE_PROJECT_ROOT = previous;
        }),
    );
    const { lines, error } = yield* runSetup(
      "node -e 'console.log(JSON.stringify([process.cwd(), process.env.T3CODE_WORKTREE_PATH, process.env.T3CODE_PROJECT_ROOT ?? null]))'",
      worktree,
    );
    assert.isNull(error);
    const [cwd, worktreeEnv, projectRoot] = JSON.parse(lines.at(-1)!) as [string, string, null];
    assert.equal(NodeFS.realpathSync.native(cwd), NodeFS.realpathSync.native(worktree));
    assert.equal(worktreeEnv, worktree);
    assert.isNull(projectRoot);
  }).pipe(Effect.scoped, Effect.provide(live)),
);

it.live("fails a non-zero exit with the last lines of stdout and stderr", () =>
  Effect.gen(function* () {
    const { error } = yield* runSetup(
      "node -e 'console.log(`installing`); console.error(`ERR_PNPM_OUTDATED_LOCKFILE`); process.exitCode = 3'",
      yield* tempWorktree,
    );
    assert.equal(error?.reason, "exit");
    assert.equal(
      error?.message,
      "Setup script exited with 3.\nLast output:\ninstalling\nERR_PNPM_OUTDATED_LOCKFILE",
    );
  }).pipe(Effect.scoped, Effect.provide(live)),
);

it.live("returns PowerShell's own exit code", () =>
  Effect.gen(function* () {
    if (HostProcess.Platform.defaultValue() !== "win32") return;
    const { error } = yield* runSetup("exit 3", yield* tempWorktree);
    assert.equal(error?.message, "Setup script exited with 3.");
  }).pipe(Effect.scoped, Effect.provide(live)),
);

it.effect("keeps the last output lines of a setup that runs out of time", () =>
  Effect.gen(function* () {
    let invocation: Processes.ProcessRunInput | undefined;
    const runner = Layer.mock(Processes.ProcessRunner)({
      run: (input) =>
        Effect.sync(() => {
          invocation = input;
          for (let line = 1; line <= 24; line++)
            input.onStdoutChunk?.(encoder.encode(`line ${line}\r\n`));
          input.onStderrChunk?.(encoder.encode("progress 10%\rprogress 90%"));
          return {
            stdout: "",
            stderr: "",
            code: null,
            timedOut: true,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const { lines, error } = yield* runSetup("vp i", "/worktree").pipe(
      Effect.provide(Setup.layer.pipe(Layer.provide(Layer.mergeAll(runner, NodeServices.layer)))),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { SHELL: "/bin/zsh" }),
    );
    const tail = [...Array.from({ length: 19 }, (_, index) => `line ${index + 6}`), "progress 90%"];
    assert.equal(error?.reason, "timeout");
    assert.equal(
      error?.message,
      `Setup script did not finish within 15 minutes.\nLast output:\n${tail.join("\n")}`,
    );
    assert.deepEqual(lines.slice(-20), tail);
    assert.deepInclude(invocation, {
      command: "/bin/zsh",
      args: ["-c", "vp i"],
      cwd: "/worktree",
      stdin: "",
      env: { T3CODE_WORKTREE_PATH: "/worktree", T3CODE_PROJECT_ROOT: undefined },
    });
  }),
);
