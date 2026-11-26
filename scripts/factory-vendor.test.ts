// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalErrorInEffectFailure:off globalErrorInEffectCatch:off - Fixtures are hashed and linked with Node modules, one test swaps global fetch for a thrower, and Download fails with a plain Error.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import {
  assetFile,
  checkVendor,
  fetchVendor,
  isNetworkPath,
  makeDownload,
  statusVendor,
  vendorProblems,
  type Download,
  type Report,
} from "./factory-vendor.ts";

interface Hashed {
  url: string;
  bytes: number;
  sha256: string;
}
interface Asset extends Hashed {
  platform: string;
}
interface Component {
  name: string;
  version: string;
  source: string;
  publishedAt: string;
  retrievedAt: string;
  license: Hashed & { id: string };
  assets: Array<Asset>;
  requires: { component: string; min: string; below: string } | null;
}
interface Manifest {
  v: number;
  components: [Component, Component];
}

// The value of V1, typed out here so a wrong committed file cannot make this test agree with itself.
const pinned: Manifest = {
  v: 1,
  components: [
    {
      name: "cliproxyapi",
      version: "8.0.78",
      source: "https://github.com/router-for-me/CLIProxyAPI",
      publishedAt: "2026-11-19T00:28:17Z",
      retrievedAt: "2026-11-26T04:17:56Z",
      license: {
        id: "MIT",
        url: "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v8.0.78/LICENSE",
        bytes: 1116,
        sha256: "879792e89cf1bdd6a8d446033ec87e30496f97dcafc4656dc53f641509b346a6",
      },
      assets: [
        {
          platform: "win32-x64",
          url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.78/CLIProxyAPI_8.0.78_windows_amd64.zip",
          bytes: 26764848,
          sha256: "9b87222ccc4e9705193fcfe6ebb1fcd08154987b30d43e80cd03326bbc875831",
        },
        {
          platform: "darwin-arm64",
          url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.78/CLIProxyAPI_8.0.78_darwin_aarch64.tar.gz",
          bytes: 24384911,
          sha256: "32d3bfb23df6f88615d9bcb0acab65db842182bacd583d73b2f5e280651a26cf",
        },
        {
          platform: "darwin-x64",
          url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.78/CLIProxyAPI_8.0.78_darwin_amd64.tar.gz",
          bytes: 26442067,
          sha256: "18cc73e9da3485824358efd1d1decc550c40c71c3dd84bedd45881ba74da590d",
        },
        {
          platform: "linux-x64",
          url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.78/CLIProxyAPI_8.0.78_linux_amd64.tar.gz",
          bytes: 26481480,
          sha256: "c0267b899095b9f61eaeb627a5a5f1b0926b0683236485c30e35ee56871eeb9f",
        },
        {
          platform: "linux-arm64",
          url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.78/CLIProxyAPI_8.0.78_linux_aarch64.tar.gz",
          bytes: 23846609,
          sha256: "cbece9287e0920cd5601cc3a7127175c61edc0c22f29e4838f49267177b3d18b",
        },
      ],
      requires: null,
    },
    {
      name: "management-center",
      version: "1.28.3",
      source: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center",
      publishedAt: "2026-11-18T05:37:56Z",
      retrievedAt: "2026-11-26T04:17:56Z",
      license: {
        id: "MIT",
        url: "https://raw.githubusercontent.com/router-for-me/Cli-Proxy-API-Management-Center/v1.28.3/LICENSE",
        bytes: 1070,
        sha256: "48fc0d19e5d0918e7e2a7df2deed33b167d9aad1aebb07891a32a8e6f71f80ee",
      },
      assets: [
        {
          platform: "any",
          url: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/download/v1.28.3/management.html",
          bytes: 3906632,
          sha256: "6d4e005420ee18899ef115a4e68d61f700ddb372844f2317546a0d0aa4553dfc",
        },
      ],
      requires: { component: "cliproxyapi", min: "8.0.0", below: "9.0.0" },
    },
  ],
};

const platform = HostProcess.Platform.defaultValue();
const linksSupported = platform === "win32" || symlinksSupported;
const hasModeBits = platform !== "win32";
const foldsCase = platform === "win32" || platform === "darwin";
const deniedReadsWork = platform !== "win32" && HostProcess.UserId.defaultValue() !== 0;

