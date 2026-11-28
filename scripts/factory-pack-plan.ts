import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class FactoryPackError extends Schema.TaggedError<FactoryPackError>()("FactoryPackError", {
  message: Schema.String,
}) {}

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
export const FACTORY_PACK_MANIFEST = ".factory-pack.json";
const validRelativePath = (name: string) =>
  name !== FACTORY_PACK_MANIFEST &&
  name
    .split("/")
    .every(
      (part) =>
        part !== "" && part !== "." && part !== ".." && !part.includes("\\") && !part.includes(":"),
    );
const filePath = (path: Path.Path, root: string, name: string) =>
  path.join(root, ...name.split("/"));

const hash = (bytes: Uint8Array) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

/** Each file's SHA-256 by its pack path, in sorted order, so every source writes one manifest. */
export const hashPack = Effect.fn("factoryPack.hashPack")(function* (
  files: ReadonlyMap<string, Uint8Array>,
) {
  const hashes = new Map<string, string>();
  for (const [name, bytes] of [...files].toSorted(([left], [right]) => (left < right ? -1 : 1))) {
    if (!validRelativePath(name))
      return yield* new FactoryPackError({ message: `Invalid pack path: ${name}` });
    hashes.set(name, yield* hash(bytes));
  }
  return hashes;
});

export const readManifest = Effect.fn("factoryPack.readManifest")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filename = path.join(directory, FACTORY_PACK_MANIFEST);
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

export const readTargets = Effect.fn("factoryPack.readTargets")(function* (
  root: string,
  names: Iterable<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hashes = new Map<string, string>();
  for (const name of names) {
    const filename = filePath(path, root, name);
    if (yield* fs.exists(filename)) hashes.set(name, yield* hash(yield* fs.readFile(filename)));
  }
  return hashes;
});

/**
 * What installing `files` into `directory` would change. Only a `managed` install reads and
 * keeps `.factory-pack.json`, so only it updates its own files and removes those it dropped.
 */
export const prepareInstall = Effect.fn("factoryPack.prepareInstall")(function* (input: {
  readonly directory: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly force: boolean;
  readonly managed: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hashes = yield* hashPack(input.files);
  const manifest = input.managed
    ? yield* readManifest(input.directory).pipe(
        Effect.catchTags({
          FactoryPackError: (error) => (input.force ? Effect.succeed(null) : Effect.fail(error)),
        }),
      )
    : null;
  const target = yield* readTargets(input.directory, hashes.keys());
  const existing =
    target.size > 0 ||
    (input.managed && (yield* fs.exists(path.join(input.directory, FACTORY_PACK_MANIFEST))));
  const plan = planInstall({ pack: hashes, target, manifest, force: input.force });
  return {
    ...input,
    hashes,
    plan,
    existing,
    conflicts: plan.conflicts.map((name) => filePath(path, input.directory, name)),
  };
});

/** Writes what `prepareInstall` planned, or nothing when a file is in the way. */
export const applyInstall = Effect.fn("factoryPack.applyInstall")(function* (
  prepared: Effect.Success<ReturnType<typeof prepareInstall>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { directory, files, plan } = prepared;
  if (prepared.conflicts.length > 0)
    return yield* new FactoryPackConflictError({ paths: prepared.conflicts });
  if (prepared.managed) yield* fs.makeDirectory(directory, { recursive: true });
  const removed: string[] = [];
  for (const name of plan.remove) {
    const filename = filePath(path, directory, name);
    if (yield* fs.exists(filename)) removed.push(name);
    yield* fs.remove(filename, { force: true });
  }
  for (const name of plan.write) {
    const filename = filePath(path, directory, name);
    yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
    const bytes = files.get(name);
    if (bytes !== undefined) yield* fs.writeFile(filename, bytes);
  }
  if (prepared.managed) {
    const manifestJson = `${yield* encodeManifest({
      v: 1,
      files: Object.fromEntries(prepared.hashes),
    })}\n`;
    const manifestPath = path.join(directory, FACTORY_PACK_MANIFEST);
    const previousManifest = (yield* fs.exists(manifestPath))
      ? yield* fs.readFileString(manifestPath)
      : null;
    if (previousManifest !== manifestJson) yield* fs.writeFileString(manifestPath, manifestJson);
  }
  return { written: plan.write, removed };
});
