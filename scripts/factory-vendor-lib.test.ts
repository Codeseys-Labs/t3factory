// @effect-diagnostics nodeBuiltinImport:off -- Fixtures are hashed with Node crypto.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

import { vendorProblems } from "./factory-vendor.ts";
import {
  fetchPinned,
  makeDownload,
  pinnedFor,
  readVendorManifestIn,
  type Download,
  type PinnedFile,
} from "./factory-vendor-lib.ts";

const encoder = new TextEncoder();
const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

interface HashedFixture {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface AssetFixture extends HashedFixture {
  readonly platform: string;
}
interface ComponentFixture {
  readonly name: string;
  readonly version: string;
  readonly license: HashedFixture;
  readonly assets: ReadonlyArray<AssetFixture>;
}

const committedManifestPath = NodeURL.fileURLToPath(
  new URL("../factory/vendor/manifest.json", import.meta.url),
);

const PROXY_LABEL = "cliproxyapi 8.0.78 win32-x64";
const RELEASE_ASSET_HOST =
  "https://release-assets.githubusercontent.com/CLIProxyAPI_8.0.78_windows_amd64.zip";

// The stand-in release body; the fixture PinnedFile pins its length and hash.
const BODY = encoder.encode("stand-in release body, nothing more\n");
const archiveFile = (url: string, body: Uint8Array): PinnedFile => ({
  role: "archive",
  label: PROXY_LABEL,
  url,
  bytes: body.length,
  sha256: sha256Hex(body),
});

interface Reply {
  readonly status: number;
  readonly location: string | null;
  readonly body: Uint8Array;
}
type Route = (url: string, request: number) => Effect.Effect<Reply, Error>;

const reply = (body: Uint8Array): Reply => ({ status: 200, location: null, body });
const redirect = (status: number, location: string | null): Reply => ({
  status,
  location,
  body: new Uint8Array(0),
});

/** A fake Download that records every URL it is given and answers as scripted. */
const scriptedDownload = (route: Route) => {
  const requests: Array<string> = [];
  const download: Download = (url) =>
    Effect.suspend(() => {
      const request = requests.length + 1;
      requests.push(url);
      return route(url, request);
    });
  return { download, requests };
};

// 24
it.layer(NodeServices.layer)("24 pinnedFor and readVendorManifestIn", (it) => {
  it.effect(
    "pinnedFor of the committed manifest for win32-x64 gives both versions and P4's four files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs.readFileString(committedManifestPath);
        const manifest = JSON.parse(text) as { components: [ComponentFixture, ComponentFixture] };
        const [proxy, center] = manifest.components;

        const result = pinnedFor(text, "win32-x64");
        if ("problems" in result) {
          assert.deepStrictEqual(result.problems, [], "the committed manifest has no problems");
        }
        if ("problems" in result) return;
        assert.strictEqual(result.proxy, "8.0.78");
        assert.strictEqual(result.console, "1.28.3");

        const archive = proxy.assets.find((asset) => asset.platform === "win32-x64");
        assert.isTrue(archive !== undefined);
        assert.deepStrictEqual(result.files && [...result.files], [
          {
            role: "archive",
            label: "cliproxyapi 8.0.78 win32-x64",
            url: archive?.url,
            bytes: archive?.bytes,
            sha256: archive?.sha256,
          },
          {
            role: "proxy-license",
            label: "cliproxyapi 8.0.78 license",
            url: proxy.license.url,
            bytes: proxy.license.bytes,
            sha256: proxy.license.sha256,
          },
          {
            role: "console",
            label: "management-center 1.28.3 any",
            url: center.assets[0]?.url,
            bytes: center.assets[0]?.bytes,
            sha256: center.assets[0]?.sha256,
          },
          {
            role: "console-license",
            label: "management-center 1.28.3 license",
            url: center.license.url,
            bytes: center.license.bytes,
            sha256: center.license.sha256,
          },
        ]);
      }),
  );

