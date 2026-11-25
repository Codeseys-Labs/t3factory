#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { matchesSeamGlob, SeamConfig } from "./factory-seams.ts";

export type ConflictKind = "seam" | "generated" | "owned" | "outside";

export interface UpstreamConflict {
  readonly kind: ConflictKind;
  readonly path: string;
}

export type MergeBaseResult =
  | { readonly status: "skipped" }
  | { readonly status: "none" }
  | { readonly status: "found"; readonly sha: string };

export interface UpstreamSyncPlan {
  readonly clean: boolean;
  readonly ref: string;
  readonly refFound: boolean;
  readonly mergeBase: MergeBaseResult;
  readonly conflicts: ReadonlyArray<UpstreamConflict>;
}

export class FactorySyncGitError extends Schema.TaggedError<FactorySyncGitError>()(
  "FactorySyncGitError",
  {
    cwd: Schema.String,
    command: Schema.String,
    operation: Schema.Literals(["spawn", "read-stdout", "read-stderr", "wait-for-exit", "exit"]),
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optional(Schema.Number),
    stderr: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const detail = this.stderr ? `: ${this.stderr.trim()}` : "";
    const hint = this.command.includes("merge-tree")
      ? " (merge-tree --write-tree needs git 2.38 or later)"
      : "";
    return `factory-sync: git ${this.command} failed during ${this.operation}${detail}${hint}`;
  }
}

export class FactorySyncConfigError extends Schema.TaggedError<FactorySyncConfigError>()(
  "FactorySyncConfigError",
  {
    configPath: Schema.String,
    operation: Schema.Literals(["read", "parse"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `factory-sync: failed to ${this.operation} ${this.configPath}.`;
  }
}

const decodeSeamConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(SeamConfig));

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const matchesAny = (globs: ReadonlyArray<string>, path: string) =>
  globs.some((glob) => matchesSeamGlob(glob, path));

export const classifyConflict = (path: string, config: SeamConfig): ConflictKind => {
  if (config.seams.includes(path)) return "seam";
  if (matchesAny(config.generated, path)) return "generated";
  if (matchesAny(config.owned, path)) return "owned";
  return "outside";
};

export const parseMergeTreeConflicts = (stdout: string): ReadonlyArray<string> => {
  const [, ...lines] = stdout.split(/\r?\n/);
  return [...new Set(lines.filter((line) => line.length > 0))];
};

export const planProblemCount = (plan: UpstreamSyncPlan): number =>
  Number(!plan.clean) +
  Number(!plan.refFound) +
  Number(plan.mergeBase.status === "none") +
  plan.conflicts.filter((conflict) => conflict.kind === "outside").length;

export const planExitCode = (plan: UpstreamSyncPlan): 0 | 1 =>
  planProblemCount(plan) === 0 ? 0 : 1;

export const formatPlan = (plan: UpstreamSyncPlan): ReadonlyArray<string> => {
  const lines = [
    `tree\t${plan.clean ? "clean" : "dirty"}`,
    `ref\t${plan.ref}\t${plan.refFound ? "found" : "unknown"}`,
  ];
  if (plan.mergeBase.status === "found") lines.push(`merge-base\t${plan.mergeBase.sha}`);
  if (plan.mergeBase.status === "none") lines.push("merge-base\tnone");
  for (const conflict of plan.conflicts) lines.push(`conflict\t${conflict.kind}\t${conflict.path}`);
  const problems = planProblemCount(plan);
  lines.push(problems === 0 ? "factory-sync: ok" : `factory-sync: ${problems} problem(s)`);
  return lines;
};

const runGit = Effect.fn("factorySync.runGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = args.join(" ");
  const context = { cwd, command };

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(ChildProcess.make("git", args, { cwd }))
        .pipe(
          Effect.mapError(
            (cause) => new FactorySyncGitError({ ...context, operation: "spawn", cause }),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout).pipe(
            Effect.mapError(
              (cause) => new FactorySyncGitError({ ...context, operation: "read-stdout", cause }),
            ),
          ),
          collectStreamAsString(child.stderr).pipe(
            Effect.mapError(
              (cause) => new FactorySyncGitError({ ...context, operation: "read-stderr", cause }),
            ),
          ),
          child.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError(
              (cause) => new FactorySyncGitError({ ...context, operation: "wait-for-exit", cause }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      return { stdout, stderr, exitCode, ...context };
    }),
  );
});

