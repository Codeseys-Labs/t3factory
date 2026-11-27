// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off globalErrorInEffectCatch:off -- Stubs die with plain Errors and stand-in tar answers with plain text.
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  type AuthEnvironmentScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthRelayConfigureScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  FACTORY_PROXY_SOURCE_ID,
  FACTORY_WS_METHODS,
  type FactoryProxyStatus,
  WsRpcGroup,
  type UsageLimitSourceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Net from "@t3tools/shared/Net";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as RpcTest from "effect/rpc/RpcTest";
import { parseDocument } from "yaml";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeDownload } from "../../../../scripts/factory-vendor-lib.ts";
import * as FactoryTasks from "./FactoryTasks.ts";
import * as FactoryProxy from "./FactoryProxy.ts";
import {
  ARCHIVE_URL,
  CLIENT_KEY_NAME,
  CONSOLE_BYTES,
  CONSOLE_LICENSE_BYTES,
  CONSOLE_LICENSE_URL,
  CONSOLE_URL,
  CONSOLE_VERSION,
  EXE_BYTES,
  LINUX_ARCHIVE_NAMES,
  MANAGEMENT_KEY_NAME,
  MANIFEST_TEXT,
  EXECUTABLE_BYTES_MAX,
  PANEL_REPOSITORY,
  PROXY_LICENSE_BYTES,
  PROXY_LICENSE_URL,
  PROXY_VERSION,
  REFUSALS,
  SETTINGS_SECRET_NAME,
  WIN_ARCHIVE_NAMES,
  WIN_ZIP,
  type ScriptedReply,
  type World,
  type ZipEntry,
  awaitCount,
  awaitEvent,
  awaitStatus,
  countEvent,
  expectedConfig,
  firstIndex,
  install,
  lastIndex,
  makeZip,
  managementKeyOf,
  processAlive,
  proxyEntry,
  recordOf,
  refusalOf,
  rootListing,
  scanHome,
  scriptedHandle,
  secretText,
  requiredSecretText,
  seedInstalledRecord,
  sha256Hex,
  startToRunning,
  unslash,
  withWorld,
  zipMember,
  decoder,
  encoder,
} from "./FactoryProxy.testkit.ts";

describe("P11-1 the scope gate", () => {
  const statusFixture: FactoryProxyStatus = {
    state: "not-installed",
    desired: null,
    hub: "disconnected",
    platform: "win32-x64",
    supported: true,
    pinned: { proxy: PROXY_VERSION, console: CONSOLE_VERSION },
    installed: null,
    port: null,
    consoleUrl: null,
    consoleKey: null,
    credentials: false,
    restarts: 0,
    pid: null,
    exitCode: null,
    problem: null,
  };

  const everyScopeButManage: ReadonlyArray<AuthEnvironmentScope> = [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
    AuthSettingsWriteScope,
    AuthEnvironmentMaintainScope,
    AuthPreviewOperateScope,
    AuthDiagnosticsReadScope,
    AuthTerminalReadScope,
    AuthTerminalOperateScope,
    AuthSourceControlWriteScope,
    AuthFilesystemReadScope,
    AuthFilesystemWriteScope,
    AuthAccessReadScope,
    AuthAccessWriteScope,
    AuthRelayReadScope,
    AuthRelayWriteScope,
    AuthRelayConfigureScope,
  ];
  const proxyTags = [
    FACTORY_WS_METHODS.factoryProxyStatus,
    FACTORY_WS_METHODS.factoryProxyInstall,
    FACTORY_WS_METHODS.factoryProxyStart,
    FACTORY_WS_METHODS.factoryProxyStop,
    FACTORY_WS_METHODS.factoryProxyUninstall,
  ] as const;
  type ProxyTag = (typeof proxyTags)[number];

  const makeClient = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
    Effect.gen(function* () {
      const entered: Array<string> = [];
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, ProxyTag> =>
            !(proxyTags as ReadonlyArray<string>).includes(tag),
        ),
      );
      const handlers = Layer.mergeAll(
        group.toLayerHandler(FACTORY_WS_METHODS.factoryProxyStatus, () =>
          Effect.sync(() => {
            entered.push("status");
            return statusFixture;
          }),
        ),
        group.toLayerHandler(FACTORY_WS_METHODS.factoryProxyInstall, () =>
          Effect.sync(() => {
            entered.push("install");
            return statusFixture;
          }),
        ),
        group.toLayerHandler(FACTORY_WS_METHODS.factoryProxyStart, () =>
          Effect.sync(() => {
            entered.push("start");
            return statusFixture;
          }),
        ),
        group.toLayerHandler(FACTORY_WS_METHODS.factoryProxyStop, () =>
          Effect.sync(() => {
            entered.push("stop");
            return statusFixture;
          }),
        ),
        group.toLayerHandler(FACTORY_WS_METHODS.factoryProxyUninstall, () =>
          Effect.sync(() => {
            entered.push("uninstall");
            return statusFixture;
          }),
        ),
      );
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.mergeAll(handlers, RpcAuthorization.layer(scopes))),
      );
      return { client, entered };
    });

  interface GateRefusal {
    readonly _tag: string;
    readonly requiredPermission: string;
  }
  const call = <A>(client: unknown, tag: string, payload: unknown): Effect.Effect<A, GateRefusal> =>
    (client as { readonly [key: string]: (input: unknown) => Effect.Effect<A, GateRefusal> })[tag]!(
      payload,
    );

  it.effect("the four mutations need providers:manage and never enter their handler", () =>
    Effect.gen(function* () {
      const { client, entered } = yield* makeClient(everyScopeButManage);
      const mutations: ReadonlyArray<readonly [string, unknown]> = [
        [FACTORY_WS_METHODS.factoryProxyInstall, { managementKey: Redacted.make("k".repeat(24)) }],
        [FACTORY_WS_METHODS.factoryProxyStart, {}],
        [FACTORY_WS_METHODS.factoryProxyStop, {}],
        [FACTORY_WS_METHODS.factoryProxyUninstall, { removeCredentials: false }],
      ];
      for (const [tag, payload] of mutations) {
        const refusal = yield* Effect.flip(call<FactoryProxyStatus>(client, tag, payload));
        assert.strictEqual(refusal._tag, "EnvironmentAuthorizationError");
        assert.strictEqual(refusal.requiredPermission, AuthProvidersManageScope);
      }
      assert.deepStrictEqual(entered, []);
    }),
  );

  it.effect("status answers with orchestration:read alone and fails with no scope", () =>
    Effect.gen(function* () {
      const withRead = yield* makeClient([AuthOrchestrationReadScope]);
      assert.deepStrictEqual(
        yield* call(withRead.client, FACTORY_WS_METHODS.factoryProxyStatus, {}),
        statusFixture,
      );
      assert.deepStrictEqual(withRead.entered, ["status"]);

      const bare = yield* makeClient([]);
      const refusal = yield* Effect.flip(
        call<FactoryProxyStatus>(bare.client, FACTORY_WS_METHODS.factoryProxyStatus, {}),
      );
      assert.strictEqual(refusal._tag, "EnvironmentAuthorizationError");
      assert.strictEqual(refusal.requiredPermission, AuthOrchestrationReadScope);
      assert.deepStrictEqual(bare.entered, []);
    }),
  );
});

describe("P11-2 the unavailable stand-ins", () => {
  it.effect(
    "orDisabled and a module without a secret store refuse all five, creating nothing",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "t3-factory-proxy-unavailable-",
        });
        const root = (yield* Path.Path).join(baseDir, "userdata", FACTORY_PROXY_SOURCE_ID);

        const disabled = yield* FactoryTasks.orDisabled;
        for (const refused of [
          () => disabled.proxyStatus({}),
          () => disabled.proxyInstall({}),
          () => disabled.proxyStart({}),
          () => disabled.proxyStop({}),
          () => disabled.proxyUninstall({ removeCredentials: false }),
        ]) {
          assert.deepStrictEqual(yield* refusalOf(refused()), {
            reason: "unavailable",
            message: REFUSALS.unavailable,
          });
        }

        const layer = Layer.mergeAll(
          PlatformCrypto.layer,
          ServerConfig.layerTest(baseDir, baseDir),
          ServerSettings.layerTest(),
          Layer.succeed(
            Net.NetService,
            Net.NetService.of({
              canListenOnHost: () => Effect.succeed(true),
              isPortAvailableOnLoopback: () => Effect.succeed(true),
              hasListenerOnHost: () => Effect.succeed(false),
              reserveLoopbackPort: () => Effect.succeed(0),
              findAvailablePort: () => Effect.succeed(0),
            }),
          ),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die(new Error("no request expected"))),
          ),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die(new Error("no spawn expected"))),
          ),
          Layer.succeed(FactoryProxy.Host, {
            manifest: Effect.succeed({ checkout: true as const, text: MANIFEST_TEXT }),
            download: makeDownload({
              transport: () => {
                throw new Error("no download expected");
              },
              maxBytes: EXECUTABLE_BYTES_MAX,
            }),
            listenerOwner: () => Effect.succeed("other" as const),
          }),
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
          Layer.succeed(HostProcess.Environment, {}),
          Layer.succeed(HostProcess.ExecutablePath, NodeProcess.execPath),
        ).pipe(Layer.provideMerge(NodeServices.layer));
        const proxy = yield* FactoryProxy.makeOrUnavailable.pipe(
          Effect.provide(layer),
          Effect.provideService(Scope.Scope, yield* Scope.fork(yield* Effect.scope)),
        );
        for (const refused of [
          () => proxy.status({}),
          () => proxy.install({}),
          () => proxy.start({}),
          () => proxy.stop({}),
          () => proxy.uninstall({ removeCredentials: false }),
        ]) {
          assert.deepStrictEqual(yield* refusalOf(refused()), {
            reason: "unavailable",
            message: REFUSALS.unavailable,
          });
        }
        assert.isFalse(NodeFS.existsSync(root));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("P11-3 install on win32-x64", () => {
  it.effect(
    "the record precedes the first request and every secret, and the install ends stopped",
    () =>
      withWorld({ platform: "win32", arch: "x64" }, (world) =>
        Effect.gen(function* () {
          const answer = yield* install(world);
          assert.strictEqual(answer.state, "installing");

          const firstDownload = firstIndex(world.order, (event) => event === "download");
          const firstSecret = firstIndex(world.order, (event) => event.startsWith("secret-"));
          const firstRecord = firstIndex(
            world.order,
            (event) => event === `rename:${world.recordPath}`,
          );
          assert.isDefined(firstRecord);
          assert.isDefined(firstDownload);
          assert.ok(firstRecord! < firstDownload!);
          assert.isTrue(firstSecret === undefined || firstSecret > firstDownload!);

          const final = yield* world.proxy.status({});
          assert.strictEqual(final.state, "stopped");
          assert.deepStrictEqual(final.pinned, { proxy: PROXY_VERSION, console: CONSOLE_VERSION });
          assert.deepStrictEqual(final.installed, {
            proxy: PROXY_VERSION,
            console: CONSOLE_VERSION,
          });
          assert.strictEqual(final.port, 8317);
          assert.strictEqual(final.platform, "win32-x64");
          assert.strictEqual(final.supported, true);
          assert.strictEqual(final.desired, "stopped");
          assert.strictEqual(final.consoleKey, "generated");
          assert.strictEqual(final.credentials, true);
          assert.strictEqual(final.pid, null);
          assert.strictEqual(final.problem, null);
          assert.strictEqual(final.consoleUrl, "http://127.0.0.1:8317/management.html");

          assert.deepStrictEqual(world.downloads, [
            ARCHIVE_URL,
            PROXY_LICENSE_URL,
            CONSOLE_URL,
            CONSOLE_LICENSE_URL,
          ]);

          const record = recordOf(world);
          assert.strictEqual(record["phase"], "installed");
          assert.strictEqual(record["proxy"], PROXY_VERSION);
          assert.strictEqual(record["console"], CONSOLE_VERSION);
          assert.strictEqual(record["platform"], "win32-x64");
          assert.strictEqual(record["consoleSha256"], sha256Hex(CONSOLE_BYTES));
          assert.strictEqual(record["executableSha256"], sha256Hex(EXE_BYTES));
          assert.strictEqual(record["port"], 8317);
          assert.strictEqual(record["desired"], "stopped");
          assert.strictEqual(record["process"], null);

          assert.deepStrictEqual(yield* rootListing(world), [
            "auth",
            "config.yaml",
            "record.json",
            "releases",
            `releases/${PROXY_VERSION}`,
            `releases/${PROXY_VERSION}/LICENSE`,
            `releases/${PROXY_VERSION}/LICENSE-management-center`,
            `releases/${PROXY_VERSION}/cli-proxy-api.exe`,
            "static",
            "static/management.html",
          ]);
          assert.deepStrictEqual(NodeFS.readdirSync(world.authDir), []);
          assert.deepStrictEqual(new Uint8Array(NodeFS.readFileSync(world.exePath)), EXE_BYTES);
          assert.deepStrictEqual(
            new Uint8Array(NodeFS.readFileSync(`${world.releaseDir}/LICENSE`)),
            PROXY_LICENSE_BYTES,
          );
          assert.deepStrictEqual(
            new Uint8Array(NodeFS.readFileSync(`${world.releaseDir}/LICENSE-management-center`)),
            CONSOLE_LICENSE_BYTES,
          );
          assert.deepStrictEqual(
            new Uint8Array(NodeFS.readFileSync(world.consolePath)),
            CONSOLE_BYTES,
          );
        }),
      ),
  );
});