  it.effect(
    "linux-arm64 names the linux_aarch64 archive, win32-arm64 has no build, an invalid text its problems",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs.readFileString(committedManifestPath);

        const linux = pinnedFor(text, "linux-arm64");
        if ("problems" in linux) {
          assert.deepStrictEqual(linux.problems, [], "linux-arm64 is pinned");
        }
        if ("problems" in linux) return;
        assert.strictEqual(
          linux.files?.[0]?.url.endsWith("CLIProxyAPI_8.0.78_linux_aarch64.tar.gz"),
          true,
        );

        const arm = pinnedFor(text, "win32-arm64");
        if ("problems" in arm) {
          assert.deepStrictEqual(arm.problems, [], "the manifest itself is valid");
        }
        if ("problems" in arm) return;
        assert.strictEqual(arm.files, null);

        assert.deepStrictEqual(pinnedFor("{", "win32-x64"), { problems: vendorProblems("{") });
        assert.deepStrictEqual(pinnedFor(null, "win32-x64"), { problems: vendorProblems(null) });
      }),
  );

  it.effect(
    "readVendorManifestIn answers no checkout without seams.json, else the manifest text or null",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const committed = yield* fs.readFileString(committedManifestPath);

        const bare = yield* fs.makeTempDirectoryScoped({ prefix: "factory-vendor-lib-bare-" });
        assert.deepStrictEqual(yield* readVendorManifestIn(bare), { checkout: false });

        const checkout = yield* fs.makeTempDirectoryScoped({
          prefix: "factory-vendor-lib-checkout-",
        });
        yield* fs.makeDirectory(path.join(checkout, "factory"), { recursive: true });
        yield* fs.writeFileString(path.join(checkout, "factory", "seams.json"), "{}");
        assert.deepStrictEqual(yield* readVendorManifestIn(checkout), {
          checkout: true,
          text: null,
        });

        yield* fs.makeDirectory(path.join(checkout, "factory", "vendor"), { recursive: true });
        yield* fs.writeFileString(
          path.join(checkout, "factory", "vendor", "manifest.json"),
          committed,
        );
        assert.deepStrictEqual(yield* readVendorManifestIn(checkout), {
          checkout: true,
          text: committed,
        });
      }),
  );
});

// 25
it.layer(NodeServices.layer)("25 fetchPinned and the abortable download", (it) => {
  it.effect("fetchPinned follows a 302 to the release-asset host and returns the body", () =>
    Effect.gen(function* () {
      const url = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.78/x.zip";
      const { download, requests } = scriptedDownload((requested) =>
        Effect.succeed(requested === url ? redirect(302, RELEASE_ASSET_HOST) : reply(BODY)),
      );
      const result = yield* fetchPinned(archiveFile(url, BODY), download);
      if ("failure" in result) {
        assert.fail(`expected a body, got ${String(result.failure)}: ${String(result.line)}`);
      }
      assert.deepStrictEqual(new Uint8Array(result.body), BODY);
      assert.deepStrictEqual(requests, [url, RELEASE_ASSET_HOST]);
    }),
  );

  it.effect.each([
    {
      name: "a short body",
      route: () => reply(BODY.slice(0, BODY.length - 1)),
      failure: "verify",
      line: `failed ${PROXY_LABEL}: expected ${BODY.length} bytes, got ${BODY.length - 1}`,
    },
    {
      name: "a body with another SHA-256",
      route: () =>
        reply(
          encoder.encode(
            `not the pinned body at all${" ".repeat(BODY.length)}`.slice(0, BODY.length),
          ),
        ),
      failure: "verify",
      line: `failed ${PROXY_LABEL}: sha256 expected ${sha256Hex(BODY)}, got ${sha256Hex(
        encoder.encode("not the pinned body at all".padEnd(BODY.length, " ")),
      )}`,
    },
    {
      name: "a 404",
      route: () => redirect(404, null),
      failure: "download",
      line: `failed ${PROXY_LABEL}: status 404`,
    },
    {
      name: "a redirect to evil.example",
      route: () => redirect(302, "https://evil.example/x"),
      failure: "download",
      line: `failed ${PROXY_LABEL}: redirect to evil.example is not allowed`,
    },
  ])(
    "fetchPinned gives $failure for $name, with stage 1's exact line",
    ({ route, failure, line }) =>
      Effect.gen(function* () {
        const url = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.78/x.zip";
        const { download, requests } = scriptedDownload(() => Effect.succeed(route()));
        const result = yield* fetchPinned(archiveFile(url, BODY), download);
        assert.isTrue("failure" in result);
        if (!("failure" in result)) return;
        assert.strictEqual(result.failure, failure);
        assert.strictEqual(result.line, line);
        assert.deepStrictEqual(requests, [url]);
      }),
  );

  it.effect(
    "makeDownload with abortable hands the transport a signal aborted when the fiber is interrupted",
    () =>
      Effect.gen(function* () {
        const called = yield* Deferred.make<AbortSignal | null | undefined>();
        const transport = (_input: RequestInfo | URL, init?: RequestInit) => {
          Deferred.doneUnsafe(called, Effect.succeed(init?.signal));
          const { promise } = Promise.withResolvers<Response>();
          return promise;
        };
        const download = makeDownload({ transport, maxBytes: 1024, abortable: true });
        const fiber = yield* Effect.forkChild(
          download("https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.78/x.zip"),
        );
        const signal = yield* Deferred.await(called);
        yield* Fiber.interrupt(fiber);
        assert.isDefined(signal);
        assert.strictEqual(signal?.aborted, true);
      }),
  );
});
