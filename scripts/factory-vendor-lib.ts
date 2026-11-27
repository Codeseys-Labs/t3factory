// @effect-diagnostics nodeBuiltinImport:off - Non-recursive directory removal and explicit close errors require Node APIs.

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFSP from "node:fs/promises";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const BYTES_MAX = 104857600;
const COMPONENTS = ["cliproxyapi", "management-center"];
const SOURCES: Readonly<Record<string, string>> = {
  cliproxyapi: "https://github.com/router-for-me/CLIProxyAPI",
  "management-center": "https://github.com/router-for-me/Cli-Proxy-API-Management-Center",
};
const PLATFORMS: Readonly<Record<string, ReadonlyArray<string>>> = {
  cliproxyapi: ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"],
  "management-center": ["any"],
};
const SUFFIXES: Readonly<Record<string, string>> = {
  "win32-x64": "windows_amd64.zip",
  "darwin-arm64": "darwin_aarch64.tar.gz",
  "darwin-x64": "darwin_amd64.tar.gz",
  "linux-x64": "linux_amd64.tar.gz",
  "linux-arm64": "linux_aarch64.tar.gz",
};

export const isNetworkPath = (folder: string, platform: string): boolean =>
  platform === "win32" && /^[\\/]{2}/.test(folder);
const ALLOWED_HOSTS = ["github.com", "raw.githubusercontent.com"];
const REDIRECT_HOSTS = [...ALLOWED_HOSTS, "release-assets.githubusercontent.com"];
const Hashed = { url: Schema.String, bytes: Schema.Number, sha256: Schema.String };
const Manifest = Schema.Struct({
  v: Schema.Literal(1),
  components: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      source: Schema.String,
      publishedAt: Schema.String,
      retrievedAt: Schema.String,
      license: Schema.Struct({ id: Schema.String, ...Hashed }),
      assets: Schema.Array(Schema.Struct({ platform: Schema.String, ...Hashed })),
      requires: Schema.NullOr(
        Schema.Struct({
          component: Schema.Literal("cliproxyapi"),
          min: Schema.String,
          below: Schema.String,
        }),
      ),
    }),
  ),
});
const decodeManifest = Schema.decodeUnknownSync(Manifest);
type Manifest = typeof Manifest.Type;

class VendorError extends Schema.TaggedError<VendorError>()("VendorError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}
const toVendorError = (cause: unknown) =>
  new VendorError({ message: cause instanceof Error ? cause.message : String(cause), cause });

export type Report = {
  exitCode: 0 | 1;
  stdout: ReadonlyArray<string>;
  stderr: ReadonlyArray<string>;
};
export type Download = (url: string) => Effect.Effect<
  {
    status: number;
    location: string | null;
    body: Uint8Array;
  },
  Error
>;

export type PinnedFile = {
  readonly role: "archive" | "proxy-license" | "console" | "console-license";
  readonly label: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
};

const exactVersion = (value: string) => /^\d+\.\d+\.\d+(?![\s\S])/.test(value);
const compareVersions = (left: string, right: string) => {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
};
const timestamp = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z(?![\s\S])/.test(value)) return false;
  const date = DateTime.make(value);
  return Option.isSome(date) && `${DateTime.formatIso(date.value).slice(0, 19)}Z` === value;
};

