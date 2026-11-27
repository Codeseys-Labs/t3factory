import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import {
  FACTORY_PROXY_KEY_PATTERN,
  FACTORY_PROXY_PORT_FIRST,
  FACTORY_PROXY_PORT_LAST,
  FACTORY_PROXY_SOURCE_ID,
  FactoryProxyError,
  type FactoryProxyHub,
  type FactoryProxyInstallInput,
  type FactoryProxyNoInput,
  FactoryProxyProblem,
  type FactoryProxyRefusal,
  type FactoryProxyState,
  type FactoryProxyStatus,
  type FactoryProxyUninstallInput,
  IsoDateTime,
  PositiveInt,
  Sha256,
  type UsageLimitSourceConfig,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Net from "@t3tools/shared/Net";
import { LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { parseDocument } from "yaml";

import {
  type Download,
  fetchPinned,
  liveDownload,
  type PinnedFile,
  pinnedFor,
  readVendorManifest,
  sha256Hex,
} from "../../../../scripts/factory-vendor-lib.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeCliproxyApi } from "../usage/cliproxyApi.ts";
import { removeEmptyDirectory } from "../vcs/removeEmptyDirectory.ts";
import { openZipArchive } from "../zipArchive.ts";

const SOURCE = UsageLimitSourceId.make(FACTORY_PROXY_SOURCE_ID);
const MANAGEMENT_KEY = "factory-proxy-management-key";
const CLIENT_KEY = "factory-proxy-client-key";
const SETTINGS_KEY = `usage-limit-source-${Base64Url.encode(SOURCE)}`;
const LOOPBACK = "127.0.0.1";
const PANEL_REPO = "https://github.com/router-for-me/Cli-Proxy-API-Management-Center";
const EXECUTABLE_BYTES_MAX = 268435456;
const QUERY_TIMEOUT = "5 seconds";
const STOP_GRACE = "5 seconds";
const STOP_WAIT = "10 seconds";
const HEALTH_INTERVAL = "500 millis";
const HEALTH_WAIT = "30 seconds";
const RESTART_DELAYS = [1_000, 2_000, 4_000, 8_000];
const STABLE_AFTER = "5 minutes";
const PROXY_ENV = new Set(
  "PATH HOME TMPDIR TMP TEMP LANG LC_ALL TZ HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY SSL_CERT_FILE SSL_CERT_DIR SYSTEMROOT SYSTEMDRIVE WINDIR USERPROFILE HOMEDRIVE HOMEPATH APPDATA LOCALAPPDATA PROGRAMDATA COMSPEC PATHEXT USERNAME".split(
    " ",
  ),
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const urlFor = (port: number) => `http://${LOOPBACK}:${port}`;

export const SUPERVISOR = String.raw`const { spawn } = require("node:child_process");
const [command, ...args] = process.argv.slice(1);
const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
let ending = false;
const end = () => { if (ending) return; ending = true; child.kill(); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); };
child.once("spawn", () => process.stdout.write("pid " + child.pid + "\n"));
child.once("error", () => process.exit(126));
child.once("exit", (code) => process.exit(code ?? 1));
process.stdout.on("error", end);
process.stdin.on("end", end).on("close", end).on("error", end).resume();
for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(name, end);`;

const messages = {
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
} satisfies Record<FactoryProxyRefusal, string>;
const refusal = (reason: FactoryProxyRefusal) =>
  new FactoryProxyError({ reason, message: messages[reason] });

interface Methods {
  readonly drain: Effect.Effect<void>;
  readonly status: (
    input?: FactoryProxyNoInput,
  ) => Effect.Effect<FactoryProxyStatus, FactoryProxyError>;
  readonly install: (
    input: FactoryProxyInstallInput,
  ) => Effect.Effect<FactoryProxyStatus, FactoryProxyError>;
  readonly start: (
    input?: FactoryProxyNoInput,
  ) => Effect.Effect<FactoryProxyStatus, FactoryProxyError>;
  readonly stop: (
    input?: FactoryProxyNoInput,
  ) => Effect.Effect<FactoryProxyStatus, FactoryProxyError>;
  readonly uninstall: (
    input: FactoryProxyUninstallInput,
  ) => Effect.Effect<FactoryProxyStatus, FactoryProxyError>;
}
const refuseUnavailable = Effect.fn("FactoryProxy.unavailable")(function* () {
  return yield* refusal("unavailable");
});
export const unavailable: Methods = {
  drain: Effect.void,
  status: refuseUnavailable,
  install: refuseUnavailable,
  start: refuseUnavailable,
  stop: refuseUnavailable,
  uninstall: refuseUnavailable,
};

class JobProblem extends Schema.TaggedError<JobProblem>()("FactoryProxyJobProblem", {
  problem: FactoryProxyProblem,
}) {}
const isJobProblem = Schema.is(JobProblem);
const fault = (problem: FactoryProxyProblem) => new JobProblem({ problem });
const asProblem = (problem: FactoryProxyProblem) => Effect.mapError(() => fault(problem));
const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?![\s\S])/));
const ProxyRecord = Schema.Struct({
  v: Schema.Literal(1),
  phase: Schema.Literals(["installing", "installed", "removing"]),
  proxy: Version,
  console: Version,
  platform: Schema.String,
  executableSha256: Schema.NullOr(Sha256),
  consoleSha256: Sha256,
  port: Schema.Int.check(
    Schema.isBetween({ minimum: FACTORY_PROXY_PORT_FIRST, maximum: FACTORY_PROXY_PORT_LAST }),
  ),
  consoleKey: Schema.Literals(["typed", "generated"]),
  desired: Schema.Literals(["running", "stopped"]),
  installedAt: IsoDateTime,
  process: Schema.NullOr(Schema.Struct({ pid: PositiveInt })),
});
type ProxyRecord = typeof ProxyRecord.Type;
const recordJson = Schema.fromJsonString(ProxyRecord);
const decodeRecord = Schema.decodeOption(recordJson);
const encodeRecord = Schema.encodeEffect(recordJson);

