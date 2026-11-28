#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import {
  applyInstall,
  FACTORY_PACK_MANIFEST,
  FactoryPackConflictError,
  FactoryPackError,
  hashPack,
  needsWorkflowRestart,
  planInstall,
  planStatus,
  prepareInstall,
  readManifest,
  readTargets,
} from "./factory-pack-plan.ts";

export {
  FactoryPackConflictError,
  FactoryPackError,
  needsWorkflowRestart,
  planInstall,
  planStatus,
};

export class FactoryPackHomeError extends Schema.TaggedError<FactoryPackHomeError>()(
  "FactoryPackHomeError",
  { home: Schema.String },
) {
  override get message(): string {
    return `Home must be an existing directory: ${this.home}`;
  }
}

const readPack = Effect.fn("factoryPack.readPack")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = new Map<string, Uint8Array>();
  for (const entry of yield* fs.readDirectory(root, { recursive: true })) {
    const absolute = path.join(root, entry);
    if ((yield* fs.stat(absolute)).type !== "File") continue;
    files.set(entry.replaceAll("\\", "/"), yield* fs.readFile(absolute));
  }
  return files;
});

const requireHome = Effect.fn("factoryPack.requireHome")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(home).pipe(Effect.option);
  if (Option.isNone(stat) || stat.value.type !== "Directory") {
    return yield* new FactoryPackHomeError({ home });
  }
});

const sourceRoot = Effect.fn("factoryPack.sourceRoot")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../factory", import.meta.url));
});

export const installFactoryPack = Effect.fn("factoryPack.install")(function* (input: {
  readonly home: string;
  readonly skills?: string | undefined;
  readonly force: boolean;
  readonly source?: string | undefined;
}) {
  const path = yield* Path.Path;
  yield* requireHome(input.home);
  const source = input.source ?? (yield* sourceRoot());
  const workflows = yield* prepareInstall({
    directory: path.join(input.home, "workflows"),
    files: yield* readPack(path.join(source, "workflows")),
    force: input.force,
    managed: true,
  });
  const skillRoot =
    input.skills === undefined ? undefined : path.join(input.skills, "t3factory-orchestrator");
  const skill =
    skillRoot === undefined
      ? undefined
      : yield* prepareInstall({
          directory: skillRoot,
          files: yield* readPack(path.join(source, "skills", "t3factory-orchestrator")),
          force: input.force,
          managed: false,
        });
  const conflicts = [...workflows.conflicts, ...(skill?.conflicts ?? [])];
  if (conflicts.length) return yield* new FactoryPackConflictError({ paths: conflicts });
  const { written, removed } = yield* applyInstall(workflows);
  if (skill) yield* applyInstall(skill);
  if (skillRoot)
    yield* Console.log(`Skill installed at ${skillRoot}; status and uninstall do not manage it.`);
  if (needsWorkflowRestart({ write: written, remove: removed }, workflows.existing))
    yield* Console.log(
      "Restart the server to load this update: a running server keeps the old lib/ helpers.",
    );
});

export const statusFactoryPack = Effect.fn("factoryPack.status")(function* (home: string) {
  const path = yield* Path.Path;
  yield* requireHome(home);
  const directory = path.join(home, "workflows");
  const pack = yield* hashPack(yield* readPack(path.join(yield* sourceRoot(), "workflows")));
  const manifest = yield* readManifest(directory).pipe(
    Effect.catchTags({ FactoryPackError: () => Effect.succeed(null) }),
  );
  const target = yield* readTargets(directory, pack.keys());
  return planStatus({ pack, target, manifest });
});

export const uninstallFactoryPack = Effect.fn("factoryPack.uninstall")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* requireHome(home);
  const directory = path.join(home, "workflows");
  const manifest = yield* readManifest(directory);
  if (manifest === null) return;
  let removedNested = false;
  for (const name of manifest.keys()) {
    const filename = path.join(directory, ...name.split("/"));
    if (name.includes("/") && (yield* fs.exists(filename))) removedNested = true;
    yield* fs.remove(filename, { force: true });
  }
  yield* fs.remove(path.join(directory, FACTORY_PACK_MANIFEST));
  if (removedNested)
    yield* Console.log(
      "Restart the server to finish removing this pack: a running server keeps the old lib/ helpers.",
    );
});

const command = Command.make("factory-pack").pipe(
  Command.withSubcommands([
    Command.make(
      "install",
      {
        home: Flag.String("home"),
        skills: Flag.String("skills").pipe(Flag.optional),
        force: Flag.Boolean("force").pipe(Flag.withDefault(false)),
      },
      ({ home, skills, force }) =>
        installFactoryPack({ home, skills: Option.getOrUndefined(skills), force }),
    ),
    Command.make("status", { home: Flag.String("home") }, ({ home }) =>
      statusFactoryPack(home).pipe(
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            for (const entry of result) yield* Console.log(`${entry.status} ${entry.path}`);
            if (result.some((entry) => entry.status !== "same")) process.exitCode = 1;
          }),
        ),
      ),
    ),
    Command.make("uninstall", { home: Flag.String("home") }, ({ home }) =>
      uninstallFactoryPack(home),
    ),
  ]),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.catchTags({
      FactoryPackHomeError: (error) =>
        Console.error(error.message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      FactoryPackConflictError: (error) =>
        Console.error(error.message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
    }),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
