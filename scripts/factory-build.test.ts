// @effect-diagnostics nodeBuiltinImport:off - Builds ZIP fixtures shaped like GitHub artifact downloads.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CHECK_JOB_NAMES,
  evaluateBuild,
  evaluateValidationRun,
  protocolHandlerRestoreSteps,
  readZipEntries,
  regQueryListsSubkey,
  reusesResourceMonitor,
  validatePackageReceipt,
  windowsSmokeEnvironment,
  type ValidationRequest,
} from "./factory-build.ts";
import { CHECK_LANES } from "./factory-check.ts";
import { cleanupSmokeDirectory } from "./desktop-smoke-cleanup.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

const repository = "owner/factory";
const candidateSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const controlSha = "c".repeat(40);
const toolchain = { node: "26.12.1", pnpm: "12.14.0" };
const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

function zip(entries: Record<string, string | Buffer>) {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const compressed = NodeZlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, compressed);
    directory.push(central, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}

const prerequisites = {
  msvcToolset: "14.44.35207",
  spectreLibraries: true,
  windowsSdk: "10.0.26100.0",
  rustc: "rustc 1.96.0 (ac68faa20 2026-05-25)",
  rustTarget: "x86_64-pc-windows-msvc",
  rustTargetInstalled: true,
  python: "Python 3.12.10",
  reuseResourceMonitor: false,
};
const packageFile = { file: "T3Factory-0.1.5-x64.zip", bytes: 1234, sha256: "d".repeat(64) };
const output = { exitCode: 0, durationMs: 1000, outputBytes: 10, outputSha256: "e".repeat(64) };
const packageCommand = {
  kind: "package",
  argv: [
    "vp",
    "run",
    "dist:desktop:artifact",
    "--distribution",
    "factory-preview",
    "--output-dir",
    "C:\\evidence\\package",
  ],
  ...output,
};
const smokeCommand = {
  kind: "smoke",
  argv: [
    "node",
    "scripts/factory-build.ts",
    "smoke",
    "--package",
    `C:\\evidence\\package\\${packageFile.file}`,
    "--sha256",
    packageFile.sha256,
  ],
  ...output,
};
const checkCommand = {
  kind: "check-changed",
  argv: ["vp", "run", "check:changed", baseSha],
  ...output,
};
const testCommand = {
  kind: "test",
  argv: ["vp", "test", "run", "scripts/factory-build.test.ts"],
  ...output,
};

function packageReceipt(overrides: Record<string, unknown> = {}) {
  return {
    schema: "t3factory.local-package/v1",
    evidence: "dispatcher-declared",
    repository,
    candidateSha,
    baseSha,
    worktreeClean: true,
    toolchain,
    platform: { os: "win32", arch: "x64", release: "10.0.22631" },
    windowsPrerequisites: prerequisites,
    recordedAt: "2026-11-01T22:00:00.000Z",
    commands: [checkCommand, testCommand, packageCommand, smokeCommand],
    package: packageFile,
    ...overrides,
  };
}

const expected = { repository, candidateSha, baseSha, toolchain };

