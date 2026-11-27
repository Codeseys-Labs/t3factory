// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off globalErrorInEffectCatch:off -- Fixtures hash with Node crypto, stand-in tar answers with plain text, and stubs die with plain Errors.
// The world the FactoryProxy tests run in: a temp home, stand-in pins and bodies,
// recording seams at the contract's surfaces (Host, spawner, settings, secrets).
// No vitest import; probes drive this module directly with plain node.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import {
  FACTORY_PROXY_SOURCE_ID,
  type FactoryProxyStatus,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Net from "@t3tools/shared/Net";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SecretStoreModule from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { makeDownload } from "../../../../scripts/factory-vendor-lib.ts";
import * as FactoryProxy from "./FactoryProxy.ts";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
export const unslash = (text: string) => text.replaceAll("\\", "/");
export const SETTINGS_SECRET_NAME = `usage-limit-source-${Buffer.from(FACTORY_PROXY_SOURCE_ID, "utf8").toString("base64url")}`;
export const MANAGEMENT_KEY_NAME = "factory-proxy-management-key";
export const CLIENT_KEY_NAME = "factory-proxy-client-key";

const PATH_VALUE = NodeProcess.env["PATH"] ?? "";
export const PROXY_VERSION = "8.0.78";
export const CONSOLE_VERSION = "1.28.3";
export const PANEL_REPOSITORY = "https://github.com/router-for-me/Cli-Proxy-API-Management-Center";
export const EXECUTABLE_BYTES_MAX = 268435456;

export const REFUSALS = {
  unavailable: "The model proxy is not available on this server.",
  busy: "The model proxy is busy with another change. Try again when it has finished.",
  "invalid-key": "A management key is 16 to 64 printable characters with no spaces.",
  "not-installed": "The model proxy is not installed on this server.",
  "already-installed": "The model proxy is already installed on this server.",
  "no-checkout": "This server does not run from a Factory checkout, so it has no pinned manifest.",
  manifest: "The pinned manifest is missing or invalid, so nothing was fetched.",
  "unsupported-platform": "The pin has no build of the proxy for this machine.",
  "no-free-port": "No port from 8317 to 8327 is free on this machine.",
  "earlier-run":
    "An earlier proxy of this server may still be running. End it on the machine, then try again.",
  "remove-refused":
    "The proxy's hub could not be removed from this server's settings. Nothing was uninstalled. Try again.",
  "config-unreadable":
    "The model proxy's settings file cannot be read. Uninstall, keeping sign-ins, then install again.",
} as const;

// The stand-in executable and the four pinned bodies it ships beside.
export const EXE_BYTES = encoder.encode("stand-in executable bytes, nothing more\n");
export const PROXY_LICENSE_BYTES = encoder.encode("proxy licence text\n");
export const CONSOLE_BYTES = encoder.encode("<html>management console</html>\n");
export const CONSOLE_LICENSE_BYTES = encoder.encode("console licence text\n");
const LINUX_ARCHIVE_BYTES = encoder.encode("not a real tar.gz; the stub never unpacks it\n");

export const WIN_ARCHIVE_NAMES = [
  "cli-proxy-api.exe",
  "config.example.yaml",
  "LICENSE",
  "README.md",
  "README_CN.md",
];
export const LINUX_ARCHIVE_NAMES = ["cli-proxy-api", ...WIN_ARCHIVE_NAMES.slice(1)];

export interface ZipEntry {
  readonly name: string;
  readonly data?: Uint8Array;
  readonly mode: number;
  readonly dosDirectory?: boolean;
  readonly encrypted?: boolean;
}

// A zip built by hand, as preview/PreviewBrowser.test.ts builds one, so yauzl reads it.
export const makeZip = (entries: ReadonlyArray<ZipEntry>): Uint8Array => {
  const records: Array<Buffer> = [];
  const directory: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? new Uint8Array(0));
    const crc = NodeZlib.crc32(data);
    const flags = entry.encrypted === true ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(
      ((entry.mode << 16) | (entry.dosDirectory === true ? 0x10 : 0)) >>> 0,
      38,
    );
    central.writeUInt32LE(offset, 42);
    records.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...records, centralDirectory, end]));
};

export const zipMember = (name: string, data: Uint8Array): ZipEntry => ({
  name,
  data,
  mode: 0o100644,
});