// P11-4/P11-5: a tar stand-in that lists exactly ARCHIVE_NAMES and streams the stand-in executable.
const longListing = (marker: string) =>
  LINUX_ARCHIVE_NAMES.map(
    (name, index) => `${index === 0 ? marker : "-"}rw-r--r-- 0 0 0 1 Jan  1 00:00 ${name}`,
  ).join("\n");

const tarReplyOk = (args: ReadonlyArray<string>): ScriptedReply => {
  if (args[0] === "-tzf") return { stdout: `${LINUX_ARCHIVE_NAMES.join("\n")}\n` };
  if (args[0] === "-tvzf") return { stdout: longListing("-") };
  return { stdout: decoder.decode(EXE_BYTES) };
};

describe("P11-4 install on linux-x64", () => {
  it.effect(
    "tar -tzf, -tvzf and -xOzf run in that order and the streamed bytes become the executable",
    () =>
      withWorld({ platform: "linux", arch: "x64", tar: tarReplyOk }, (world) =>
        Effect.gen(function* () {
          yield* install(world);
          const tarArgs = world.spawns
            .filter((spawn) => /tar(\.exe)?$/i.test(spawn.command))
            .map((spawn) => spawn.args[0]);
          assert.deepStrictEqual(tarArgs, ["-tzf", "-tvzf", "-xOzf"]);
          const streamed = world.spawns.find((spawn) => spawn.args[0] === "-xOzf");
          assert.isDefined(streamed);
          assert.strictEqual(
            streamed!.args[1],
            world.spawns.find((spawn) => spawn.args[0] === "-tzf")!.args[1],
          );
          assert.strictEqual(streamed!.args[2], "cli-proxy-api");
          assert.deepStrictEqual(new Uint8Array(NodeFS.readFileSync(world.exePath)), EXE_BYTES);
          assert.strictEqual(recordOf(world)["executableSha256"], sha256Hex(EXE_BYTES));
        }),
      ),
  );

  it.effect.each([
    { name: "the -tzf listing", failing: "-tzf" },
    { name: "the -tvzf listing", failing: "-tvzf" },
  ])("a $name that exits 1 ends in archive with -xOzf never run", ({ failing }) =>
    withWorld(
      {
        platform: "linux",
        arch: "x64",
        tar: (args) =>
          args[0] === failing ? { ...tarReplyOk(args), exitCode: 1 } : tarReplyOk(args),
      },
      (world) =>
        Effect.gen(function* () {
          yield* world.proxy.install({});
          yield* world.proxy.drain;
          yield* awaitEvent(world, `remove:${world.recordPath}`);
          const status = yield* world.proxy.status({});
          assert.strictEqual(status.state, "not-installed");
          assert.strictEqual(status.problem, "archive");
          const tarArgs = world.spawns
            .filter((spawn) => /tar(\.exe)?$/i.test(spawn.command))
            .map((spawn) => spawn.args[0]);
          assert.deepStrictEqual(tarArgs, failing === "-tzf" ? ["-tzf"] : ["-tzf", "-tvzf"]);
          assert.deepStrictEqual(yield* rootListing(world), []);
        }),
    ),
  );
});

describe("P11-5 refused archives", () => {
  const member = (name: string): ZipEntry => ({
    name,
    data: encoder.encode(`member ${name}\n`),
    mode: 0o100644,
  });

  it.effect.each([
    {
      name: "a sixth entry",
      entries: [...WIN_ARCHIVE_NAMES.map(member), member("extra.txt")],
    },
    {
      name: "one name missing",
      entries: WIN_ARCHIVE_NAMES.slice(0, 4).map(member),
    },
    {
      name: "a name above the root",
      entries: [
        zipMember("../cli-proxy-api.exe", EXE_BYTES),
        ...WIN_ARCHIVE_NAMES.slice(1).map(member),
      ],
    },
    {
      name: "a name inside a folder",
      entries: [
        zipMember("bin/cli-proxy-api.exe", EXE_BYTES),
        ...WIN_ARCHIVE_NAMES.slice(1).map(member),
      ],
    },
    {
      name: "a repeated name",
      entries: [...WIN_ARCHIVE_NAMES.slice(0, 4).map(member), member("README.md")],
    },
    {
      name: "a symbolic-link entry",
      entries: [
        { name: "cli-proxy-api.exe", data: EXE_BYTES, mode: 0o120777 },
        ...WIN_ARCHIVE_NAMES.slice(1).map(member),
      ],
    },
    {
      name: "the DOS directory attribute",
      entries: WIN_ARCHIVE_NAMES.map((name) => ({
        ...member(name),
        dosDirectory: name === "config.example.yaml",
      })),
    },
    {
      name: "the encrypted bit",
      entries: WIN_ARCHIVE_NAMES.map((name) => ({
        ...member(name),
        encrypted: name === "cli-proxy-api.exe",
      })),
    },
  ])("a zip with $name ends not-installed with archive and leaves nothing", ({ entries }) =>
    withWorld({ platform: "win32", arch: "x64", winArchive: makeZip(entries) }, (world) =>
      Effect.gen(function* () {
        yield* world.proxy.install({});
        yield* world.proxy.drain;
        const status = yield* world.proxy.status({});
        assert.strictEqual(status.state, "not-installed");
        assert.strictEqual(status.problem, "archive");
        assert.deepStrictEqual(yield* rootListing(world), []);
      }),
    ),
  );

  it.effect.each([
    {
      name: "six names",
      reply: (args: ReadonlyArray<string>): ScriptedReply =>
        args[0] === "-tzf"
          ? { stdout: `${[...LINUX_ARCHIVE_NAMES, "extra.txt"].join("\n")}\n` }
          : tarReplyOk(args),
    },
    {
      name: "./ prefixes",
      reply: (args: ReadonlyArray<string>): ScriptedReply =>
        args[0] === "-tzf"
          ? { stdout: `${LINUX_ARCHIVE_NAMES.map((entry) => `./${entry}`).join("\n")}\n` }
          : tarReplyOk(args),
    },
    {
      name: "a long-listing line starting l",
      reply: (args: ReadonlyArray<string>): ScriptedReply =>
        args[0] === "-tvzf" ? { stdout: longListing("l") } : tarReplyOk(args),
    },
    {
      name: "a long-listing line starting h",
      reply: (args: ReadonlyArray<string>): ScriptedReply =>
        args[0] === "-tvzf" ? { stdout: longListing("h") } : tarReplyOk(args),
    },
    {
      name: "a long-listing line starting d",
      reply: (args: ReadonlyArray<string>): ScriptedReply =>
        args[0] === "-tvzf" ? { stdout: longListing("d") } : tarReplyOk(args),
    },
  ])("a tar listing with $name ends not-installed with archive", ({ reply }) =>
    withWorld({ platform: "linux", arch: "x64", tar: reply }, (world) =>
      Effect.gen(function* () {
        yield* world.proxy.install({});
        yield* world.proxy.drain;
        const status = yield* world.proxy.status({});
        assert.strictEqual(status.state, "not-installed");
        assert.strictEqual(status.problem, "archive");
        assert.deepStrictEqual(yield* rootListing(world), []);
      }),
    ),
  );
});