type OwnerQuery = { readonly port: number; readonly pid: number };
type Ownership = "ours" | "other";
const goodOutput = (out: ProcessRunner.ProcessRunOutput) =>
  out.code === 0 &&
  !out.timedOut &&
  !out.stdoutTruncated &&
  !out.stderrTruncated &&
  !out.stdoutInvalidUtf8 &&
  !out.stderrInvalidUtf8;

function windowsOwnership(text: string, { port, pid }: OwnerQuery): Ownership {
  let found = false;
  const suffix = `:${port}`;
  const namesPort = new RegExp(`(?:^|[:\\s])${port}(?!\\d)`);
  for (const line of text.split(/\r?\n/)) {
    if (!namesPort.test(line)) continue;
    const fields = line.trim().split(/\s+/);
    const [proto, local, foreign, state, owner] = fields;
    if (
      proto?.toUpperCase() !== "TCP" ||
      fields.length !== 5 ||
      !local ||
      !foreign ||
      !/^.+:\d+$/.test(local) ||
      !/^.+:\d+$/.test(foreign) ||
      !state ||
      !owner ||
      !/^\d+$/.test(owner)
    )
      return "other";
    if (!local.endsWith(suffix) || !foreign.endsWith(":0")) continue;
    if (!/^(?:0\.0\.0\.0|\[::\]|::):0$/.test(foreign)) return "other";
    const host = local.slice(0, -suffix.length);
    if ((!LSOF_LOCAL_HOST_TOKENS.has(host) && host !== "::") || Number(owner) !== pid)
      return "other";
    found = true;
  }
  return found ? "ours" : "other";
}

function macOwnership(text: string, { port, pid }: OwnerQuery): Ownership {
  let current = 0;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    if (line && !/^[pcn]/.test(line)) return "other";
    if (line.startsWith("p")) current = /^p\d+$/.test(line) ? Number(line.slice(1)) : 0;
    if (!line.includes(`:${port}`)) continue;
    const entry = /^n(\S+):(\d+)$/.exec(line);
    if (!entry) return "other";
    if (Number(entry[2]) !== port) continue;
    if (!LSOF_LOCAL_HOST_TOKENS.has(entry[1]!) || current !== pid) return "other";
    found = true;
  }
  return found ? "ours" : "other";
}

const procOwnership = Effect.fn("FactoryProxy.procOwnership")(function* (
  fs: FileSystem.FileSystem,
  { port, pid }: OwnerQuery,
): Effect.fn.Return<Ownership, PlatformError.PlatformError> {
  const inodes = new Set<string>();
  let localListener = false;
  for (const table of ["tcp", "tcp6"]) {
    const text = yield* fs.readFileString(`/proc/net/${table}`).pipe(
      Effect.catchIf(
        (error) => table === "tcp6" && error.reason._tag === "NotFound",
        () => Effect.succeed(""),
      ),
    );
    for (const line of text.split("\n")) {
      if (!line.trim() || /^\s*sl\s+local_address\s/.test(line)) continue;
      const fields = line.trim().split(/\s+/);
      const endpoint = /^([\da-f]{8}|[\da-f]{32}):([\da-f]{4})$/i.exec(fields[1] ?? "");
      if (!endpoint) return "other";
      if (Number.parseInt(endpoint[2]!, 16) !== port) continue;
      if (
        !/^\d+:$/.test(fields[0] ?? "") ||
        !/^(?:[\da-f]{8}|[\da-f]{32}):[\da-f]{4}$/i.test(fields[2] ?? "")
      )
        return "other";
      if (!/^[\da-f]{2}$/i.test(fields[3] ?? "")) return "other";
      if (fields[3]?.toUpperCase() !== "0A") continue;
      const inode = fields[9];
      if (!inode || !/^[1-9]\d*$/.test(inode)) return "other";
      inodes.add(`socket:[${inode}]`);
      if (/^(?:0+|0100007f|0{24}01000000|0{16}ffff00000100007f)$/i.test(endpoint[1]!))
        localListener = true;
    }
  }
  if (!localListener) return "other";
  const folder = `/proc/${pid}/fd`;
  for (const fd of yield* fs.readDirectory(folder)) {
    const target = yield* fs.readLink(`${folder}/${fd}`).pipe(Effect.option);
    if (Option.isSome(target)) inodes.delete(target.value);
  }
  return inodes.size === 0 ? "ours" : "other";
});

export const listenerOwner = Effect.fn("FactoryProxy.listenerOwner")(
  function* (input: OwnerQuery) {
    const platform = yield* HostProcess.Platform;
    if (!Number.isSafeInteger(input.pid) || input.pid < 1) return "other" as const;
    if (platform === "linux") {
      const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
      return Option.isNone(fs) ? ("other" as const) : yield* procOwnership(fs.value, input);
    }
    if (platform !== "win32" && platform !== "darwin") return "other" as const;
    const provided = yield* Effect.serviceOption(ProcessRunner.ProcessRunner);
    const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
    const runner = Option.isSome(provided)
      ? provided.value
      : Option.isSome(spawner)
        ? yield* ProcessRunner.make().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner.value),
          )
        : null;
    if (!runner) return "other" as const;
    const query = (command: string, args: ReadonlyArray<string>) =>
      runner.run({ command, args, timeout: QUERY_TIMEOUT, maxOutputBytes: 16 * 1024 * 1024 });
    if (platform === "darwin") {
      const result = yield* query("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"]);
      return goodOutput(result) ? macOwnership(result.stdout, input) : ("other" as const);
    }
    const lists = yield* Effect.forEach(
      ["tcp", "tcpv6"],
      (protocol) => query("netstat.exe", ["-ano", "-p", protocol]),
      { concurrency: 2 },
    );
    return lists.every(goodOutput)
      ? windowsOwnership(lists.map((list) => list.stdout).join("\n"), input)
      : ("other" as const);
  },
  Effect.timeout(QUERY_TIMEOUT),
  Effect.orElseSucceed(() => "other" as const),
  Effect.catchDefect(() => Effect.succeed("other" as const)),
);