const encoder = new TextEncoder();
const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const sorted = (items: Iterable<string>) => [...items].sort();
const unslash = (text: string) => text.replaceAll("\\", "/");
const at = <T>(items: ReadonlyArray<T>, index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${index}`);
  return item;
};

const [proxy, center] = pinned.components;
const proxyUrl = at(proxy.assets, 0).url;
const committedText = `${JSON.stringify(pinned, null, 2)}\n`;
const PLATFORMS = "win32-x64,darwin-arm64,darwin-x64,linux-x64,linux-arm64";

const edit = (change: (manifest: Manifest) => void) => {
  const manifest = structuredClone(pinned);
  change(manifest);
  return JSON.stringify(manifest);
};
const proxyOf = (manifest: Manifest) => manifest.components[0];
const centerOf = (manifest: Manifest) => manifest.components[1];
const requiresOf = (manifest: Manifest) => {
  const requires = centerOf(manifest).requires;
  if (requires === null) throw new Error("the console has no requires");
  return requires;
};
const entriesOf = (manifest: Manifest) =>
  manifest.components.flatMap((component): Array<Hashed> => [
    ...component.assets,
    component.license,
  ]);
const withProxyVersion = (manifest: Manifest, version: string) => {
  const component = proxyOf(manifest);
  component.version = version;
  for (const entry of [...component.assets, component.license]) {
    entry.url = entry.url.replaceAll("8.0.78", version);
  }
};

interface Row {
  readonly name: string;
  readonly text: string;
  readonly expected: ReadonlyArray<string>;
}
const rule = (
  name: string,
  change: (manifest: Manifest) => void,
  expected: ReadonlyArray<string>,
): Row => ({ name, text: edit(change), expected: sorted(expected) });

// V2 in order: per component its assets, then the licence, with the label V4 prints.
const expectedFiles = [
  {
    label: "cliproxyapi 8.0.78 win32-x64",
    file: "cliproxyapi-8.0.78/CLIProxyAPI_8.0.78_windows_amd64.zip",
    url: proxyUrl,
  },
  {
    label: "cliproxyapi 8.0.78 darwin-arm64",
    file: "cliproxyapi-8.0.78/CLIProxyAPI_8.0.78_darwin_aarch64.tar.gz",
    url: at(proxy.assets, 1).url,
  },
  {
    label: "cliproxyapi 8.0.78 darwin-x64",
    file: "cliproxyapi-8.0.78/CLIProxyAPI_8.0.78_darwin_amd64.tar.gz",
    url: at(proxy.assets, 2).url,
  },
  {
    label: "cliproxyapi 8.0.78 linux-x64",
    file: "cliproxyapi-8.0.78/CLIProxyAPI_8.0.78_linux_amd64.tar.gz",
    url: at(proxy.assets, 3).url,
  },
  {
    label: "cliproxyapi 8.0.78 linux-arm64",
    file: "cliproxyapi-8.0.78/CLIProxyAPI_8.0.78_linux_aarch64.tar.gz",
    url: at(proxy.assets, 4).url,
  },
  {
    label: "cliproxyapi 8.0.78 license",
    file: "cliproxyapi-8.0.78/LICENSE",
    url: proxy.license.url,
  },
  {
    label: "management-center 1.28.3 any",
    file: "management-center-1.28.3/management.html",
    url: at(center.assets, 0).url,
  },
  {
    label: "management-center 1.28.3 license",
    file: "management-center-1.28.3/LICENSE",
    url: center.license.url,
  },
];

// Small distinct bodies stand in for the real archives; the fixture manifest pins their size and hash.
const bodies = expectedFiles.map((entry) => encoder.encode(`body of ${entry.label}`));
const served = new Map(expectedFiles.map((entry, index) => [entry.url, at(bodies, index)]));
const fixtureText = edit((manifest) => {
  for (const [index, entry] of entriesOf(manifest).entries()) {
    const body = at(bodies, index);
    entry.bytes = body.length;
    entry.sha256 = sha256Hex(body);
  }
});
const downloadedListing = sorted([
  "cliproxyapi-8.0.78",
  "management-center-1.28.3",
  ...expectedFiles.map((entry) => entry.file),
]);
const fetchedLines = expectedFiles.map((entry) => `fetched ${entry.label} ${entry.file}`);

// T1
it.layer(NodeServices.layer)("committed manifest", (it) => {
  it.effect("is valid and equals the value of V1", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(
        NodeURL.fileURLToPath(new URL("../factory/vendor/manifest.json", import.meta.url)),
      );
      assert.deepStrictEqual(vendorProblems(text), []);
      const parsed: unknown = JSON.parse(text);
      assert.deepStrictEqual(parsed, pinned);
    }),
  );
});

// T2
it.effect("reports an unreadable or non-JSON manifest as its one problem", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(vendorProblems(null), ["manifest: cannot be read"]);
    assert.deepStrictEqual(vendorProblems("{"), ["manifest: not valid JSON"]);
    assert.deepStrictEqual(vendorProblems(""), ["manifest: not valid JSON"]);
  }),
);

const schemaRows = [
  {
    name: "missing top-level key",
    text: edit((m) => {
      Reflect.deleteProperty(m, "v");
    }),
  },
  {
    name: "unknown top-level key",
    text: edit((m) => {
      Object.assign(m, { extra: 1 });
    }),
  },
  {
    name: "missing component key",
    text: edit((m) => {
      Reflect.deleteProperty(proxyOf(m), "publishedAt");
    }),
  },
  {
    name: "missing component requires",
    text: edit((m) => {
      Reflect.deleteProperty(centerOf(m), "requires");
    }),
  },
  {
    name: "unknown component key",
    text: edit((m) => {
      Object.assign(proxyOf(m), { extra: 1 });
    }),
  },
  {
    name: "missing license key",
    text: edit((m) => {
      Reflect.deleteProperty(proxyOf(m).license, "sha256");
    }),
  },
  {
    name: "unknown license key",
    text: edit((m) => {
      Object.assign(proxyOf(m).license, { extra: 1 });
    }),
  },
  {
    name: "missing asset key",
    text: edit((m) => {
      Reflect.deleteProperty(at(proxyOf(m).assets, 0), "bytes");
    }),
  },
  {
    name: "unknown asset key",
    text: edit((m) => {
      Object.assign(at(proxyOf(m).assets, 0), { extra: 1 });
    }),
  },
  {
    name: "missing requires key",
    text: edit((m) => {
      Reflect.deleteProperty(requiresOf(m), "min");
    }),
  },
  {
    name: "unknown requires key",
    text: edit((m) => {
      Object.assign(requiresOf(m), { extra: 1 });
    }),
  },
  {
    name: "version other than 1",
    text: edit((m) => {
      m.v = 2;
    }),
  },
  {
    name: "bytes as text",
    text: edit((m) => {
      Reflect.set(at(proxyOf(m).assets, 0), "bytes", "26764848");
    }),
  },
  { name: "components not an array", text: JSON.stringify({ v: 1, components: {} }) },
  { name: "JSON null", text: "null" },
  { name: "JSON array", text: "[]" },
  { name: "empty object", text: "{}" },
];

it.effect.each(schemaRows)("$name gives exactly one schema problem", ({ text }) =>
  Effect.sync(() => {
    const problems = vendorProblems(text);
    assert.lengthOf(problems, 1);
    assert.match(problems[0] ?? "", /^schema: /);
  }),
);

const NAMES = "manifest: components must be cliproxyapi,management-center";
it.effect.each([
  { name: "only the proxy", components: [proxy] },
  { name: "no component", components: [] },
])("component names: $name", ({ components }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(vendorProblems(JSON.stringify({ v: 1, components })), [NAMES]);
  }),
);

// T3
const WIN = "cliproxyapi/win32-x64";
const NOT_PINNED = "url is not pinned to cliproxyapi 8.0.78";
const REQUIRES_FORM =
  "management-center: requires.min and requires.below must be exact x.y.z with min below below";

const urlCases: ReadonlyArray<readonly [string, string, string]> = [
  ["does not parse", "not a url", "url is not a valid URL"],
  ["http scheme", proxyUrl.replace("https:", "http:"), "url is not https"],
  [
    "http is checked before the host",
    proxyUrl.replace("https://github.com", "http://evil.example"),
    "url is not https",
  ],
  [
    "host not allowed",
    proxyUrl.replace("github.com", "evil.example"),
    "host evil.example is not allowed",
  ],
  ["latest download", proxyUrl.replace("download/v8.0.78", "latest/download"), NOT_PINNED],
  ["main branch", proxyUrl.replace("releases/download/v8.0.78", "raw/main"), NOT_PINNED],
  ["another version", proxyUrl.replace("/v8.0.78/", "/v8.0.77/"), NOT_PINNED],
  [
    "another repository",
    proxyUrl.replace("CLIProxyAPI/releases", "Cli-Proxy-API-Management-Center/releases"),
    NOT_PINNED,
  ],
  [
    "raw host for an asset",
    proxyUrl.replace("github.com", "raw.githubusercontent.com"),
    NOT_PINNED,
  ],
  ["query", `${proxyUrl}?x=1`, NOT_PINNED],
  ["fragment", `${proxyUrl}#top`, NOT_PINNED],
  ["port 8443", proxyUrl.replace("github.com", "github.com:8443"), NOT_PINNED],
  ["explicit port 443", proxyUrl.replace("github.com", "github.com:443"), NOT_PINNED],
  ["upper-case host", proxyUrl.replace("github.com", "GITHUB.COM"), NOT_PINNED],
  ["userinfo", proxyUrl.replace("https://", "https://user@"), NOT_PINNED],
  ["dot segments", proxyUrl.replace("/v8.0.78/", "/v8.0.78/../v8.0.78/"), NOT_PINNED],
];

const ruleRows: ReadonlyArray<Row> = [
  ...["latest", "v8.0.78", "8.0", "^8", "8.0.78-rc.1"].map((version) =>
    rule(
      `floating proxy version ${version}`,
      (m) => {
        proxyOf(m).version = version;
      },
      [`cliproxyapi: version ${version} is not an exact x.y.z`],
    ),
  ),
  rule(
    "floating console version",
    (m) => {
      centerOf(m).version = "latest";
    },
    ["management-center: version latest is not an exact x.y.z"],
  ),
  rule(
    "proxy source with a trailing slash",
    (m) => {
      proxyOf(m).source = `${proxy.source}/`;
    },
    ["cliproxyapi: source must be https://github.com/router-for-me/CLIProxyAPI"],
  ),
  rule(
    "console source of the proxy",
    (m) => {
      centerOf(m).source = proxy.source;
    },
    [
      "management-center: source must be https://github.com/router-for-me/Cli-Proxy-API-Management-Center",
    ],
  ),
  rule(
    "a platform is missing",
    (m) => {
      proxyOf(m).assets.pop();
    },
    [`cliproxyapi: platforms must be ${PLATFORMS}`],
  ),
  rule(
    "platforms out of order",
    (m) => {
      proxyOf(m).assets.reverse();
    },
    [`cliproxyapi: platforms must be ${PLATFORMS}`],
  ),
  rule(
    "darwin file under win32-x64",
    (m) => {
      at(proxyOf(m).assets, 0).url = at(proxy.assets, 1).url;
    },
    ["cliproxyapi/darwin-arm64: duplicate url", `${WIN}: ${NOT_PINNED}`],
  ),
  rule(
    "proxy with requires",
    (m) => {
      proxyOf(m).requires = { component: "cliproxyapi", min: "8.0.0", below: "9.0.0" };
    },
    ["cliproxyapi: requires must be null"],
  ),
  rule(
    "console without requires",
    (m) => {
      centerOf(m).requires = null;
    },
    ["management-center: requires is missing"],
  ),
  ...urlCases.map(([name, url, problem]) =>
    rule(
      `url ${name}`,
      (m) => {
        at(proxyOf(m).assets, 0).url = url;
      },
      [`${WIN}: ${problem}`],
    ),
  ),
  rule(
    "licence url on the main branch",
    (m) => {
      proxyOf(m).license.url =
        "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/LICENSE";
    },
    [`cliproxyapi/license: ${NOT_PINNED}`],
  ),
  rule(
    "licence url on the release host",
    (m) => {
      proxyOf(m).license.url = "https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.78/LICENSE";
    },
    [`cliproxyapi/license: ${NOT_PINNED}`],
  ),
  rule(
    "console url on the latest release",
    (m) => {
      at(centerOf(m).assets, 0).url = at(center.assets, 0).url.replace(
        "download/v1.28.3",
        "latest/download",
      );
    },
    ["management-center/any: url is not pinned to management-center 1.28.3"],
  ),
  ...["GPL-3.0-only", "MIT-0", "NOASSERTION"].map((id) =>
    rule(
      `proxy licence id ${id}`,
      (m) => {
        proxyOf(m).license.id = id;
      },
      [`cliproxyapi/license: id ${id} is not allowed`],
    ),
  ),
  rule(
    "console licence id MIT-0",
    (m) => {
      centerOf(m).license.id = "MIT-0";
    },
    ["management-center/license: id MIT-0 is not allowed"],
  ),
];