describe("validatePackageReceipt", () => {
  it("accepts a Windows x64 receipt that packaged and smoked the candidate with full prerequisites", () => {
    const bytes = encode(packageReceipt());
    expect(validatePackageReceipt(bytes, digest(bytes), expected).errors).toEqual([]);
  });

  it.each([
    ["another candidate", packageReceipt({ candidateSha: "f".repeat(40) }), "receipt candidate"],
    [
      "a toolset without Spectre libraries",
      packageReceipt({ windowsPrerequisites: { ...prerequisites, spectreLibraries: false } }),
      "no x64 Spectre-mitigated libraries",
    ],
    [
      "a reused resource monitor",
      packageReceipt({ windowsPrerequisites: { ...prerequisites, reuseResourceMonitor: true } }),
      "the resource monitor was reused",
    ],
    [
      "no recorded prerequisites",
      packageReceipt({ windowsPrerequisites: null }),
      "were not recorded",
    ],
    [
      "a Linux host",
      packageReceipt({ platform: { os: "linux", arch: "x64", release: "6" } }),
      "Windows x64",
    ],
    [
      "a failed smoke",
      packageReceipt({
        commands: [checkCommand, testCommand, packageCommand, { ...smokeCommand, exitCode: 1 }],
      }),
      "(smoke) did not pass",
    ],
    [
      "a smoke of another ZIP",
      packageReceipt({
        commands: [
          checkCommand,
          testCommand,
          packageCommand,
          { ...smokeCommand, argv: [...smokeCommand.argv.slice(0, -1), "0".repeat(64)] },
        ],
      }),
      "must smoke the recorded package",
    ],
    [
      "a smoke before packaging",
      packageReceipt({ commands: [checkCommand, testCommand, smokeCommand, packageCommand] }),
      "smokes before it packages",
    ],
    [
      "a package reusing earlier bundles",
      packageReceipt({
        commands: [
          checkCommand,
          testCommand,
          { ...packageCommand, argv: [...packageCommand.argv, "--skip-build"] },
          smokeCommand,
        ],
      }),
      "must not pass --skip-build",
    ],
    [
      "an upstream identity",
      packageReceipt({
        commands: [
          checkCommand,
          testCommand,
          { ...packageCommand, argv: packageCommand.argv.with(4, "t3code") },
          smokeCommand,
        ],
      }),
      "--distribution factory-preview",
    ],
    [
      "no smoke",
      packageReceipt({ commands: [checkCommand, testCommand, packageCommand] }),
      "no smoke command",
    ],
    [
      "an installer instead of the ZIP",
      packageReceipt({ package: { ...packageFile, file: "T3Factory-0.1.5-x64.exe" } }),
      "is not a T3Factory Windows x64 ZIP",
    ],
    ["a claim of attestation", packageReceipt({ evidence: "attested" }), "dispatcher-declared"],
  ])("rejects %s", (_name, value, message) => {
    const bytes = encode(value);
    const result = validatePackageReceipt(bytes, digest(bytes), expected);
    expect(result.receipt).toBeUndefined();
    expect(result.errors.join("\n")).toContain(message);
  });

  it("rejects bytes that do not match the dispatched digest", () => {
    const result = validatePackageReceipt(encode(packageReceipt()), "0".repeat(64), expected);
    expect(result.errors.join("\n")).toContain("does not match");
  });
});

it("isolates the Windows package smoke from the installed profile and inherited runtime overrides", () => {
  const home = NodePath.resolve("smoke-sandbox");
  const env = windowsSmokeEnvironment(
    {
      PATH: "toolchain",
      HOME: "live-home",
      USERPROFILE: "live-profile",
      APPDATA: "live-roaming",
      LOCALAPPDATA: "live-local",
      T3CODE_HOME: "live-state",
      T3CODE_PORT: "1234",
      VITE_DEV_SERVER_URL: "http://live",
      ELECTRON_RUN_AS_NODE: "1",
    },
    home,
  );
  expect(env).toMatchObject({
    PATH: "toolchain",
    HOME: home,
    USERPROFILE: home,
    APPDATA: NodePath.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
  });
  expect(Object.keys(env).filter((key) => /^(T3CODE_|VITE_|ELECTRON_)/i.test(key))).toEqual([]);
});

it("preserves the smoke result when Windows keeps its extracted files locked", () => {
  using _remove = vi.spyOn(NodeFS, "rmSync").mockImplementation(() => {
    throw Object.assign(new Error("file is locked"), { code: "EBUSY" });
  });
  using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(() => cleanupSmokeDirectory("owned-smoke-directory")).not.toThrow();
  const smokeFailure = new Error("seeded thread did not render");
  expect(() => {
    try {
      throw smokeFailure;
    } finally {
      cleanupSmokeDirectory("owned-smoke-directory");
    }
  }).toThrow(smokeFailure);
});

describe("protocolHandlerRestoreSteps", () => {
  const key = "HKCU\\Software\\Classes\\scheme";
  const file = "C:\\smoke\\handler-before.reg";
  const installed = Buffer.from("installed app handler");
  const smoked = Buffer.from("smoke copy handler");
  const remove = ["delete", key, "/f"];
  const restore = ["import", file];

  it.each([
    ["leaves a key the smoke never created absent", null, null, false, []],
    ["deletes a key the smoke created", null, smoked, false, [remove]],
    ["leaves a key the smoke did not change", installed, Buffer.from(installed), false, []],
    ["imports over a key the smoke changed", installed, smoked, false, [restore]],
    ["stops once the import restored the key", installed, Buffer.from(installed), true, []],
    [
      "deletes and re-imports a key the import left different",
      installed,
      smoked,
      true,
      [remove, restore],
    ],
    ["re-imports a key that disappeared", installed, null, false, [restore]],
  ])("%s", (_name, before, current, importTried, steps) => {
    expect(protocolHandlerRestoreSteps({ key, file, before }, current, importTried)).toEqual(steps);
  });
});

