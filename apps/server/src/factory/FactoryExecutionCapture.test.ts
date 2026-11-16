import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  type FactoryExecutionBinding,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { OwnedProcess } from "@t3tools/shared/ownedProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Store from "../persistence/FactoryExecutionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Processes from "../processRunner.ts";
import * as Capture from "./FactoryExecutionCapture.ts";
import { codeResultCommit } from "./FactoryExecutionCapture.ts";

const git = Effect.fn("test.git")(function* (cwd: string, ...args: ReadonlyArray<string>) {
  const result = yield* (yield* Processes.ProcessRunner).run({ command: "git", args, cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
});

/**
 * A worktree where the agent committed once, then T3 took its checkpoint, with the agent's other
 * changes left uncommitted when `leftover`. `identity` is the repository's own afterwards.
 */
const agentRun = Effect.fn("test.agentRun")(function* (input: {
  readonly identity: readonly [name: string, email: string];
  readonly leftover: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-capture-" });
  const as = (name: string) => ["-c", `user.name=${name}`, "-c", "user.email=agent@example.com"];
  yield* git(cwd, "init", "--quiet");
  yield* fs.writeFileString(path.join(cwd, "board.ts"), "export const width = 1;\n");
  yield* git(cwd, "add", "--all");
  yield* git(cwd, ...as("Agent"), "commit", "--quiet", "-m", "base");
  yield* fs.writeFileString(path.join(cwd, "board.ts"), "export const width = 2;\n");
  yield* git(cwd, ...as("Agent"), "commit", "--quiet", "--all", "-m", "fix(board): keep width");
  if (input.leftover) yield* fs.writeFileString(path.join(cwd, "card.ts"), "export {};\n");
  yield* git(cwd, "add", "--all");
  const tree = yield* git(cwd, "write-tree");
  const checkpoint = yield* git(
    cwd,
    ...as("T3 Code"),
    "commit-tree",
    tree,
    "-p",
    "HEAD",
    "-m",
    "t3 checkpoint ref=refs/t3/orchestration-v2/checkpoints/run/ordinal/1",
  );
  yield* git(cwd, "config", "user.name", input.identity[0]);
  yield* git(cwd, "config", "user.email", input.identity[1]);
  return { cwd, tree, checkpoint, head: yield* git(cwd, "rev-parse", "HEAD") };
});

const layer = Layer.provideMerge(Processes.layer, NodeServices.layer);

// The test setup turns `core.longpaths` on for every git child; a Windows machine has it off.
const withoutLongPaths = Layer.effect(
  Processes.ProcessRunner,
  Effect.gen(function* () {
    const runner = yield* Processes.ProcessRunner;
    const count = yield* Config.Int("GIT_CONFIG_COUNT").pipe(Config.withDefault(0));
    return {
      run: (input) =>
        runner.run({
          ...input,
          env: {
            ...input.env,
            GIT_CONFIG_COUNT: String(count + 1),
            [`GIT_CONFIG_KEY_${count}`]: "core.longpaths",
            [`GIT_CONFIG_VALUE_${count}`]: "false",
          },
        }),
    };
  }),
).pipe(Layer.provide(layer));

it.effect("a checkpoint that adds nothing names the agent's own commit", () =>
  Effect.gen(function* () {
    const run = yield* agentRun({ identity: ["Ada", "ada@example.com"], leftover: false });
    const commit = yield* codeResultCommit({ ...run, message: "Cards overflow the board" });
    assert.equal(commit, run.head);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([
  { name: "the repository's author", identity: ["Ada", "ada@example.com"], author: "Ada" },
  // Git refuses an empty identity the same way it refuses a missing one.
  { name: "T3's author when the repository has none", identity: ["", ""], author: "T3 Code" },
] as const)("leftover changes are committed on the agent's commit as $name", (row) =>
  Effect.gen(function* () {
    const run = yield* agentRun({ identity: row.identity, leftover: true });
    const commit = yield* codeResultCommit({ ...run, message: "Cards overflow the board" });
    assert.notEqual(commit, run.checkpoint);
    assert.deepEqual(
      (yield* git(run.cwd, "show", "--no-patch", "--format=%P%n%T%n%an%n%B", commit)).split("\n"),
      [run.head, run.tree, row.author, "Cards overflow the board"],
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each(["normal", "slow add", "slow remove"] as const)(
  "a verified result survives long checkout paths and %s",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-capture-" });
      // The checkout is `<os tmp>/t3-factory-verify-XXXXXX/tree/<file>`.
      const checkout = path.join(path.dirname(cwd), "t3-factory-verify-XXXXXX", "tree");
      const file = [
        ...Array.from({ length: Math.ceil((300 - checkout.length) / 41) }, () => "d".repeat(40)),
        "long.ts",
      ].join("/");
      assert.isAbove(checkout.length + file.length, 260);
      const as = (name: string) => [
        "-c",
        `user.name=${name}`,
        "-c",
        "user.email=agent@example.com",
      ];
      yield* git(cwd, "init", "--quiet");
      // Plumbing only, so the long path never has to exist in this repository's own working tree.
      yield* fs.writeFileString(path.join(cwd, "blob.txt"), "export {};\n");
      const blob = yield* git(cwd, "hash-object", "-w", "blob.txt");
      yield* git(cwd, "update-index", "--add", "--cacheinfo", `100644,${blob},board.ts`);
      const base = yield* git(
        cwd,
        ...as("Agent"),
        "commit-tree",
        yield* git(cwd, "write-tree"),
        "-m",
        "base",
      );
      yield* git(cwd, "update-index", "--add", "--cacheinfo", `100644,${blob},${file}`);
      const tree = yield* git(cwd, "write-tree");
      const checkpoint = yield* git(
        cwd,
        ...as("T3 Code"),
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        "t3",
      );

      const instanceId = ProviderInstanceId.make("codex");
      const context = {
        threadId: ThreadId.make("managed"),
        runId: RunId.make("run"),
        runAttemptId: RunAttemptId.make("attempt"),
        scopeId: CheckpointScopeId.make("scope"),
        providerThreadId: ProviderThreadId.make("provider-thread"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
      };
      const binding: FactoryExecutionBinding = {
        selection: {
          ref: {
            environmentId: EnvironmentId.make("local"),
            projectId: ProjectId.make("project"),
            rootId: "plan",
          },
          revision: 1,
          taskId: "root",
        },
        grantVersion: 1,
        taskVersion: 1,
        commandId: CommandId.make("admit"),
        threadId: context.threadId,
        runId: context.runId,
        runAttemptId: context.runAttemptId,
        driver: context.driver,
        spec: {
          taskId: "root",
          modelSelection: { instanceId, model: "luna" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          setup: "deny",
          verification: { command: "git", args: ["--version"] },
          output: { slot: "code", kind: "verified-code" },
        },
        inputDigest: "a".repeat(64),
        inputText: "Long paths",
        prerequisites: [],
        admittedAt: "2026-11-05T00:00:00.000Z",
        stopRequested: false,
        quiescent: false,
      };
      const projection = {
        runs: [{ id: context.runId }],
        attempts: [
          {
            id: context.runAttemptId,
            runId: context.runId,
            providerThreadId: context.providerThreadId,
            providerInstanceId: instanceId,
            status: "completed",
          },
        ],
        messages: [],
        checkpointScopes: [{ id: context.scopeId, cwd }],
        checkpoints: [
          { runId: context.runId, scopeId: context.scopeId, status: "ready", ref: checkpoint },
        ],
      };
      const runner = yield* Processes.ProcessRunner.pipe(Effect.provide(withoutLongPaths));
      const captureRunner = Layer.succeed(Processes.ProcessRunner, {
        run: (input) => {
          const operation = input.args[input.args.indexOf("worktree") + 1];
          if (input.args.includes("worktree") && scenario === `slow ${operation}`) {
            const timeoutMs = Duration.toMillis(
              Duration.fromInputUnsafe(input.timeout ?? "60 seconds"),
            );
            if (timeoutMs <= 65_000)
              return Effect.fail(
                new Processes.ProcessTimeoutError({
                  command: input.command,
                  argumentCount: input.args.length,
                  timeoutMs,
                }),
              );
          }
          return runner.run(input);
        },
      });
      const captured = yield* Capture.FactoryExecutionCapture.pipe(
        Effect.flatMap((service) => service.capture(context)),
        Effect.provide(
          Capture.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(Store.FactoryExecutionStore)({
                  getBinding: () => Effect.succeed(binding),
                  captureKey: () => Effect.succeed("native-final/1"),
                  readCapture: () => Effect.succeed(null),
                  retainCapture: () => Effect.void,
                }),
                Layer.mock(Projections.ProjectionStoreV2)({
                  getThreadProjection: () => Effect.succeed(projection as never),
                }),
                Sqlite.layerMemory,
                captureRunner,
                NodeServices.layer,
              ),
            ),
          ),
        ),
        Effect.provideService(OwnedProcess, {
          spawn: (command, spawner) => spawner.spawn(command),
        }),
      );
      assert.equal(captured.status, "sealed");
      assert.equal(captured.checkpoint?.tree, tree);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