it.effect.each(ruleRows)("rule: $name", ({ text, expected }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(vendorProblems(text), expected);
  }),
);

// r10c V3: pinned is the exact URL, so an empty query, an empty fragment or a trailing space fails.
const pinTargets: ReadonlyArray<{
  label: string;
  problem: string;
  url: string;
  set: (m: Manifest, url: string) => void;
}> = [
  {
    label: WIN,
    problem: NOT_PINNED,
    url: proxyUrl,
    set: (m, url) => {
      at(proxyOf(m).assets, 0).url = url;
    },
  },
  {
    label: "cliproxyapi/license",
    problem: NOT_PINNED,
    url: proxy.license.url,
    set: (m, url) => {
      proxyOf(m).license.url = url;
    },
  },
  {
    label: "management-center/any",
    problem: "url is not pinned to management-center 1.28.3",
    url: at(center.assets, 0).url,
    set: (m, url) => {
      at(centerOf(m).assets, 0).url = url;
    },
  },
  {
    label: "management-center/license",
    problem: "url is not pinned to management-center 1.28.3",
    url: center.license.url,
    set: (m, url) => {
      centerOf(m).license.url = url;
    },
  },
];

const pinRows: ReadonlyArray<Row> = pinTargets.flatMap((target) =>
  ["?", "#", "?#", "?x=1", " "].map((suffix) =>
    rule(
      `${target.label} url followed by ${JSON.stringify(suffix)}`,
      (m) => {
        target.set(m, `${target.url}${suffix}`);
      },
      [`${target.label}: ${target.problem}`],
    ),
  ),
);

it.effect.each(pinRows)("r10c V3 pinned is the exact url: $name", ({ text, expected }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(vendorProblems(text), expected);
  }),
);

// r10c V3: a name that is an Object.prototype key is an unknown name like any other, not a crash.
// The name is a string value in the manifest; a lookup keyed by it is what must not reach the prototype.
const OTHER_NAME = "other-component";
const renamed = (index: 0 | 1, name: string) =>
  edit((m) => {
    m.components[index].name = name;
  });
const prototypeNames = ["constructor", "toString", "__proto__"].flatMap((name) =>
  ([0, 1] as const).map((index) => ({ name, index })),
);

it.effect.each(prototypeNames)(
  "r10c V3 a component named $name at position $index is an ordinary unknown name",
  ({ name, index }) =>
    Effect.sync(() => {
      const text = renamed(index, name);
      const problems = vendorProblems(text);
      // An ordinary unknown name gives the same lines with its own name in place of this one.
      const ordinary = vendorProblems(renamed(index, OTHER_NAME)).map((line) =>
        line.replaceAll(OTHER_NAME, name),
      );
      assert.include(problems, NAMES);
      assert.deepStrictEqual(problems, sorted(ordinary));
      assert.deepStrictEqual(checkVendor(text), {
        exitCode: 1,
        stdout: [],
        stderr: problems.map((problem) => `invalid ${problem}`),
      });
    }),
);

const crowdedRows: ReadonlyArray<Row> = [
  rule(
    "one value breaking six rules is sorted",
    (m) => {
      const p = proxyOf(m);
      p.version = "8.0";
      p.requires = { component: "cliproxyapi", min: "8.0.0", below: "9.0.0" };
      p.license.id = "MIT-0";
      at(p.assets, 0).bytes = 0;
      at(p.assets, 4).sha256 = at(p.assets, 4).sha256.toUpperCase();
      centerOf(m).requires = null;
    },
    [
      "cliproxyapi: version 8.0 is not an exact x.y.z",
      "cliproxyapi: requires must be null",
      "cliproxyapi/license: id MIT-0 is not allowed",
      `${WIN}: bytes must be an integer from 1 to 104857600`,
      "cliproxyapi/linux-arm64: sha256 is not 64 lower-case hex",
      "management-center: requires is missing",
    ],
  ),
  rule(
    "a problem text produced twice is listed once",
    (m) => {
      const first = at(proxyOf(m).assets, 0);
      // Both extra assets share the label cliproxyapi/win32-x64, so each rule gives the same text twice.
      proxyOf(m).assets = [
        first,
        { platform: "win32-x64", url: "not a url 1", bytes: 1, sha256: "a".repeat(64) },
        { platform: "win32-x64", url: "not a url 2", bytes: 1, sha256: "b".repeat(64) },
      ];
    },
    [
      `${WIN}: duplicate platform`,
      `${WIN}: url is not a valid URL`,
      `cliproxyapi: platforms must be ${PLATFORMS}`,
    ],
  ),
];

it.effect.each(crowdedRows)("$name", ({ text, expected }) =>
  Effect.sync(() => {
    const problems = vendorProblems(text);
    assert.deepStrictEqual(problems, expected);
    assert.deepStrictEqual(problems, sorted(new Set(problems)));
  }),
);

// T4
const PROXY_AGE = "cliproxyapi: retrievedAt is less than 168 hours after publishedAt";
const CENTER_AGE = "management-center: retrievedAt is less than 168 hours after publishedAt";
const formatProblem = (field: string) =>
  `cliproxyapi: ${field} is not a UTC timestamp YYYY-MM-DDTHH:MM:SSZ`;

const badTimestamps: ReadonlyArray<readonly [string, string]> = [
  ["date only", "2026-11-19"],
  ["fractional seconds", "2026-11-19T00:28:17.000Z"],
  ["numeric offset", "2026-11-19T00:28:17+00:00"],
  ["space separator", "2026-11-19 00:28:17Z"],
  ["lower case", "2026-11-19t00:28:17z"],
  ["impossible day", "2026-02-30T00:28:17Z"],
  ["impossible month", "2026-13-01T00:28:17Z"],
  ["hour 24", "2026-11-19T24:00:00Z"],
];

const ageRows: ReadonlyArray<Row> = [
  // Published 2026-11-19T00:28:17Z plus 7 days is 168 hours.
  rule(
    "proxy retrieved exactly 168 hours after publication",
    (m) => {
      proxyOf(m).retrievedAt = "2026-11-26T00:28:17Z";
    },
    [],
  ),
  rule(
    "proxy retrieved one second short of 168 hours",
    (m) => {
      proxyOf(m).retrievedAt = "2026-11-26T00:28:16Z";
    },
    [PROXY_AGE],
  ),
  rule(
    "proxy retrieved before publication",
    (m) => {
      proxyOf(m).retrievedAt = "2026-11-18T00:28:17Z";
    },
    [PROXY_AGE],
  ),
  rule(
    "proxy retrieved at the instant of publication",
    (m) => {
      proxyOf(m).retrievedAt = proxy.publishedAt;
    },
    [PROXY_AGE],
  ),
  // Published 2026-11-18T05:37:56Z plus 7 days.
  rule(
    "console retrieved exactly 168 hours after publication",
    (m) => {
      centerOf(m).retrievedAt = "2026-11-25T05:37:56Z";
    },
    [],
  ),
  rule(
    "console retrieved one second short of 168 hours",
    (m) => {
      centerOf(m).retrievedAt = "2026-11-25T05:37:55Z";
    },
    [CENTER_AGE],
  ),
  // A timestamp with its own problem skips the age check, even when the other one is far off.
  ...badTimestamps.flatMap(([name, value]) => [
    rule(
      `publishedAt ${name}`,
      (m) => {
        proxyOf(m).publishedAt = value;
      },
      [formatProblem("publishedAt")],
    ),
    rule(
      `retrievedAt ${name}`,
      (m) => {
        proxyOf(m).retrievedAt = value;
      },
      [formatProblem("retrievedAt")],
    ),
  ]),
  rule(
    "both timestamps malformed",
    (m) => {
      proxyOf(m).publishedAt = "yesterday";
      proxyOf(m).retrievedAt = "2026-02-30T00:28:17Z";
    },
    [formatProblem("publishedAt"), formatProblem("retrievedAt")],
  ),
];

it.effect.each(ageRows)("age: $name", ({ text, expected }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(vendorProblems(text), expected);
  }),
);