describe("regQueryListsSubkey", () => {
  const subkey = (name: string) => `HKEY_CURRENT_USER\\Software\\Classes\\${name}`;
  const listing = (...lines: string[]) =>
    ["", "HKEY_CURRENT_USER\\Software\\Classes", ...lines, ""].join("\n");

  it.each([
    ["lists the subkey", listing(subkey(".html"), subkey("t3factory")), true],
    ["lists only other subkeys", listing(subkey(".html"), subkey("t3code")), false],
    ["lists it in another case", listing(subkey("T3Factory")), true],
    [
      "lists only longer names that hold it",
      listing(subkey("t3factory-dev"), subkey("xt3factory")),
      false,
    ],
    ["names it only as a value", listing("    t3factory    REG_SZ    URL:t3factory"), false],
    ["ends lines with CRLF", listing(subkey("t3factory")).replaceAll("\n", "\r\n"), true],
    ["is empty", "", false],
  ])("when the listing %s", (_name, output, listed) => {
    expect(regQueryListsSubkey(output, "t3factory")).toBe(listed);
  });
});

describe("reusesResourceMonitor", () => {
  it("treats only unset or false values as building the monitor", () => {
    expect([undefined, "", "false", "0", "OFF"].map(reusesResourceMonitor)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(["true", "1", "yes", "maybe"].map(reusesResourceMonitor)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("readZipEntries", () => {
  it("reads deflated entries and rejects a corrupted one", () => {
    const archive = zip({ "a.json": "{}", "b.txt": "hello" });
    expect(
      Object.fromEntries([...readZipEntries(archive)].map(([name, data]) => [name, String(data)])),
    ).toEqual({
      "a.json": "{}",
      "b.txt": "hello",
    });
    const corrupted = Buffer.from(archive);
    corrupted.writeUInt32LE(0, corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16);
    expect(() => readZipEntries(corrupted)).toThrow("corrupt");
  });
});

describe("evaluateValidationRun", () => {
  const checkReceipt = {
    schema: "t3factory.local-evidence/v1",
    evidence: "dispatcher-declared",
    repository,
    candidateSha,
    baseSha,
    worktreeClean: true,
    toolchain,
    platform: { os: "win32", arch: "x64", release: "10.0.22631" },
    recordedAt: "2026-11-01T22:00:00.000Z",
    commands: [
      checkCommand,
      testCommand,
      { kind: "build-desktop", argv: ["vp", "run", "build:desktop"], ...output },
    ],
  };
  const checkReceiptSha = "9".repeat(64);
  const shards = (total: number) =>
    Array.from({ length: total }, (_, index) => ({
      shard: { index: index + 1, total },
      toolchain,
      runner: { os: "Linux" },
    }));
  const checkManifest = {
    schema: "t3factory.check-manifest/v1",
    status: "passed",
    failures: [],
    repository,
    workflow: {
      path: ".github/workflows/factory-check.yml",
      ref: `${repository}/.github/workflows/factory-check.yml@refs/heads/feat/t3factory`,
      sha: controlSha,
    },
    run: {
      id: "555",
      attempt: "2",
      event: "workflow_dispatch",
      dispatchRef: "refs/heads/feat/t3factory",
    },
    candidate: {
      sha: candidateSha,
      ref: "feat/t3factory",
      refKind: "branch",
      refSha: candidateSha,
    },
    baseSha,
    toolchain: { pinned: toolchain },
    lanes: CHECK_LANES.map((name) => ({
      name,
      requested: true,
      result: "success",
      runs: shards(name === "test_server" ? 2 : 1),
    })),
    unsupportedLanes: [],
    localEvidence: {
      evidence: "dispatcher-declared",
      attested: false,
      sha256: checkReceiptSha,
      bytes: 900,
      receipt: checkReceipt,
    },
    artifacts: [{ path: "factory-resolve-a2/receipt.json", bytes: 900, sha256: checkReceiptSha }],
  };

  function fixture(manifestValue: unknown = checkManifest, extra: Record<string, string> = {}) {
    const manifestBytes = encode(manifestValue);
    const artifactZip = zip({
      "factory-check-manifest.json": manifestBytes,
      "factory-check-manifest.json.sha256": `${digest(manifestBytes)}  factory-check-manifest.json\n`,
      ...extra,
    });
    const request: ValidationRequest = {
      repository,
      candidateSha,
      baseSha,
      candidateRef: "feat/t3factory",
      controlSha,
      controlReachable: true,
      dispatchBranch: "feat/t3factory",
      runId: "555",
      runAttempt: "2",
      manifestSha256: digest(manifestBytes),
      toolchain,
    };
    const job = (name: string, id: number) => ({
      id,
      name,
      run_id: 555,
      run_attempt: 2,
      head_sha: controlSha,
      status: "completed",
      conclusion: "success",
    });
    const names = [
      CHECK_JOB_NAMES.resolve,
      ...CHECK_LANES.filter((lane) => lane !== "test_server").map((lane) => CHECK_JOB_NAMES[lane]),
      "Test Server 1",
      "Test Server 2",
      CHECK_JOB_NAMES.check,
    ];
    const jobs = names.map(job);
    const artifact = {
      id: 77,
      name: "factory-check-manifest-a2",
      size_in_bytes: artifactZip.length,
      expired: false,
      digest: `sha256:${digest(artifactZip)}`,
      workflow_run: { id: 555, head_sha: controlSha },
    };
    return {
      request,
      run: {
        id: 555,
        path: ".github/workflows/factory-check.yml",
        event: "workflow_dispatch",
        head_sha: controlSha,
        head_branch: "feat/t3factory",
        run_attempt: 2,
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/owner/factory/actions/runs/555",
        repository: { full_name: repository },
        head_repository: { full_name: repository },
      },
      jobs: { total_count: jobs.length, jobs },
      artifacts: { total_count: 1, artifacts: [artifact] },
      artifactZip,
    };
  }

  it("accepts the current successful attempt with every lane, job and digest bound", () => {
    const result = evaluateValidationRun(fixture());
    expect(result.errors).toEqual([]);
    expect(result.validation).toMatchObject({
      workflow: { sha: controlSha },
      run: { id: "555", attempt: "2" },
      manifest: { artifact: { id: "77", name: "factory-check-manifest-a2" } },
      localEvidence: { sha256: checkReceiptSha, attested: false },
    });
  });

  const base = fixture();
  const withJob = (name: string, change: Record<string, unknown>) => ({
    ...base.jobs,
    jobs: base.jobs.jobs.map((job) => (job.name === name ? { ...job, ...change } : job)),
  });
  const lanes = (change: (lane: { name: string }) => Record<string, unknown>) => ({
    ...checkManifest,
    lanes: checkManifest.lanes.map((lane) => ({ ...lane, ...change(lane) })),
  });
  it.each([
    [
      "a later attempt superseded it",
      { run: { ...base.run, run_attempt: 3 } },
      "is not its current attempt 3",
    ],
    ["the run failed", { run: { ...base.run, conclusion: "failure" } }, "completed/failure"],
    [
      "another workflow ran",
      { run: { ...base.run, path: ".github/workflows/ci.yml" } },
      "ran .github/workflows/ci.yml",
    ],
    [
      "it ran another control revision",
      { run: { ...base.run, head_sha: "1".repeat(40) } },
      "ran control revision",
    ],
    [
      "its control revision is outside this workflow's lineage",
      { request: { ...base.request, controlReachable: false } },
      "is not this workflow's revision or an ancestor",
    ],
    [
      "it ran from an untrusted branch",
      { run: { ...base.run, head_branch: "fork-branch" } },
      "not the trusted feat/t3factory",
    ],
    [
      "it ran from a fork",
      { run: { ...base.run, head_repository: { full_name: "fork/factory" } } },
      "is not a run of",
    ],
    [
      "a lane job failed",
      { jobs: withJob("Lint", { conclusion: "failure" }) },
      "job Lint is completed/failure",
    ],
    [
      "a job is from another attempt",
      { jobs: withJob("Rust", { run_attempt: 1 }) },
      "job Rust belongs to another run, attempt or revision",
    ],
    [
      "a server shard job is missing",
      {
        jobs: {
          total_count: base.jobs.jobs.length - 1,
          jobs: base.jobs.jobs.filter((job) => job.name !== "Test Server 2"),
        },
      },
      "has 0 Test Server 2 jobs",
    ],
    [
      "an unknown job ran",
      {
        jobs: {
          total_count: base.jobs.jobs.length + 1,
          jobs: [...base.jobs.jobs, { ...base.jobs.jobs[0]!, id: 99, name: "Publish" }],
        },
      },
      "unexpected job Publish",
    ],
    [
      "the manifest artifact is ambiguous",
      {
        artifacts: {
          total_count: 2,
          artifacts: [...base.artifacts.artifacts, { ...base.artifacts.artifacts[0]!, id: 78 }],
        },
      },
      "has 2 factory-check-manifest-a2 artifacts",
    ],
    ["the manifest artifact is missing", { artifacts: { total_count: 0, artifacts: [] } }, "has 0"],
    [
      "the manifest artifact expired",
      {
        artifacts: {
          total_count: 1,
          artifacts: [{ ...base.artifacts.artifacts[0]!, expired: true }],
        },
      },
      "has expired",
    ],
    [
      "the download differs from the artifact digest",
      { artifactZip: zip({ "factory-check-manifest.json": "{}" }) },
      "does not match its digest",
    ],
    [
      "the dispatched manifest digest differs",
      { request: { ...base.request, manifestSha256: "0".repeat(64) } },
      `not ${"0".repeat(64)}`,
    ],
  ])("rejects when %s", (_name, override, message) => {
    const result = evaluateValidationRun({ ...base, ...override } as typeof base);
    expect(result.validation).toBeUndefined();
    expect(result.errors.join("\n")).toContain(message);
  });

  it.each([
    [
      "a requested lane was skipped",
      lanes((lane) => (lane.name === "windows" ? { requested: false, result: "skipped" } : {})),
      "required lane windows was not requested",
    ],
    [
      "a lane failed but the manifest claims to pass",
      lanes((lane) => (lane.name === "build" ? { result: "failure" } : {})),
      "required lane build result is failure",
    ],
    [
      "the manifest validated another candidate",
      { ...checkManifest, candidate: { ...checkManifest.candidate, sha: "1".repeat(40) } },
      "validated candidate 1111",
    ],
    [
      "the manifest failed",
      { ...checkManifest, status: "failed", failures: ["lane lint failed"] },
      "did not pass",
    ],
    [
      "a lane ran another Node.js",
      lanes((lane) =>
        lane.name === "test"
          ? {
              runs: [
                { shard: { index: 1, total: 1 }, toolchain: { ...toolchain, node: "24.13.1" } },
              ],
            }
          : {},
      ),
      "lane test ran another toolchain",
    ],
    [
      "the local receipt digest is not the uploaded one",
      { ...checkManifest, artifacts: [] },
      "is not its uploaded factory-resolve-a2/receipt.json",
    ],
    [
      "the local receipt failed a command",
      {
        ...checkManifest,
        localEvidence: {
          ...checkManifest.localEvidence,
          receipt: { ...checkReceipt, commands: [{ ...checkCommand, exitCode: 1 }] },
        },
      },
      "did not pass: exit 1",
    ],
  ])("rejects a manifest where %s", (_name, manifestValue, message) => {
    const result = evaluateValidationRun(fixture(manifestValue));
    expect(result.validation).toBeUndefined();
    expect(result.errors.join("\n")).toContain(message);
  });

  it("rejects an artifact carrying anything besides the manifest and its digest", () => {
    const result = evaluateValidationRun(fixture(checkManifest, { "extra.json": "{}" }));
    expect(result.errors.join("\n")).toContain("not exactly the manifest and its digest");
  });
});

describe("evaluateBuild", () => {
  const receiptSha = "8".repeat(64);
  const inputs = {
    candidate_sha: candidateSha,
    base_sha: baseSha,
    candidate_ref: "feat/t3factory",
    validation_run_id: "555",
    validation_run_attempt: "2",
    validation_control_sha: controlSha,
    validation_manifest_sha256: "7".repeat(64),
    package_receipt_sha256: receiptSha,
  };
  const provenance = {
    schema: "t3factory.build-provenance/v1",
    repository,
    workflowSha: "6".repeat(40),
    runAttempt: "1",
    candidate: {
      sha: candidateSha,
      ref: "feat/t3factory",
      refKind: "branch",
      refSha: candidateSha,
    },
    baseSha,
    toolchainPins: toolchain,
    validation: {
      workflow: { sha: controlSha },
      run: { id: "555", attempt: "2" },
      manifest: { sha256: "7".repeat(64) },
    },
    packageReceipt: { evidence: "dispatcher-declared", attested: false, sha256: receiptSha },
  };
  const packageRecord = {
    schema: "t3factory.build-package/v1",
    candidateHead: candidateSha,
    runAttempt: "1",
    toolchain,
    windowsPrerequisites: prerequisites,
    runner: { os: "Windows" },
    distribution: "factory-preview",
    platform: "win",
    arch: "x64",
    signed: false,
    package: packageFile,
  };
  const zipFile = {
    path: `factory-package-a1/${packageFile.file}`,
    bytes: packageFile.bytes,
    sha256: packageFile.sha256,
  };
  const passing = {
    context: {
      repository,
      workflowRef: `${repository}/.github/workflows/factory-build.yml@refs/heads/feat/t3factory`,
      workflowSha: "6".repeat(40),
      runId: "900",
      runAttempt: "1",
      eventName: "workflow_dispatch",
      ref: "refs/heads/feat/t3factory",
    },
    inputs,
    needs: { verify: { result: "success" }, package: { result: "success" } },
    provenance,
    packageReceiptSha256: receiptSha,
    packageRecord,
    packageFiles: [zipFile],
    artifacts: [zipFile],
  };

  it("binds candidate, validation, receipt, toolchain and package hashes", () => {
    const manifest = evaluateBuild(passing);
    expect(manifest.failures).toEqual([]);
    expect(manifest).toMatchObject({
      status: "passed",
      candidate: { sha: candidateSha, refKind: "branch" },
      validation: { run: { id: "555", attempt: "2" } },
      packageReceipt: { sha256: receiptSha, attested: false },
      toolchain: { pinned: toolchain, windowsPrerequisites: { spectreLibraries: true } },
      package: { signed: false, files: [zipFile] },
      publication: "none",
    });
  });

  it.each([
    [
      "verification failed",
      { needs: { ...passing.needs, verify: { result: "failure" } } },
      "verify result is failure",
    ],
    [
      "the package job was skipped",
      { needs: { ...passing.needs, package: { result: "skipped" } } },
      "package result is skipped",
    ],
    [
      "the package job built another commit",
      { packageRecord: { ...packageRecord, candidateHead: "1".repeat(40) } },
      "package job built 1111",
    ],
    [
      "the package job lacked Spectre libraries",
      {
        packageRecord: {
          ...packageRecord,
          windowsPrerequisites: { ...prerequisites, spectreLibraries: false },
        },
      },
      "no x64 Spectre-mitigated libraries",
    ],
    [
      "the package came from an earlier attempt",
      { packageRecord: { ...packageRecord, runAttempt: "0" } },
      "package record is from another run attempt",
    ],
    [
      "the uploaded ZIP differs from the recorded one",
      { packageFiles: [{ ...zipFile, sha256: "0".repeat(64) }] },
      "not exactly the recorded",
    ],
    [
      "the package artifact is ambiguous",
      { packageFiles: [zipFile, zipFile] },
      "not exactly the recorded",
    ],
    [
      "provenance names another validation run",
      { inputs: { ...inputs, validation_run_id: "556" } },
      "names another validation run",
    ],
    [
      "the run was not dispatched",
      { context: { ...passing.context, eventName: "push" } },
      "is not workflow_dispatch",
    ],
  ])("fails when %s", (_name, override, message) => {
    const manifest = evaluateBuild({ ...passing, ...override } as typeof passing);
    expect(manifest.status).toBe("failed");
    expect(manifest.failures.join("\n")).toContain(message);
  });
});