describe("P11-6 download failures and an interrupted install", () => {
  it.effect.each([
    { name: "a body one byte short", status: 200, problem: "verify", mangled: true },
    { name: "a body with another SHA-256", status: 200, problem: "verify", mangled: false },
    { name: "a 404", status: 404, problem: "download", mangled: false },
  ])(
    "$name stops the job, requests no later URL and leaves nothing",
    ({ name, status, problem, mangled }) =>
      withWorld({}, (world) =>
        Effect.gen(function* () {
          const mangledArchive = new Uint8Array(WIN_ZIP);
          mangledArchive[100] = (mangledArchive[100] ?? 0) ^ 0xff;
          world.downloadFailures.set(ARCHIVE_URL, {
            status,
            body: name === "a 404" ? undefined : mangled ? WIN_ZIP.slice(0, -1) : mangledArchive,
          });
          yield* world.proxy.install({});
          yield* world.proxy.drain;
          yield* awaitEvent(world, `remove:${world.recordPath}`);
          const final = yield* world.proxy.status({});
          assert.strictEqual(final.state, "not-installed");
          assert.strictEqual(final.problem, problem);
          assert.strictEqual(world.downloads.length, 1);
          assert.deepStrictEqual(yield* rootListing(world), []);
        }),
      ),
  );

  it.effect("closing the module's scope during a download aborts the transport's signal", () =>
    Effect.gen(function* () {
      const baseDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "t3-factory-proxy-interrupted-",
      });
      yield* withWorld({ baseDir, hangArchive: true }, (world, close) =>
        Effect.gen(function* () {
          yield* world.proxy.install({});
          yield* awaitEvent(world, "download");
          yield* close();
          const signal = world.downloadSignals[0];
          assert.isDefined(signal);
          assert.strictEqual(signal?.aborted, true);
        }),
      );
      yield* withWorld({ baseDir }, (world) =>
        Effect.gen(function* () {
          const status = yield* world.proxy.status({});
          assert.strictEqual(status.state, "failed");
          assert.strictEqual(status.problem, "interrupted");
          assert.deepStrictEqual(yield* refusalOf(world.proxy.install({})), {
            reason: "already-installed",
            message: REFUSALS["already-installed"],
          });
          const after = yield* world.proxy.uninstall({ removeCredentials: false });
          yield* world.proxy.drain;
          assert.strictEqual(after.state, "not-installed");
          assert.isFalse(yield* world.fs.exists(world.recordPath));
          assert.deepStrictEqual(yield* rootListing(world), []);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("P11-7 the config file and a typed key", () => {
  it.effect("install writes P7's template; a spawn changes only management.secret-key", () =>
    Effect.gen(function* () {
      const hostHasModes = HostProcess.Platform.defaultValue() !== "win32";
      const platform: NodeJS.Platform = hostHasModes ? "linux" : "win32";
      const typedKey = `a"b\\c#d:e${"f".repeat(16)}`;
      yield* withWorld({ platform, arch: "x64", tar: tarReplyOk }, (world) =>
        Effect.gen(function* () {
          yield* install(world, { managementKey: typedKey });
          const clientKey = yield* requiredSecretText(world, CLIENT_KEY_NAME);
          const before = parseDocument(yield* world.fs.readFileString(world.configPath)).toJS();
          assert.deepStrictEqual(
            before,
            expectedConfig(8317, unslash(world.authDir), "", clientKey),
          );
          if (hostHasModes) {
            assert.strictEqual(
              ((yield* world.fs.stat(world.configPath)).mode & 0o7777) as number,
              0o600,
            );
            yield* world.fs.chmod(world.configPath, 0o644);
          }

          const from = world.order.length;
          yield* startToRunning(world);
          if (hostHasModes) {
            const publish = `rename:${world.configPath}`;
            const restrict = `chmod:${world.configPath}`;
            assert.deepStrictEqual(
              world.order.slice(from).filter((event) => event === restrict || event === publish),
              [restrict, publish],
            );
            assert.strictEqual((yield* world.fs.stat(world.configPath)).mode & 0o777, 0o600);
          }
          const after = parseDocument(yield* world.fs.readFileString(world.configPath)).toJS();
          assert.deepStrictEqual(
            after,
            expectedConfig(8317, unslash(world.authDir), typedKey, clientKey),
          );
          assert.strictEqual(managementKeyOf(proxyEntry(world.patches.at(-1))), typedKey);
        }),
      );
    }),
  );
});

describe("P11-8 no key anywhere it must not be", () => {
  it.effect("neither key reaches a record, status, error, log, spawn or file under the home", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        const seen: Array<string> = [];
        const capture = (value: unknown) => {
          seen.push(JSON.stringify(value));
        };
        const assertClean = (text: string, where: string) => {
          assert.isTrue(!text.includes(managementKey), `the management key leaked into ${where}`);
          assert.isTrue(!text.includes(clientKey), `the client key leaked into ${where}`);
        };

        capture(yield* install(world));
        yield* world.proxy.start({});
        yield* awaitEvent(world, "supervisor-spawn");
        const handle = world.supervisors[world.supervisors.length - 1]!;
        const managementKey = yield* requiredSecretText(world, MANAGEMENT_KEY_NAME);
        const clientKey = yield* requiredSecretText(world, CLIENT_KEY_NAME);
        handle.offerStdout(`management ${managementKey} client ${clientKey}\n`);
        handle.offerStderr(`stderr ${managementKey} ${clientKey}\n`);
        handle.offerStdout(`pid ${handle.pid}\n`);
        handle.offerStdout(`after ${managementKey}\n`);
        handle.offerStderr(`after ${clientKey}\n`);

        // A refused health read keeps it starting; the record and status stay key-free.
        world.setHttpAnswer({ status: 401, body: {} });
        world.takenPorts.add(8317);
        yield* TestClock.adjust(Duration.millis(500));
        yield* awaitCount(world, "owner", 1);
        yield* awaitCount(world, "request", 1);
        capture(yield* world.proxy.status({}));

        world.setHttpAnswer({ status: 200, body: { files: [] } });
        yield* TestClock.adjust(Duration.millis(500));
        yield* awaitCount(world, "owner", 2);
        yield* awaitCount(world, "request", 2);
        yield* awaitCount(world, "settings-applied", 1);
        capture(yield* world.proxy.status({}));
        capture(recordOf(world));
        for (const [file, contents] of scanHome(world)) assertClean(contents, file);

        const stopped = yield* world.proxy.stop({});
        world.takenPorts.delete(8317);
        capture(stopped);
        const removed = yield* world.proxy.uninstall({ removeCredentials: false });
        yield* world.proxy.drain;
        capture(removed);

        for (const text of seen) assertClean(text, "an answer, status or record");
        for (const line of world.logLines) assertClean(line, "a captured log line");
        for (const spawn of world.spawns) assertClean(JSON.stringify(spawn), "the spawn's command");
      }),
    ),
  );
});

describe("P11-9 the two kinds of management key", () => {
  it.effect.each([{ length: 16 }, { length: 64 }])(
    "a typed key of $length characters is stored and written unchanged at two spawns in a row",
    ({ length }) =>
      withWorld({}, (world) =>
        Effect.gen(function* () {
          const typedKey = "k".repeat(length);
          yield* install(world, { managementKey: typedKey });
          for (let round = 0; round < 2; round += 1) {
            yield* startToRunning(world);
            const config = parseDocument(
              yield* world.fs.readFileString(world.configPath),
            ).toJS() as {
              management: Record<string, unknown>;
            };
            assert.strictEqual(config.management["secret-key"], typedKey);
            assert.strictEqual(managementKeyOf(proxyEntry(world.patches.at(-1))), typedKey);
            const stopped = yield* world.proxy.stop({});
            world.takenPorts.delete(8317);
            assert.strictEqual(stopped.state, "stopped");
          }
        }),
      ),
  );

  it.effect.each([
    { name: "15 characters", key: "k".repeat(15) },
    { name: "65 characters", key: "k".repeat(65) },
    { name: "a space inside", key: "k k k k k k k k 16" },
    { name: "a non-ASCII character", key: "é".repeat(16) },
  ])("a typed key of $name is refused with invalid-key and writes nothing", ({ key }) =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* refusalOf(world.proxy.install({ managementKey: Redacted.make(key) })),
          { reason: "invalid-key", message: REFUSALS["invalid-key"] },
        );
        assert.strictEqual(countEvent(world.order, `rename:${world.recordPath}`), 0);
        assert.strictEqual(countEvent(world.order, "download"), 0);
        assert.isFalse(yield* world.fs.exists(world.root));
      }),
    ),
  );

  it.effect(
    "a generated key differs at every spawn, and the earlier one is nowhere afterwards",
    () =>
      withWorld({}, (world) =>
        Effect.gen(function* () {
          yield* install(world);

          yield* startToRunning(world);
          const first = yield* requiredSecretText(world, MANAGEMENT_KEY_NAME);
          assert.notStrictEqual(first, "");
          assert.strictEqual(managementKeyOf(proxyEntry(world.patches.at(-1))), first);
          const firstConfig = parseDocument(
            yield* world.fs.readFileString(world.configPath),
          ).toJS() as {
            management: Record<string, unknown>;
          };
          assert.strictEqual(firstConfig.management["secret-key"], first);

          yield* world.proxy.stop({});
          world.takenPorts.delete(8317);
          yield* startToRunning(world);
          const second = yield* requiredSecretText(world, MANAGEMENT_KEY_NAME);
          assert.notStrictEqual(second, first);
          assert.strictEqual(managementKeyOf(proxyEntry(world.patches.at(-1))), second);

          for (const name of [MANAGEMENT_KEY_NAME, CLIENT_KEY_NAME, SETTINGS_SECRET_NAME]) {
            const value = yield* secretText(world, name);
            if (value !== null) {
              assert.isFalse(
                value.includes(first),
                `the earlier key survived in the secret ${name}`,
              );
            }
          }
          for (const [file, text] of scanHome(world, {
            includeSecrets: true,
            includeConfig: true,
          })) {
            assert.isFalse(text.includes(first), `the earlier key leaked into ${file}`);
          }
        }),
      ),
  );
});

describe("P11-10 the port range", () => {
  it.effect("the first free port is recorded, and none free refuses install", () =>
    Effect.gen(function* () {
      yield* withWorld({ takenPorts: [8317, 8318] }, (world) =>
        Effect.gen(function* () {
          yield* install(world);
          assert.strictEqual(recordOf(world)["port"], 8319);
          const status = yield* world.proxy.status({});
          assert.strictEqual(status.port, 8319);
          const config = parseDocument(yield* world.fs.readFileString(world.configPath)).toJS() as {
            server: { port: number };
          };
          assert.strictEqual(config.server.port, 8319);
        }),
      );
      const allTaken = Array.from({ length: 11 }, (_, index) => 8317 + index);
      yield* withWorld({ takenPorts: allTaken }, (world) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* refusalOf(world.proxy.install({})), {
            reason: "no-free-port",
            message: REFUSALS["no-free-port"],
          });
          assert.deepStrictEqual(world.downloads, []);
          assert.strictEqual(countEvent(world.order, `rename:${world.recordPath}`), 0);
          assert.isFalse(yield* world.fs.exists(world.root));
        }),
      );
    }),
  );
});