// T5
const sha = at(proxy.assets, 0).sha256;
const shaCases: ReadonlyArray<readonly [string, string]> = [
  ["upper-case", sha.toUpperCase()],
  ["63 characters", sha.slice(1)],
  ["65 characters with a leading extra", `0${sha}`],
  ["65 characters with a trailing extra", `${sha}0`],
  ["64 characters with one not hex", `${sha.slice(0, 63)}g`],
  ["trailing newline", `${sha}\n`],
  ["empty", ""],
];
const targets: ReadonlyArray<{
  label: string;
  set: (m: Manifest, field: "sha256" | "bytes", value: string | number) => void;
}> = [
  {
    label: WIN,
    set: (m, field, value) => {
      Reflect.set(at(proxyOf(m).assets, 0), field, value);
    },
  },
  {
    label: "cliproxyapi/license",
    set: (m, field, value) => {
      Reflect.set(proxyOf(m).license, field, value);
    },
  },
  {
    label: "management-center/any",
    set: (m, field, value) => {
      Reflect.set(at(centerOf(m).assets, 0), field, value);
    },
  },
];
const BYTES = "bytes must be an integer from 1 to 104857600";

const hashRows: ReadonlyArray<Row> = [
  ...targets.flatMap((target) =>
    shaCases.map(([name, value]) =>
      rule(
        `${target.label} sha256 ${name}`,
        (m) => {
          target.set(m, "sha256", value);
        },
        [`${target.label}: sha256 is not 64 lower-case hex`],
      ),
    ),
  ),
  ...targets.flatMap((target) =>
    [0, 1.5, 104857601, -1].map((value) =>
      rule(
        `${target.label} bytes ${value}`,
        (m) => {
          target.set(m, "bytes", value);
        },
        [`${target.label}: ${BYTES}`],
      ),
    ),
  ),
  ...[1, 104857600].map((value) =>
    rule(
      `bytes ${value} is accepted`,
      (m) => {
        at(proxyOf(m).assets, 0).bytes = value;
      },
      [],
    ),
  ),
];

it.effect.each(hashRows)("hash and size: $name", ({ text, expected }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(vendorProblems(text), expected);
  }),
);

// T6
const duplicateRows: ReadonlyArray<Row> = [
  rule(
    "an asset of the second component repeats a url of the first",
    (m) => {
      at(centerOf(m).assets, 0).url = proxyUrl;
    },
    [
      "management-center/any: duplicate url",
      "management-center/any: url is not pinned to management-center 1.28.3",
    ],
  ),
  rule(
    "an asset of the second component repeats a sha256 of the first",
    (m) => {
      at(centerOf(m).assets, 0).sha256 = at(proxyOf(m).assets, 0).sha256;
    },
    ["management-center/any: duplicate sha256"],
  ),
  rule(
    "a licence repeats an asset url of its component",
    (m) => {
      proxyOf(m).license.url = proxyUrl;
    },
    ["cliproxyapi/license: duplicate url", `cliproxyapi/license: ${NOT_PINNED}`],
  ),
  rule(
    "a licence repeats an asset sha256 of its component",
    (m) => {
      proxyOf(m).license.sha256 = at(proxyOf(m).assets, 2).sha256;
    },
    ["cliproxyapi/license: duplicate sha256"],
  ),
  // Assets come first in the walk, so the licence is the later entry and gets the problem.
  rule(
    "an asset repeats the url of its component's licence",
    (m) => {
      at(proxyOf(m).assets, 0).url = proxy.license.url;
    },
    ["cliproxyapi/license: duplicate url", `${WIN}: ${NOT_PINNED}`],
  ),
  // Both assets carry the label cliproxyapi/win32-x64, so a single line is all that can appear.
  rule(
    "an asset repeats a platform of its component",
    (m) => {
      at(proxyOf(m).assets, 1).platform = "win32-x64";
    },
    [
      `${WIN}: duplicate platform`,
      `${WIN}: ${NOT_PINNED}`,
      `cliproxyapi: platforms must be ${PLATFORMS}`,
    ],
  ),
];

it.effect.each(duplicateRows)("duplicates: $name", ({ text, expected }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(vendorProblems(text), expected);
  }),
);

// T7
const outside = (version: string) =>
  `management-center: cliproxyapi ${version} is outside >=8.0.0 <9.0.0`;
const requiring = (min: string, below: string) => (m: Manifest) => {
  Object.assign(requiresOf(m), { min, below });
};

const rangeRows: ReadonlyArray<Row> = [
  ...["7.9.9", "9.0.0", "10.0.0"].map((version) =>
    rule(
      `proxy ${version} is rejected`,
      (m) => {
        withProxyVersion(m, version);
      },
      [outside(version)],
    ),
  ),
  ...["8.0.0", "8.99.99", "8.10.0"].map((version) =>
    rule(
      `proxy ${version} is accepted`,
      (m) => {
        withProxyVersion(m, version);
      },
      [],
    ),
  ),
  rule("min equal to below", requiring("9.0.0", "9.0.0"), [REQUIRES_FORM]),
  rule("min above below", requiring("9.0.0", "8.0.0"), [REQUIRES_FORM]),
  rule("min above below numerically", requiring("10.0.0", "9.0.0"), [REQUIRES_FORM]),
  rule("min that is not x.y.z", requiring("8.0", "9.0.0"), [REQUIRES_FORM]),
  rule("below that is not x.y.z", requiring("8.0.0", "9"), [REQUIRES_FORM]),
  rule(
    "the bound check is skipped when requires is invalid",
    (m) => {
      withProxyVersion(m, "7.9.9");
      requiring("8.0", "9.0.0")(m);
    },
    [REQUIRES_FORM],
  ),
  ...["latest", "8.0"].map((version) =>
    rule(
      `the bound check is skipped when the proxy version is ${version}`,
      (m) => {
        withProxyVersion(m, version);
      },
      [`cliproxyapi: version ${version} is not an exact x.y.z`],
    ),
  ),
];

it.effect.each(rangeRows)("requires: $name", ({ text, expected }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(vendorProblems(text), expected);
  }),
);

it.effect.each([
  {
    name: "proxy asset",
    component: "cliproxyapi",
    version: "8.0.78",
    url: proxyUrl,
    expected: "cliproxyapi-8.0.78/CLIProxyAPI_8.0.78_windows_amd64.zip",
  },
  {
    name: "console asset",
    component: "management-center",
    version: "1.28.3",
    url: at(center.assets, 0).url,
    expected: "management-center-1.28.3/management.html",
  },
  {
    name: "licence",
    component: "cliproxyapi",
    version: "8.0.78",
    url: null,
    expected: "cliproxyapi-8.0.78/LICENSE",
  },
])(
  "assetFile names the $name from the manifest with a forward slash",
  ({ component, version, url, expected }) =>
    Effect.sync(() => {
      assert.strictEqual(assetFile(component, version, url), expected);
    }),
);

// r10c V5: only win32 has network and device paths; they start with two separators.
const networkPathCases = [
  ...[
    "\\\\localhost\\C$\\x",
    "\\\\127.0.0.1\\C$\\x",
    "\\\\?\\UNC\\localhost\\C$\\x",
    "//localhost/C$/x",
    "\\/localhost\\x",
    "\\\\?\\C:\\x",
    "\\\\.\\pipe\\x",
  ].flatMap((folder) => [
    { name: `win32 ${JSON.stringify(folder)}`, platform: "win32", folder, expected: true },
    { name: `linux ${JSON.stringify(folder)}`, platform: "linux", folder, expected: false },
    { name: `darwin ${JSON.stringify(folder)}`, platform: "darwin", folder, expected: false },
  ]),
  ...["C:\\x", "\\x", "/x", "x", "", "C://x", " \\\\x"].flatMap((folder) =>
    ["win32", "linux", "darwin"].map((platform) => ({
      name: `${platform} ${JSON.stringify(folder)}`,
      platform,
      folder,
      expected: false,
    })),
  ),
];

it.effect.each(networkPathCases)("r10c V5 isNetworkPath: $name", ({ folder, platform, expected }) =>
  Effect.sync(() => {
    assert.strictEqual(isNetworkPath(folder, platform), expected);
  }),
);

// T8
const withThrowingFetch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = globalThis.fetch;
      globalThis.fetch = () => {
        throw new Error("the network was used");
      };
      return original;
    }),
    () => effect,
    (original) =>
      Effect.sync(() => {
        globalThis.fetch = original;
      }),
  );

const pinnedLines = expectedFiles.map((entry, index) => {
  const pinnedEntry = at(entriesOf(pinned), index);
  return `pinned ${entry.label} ${pinnedEntry.bytes} ${pinnedEntry.sha256}`;
});

