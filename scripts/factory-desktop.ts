#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Staging uses byte hashes and nonrecursive rmdir at publication.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { matchesSeamGlob, SeamConfig } from "./factory-seams.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import { windowsSystemTar } from "./lib/windows-tar.ts";

class FactoryDesktopError extends Schema.TaggedError<FactoryDesktopError>()("FactoryDesktopError", {
  message: Schema.String,
}) {}

const problem = (message: string) => new FactoryDesktopError({ message });
const root = NodePath.resolve(import.meta.dirname, "..");
const overlayPath = "factory/desktop/overlay.json";
const packModule = "apps/server/src/factory/bundledPack.ts";
const fullCommit = /^[0-9a-f]{40}$/i;
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const Entry = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  find: Schema.String,
  replace: Schema.String,
  why: Schema.String,
  count: Schema.optionalKey(Schema.Int),
});
type Entry = typeof Entry.Type;
const Overlay = Schema.Struct({ v: Schema.Literal(1), entries: Schema.Array(Entry) });
export const decodeOverlay = Schema.decodeUnknownEffect(Schema.fromJsonString(Overlay));

// Each entry is upkeep at every upstream sync. Raise this only with the list written down (D32).
const MAX_ENTRIES = 24;
const excludedDirectory = /^(?:factory|apps\/(?:server|web)\/src\/factory)\//i;
const lockfile =
  /(?:^|\/)(?:[^/]*\.lockb?|[^/]*-lock\.(?:json|ya?ml)|npm-shrinkwrap\.json|Package\.resolved)$/i;

function isAllowedFile(file: string, generated: readonly string[]) {
  const safeSegments = file
    .split("/")
    .every(
      (part) =>
        part.length > 0 &&
        part !== "." &&
        part !== ".." &&
        part.toLowerCase() !== ".git" &&
        !part.includes("\\") &&
        !part.includes(":") &&
        !part.includes("\0") &&
        !/[. ]$/.test(part),
    );
  return (
    safeSegments &&
    !excludedDirectory.test(file) &&
    !lockfile.test(file) &&
    !generated.some((glob) => matchesSeamGlob(glob.toLowerCase(), file.toLowerCase()))
  );
}

export function validateOverlay(
  overlay: typeof Overlay.Type,
  generated: readonly string[],
  tracked: ReadonlySet<string> | null,
) {
  const problems: string[] = [];
  const ids = new Set<string>();
  if (overlay.entries.length > MAX_ENTRIES) {
    problems.push(`A1: ${overlay.entries.length} entries exceeds ${MAX_ENTRIES}`);
  }
  for (const { id, file, find, replace, why, count } of overlay.entries) {
    if (!id.trim() || ids.has(id)) problems.push(`A1 ${id}: missing or duplicate id`);
    ids.add(id);
    if (!/^[^\r\n]+[.!?]$/.test(why.trim()) || /[.!?]\s+\p{Lu}/u.test(why.trim())) {
      problems.push(`A1 ${id}: why must be one sentence`);
    }
    if (!isAllowedFile(file, generated) || tracked?.has(file) === false) {
      problems.push(`A2 ${id}: forbidden or untracked file ${file}`);
    }
    if (!find || find === replace || (count !== undefined && count < 2)) {
      problems.push(
        `A3 ${id}: require a nonempty find, a different replace, and count only for multiple matches`,
      );
    }
  }
  return problems;
}

type Edit = { start: number; end: number; entry: Entry };

export function planEntries(source: string, entries: readonly Entry[]) {
  const edits: Edit[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    let found = 0;
    if (entry.find.length) {
      for (let at = source.indexOf(entry.find); at >= 0; at = source.indexOf(entry.find, at + 1)) {
        edits.push({ start: at, end: at + entry.find.length, entry });
        found++;
      }
    }
    if (found !== (entry.count ?? 1)) {
      problems.push(
        `drift ${entry.id} ${entry.file}: found ${found}, expected ${entry.count ?? 1}`,
      );
    }
  }
  edits.sort((a, b) => a.start - b.start);
  let previous: Edit | undefined;
  for (const edit of edits) {
    if (previous && edit.start < previous.end) {
      problems.push(`A4 ${edit.entry.file}: ${previous.entry.id} overlaps ${edit.entry.id}`);
    }
    if (!previous || edit.end > previous.end) previous = edit;
  }
  return { edits, problems };
}

