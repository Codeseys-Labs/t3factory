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

export class FactoryPackError extends Schema.TaggedError<FactoryPackError>()("FactoryPackError", {
  message: Schema.String,
}) {}

export class FactoryPackHomeError extends Schema.TaggedError<FactoryPackHomeError>()(
  "FactoryPackHomeError",
  { home: Schema.String },
) {
  override get message(): string {
    return `Home must be an existing directory: ${this.home}`;
  }
}

export class FactoryPackConflictError extends Schema.TaggedError<FactoryPackConflictError>()(
  "FactoryPackConflictError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Conflicts: ${this.paths.join(", ")}`;
  }
}

interface PlanInput {
  readonly pack: ReadonlyMap<string, string>;
  readonly target: ReadonlyMap<string, string>;
  readonly manifest: ReadonlyMap<string, string> | null;
}

export const planInstall = (input: PlanInput & { readonly force: boolean }) => {
  const conflicts: string[] = [];
  const write: string[] = [];
  const unchanged: string[] = [];
  const remove: string[] = [];
  for (const [name, hash] of input.pack) {
    const current = input.target.get(name);
    if (current === hash) unchanged.push(name);
    else if (current !== undefined && !input.manifest?.has(name) && !input.force)
      conflicts.push(name);
    else write.push(name);
  }
  for (const name of input.manifest?.keys() ?? []) {
    if (!input.pack.has(name)) remove.push(name);
  }
  return {
    conflicts,
    write: conflicts.length ? [] : write,
    remove: conflicts.length ? [] : remove,
    unchanged,
  };
};

export const needsWorkflowRestart = (
  changes: {
    readonly write: ReadonlyArray<string>;
    readonly remove: ReadonlyArray<string>;
  },
  existing: boolean,
) =>
  existing &&
  (changes.write.some((name) => name.includes("/")) ||
    changes.remove.some((name) => name.includes("/")));

export const planStatus = (input: PlanInput) => {
  const result: Array<{
    readonly path: string;
    readonly status: "same" | "changed" | "missing" | "stale";
  }> = [];
  for (const [name, hash] of input.pack) {
    const current = input.target.get(name);
    result.push({
      path: name,
      status: current === undefined ? "missing" : current === hash ? "same" : "changed",
    });
  }
  for (const name of input.manifest?.keys() ?? []) {
    if (!input.pack.has(name)) result.push({ path: name, status: "stale" });
  }
  return result;
};

const Manifest = Schema.Struct({
  v: Schema.Literal(1),
  files: Schema.Record(Schema.String, Schema.String),
});
const ManifestJson = Schema.fromJsonString(Manifest);
const decodeManifest = Schema.decodeUnknownEffect(ManifestJson);
const encodeManifest = Schema.encodeEffect(ManifestJson);
const manifestName = ".factory-pack.json";
const validRelativePath = (name: string) =>
  name !== manifestName &&
  name
    .split("/")
    .every(
      (part) =>
        part !== "" && part !== "." && part !== ".." && !part.includes("\\") && !part.includes(":"),
    );

const hash = (bytes: Uint8Array) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

const readPack = Effect.fn("factoryPack.readPack")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = new Map<string, Uint8Array>();
  const hashes = new Map<string, string>();
  for (const entry of (yield* fs.readDirectory(root, { recursive: true })).sort()) {
    const absolute = path.join(root, entry);
    if ((yield* fs.stat(absolute)).type !== "File") continue;
    const name = entry.replaceAll("\\", "/");
    if (!validRelativePath(name))
      return yield* new FactoryPackError({ message: `Invalid pack path: ${name}` });
    const bytes = yield* fs.readFile(absolute);
    files.set(name, bytes);
    hashes.set(name, yield* hash(bytes));
  }
  return { files, hashes };
});

const readManifest = Effect.fn("factoryPack.readManifest")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filename = path.join(directory, manifestName);
  if (!(yield* fs.exists(filename))) return null;
  const manifest = yield* decodeManifest(yield* fs.readFileString(filename)).pipe(
    Effect.mapError(() => new FactoryPackError({ message: `Invalid manifest: ${filename}` })),
  );
  const entries = Object.entries(manifest.files);
  if (
    entries.some(([name, digest]) => !validRelativePath(name) || !/^[a-f0-9]{64}$/.test(digest))
  ) {
    return yield* new FactoryPackError({ message: `Invalid manifest: ${filename}` });
  }
  return new Map(entries);
});

