import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Processes from "../processRunner.ts";
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