it.layer(NodeServices.layer)("check and status without a folder", (it) => {
  it.effect("complete without touching the network", () =>
    withThrowingFetch(
      Effect.gen(function* () {
        assert.deepStrictEqual(checkVendor(committedText), {
          exitCode: 0,
          stdout: ["ok cliproxyapi 8.0.78", "ok management-center 1.28.3"],
          stderr: [],
        });
        assert.deepStrictEqual(checkVendor(null), {
          exitCode: 1,
          stdout: [],
          stderr: ["invalid manifest: cannot be read"],
        });
        assert.deepStrictEqual(yield* statusVendor({ manifestText: committedText, dir: null }), {
          exitCode: 0,
          stdout: pinnedLines,
          stderr: [],
        });
      }),
    ),
  );

  it.effect("check lists every problem on stderr, sorted, and nothing on stdout", () =>
    Effect.sync(() => {
      const text = edit((m) => {
        proxyOf(m).license.id = "MIT-0";
        centerOf(m).requires = null;
      });
      assert.deepStrictEqual(checkVendor(text), {
        exitCode: 1,
        stdout: [],
        stderr: [
          "invalid cliproxyapi/license: id MIT-0 is not allowed",
          "invalid management-center: requires is missing",
        ],
      });
    }),
  );

  it.effect("status with an invalid manifest prints the invalid lines whatever --dir says", () =>
    Effect.gen(function* () {
      const expected: Report = {
        exitCode: 1,
        stdout: [],
        stderr: ["invalid manifest: cannot be read"],
      };
      assert.deepStrictEqual(yield* statusVendor({ manifestText: null, dir: null }), expected);
      assert.deepStrictEqual(
        yield* statusVendor({ manifestText: null, dir: "somewhere" }),
        expected,
      );
    }),
  );
});

interface Reply {
  status: number;
  location: string | null;
  body: Uint8Array;
}
type Route = (url: string, request: number) => Effect.Effect<Reply, Error>;

const reply = (body: Uint8Array): Reply => ({ status: 200, location: null, body });
const redirect = (status: number, location: string | null): Reply => ({
  status,
  location,
  body: new Uint8Array(0),
});
const bare = (status: number): Reply => redirect(status, null);
const serve: Route = (url) => {
  const body = served.get(url);
  return body === undefined
    ? Effect.fail(new Error(`unexpected request ${url}`))
    : Effect.succeed(reply(body));
};
const recorder = (route: Route) => {
  const requests: Array<string> = [];
  const download: Download = (url) =>
    Effect.suspend(() => {
      requests.push(url);
      return route(url, requests.length);
    });
  return { download, requests };
};
const scripted =
  (script: ReadonlyArray<Reply | Error>): Route =>
  (url, request) => {
    const step = script[request - 1];
    if (step === undefined) return serve(url, request);
    return step instanceof Error ? Effect.fail(step) : Effect.succeed(step);
  };

const makeWorld = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "factory-vendor-" }));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  for (const folder of [
    repo,
    `${repo}-copy`,
    path.join(home, ".t3", "userdata"),
    path.join(home, ".t3factory"),
    path.join(home, ".t3factory-v2"),
    path.join(home, ".t3x"),
  ]) {
    yield* fs.makeDirectory(folder, { recursive: true });
  }
  yield* fs.writeFileString(path.join(root, "afile"), "x");
  return { fs, path, root, repo, home };
});
type World = Effect.Success<typeof makeWorld>;

interface FetchOptions {
  route?: Route;
  manifestText?: string | null;
  repoRoot?: string;
  home?: string;
}
interface FetchResult {
  report: Report;
  requests: ReadonlyArray<string>;
}
const fetchInto = (
  world: World,
  dir: string,
  options: FetchOptions = {},
): Effect.Effect<FetchResult, never, FileSystem.FileSystem | Path.Path> =>
  Effect.suspend(() => {
    const { download, requests } = recorder(options.route ?? serve);
    return fetchVendor({
      manifestText: options.manifestText === undefined ? fixtureText : options.manifestText,
      dir,
      download,
      repoRoot: options.repoRoot ?? world.repo,
      home: options.home ?? world.home,
    }).pipe(Effect.map((report) => ({ report, requests })));
  });

interface Lines {
  exitCode: number;
  stdout: ReadonlyArray<string>;
  stderr: ReadonlyArray<string>;
}
const normalized = (report: Report): Lines => ({
  exitCode: report.exitCode,
  stdout: report.stdout.map(unslash),
  stderr: report.stderr.map(unslash),
});
const refused = (text: string): Lines => ({
  exitCode: 1,
  stdout: [],
  stderr: [unslash(`refused: ${text}`)],
});
const snapshot = (world: World, dir: string = world.root) =>
  world.fs
    .readDirectory(dir, { recursive: true })
    .pipe(Effect.map((entries) => sorted(entries.map(unslash))));
const link = (target: string, linkPath: string) =>
  Effect.promise(() => NodeFSP.symlink(target, linkPath, "junction"));