describe("P11-11 every refusal", () => {
  it.effect(
    "install refuses an existing record, no checkout, a bad manifest and an unsupported machine",
    () =>
      Effect.gen(function* () {
        yield* withWorld({}, (world) =>
          Effect.gen(function* () {
            seedInstalledRecord(world, { desired: "stopped", process: null });
            assert.deepStrictEqual(yield* refusalOf(world.proxy.install({})), {
              reason: "already-installed",
              message: REFUSALS["already-installed"],
            });
          }),
        );
        yield* withWorld({ noCheckout: true }, (world) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* refusalOf(world.proxy.install({})), {
              reason: "no-checkout",
              message: REFUSALS["no-checkout"],
            });
          }),
        );
        yield* withWorld({ manifestText: "{ not json" }, (world) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* refusalOf(world.proxy.install({})), {
              reason: "manifest",
              message: REFUSALS.manifest,
            });
            assert.deepStrictEqual(world.downloads, []);
          }),
        );
        yield* withWorld({ platform: "win32", arch: "arm64" }, (world) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* refusalOf(world.proxy.install({})), {
              reason: "unsupported-platform",
              message: REFUSALS["unsupported-platform"],
            });
            assert.deepStrictEqual(world.downloads, []);
          }),
        );
      }),
  );

  it.effect("every mutation is busy while an install runs; start and stop need a record", () =>
    Effect.gen(function* () {
      yield* withWorld({ hangArchive: true }, (world) =>
        Effect.gen(function* () {
          yield* world.proxy.install({});
          yield* awaitEvent(world, "download");
          for (const refused of [
            () => world.proxy.install({}),
            () => world.proxy.start({}),
            () => world.proxy.stop({}),
            () => world.proxy.uninstall({ removeCredentials: false }),
          ]) {
            assert.deepStrictEqual(yield* refusalOf(refused()), {
              reason: "busy",
              message: REFUSALS.busy,
            });
          }
        }),
      );
      yield* withWorld({}, (world) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* refusalOf(world.proxy.start({})), {
            reason: "not-installed",
            message: REFUSALS["not-installed"],
          });
          assert.deepStrictEqual(yield* refusalOf(world.proxy.stop({})), {
            reason: "not-installed",
            message: REFUSALS["not-installed"],
          });
        }),
      );
    }),
  );
});

describe("P11-12 the spawn", () => {
  it.effect(
    "start writes intent before the spawn, which carries the supervisor text and a bare environment",
    () =>
      withWorld({}, (world) =>
        Effect.gen(function* () {
          yield* install(world);
          yield* world.proxy.start({});
          yield* awaitEvent(world, "supervisor-spawn");

          assert.strictEqual(world.supervisors.length, 1);
          assert.deepStrictEqual(world.recordAtSpawns[0], {
            v: 1,
            phase: "installed",
            proxy: PROXY_VERSION,
            console: CONSOLE_VERSION,
            platform: "win32-x64",
            executableSha256: sha256Hex(EXE_BYTES),
            consoleSha256: sha256Hex(CONSOLE_BYTES),
            port: 8317,
            consoleKey: "generated",
            desired: "running",
            installedAt: (recordOf(world) as { installedAt: string }).installedAt,
            process: null,
          });

          const spawn = world.spawns.find((recorded) => recorded.args[0] === "-e");
          assert.isDefined(spawn);
          assert.strictEqual(spawn!.command, NodeProcess.execPath);
          assert.deepStrictEqual(spawn!.args, [
            "-e",
            FactoryProxy.SUPERVISOR,
            "--",
            world.exePath,
            "-config",
            world.configPath,
            "-local-model",
          ]);
          assert.strictEqual(unslash(spawn!.options.cwd ?? ""), unslash(world.root));
          assert.strictEqual(spawn!.options.shell, false);
          assert.strictEqual(spawn!.options.detached, false);
          assert.deepStrictEqual(Object.keys(spawn!.options.env ?? {}).sort(), [
            "HTTPS_PROXY",
            "PATH",
          ]);
        }),
      ),
  );
});

describe("P11-13 the ownership gate", () => {
  it.effect(
    "nothing keyed is sent before the pid line, while the port is free, or for any answer but ours",
    () =>
      withWorld({}, (world) =>
        Effect.gen(function* () {
          const { proxy } = world;
          yield* install(world);

          yield* proxy.start({});
          yield* awaitEvent(world, "supervisor-spawn");
          const handle = world.supervisors[0]!;

          // Before the pid line, and while the port is free: no request, no patch.
          yield* TestClock.adjust(Duration.seconds(29));
          assert.strictEqual(countEvent(world.order, "request"), 0);
          assert.strictEqual(countEvent(world.order, "patch"), 0);

          handle.offerStdout(`pid ${handle.pid}\n`);
          yield* TestClock.adjust(Duration.millis(500));
          assert.strictEqual(countEvent(world.order, "request"), 0);
          assert.strictEqual(countEvent(world.order, "patch"), 0);

          // The port is held and provably the child's: one keyed read; a 401 keeps it starting.
          world.takenPorts.add(8317);
          world.setHttpAnswer({ status: 401, body: {} });
          yield* TestClock.adjust(Duration.millis(500));
          yield* awaitEvent(world, "owner");
          yield* awaitEvent(world, "request");
          assert.strictEqual(countEvent(world.order, "request"), 1);
          assert.strictEqual(countEvent(world.order, "patch"), 0);
          assert.strictEqual((yield* proxy.status({})).state, "starting");

          // A 200 with no accounts is healthy: running, connected, and P9's exact enable patch.
          world.setHttpAnswer({ status: 200, body: { files: [] } });
          yield* TestClock.adjust(Duration.millis(500));
          yield* awaitCount(world, "request", 2);
          yield* awaitEvent(world, "settings-applied");
          const running = yield* proxy.status({});
          assert.strictEqual(running.state, "running");
          assert.strictEqual(running.hub, "connected");

          const managementKey = yield* requiredSecretText(world, MANAGEMENT_KEY_NAME);
          const request = world.httpRequests[0]!;
          assert.strictEqual(request.url, "http://127.0.0.1:8317/v0/management/auth-files");
          assert.strictEqual(request.authorization, `Bearer ${managementKey}`);
          assert.deepStrictEqual(proxyEntry(world.patches[0]), {
            kind: "cliproxy",
            label: "Factory proxy",
            url: "http://127.0.0.1:8317",
            managementKey,
            enabled: true,
          });
        }),
      ),
  );

  it.effect("startup probes only local management when the account list is populated", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        yield* install(world);
        world.setHttpAnswer({
          status: 200,
          body: { files: [{ id: "fixture.json", auth_index: "1", provider: "codex" }] },
        });
        yield* world.proxy.start({});
        yield* awaitEvent(world, "supervisor-spawn");
        const handle = world.supervisors[0]!;
        world.takenPorts.add(8317);
        handle.offerStdout(`pid ${handle.pid}\n`);
        yield* awaitEvent(world, "settings-applied");
        assert.strictEqual((yield* world.proxy.status({})).state, "running");
        assert.deepStrictEqual(
          world.httpRequests.map(({ url }) => url),
          ["http://127.0.0.1:8317/v0/management/auth-files"],
        );
      }),
    ),
  );

  it.effect("an answer of other ends the child, gives port-in-use and makes no request ever", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        const { proxy } = world;
        yield* install(world);
        yield* proxy.start({});
        yield* awaitEvent(world, "supervisor-spawn");
        const handle = world.supervisors[0]!;
        handle.offerStdout(`pid ${handle.pid}\n`);
        world.setOwnerAnswer("other");
        world.takenPorts.add(8317);
        yield* TestClock.adjust(Duration.millis(500));
        yield* awaitEvent(world, "owner");
        yield* awaitEvent(world, "stdin-end:1");

        const status = yield* awaitStatus(world, (next) => next.state === "port-in-use");
        assert.strictEqual(status.state, "port-in-use");
        assert.deepStrictEqual(world.httpRequests, []);
        assert.strictEqual(countEvent(world.order, "patch"), 0);
        const spawns = countEvent(world.order, "supervisor-spawn");
        yield* TestClock.adjust(Duration.seconds(60));
        assert.strictEqual(countEvent(world.order, "supervisor-spawn"), spawns);
      }),
    ),
  );
});

describe("P11-14 health waits and a refused enable", () => {
  it.effect(
    "an expired wait ends the child as one failure; five in a row end failed with unhealthy",
    () =>
      withWorld({}, (world) =>
        Effect.gen(function* () {
          const { proxy } = world;
          yield* install(world);
          world.setHttpAnswer({ status: 401, body: {} });
          yield* proxy.start({});
          for (let round = 1; round <= 5; round += 1) {
            // The module spawns one supervisor per try; each try ends at its stdin.
            yield* awaitCount(world, "supervisor-spawn", round);
            const nextRequest = world.httpRequests.length + 1;
            const handle = world.supervisors[world.supervisors.length - 1]!;
            handle.offerStdout(`pid ${handle.pid}\n`);
            world.takenPorts.add(8317);
            yield* awaitCount(world, "request", nextRequest);
            const delay = [1, 2, 4, 8][round - 1];
            const cleared = countEvent(world.order, `rename:${world.recordPath}`) + 1;
            yield* TestClock.adjust(Duration.seconds(30));
            yield* awaitCount(world, "stdin-end:1", round);
            yield* awaitCount(world, `rename:${world.recordPath}`, cleared);
            if (delay !== undefined) yield* awaitEvent(world, `timer:${delay * 1_000}`);
            else yield* awaitEvent(world, "log");
            const status = yield* proxy.status({});
            if (delay !== undefined) {
              assert.strictEqual(status.state, "starting");
              assert.strictEqual(status.restarts, round);
              yield* TestClock.adjust(Duration.seconds(delay));
            } else {
              assert.strictEqual(status.state, "failed");
              assert.strictEqual(status.problem, "unhealthy");
              assert.strictEqual(status.restarts, 5);
            }
          }
          const spawns = countEvent(world.order, "supervisor-spawn");
          yield* TestClock.adjust(Duration.seconds(60));
          assert.strictEqual(countEvent(world.order, "supervisor-spawn"), spawns);
        }),
      ),
  );

  it.effect(
    "a refused enable patch leaves the proxy running with enable-refused, and a later start retries",
    () =>
      withWorld({}, (world) =>
        Effect.gen(function* () {
          const { proxy } = world;
          yield* install(world);
          world.setRefuseSettings(true);
          const running = yield* startToRunning(world);
          assert.strictEqual(running.state, "running");
          assert.strictEqual(running.hub, "enable-refused");
          const spawns = countEvent(world.order, "supervisor-spawn");
          const patches = countEvent(world.order, "patch");

          world.setRefuseSettings(false);
          yield* proxy.start({});
          yield* TestClock.adjust(Duration.millis(500));
          yield* awaitCount(world, "patch", patches + 1);
          const status = yield* proxy.status({});
          assert.strictEqual(status.state, "running");
          assert.strictEqual(status.hub, "connected");
          assert.strictEqual(countEvent(world.order, "supervisor-spawn"), spawns);
        }),
      ),
  );
});