export const WIN_ZIP = makeZip([
  zipMember("cli-proxy-api.exe", EXE_BYTES),
  zipMember("config.example.yaml", encoder.encode("config-version: 8\n")),
  zipMember("LICENSE", encoder.encode("archive licence, never used\n")),
  zipMember("README.md", encoder.encode("readme\n")),
  zipMember("README_CN.md", encoder.encode("readme cn\n")),
]);

const committedManifestText = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("../../../../factory/vendor/manifest.json", import.meta.url)),
  "utf8",
);

interface CommittedBody {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface CommittedAsset extends CommittedBody {
  readonly platform: string;
}
interface CommittedComponent {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly publishedAt: string;
  readonly retrievedAt: string;
  readonly license: CommittedBody;
  readonly assets: ReadonlyArray<CommittedAsset>;
  readonly requires: unknown;
}
const committedManifest = JSON.parse(committedManifestText) as {
  readonly v: number;
  readonly components: readonly [CommittedComponent, CommittedComponent];
};

// A manifest of the committed pin's URLs and shape, hashing the fixture bodies.
const manifestOf = (winArchive: Uint8Array) => {
  const withBody = <T extends CommittedBody>(entry: T, body: Uint8Array | undefined): T => ({
    ...entry,
    ...(body === undefined ? {} : { bytes: body.length, sha256: sha256Hex(body) }),
  });
  const [proxy, center] = committedManifest.components;
  return {
    v: committedManifest.v,
    components: [
      {
        ...proxy,
        license: withBody(proxy.license, PROXY_LICENSE_BYTES),
        assets: proxy.assets.map((asset) =>
          withBody(
            asset,
            asset.platform === "win32-x64"
              ? winArchive
              : asset.platform === "linux-x64"
                ? LINUX_ARCHIVE_BYTES
                : undefined,
          ),
        ),
      },
      {
        ...center,
        license: withBody(center.license, CONSOLE_LICENSE_BYTES),
        assets: center.assets.map((asset) => withBody(asset, CONSOLE_BYTES)),
      },
    ],
  };
};

const MANIFEST = manifestOf(WIN_ZIP);
export const MANIFEST_TEXT = JSON.stringify(MANIFEST);

const manifestTextOf = (archive: Uint8Array) => JSON.stringify(manifestOf(archive));
const PROXY_ASSETS = MANIFEST.components[0]!.assets;
export const ARCHIVE_URL = PROXY_ASSETS.find((asset) => asset.platform === "win32-x64")!.url;
const LINUX_ARCHIVE_URL = PROXY_ASSETS.find((asset) => asset.platform === "linux-x64")!.url;
export const PROXY_LICENSE_URL = MANIFEST.components[0]!.license.url;
export const CONSOLE_URL = MANIFEST.components[1]!.assets[0]!.url;
export const CONSOLE_LICENSE_URL = MANIFEST.components[1]!.license.url;

// P7's install template: block YAML, two-space indents, JSON.stringify strings, LF ends.
const configTemplate = (port: number, authDir: string, clientKey: string) =>
  [
    "config-version: 8",
    "server:",
    '  host: "127.0.0.1"',
    `  port: ${port}`,
    "  tls:",
    "    enable: false",
    "  discovery:",
    "    enabled: false",
    "  kv-store:",
    '    path: ""',
    "models:",
    "  codex:",
    "    live-media-relay:",
    "      enabled: false",
    "management:",
    "  allow-remote: false",
    '  secret-key: ""',
    "  disable-auto-update-panel: true",
    `  panel-github-repository: ${JSON.stringify(PANEL_REPOSITORY)}`,
    "oauth:",
    `  auth-dir: ${JSON.stringify(authDir)}`,
    "observability:",
    "  pprof:",
    "    enable: false",
    "plugins:",
    "  enabled: false",
    "access:",
    "  api-keys:",
    `    - ${JSON.stringify(clientKey)}`,
    "",
  ].join("\n");

export const expectedConfig = (
  port: number,
  authDir: string,
  managementKey: string,
  clientKey: string,
) => ({
  "config-version": 8,
  server: {
    host: "127.0.0.1",
    port,
    tls: { enable: false },
    discovery: { enabled: false },
    "kv-store": { path: "" },
  },
  models: { codex: { "live-media-relay": { enabled: false } } },
  management: {
    "allow-remote": false,
    "secret-key": managementKey,
    "disable-auto-update-panel": true,
    "panel-github-repository": PANEL_REPOSITORY,
  },
  oauth: { "auth-dir": authDir },
  observability: { pprof: { enable: false } },
  plugins: { enabled: false },
  access: { "api-keys": [clientKey] },
});

export interface ScriptedReply {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly hang?: boolean;
}

export interface RecordedSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.StandardCommand["options"];
}