it.layer(NodeServices.layer)("fetch", (it) => {
  // T9
  it.effect("creates the folder, both component folders and the 8 files, and nothing else", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(vendorProblems(fixtureText), []);
      const world = yield* makeWorld;
      const { fs, path, root } = world;
      const folder = path.join(root, "download");
      const { report, requests } = yield* fetchInto(world, folder);
      assert.deepStrictEqual(report, { exitCode: 0, stdout: fetchedLines, stderr: [] });
      assert.deepStrictEqual(
        requests,
        expectedFiles.map((entry) => entry.url),
      );
      assert.deepStrictEqual(yield* snapshot(world, folder), downloadedListing);
      for (const [index, entry] of expectedFiles.entries()) {
        const file = path.join(folder, entry.file);
        assert.strictEqual(sha256Hex(yield* fs.readFile(file)), sha256Hex(at(bodies, index)));
        if (hasModeBits) assert.strictEqual((yield* fs.stat(file)).mode & 0o111, 0);
      }
    }),
  );

  // T10
  const damages = [2, 7].flatMap((index) => [
    {
      name: "one byte short",
      index,
      tamper: (body: Uint8Array) => body.slice(0, body.length - 1),
      detail: (good: Uint8Array, bad: Uint8Array) =>
        `expected ${good.length} bytes, got ${bad.length}`,
    },
    {
      name: "one byte long",
      index,
      tamper: (body: Uint8Array) => new Uint8Array([...body, 0]),
      detail: (good: Uint8Array, bad: Uint8Array) =>
        `expected ${good.length} bytes, got ${bad.length}`,
    },
    {
      name: "right length, another sha256",
      index,
      tamper: (body: Uint8Array) => Uint8Array.from(body, (byte, i) => (i === 0 ? byte ^ 1 : byte)),
      detail: (good: Uint8Array, bad: Uint8Array) =>
        `sha256 expected ${sha256Hex(good)}, got ${sha256Hex(bad)}`,
    },
  ]);

  it.effect.each(damages)("a body $name at file $index fails and leaves nothing", (damage) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { fs, path, root } = world;
      const folder = path.join(root, "download");
      const entry = at(expectedFiles, damage.index);
      const good = at(bodies, damage.index);
      const before = yield* snapshot(world);
      const route: Route = (url, request) =>
        url === entry.url ? Effect.succeed(reply(damage.tamper(good))) : serve(url, request);
      const { report, requests } = yield* fetchInto(world, folder, { route });
      assert.deepStrictEqual(report, {
        exitCode: 1,
        stdout: [],
        stderr: [`failed ${entry.label}: ${damage.detail(good, damage.tamper(good))}`],
      });
      assert.deepStrictEqual(
        requests,
        expectedFiles.slice(0, damage.index + 1).map((file) => file.url),
      );
      assert.isFalse(yield* fs.exists(folder));
      assert.deepStrictEqual(yield* snapshot(world), before);
    }),
  );

  // T11
  const first = at(expectedFiles, 0);
  const RELEASE_HOST = "https://release-assets.githubusercontent.com";
  const followed = [
    ...[302, 301, 303, 307, 308].map((status) => ({
      name: `${status} to the release host`,
      status,
      location: `${RELEASE_HOST}/x`,
      next: `${RELEASE_HOST}/x`,
    })),
    {
      name: "302 to the raw host",
      status: 302,
      location: "https://raw.githubusercontent.com/x",
      next: "https://raw.githubusercontent.com/x",
    },
    { name: "302 to a relative path", status: 302, location: "/x", next: "https://github.com/x" },
    {
      name: "302 to an explicit port 443",
      status: 302,
      location: "https://github.com:443/x",
      next: "https://github.com/x",
    },
  ];

  it.effect.each(followed)("follows a $name and still writes the manifest's file name", (hop) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const folder = world.path.join(world.root, "download");
      const route: Route = (url, request) =>
        url === first.url
          ? Effect.succeed(redirect(hop.status, hop.location))
          : url === hop.next
            ? Effect.succeed(reply(at(bodies, 0)))
            : serve(url, request);
      const { report, requests } = yield* fetchInto(world, folder, { route });
      assert.deepStrictEqual(report, { exitCode: 0, stdout: fetchedLines, stderr: [] });
      assert.deepStrictEqual(requests, [
        first.url,
        hop.next,
        ...expectedFiles.slice(1).map((entry) => entry.url),
      ]);
      assert.deepStrictEqual(yield* snapshot(world, folder), downloadedListing);
    }),
  );

  it.effect("follows three redirects in a row", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const folder = world.path.join(world.root, "download");
      const hops = [`${RELEASE_HOST}/a`, `${RELEASE_HOST}/b`, `${RELEASE_HOST}/c`];
      const route: Route = (url, request) =>
        request <= 3
          ? Effect.succeed(redirect(302, at(hops, request - 1)))
          : request === 4
            ? Effect.succeed(reply(at(bodies, 0)))
            : serve(url, request);
      const { report, requests } = yield* fetchInto(world, folder, { route });
      assert.deepStrictEqual(report, { exitCode: 0, stdout: fetchedLines, stderr: [] });
      assert.deepStrictEqual(requests.slice(0, 4), [first.url, ...hops]);
    }),
  );

  const a = `${RELEASE_HOST}/a`;
  const b = `${RELEASE_HOST}/b`;
  const c = `${RELEASE_HOST}/c`;
  const stops = [
    {
      name: "a fourth hop",
      script: [
        redirect(302, a),
        redirect(302, b),
        redirect(302, c),
        redirect(302, `${RELEASE_HOST}/d`),
      ],
      line: "more than 3 redirects",
      requested: [first.url, a, b, c],
    },
    {
      name: "a missing location",
      script: [redirect(302, null)],
      line: "redirect without location",
      requested: [first.url],
    },
    {
      name: "a malformed location",
      script: [redirect(302, "https://exa mple.com/x")],
      line: "redirect invalid location",
      requested: [first.url],
    },
    {
      name: "a redirect to http",
      script: [redirect(302, "http://github.com/x")],
      line: "redirect is not https",
      requested: [first.url],
    },
    {
      name: "a redirect with userinfo",
      script: [redirect(302, "https://user@github.com/x")],
      line: "redirect has credentials",
      requested: [first.url],
    },
    {
      name: "a redirect to port 8443",
      script: [redirect(302, "https://github.com:8443/x")],
      line: "redirect has a port",
      requested: [first.url],
    },
    {
      name: "a redirect to evil.example",
      script: [redirect(302, "https://evil.example/x")],
      line: "redirect to evil.example is not allowed",
      requested: [first.url],
    },
    {
      name: "a redirect to a host that is not listed",
      script: [redirect(302, "https://objects.githubusercontent.com/x")],
      line: "redirect to objects.githubusercontent.com is not allowed",
      requested: [first.url],
    },
    {
      name: "http before credentials, port and host",
      script: [redirect(302, "http://user@evil.example:8443/x")],
      line: "redirect is not https",
      requested: [first.url],
    },
    {
      name: "credentials before port and host",
      script: [redirect(302, "https://user@evil.example:8443/x")],
      line: "redirect has credentials",
      requested: [first.url],
    },
    {
      name: "port before host",
      script: [redirect(302, "https://evil.example:8443/x")],
      line: "redirect has a port",
      requested: [first.url],
    },
    {
      name: "a bad location on the second hop",
      script: [redirect(302, a), redirect(302, "http://github.com/x")],
      line: "redirect is not https",
      requested: [first.url, a],
    },
    {
      name: "a 404",
      script: [bare(404)],
      line: "status 404",
      requested: [first.url],
    },
    {
      name: "a 404 after a redirect",
      script: [redirect(302, a), bare(404)],
      line: "status 404",
      requested: [first.url, a],
    },
    {
      name: "a 300",
      script: [redirect(300, a)],
      line: "status 300",
      requested: [first.url],
    },
    {
      name: "a 304",
      script: [bare(304)],
      line: "status 304",
      requested: [first.url],
    },
    {
      name: "a failed download",
      script: [new Error("boom")],
      line: "network boom",
      requested: [first.url],
    },
  ];

  it.effect.each(stops)("stops at $name with its exact line", (stop) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { fs, path, root } = world;
      const folder = path.join(root, "download");
      const before = yield* snapshot(world);
      const { report, requests } = yield* fetchInto(world, folder, {
        route: scripted(stop.script),
      });
      assert.deepStrictEqual(report, {
        exitCode: 1,
        stdout: [],
        stderr: [`failed ${first.label}: ${stop.line}`],
      });
      assert.deepStrictEqual(requests, stop.requested);
      assert.isFalse(yield* fs.exists(folder));
      assert.deepStrictEqual(yield* snapshot(world), before);
    }),
  );

  // T12
  const invalidRows = [
    {
      name: "a floating version",
      text: edit((m) => {
        proxyOf(m).version = "latest";
      }),
      dir: (world: World) => world.path.join(world.root, "download"),
      lines: ["invalid cliproxyapi: version latest is not an exact x.y.z"],
    },
    {
      name: "an unreadable file",
      text: null,
      dir: (world: World) => world.path.join(world.root, "download"),
      lines: ["invalid manifest: cannot be read"],
    },
    {
      name: "two problems",
      text: edit((m) => {
        proxyOf(m).license.id = "MIT-0";
        centerOf(m).requires = null;
      }),
      dir: (world: World) => world.path.join(world.root, "download"),
      lines: [
        "invalid cliproxyapi/license: id MIT-0 is not allowed",
        "invalid management-center: requires is missing",
      ],
    },
    {
      name: "a folder that would be refused",
      text: null,
      dir: (world: World) => world.repo,
      lines: ["invalid manifest: cannot be read"],
    },
  ];

  it.effect.each(invalidRows)("$name requests nothing and creates nothing", (row) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const before = yield* snapshot(world);
      const { report, requests } = yield* fetchInto(world, row.dir(world), {
        manifestText: row.text,
      });
      assert.deepStrictEqual(report, { exitCode: 1, stdout: [], stderr: row.lines });
      assert.deepStrictEqual(requests, []);
      assert.deepStrictEqual(yield* snapshot(world), before);
    }),
  );

  // T13
  const refusals = [
    {
      name: "the checkout root",
      dir: (w: World) => w.repo,
      line: (w: World) => `${w.repo} is inside the repository`,
    },
    {
      name: "a child of the checkout",
      dir: (w: World) => w.path.join(w.repo, "dl"),
      line: (w: World) => `${w.path.join(w.repo, "dl")} is inside the repository`,
    },
    {
      name: "<repo>/../<repo name>/x",
      dir: (w: World) => `${w.repo}${w.path.sep}..${w.path.sep}repo${w.path.sep}x`,
      line: (w: World) => `${w.path.join(w.repo, "x")} is inside the repository`,
    },
    {
      name: "a path that only reaches the checkout through ..",
      dir: (w: World) =>
        `${w.root}${w.path.sep}elsewhere${w.path.sep}..${w.path.sep}repo${w.path.sep}x`,
      line: (w: World) => `${w.path.join(w.repo, "x")} is inside the repository`,
    },
    {
      name: "<home>/.t3",
      dir: (w: World) => w.path.join(w.home, ".t3"),
      line: (w: World) => `${w.path.join(w.home, ".t3")} is inside ~/.t3`,
    },
    {
      name: "<home>/.t3/userdata/x",
      dir: (w: World) => w.path.join(w.home, ".t3", "userdata", "x"),
      line: (w: World) => `${w.path.join(w.home, ".t3", "userdata", "x")} is inside ~/.t3`,
    },
    {
      name: "<home>/.t3factory itself, not ~/.t3",
      dir: (w: World) => w.path.join(w.home, ".t3factory"),
      line: (w: World) => `${w.path.join(w.home, ".t3factory")} is inside ~/.t3factory`,
    },
    {
      name: "<home>/.t3factory/x",
      dir: (w: World) => w.path.join(w.home, ".t3factory", "x"),
      line: (w: World) => `${w.path.join(w.home, ".t3factory", "x")} is inside ~/.t3factory`,
    },
    {
      name: "a missing parent",
      dir: (w: World) => w.path.join(w.root, "missing", "dl"),
      line: (w: World) => `${w.path.join(w.root, "missing")} is not an existing directory`,
    },
    {
      name: "a parent that is a file",
      dir: (w: World) => w.path.join(w.root, "afile", "dl"),
      line: (w: World) => `${w.path.join(w.root, "afile")} is not an existing directory`,
    },
  ];

  it.effect.each(refusals)("refuses $name and creates nothing", (row) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const before = yield* snapshot(world);
      const { report, requests } = yield* fetchInto(world, row.dir(world));
      assert.deepStrictEqual(normalized(report), refused(row.line(world)));
      assert.deepStrictEqual(requests, []);
      assert.deepStrictEqual(yield* snapshot(world), before);
    }),
  );

  it.effect.skipIf(platform !== "win32")(
    "r10c V5 refuses the administrative-share spelling of a new folder",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const { fs, path, root } = world;
        const local = path.join(root, "download");
        // C:\Temp\x\download becomes \\localhost\C$\Temp\x\download: the same folder over the share.
        const dir = `\\\\localhost\\${local.charAt(0)}$\\${local.slice(3)}`;
        const before = yield* snapshot(world);
        const { report, requests } = yield* fetchInto(world, dir);
        assert.deepStrictEqual(normalized(report), refused(`${dir} is a network or device path`));
        assert.deepStrictEqual(requests, []);
        assert.isFalse(yield* fs.exists(local));
        assert.deepStrictEqual(yield* snapshot(world), before);
      }),
  );

  it.effect.skipIf(!linksSupported)("refuses a folder reached through a link into ~/.t3", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { path, root, home } = world;
      const via = path.join(root, "via");
      yield* link(path.join(home, ".t3"), via);
      const before = yield* snapshot(world);
      const { report, requests } = yield* fetchInto(world, path.join(via, "dl"));
      // The message names either the real folder or the argument's resolved path; V5 words both.
      const lines = [
        unslash(`refused: ${path.join(home, ".t3", "dl")} is inside ~/.t3`),
        unslash(`refused: ${path.join(via, "dl")} is inside ~/.t3`),
      ];
      assert.strictEqual(report.exitCode, 1);
      assert.deepStrictEqual(report.stdout, []);
      assert.lengthOf(report.stderr, 1);
      assert.include(lines, unslash(report.stderr[0] ?? ""));
      assert.deepStrictEqual(requests, []);
      assert.deepStrictEqual(yield* snapshot(world), before);
    }),
  );

  const otherCase = [
    {
      name: "a checkout root written in upper case",
      dir: (w: World) => w.path.join(w.repo, "dl"),
      options: (w: World): FetchOptions => ({ repoRoot: w.path.join(w.root, "REPO") }),
      line: (w: World) => `${w.path.join(w.repo, "dl")} is inside the repository`,
    },
    {
      name: "a folder written in upper case under the checkout",
      dir: (w: World) => w.path.join(w.root, "REPO", "dl"),
      options: (): FetchOptions => ({}),
      line: (w: World) => `${w.path.join(w.repo, "dl")} is inside the repository`,
    },
    {
      name: "a home written in upper case",
      dir: (w: World) => w.path.join(w.home, ".t3", "dl"),
      options: (w: World): FetchOptions => ({ home: w.path.join(w.root, "HOME") }),
      line: (w: World) => `${w.path.join(w.home, ".t3", "dl")} is inside ~/.t3`,
    },
    {
      name: "a folder written in upper case under ~/.t3factory",
      dir: (w: World) => w.path.join(w.home, ".T3FACTORY", "dl"),
      options: (): FetchOptions => ({}),
      line: (w: World) => `${w.path.join(w.home, ".t3factory", "dl")} is inside ~/.t3factory`,
    },
  ];

  it.effect.skipIf(!foldsCase)("refuses roots and folders written in another letter case", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const before = yield* snapshot(world);
      for (const row of otherCase) {
        const { report, requests } = yield* fetchInto(world, row.dir(world), row.options(world));
        const actual = normalized(report);
        const expected = refused(row.line(world));
        // realPath may report the folder in either case, so the line is compared lower-cased.
        assert.strictEqual(actual.exitCode, expected.exitCode, row.name);
        assert.deepStrictEqual(actual.stdout, expected.stdout, row.name);
        assert.deepStrictEqual(
          actual.stderr.map((line) => line.toLowerCase()),
          expected.stderr.map((line) => line.toLowerCase()),
          row.name,
        );
        assert.deepStrictEqual(requests, [], row.name);
      }
      assert.deepStrictEqual(yield* snapshot(world), before);
    }),
  );

  const accepted = [
    {
      name: "<home>/.t3factory-v2/dl",
      dir: (w: World) => w.path.join(w.home, ".t3factory-v2", "dl"),
    },
    { name: "<home>/.t3x/dl", dir: (w: World) => w.path.join(w.home, ".t3x", "dl") },
    { name: "<repo>-copy/dl", dir: (w: World) => `${w.repo}-copy${w.path.sep}dl` },
    { name: "a plain sibling of the checkout", dir: (w: World) => w.path.join(w.root, "dl") },
  ];

  it.effect.each(accepted)("accepts $name", (row) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const folder = row.dir(world);
      const { report, requests } = yield* fetchInto(world, folder);
      assert.deepStrictEqual(report, { exitCode: 0, stdout: fetchedLines, stderr: [] });
      assert.lengthOf(requests, 8);
      assert.deepStrictEqual(yield* snapshot(world, folder), downloadedListing);
    }),
  );

  // T14
  const occupied = [
    {
      name: "an empty folder",
      make: (w: World, target: string) => w.fs.makeDirectory(target),
    },
    {
      name: "a non-empty folder",
      make: (w: World, target: string) =>
        w.fs
          .makeDirectory(target)
          .pipe(Effect.andThen(w.fs.writeFileString(w.path.join(target, "keep.txt"), "keep"))),
    },
    {
      name: "a file",
      make: (w: World, target: string) => w.fs.writeFileString(target, "keep"),
    },
  ];

  it.effect.each(occupied)("refuses $name that already exists and changes nothing", (row) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const target = world.path.join(world.root, "taken");
      yield* row.make(world, target);
      const before = yield* snapshot(world);
      const { report, requests } = yield* fetchInto(world, target);
      assert.deepStrictEqual(normalized(report), refused(`${target} already exists`));
      assert.deepStrictEqual(requests, []);
      assert.deepStrictEqual(yield* snapshot(world), before);
    }),
  );

  it.effect.skipIf(!linksSupported)("refuses links as links without following them", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { fs, path, root, home } = world;
      const existing = path.join(root, "existing");
      const nowhere = path.join(root, "nowhere");
      yield* fs.makeDirectory(existing);
      const links = [
        { name: "link-to-folder", target: existing },
        { name: "link-to-t3", target: path.join(home, ".t3") },
        { name: "dangling", target: nowhere },
      ];
      for (const entry of links) yield* link(entry.target, path.join(root, entry.name));
      const before = yield* snapshot(world);
      for (const entry of links) {
        const dir = path.join(root, entry.name);
        const { report, requests } = yield* fetchInto(world, dir);
        assert.deepStrictEqual(normalized(report), refused(`${dir} already exists`), entry.name);
        assert.deepStrictEqual(requests, [], entry.name);
      }
      assert.deepStrictEqual(yield* snapshot(world), before);
      assert.isFalse(yield* fs.exists(nowhere));
    }),
  );

  // T15
  it.effect("never overwrites a file that appeared during the run and reports what it left", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { fs, path, root } = world;
      const folder = path.join(root, "download");
      const foreign = at(expectedFiles, 3);
      const foreignPath = path.join(folder, foreign.file);
      const route: Route = (url, request) =>
        url === at(expectedFiles, 1).url
          ? fs.writeFileString(foreignPath, "foreign").pipe(
              Effect.mapError((error) => new Error(error.message)),
              Effect.andThen(serve(url, request)),
            )
          : serve(url, request);
      const { report, requests } = yield* fetchInto(world, folder, { route });
      assert.strictEqual(report.exitCode, 1);
      assert.deepStrictEqual(report.stdout, []);
      // V4 words the failing path loosely, so the line is matched on its parts.
      assert.lengthOf(report.stderr, 3);
      const failure = report.stderr[0] ?? "";
      assert.isTrue(failure.startsWith("failed "));
      assert.include(failure, ": filesystem ");
      assert.include(failure, "CLIProxyAPI_8.0.78_linux_amd64.tar.gz");
      // Reverse creation order: the component folder, then the target, both kept by the foreign file.
      assert.deepStrictEqual(report.stderr.slice(1).map(unslash), [
        unslash(`cleanup failed ${path.join(folder, "cliproxyapi-8.0.78")}`),
        unslash(`cleanup failed ${folder}`),
      ]);
      assert.deepStrictEqual(
        requests,
        expectedFiles.slice(0, 4).map((entry) => entry.url),
      );
      assert.strictEqual(yield* fs.readFileString(foreignPath), "foreign");
      assert.deepStrictEqual(yield* snapshot(world, folder), [
        "cliproxyapi-8.0.78",
        "cliproxyapi-8.0.78/CLIProxyAPI_8.0.78_linux_amd64.tar.gz",
      ]);
    }),
  );
});