describe("P11-15 the config the proxy and the console leave", () => {
  // What the proxy and the console leave: a bcrypt secret key, a saved provider mapping,
  // a second client key, and the person's choice to serve no panel.
  const consoleRewrite = [
    "config-version: 8",
    "server:",
    '  host: ""',
    "  port: 9999",
    "  tls:",
    "    enable: true",
    "  discovery:",
    "    enabled: true",
    "  kv-store:",
    '    path: "/somewhere/else/kv.db"',
    "models:",
    "  codex:",
    "    live-media-relay:",
    "      enabled: true",
    "my-provider:",
    '  api-key: "sk-console-saved"',
    "management:",
    "  allow-remote: true",
    '  secret-key: "$2a$10$bcryptHashOfTheKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
    "  disable-auto-update-panel: false",
    "  disable-control-panel: true",
    "oauth:",
    '  auth-dir: "/tmp/other-auth"',
    "observability:",
    "  pprof:",
    "    enable: true",
    "plugins:",
    "  enabled: true",
    "access:",
    "  api-keys:",
    "    - person-added-key",
    "",
  ].join("\n");

  it.effect("a spawn keeps what the console saved and forces every owned key", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        yield* install(world);
        const clientKey = () =>
          Effect.map(world.secretStore.get(CLIENT_KEY_NAME), (value) =>
            Option.isSome(value) ? decoder.decode(new Uint8Array(value.value as Uint8Array)) : "",
          );
        const managementKey = () =>
          Effect.map(world.secretStore.get(MANAGEMENT_KEY_NAME), (value) =>
            Option.isSome(value) ? decoder.decode(new Uint8Array(value.value as Uint8Array)) : "",
          );

        NodeFS.writeFileSync(world.configPath, consoleRewrite);
        yield* startToRunning(world);
        assert.deepStrictEqual(
          parseDocument(yield* world.fs.readFileString(world.configPath)).toJS(),
          {
            ...expectedConfig(
              8317,
              unslash(world.authDir),
              yield* managementKey(),
              yield* clientKey(),
            ),
            "my-provider": { "api-key": "sk-console-saved" },
            management: {
              "allow-remote": false,
              "secret-key": yield* managementKey(),
              "disable-auto-update-panel": true,
              "panel-github-repository": PANEL_REPOSITORY,
              "disable-control-panel": true,
            },
            access: { "api-keys": ["person-added-key", yield* clientKey()] },
          },
        );

        const emptier = consoleRewrite.replace(
          "  api-keys:\n    - person-added-key\n",
          "  api-keys: []\n",
        );
        NodeFS.writeFileSync(world.configPath, emptier);
        const stopped = yield* world.proxy.stop({});
        world.takenPorts.delete(8317);
        assert.strictEqual(stopped.state, "stopped");
        yield* startToRunning(world);
        const after = parseDocument(yield* world.fs.readFileString(world.configPath)).toJS() as {
          access: { "api-keys": ReadonlyArray<string> };
        };
        assert.deepStrictEqual(after.access["api-keys"], [yield* clientKey()]);
      }),
    ),
  );

  it.effect(
    "text that is not YAML refuses start, stays byte for byte and fails a booting server",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "t3-factory-proxy-unreadable-",
        });
        yield* withWorld({ baseDir }, (world) =>
          Effect.gen(function* () {
            yield* install(world);
            NodeFS.writeFileSync(world.configPath, "{{");
            const refusal = yield* refusalOf(world.proxy.start({}));
            assert.deepStrictEqual(refusal, {
              reason: "config-unreadable",
              message: REFUSALS["config-unreadable"],
            });
            assert.strictEqual(countEvent(world.order, "supervisor-spawn"), 0);
            assert.strictEqual(yield* world.fs.readFileString(world.configPath), "{{");
            for (const line of world.logLines) {
              assert.isTrue(
                !line.includes("{{"),
                `the broken text leaked into a captured log line`,
              );
            }
            assert.strictEqual(recordOf(world)["desired"], "stopped");
          }),
        );
        yield* withWorld({ baseDir }, (world) =>
          Effect.sync(() => {
            seedInstalledRecord(world, { desired: "running", process: null });
            NodeFS.writeFileSync(world.configPath, "{{");
          }),
        );
        yield* withWorld({ baseDir }, (world) =>
          Effect.gen(function* () {
            yield* awaitEvent(world, "probe");
            const status = yield* awaitStatus(world, (next) => next.state !== "starting");
            assert.strictEqual(status.state, "failed");
            assert.strictEqual(status.problem, "config-unreadable");
            assert.strictEqual(countEvent(world.order, "supervisor-spawn"), 0);
            for (const line of world.logLines) {
              assert.isTrue(!line.includes("{{"), `parser text leaked into a captured log line`);
            }
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      name: "a changed executable byte",
      corrupt: (world: World) => {
        const bytes = new Uint8Array(NodeFS.readFileSync(world.exePath));
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        NodeFS.writeFileSync(world.exePath, bytes);
      },
    },
    {
      name: "a changed console byte",
      corrupt: (world: World) => {
        const bytes = new Uint8Array(NodeFS.readFileSync(world.consolePath));
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        NodeFS.writeFileSync(world.consolePath, bytes);
      },
    },
  ])("$name ends failed with damaged and no spawn", ({ corrupt }) =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        seedInstalledRecord(world, { desired: "stopped", process: null });
        corrupt(world);
        yield* world.proxy.start({});
        yield* awaitEvent(world, "probe");
        const status = yield* awaitStatus(world, (next) => next.state !== "starting");
        assert.strictEqual(status.state, "failed");
        assert.strictEqual(status.problem, "damaged");
        assert.strictEqual(countEvent(world.order, "supervisor-spawn"), 0);
      }),
    ),
  );

  it.effect("a missing typed-key secret ends failed with damaged and no spawn", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        seedInstalledRecord(world, { desired: "stopped", process: null, consoleKey: "typed" });
        yield* world.proxy.start({});
        yield* awaitEvent(world, "probe");
        yield* awaitEvent(world, `secret-get:${MANAGEMENT_KEY_NAME}`);
        const status = yield* awaitStatus(world, (next) => next.state !== "starting");
        assert.strictEqual(status.state, "failed");
        assert.strictEqual(status.problem, "damaged");
        assert.strictEqual(countEvent(world.order, "supervisor-spawn"), 0);
      }),
    ),
  );
});

describe("P11-16 restart with backoff", () => {
  it.effect(
    "an exit in running backs off 1, 2, 4 and 8 seconds, gives up at five and resets when stable",
    () =>
      withWorld({}, (world) =>
        Effect.gen(function* () {
          const { proxy } = world;
          yield* install(world);
          const spawns = () => countEvent(world.order, "supervisor-spawn");
          const patches = () => countEvent(world.order, "patch");

          // Try one reaches running; its exit disables the entry and sets the exit code.
          yield* startToRunning(world);
          let handle = world.supervisors[world.supervisors.length - 1]!;
          for (let round = 1; round <= 5; round += 1) {
            const before = patches();
            handle.exit(3);
            yield* awaitCount(world, "settings-applied", before + 1);
            const delay = [1, 2, 4, 8][round - 1];
            if (delay !== undefined) yield* awaitEvent(world, `timer:${delay * 1_000}`);
            else yield* awaitEvent(world, "log");
            const status = yield* proxy.status({});
            assert.strictEqual(status.exitCode, 3);
            assert.strictEqual(status.restarts, round);
            // P8.5 disables the hub entry the moment the exit is seen.
            assert.strictEqual(patches(), before + 1);
            if (delay !== undefined) {
              assert.strictEqual(status.state, "starting");
              const beforeSpawns = spawns();
              yield* TestClock.adjust(Duration.millis(delay * 1_000 - 1));
              assert.strictEqual(spawns(), beforeSpawns);
              yield* TestClock.adjust(Duration.millis(1));
              yield* awaitCount(world, "supervisor-spawn", round + 1);
              handle = world.supervisors[world.supervisors.length - 1]!;
              handle.offerStdout(`pid ${handle.pid}\n`);
              world.takenPorts.add(8317);
              yield* awaitCount(world, "settings-applied", before + 2);
            } else {
              assert.strictEqual(status.state, "failed");
              assert.strictEqual(status.problem, "exited");
              const beforeSpawns = spawns();
              yield* TestClock.adjust(Duration.seconds(60));
              assert.strictEqual(spawns(), beforeSpawns);
            }
          }

          // Start accepts again: a fresh supervisor reaches running with the count back at 0.
          yield* proxy.start({});
          yield* awaitCount(world, "supervisor-spawn", 6);
          const applied = countEvent(world.order, "settings-applied");
          const manual = world.supervisors[5]!;
          manual.offerStdout(`pid ${manual.pid}\n`);
          world.takenPorts.add(8317);
          yield* awaitCount(world, "settings-applied", applied + 1);
          const running = yield* proxy.status({});
          assert.strictEqual(running.state, "running");
          assert.strictEqual(running.restarts, 0);

          manual.exit(3);
          yield* awaitCount(world, "settings-applied", applied + 2);
          yield* awaitCount(world, "timer:1000", 2);
          yield* TestClock.adjust(Duration.seconds(1));
          yield* awaitCount(world, "supervisor-spawn", 7);
          const stable = world.supervisors[6]!;
          world.takenPorts.add(8317);
          stable.offerStdout(`pid ${stable.pid}\n`);
          yield* awaitCount(world, "settings-applied", applied + 3);
          assert.strictEqual((yield* proxy.status({})).restarts, 1);

          yield* TestClock.adjust(Duration.minutes(5));
          assert.strictEqual((yield* proxy.status({})).restarts, 0);
          stable.exit(3);
          yield* awaitCount(world, "settings-applied", applied + 4);
          const again = yield* proxy.status({});
          assert.strictEqual(again.state, "starting");
          assert.strictEqual(again.restarts, 1);
        }),
      ),
  );

  it.effect("a supervisor that exits with no pid line gives failed with spawn and no retry", () =>
    withWorld({ supervisor: { pid: 800, exitsOnStdinEnd: false } }, (world) =>
      Effect.gen(function* () {
        const { proxy } = world;
        yield* install(world);
        yield* proxy.start({});
        yield* awaitEvent(world, "supervisor-spawn");
        world.supervisors[0]!.exit(0);
        const status = yield* awaitStatus(world, (next) => next.state !== "starting");
        assert.strictEqual(status.state, "failed");
        assert.strictEqual(status.problem, "spawn");
        const spawns = countEvent(world.order, "supervisor-spawn");
        yield* TestClock.adjust(Duration.seconds(60));
        assert.strictEqual(countEvent(world.order, "supervisor-spawn"), spawns);
      }),
    ),
  );

  it.effect.each(["open", "closed"] as const)(
    "a live supervisor with %s stdout and no pid is closed without a health read",
    (stdout) =>
      withWorld({ supervisor: { stdoutClosed: stdout === "closed" } }, (world) =>
        Effect.gen(function* () {
          yield* install(world);
          yield* world.proxy.start({});
          if (stdout === "open") {
            yield* awaitEvent(world, "timer:30000");
            yield* TestClock.adjust(Duration.seconds(30));
          }
          yield* awaitEvent(world, "stdin-end:1");
          const status = yield* world.proxy.status({});
          assert.strictEqual(status.state, "failed");
          assert.strictEqual(status.problem, "spawn");
          assert.strictEqual(status.pid, null);
          assert.strictEqual(status.restarts, 0);
          assert.isTrue(world.supervisors[0]!.state.exited);
          assert.deepStrictEqual(world.httpRequests, []);
          assert.deepStrictEqual(world.patches, []);
        }),
      ),
  );
});