export interface SupervisorHandle {
  readonly pid: number;
  exit(code: number): void;
  offerStdout(text: string): void;
  offerStderr(text: string): void;
  readonly state: { stdinEnds: number; kills: number; exited: boolean };
}

export interface WorldOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly manifestText?: string | null;
  readonly noCheckout?: boolean;
  readonly winArchive?: Uint8Array;
  readonly baseDir?: string;
  readonly takenPorts?: ReadonlyArray<number>;
  readonly hangArchive?: boolean;
  readonly settingsOverrides?: Parameters<typeof ServerSettingsModule.layerTest>[0];
  readonly persistentSettings?: boolean;
  readonly tar?: (args: ReadonlyArray<string>) => ScriptedReply;
  readonly supervisor?: {
    readonly pid?: number;
    readonly exitsOnStdinEnd?: boolean;
    readonly exitsOnKill?: boolean;
    readonly stdoutClosed?: boolean;
  };
}

export interface World {
  readonly scope: Scope.Closeable;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly root: string;
  readonly recordPath: string;
  readonly configPath: string;
  readonly exePath: string;
  readonly releaseDir: string;
  readonly consolePath: string;
  readonly authDir: string;
  readonly secretsDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly order: ReadonlyArray<string>;
  readonly recordAtDownloads: ReadonlyArray<Record<string, unknown> | null>;
  readonly recordAtSecrets: ReadonlyArray<Record<string, unknown> | null>;
  readonly recordAtStdinEnds: ReadonlyArray<Record<string, unknown>>;
  readonly recordAtSpawns: ReadonlyArray<Record<string, unknown>>;
  readonly spawns: ReadonlyArray<RecordedSpawn>;
  readonly supervisors: ReadonlyArray<SupervisorHandle>;
  readonly patches: ReadonlyArray<unknown>;
  readonly httpRequests: ReadonlyArray<{
    readonly url: string;
    readonly authorization: string | null;
  }>;
  readonly ownerQueries: ReadonlyArray<{ readonly port: number; readonly pid: number }>;
  readonly downloads: ReadonlyArray<string>;
  readonly downloadSignals: ReadonlyArray<AbortSignal | null | undefined>;
  readonly logLines: ReadonlyArray<string>;
  readonly settings: ServerSettingsModule.ServerSettingsService["Service"];
  readonly secretStore: SecretStoreModule.ServerSecretStore["Service"];
  readonly fs: FileSystem.FileSystem;
  readonly proxy: Effect.Success<typeof FactoryProxy.make>;
  readonly events: Queue.Queue<string>;
  readonly takenPorts: Set<number>;
  readonly downloadFailures: Map<
    string,
    { readonly status: number; readonly body?: Uint8Array | undefined }
  >;
  readonly hangDownloadUrls: Set<string>;
  setOwnerAnswer(answer: "ours" | "other"): void;
  setHttpAnswer(answer: { readonly status: number; readonly body: unknown }): void;
  setRefuseSettings(refused: boolean): void;
  setRefuseRecordWrites(refused: boolean): void;
}