// T16
it.layer(NodeServices.layer)("status with a folder", (it) => {
  const populate = (world: World, dir: string) =>
    Effect.gen(function* () {
      const { fs, path } = world;
      yield* fs.makeDirectory(dir);
      yield* fs.makeDirectory(path.join(dir, "cliproxyapi-8.0.78"));
      yield* fs.makeDirectory(path.join(dir, "management-center-1.28.3"));
      for (const [index, entry] of expectedFiles.entries()) {
        yield* fs.writeFile(path.join(dir, entry.file), at(bodies, index));
      }
    });
  const statusLines = (states: ReadonlyArray<string>) =>
    expectedFiles.map((entry, index) => `${at(states, index)} ${entry.label} ${entry.file}`);
  const same = expectedFiles.map(() => "same");

  it.effect("prints same for good files and exits 0", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const dir = world.path.join(world.root, "download");
      yield* populate(world, dir);
      assert.deepStrictEqual(yield* statusVendor({ manifestText: fixtureText, dir }), {
        exitCode: 0,
        stdout: statusLines(same),
        stderr: [],
      });
    }),
  );

  it.effect("tells a deleted, truncated, bit-flipped and replaced file apart", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { fs, path } = world;
      const dir = path.join(world.root, "download");
      yield* populate(world, dir);
      const file = (index: number) => path.join(dir, at(expectedFiles, index).file);
      yield* fs.remove(file(0));
      yield* fs.writeFile(file(1), at(bodies, 1).slice(0, -1));
      yield* fs.writeFile(
        file(2),
        Uint8Array.from(at(bodies, 2), (byte, i) => (i === 0 ? byte ^ 1 : byte)),
      );
      yield* fs.remove(file(3));
      yield* fs.makeDirectory(file(3));
      assert.deepStrictEqual(yield* statusVendor({ manifestText: fixtureText, dir }), {
        exitCode: 1,
        stdout: statusLines(["missing", "size", "hash", "not-file", ...same.slice(4)]),
        stderr: [],
      });
    }),
  );

  it.effect.skipIf(!deniedReadsWork)("reports a file it cannot read as unreadable", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { fs, path } = world;
      const dir = path.join(world.root, "download");
      yield* populate(world, dir);
      yield* fs.chmod(path.join(dir, at(expectedFiles, 4).file), 0o000);
      assert.deepStrictEqual(yield* statusVendor({ manifestText: fixtureText, dir }), {
        exitCode: 1,
        stdout: statusLines([...same.slice(0, 4), "unreadable", ...same.slice(5)]),
        stderr: [],
      });
    }),
  );

  it.effect.skipIf(!linksSupported)("reports a link in a file's place as not-file", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { fs, path, root } = world;
      const dir = path.join(root, "download");
      yield* populate(world, dir);
      const licence = path.join(dir, at(expectedFiles, 7).file);
      yield* fs.remove(licence);
      yield* link(world.home, licence);
      assert.deepStrictEqual(yield* statusVendor({ manifestText: fixtureText, dir }), {
        exitCode: 1,
        stdout: statusLines([...same.slice(0, 7), "not-file"]),
        stderr: [],
      });
    }),
  );

  it.effect("reports every file missing for a folder that does not exist", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const dir = world.path.join(world.root, "nothing");
      const missing = expectedFiles.map(() => "missing");
      assert.deepStrictEqual(yield* statusVendor({ manifestText: fixtureText, dir }), {
        exitCode: 1,
        stdout: statusLines(missing),
        stderr: [],
      });
      assert.isFalse(yield* world.fs.exists(dir));
    }),
  );

  it.effect("prints the 8 pinned lines without a folder", () =>
    Effect.gen(function* () {
      assert.lengthOf(pinnedLines, 8);
      assert.deepStrictEqual(yield* statusVendor({ manifestText: committedText, dir: null }), {
        exitCode: 0,
        stdout: pinnedLines,
        stderr: [],
      });
    }),
  );
});