describe("P11-17 both histories of a first stop", () => {
  it.effect("a failed stop intent write still disables the hub and stops the runtime", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        yield* install(world);
        yield* startToRunning(world);
        world.setRefuseRecordWrites(true);
        const stopped = yield* world.proxy.stop({});
        assert.strictEqual(stopped.state, "failed");
        assert.strictEqual(stopped.problem, "write");
        assert.strictEqual(stopped.desired, "running");
        assert.strictEqual(recordOf(world)["desired"], "running");
        assert.strictEqual(stopped.hub, "disconnected");
        assert.isTrue(world.supervisors[0]!.state.exited);
        assert.strictEqual(world.supervisors[0]!.state.kills, 0);
        yield* TestClock.adjust(Duration.minutes(1));
        assert.strictEqual(world.supervisors.length, 1);
        world.setRefuseRecordWrites(false);
        assert.strictEqual((yield* world.proxy.stop({})).desired, "stopped");
      }),
    ),
  );

  it.effect(
    "the disable patch precedes the pipe after a connected start; an unconnected start sends none",
    () =>
      Effect.gen(function* () {
        // History one: a start that connected.
        yield* withWorld({}, (world) =>
          Effect.gen(function* () {
            const { proxy } = world;
            yield* install(world);
            yield* startToRunning(world);
            const before = world.order.length;

            const stopped = yield* proxy.stop({});
            world.takenPorts.delete(8317);
            assert.strictEqual(stopped.state, "stopped");
            assert.strictEqual(stopped.hub, "disconnected");
            const tail = world.order.slice(before);
            assert.deepStrictEqual(
              tail.filter((event) => event === "patch"),
              ["patch"],
            );
            assert.deepStrictEqual(
              tail.filter((event) => event === "settings-applied" || event.startsWith("stdin-end")),
              ["settings-applied", "stdin-end:1"],
            );
            const atEnd = world.recordAtStdinEnds.at(-1);
            assert.isDefined(atEnd);
            assert.strictEqual(atEnd!["desired"], "stopped");
            assert.strictEqual(world.supervisors[0]!.state.kills, 0);
            const spawns = countEvent(world.order, "supervisor-spawn");
            yield* TestClock.adjust(Duration.seconds(2));
            assert.strictEqual(countEvent(world.order, "supervisor-spawn"), spawns);
          }),
        );

        // History two: a start that never connected.
        yield* withWorld({ supervisor: { pid: 800, exitsOnStdinEnd: false } }, (world) =>
          Effect.gen(function* () {
            const { proxy } = world;
            yield* install(world);
            world.setHttpAnswer({ status: 401, body: {} });
            yield* proxy.start({});
            yield* awaitEvent(world, "supervisor-spawn");
            const handle = world.supervisors[0]!;
            handle.offerStdout(`pid ${handle.pid}\n`);
            world.takenPorts.add(8317);
            yield* TestClock.adjust(Duration.millis(500));
            yield* awaitEvent(world, "owner");
            yield* awaitEvent(world, "request");
            assert.strictEqual((yield* proxy.status({})).state, "starting");
            assert.strictEqual(countEvent(world.order, "patch"), 0);

            const before = world.order.length;
            const stopFiber = yield* Effect.forkChild(proxy.stop({}));
            yield* awaitEvent(world, "stdin-end:1");
            yield* TestClock.adjust(Duration.seconds(11));
            const stopped = yield* Fiber.join(stopFiber);
            world.takenPorts.delete(8317);
            assert.strictEqual(stopped.state, "stopped");
            assert.strictEqual(stopped.hub, "disconnected");
            assert.deepStrictEqual(
              world.order.slice(before).filter((event) => event === "patch"),
              [],
            );
            assert.strictEqual(handle.state.kills, 1);
            const atEnd = world.recordAtStdinEnds.at(-1);
            assert.isDefined(atEnd);
            assert.strictEqual(atEnd!["desired"], "stopped");
            const spawns = countEvent(world.order, "supervisor-spawn");
            yield* TestClock.adjust(Duration.seconds(2));
            assert.strictEqual(countEvent(world.order, "supervisor-spawn"), spawns);
          }),
        );
      }),
  );
});

describe("P11-18 a refused disable patch", () => {
  it.effect("stop still ends the child and answers disable-refused; a second stop finishes", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        const { proxy } = world;
        yield* install(world);
        yield* startToRunning(world);
        const entry = () =>
          Effect.map(
            world.settings.getSettings,
            (settings) => settings.usageLimitSources[FACTORY_PROXY_SOURCE_ID as UsageLimitSourceId],
          );

        world.setRefuseSettings(true);
        let stopped = yield* proxy.stop({});
        world.takenPorts.delete(8317);
        assert.strictEqual(stopped.state, "stopped");
        assert.strictEqual(stopped.hub, "disable-refused");
        assert.isTrue(world.supervisors[0]!.state.stdinEnds > 0);
        assert.strictEqual(world.supervisors[0]!.state.kills, 0);
        assert.isTrue(yield* world.fs.exists(world.recordPath));
        assert.isTrue((yield* entry())?.enabled === true);

        world.setRefuseSettings(false);
        stopped = yield* proxy.stop({});
        assert.strictEqual(stopped.state, "stopped");
        assert.strictEqual(stopped.hub, "disconnected");
        assert.isTrue((yield* entry())?.enabled === false);
      }),
    ),
  );
});