// A stand-in handle for a `tar`/`netstat`/`lsof` run: fixed pid, scripted stdout, no-op kill.
export const scriptedHandle = (reply: ScriptedReply) => {
  const output = encoder.encode(reply.stdout ?? "");
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(9000),
    exitCode:
      reply.hang === true
        ? Effect.never
        : Effect.succeed(ChildProcessSpawner.ExitCode(reply.exitCode ?? 0)),
    isRunning: Effect.succeed(reply.hang === true),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(output),
    stderr: Stream.empty,
    all: Stream.make(output),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

export const refusalOf = <A>(effect: Effect.Effect<A, { reason: string; message: string }>) =>
  Effect.map(Effect.flip(effect), (error) => ({ reason: error.reason, message: error.message }));

export const countEvent = (order: ReadonlyArray<string>, name: string) =>
  order.reduce((total, event) => (event === name ? total + 1 : total), 0);

export const firstIndex = (order: ReadonlyArray<string>, matches: (event: string) => boolean) => {
  const index = order.findIndex(matches);
  return index === -1 ? undefined : index;
};

export const lastIndex = (order: ReadonlyArray<string>, matches: (event: string) => boolean) => {
  for (let index = order.length - 1; index >= 0; index -= 1) {
    if (matches(order[index]!)) return index;
  }
  return undefined;
};

export const secretText = (world: World, name: string) =>
  Effect.map(world.secretStore.get(name), (value) =>
    Option.match(value, {
      onNone: () => null,
      onSome: (bytes) => decoder.decode(new Uint8Array(bytes)),
    }),
  );

export const requiredSecretText = (world: World, name: string) =>
  Effect.map(world.secretStore.get(name), (value) =>
    Option.getOrThrow(Option.map(value, (bytes) => decoder.decode(new Uint8Array(bytes)))),
  );

export const proxyEntry = (patch: unknown): unknown => {
  if (typeof patch !== "object" || patch === null || !("usageLimitSources" in patch)) {
    return undefined;
  }
  const sources = (patch as { usageLimitSources: unknown }).usageLimitSources;
  if (typeof sources !== "object" || sources === null) return undefined;
  const keyed = sources as Record<string, unknown>;
  return Object.hasOwn(keyed, FACTORY_PROXY_SOURCE_ID) ? keyed[FACTORY_PROXY_SOURCE_ID] : undefined;
};

export const managementKeyOf = (entry: unknown): unknown =>
  typeof entry === "object" && entry !== null && "managementKey" in entry
    ? (entry as { managementKey: unknown }).managementKey
    : undefined;

const makeWorld = Effect.fn("FactoryProxy.testkit.makeWorld")(function* (
  scope: Scope.Closeable,
  options: WorldOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir =
    options.baseDir === undefined
      ? yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-proxy-" })
      : options.baseDir;
  const stateDir = path.join(baseDir, "userdata");
  const root = path.join(stateDir, FACTORY_PROXY_SOURCE_ID);
  const recordPath = path.join(root, "record.json");
  const configPath = path.join(root, "config.yaml");
  const platform = options.platform ?? "win32";
  const arch = options.arch ?? "x64";
  const exeName = platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
  const releaseDir = path.join(root, "releases", PROXY_VERSION);
  const exePath = path.join(releaseDir, exeName);
  const consolePath = path.join(root, "static", "management.html");
  const authDir = path.join(root, "auth");
  const secretsDir = path.join(stateDir, "secrets");

  const order: string[] = [];
  const events = yield* Queue.unbounded<string>();
  const record = (name: string) => {
    order.push(name);
    Queue.offerUnsafe(events, name);
  };

  const recordAtDownloads: Array<Record<string, unknown> | null> = [];
  const recordAtSecrets: Array<Record<string, unknown> | null> = [];
  const recordAtStdinEnds: Array<Record<string, unknown>> = [];
  const recordAtSpawns: Array<Record<string, unknown>> = [];
  const spawnRecords: RecordedSpawn[] = [];
  const supervisors: SupervisorHandle[] = [];
  const patches: unknown[] = [];
  const httpRequests: Array<{ url: string; authorization: string | null }> = [];
  const ownerQueries: Array<{ port: number; pid: number }> = [];
  const downloads: string[] = [];
  const downloadSignals: Array<AbortSignal | null | undefined> = [];
  const logLines: string[] = [];
  const takenPorts = new Set<number>(options.takenPorts ?? []);
  const downloadFailures = new Map<string, { status: number; body?: Uint8Array | undefined }>();
  const hangDownloadUrls = new Set<string>(options.hangArchive === true ? [ARCHIVE_URL] : []);
  let ownerAnswer: "ours" | "other" = "ours";
  let httpAnswer: { status: number; body: unknown } = { status: 200, body: { files: [] } };
  let refuseSettings = false;
  let refuseRecordWrites = false;
  const renameFailure = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "rename",
    description: "Fixture commit refused.",
  });

  const currentRecord = (): Record<string, unknown> =>
    JSON.parse(NodeFS.readFileSync(recordPath, "utf8")) as Record<string, unknown>;
  const recordOrNull = (): Record<string, unknown> | null =>
    NodeFS.existsSync(recordPath) ? currentRecord() : null;

  const rawSecretStore = yield* Layer.build(SecretStoreModule.layer).pipe(
    Effect.provide(Layer.mergeAll(PlatformCrypto.layer, ServerConfig.layerTest(baseDir, baseDir))),
  );
  const innerSecretStore = yield* Effect.service(SecretStoreModule.ServerSecretStore).pipe(
    Effect.provide(rawSecretStore),
  );
  const secretStore: SecretStoreModule.ServerSecretStore["Service"] = {
    ...innerSecretStore,
    get: (name) =>
      Effect.tap(innerSecretStore.get(name), () =>
        Effect.sync(() => {
          record(`secret-get:${name}`);
        }),
      ),
    set: (name, value) =>
      Effect.tap(innerSecretStore.set(name, value), () =>
        Effect.sync(() => {
          recordAtSecrets.push(recordOrNull());
          record(`secret-set:${name}`);
        }),
      ),
    remove: (name) =>
      Effect.tap(innerSecretStore.remove(name), () =>
        Effect.sync(() => {
          recordAtSecrets.push(recordOrNull());
          record(`secret-remove:${name}`);
        }),
      ),
  };

  const settingsContext = options.persistentSettings
    ? yield* ServerSettingsModule.layer.pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(Layer.succeed(SecretStoreModule.ServerSecretStore, secretStore)),
        Layer.provide(
          Layer.succeed(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fs,
              rename: (from, to) =>
                refuseSettings ? Effect.fail(renameFailure) : fs.rename(from, to),
            }),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(PlatformCrypto.layer, ServerConfig.layerTest(baseDir, baseDir)),
        ),
        Layer.build,
      )
    : yield* Layer.build(ServerSettingsModule.layerTest(options.settingsOverrides));
  const innerSettings = yield* Effect.service(ServerSettingsModule.ServerSettingsService).pipe(
    Effect.provide(settingsContext),
  );
  const settings: ServerSettingsModule.ServerSettingsService["Service"] = {
    ...innerSettings,
    updateSettings: (patch) =>
      Effect.gen(function* () {
        record("patch");
        patches.push(patch);
        if (refuseSettings && !options.persistentSettings) {
          record("settings-refused");
          return yield* new ServerSettingsError({
            settingsPath: "<test>",
            operation: "write-managed-setting",
            managedSetting: "usageLimitSources",
          });
        }
        if (!options.persistentSettings) {
          const entry = proxyEntry(patch);
          if (entry === null) {
            yield* Effect.ignore(secretStore.remove(SETTINGS_SECRET_NAME));
          } else if (managementKeyOf(entry) !== undefined) {
            yield* Effect.ignore(
              secretStore.set(SETTINGS_SECRET_NAME, encoder.encode(String(managementKeyOf(entry)))),
            );
          }
        }
        const next = yield* innerSettings.updateSettings(patch);
        record("settings-applied");
        return next;
      }),
  };

  const winArchive = options.winArchive ?? WIN_ZIP;
  const manifestText =
    options.noCheckout === true ? null : (options.manifestText ?? manifestTextOf(winArchive));
  const served = new Map<string, Uint8Array>([
    [ARCHIVE_URL, winArchive],
    [LINUX_ARCHIVE_URL, LINUX_ARCHIVE_BYTES],
    [PROXY_LICENSE_URL, PROXY_LICENSE_BYTES],
    [CONSOLE_URL, CONSOLE_BYTES],
    [CONSOLE_LICENSE_URL, CONSOLE_LICENSE_BYTES],
  ]);

  const transport = (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    record("download");
    downloads.push(url);
    downloadSignals.push(init?.signal);
    recordAtDownloads.push(recordOrNull());
    if (hangDownloadUrls.has(url)) {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      return promise;
    }
    const failure = downloadFailures.get(url);
    if (failure !== undefined) {
      return Promise.resolve(
        new Response(failure.body ?? new Uint8Array(0), { status: failure.status }),
      );
    }
    const body = served.get(url);
    return Promise.resolve(
      new Response(body ?? new Uint8Array(0), { status: body === undefined ? 404 : 200 }),
    );
  };

  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      record("request");
      httpRequests.push({ url: request.url, authorization: request.headers.authorization ?? null });
      return HttpClientResponse.fromWeb(
        request,
        Response.json(httpAnswer.body, { status: httpAnswer.status }),
      );
    }),
  );

  const net = Net.NetService.of({
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: (port) =>
      Effect.sync(() => {
        record("probe");
        return !takenPorts.has(port);
      }),
    hasListenerOnHost: () => Effect.succeed(false),
    reserveLoopbackPort: () => Effect.succeed(0),
    findAvailablePort: () => Effect.succeed(0),
  });

  const makeSupervisor = Effect.fn("FactoryProxy.testkit.supervisor")(function* (script: {
    readonly pid: number;
    readonly exitsOnStdinEnd: boolean;
    readonly exitsOnKill: boolean;
  }) {
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const stdout = yield* Queue.unbounded<Uint8Array>();
    const stderr = yield* Queue.unbounded<Uint8Array>();
    const state = { stdinEnds: 0, kills: 0, exited: false };
    const port = recordOrNull()?.["port"];
    const settle = (code: number) => {
      if (state.exited) return;
      state.exited = true;
      if (typeof port === "number" && ownerAnswer === "ours") takenPorts.delete(port);
      Deferred.doneUnsafe(exit, Effect.succeed(ChildProcessSpawner.ExitCode(code)));
    };
    const stdin: Sink.Sink<void, Uint8Array> = Sink.suspend(() => {
      state.stdinEnds += 1;
      record(`stdin-end:${state.stdinEnds}`);
      if (NodeFS.existsSync(recordPath)) recordAtStdinEnds.push(currentRecord());
      if (script.exitsOnStdinEnd) settle(0);
      return Sink.drain;
    });
    const handle: SupervisorHandle = {
      pid: script.pid,
      exit: settle,
      offerStdout: (text) => Queue.offerUnsafe(stdout, encoder.encode(text)),
      offerStderr: (text) => Queue.offerUnsafe(stderr, encoder.encode(text)),
      state,
    };
    const made = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(script.pid),
      exitCode: Deferred.await(exit),
      isRunning: Effect.sync(() => !state.exited),
      kill: () =>
        Effect.sync(() => {
          state.kills += 1;
          record("kill");
          if (script.exitsOnKill) settle(1);
        }),
      stdin,
      stdout: options.supervisor?.stdoutClosed ? Stream.empty : Stream.fromQueue(stdout),
      stderr: Stream.fromQueue(stderr),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
    return { handle, made };
  });

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die(new Error("unexpected command form"));
      }
      spawnRecords.push({
        command: command.command,
        args: command.args.map(String),
        options: command.options,
      });
      if (command.args[0] === "-e" && command.args[1] === FactoryProxy.SUPERVISOR) {
        record("supervisor-spawn");
        const { handle, made } = yield* makeSupervisor({
          pid: options.supervisor?.pid ?? 800 + supervisors.length,
          exitsOnStdinEnd: options.supervisor?.exitsOnStdinEnd ?? true,
          exitsOnKill: options.supervisor?.exitsOnKill ?? true,
        });
        supervisors.push(handle);
        if (NodeFS.existsSync(recordPath)) recordAtSpawns.push(currentRecord());
        return made;
      }
      record(`spawn:${command.command}`);
      const reply = options.tar?.(command.args.map(String));
      if (reply === undefined) {
        return yield* Effect.die(new Error(`unexpected command ${command.command}`));
      }
      return scriptedHandle(reply);
    }),
  );

  const collector = Logger.make<unknown, void>((entry) => {
    const message = entry.message;
    logLines.push(
      `${entry.logLevel}: ${
        Array.isArray(message)
          ? message
              .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
              .join(" ")
          : String(message)
      }`,
    );
    record("log");
  });

  // Method-agnostic file events: any read, write or removal of a path fires one,
  // whichever FileSystem call the module uses for it.
  const eventful =
    <A, E, R, Args extends Array<unknown>>(
      name: string,
      method: (path: string, ...args: Args) => Effect.Effect<A, E, R>,
    ) =>
    (path: string, ...args: Args): Effect.Effect<A, E, R> =>
      Effect.tap(method(path, ...args), () => Effect.sync(() => record(`${name}:${path}`)));
  const wrappedFs = FileSystem.FileSystem.of({
    ...fs,
    readFile: eventful("read", fs.readFile),
    readFileString: eventful("read", fs.readFileString),
    open: eventful("read", fs.open),
    stat: eventful("read", fs.stat),
    exists: eventful("read", fs.exists),
    readDirectory: eventful("read", fs.readDirectory),
    writeFileString: eventful("write", fs.writeFileString),
    writeFile: eventful("write", fs.writeFile),
    makeDirectory: eventful("write", fs.makeDirectory),
    remove: eventful("remove", fs.remove),
    chmod: eventful("chmod", fs.chmod),
    rename: (from, to) =>
      refuseRecordWrites && to === recordPath
        ? Effect.fail(renameFailure)
        : Effect.tap(fs.rename(from, to), () => Effect.sync(() => record(`rename:${to}`))),
  });

  const env = {
    PATH: PATH_VALUE,
    HTTPS_PROXY: "https://proxy.example:3128",
    MANAGEMENT_PASSWORD: "server secret",
    MANAGEMENT_STATIC_PATH: "server static path",
    WRITABLE_PATH: "server writable path",
    GITHUB_TOKEN: "server token",
    ANTHROPIC_API_KEY: "server key",
  };

  const clock = yield* Clock.Clock;
  const recordingClock: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Effect.suspend(() => {
        record(`timer:${Duration.toMillis(duration)}`);
        return clock.sleep(duration);
      }),
  };
  const layer = Layer.mergeAll(
    PlatformCrypto.layer,
    Layer.succeed(Clock.Clock, recordingClock),
    ServerConfig.layerTest(baseDir, baseDir),
    Layer.succeed(ServerSettingsModule.ServerSettingsService, settings),
    Layer.succeed(SecretStoreModule.ServerSecretStore, secretStore),
    Layer.succeed(Net.NetService, net),
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(FactoryProxy.Host, {
      manifest:
        manifestText === null
          ? Effect.succeed({ checkout: false as const })
          : Effect.succeed({ checkout: true as const, text: manifestText }),
      download: makeDownload({ transport, maxBytes: EXECUTABLE_BYTES_MAX, abortable: true }),
      listenerOwner: (input: { readonly port: number; readonly pid: number }) =>
        Effect.sync(() => {
          record("owner");
          ownerQueries.push(input);
          return ownerAnswer;
        }),
    }),
    Layer.succeed(HostProcess.Platform, platform),
    Layer.succeed(HostProcess.Architecture, arch),
    Layer.succeed(HostProcess.Environment, env),
    Layer.succeed(HostProcess.ExecutablePath, NodeProcess.execPath),
    Logger.layer([collector]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, wrappedFs),
        Layer.succeed(Path.Path, path),
      ),
    ),
  );

  const proxy = yield* FactoryProxy.make.pipe(
    Effect.provide(layer),
    Effect.provideService(Scope.Scope, scope),
  );

  const world: World = {
    scope,
    baseDir,
    stateDir,
    root,
    recordPath,
    configPath,
    exePath,
    releaseDir,
    consolePath,
    authDir,
    secretsDir,
    platform,
    arch,
    order,
    recordAtDownloads,
    recordAtSecrets,
    recordAtStdinEnds,
    recordAtSpawns,
    spawns: spawnRecords,
    supervisors,
    patches,
    httpRequests,
    ownerQueries,
    downloads,
    downloadSignals,
    logLines,
    settings,
    secretStore,
    fs,
    // Manual mutations fork in the caller's context, not the layer used to build the proxy.
    proxy: {
      ...proxy,
      start: (input) =>
        proxy
          .start(input)
          .pipe(
            Effect.provideService(Clock.Clock, recordingClock),
            Effect.provide(Logger.layer([collector])),
          ),
      stop: (input) => proxy.stop(input).pipe(Effect.provideService(Clock.Clock, recordingClock)),
      uninstall: (input) =>
        proxy.uninstall(input).pipe(Effect.provideService(Clock.Clock, recordingClock)),
    },
    events,
    takenPorts,
    downloadFailures,
    hangDownloadUrls,
    setOwnerAnswer: (answer) => {
      ownerAnswer = answer;
    },
    setHttpAnswer: (answer) => {
      httpAnswer = answer;
    },
    setRefuseSettings: (refused) => {
      refuseSettings = refused;
    },
    setRefuseRecordWrites: (refused) => {
      refuseRecordWrites = refused;
    },
  };
  return world;
});