export function applyEntries(source: string, entries: readonly Entry[], checkout = false) {
  const text = checkout ? source.replaceAll("\r\n", "\n") : source;
  const { edits, problems } = planEntries(text, entries);
  if (problems.length) return { problems, text };
  const parts: string[] = [];
  let offset = 0;
  for (const { start, end, entry } of edits) {
    parts.push(text.slice(offset, start), entry.replace);
    offset = end;
  }
  return { problems, text: parts.join("") + text.slice(offset) };
}

export function renderPackModule(pack: Readonly<Record<string, string>>) {
  // A computed key preserves a file literally named "__proto__" in the object initializer.
  const fields = Object.keys(pack)
    .sort()
    .map((path) => {
      const key = path === "__proto__" ? '["__proto__"]' : JSON.stringify(path);
      return `  ${key}: ${JSON.stringify(pack[path])}`;
    });
  return `export const BUNDLED_FACTORY_PACK: Readonly<Record<string, string>> | null = {\n${fields.join(",\n")}\n};\n`;
}

export const factoryVersion = (version: string, commit: string) =>
  `${version}-factory.g${commit.slice(0, 7).toLowerCase()}`;

export function scrubEnvironment(environment: Readonly<NodeJS.ProcessEnv>) {
  // A terminal opened by T3 Code sets ELECTRON_RUN_AS_NODE and its own T3CODE_* and T3_* variables.
  const names = ["GITHUB_REPOSITORY", "GH_TOKEN", "GITHUB_TOKEN", "ELECTRON_RUN_AS_NODE"];
  const prefixes = [
    "T3CODE_",
    "T3_",
    "VITE_",
    "CSC_",
    "WIN_CSC_",
    "APPLE_",
    "AZURE_",
    "SIGNING_",
    "SIGNTOOL_",
    "SIGNPATH_",
    "WINDOWS_CERTIFICATE",
    "ELECTRON_BUILDER_",
    "GIT_",
  ];
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => {
      const name = key.toUpperCase();
      return !names.includes(name) && !prefixes.some((prefix) => name.startsWith(prefix));
    }),
  );
}

const decodeText = (bytes: Uint8Array, file: string) =>
  Effect.try({
    try: () => {
      if (bytes.includes(0)) throw new Error("binary");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    },
    catch: () => problem(`A2: expected UTF-8 text in ${file}`),
  });
const decodeSeams = Schema.decodeEffect(Schema.fromJsonString(SeamConfig));

const readOverlay = Effect.fn("factoryDesktop.readOverlay")(function* (
  directory: string,
  tracked: ReadonlySet<string> | null,
  checkout: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(NodePath.join(directory, overlayPath));
  const overlay = yield* decodeOverlay(yield* decodeText(bytes, overlayPath)).pipe(
    Effect.mapError((error) => problem(`A1-A3: invalid overlay: ${error.message}`)),
  );
  const seams = yield* decodeSeams(
    yield* fs.readFileString(NodePath.join(directory, "factory/seams.json")),
  );
  const problems = validateOverlay(overlay, seams.generated, tracked);
  const changes = new Map<string, string>();
  for (const [file, entries] of Map.groupBy(overlay.entries, (entry) => entry.file)) {
    if (!isAllowedFile(file, seams.generated) || tracked?.has(file) === false) continue;
    const filename = NodePath.join(directory, file);
    const result = yield* Effect.gen(function* () {
      const regular = (yield* fs.lstat(filename)).type === "File";
      if (!regular || NodePath.relative(filename, yield* fs.realPath(filename)) !== "") {
        return yield* problem("expected a regular file inside the checkout");
      }
      const source = yield* decodeText(yield* fs.readFile(filename), file);
      return applyEntries(source, entries, checkout);
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({ text: "", problems: [`A2 ${file}: ${error.message}`] }),
      ),
    );
    problems.push(...result.problems);
    changes.set(file, result.text);
  }
  if (problems.length) return yield* problem(problems.join("\n"));
  return { overlaySha256: sha256(bytes), applied: overlay.entries.map(({ id }) => id), changes };
});

const check = Effect.fn("factoryDesktop.check")(function* () {
  const fs = yield* FileSystem.FileSystem;
  // The working tree stands in for the commit here; `stage` checks the commit itself.
  const { applied } = yield* readOverlay(yield* fs.realPath(root), null, true);
  yield* Console.log(`factory-desktop: ok (${applied.length} entries)`);
});