const readTargets = Effect.fn("factoryPack.readTargets")(function* (
  root: string,
  names: Iterable<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hashes = new Map<string, string>();
  for (const name of names) {
    const filename = path.join(root, ...name.split("/"));
    if (yield* fs.exists(filename)) hashes.set(name, yield* hash(yield* fs.readFile(filename)));
  }
  return hashes;
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* requireHome(input.home);
  const source = input.source ?? (yield* sourceRoot());
  const directory = path.join(input.home, "workflows");
  const pack = yield* readPack(path.join(source, "workflows"));
  const manifest = yield* readManifest(directory).pipe(
    Effect.catchTags({
      FactoryPackError: (error) => (input.force ? Effect.succeed(null) : Effect.fail(error)),
    }),
  );
  const target = yield* readTargets(directory, pack.hashes.keys());
  const existing = target.size > 0 || (yield* fs.exists(path.join(directory, manifestName)));
  const plan = planInstall({ pack: pack.hashes, target, manifest, force: input.force });
  const skillRoot =
    input.skills === undefined ? undefined : path.join(input.skills, "t3factory-orchestrator");
  const skill =
    skillRoot === undefined
      ? undefined
      : yield* readPack(path.join(source, "skills", "t3factory-orchestrator"));
  const skillPlan =
    skill === undefined || skillRoot === undefined
      ? undefined
      : planInstall({
          pack: skill.hashes,
          target: yield* readTargets(skillRoot, skill.hashes.keys()),
          manifest: null,
          force: input.force,
        });
  const conflicts = [
    ...plan.conflicts.map((name) => path.join(directory, ...name.split("/"))),
    ...(skillPlan?.conflicts.map((name) => path.join(skillRoot ?? "", ...name.split("/"))) ?? []),
  ];
  if (conflicts.length) return yield* new FactoryPackConflictError({ paths: conflicts });
  yield* fs.makeDirectory(directory, { recursive: true });
  const removed: string[] = [];
  for (const name of plan.remove) {
    const filename = path.join(directory, ...name.split("/"));
    if (yield* fs.exists(filename)) removed.push(name);
    yield* fs.remove(filename, { force: true });
  }
  for (const name of plan.write) {
    const filename = path.join(directory, ...name.split("/"));
    yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
    const bytes = pack.files.get(name);
    if (bytes !== undefined) yield* fs.writeFile(filename, bytes);
  }
  if (skill && skillPlan && skillRoot) {
    for (const name of skillPlan.write) {
      const filename = path.join(skillRoot, ...name.split("/"));
      yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
      const bytes = skill.files.get(name);
      if (bytes !== undefined) yield* fs.writeFile(filename, bytes);
    }
  }
  const manifestJson = `${yield* encodeManifest({ v: 1, files: Object.fromEntries(pack.hashes) })}\n`;
  const manifestPath = path.join(directory, manifestName);
  const previousManifest = (yield* fs.exists(manifestPath))
    ? yield* fs.readFileString(manifestPath)
    : null;
  if (previousManifest !== manifestJson) yield* fs.writeFileString(manifestPath, manifestJson);
  if (skillRoot)
    yield* Console.log(`Skill installed at ${skillRoot}; status and uninstall do not manage it.`);
  if (needsWorkflowRestart({ write: plan.write, remove: removed }, existing))
    yield* Console.log(
      "Restart the server to load this update: a running server keeps the old lib/ helpers.",
    );
});

export const statusFactoryPack = Effect.fn("factoryPack.status")(function* (home: string) {
  const path = yield* Path.Path;
  yield* requireHome(home);
  const directory = path.join(home, "workflows");
  const pack = yield* readPack(path.join(yield* sourceRoot(), "workflows"));
  const manifest = yield* readManifest(directory).pipe(
    Effect.catchTags({ FactoryPackError: () => Effect.succeed(null) }),
  );
  const target = yield* readTargets(directory, pack.hashes.keys());
  return planStatus({ pack: pack.hashes, target, manifest });
});

export const uninstallFactoryPack = Effect.fn("factoryPack.uninstall")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* requireHome(home);
  const directory = path.join(home, "workflows");
  const manifest = yield* readManifest(directory);
  if (manifest === null) return;
  for (const name of manifest.keys())
    yield* fs.remove(path.join(directory, ...name.split("/")), { force: true });
  yield* fs.remove(path.join(directory, manifestName));
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