const until = (world: World, ready: (order: ReadonlyArray<string>) => boolean) =>
  Effect.gen(function* () {
    while (!ready(world.order)) {
      yield* Queue.take(world.events);
    }
  });

export const awaitEvent = (world: World, name: string) =>
  until(world, (order) => order.includes(name));

export const awaitCount = (world: World, name: string, count: number) =>
  until(world, (order) => countEvent(order, name) >= count);

// Awaits an event that was not yet in the order when `from` was captured, so a
// later call does not pass on an earlier call's events.
const awaitFresh = (world: World, from: number, name: string) =>
  until(world, (order) => order.slice(from).includes(name));

export const withWorld = <A, E, R>(
  options: WorldOptions,
  use: (world: World, close: () => Effect.Effect<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const world = yield* makeWorld(scope, options).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provide(NodeServices.layer),
    );
    let closed = false;
    const close = () =>
      Effect.suspend(() => {
        if (closed) return Effect.void;
        closed = true;
        return Scope.close(scope, Exit.void);
      });
    const result = yield* use(world, close);
    yield* close();
    return result;
  });

// Polls `status` with a small clock advance until `ready`, so a failure the
// module reaches through real file IO can be awaited without a wall clock.
export const awaitStatus = Effect.fn("FactoryProxy.testkit.awaitStatus")(function* (
  world: World,
  ready: (status: FactoryProxyStatus) => boolean,
  rounds = 200,
) {
  let status = yield* world.proxy.status({});
  for (let i = 0; i < rounds && !ready(status); i += 1) {
    yield* TestClock.adjust(Duration.millis(50));
    status = yield* world.proxy.status({});
  }
  return status;
});