function inside(parent: string, child: string) {
  const relative = NodePath.relative(parent, child);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

const destination = Effect.fn("factoryDesktop.destination")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const target = NodePath.resolve(name);
  let ancestor = target;
  while (!(yield* fs.exists(ancestor))) {
    const parent = NodePath.dirname(ancestor);
    if (parent === ancestor) return yield* problem(`Cannot resolve ${target}`);
    ancestor = parent;
  }
  return NodePath.resolve(yield* fs.realPath(ancestor), NodePath.relative(ancestor, target));
});

const run = Effect.fn("factoryDesktop.run")(function* (
  command: string,
  args: readonly string[],
  cwd: string,
  options: {
    readonly input?: Uint8Array;
    readonly capture?: boolean;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
) {
  const env = options.env ?? {
    ...scrubEnvironment(yield* HostProcess.Environment),
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const resolved = yield* resolveSpawnCommand(command, args, { env });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(resolved.command, resolved.args, {
      cwd,
      env,
      extendEnv: false,
      shell: resolved.shell,
      stdin: options.input ? Stream.make(options.input) : "ignore",
      stdout: options.capture ? "pipe" : "inherit",
      stderr: "inherit",
    }),
  );
  const collect = options.capture
    ? Stream.runCollect(child.stdout).pipe(Effect.map((chunks) => Buffer.concat(chunks)))
    : Effect.succeed(Buffer.alloc(0));
  const [stdout, code] = yield* Effect.all([collect, child.exitCode], { concurrency: "unbounded" });
  if (code !== 0) return yield* problem(`${command} ${args.join(" ")} exited with ${code}`);
  return stdout;
}, Effect.scoped);

const exportCommit = Effect.fn("factoryDesktop.exportCommit")(function* (
  commit: string,
  stage: string,
  scratch: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const kind = yield* run("git", ["cat-file", "-t", commit], root, { capture: true });
  if (kind.toString().trim() !== "commit") return yield* problem(`${commit} is not a commit`);
  const objects = yield* run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
    root,
    { capture: true },
  );
  const git = NodePath.join(scratch, "git");
  yield* run(
    "git",
    ["init", "--quiet", "--bare", "--object-format=sha1", "--template=", git],
    scratch,
  );
  yield* fs.makeDirectory(NodePath.join(git, "info"), { recursive: true });
  yield* fs.writeFileString(
    NodePath.join(git, "objects/info/alternates"),
    `${objects.toString().trim().replaceAll("\\", "/")}\n`,
  );
  // info/attributes overrides the commit's checkout filters, including CRLF for batch files.
  yield* fs.writeFileString(
    NodePath.join(git, "info/attributes"),
    "* -text !eol -ident -filter !working-tree-encoding\n",
  );
  const context = [
    `--git-dir=${git}`,
    `--work-tree=${stage}`,
    "-c",
    "core.sparseCheckout=false",
    "-c",
    "core.longpaths=true",
    "-c",
    `core.symlinks=${(yield* HostProcess.Platform) !== "win32"}`,
  ];
  yield* run("git", [...context, "read-tree", commit], stage);
  const listing = yield* run(
    "git",
    [...context, "ls-files", "--stage", "-z", "--", ".", ":(exclude,top).repos/**"],
    stage,
    { capture: true },
  );
  const tracked = new Set<string>();
  const paths: string[] = [];
  for (const record of listing.toString().split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const path = record.slice(tab + 1);
    if (tab < 0 || !/^(100644|100755|120000) [0-9a-f]{40} 0$/.test(record.slice(0, tab))) {
      return yield* problem(`Unsupported Git entry: ${record}`);
    }
    if (!record.startsWith("120000 ")) tracked.add(path);
    paths.push(path);
  }
  yield* run("git", [...context, "checkout-index", "--stdin", "-z"], stage, {
    input: Buffer.from(paths.join("\0") + "\0"),
  });
  return tracked;
});

const Version = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);
const Toolchain = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      engines: Schema.Struct({ node: Schema.String }),
      packageManager: Schema.String,
    }),
  ),
);
const manifest = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