describe("P11-19 a module built over a home with a record", () => {
  it.effect(
    "desired running spawns with no method called, desired stopped does not, and scope close cleans up",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "t3-factory-proxy-boot-",
        });
        const settingsOverrides = {
          usageLimitSources: {
            [FACTORY_PROXY_SOURCE_ID as UsageLimitSourceId]: {
              kind: "cliproxy",
              label: "Factory proxy",
              url: "http://127.0.0.1:8317",
              managementKey: "seeded-key",
              enabled: true,
            },
          },
        } as unknown as Parameters<typeof ServerSettings.layerTest>[0];
        yield* withWorld({ baseDir }, (world) =>
          Effect.sync(() => seedInstalledRecord(world, { desired: "running", process: null })),
        );
        yield* withWorld({ baseDir, settingsOverrides }, (world, close) =>
          Effect.gen(function* () {
            yield* awaitEvent(world, "patch");
            yield* awaitEvent(world, "supervisor-spawn");
            const patchAt = firstIndex(world.order, (event) => event === "settings-applied")!;
            const spawnAt = firstIndex(world.order, (event) => event === "supervisor-spawn")!;
            assert.isTrue(patchAt < spawnAt);

            const handle = world.supervisors[0]!;
            handle.offerStdout(`pid ${handle.pid}\n`);
            world.takenPorts.add(8317);
            yield* TestClock.adjust(Duration.millis(500));
            yield* awaitEvent(world, "owner");
            yield* awaitEvent(world, "request");
            yield* awaitCount(world, "settings-applied", 2);
            assert.strictEqual((yield* world.proxy.status({})).state, "running");

            const patchesBefore = countEvent(world.order, "settings-applied");
            yield* close();
            yield* awaitCount(world, "settings-applied", patchesBefore + 1);
            const disableAt = lastIndex(world.order, (event) => event === "settings-applied")!;
            const stdinAt = firstIndex(world.order, (event) => event.startsWith("stdin-end"))!;
            assert.isTrue(stdinAt > disableAt);
            assert.strictEqual(recordOf(world)["desired"], "running");
          }),
        );

        yield* withWorld({ baseDir }, (world) =>
          Effect.sync(() => seedInstalledRecord(world, { desired: "stopped", process: null })),
        );
        yield* withWorld({ baseDir }, (world) =>
          Effect.gen(function* () {
            yield* world.proxy.stop({});
            assert.strictEqual(countEvent(world.order, "supervisor-spawn"), 0);
            assert.strictEqual((yield* world.proxy.status({})).state, "stopped");
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("P11-20 an earlier run", () => {
  it.effect(
    "a held port with a recorded process is port-in-use, and uninstall is refused with earlier-run",
    () =>
      Effect.gen(function* () {
        yield* withWorld({}, (world) =>
          Effect.gen(function* () {
            seedInstalledRecord(world, { desired: "stopped", process: { pid: 4242 } });
            world.takenPorts.add(8317);
            yield* world.proxy.start({});
            yield* awaitEvent(world, "probe");
            const status = yield* world.proxy.status({});
            assert.strictEqual(status.state, "port-in-use");
            assert.strictEqual(status.pid, 4242);
            assert.strictEqual(countEvent(world.order, "supervisor-spawn"), 0);
            assert.deepStrictEqual(world.httpRequests, []);
            assert.deepStrictEqual(recordOf(world)["process"], { pid: 4242 });
            assert.deepStrictEqual(
              yield* refusalOf(world.proxy.uninstall({ removeCredentials: false })),
              {
                reason: "earlier-run",
                message: REFUSALS["earlier-run"],
              },
            );
            yield* world.proxy.drain;
            assert.isTrue(yield* world.fs.exists(world.recordPath));

            world.takenPorts.clear();
            yield* startToRunning(world);
            const running = yield* world.proxy.status({});
            assert.strictEqual(running.state, "running");
            assert.strictEqual(running.pid, world.supervisors[0]!.pid);
            assert.deepStrictEqual(recordOf(world)["process"], { pid: world.supervisors[0]!.pid });
          }),
        );

        yield* withWorld({}, (world) =>
          Effect.gen(function* () {
            seedInstalledRecord(world, { desired: "stopped", process: null });
            world.takenPorts.add(8317);
            yield* world.proxy.start({});
            yield* awaitEvent(world, "probe");
            const status = yield* world.proxy.status({});
            assert.strictEqual(status.state, "port-in-use");
            assert.strictEqual(status.pid, null);
            assert.strictEqual(countEvent(world.order, "supervisor-spawn"), 0);
          }),
        );
      }),
  );
});

describe("P11-21 uninstall", () => {
  it.effect("a failed removing marker preserves the installed files, keys and sign-ins", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        yield* install(world);
        yield* startToRunning(world);
        yield* world.fs.writeFileString(`${world.authDir}/kv.db`, "sign-ins");
        const installed = recordOf(world);
        const files = yield* rootListing(world);
        world.setRefuseRecordWrites(true);
        const stopped = yield* world.proxy.uninstall({ removeCredentials: true });
        yield* world.proxy.drain;
        assert.strictEqual(stopped.state, "failed");
        assert.strictEqual(stopped.problem, "leftover");
        assert.deepStrictEqual(recordOf(world), installed);
        assert.deepStrictEqual(yield* rootListing(world), files);
        assert.strictEqual(yield* world.fs.readFileString(`${world.authDir}/kv.db`), "sign-ins");
        for (const name of [MANAGEMENT_KEY_NAME, CLIENT_KEY_NAME])
          assert.isTrue(Option.isSome(yield* world.secretStore.get(name)));

        world.setRefuseRecordWrites(false);
        const retried = yield* world.proxy.uninstall({ removeCredentials: true });
        assert.strictEqual(retried.state, "not-installed");
        yield* world.proxy.drain;
        assert.isFalse(yield* world.fs.exists(world.root));
      }),
    ),
  );

  it.effect(
    "keeping sign-ins removes the hub entry first and every proxy secret, and keeps auth",
    () =>
      withWorld({}, (world) =>
        Effect.gen(function* () {
          const { proxy } = world;
          yield* install(world);
          yield* startToRunning(world);
          yield* world.fs.writeFileString(`${world.authDir}/kv.db`, "bbolt bytes");
          yield* world.fs.writeFileString(`${world.authDir}/codex.json`, "{}");

          assert.isTrue(Option.isSome(yield* world.secretStore.get(SETTINGS_SECRET_NAME)));

          const before = world.order.length;
          const status = yield* proxy.uninstall({ removeCredentials: false });
          yield* world.proxy.drain;
          assert.strictEqual(status.state, "not-installed");
          assert.isTrue(status.credentials);
          for (const name of [MANAGEMENT_KEY_NAME, CLIENT_KEY_NAME, SETTINGS_SECRET_NAME]) {
            assert.isTrue(
              Option.isNone(yield* world.secretStore.get(name)),
              `the secret ${name} survived`,
            );
          }
          const settings = yield* world.settings.getSettings;
          assert.isFalse(Object.hasOwn(settings.usageLimitSources, FACTORY_PROXY_SOURCE_ID));
          assert.deepStrictEqual(yield* rootListing(world), [
            "auth",
            "auth/codex.json",
            "auth/kv.db",
          ]);
          assert.strictEqual(NodeFS.readFileSync(`${world.authDir}/kv.db`, "utf8"), "bbolt bytes");
          const tail = world.order.slice(before);
          assert.deepStrictEqual(
            tail.filter((event) => event === "patch"),
            ["patch"],
          );
          assert.deepStrictEqual(
            tail.filter((event) => event === "settings-applied" || event.startsWith("stdin-end")),
            ["settings-applied", "stdin-end:1"],
          );
          assert.strictEqual(world.supervisors[0]!.state.kills, 0);
        }),
      ),
  );

  it.effect("a refused removal patch deletes nothing at all, and a second uninstall finishes", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        const { proxy } = world;
        yield* install(world);
        yield* startToRunning(world);
        yield* world.fs.writeFileString(`${world.authDir}/kv.db`, "bbolt bytes");

        world.setRefuseSettings(true);
        const refusal = yield* refusalOf(proxy.uninstall({ removeCredentials: false }));
        yield* world.proxy.drain;
        assert.deepStrictEqual(refusal, {
          reason: "remove-refused",
          message: REFUSALS["remove-refused"],
        });
        assert.strictEqual(world.supervisors[0]!.state.stdinEnds, 0);
        assert.strictEqual(world.supervisors[0]!.state.kills, 0);
        assert.isTrue(yield* world.fs.exists(world.recordPath));
        assert.isTrue(Option.isSome(yield* world.secretStore.get(MANAGEMENT_KEY_NAME)));
        assert.isTrue(Option.isSome(yield* world.secretStore.get(CLIENT_KEY_NAME)));
        assert.isTrue(Option.isSome(yield* world.secretStore.get(SETTINGS_SECRET_NAME)));
        assert.strictEqual(NodeFS.readFileSync(`${world.authDir}/kv.db`, "utf8"), "bbolt bytes");
        const settings = yield* world.settings.getSettings;
        assert.isTrue(Object.hasOwn(settings.usageLimitSources, FACTORY_PROXY_SOURCE_ID));

        world.setRefuseSettings(false);
        const status = yield* proxy.uninstall({ removeCredentials: false });
        yield* world.proxy.drain;
        assert.strictEqual(status.state, "not-installed");
        assert.isFalse(yield* world.fs.exists(world.recordPath));
        assert.deepStrictEqual(yield* rootListing(world), ["auth", "auth/kv.db"]);
      }),
    ),
  );

  it.effect.each(["unconfirmed shutdown", "held port after exit"] as const)(
    "%s keeps the process record, keys and files until uninstall is safe",
    (condition) =>
      withWorld(
        {
          supervisor: { exitsOnStdinEnd: condition === "held port after exit", exitsOnKill: false },
        },
        (world) =>
          Effect.gen(function* () {
            yield* install(world);
            yield* world.fs.writeFileString(`${world.authDir}/kv.db`, "sign-ins");
            yield* startToRunning(world);
            const handle = world.supervisors[0]!;
            if (condition === "held port after exit") world.setOwnerAnswer("other");

            const remove = world.proxy.uninstall({ removeCredentials: true });
            const result = yield* Effect.forkChild(refusalOf(remove));
            yield* awaitEvent(world, "stdin-end:1");
            if (condition === "unconfirmed shutdown") {
              yield* awaitEvent(world, "timer:10000");
              yield* TestClock.adjust(Duration.seconds(10));
            }
            assert.deepStrictEqual(yield* Fiber.join(result), {
              reason: "earlier-run",
              message: REFUSALS["earlier-run"],
            });
            yield* world.proxy.drain;
            assert.strictEqual(recordOf(world)["phase"], "removing");
            assert.deepStrictEqual(recordOf(world)["process"], { pid: handle.pid });
            assert.isTrue(yield* world.fs.exists(world.exePath));
            assert.isTrue(yield* world.fs.exists(world.configPath));
            assert.strictEqual(
              yield* world.fs.readFileString(`${world.authDir}/kv.db`),
              "sign-ins",
            );
            for (const name of [MANAGEMENT_KEY_NAME, CLIENT_KEY_NAME])
              assert.isTrue(Option.isSome(yield* world.secretStore.get(name)));
            assert.isTrue(Option.isNone(yield* world.secretStore.get(SETTINGS_SECRET_NAME)));

            if (condition === "unconfirmed shutdown") {
              assert.strictEqual(handle.state.kills, 1);
              world.takenPorts.clear();
              assert.strictEqual((yield* refusalOf(remove)).reason, "earlier-run");
              handle.exit(0);
            } else {
              assert.isTrue(handle.state.exited);
              assert.strictEqual(handle.state.kills, 0);
              world.takenPorts.clear();
            }
            assert.strictEqual((yield* remove).state, "not-installed");
            yield* world.proxy.drain;
            assert.isFalse(yield* world.fs.exists(world.root));
          }),
      ),
  );

  it.effect("with no record or hub row it removes the orphaned settings key and keeps auth", () =>
    withWorld({ persistentSettings: true }, (world) =>
      Effect.gen(function* () {
        NodeFS.mkdirSync(world.authDir, { recursive: true });
        NodeFS.writeFileSync(`${world.authDir}/kv.db`, "bbolt bytes");
        NodeFS.mkdirSync(`${world.root}/releases/9.9.9`, { recursive: true });
        NodeFS.writeFileSync(`${world.root}/releases/9.9.9/stray.txt`, "stray");
        NodeFS.mkdirSync(world.secretsDir, { recursive: true });
        yield* world.secretStore.set(MANAGEMENT_KEY_NAME, encoder.encode("stray management"));
        yield* world.secretStore.set(CLIENT_KEY_NAME, encoder.encode("stray client"));
        yield* world.secretStore.set(SETTINGS_SECRET_NAME, encoder.encode("orphan"));
        const settings = yield* world.settings.getSettings;
        assert.isFalse(Object.hasOwn(settings.usageLimitSources, FACTORY_PROXY_SOURCE_ID));

        world.setRefuseSettings(true);
        const refused = yield* refusalOf(world.proxy.uninstall({ removeCredentials: false }));
        yield* world.proxy.drain;
        assert.strictEqual(refused.reason, "remove-refused");
        assert.include(world.order, `secret-remove:${SETTINGS_SECRET_NAME}`);
        assert.strictEqual(yield* secretText(world, SETTINGS_SECRET_NAME), "orphan");
        assert.isTrue(yield* world.fs.exists(`${world.root}/releases/9.9.9/stray.txt`));
        world.setRefuseSettings(false);

        const status = yield* world.proxy.uninstall({ removeCredentials: false });
        yield* world.proxy.drain;
        assert.strictEqual(status.state, "not-installed");
        assert.isTrue(Option.isNone(yield* world.secretStore.get(MANAGEMENT_KEY_NAME)));
        assert.isTrue(Option.isNone(yield* world.secretStore.get(CLIENT_KEY_NAME)));
        assert.isTrue(Option.isNone(yield* world.secretStore.get(SETTINGS_SECRET_NAME)));
        const removalPatch = { usageLimitSources: { [FACTORY_PROXY_SOURCE_ID]: null } };
        assert.deepStrictEqual(world.patches, [removalPatch, removalPatch]);
        assert.deepStrictEqual(yield* rootListing(world), ["auth", "auth/kv.db"]);
        yield* world.proxy.uninstall({ removeCredentials: false });
        yield* world.proxy.drain;
        assert.strictEqual(world.patches.length, 2);
      }),
    ),
  );

  it.effect("removeCredentials true leaves no home folder", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        yield* install(world);
        const status = yield* world.proxy.uninstall({ removeCredentials: true });
        yield* world.proxy.drain;
        assert.strictEqual(status.state, "not-installed");
        assert.isFalse(yield* world.fs.exists(world.root));
      }),
    ),
  );
});