export const recordOf = (world: World): Record<string, unknown> =>
  JSON.parse(NodeFS.readFileSync(world.recordPath, "utf8")) as Record<string, unknown>;

export const seedInstalledRecord = (
  world: World,
  record: {
    readonly desired: "running" | "stopped";
    readonly process: { readonly pid: number } | null;
    readonly consoleKey?: "typed" | "generated";
  },
) => {
  const clientKey = "seeded-client-key-0123456789";
  NodeFS.mkdirSync(world.releaseDir, { recursive: true });
  NodeFS.mkdirSync(world.authDir, { recursive: true });
  NodeFS.mkdirSync(`${world.root}/static`, { recursive: true });
  NodeFS.writeFileSync(world.exePath, EXE_BYTES);
  NodeFS.writeFileSync(`${world.releaseDir}/LICENSE`, PROXY_LICENSE_BYTES);
  NodeFS.writeFileSync(`${world.releaseDir}/LICENSE-management-center`, CONSOLE_LICENSE_BYTES);
  NodeFS.writeFileSync(world.consolePath, CONSOLE_BYTES);
  NodeFS.writeFileSync(world.configPath, configTemplate(8317, unslash(world.authDir), clientKey));
  NodeFS.writeFileSync(
    world.recordPath,
    JSON.stringify({
      v: 1,
      phase: "installed",
      proxy: PROXY_VERSION,
      console: CONSOLE_VERSION,
      platform: `${world.platform}-${world.arch}`,
      executableSha256: sha256Hex(EXE_BYTES),
      consoleSha256: sha256Hex(CONSOLE_BYTES),
      port: 8317,
      consoleKey: record.consoleKey ?? "generated",
      desired: record.desired,
      installedAt: "2026-01-01T00:00:00.000Z",
      process: record.process,
    }),
  );
};

