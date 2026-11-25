#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const SeamConfig = Schema.Struct({
  base: Schema.String,
  owned: Schema.Array(Schema.String),
  seams: Schema.Array(Schema.String),
  generated: Schema.Array(Schema.String),
});
export type SeamConfig = typeof SeamConfig.Type;

export type SeamChangeStatus = "A" | "M" | "D" | "R";

export interface SeamChange {
  readonly status: SeamChangeStatus;
  readonly path: string;
}

export type SeamOffenceReason =
  | "unowned-add"
  | "unlisted-edit"
  | "upstream-delete"
  | "upstream-rename"
  | "too-many-seams"
  | "stale-seam";

export interface SeamOffence {
  readonly path: string;
  readonly reason: SeamOffenceReason;
}

export interface SeamChangeClassification {
  readonly ok: boolean;
  readonly offences: ReadonlyArray<SeamOffence>;
}

export class FactorySeamsGitError extends Schema.TaggedError<FactorySeamsGitError>()(
  "FactorySeamsGitError",
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
    return `factory-seams: git ${this.command} failed during ${this.operation}${detail}`;
  }
}

export class FactorySeamsConfigError extends Schema.TaggedError<FactorySeamsConfigError>()(
  "FactorySeamsConfigError",
  {
    configPath: Schema.String,
    operation: Schema.Literals(["read", "parse"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `factory-seams: failed to ${this.operation} ${this.configPath}.`;
  }
}

export class FactorySeamsDiffParseError extends Schema.TaggedError<FactorySeamsDiffParseError>()(
  "FactorySeamsDiffParseError",
  {
    line: Schema.String,
  },
) {
  override get message(): string {
    return `factory-seams: could not parse git diff status line ${this.line}.`;
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

const matchesSegment = (glob: string, segment: string): boolean => {
  let globIndex = 0;
  let segmentIndex = 0;
  let starIndex = -1;
  let starSegmentIndex = -1;

  while (segmentIndex < segment.length) {
    if (glob[globIndex] === segment[segmentIndex]) {
      globIndex += 1;
      segmentIndex += 1;
    } else if (glob[globIndex] === "*") {
      starIndex = globIndex;
      globIndex += 1;
      starSegmentIndex = segmentIndex;
    } else if (starIndex >= 0) {
      globIndex = starIndex + 1;
      starSegmentIndex += 1;
      segmentIndex = starSegmentIndex;
    } else {
      return false;
    }
  }

  while (glob[globIndex] === "*") {
    globIndex += 1;
  }

  return globIndex === glob.length;
};

export const matchesSeamGlob = (glob: string, path: string): boolean => {
  const globSegments = glob.split("/");
  const pathSegments = path.split("/");

  const matches = (globIndex: number, pathIndex: number): boolean => {
    const globSegment = globSegments[globIndex];
    if (globSegment === undefined) {
      return pathIndex === pathSegments.length;
    }
    if (globSegment === "**") {
      if (globIndex + 1 === globSegments.length) {
        return true;
      }
      for (
        let nextPathIndex = pathIndex;
        nextPathIndex <= pathSegments.length;
        nextPathIndex += 1
      ) {
        if (matches(globIndex + 1, nextPathIndex)) {
          return true;
        }
      }
      return false;
    }

    const pathSegment = pathSegments[pathIndex];
    return (
      pathSegment !== undefined &&
      matchesSegment(globSegment, pathSegment) &&
      matches(globIndex + 1, pathIndex + 1)
    );
  };

  return matches(0, 0);
};

const matchesAny = (globs: ReadonlyArray<string>, path: string) =>
  globs.some((glob) => matchesSeamGlob(glob, path));

export const classifySeamChanges = (
  changes: ReadonlyArray<SeamChange>,
  config: SeamConfig,
): SeamChangeClassification => {
  const offences: Array<SeamOffence> = [];

  for (const change of changes) {
    switch (change.status) {
      case "A":
        if (!matchesAny(config.owned, change.path)) {
          offences.push({ path: change.path, reason: "unowned-add" });
        }
        break;
      case "M":
        if (
          !matchesAny(config.owned, change.path) &&
          !config.seams.includes(change.path) &&
          !matchesAny(config.generated, change.path)
        ) {
          offences.push({ path: change.path, reason: "unlisted-edit" });
        }
        break;
      case "D":
        offences.push({ path: change.path, reason: "upstream-delete" });
        break;
      case "R":
        offences.push({ path: change.path, reason: "upstream-rename" });
        break;
    }
  }

  if (config.seams.length > 12) {
    offences.push({ path: "factory/seams.json", reason: "too-many-seams" });
  }

  const changedPaths = new Set(changes.map((change) => change.path));
  for (const seam of config.seams) {
    if (!changedPaths.has(seam)) {
      offences.push({ path: seam, reason: "stale-seam" });
    }
  }

  return { ok: offences.length === 0, offences };
};

const runGit = Effect.fn("factorySeams.runGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = args.join(" ");
  const context = { cwd, command };

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd })).pipe(
        Effect.mapError(
          (cause) =>
            new FactorySeamsGitError({
              ...context,
              operation: "spawn",
              cause,
            }),
        ),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout).pipe(
            Effect.mapError(
              (cause) =>
                new FactorySeamsGitError({
                  ...context,
                  operation: "read-stdout",
                  cause,
                }),
            ),
          ),
          collectStreamAsString(child.stderr).pipe(
            Effect.mapError(
              (cause) =>
                new FactorySeamsGitError({
                  ...context,
                  operation: "read-stderr",
                  cause,
                }),
            ),
          ),
          child.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError(
              (cause) =>
                new FactorySeamsGitError({
                  ...context,
                  operation: "wait-for-exit",
                  cause,
                }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        return yield* new FactorySeamsGitError({
          ...context,
          operation: "exit",
          exitCode,
          stderr,
        });
      }

      return stdout;
    }),
  );
});