const runGitExpecting = Effect.fn("factorySync.runGitExpecting")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  accepted: ReadonlyArray<number>,
) {
  const result = yield* runGit(cwd, args);
  if (!accepted.includes(result.exitCode)) {
    return yield* new FactorySyncGitError({
      cwd,
      command: result.command,
      operation: "exit",
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return result;
});

const readSeamConfig = Effect.fn("factorySync.readSeamConfig")(function* (repositoryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(repositoryRoot, "factory", "seams.json");
  const source = yield* fs
    .readFileString(configPath)
    .pipe(
      Effect.mapError(
        (cause) => new FactorySyncConfigError({ configPath, operation: "read", cause }),
      ),
    );

  return yield* decodeSeamConfig(source).pipe(
    Effect.mapError(
      (cause) => new FactorySyncConfigError({ configPath, operation: "parse", cause }),
    ),
  );
});

export const planUpstreamSync = Effect.fn("factorySync.planUpstreamSync")(function* (
  cwd: string,
  ref: string,
) {
  const repositoryRoot = (yield* runGitExpecting(
    cwd,
    ["rev-parse", "--show-toplevel"],
    [0],
  )).stdout.trim();
  const config = yield* readSeamConfig(repositoryRoot);

  const status = yield* runGitExpecting(
    repositoryRoot,
    ["--no-optional-locks", "status", "--porcelain"],
    [0],
  );
  const clean = status.stdout.trim().length === 0;

  // A ref that starts with "-" would be read by git as an option.
  const resolved = ref.startsWith("-")
    ? undefined
    : yield* runGitExpecting(
        repositoryRoot,
        ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
        [0, 1],
      );
  const sha = resolved?.exitCode === 0 ? resolved.stdout.trim() : undefined;
  if (sha === undefined) {
    return {
      clean,
      ref,
      refFound: false,
      mergeBase: { status: "skipped" },
      conflicts: [],
    } satisfies UpstreamSyncPlan;
  }

  const mergeBaseResult = yield* runGitExpecting(
    repositoryRoot,
    ["merge-base", "HEAD", sha],
    [0, 1],
  );
  if (mergeBaseResult.exitCode !== 0) {
    return {
      clean,
      ref,
      refFound: true,
      mergeBase: { status: "none" },
      conflicts: [],
    } satisfies UpstreamSyncPlan;
  }

  const merge = yield* runGitExpecting(
    repositoryRoot,
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", sha],
    [0, 1],
  );
  const conflicts = parseMergeTreeConflicts(merge.stdout).map((path): UpstreamConflict => ({
    kind: classifyConflict(path, config),
    path,
  }));

  return {
    clean,
    ref,
    refFound: true,
    mergeBase: { status: "found", sha: mergeBaseResult.stdout.trim() },
    conflicts,
  } satisfies UpstreamSyncPlan;
});

const command = Command.make("factory-sync").pipe(
  Command.withDescription("Plan an upstream sync without changing the repository."),
  Command.withSubcommands([
    Command.make(
      "plan",
      {
        ref: Flag.String("ref").pipe(
          Flag.withDescription("Upstream ref to merge into HEAD, for example a nightly tag."),
        ),
      },
      ({ ref }) =>
        Effect.gen(function* () {
          const plan = yield* planUpstreamSync(process.cwd(), ref);
          for (const line of formatPlan(plan)) yield* Console.log(line);
          if (planExitCode(plan) !== 0) process.exitCode = 1;
        }),
    ).pipe(
      Command.withDescription(
        "Report the tree state, the merge base and the files a merge of the ref would conflict in.",
      ),
    ),
  ]),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