// T17
const chunked = (chunks: ReadonlyArray<Uint8Array>) => {
  const log = { pulls: 0, cancelled: false };
  // A zero high-water mark means the stream is read only when the downloader asks for a chunk.
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[log.pulls];
        log.pulls += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        log.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, log };
};

const stubTransport = (respond: () => Response | Promise<Response>) => {
  const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
  const transport = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(respond());
  };
  return { transport, calls };
};

it.effect("download calls the transport once with only method, redirect and the user agent", () =>
  Effect.gen(function* () {
    const { stream, log } = chunked([Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5, 6, 7, 8)]);
    const { transport, calls } = stubTransport(() => new Response(stream, { status: 200 }));
    // The body is exactly maxBytes (4 + 4), which is within the limit.
    const result = yield* makeDownload({ transport, maxBytes: 8 })("https://github.com/a");
    assert.deepStrictEqual(calls, [
      {
        input: "https://github.com/a",
        init: { method: "GET", redirect: "manual", headers: { "User-Agent": "factory-vendor/1" } },
      },
    ]);
    assert.deepStrictEqual(
      { ...result, body: Array.from(result.body) },
      { status: 200, location: null, body: [1, 2, 3, 4, 5, 6, 7, 8] },
    );
    assert.isFalse(log.cancelled);
  }),
);

it.effect.each([
  {
    name: "chunks crossing the limit on the third",
    sizes: [4, 4, 4, 4, 4],
    maxBytes: 10,
    pulls: 3,
  },
  { name: "a first chunk over the limit", sizes: [12, 4], maxBytes: 10, pulls: 1 },
  // 5 + 5 reaches the limit exactly; only the third chunk (one byte) crosses it.
  { name: "a body one byte over the limit", sizes: [5, 5, 1], maxBytes: 10, pulls: 3 },
])("download cancels a stream larger than maxBytes: $name", ({ sizes, maxBytes, pulls }) =>
  Effect.gen(function* () {
    const { stream, log } = chunked(sizes.map((size) => new Uint8Array(size)));
    const { transport, calls } = stubTransport(() => new Response(stream, { status: 200 }));
    const error = yield* Effect.flip(
      makeDownload({ transport, maxBytes })("https://github.com/big"),
    );
    assert.strictEqual(error.message, `body exceeds ${maxBytes} bytes`);
    assert.lengthOf(calls, 1);
    assert.strictEqual(log.pulls, pulls);
    assert.isTrue(log.cancelled);
  }),
);

it.effect.each([
  { name: "404", status: 404, headers: {}, location: null },
  {
    name: "302",
    status: 302,
    headers: { location: "https://release-assets.githubusercontent.com/x" },
    location: "https://release-assets.githubusercontent.com/x",
  },
])("download cancels the body of a $name response without reading it", (row) =>
  Effect.gen(function* () {
    const { stream, log } = chunked([Uint8Array.of(1, 2, 3)]);
    const { transport, calls } = stubTransport(
      () => new Response(stream, { status: row.status, headers: row.headers }),
    );
    const result = yield* makeDownload({ transport, maxBytes: 8 })("https://github.com/a");
    assert.lengthOf(calls, 1);
    assert.deepStrictEqual(
      { ...result, body: Array.from(result.body) },
      { status: row.status, location: row.location, body: [] },
    );
    assert.strictEqual(log.pulls, 0);
    assert.isTrue(log.cancelled);
  }),
);

it.effect("download fails with an Error when the transport rejects", () =>
  Effect.gen(function* () {
    const { transport, calls } = stubTransport(() => Promise.reject(new Error("boom")));
    const error = yield* Effect.flip(
      makeDownload({ transport, maxBytes: 8 })("https://github.com/a"),
    );
    assert.instanceOf(error, Error);
    assert.include(error.message, "boom");
    assert.lengthOf(calls, 1);
  }),
);