const parseSeamChanges = Effect.fn("factorySeams.parseSeamChanges")(function* (
  stdout: string,
  owned: ReadonlyArray<string>,
) {
  const changes: Array<SeamChange> = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;

    const [status, path, renameDestination] = line.split("\t");
    if (!status || !path) {
      return yield* new FactorySeamsDiffParseError({ line });
    }

    if (/^R\d*$/.test(status)) {
      if (!renameDestination) {
        return yield* new FactorySeamsDiffParseError({ line });
      }
      changes.push(
        matchesAny(owned, path) ? { status: "A", path: renameDestination } : { status: "R", path },
      );
      continue;
    }

    switch (status) {
      case "A":
      case "M":
      case "D":
        changes.push({ status, path });
        break;
      default:
        return yield* new FactorySeamsDiffParseError({ line });
    }
  }

  return changes;
});

const readSeamConfig = Effect.fn("factorySeams.readSeamConfig")(function* (repositoryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(repositoryRoot, "factory", "seams.json");
  const source = yield* fs.readFileString(configPath).pipe(
    Effect.mapError(
      (cause) =>
        new FactorySeamsConfigError({
          configPath,
          operation: "read",
          cause,
        }),
    ),
  );

  return yield* decodeSeamConfig(source).pipe(
    Effect.mapError(
      (cause) =>
        new FactorySeamsConfigError({
          configPath,
          operation: "parse",
          cause,
        }),
    ),
  );
});

export const checkFactorySeams = Effect.fn("factorySeams.checkFactorySeams")(function* (
  base: string | undefined = undefined,
) {
  const cwd = process.cwd();
  const repositoryRoot = (yield* runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const config = yield* readSeamConfig(repositoryRoot);
  const mergeBase = (yield* runGit(repositoryRoot, [
    "merge-base",
    base ?? config.base,
    "HEAD",
  ])).trim();
  const diff = yield* runGit(repositoryRoot, ["diff", "--name-status", "-M", mergeBase, "HEAD"]);
  const changes = yield* parseSeamChanges(diff, config.owned);

  return { changes, classification: classifySeamChanges(changes, config) };
});

const reportClassification = Effect.fn("factorySeams.reportClassification")(function* (input: {
  readonly changes: ReadonlyArray<SeamChange>;
  readonly classification: SeamChangeClassification;
}) {
  for (const offence of input.classification.offences) {
    yield* Console.log(`${offence.reason}\t${offence.path}`);
  }
  yield* Console.log(
    input.classification.ok
      ? `factory-seams: ok (${input.changes.length} change(s)).`
      : `factory-seams: ${input.classification.offences.length} offence(s) (${input.changes.length} change(s)).`,
  );
});

const command = Command.make(
  "factory-seams",
  {
    base: Flag.String("base").pipe(
      Flag.withDescription("Ref to compare with HEAD instead of the configured base."),
      Flag.optional,
    ),
  },
  ({ base }) =>
    checkFactorySeams(Option.getOrUndefined(base)).pipe(
      Effect.tap(reportClassification),
      Effect.tap((result) =>
        result.classification.ok
          ? Effect.void
          : Effect.sync(() => {
              process.exitCode = 1;
            }),
      ),
    ),
).pipe(
  Command.withDescription("Check that Factory edits stay within owned files and approved seams."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