const parseManifest = (
  text: string | null,
): { manifest: Manifest; problems: [] } | { problems: string[] } => {
  if (text === null) return { problems: ["manifest: cannot be read"] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problems: ["manifest: not valid JSON"] };
  }
  let manifest: Manifest;
  try {
    manifest = decodeManifest(value, { onExcessProperty: "error" });
  } catch (error) {
    return { problems: [`schema: ${String(error)}`] };
  }
  const problems = new Set<string>();
  if (manifest.components.map((component) => component.name).join(",") !== COMPONENTS.join(",")) {
    problems.add("manifest: components must be cliproxyapi,management-center");
  }
  const proxy = manifest.components.find((component) => component.name === "cliproxyapi");
  const seenUrls = new Set<string>();
  const seenHashes = new Set<string>();
  for (const component of manifest.components) {
    const { name, version, source, publishedAt, retrievedAt, requires } = component;
    const versionValid = exactVersion(version);
    const expectedSource = Object.hasOwn(SOURCES, name) ? SOURCES[name] : undefined;
    const sourceValid = source === expectedSource;
    if (!versionValid) problems.add(`${name}: version ${version} is not an exact x.y.z`);
    if (!sourceValid) problems.add(`${name}: source must be ${expectedSource}`);
    const publishedValid = timestamp(publishedAt);
    const retrievedValid = timestamp(retrievedAt);
    if (!publishedValid)
      problems.add(`${name}: publishedAt is not a UTC timestamp YYYY-MM-DDTHH:MM:SSZ`);
    if (!retrievedValid)
      problems.add(`${name}: retrievedAt is not a UTC timestamp YYYY-MM-DDTHH:MM:SSZ`);
    if (
      publishedValid &&
      retrievedValid &&
      Date.parse(retrievedAt) - Date.parse(publishedAt) < 168 * 3600 * 1000
    ) {
      problems.add(`${name}: retrievedAt is less than 168 hours after publishedAt`);
    }
    const platforms = Object.hasOwn(PLATFORMS, name) ? PLATFORMS[name] : undefined;
    if (
      platforms &&
      component.assets.map((asset) => asset.platform).join(",") !== platforms.join(",")
    ) {
      problems.add(`${name}: platforms must be ${platforms.join(",")}`);
    }
    if (name === "cliproxyapi" && requires !== null)
      problems.add("cliproxyapi: requires must be null");
    if (name === "management-center") {
      if (requires === null) {
        problems.add("management-center: requires is missing");
      } else if (
        !exactVersion(requires.min) ||
        !exactVersion(requires.below) ||
        compareVersions(requires.min, requires.below) >= 0
      ) {
        problems.add(
          "management-center: requires.min and requires.below must be exact x.y.z with min below below",
        );
      } else if (
        proxy &&
        exactVersion(proxy.version) &&
        (compareVersions(proxy.version, requires.min) < 0 ||
          compareVersions(proxy.version, requires.below) >= 0)
      ) {
        problems.add(
          `management-center: cliproxyapi ${proxy.version} is outside >=${requires.min} <${requires.below}`,
        );
      }
    }
    const entries = [
      ...component.assets.map((asset) => ({ ...asset, label: asset.platform, license: false })),
      { ...component.license, label: "license", license: true },
    ];
    const seenPlatforms = new Set<string>();
    for (const entry of entries) {
      const where = `${name}/${entry.label}`;
      let url: URL | undefined;
      try {
        url = new URL(entry.url);
      } catch {
        problems.add(`${where}: url is not a valid URL`);
      }
      if (url) {
        if (url.protocol !== "https:") problems.add(`${where}: url is not https`);
        else if (!ALLOWED_HOSTS.includes(url.hostname))
          problems.add(`${where}: host ${url.hostname} is not allowed`);
        else if (versionValid && sourceValid) {
          const sourcePath = new URL(source).pathname;
          const filename =
            name === "management-center" && entry.label === "any"
              ? "management.html"
              : name === "cliproxyapi" && Object.hasOwn(SUFFIXES, entry.label)
                ? `CLIProxyAPI_${version}_${SUFFIXES[entry.label]}`
                : null;
          const expectedHost = entry.license ? "raw.githubusercontent.com" : "github.com";
          const expectedPath = entry.license
            ? `${sourcePath}/v${version}/LICENSE`
            : `${sourcePath}/releases/download/v${version}/${filename}`;
          if (
            entry.url !== `https://${expectedHost}${expectedPath}` ||
            (!entry.license && filename === null)
          ) {
            problems.add(`${where}: url is not pinned to ${name} ${version}`);
          }
        }
      }
      if (!/^[0-9a-f]{64}(?![\s\S])/.test(entry.sha256))
        problems.add(`${where}: sha256 is not 64 lower-case hex`);
      if (!Number.isInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > BYTES_MAX)
        problems.add(`${where}: bytes must be an integer from 1 to 104857600`);
      if (entry.license && component.license.id !== "MIT")
        problems.add(`${where}: id ${component.license.id} is not allowed`);
      if (seenUrls.has(entry.url)) problems.add(`${where}: duplicate url`);
      if (seenHashes.has(entry.sha256)) problems.add(`${where}: duplicate sha256`);
      if (!entry.license && seenPlatforms.has(entry.label))
        problems.add(`${where}: duplicate platform`);
      seenUrls.add(entry.url);
      seenHashes.add(entry.sha256);
      if (!entry.license) seenPlatforms.add(entry.label);
    }
  }
  return problems.size ? { problems: [...problems].sort() } : { manifest, problems: [] };
};