export const rootListing = (world: World) =>
  Effect.map(world.fs.readDirectory(world.root, { recursive: true }), (entries) =>
    entries.map((entry) => unslash(String(entry))).sort(),
  ).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(Array<string>()),
    ),
  );

// Every file under the home as text, skipping the folders a clause says to skip.
export const scanHome = (
  world: World,
  options: { readonly includeSecrets?: boolean; readonly includeConfig?: boolean } = {},
) => {
  const skip = new Set<string>();
  if (options.includeSecrets !== true) skip.add(unslash(world.secretsDir));
  if (options.includeConfig !== true) skip.add(unslash(world.configPath));
  const files: Array<[string, string]> = [];
  const visit = (dir: string) => {
    for (const name of NodeFS.readdirSync(dir)) {
      const full = `${dir}/${name}`;
      if (skip.has(unslash(full))) continue;
      const info = NodeFS.lstatSync(full);
      if (info.isDirectory()) visit(full);
      else if (info.isFile()) files.push([full, NodeFS.readFileSync(full, "utf8")]);
    }
  };
  visit(world.stateDir);
  return files;
};

// Install answers `installing` and ends `stopped`; the caller drives spawns itself.
export const install = Effect.fn("FactoryProxy.testkit.install")(function* (
  world: World,
  input: { managementKey?: string } = {},
) {
  const answer = yield* world.proxy.install(
    input.managementKey === undefined ? {} : { managementKey: Redacted.make(input.managementKey) },
  );
  yield* world.proxy.drain;
  return answer;
});

// Drive one spawned supervisor to `running`: pid line, held port, an `ours` answer, a 200 read.
// Every wait is over the fresh tail so a second call does not pass on the first.
export const startToRunning = Effect.fn("FactoryProxy.testkit.startToRunning")(function* (
  world: World,
) {
  const from = world.order.length;
  yield* world.proxy.start({});
  yield* awaitFresh(world, from, "supervisor-spawn");
  const handle = world.supervisors[world.supervisors.length - 1]!;
  handle.offerStdout(`pid ${handle.pid}\n`);
  world.takenPorts.add(8317);
  yield* until(world, (events) =>
    events
      .slice(from)
      .some((event) => event === "settings-applied" || event === "settings-refused"),
  );
  return yield* world.proxy.status({});
});

export const processAlive = (pid: number) => {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