export const stageDesktop = Effect.fn("factoryDesktop.stage")(function* (sha: string, out: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!fullCommit.test(sha)) return yield* problem("stage requires a full 40-hex commit SHA");
  const commit = sha.toLowerCase();
  const target = yield* destination(out);
  if (inside(yield* fs.realPath(root), target))
    return yield* problem("--out is inside the repository");
  if (yield* fs.exists(target)) {
    if ((yield* fs.stat(target)).type !== "Directory" || (yield* fs.readDirectory(target)).length) {
      return yield* problem(`--out must be an empty directory: ${target}`);
    }
  }
  const directory = NodePath.dirname(target);
  yield* fs.makeDirectory(directory, { recursive: true });
  const scratch = yield* fs.makeTempDirectoryScoped({ directory, prefix: "f-" });
  const stage = NodePath.join(scratch, "s");
  yield* fs.makeDirectory(stage);
  const tracked = yield* exportCommit(commit, stage, scratch);
  if (!tracked.has(packModule) || !tracked.has(overlayPath)) {
    return yield* problem(`The selected commit must contain ${packModule} and ${overlayPath}`);
  }
  const { changes, applied, overlaySha256 } = yield* readOverlay(stage, tracked, false);
  for (const [file, text] of changes) yield* fs.writeFileString(NodePath.join(stage, file), text);
  const prefix = "factory/workflows/";
  const files: Array<{ path: string; sha256: string }> = [];
  const pack = new Map<string, string>();
  for (const file of [...tracked].filter((path) => path.startsWith(prefix)).sort()) {
    const path = file.slice(prefix.length);
    const bytes = yield* fs.readFile(NodePath.join(stage, file));
    pack.set(path, yield* decodeText(bytes, file));
    files.push({ path, sha256: sha256(bytes) });
  }
  if (!files.length) return yield* problem("The selected commit has no workflow pack");
  yield* fs.writeFileString(
    NodePath.join(stage, packModule),
    renderPackModule(Object.fromEntries(pack)),
  );
  const desktop = yield* Version(
    yield* fs.readFileString(NodePath.join(stage, "apps/desktop/package.json")),
  );
  const version = factoryVersion(desktop.version, commit);
  const receipt = { commit, version, overlaySha256, applied, files };
  yield* fs.writeFileString(NodePath.join(stage, "factory-desktop-stage.json"), manifest(receipt), {
    flag: "wx",
  });
  // Windows requires an absent rename destination; nonrecursive removal refuses a newly populated directory.
  if (yield* fs.exists(target)) {
    yield* Effect.tryPromise({
      try: () => NodeFSP.rmdir(target),
      catch: (e) => problem(String(e)),
    });
  }
  yield* fs.rename(stage, target);
  return receipt;
}, Effect.scoped);

const rejectUpdateFiles = Effect.fn("factoryDesktop.rejectUpdateFiles")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs.readDirectory(directory, { recursive: true });
  const forbidden = names.filter((name) =>
    /^(?:app-update|latest.*)\.yml$/i.test(NodePath.basename(name)),
  );
  if (forbidden.length)
    return yield* problem(`Unexpected update metadata: ${forbidden.join(", ")}`);
});