export const Host = Context.Reference<{
  readonly manifest: typeof readVendorManifest;
  readonly download: Download;
  readonly listenerOwner: (input: OwnerQuery) => Effect.Effect<Ownership>;
}>("t3/factory/FactoryProxy/Host", {
  defaultValue: () => ({ manifest: readVendorManifest, download: liveDownload, listenerOwner }),
});

const ownedConfig = (port: number, authDir: string, managementKey: string, clientKey: string) => ({
  server: {
    host: LOOPBACK,
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
    "panel-github-repository": PANEL_REPO,
  },
  oauth: { "auth-dir": authDir },
  observability: { pprof: { enable: false } },
  plugins: { enabled: false },
  access: { "api-keys": [clientKey] },
});
type ConfigFields = { readonly [key: string]: string | number | boolean | string[] | ConfigFields };
function template(fields: ConfigFields, indent = ""): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      const head = `${indent}${key}:`;
      if (Array.isArray(value)) return `${head}\n${indent}  - ${JSON.stringify(value[0])}\n`;
      if (typeof value === "object") return `${head}\n${template(value, `${indent}  `)}`;
      return `${head} ${JSON.stringify(value)}\n`;
    })
    .join("");
}

// Parsing, alias resolution and serialization are called only inside the same sanitizing guard.
function parseConfig(text: string, port: number, authDir: string) {
  const doc = parseDocument(text, { intAsBigInt: true, prettyErrors: false, logLevel: "silent" });
  const mapClass = doc.createNode({}).constructor;
  if (doc.errors.length || doc.contents?.constructor !== mapClass) return null;
  const data: unknown = doc.toJS({ mapAsMap: true });
  if (!(data instanceof Map)) return null;
  const access: unknown = data.get("access");
  const keys: unknown = access instanceof Map ? access.get("api-keys") : undefined;
  function visit(fields: ConfigFields, parent: string[], write: boolean): boolean {
    for (const [name, value] of Object.entries(fields)) {
      const path = [...parent, name];
      if (Array.isArray(value)) {
        if (!write) continue;
        if (!Array.isArray(keys)) doc.setIn(path, doc.createNode(value));
        else if (!keys.includes(value[0])) {
          if (doc.getIn(path, true)?.constructor === doc.createNode([]).constructor)
            doc.addIn(path, value[0]);
          else doc.setIn(path, doc.createNode([...keys, value[0]]));
        }
      } else if (typeof value === "object") {
        if (doc.hasIn(path) && doc.getIn(path, true)?.constructor !== mapClass) return false;
        if (!visit(value, path, write)) return false;
      } else if (write) doc.setIn(path, value);
    }
    return true;
  }
  if (!visit(ownedConfig(port, authDir, "", ""), [], false)) return null;
  return (managementKey: string, clientKey: string) => {
    visit(ownedConfig(port, authDir, managementKey, clientKey), [], true);
    return doc.toString({ lineWidth: 0 });
  };
}