export const vendorProblems = (text: string | null): ReadonlyArray<string> =>
  parseManifest(text).problems;
export const assetFile = (name: string, version: string, url: string | null) =>
  `${name}-${version}/${url === null ? "LICENSE" : new URL(url).pathname.split("/").pop()}`;

export const pinnedFor = (
  manifestText: string | null,
  platform: string,
):
  | { readonly problems: ReadonlyArray<string> }
  | {
      readonly proxy: string;
      readonly console: string;
      readonly files: ReadonlyArray<PinnedFile> | null;
    } => {
  const parsed = parseManifest(manifestText);
  if (!("manifest" in parsed)) return { problems: parsed.problems };
  const proxy = parsed.manifest.components[0]!;
  const console = parsed.manifest.components[1]!;
  const archive = proxy.assets.find((asset) => asset.platform === platform);
  if (!archive) return { proxy: proxy.version, console: console.version, files: null };
  const panel = console.assets[0]!;
  return {
    proxy: proxy.version,
    console: console.version,
    files: [
      {
        role: "archive",
        label: `${proxy.name} ${proxy.version} ${archive.platform}`,
        url: archive.url,
        bytes: archive.bytes,
        sha256: archive.sha256,
      },
      {
        role: "proxy-license",
        label: `${proxy.name} ${proxy.version} license`,
        url: proxy.license.url,
        bytes: proxy.license.bytes,
        sha256: proxy.license.sha256,
      },
      {
        role: "console",
        label: `${console.name} ${console.version} ${panel.platform}`,
        url: panel.url,
        bytes: panel.bytes,
        sha256: panel.sha256,
      },
      {
        role: "console-license",
        label: `${console.name} ${console.version} license`,
        url: console.license.url,
        bytes: console.license.bytes,
        sha256: console.license.sha256,
      },
    ],
  };
};

const files = (manifest: Manifest) =>
  manifest.components.flatMap((component) => [
    ...component.assets.map((asset) => ({
      ...asset,
      label: `${component.name} ${component.version} ${asset.platform}`,
      file: assetFile(component.name, component.version, asset.url),
    })),
    {
      ...component.license,
      label: `${component.name} ${component.version} license`,
      file: assetFile(component.name, component.version, null),
    },
  ]);
const invalidReport = (problems: ReadonlyArray<string>): Report => ({
  exitCode: 1,
  stdout: [],
  stderr: problems.map((problem) => `invalid ${problem}`),
});
export const checkVendor = (text: string | null): Report => {
  const parsed = parseManifest(text);
  if (!("manifest" in parsed)) return invalidReport(parsed.problems);
  return {
    exitCode: 0,
    stdout: parsed.manifest.components.map(({ name, version }) => `ok ${name} ${version}`),
    stderr: [],
  };
};

export const sha256Hex = (bytes: Uint8Array) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