const build = Effect.fn("factoryDesktop.build")(function* (
  sha: string,
  out: string,
  requestedStage: string | undefined,
  keepStage: boolean,
) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32") return yield* problem(`build requires Windows x64, found ${platform}`);
  const arch = yield* getDefaultBuildArch("win", { archChoices: ["arm64", "x64"] });
  if (arch !== "x64" || (yield* HostProcess.Architecture) !== "x64") {
    return yield* problem("build requires a native Windows x64 host and Node runtime");
  }
  if (!fullCommit.test(sha)) return yield* problem("build requires a full 40-hex commit SHA");
  const fs = yield* FileSystem.FileSystem;
  const output = yield* destination(out);
  if (inside(yield* fs.realPath(root), output)) {
    return yield* problem("--out is inside the repository");
  }
  const makeTemp = keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stage =
    requestedStage === undefined
      ? NodePath.join(yield* makeTemp({ prefix: "f-" }), "s")
      : yield* destination(requestedStage);
  if (inside(stage, output) || inside(output, stage)) {
    return yield* problem("--out and --stage must be separate directories");
  }

  const receipt = yield* stageDesktop(sha, stage);
  if (requestedStage !== undefined && !keepStage) {
    yield* Effect.addFinalizer(() => fs.remove(stage, { recursive: true }).pipe(Effect.orDie));
  }
  if (keepStage) yield* Console.log(`Stage: ${stage}`);
  yield* fs.makeDirectory(output, { recursive: true });
  yield* rejectUpdateFiles(output);
  const temp = yield* fs.makeTempDirectoryScoped({ directory: output, prefix: ".factory-" });
  const dist = NodePath.join(temp, "dist");
  const unpacked = NodePath.join(temp, "win-unpacked");
  const toolchain = yield* Toolchain(
    yield* fs.readFileString(NodePath.join(stage, "package.json")),
  );
  const env = scrubEnvironment(yield* HostProcess.Environment);
  const pinned = [
    "env",
    "exec",
    "--node",
    toolchain.engines.node,
    "--package-manager",
    toolchain.packageManager,
    "--",
    "vp",
  ];
  yield* run("vp", [...pinned, "install", "--frozen-lockfile"], stage, { env });
  yield* run(
    "vp",
    [
      ...pinned,
      "exec",
      "--",
      "node",
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "win",
      "--arch",
      "x64",
      "--target",
      "zip",
      "--build-version",
      receipt.version,
      "--output-dir",
      dist,
    ],
    stage,
    // On a Windows host upstream's afterPack hook adds about 37 compile-cache files, and its own
    // 80-file payload check then refuses the app. This skips that hook and the bundle self-check.
    { env: { ...env, T3CODE_DESKTOP_UNTRUSTED_BUNDLE: "true" } },
  );

  const zip = `T3-Factory-v2-${receipt.version}-x64.zip`;
  const artifacts: Array<{ name: string; size: number; sha256: string }> = [];
  for (const name of (yield* fs.readDirectory(dist)).sort()) {
    const file = NodePath.join(dist, name);
    const stat = yield* fs.lstat(file);
    if (stat.type !== "File") return yield* problem(`Unexpected build output: ${name}`);
    const hash = NodeCrypto.createHash("sha256");
    yield* Stream.runForEach(fs.stream(file), (chunk) => Effect.sync(() => hash.update(chunk)));
    artifacts.push({ name, size: Number(stat.size), sha256: hash.digest("hex") });
  }
  if (!artifacts.some(({ name }) => name === zip)) {
    return yield* problem(`Missing Windows artifact: ${zip}`);
  }
  yield* fs.makeDirectory(unpacked);
  yield* run(windowsSystemTar(), ["-xf", NodePath.join(dist, zip), "-C", unpacked], temp, { env });
  if (!(yield* fs.exists(NodePath.join(unpacked, "T3 Factory v2.exe")))) {
    return yield* problem("The zip has no T3 Factory v2.exe at its root");
  }
  yield* rejectUpdateFiles(temp);
  const unpackedApp = NodePath.join(output, `win-unpacked-${NodeCrypto.randomUUID()}`);
  yield* fs.rename(unpacked, unpackedApp);
  for (const { name } of artifacts) {
    yield* fs.rename(NodePath.join(dist, name), NodePath.join(output, name));
  }
  const buildReceipt = {
    commit: receipt.commit,
    version: receipt.version,
    overlaySha256: receipt.overlaySha256,
    artifacts,
    unpackedApp,
  };
  const receiptFile = "factory-desktop-build.json";
  yield* fs.writeFileString(NodePath.join(temp, receiptFile), manifest(buildReceipt));
  yield* fs.rename(NodePath.join(temp, receiptFile), NodePath.join(output, receiptFile));
  yield* Console.log(`Built ${NodePath.join(output, zip)}`);
}, Effect.scoped);

const flags = { sha: Flag.String("sha"), out: Flag.String("out") };
const command = Command.make("factory-desktop").pipe(
  Command.withSubcommands([
    Command.make("check", {}, () => check()),
    Command.make("stage", flags, ({ sha, out }) => stageDesktop(sha, out).pipe(Effect.asVoid)),
    Command.make(
      "build",
      {
        ...flags,
        stage: Flag.String("stage").pipe(Flag.optional),
        keepStage: Flag.Boolean("keep-stage").pipe(Flag.withDefault(false)),
      },
      ({ sha, out, stage, keepStage }) => build(sha, out, Option.getOrUndefined(stage), keepStage),
    ),
  ]),
);

if (import.meta.main) {
  Command.run(command, { version: "1" }).pipe(
    Effect.catchTags({
      FactoryDesktopError: (error) =>
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