interface Active {
  readonly scope: Scope.Closeable;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly managementKey: Redacted.Redacted<string>;
  readonly port: number;
  pid: number | null;
  exited: boolean;
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const api = yield* makeCliproxyApi;
  const runner = yield* ProcessRunner.make();
  const net = yield* Net.NetService;
  const random = yield* SecureRandom.SecureRandom;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const host = yield* Host;
  const os = yield* HostProcess.Platform;
  const platform = `${os}-${yield* HostProcess.Architecture}`;
  const node = yield* HostProcess.ExecutablePath;
  const environment = yield* HostProcess.Environment;
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key]) => PROXY_ENV.has(key.toUpperCase())),
  );
  const root = path.resolve(config.stateDir, FACTORY_PROXY_SOURCE_ID);
  const recordPath = path.join(root, "record.json");
  const configPath = path.join(root, "config.yaml");
  const auth = path.join(root, "auth");
  const authDir = auth.split(path.sep).join("/");
  const releases = path.join(root, "releases");
  const panelDir = path.join(root, "static");
  const panel = path.join(panelDir, "management.html");
  const executableName = os === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
  const fileServices = Context.make(FileSystem.FileSystem, fs).pipe(
    Context.add(Path.Path, path),
    Context.add(HostProcess.Platform, os),
  );
  const pins = host.manifest.pipe(
    Effect.provideContext(fileServices),
    Effect.map((manifest) => (manifest.checkout ? pinnedFor(manifest.text, platform) : null)),
  );
  const lock = yield* Semaphore.make(1);
  const recordLock = yield* Semaphore.make(1);
  const hubLock = yield* Semaphore.make(1);
  const ready = yield* Deferred.make<void>();
  let record: ProxyRecord | null = null;
  let damagedRecord = false;
  let initialized = false;
  let state: FactoryProxyState = "not-installed";
  let hub: FactoryProxyHub = "disconnected";
  let problem: FactoryProxyProblem | null = null;
  let exitCode: number | null = null;
  let restarts = 0;
  let active: Active | null = null;
  let worker: Fiber.Fiber<void> | null = null;
  let removing = false;
  let fileJob: { decision: Effect.Effect<void>; background: Fiber.Fiber<void> | null } = {
    decision: Effect.void,
    background: null,
  };
  const drain = Effect.suspend(() => {
    const job = fileJob;
    return job.decision.pipe(
      Effect.andThen(() =>
        job.background ? Effect.asVoid(Fiber.await(job.background)) : Effect.void,
      ),
    );
  });
  const trackFileJob = Effect.fn("FactoryProxy.trackFileJob")(function* <A, E>(
    effect: Effect.Effect<A, E>,
  ) {
    const decided = yield* Deferred.make<void>();
    fileJob = { decision: Deferred.await(decided), background: null };
    return yield* effect.pipe(Effect.ensuring(Deferred.succeed(decided, undefined)));
  });

  const kind = (name: string) =>
    fs.lstat(name).pipe(
      Effect.map((info) => info.type),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );
  const inspect = Effect.fn("FactoryProxy.readRecord")(
    function* () {
      const folder = yield* kind(root);
      if (folder === null) return null;
      if (folder !== "Directory") return "damaged" as const;
      const type = yield* kind(recordPath);
      if (type === null) return null;
      if (type !== "File") return "damaged" as const;
      return Option.getOrElse(
        decodeRecord(yield* fs.readFileString(recordPath)),
        () => "damaged" as const,
      );
    },
    Effect.orElseSucceed(() => "damaged" as const),
  );

  const observedHub = Effect.gen(function* () {
    const run = active;
    if (hub !== "connected" || !run) return hub;
    const snapshot = yield* settings.getSettings.pipe(Effect.option);
    if (Option.isSome(snapshot) && run === active && hub === "connected") {
      const entry = snapshot.value.usageLimitSources[SOURCE];
      if (
        !entry?.enabled ||
        entry.kind !== "cliproxy" ||
        entry.url !== urlFor(run.port) ||
        entry.managementKey !== Redacted.value(run.managementKey)
      )
        hub = "disconnected";
    }
    return hub;
  });
  const status = Effect.fn("FactoryProxy.status")(function* (
    _input?: FactoryProxyNoInput,
  ): Effect.fn.Return<FactoryProxyStatus> {
    const pin = yield* pins;
    const credentials = yield* Effect.gen(function* () {
      return (yield* kind(root)) === "Directory" && (yield* kind(auth)) === "Directory";
    }).pipe(Effect.orElseSucceed(() => false));
    const connection = yield* observedHub;
    const initial = initialized ? null : yield* inspect();
    const rec = initialized ? record : initial === "damaged" ? null : initial;
    const interrupted = !initialized && rec !== null && rec.phase !== "installed";
    const bad = !initialized && initial === "damaged";
    return {
      state: initialized
        ? state
        : bad || interrupted
          ? "failed"
          : rec?.desired === "running"
            ? "starting"
            : rec
              ? "stopped"
              : "not-installed",
      desired: rec?.desired ?? null,
      hub: connection,
      platform,
      supported: !!pin && "files" in pin && pin.files !== null,
      pinned: pin && "files" in pin ? { proxy: pin.proxy, console: pin.console } : null,
      installed: rec?.phase === "installed" ? { proxy: rec.proxy, console: rec.console } : null,
      port: rec?.port ?? null,
      consoleUrl: rec?.phase === "installed" ? `${urlFor(rec.port)}/management.html` : null,
      consoleKey: rec?.consoleKey ?? null,
      credentials,
      restarts,
      pid: rec?.process?.pid ?? null,
      exitCode,
      problem: bad ? "damaged" : interrupted ? "interrupted" : problem,
    };
  });

  const atomic = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(Effect.provideContext(fileServices));
  const persist = Effect.fn("FactoryProxy.persist")(
    function* (next: ProxyRecord) {
      const type = yield* kind(recordPath);
      if ((yield* kind(root)) !== "Directory" || (type !== null && type !== "File"))
        return yield* fault("write");
      yield* atomic(recordPath, yield* encodeRecord(next));
      record = next;
    },
    asProblem("write"),
    Effect.uninterruptible,
  );
  const updateRecord = (patch: Partial<ProxyRecord>) =>
    recordLock.withPermit(
      Effect.suspend(() =>
        record ? persist({ ...record, ...patch }) : Effect.fail(fault("damaged")),
      ),
    );
  const setFailed = (code: FactoryProxyProblem) => {
    state = "failed";
    problem = code;
  };
  const writeKey = (name: string, text: string) => secrets.set(name, encoder.encode(text));
  const readKey = (name: string) =>
    secrets.get(name).pipe(Effect.map(Option.map((bytes) => decoder.decode(bytes))));
  const newKey = Effect.fn("FactoryProxy.newKey")(function* () {
    return Base64Url.encode(yield* random.randomBytes(32));
  });

  const patchSource = (entry: UsageLimitSourceConfig | null) =>
    settings.updateSettings({ usageLimitSources: { [SOURCE]: entry } });
  const disableHub = hubLock.withPermit(
    Effect.gen(function* () {
      if (removing) return;
      const entry = (yield* settings.getSettings).usageLimitSources[SOURCE];
      if (entry?.enabled) yield* patchSource({ ...entry, enabled: false });
      hub = "disconnected";
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          hub = "disable-refused";
        }),
      ),
    ),
  );
  const removeHub = hubLock.withPermit(
    Effect.gen(function* () {
      if ((yield* settings.getSettings).usageLimitSources[SOURCE]) yield* patchSource(null);
      if (Option.isSome(yield* secrets.get(SETTINGS_KEY))) return yield* refusal("remove-refused");
      hub = "disconnected";
      removing = true;
    }).pipe(
      Effect.mapError(() => refusal("remove-refused")),
      Effect.tapError(() =>
        Effect.sync(() => {
          hub = "remove-refused";
        }),
      ),
    ),
  );

  const proved = Effect.fn("FactoryProxy.proved")(
    function* (run: Active) {
      if (
        removing ||
        run.exited ||
        active !== run ||
        run.pid === null ||
        !(yield* run.child.isRunning)
      )
        return false;
      const owner = yield* host
        .listenerOwner({ port: run.port, pid: run.pid })
        .pipe(
          Effect.provideContext(fileServices),
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.timeoutOption(QUERY_TIMEOUT),
        );
      return (
        Option.isSome(owner) &&
        owner.value === "ours" &&
        !removing &&
        !run.exited &&
        active === run &&
        (yield* run.child.isRunning)
      );
    },
    Effect.orElseSucceed(() => false),
    Effect.catchDefect(() => Effect.succeed(false)),
  );
  const enableHub = Effect.fn("FactoryProxy.enableHub")(
    function* (run: Active) {
      if (!(yield* proved(run))) return false;
      const enabled = yield* Effect.isSuccess(
        patchSource({
          kind: "cliproxy",
          label: "Factory proxy",
          url: urlFor(run.port),
          managementKey: Redacted.value(run.managementKey),
          enabled: true,
        }),
      ).pipe(Effect.uninterruptible);
      hub = enabled ? "connected" : "enable-refused";
      return true;
    },
    (effect) => hubLock.withPermit(effect),
  );

  const prune = Effect.fn("FactoryProxy.prune")(
    function* (removeCredentials: boolean) {
      const type = yield* kind(root);
      if (type === null) return true;
      if (type !== "Directory") return yield* Effect.isSuccess(fs.remove(root));
      const entries = yield* fs.readDirectory(root).pipe(Effect.option);
      let clean = Option.isSome(entries);
      for (const name of Option.getOrElse(entries, () => [])) {
        if (name === "record.json" || name === "auth") continue;
        if (
          !(yield* Effect.isSuccess(
            fs.remove(path.join(root, name), { recursive: true, force: true }),
          ))
        )
          clean = false;
      }
      if (
        removeCredentials &&
        !(yield* Effect.isSuccess(fs.remove(auth, { recursive: true, force: true })))
      )
        clean = false;
      return clean;
    },
    Effect.orElseSucceed(() => false),
  );
  const cleanup = Effect.fn("FactoryProxy.cleanup")(
    function* (removeCredentials: boolean, previousStepsOk: boolean) {
      const a = yield* Effect.isSuccess(secrets.remove(MANAGEMENT_KEY));
      const b = yield* Effect.isSuccess(secrets.remove(CLIENT_KEY));
      const files = yield* prune(removeCredentials);
      if (!a || !b || !files || !previousStepsOk) return false;
      if ((yield* kind(root)) === "Directory") {
        const retained = (yield* fs.readDirectory(root)).filter((name) => name !== "record.json");
        if (retained.some((name) => removeCredentials || name !== "auth")) return false;
        yield* fs.remove(recordPath, { recursive: true, force: true });
        if (retained.length === 0) {
          const removed = yield* Effect.isSuccess(fs.remove(root, { recursive: true }));
          if (!removed) {
            if (record) yield* persist(record);
            return false;
          }
        }
      }
      record = null;
      damagedRecord = false;
      return true;
    },
    Effect.orElseSucceed(() => false),
  );

  const extract = Effect.fn("FactoryProxy.extract")(function* (archivePath: string, dest: string) {
    const names = new Set([
      executableName,
      "config.example.yaml",
      "LICENSE",
      "README.md",
      "README_CN.md",
    ]);
    const unsafe = fault("archive");
    const writeExecutable = Effect.fn("FactoryProxy.writeExecutable")(function* (
      stream: Stream.Stream<Uint8Array, JobProblem>,
    ) {
      let size = 0;
      yield* stream.pipe(
        Stream.tap((bytes) => {
          size += bytes.byteLength;
          return size > EXECUTABLE_BYTES_MAX ? Effect.fail(unsafe) : Effect.void;
        }),
        Stream.run(fs.sink(dest, { flag: "wx", mode: 0o700 })),
        Effect.mapError((e) => (isJobProblem(e) ? e : fault("write"))),
      );
      if (size === 0) return yield* unsafe;
    });
    if (os === "win32") {
      const zip = yield* openZipArchive(archivePath, () => unsafe);
      if (zip.entryCount !== names.size) return yield* unsafe;
      for (;;) {
        const entry = yield* zip.next;
        if (!entry) break;
        const type = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (
          !names.delete(entry.fileName) ||
          (type !== 0 && type !== 0o100000) ||
          (entry.externalFileAttributes & 0x10) !== 0 ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
        )
          return yield* unsafe;
        if (entry.fileName === executableName) {
          const readable = yield* zip.streamEntry(entry);
          yield* writeExecutable(
            EffectNodeStream.fromReadable<Uint8Array, JobProblem>({
              evaluate: () => readable,
              onError: () => unsafe,
            }),
          );
        }
      }
      if (names.size !== 0) return yield* unsafe;
    } else {
      const tar = cliArchiveTarCommand(os, environment);
      const list = Effect.fn("FactoryProxy.listArchive")(function* (flag: string) {
        const result = yield* runner
          .run({ command: tar, args: [flag, archivePath] })
          .pipe(asProblem("archive"));
        if (!goodOutput(result)) return yield* unsafe;
        return result.stdout.split(/\r?\n/).filter((line) => line !== "");
      });
      const expected = [...names].sort();
      const short = (yield* list("-tzf")).sort();
      if (short.length !== expected.length || short.some((name, i) => name !== expected[i]))
        return yield* unsafe;
      const long = yield* list("-tvzf");
      if (long.length !== expected.length || long.some((line) => !line.startsWith("-")))
        return yield* unsafe;
      const child = yield* spawner
        .spawn(
          ChildProcess.make(tar, ["-xOzf", archivePath, executableName], {
            stdout: "pipe",
            stderr: "ignore",
          }),
        )
        .pipe(asProblem("archive"));
      yield* writeExecutable(child.stdout.pipe(Stream.mapError(() => unsafe)));
      if ((yield* child.exitCode.pipe(asProblem("archive"))) !== 0) return yield* unsafe;
      yield* fs.chmod(dest, 0o755).pipe(asProblem("write"));
    }
  }, Effect.scoped);

  const installFiles = Effect.fn("FactoryProxy.installFiles")(
    function* (rec: ProxyRecord, files: ReadonlyArray<PinnedFile>, typed: string) {
      if (!(yield* prune(false))) return yield* fault("write");
      const bodies = new Map<PinnedFile["role"], Uint8Array>();
      for (const file of files) {
        const fetched = yield* fetchPinned(file, host.download).pipe(
          Effect.timeout("5 minutes"),
          asProblem("download"),
        );
        if ("failure" in fetched) {
          yield* Effect.logWarning(fetched.line);
          return yield* fault(fetched.failure);
        }
        bodies.set(file.role, fetched.body);
      }
      const archive = bodies.get("archive"),
        consoleBody = bodies.get("console");
      const license = bodies.get("proxy-license"),
        consoleLicense = bodies.get("console-license");
      if (!archive || !consoleBody || !license || !consoleLicense) return yield* fault("verify");
      const digest = yield* Effect.scoped(
        Effect.gen(function* () {
          const staging = yield* fs.makeTempDirectoryScoped({
            directory: root,
            prefix: ".install-",
          });
          const archivePath = path.join(
            staging,
            os === "win32" ? "download.zip" : "download.tar.gz",
          );
          const release = path.join(staging, "release");
          const executable = path.join(release, executableName);
          yield* fs.writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
          yield* fs.makeDirectory(release);
          yield* extract(archivePath, executable);
          const hash = yield* sha256Hex(yield* fs.readFile(executable));
          const exclusive = { flag: "wx", mode: 0o644 } as const;
          yield* fs.writeFile(path.join(release, "LICENSE"), license, exclusive);
          yield* fs.writeFile(
            path.join(release, "LICENSE-management-center"),
            consoleLicense,
            exclusive,
          );
          yield* fs.makeDirectory(releases);
          yield* fs.rename(release, path.join(releases, rec.proxy));
          yield* fs.makeDirectory(panelDir);
          yield* fs.writeFile(panel, consoleBody, exclusive);
          const authType = yield* kind(auth);
          if (authType === null) yield* fs.makeDirectory(auth, { mode: 0o700 });
          else if (authType !== "Directory") return yield* fault("write");
          return hash;
        }),
      );
      if (typed) yield* writeKey(MANAGEMENT_KEY, typed);
      const client = yield* newKey();
      yield* writeKey(CLIENT_KEY, client);
      yield* atomic(
        configPath,
        `config-version: 8\n${template(ownedConfig(rec.port, authDir, "", client))}`,
      );
      if (os !== "win32") yield* fs.chmod(configPath, 0o600);
      yield* updateRecord({ phase: "installed", executableSha256: digest });
      state = "stopped";
    },
    Effect.mapError((error) => (isJobProblem(error) ? error : fault("write"))),
  );

  const configure = Effect.fn("FactoryProxy.configure")(
    function* (rec: ProxyRecord, write: boolean) {
      if ((yield* kind(root)) !== "Directory" || (yield* kind(configPath)) !== "File")
        return yield* fault("config-unreadable");
      const render = parseConfig(yield* fs.readFileString(configPath), rec.port, authDir);
      if (render === null) return yield* fault("config-unreadable");
      if (!write) {
        render("", "");
        return null;
      }
      const management =
        rec.consoleKey === "generated"
          ? yield* newKey()
          : Option.getOrNull(yield* readKey(MANAGEMENT_KEY).pipe(asProblem("damaged")));
      if (management === null || !FACTORY_PROXY_KEY_PATTERN.test(management))
        return yield* fault("damaged");
      const saved = yield* readKey(CLIENT_KEY).pipe(asProblem("damaged"));
      const missing = Option.isNone(saved) || saved.value === "";
      const client = missing ? yield* newKey() : saved.value;
      const contents = render(management, client);
      if (rec.consoleKey === "generated")
        yield* writeKey(MANAGEMENT_KEY, management).pipe(asProblem("damaged"));
      if (missing) yield* writeKey(CLIENT_KEY, client).pipe(asProblem("damaged"));
      yield* atomic(configPath, contents);
      if (os !== "win32") yield* fs.chmod(configPath, 0o600);
      return Redacted.make(management);
    },
    Effect.mapError((error) => (isJobProblem(error) ? error : fault("config-unreadable"))),
    Effect.catchDefect(() => Effect.fail(fault("config-unreadable"))),
  );

  const end = Effect.fn("FactoryProxy.end")(function* (run: Active) {
    if (!run.exited) {
      yield* disableHub;
      const ended = yield* Effect.gen(function* () {
        yield* Stream.run(Stream.empty, run.child.stdin).pipe(Effect.ignore);
        return yield* run.child.exitCode;
      }).pipe(
        Effect.interruptible,
        Effect.timeoutOption(STOP_WAIT),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(ended)) {
        exitCode = ended.value;
        if (record?.process)
          yield* updateRecord({ process: null }).pipe(
            Effect.catch(() => Effect.sync(() => setFailed("write"))),
          );
      } else if (yield* run.child.isRunning.pipe(Effect.orElseSucceed(() => false))) {
        yield* run.child.kill({ forceKillAfter: STOP_GRACE }).pipe(Effect.ignore);
      }
    }
    if (active === run) active = null;
  });
  const closeActive = Effect.suspend(() =>
    active ? Scope.close(active.scope, Exit.succeed(undefined)) : disableHub,
  );
  yield* Scope.addFinalizer(scope, closeActive);
  const launch = Effect.fn("FactoryProxy.launch")(function* (
    executable: string,
    port: number,
    managementKey: Redacted.Redacted<string>,
  ) {
    const childScope = yield* Scope.make("sequential");
    const command = ChildProcess.make(
      node,
      ["-e", SUPERVISOR, "--", executable, "-config", configPath, "-local-model"],
      {
        cwd: root,
        env,
        extendEnv: false,
        shell: false,
        detached: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: STOP_GRACE,
      },
    );
    const child = yield* Effect.suspend(() => spawner.spawn(command)).pipe(
      Scope.provide(childScope),
      asProblem("spawn"),
      Effect.catchDefect(() => Effect.fail(fault("spawn"))),
      Effect.onError(() => Scope.close(childScope, Exit.void)),
    );
    const run: Active = { scope: childScope, child, managementKey, port, pid: null, exited: false };
    active = run;
    const announced = yield* Deferred.make<number>();
    yield* run.child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(run.scope));
    yield* run.child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        if (run.pid !== null) return Effect.void;
        const match = /^pid (\d+)$/.exec(line);
        const pid = Number(match?.[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) return Effect.void;
        run.pid = pid;
        return Deferred.succeed(announced, pid);
      }),
      Effect.ignore,
      Effect.forkIn(run.scope),
    );
    yield* Scope.addFinalizer(childScope, end(run));
    return { run, announced };
  }, Effect.uninterruptible);

  const verifyFiles = Effect.fn("FactoryProxy.verifyFiles")(function* (rec: ProxyRecord) {
    const release = path.join(releases, rec.proxy);
    const exe = path.join(release, executableName);
    for (const dir of [root, releases, release, panelDir, auth])
      if ((yield* kind(dir)) !== "Directory") return yield* fault("damaged");
    for (const [file, hash] of [
      [exe, rec.executableSha256],
      [panel, rec.consoleSha256],
    ] as const) {
      if (
        hash === null ||
        (yield* kind(file)) !== "File" ||
        (yield* sha256Hex(yield* fs.readFile(file))) !== hash
      )
        return yield* fault("damaged");
    }
    return exe;
  }, asProblem("damaged"));

  const attempt = Effect.fn("FactoryProxy.attempt")(function* (rec: ProxyRecord) {
    if (!(yield* net.isPortAvailableOnLoopback(rec.port))) return "port-in-use" as const;
    if (rec.process) yield* updateRecord({ process: null });
    const exe = yield* verifyFiles(rec);
    const key = yield* configure(rec, true);
    if (key === null) return yield* fault("damaged");
    const { run, announced } = yield* launch(exe, rec.port, key);
    const exited = run.child.exitCode.pipe(
      Effect.map((code) => {
        exitCode = code;
        run.exited = true;
        return run.pid === null ? ("spawn" as const) : ("exited" as const);
      }),
      asProblem("spawn"),
    );
    const observe = Effect.gen(function* () {
      const pid = yield* Deferred.await(announced);
      yield* updateRecord({ process: { pid } });
      const health = yield* Effect.gen(function* () {
        for (;;) {
          if (!(yield* net.isPortAvailableOnLoopback(run.port))) {
            if (!(yield* proved(run))) return "port-in-use" as const;
            if (
              yield* Effect.isSuccess(
                api.readAccounts({ url: urlFor(run.port), managementKey: Redacted.value(key) }),
              )
            )
              return "healthy" as const;
          }
          yield* Effect.sleep(HEALTH_INTERVAL);
        }
      }).pipe(Effect.timeoutOption(HEALTH_WAIT));
      if (Option.isNone(health)) return "unhealthy" as const;
      if (health.value === "port-in-use") return health.value;
      state = "running";
      problem = null;
      yield* Effect.sleep(STABLE_AFTER).pipe(
        Effect.andThen(
          Effect.sync(() => {
            restarts = 0;
          }),
        ),
        Effect.forkChild,
      );
      if (!(yield* enableHub(run))) return "port-in-use" as const;
      return yield* Effect.never;
    });
    return yield* Effect.raceFirst(observe, exited).pipe(
      Effect.ensuring(Effect.suspend(() => (run.exited ? disableHub : Effect.void))),
    );
  });
  const supervise = Effect.fn("FactoryProxy.supervise")(
    function* () {
      for (;;) {
        const current = record;
        if (current?.phase !== "installed" || current.desired !== "running") return;
        const outcome = yield* attempt(current);
        if (active) yield* closeActive;
        if (outcome === "port-in-use") {
          state = outcome;
          problem = null;
          return;
        }
        if (outcome === "spawn") {
          setFailed(outcome);
          return;
        }
        problem = outcome;
        const delay = RESTART_DELAYS[restarts++];
        if (delay === undefined) {
          setFailed(outcome);
          return;
        }
        state = "starting";
        yield* Effect.sleep(delay);
      }
    },
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (active) yield* closeActive;
        setFailed(error.problem);
      }),
    ),
  );
  const begin = Effect.fn("FactoryProxy.begin")(function* () {
    state = "starting";
    worker = yield* supervise().pipe(Effect.forkIn(scope));
  });
  const interruptWorker = Effect.suspend(() => (worker ? Fiber.interrupt(worker) : Effect.void));
  yield* Effect.gen(function* () {
    yield* disableHub;
    const found = yield* inspect();
    if (found === "damaged") {
      damagedRecord = true;
      setFailed("damaged");
    } else if (found !== null) {
      record = found;
      if (found.phase !== "installed") setFailed("interrupted");
      else if (found.desired === "running") yield* begin();
      else state = "stopped";
    }
    initialized = true;
    yield* Deferred.succeed(ready, undefined);
  }).pipe(Effect.forkIn(scope));

  const decideMutation = <A, E>(effect: Effect.Effect<A, E>, onlyCredentials: boolean) =>
    lock
      .withPermitsIfAvailable(1)(
        Effect.gen(function* () {
          yield* Deferred.await(ready);
          if (state === "installing")
            return yield* refusal(onlyCredentials ? "already-installed" : "busy");
          return yield* effect;
        }),
      )
      .pipe(
        Effect.flatMap((result) =>
          Effect.fromOption(result, () =>
            refusal(onlyCredentials && (record || damagedRecord) ? "already-installed" : "busy"),
          ),
        ),
        Effect.uninterruptible,
      );
  const mutation = <A, E>(effect: Effect.Effect<A, E>) => decideMutation(effect, false);
  const removeOwned = Effect.fn("FactoryProxy.removeOwned")(function* (removeCredentials: boolean) {
    const marked =
      !record || (yield* Effect.isSuccess(updateRecord({ phase: "removing", desired: "stopped" })));
    yield* interruptWorker;
    yield* closeActive;
    const clean = yield* cleanup(removeCredentials, marked);
    removing = false;
    return clean;
  });
  const finishInstallFailure = Effect.fn("FactoryProxy.installFailure")(function* (
    error: JobProblem,
  ) {
    const gone = yield* Effect.isSuccess(removeHub);
    const clean = gone && (yield* removeOwned(false));
    state = clean ? "not-installed" : "failed";
    problem = clean ? error.problem : "leftover";
  });
  const install = Effect.fn("FactoryProxy.install")(
    function* (input: FactoryProxyInstallInput) {
      const typed = input.managementKey ? Redacted.value(input.managementKey).trim() : "";
      if (typed && !FACTORY_PROXY_KEY_PATTERN.test(typed)) return yield* refusal("invalid-key");
      if (damagedRecord || record || (yield* inspect()) !== null)
        return yield* refusal("already-installed");
      const pin = yield* pins;
      if (!pin) return yield* refusal("no-checkout");
      if ("problems" in pin) return yield* refusal("manifest");
      if (pin.files === null) return yield* refusal("unsupported-platform");
      const consoleFile = pin.files.find((file) => file.role === "console");
      if (!consoleFile) return yield* refusal("manifest");
      let port: number = FACTORY_PROXY_PORT_FIRST;
      while (port <= FACTORY_PROXY_PORT_LAST && !(yield* net.isPortAvailableOnLoopback(port)))
        port++;
      if (port > FACTORY_PROXY_PORT_LAST) return yield* refusal("no-free-port");
      const rec: ProxyRecord = {
        v: 1,
        phase: "installing",
        proxy: pin.proxy,
        console: pin.console,
        platform,
        executableSha256: null,
        consoleSha256: consoleFile.sha256,
        port,
        consoleKey: typed ? "typed" : "generated",
        desired: "stopped",
        installedAt: DateTime.formatIso(yield* DateTime.now),
        process: null,
      };
      problem = null;
      exitCode = null;
      restarts = 0;
      const saved = yield* Effect.isSuccess(
        fs.makeDirectory(root, { recursive: true, mode: 0o700 }).pipe(Effect.andThen(persist(rec))),
      );
      if (!saved) {
        yield* finishInstallFailure(fault("write"));
        return yield* status();
      }
      state = "installing";
      const answer = yield* status();
      const job = fileJob;
      const background = yield* installFiles(rec, pin.files, typed).pipe(
        Effect.catch(finishInstallFailure),
        Effect.forkIn(scope),
      );
      job.background = background;
      background.addObserver(() => {
        job.background = null;
      });
      return answer;
    },
    trackFileJob,
    mutation,
  );

  const start = Effect.fn("FactoryProxy.start")(function* (_input?: FactoryProxyNoInput) {
    if (damagedRecord || (record && record.phase !== "installed")) return yield* status();
    if (!record) return yield* refusal("not-installed");
    if (state === "starting") return yield* status();
    if (state === "running") {
      const run = active;
      if (
        (yield* observedHub) !== "connected" &&
        run &&
        !(yield* enableHub(run)) &&
        active === run &&
        !run.exited
      ) {
        yield* interruptWorker;
        yield* closeActive;
        state = "port-in-use";
      }
      return yield* status();
    }
    if (problem === "config-unreadable" || !(yield* Effect.isSuccess(configure(record, false))))
      return yield* refusal("config-unreadable");
    if (!(yield* Effect.isSuccess(updateRecord({ desired: "running" })))) {
      setFailed("write");
      return yield* status();
    }
    restarts = 0;
    problem = null;
    state = "starting";
    const answer = yield* status();
    yield* begin();
    return answer;
  }, mutation);
  const stop = Effect.fn("FactoryProxy.stop")(function* (_input?: FactoryProxyNoInput) {
    if (damagedRecord || (record && record.phase !== "installed")) return yield* status();
    if (!record) return yield* refusal("not-installed");
    if (state === "stopped") {
      if (hub === "disable-refused") yield* disableHub;
      return yield* status();
    }
    if (!(yield* Effect.isSuccess(updateRecord({ desired: "stopped" })))) {
      setFailed("write");
      return yield* status();
    }
    yield* interruptWorker;
    yield* closeActive;
    state = "stopped";
    problem = null;
    return yield* status();
  }, mutation);
  const uninstall = Effect.fn("FactoryProxy.uninstall")(
    function* (input: FactoryProxyUninstallInput) {
      if (input.onlyCredentials) {
        if (damagedRecord || record || (yield* inspect()) !== null)
          return yield* refusal("already-installed");
        const clean = yield* Effect.isSuccess(
          Effect.gen(function* () {
            if ((yield* kind(root)) !== "Directory") return;
            yield* fs.remove(auth, { recursive: true, force: true });
            if ((yield* fs.readDirectory(root)).length === 0) yield* removeEmptyDirectory(root);
          }),
        );
        if (clean) {
          state = "not-installed";
          problem = null;
        } else setFailed("leftover");
        return yield* status();
      }
      if (
        record?.process &&
        (!active || !(yield* active.child.isRunning.pipe(Effect.orElseSucceed(() => false)))) &&
        !(yield* net.isPortAvailableOnLoopback(record.port))
      )
        return yield* refusal("earlier-run");
      yield* removeHub;
      problem = null;
      const clean = yield* removeOwned(input.removeCredentials);
      if (clean) {
        state = "not-installed";
        problem = null;
        restarts = 0;
        exitCode = null;
      } else setFailed("leftover");
      return yield* status();
    },
    trackFileJob,
    (effect, input) => decideMutation(effect, input.onlyCredentials === true),
  );
  const methods: Methods = { status, install, start, stop, uninstall, drain };
  return methods;
});

export const makeOrUnavailable = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const secrets = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  const http = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (
    Option.isNone(config) ||
    Option.isNone(settings) ||
    Option.isNone(secrets) ||
    Option.isNone(spawner) ||
    Option.isNone(http)
  )
    return unavailable;
  return yield* make.pipe(
    Effect.provideService(ServerConfig.ServerConfig, config.value),
    Effect.provideService(ServerSettings.ServerSettingsService, settings.value),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets.value),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner.value),
    Effect.provideService(HttpClient.HttpClient, http.value),
    Effect.provide(Net.layer),
  );
});