export const makeDownload =
  (input: {
    transport: typeof globalThis.fetch;
    maxBytes: number;
    abortable?: boolean;
  }): Download =>
  (url) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await input.transport(url, {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": "factory-vendor/1" },
          ...(input.abortable ? { signal } : {}),
        });
        const location = response.headers.get("location");
        if (response.status !== 200) {
          if (response.body) await response.body.cancel().catch(() => {});
          return { status: response.status, location, body: new Uint8Array() };
        }
        if (!response.body) return { status: response.status, location, body: new Uint8Array() };
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.length;
            if (length > input.maxBytes) {
              await reader.cancel().catch(() => {});
              throw new VendorError({
                message: `body exceeds ${input.maxBytes} bytes`,
                cause: null,
              });
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        return { status: response.status, location, body };
      },
      catch: toVendorError,
    });

export const liveDownload: Download = (url) =>
  makeDownload({ transport: globalThis.fetch, maxBytes: BYTES_MAX, abortable: true })(url);

export const statusVendor = Effect.fn("factoryVendor.status")(function* (input: {
  manifestText: string | null;
  dir: string | null;
}): Effect.fn.Return<Report, never, FileSystem.FileSystem | Path.Path> {
  const parsed = parseManifest(input.manifestText);
  if (!("manifest" in parsed)) return invalidReport(parsed.problems);
  const entries = files(parsed.manifest);
  if (input.dir === null)
    return {
      exitCode: 0,
      stdout: entries.map((entry) => `pinned ${entry.label} ${entry.bytes} ${entry.sha256}`),
      stderr: [],
    } satisfies Report;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stdout: string[] = [];
  let exitCode: 0 | 1 = 0;
  for (const entry of entries) {
    const filename = path.join(input.dir, ...entry.file.split("/"));
    const stat = yield* fs.lstat(filename).pipe(Effect.result);
    let state: string;
    if (Result.isFailure(stat))
      state = stat.failure.reason._tag === "NotFound" ? "missing" : "unreadable";
    else if (stat.success.type !== "File") state = "not-file";
    else {
      const read = yield* fs.readFile(filename).pipe(Effect.result);
      if (Result.isFailure(read)) state = "unreadable";
      else if (read.success.length !== entry.bytes) state = "size";
      else state = (yield* sha256Hex(read.success)) === entry.sha256 ? "same" : "hash";
    }
    if (state !== "same") exitCode = 1;
    stdout.push(`${state} ${entry.label} ${entry.file}`);
  }
  return { exitCode, stdout, stderr: [] } satisfies Report;
});

const resolveRoot = Effect.fn("factoryVendor.resolveRoot")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(root);
  const rest: string[] = [];
  while (true) {
    const resolved = yield* fs.realPath(current).pipe(Effect.result);
    if (Result.isSuccess(resolved)) return path.join(resolved.success, ...rest.reverse());
    if (resolved.failure.reason._tag !== "NotFound") return yield* resolved.failure;
    const parent = path.dirname(current);
    if (parent === current) return yield* resolved.failure;
    rest.push(path.basename(current));
    current = parent;
  }
});

const fetchBody = Effect.fn("factoryVendor.fetchBody")(function* (url: string, download: Download) {
  let current = url;
  let redirects = 0;
  while (true) {
    const result = yield* download(current).pipe(Effect.mapError(toVendorError), Effect.result);
    if (Result.isFailure(result)) return { error: `network ${result.failure.message}` };
    const { status, location, body } = result.success;
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (redirects >= 3) return { error: "more than 3 redirects" };
      if (location === null) return { error: "redirect without location" };
      const parsed = yield* Effect.try({
        try: () => new URL(location, current),
        catch: toVendorError,
      }).pipe(Effect.result);
      if (Result.isFailure(parsed)) return { error: "redirect invalid location" };
      const next = parsed.success;
      if (next.protocol !== "https:") return { error: "redirect is not https" };
      if (next.username || next.password) return { error: "redirect has credentials" };
      if (next.port) return { error: "redirect has a port" };
      if (!REDIRECT_HOSTS.includes(next.hostname))
        return { error: `redirect to ${next.hostname} is not allowed` };
      current = next.href;
      redirects++;
      continue;
    }
    if (status !== 200) return { error: `status ${status}` };
    return { body };
  }
});