describe("P11-22 the default listener owner", () => {
  const port = 8317;
  const child = 800;

  const netstatRows = (pidColumn: string) =>
    [
      `  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    ${pidColumn}`,
      "  TCP    127.0.0.1:9    0.0.0.0:0    LISTENING    77",
    ].join("\n");
  const lsofRows = (pidLine: string) => [pidLine, "cnode", `n127.0.0.1:${port}`].join("\n");
  // 8317 is 0x207D; the row is a listener (state 0A) on loopback held by inode 5001.
  const procTcpRow = `  0: 0100007F:207D 00000000:0000 0A 00000000:00000000 00 000000 00000000 00 5001 1 0000000000000000\n`;

  interface ProcFixture {
    readonly tcp: string;
    readonly owners: ReadonlyArray<{ readonly pid: string; readonly fds: ReadonlyArray<string> }>;
  }

  const ownerLayer = (options: {
    readonly platform: NodeJS.Platform;
    readonly reply?: (command: string, args: ReadonlyArray<string>) => ScriptedReply;
    readonly proc?: ProcFixture;
    readonly unreadableTcp?: boolean;
  }) => {
    const noop = FileSystem.makeNoop({});
    const proc = options.proc;
    const needsProc = proc !== undefined || options.unreadableTcp === true;
    const fileSystem = needsProc
      ? FileSystem.layerNoop({
          readFileString: (target: string) => {
            if (options.unreadableTcp === true && target === "/proc/net/tcp") {
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: target,
                }),
              );
            }
            if (proc === undefined || target === "/proc/net/tcp6")
              return noop.readFileString(target);
            return target === "/proc/net/tcp"
              ? Effect.succeed(proc.tcp)
              : noop.readFileString(target);
          },
          readDirectory: (target: string) => {
            if (proc === undefined) return noop.readDirectory(target);
            if (target === "/proc") return Effect.succeed(proc.owners.map((owner) => owner.pid));
            const pid = /^\/proc\/([^/]+)\/fd$/.exec(target)?.[1];
            const owner = proc.owners.find((candidate) => candidate.pid === pid);
            return owner === undefined
              ? noop.readDirectory(target)
              : Effect.succeed(owner.fds.map((_, index) => String(index)));
          },
          readLink: (target: string) => {
            if (proc === undefined) return noop.readLink(target);
            const match = /^\/proc\/([^/]+)\/fd\/(\d+)$/.exec(target);
            const owner = proc.owners.find((candidate) => candidate.pid === match?.[1]);
            const target0 = owner?.fds[Number(match?.[2])];
            return target0 === undefined ? noop.readLink(target) : Effect.succeed(target0);
          },
        })
      : FileSystem.layerNoop({});
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) {
          return yield* Effect.die(new Error("expected a standard command"));
        }
        return scriptedHandle(
          options.reply?.(command.command, command.args.map(String)) ?? { stdout: "" },
        );
      }),
    );
    return Layer.mergeAll(
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HostProcess.Platform, options.platform),
      Layer.succeed(HostProcess.Architecture, "x64"),
      Layer.succeed(HostProcess.Environment, { SystemRoot: "C:\\Windows" }),
      Layer.succeed(HostProcess.ExecutablePath, NodeProcess.execPath),
      fileSystem,
      Path.layer,
    );
  };

  it.effect.each([
    {
      name: "every netstat row on the port names the child",
      platform: "win32" as const,
      expected: "ours" as const,
      options: { reply: () => ({ stdout: netstatRows("800") }) },
    },
    {
      name: "a netstat row of another pid",
      platform: "win32" as const,
      expected: "other" as const,
      options: { reply: () => ({ stdout: netstatRows("900") }) },
    },
    {
      name: "a malformed netstat row",
      platform: "win32" as const,
      expected: "other" as const,
      options: {
        reply: () => ({ stdout: `  TCPX   127.0.0.1:${port}    0.0.0.0:0    LISTENING    800` }),
      },
    },
    {
      name: "a netstat row without a pid",
      platform: "win32" as const,
      expected: "other" as const,
      options: {
        reply: () => ({ stdout: `  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING` }),
      },
    },
    {
      name: "a netstat exit that is not zero",
      platform: "win32" as const,
      expected: "other" as const,
      options: { reply: () => ({ stdout: netstatRows("800"), exitCode: 1 }) },
    },
    {
      name: "every lsof row on the port names the child",
      platform: "darwin" as const,
      expected: "ours" as const,
      options: { reply: () => ({ stdout: lsofRows("p800") }) },
    },
    {
      name: "an lsof row of another pid",
      platform: "darwin" as const,
      expected: "other" as const,
      options: { reply: () => ({ stdout: lsofRows("p900") }) },
    },
    {
      name: "a malformed lsof pid line",
      platform: "darwin" as const,
      expected: "other" as const,
      options: { reply: () => ({ stdout: lsofRows("pabc") }) },
    },
    {
      name: "an lsof row without a pid",
      platform: "darwin" as const,
      expected: "other" as const,
      options: { reply: () => ({ stdout: `n127.0.0.1:${port}\n` }) },
    },
    {
      name: "an lsof exit that is not zero",
      platform: "darwin" as const,
      expected: "other" as const,
      options: { reply: () => ({ stdout: lsofRows("p800"), exitCode: 1 }) },
    },
    {
      name: "the proc row names the child",
      platform: "linux" as const,
      expected: "ours" as const,
      options: { proc: { tcp: procTcpRow, owners: [{ pid: "800", fds: ["socket:[5001]"] }] } },
    },
    {
      name: "a proc row of another pid",
      platform: "linux" as const,
      expected: "other" as const,
      options: { proc: { tcp: procTcpRow, owners: [{ pid: "900", fds: ["socket:[5001]"] }] } },
    },
    {
      name: "a malformed proc row",
      platform: "linux" as const,
      expected: "other" as const,
      options: {
        proc: {
          tcp: `  0: 0100007F:207D 00000000:0000 0A 00000000:00000000 00 000000 00000000 00 xxxx 1 0000000000000000\n`,
          owners: [{ pid: "800", fds: ["socket:[5001]"] }],
        },
      },
    },
    {
      name: "a proc row without a pid",
      platform: "linux" as const,
      expected: "other" as const,
      options: { proc: { tcp: procTcpRow, owners: [] } },
    },
    {
      name: "an unreadable proc table",
      platform: "linux" as const,
      expected: "other" as const,
      options: { unreadableTcp: true },
    },
  ])("$name answers $expected", ({ platform, expected, options }) =>
    Effect.gen(function* () {
      const answer = yield* FactoryProxy.listenerOwner({ port, pid: child }).pipe(
        Effect.provide(ownerLayer({ platform, ...options })),
      );
      assert.strictEqual(answer, expected);
    }),
  );

  it.effect.each([{ platform: "win32" as const }, { platform: "darwin" as const }])(
    "a $platform query that never exits times out and answers other",
    ({ platform }) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          FactoryProxy.listenerOwner({ port, pid: child }).pipe(
            Effect.provide(ownerLayer({ platform, reply: () => ({ stdout: "", hang: true }) })),
          ),
        );
        yield* TestClock.adjust(Duration.seconds(10));
        const answer = yield* Fiber.join(fiber);
        assert.strictEqual(answer, "other");
      }),
  );
});

describe("P11-23 the supervisor text", () => {
  // The stand-in program is the test's own Node, as the contract's harness allows for it.live.
  const spawnSupervisor = (programArgs: ReadonlyArray<string>, program = NodeProcess.execPath) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return yield* spawner.spawn(
        ChildProcess.make(
          NodeProcess.execPath,
          ["-e", FactoryProxy.SUPERVISOR, "--", program, ...programArgs],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        ),
      );
    });

  it.live(
    "prints one pid line, forwards an exit code, dies with its stdin, and without a program",
    () =>
      Effect.gen(function* () {
        // A stand-in that exits 7: one pid line, and the code forwarded.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawnSupervisor(["-e", "process.exit(7)"]);
            const lines: Array<string> = [];
            const collected = yield* Effect.forkChild(
              Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stdout)), (line) =>
                Effect.sync(() => {
                  lines.push(line);
                }),
              ),
            );
            const code = yield* handle.exitCode;
            yield* Fiber.join(collected);
            const pidLines = lines.filter((line) => /^pid \d+$/.test(line));
            assert.strictEqual(pidLines.length, 1);
            assert.strictEqual(code, 7);
          }),
        );

        // A stand-in that stays alive: the pid line names a live process; ending the
        // supervisor's stdin ends it, and the supervisor exits with the child gone.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawnSupervisor(["-e", "setInterval(() => {}, 60000)"]);
            const lines: Array<string> = [];
            const pidLine = yield* Deferred.make<number>();
            const collected = yield* Effect.forkChild(
              Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stdout)), (line) =>
                Effect.sync(() => {
                  lines.push(line);
                  const pid = /^pid (\d+)$/.exec(line)?.[1];
                  if (pid !== undefined) Deferred.doneUnsafe(pidLine, Effect.succeed(Number(pid)));
                }),
              ),
            );
            const pid = yield* Deferred.await(pidLine);
            assert.strictEqual(lines.filter((line) => /^pid \d+$/.test(line)).length, 1);
            assert.isTrue(processAlive(pid));
            yield* Stream.run(Stream.empty, handle.stdin);
            const code = yield* handle.exitCode;
            assert.strictEqual(typeof code, "number");
            assert.isFalse(processAlive(pid));
            yield* Fiber.interrupt(collected);
          }),
        );

        // A program that does not exist: exit 126 and no pid line.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawnSupervisor([], "Z:/t3-factory-proxy-missing-program");
            const lines: Array<string> = [];
            const collected = yield* Effect.forkChild(
              Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stdout)), (line) =>
                Effect.sync(() => {
                  lines.push(line);
                }),
              ),
            );
            const code = yield* handle.exitCode;
            yield* Fiber.join(collected);
            assert.deepStrictEqual(
              lines.filter((line) => /^pid \d+$/.test(line)),
              [],
            );
            assert.strictEqual(code, 126);
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("P11-26 revision 11e uninstall with onlyCredentials", () => {
  it.effect(
    "after kept sign-ins a follow-up onlyCredentials uninstall leaves no proxy folder",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "t3-factory-proxy-only-credentials-",
        });
        yield* withWorld({ baseDir }, (world) =>
          Effect.gen(function* () {
            yield* install(world);
            yield* startToRunning(world);
            const kept = yield* world.proxy.uninstall({ removeCredentials: false });
            yield* world.proxy.drain;
            assert.strictEqual(kept.state, "not-installed");
            assert.isTrue(kept.credentials);
            assert.isTrue(yield* world.fs.exists(world.root));
          }),
        );
        yield* withWorld({ baseDir }, (world) =>
          Effect.gen(function* () {
            const answer = yield* world.proxy.uninstall({
              removeCredentials: true,
              onlyCredentials: true,
            });
            yield* world.proxy.drain;
            assert.strictEqual(answer.state, "not-installed");
            assert.isFalse(yield* world.fs.exists(world.root));
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("with a record in any phase onlyCredentials is refused already-installed", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        yield* install(world);
        yield* startToRunning(world);
        const before = world.order.length;

        assert.deepStrictEqual(
          yield* refusalOf(
            world.proxy.uninstall({ removeCredentials: true, onlyCredentials: true }),
          ),
          { reason: "already-installed", message: REFUSALS["already-installed"] },
        );
        assert.isTrue(yield* world.fs.exists(world.recordPath));
        assert.isTrue(yield* world.fs.exists(world.releaseDir));
        assert.isTrue(yield* world.fs.exists(world.consolePath));
        assert.isTrue(Option.isSome(yield* world.secretStore.get(MANAGEMENT_KEY_NAME)));
        assert.isTrue(Option.isSome(yield* world.secretStore.get(CLIENT_KEY_NAME)));
        const settings = yield* world.settings.getSettings;
        assert.isTrue(Object.hasOwn(settings.usageLimitSources, FACTORY_PROXY_SOURCE_ID));
        // 11e refuses already-installed deleting nothing and patching nothing; the
        // refusal path may still read the two key secrets on its way there.
        const tail = world.order.slice(before);
        assert.deepStrictEqual(
          tail.filter(
            (event) =>
              event === "patch" || event.startsWith("remove:") || event.startsWith("secret-set:"),
          ),
          [],
        );
      }),
    ),
  );
});