const fetchVerified = Effect.fn("factoryVendor.fetchVerified")(function* (
  file: Pick<PinnedFile, "url" | "bytes" | "sha256" | "label">,
  download: Download,
): Effect.fn.Return<
  { readonly body: Uint8Array } | { readonly failure: "download" | "verify"; readonly line: string }
> {
  const result = yield* fetchBody(file.url, download);
  if ("error" in result)
    return { failure: "download", line: `failed ${file.label}: ${result.error}` };
  const body = result.body;
  if (body.length !== file.bytes)
    return {
      failure: "verify",
      line: `failed ${file.label}: expected ${file.bytes} bytes, got ${body.length}`,
    };
  const digest = yield* sha256Hex(body);
  if (digest !== file.sha256)
    return {
      failure: "verify",
      line: `failed ${file.label}: sha256 expected ${file.sha256}, got ${digest}`,
    };
  return { body };
});

export const fetchPinned = fetchVerified;

export const fetchVendor = Effect.fn("factoryVendor.fetch")(function* (input: {
  manifestText: string | null;
  dir: string;
  download: Download;
  repoRoot: string;
  home: string;
}): Effect.fn.Return<Report, never, FileSystem.FileSystem | Path.Path> {
  const parsed = parseManifest(input.manifestText);
  if (!("manifest" in parsed)) return invalidReport(parsed.problems);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const target = path.resolve(input.dir);
  if (isNetworkPath(input.dir, platform) || isNetworkPath(target, platform))
    return {
      exitCode: 1,
      stdout: [],
      stderr: [`refused: ${target} is a network or device path`],
    } satisfies Report;
  const parent = path.dirname(target);
  const parentStat = yield* fs.stat(parent).pipe(Effect.result);
  if (Result.isFailure(parentStat) || parentStat.success.type !== "Directory")
    return {
      exitCode: 1,
      stdout: [],
      stderr: [`refused: ${parent} is not an existing directory`],
    } satisfies Report;
  const realParent = yield* fs.realPath(parent).pipe(Effect.result);
  if (Result.isFailure(realParent))
    return {
      exitCode: 1,
      stdout: [],
      stderr: [`refused: ${parent} is not an existing directory`],
    } satisfies Report;
  const folder = path.join(realParent.success, path.basename(target));
  if (isNetworkPath(folder, platform))
    return {
      exitCode: 1,
      stdout: [],
      stderr: [`refused: ${folder} is a network or device path`],
    } satisfies Report;
  const roots = [
    { path: input.repoRoot, label: "the repository" },
    { path: path.join(input.home, ".t3"), label: "~/.t3" },
    { path: path.join(input.home, ".t3factory"), label: "~/.t3factory" },
  ];
  for (const root of roots) {
    const resolved = yield* resolveRoot(root.path).pipe(Effect.result);
    if (Result.isFailure(resolved))
      return {
        exitCode: 1,
        stdout: [],
        stderr: [`refused: ${folder} cannot be inspected`],
      } satisfies Report;
    const insensitive = platform === "win32" || platform === "darwin";
    const relative = path.relative(
      insensitive ? resolved.success.toLowerCase() : resolved.success,
      insensitive ? folder.toLowerCase() : folder,
    );
    if (relative === "" || (!path.isAbsolute(relative) && relative.split(/[\\/]/)[0] !== ".."))
      return {
        exitCode: 1,
        stdout: [],
        stderr: [`refused: ${folder} is inside ${root.label}`],
      } satisfies Report;
  }
  const existing = yield* fs.lstat(folder).pipe(Effect.result);
  if (Result.isSuccess(existing))
    return {
      exitCode: 1,
      stdout: [],
      stderr: [`refused: ${folder} already exists`],
    } satisfies Report;
  if (existing.failure.reason._tag !== "NotFound")
    return {
      exitCode: 1,
      stdout: [],
      stderr: [`refused: ${folder} cannot be inspected`],
    } satisfies Report;
  const created: Array<{ path: string; directory: boolean }> = [];
  const stdout: string[] = [];
  let failure: string | undefined;
  const made = yield* fs.makeDirectory(folder, { recursive: false }).pipe(Effect.result);
  if (Result.isFailure(made)) {
    if (made.failure.reason._tag === "AlreadyExists")
      return {
        exitCode: 1,
        stdout: [],
        stderr: [`refused: ${folder} already exists`],
      } satisfies Report;
    return {
      exitCode: 1,
      stdout: [],
      stderr: [`failed ${folder}: filesystem ${made.failure.message}`],
    } satisfies Report;
  }
  created.push({ path: folder, directory: true });
  for (const component of parsed.manifest.components) {
    const directory = path.join(folder, `${component.name}-${component.version}`);
    const madeDirectory = yield* fs
      .makeDirectory(directory, { recursive: false })
      .pipe(Effect.result);
    if (Result.isFailure(madeDirectory)) {
      failure = `failed ${directory}: filesystem ${madeDirectory.failure.message}`;
      break;
    }
    created.push({ path: directory, directory: true });
  }
  if (!failure)
    for (const entry of files(parsed.manifest)) {
      const result = yield* fetchVerified(entry, input.download);
      if ("failure" in result) {
        failure = result.line;
        break;
      }
      const body = result.body;
      const filename = path.join(folder, ...entry.file.split("/"));
      const opened = yield* Effect.tryPromise({
        try: () => NodeFSP.open(filename, "wx", 0o644),
        catch: toVendorError,
      }).pipe(Effect.result);
      if (Result.isFailure(opened)) {
        failure = `failed ${filename}: filesystem ${opened.failure.message}`;
        break;
      }
      created.push({ path: filename, directory: false });
      const written = yield* Effect.tryPromise({
        try: () => opened.success.writeFile(body),
        catch: toVendorError,
      }).pipe(Effect.result);
      const closed = yield* Effect.tryPromise({
        try: () => opened.success.close(),
        catch: toVendorError,
      }).pipe(Effect.result);
      if (Result.isFailure(written) || Result.isFailure(closed)) {
        const error = Result.isFailure(written)
          ? written.failure
          : Result.isFailure(closed)
            ? closed.failure
            : undefined;
        failure = `failed ${filename}: filesystem ${error?.message}`;
        break;
      }
      stdout.push(`fetched ${entry.label} ${entry.file}`);
    }
  if (failure) {
    const stderr = [failure];
    for (const entry of created.reverse()) {
      const removed = yield* entry.directory
        ? Effect.tryPromise({ try: () => NodeFSP.rmdir(entry.path), catch: toVendorError }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        : fs.remove(entry.path, { recursive: false }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
      if (!removed) stderr.push(`cleanup failed ${entry.path}`);
    }
    return { exitCode: 1, stdout: [], stderr } satisfies Report;
  }
  return { exitCode: 0, stdout, stderr: [] } satisfies Report;
});

export const readVendorManifestIn = Effect.fn("factoryVendor.readVendorManifestIn")(function* (
  root: string,
): Effect.fn.Return<
  { readonly checkout: false } | { readonly checkout: true; readonly text: string | null },
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkout = yield* fs
    .exists(path.join(root, "factory", "seams.json"))
    .pipe(Effect.orElseSucceed(() => false));
  if (!checkout) return { checkout: false };
  const text = yield* fs
    .readFileString(path.join(root, "factory", "vendor", "manifest.json"))
    .pipe(Effect.orElseSucceed(() => null));
  return { checkout: true, text };
});

export const readVendorManifest: ReturnType<typeof readVendorManifestIn> = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url)).pipe(Effect.result);
  if (Result.isFailure(root)) return { checkout: false } as const;
  return yield* readVendorManifestIn(root.success);
});
