// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - factory-build.yml runs this from the control checkout before any install.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

import { FACTORY_PREVIEW_IDENTITY } from "../apps/desktop/src/app/DesktopDistribution.ts";
import { cleanupSmokeDirectory } from "./desktop-smoke-cleanup.ts";
import {
  type ArtifactDigest,
  CHECK_LANES,
  CHECK_WORKFLOW_PATH,
  type CheckLane,
  type CheckRunContext,
  decodeReceiptInput,
  DIGEST_PATTERN,
  git,
  gitSucceeds,
  isInside,
  isRecord,
  laneShardErrors,
  listFiles,
  MANIFEST_SCHEMA,
  MAX_RECEIPT_BYTES,
  pnpmVersion,
  readToolchainPins,
  type ReceiptExpectation,
  REPOSITORY_PATTERN,
  requireCleanCandidate,
  requireEnv,
  resolveCandidate,
  runLogged,
  SHA_PATTERN,
  sha256,
  type ToolchainPins,
  unknownKeys,
  validateReceipt,
  writeJson,
} from "./factory-check.ts";

export const PACKAGE_RECEIPT_SCHEMA = "t3factory.local-package/v1";
export const PROVENANCE_SCHEMA = "t3factory.build-provenance/v1";
export const PACKAGE_RECORD_SCHEMA = "t3factory.build-package/v1";
export const BUILD_MANIFEST_SCHEMA = "t3factory.build-manifest/v1";
export const BUILD_WORKFLOW_PATH = ".github/workflows/factory-build.yml";
export const RUST_TARGET = "x86_64-pc-windows-msvc";

/** factory-check.yml job names as the jobs API reports them; the workflow audit keeps them in sync. */
export const CHECK_JOB_NAMES: Readonly<Record<"resolve" | CheckLane | "check", string>> = {
  resolve: "Resolve candidate and local evidence",
  lint: "Lint",
  build: "Build and Typecheck",
  test: "Test",
  test_web: "Test Web",
  test_server: "Test Server",
  rust: "Rust",
  release_smoke: "Release Smoke",
  windows: "Windows Build",
  check: "Check",
};
/** Matrix lanes; the jobs API appends the shard index to their name. */
export const SHARDED_CHECK_LANES: ReadonlyArray<CheckLane> = ["test_server"];

const PACKAGE_COMMAND_KINDS = ["check-changed", "test", "package", "smoke"] as const;
type PackageCommandKind = (typeof PACKAGE_COMMAND_KINDS)[number];
const MAX_COMMANDS = 32;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const PACKAGE_FILE_PATTERN = new RegExp(
  `^${FACTORY_PREVIEW_IDENTITY.artifactPrefix}\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?-x64\\.zip$`,
);
const MANIFEST_FILE = "factory-check-manifest.json";
const FORBIDDEN_PACKAGE_FLAGS = [
  "--skip-build",
  "--signed",
  "--mock-updates",
  "--wsl-runtime",
  "--build-version",
];

export interface WindowsPrerequisites {
  readonly msvcToolset: string | null;
  readonly spectreLibraries: boolean;
  readonly windowsSdk: string | null;
  readonly rustc: string | null;
  readonly rustTarget: string;
  readonly rustTargetInstalled: boolean;
  readonly python: string | null;
  readonly reuseResourceMonitor: boolean;
}

export interface PackageFile {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PackageReceiptCommand {
  readonly kind: PackageCommandKind;
  readonly argv: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly outputSha256: string;
}

export interface PackageReceipt {
  readonly schema: typeof PACKAGE_RECEIPT_SCHEMA;
  readonly evidence: "dispatcher-declared";
  readonly repository: string;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly worktreeClean: true;
  readonly toolchain: ToolchainPins;
  readonly platform: { readonly os: string; readonly arch: string; readonly release: string };
  readonly windowsPrerequisites: WindowsPrerequisites | null;
  readonly recordedAt: string;
  readonly commands: ReadonlyArray<PackageReceiptCommand>;
  readonly package: PackageFile | null;
}

export interface ValidationRequest {
  readonly repository: string;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly candidateRef: string;
  /** The factory-check run's workflow revision, as dispatched. */
  readonly controlSha: string;
  /** Whether controlSha is this factory-build revision or one of its ancestors. */
  readonly controlReachable: boolean;
  /** Branch factory-build was dispatched from; factory-check must have run from the same one. */
  readonly dispatchBranch: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly manifestSha256: string;
  readonly toolchain: ToolchainPins;
}

const rec = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const sameToolchain = (value: unknown, pins: ToolchainPins) =>
  isRecord(value) && value.node === pins.node && value.pnpm === pins.pnpm;

/** Every requirement the factory-preview build preflight checks, with the resource monitor built, not reused. */
export function windowsPrerequisiteErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["Windows prerequisites were not recorded"];
  const errors = unknownKeys(value, [
    "msvcToolset",
    "spectreLibraries",
    "windowsSdk",
    "rustc",
    "rustTarget",
    "rustTargetInstalled",
    "python",
    "reuseResourceMonitor",
  ]).map((key) => `Windows prerequisites have unknown field ${key}`);
  if (typeof value.msvcToolset !== "string" || !value.msvcToolset) {
    errors.push("no MSVC x64 build tools");
  }
  if (value.spectreLibraries !== true) {
    errors.push("the MSVC toolset has no x64 Spectre-mitigated libraries");
  }
  if (typeof value.windowsSdk !== "string" || !value.windowsSdk) errors.push("no Windows SDK");
  if (typeof value.rustc !== "string" || !value.rustc.startsWith("rustc ")) {
    errors.push("no Rust compiler");
  }
  if (value.rustTarget !== RUST_TARGET || value.rustTargetInstalled !== true) {
    errors.push(`Rust target ${RUST_TARGET} is not installed`);
  }
  if (typeof value.python !== "string" || !value.python.startsWith("Python 3.")) {
    errors.push("no Python 3 for node-gyp");
  }
  if (value.reuseResourceMonitor !== false) {
    errors.push(
      "the resource monitor was reused (T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR), not built",
    );
  }
  return errors;
}

/** Mirrors the vswhere preflight in build-desktop-artifact.ts: the newest toolset must carry Spectre libraries. */
const MSVC_PROBE = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$r = [ordered]@{ msvcToolset = $null; spectreLibraries = $false; windowsSdk = $null }",
  "$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\vswhere.exe'",
  "if (Test-Path $vswhere) { $install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }",
  "if ($install) { $toolset = Get-ChildItem (Join-Path $install 'VC\\Tools\\MSVC') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1 }",
  "if ($toolset) { $r.msvcToolset = $toolset.Name; $r.spectreLibraries = Test-Path (Join-Path $toolset.FullName 'lib\\spectre\\x64') }",
  "$kits = Get-ItemPropertyValue 'HKLM:\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots' -Name KitsRoot10",
  "if ($kits) { $sdk = Get-ChildItem (Join-Path $kits 'Lib') -Directory | Where-Object { $_.Name -match '^\\d+(\\.\\d+){3}$' } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1 }",
  "if ($sdk) { $r.windowsSdk = $sdk.Name }",
  "$r | ConvertTo-Json -Compress",
].join("; ");

function capture(command: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Effect's Config.Boolean reads these as false; anything else set either reuses or fails the build. */
export function reusesResourceMonitor(value: string | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized !== "" && !["false", "0", "no", "off", "n"].includes(normalized);
}

export function probeWindowsPrerequisites(): WindowsPrerequisites {
  let msvc: unknown;
  try {
    msvc = JSON.parse(
      capture("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        MSVC_PROBE,
      ]) ?? "null",
    );
  } catch {
    msvc = null;
  }
  const probe = rec(msvc);
  const targets = (capture("rustup", ["target", "list", "--installed"]) ?? "").split(/\r?\n/);
  return {
    msvcToolset: typeof probe.msvcToolset === "string" ? probe.msvcToolset : null,
    spectreLibraries: probe.spectreLibraries === true,
    windowsSdk: typeof probe.windowsSdk === "string" ? probe.windowsSdk : null,
    rustc: capture("rustc", ["--version"]),
    rustTarget: RUST_TARGET,
    rustTargetInstalled: targets.map((target) => target.trim()).includes(RUST_TARGET),
    python: capture("python", ["--version"]) ?? capture("py", ["-3", "--version"]),
    reuseResourceMonitor: reusesResourceMonitor(process.env.T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR),
  };
}

function flagValue(argv: ReadonlyArray<string>, flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index !== -1) return argv[index + 1];
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

/** The local package command must be the same factory-preview build the hosted job runs. */
export function packageArgvErrors(argv: ReadonlyArray<string>): string[] {
  const errors: string[] = [];
  if (!argv.includes("dist:desktop:artifact")) errors.push("must run dist:desktop:artifact");
  if (flagValue(argv, "--distribution") !== "factory-preview") {
    errors.push("must pass --distribution factory-preview");
  }
  for (const [flag, value] of [
    ["--platform", "win"],
    ["--arch", "x64"],
    ["--target", "zip"],
  ] as const) {
    const actual = flagValue(argv, flag);
    if (argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`)) && actual !== value) {
      errors.push(`must pass ${flag} ${value} or omit it`);
    }
  }
  if (!flagValue(argv, "--output-dir")) errors.push("must pass --output-dir");
  for (const flag of FORBIDDEN_PACKAGE_FLAGS) {
    if (argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
      errors.push(`must not pass ${flag}`);
    }
  }
  return errors;
}

function packageFileErrors(value: unknown, at: string): string[] {
  if (!isRecord(value)) return [`${at} is missing`];
  const errors = unknownKeys(value, ["file", "bytes", "sha256"]).map(
    (key) => `${at} has unknown field ${key}`,
  );
  if (typeof value.file !== "string" || !PACKAGE_FILE_PATTERN.test(value.file)) {
    errors.push(`${at} file ${String(value.file)} is not a T3Factory Windows x64 ZIP`);
  }
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) {
    errors.push(`${at} bytes must be a positive integer`);
  }
  if (typeof value.sha256 !== "string" || !DIGEST_PATTERN.test(value.sha256)) {
    errors.push(`${at} sha256 must be a lowercase SHA-256`);
  }
  return errors;
}

function packageCommandErrors(
  value: unknown,
  index: number,
  baseSha: string,
  packageFile: Record<string, unknown>,
): string[] {
  const at = `commands[${index}]`;
  if (!isRecord(value)) return [`${at} is not an object`];
  const errors = unknownKeys(value, [
    "kind",
    "argv",
    "exitCode",
    "durationMs",
    "outputBytes",
    "outputSha256",
  ]).map((key) => `${at} has unknown field ${key}`);
  const argv = value.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.length > 64 ||
    !argv.every((arg) => typeof arg === "string" && arg.length > 0 && arg.length <= 512)
  ) {
    errors.push(`${at}.argv must hold 1-64 non-empty strings`);
  } else if (value.kind === "check-changed") {
    if (!argv.includes("check:changed") || !argv.includes(baseSha)) {
      errors.push(`${at} must run check:changed against the base SHA`);
    }
  } else if (value.kind === "package") {
    errors.push(...packageArgvErrors(argv).map((error) => `${at} ${error}`));
  } else if (value.kind === "smoke") {
    const smoked = flagValue(argv, "--package");
    if (
      !argv.includes("smoke") ||
      flagValue(argv, "--sha256") !== packageFile.sha256 ||
      !smoked ||
      NodePath.win32.basename(smoked) !== packageFile.file
    ) {
      errors.push(`${at} must smoke the recorded package by its SHA-256`);
    }
  } else if (value.kind !== "test") {
    errors.push(`${at}.kind is not recognized`);
  }
  if (value.exitCode !== 0) {
    errors.push(`${at} (${String(value.kind)}) did not pass: exit ${String(value.exitCode)}`);
  }
  for (const field of ["durationMs", "outputBytes"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      errors.push(`${at}.${field} must be a non-negative integer`);
    }
  }
  if (typeof value.outputSha256 !== "string" || !DIGEST_PATTERN.test(value.outputSha256)) {
    errors.push(`${at}.outputSha256 must be a lowercase SHA-256`);
  }
  return errors;
}

/** Checks a local packaging receipt's bytes against their digest and the candidate it must describe. */
export function validatePackageReceipt(
  bytes: Uint8Array,
  declaredSha256: string,
  expected: ReceiptExpectation,
): { readonly receipt?: PackageReceipt; readonly sha256: string; readonly errors: string[] } {
  const digest = sha256(bytes);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECEIPT_BYTES) {
    return { sha256: digest, errors: [`receipt must be 1-${MAX_RECEIPT_BYTES} bytes`] };
  }
  if (digest !== declaredSha256) {
    return {
      sha256: digest,
      errors: [`receipt SHA-256 ${digest} does not match ${declaredSha256}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { sha256: digest, errors: ["receipt is not JSON"] };
  }
  if (!isRecord(parsed)) return { sha256: digest, errors: ["receipt is not an object"] };
  const errors = unknownKeys(parsed, [
    "schema",
    "evidence",
    "repository",
    "candidateSha",
    "baseSha",
    "worktreeClean",
    "toolchain",
    "platform",
    "windowsPrerequisites",
    "recordedAt",
    "commands",
    "package",
  ]).map((key) => `receipt has unknown field ${key}`);
  if (parsed.schema !== PACKAGE_RECEIPT_SCHEMA) {
    errors.push(`receipt schema must be ${PACKAGE_RECEIPT_SCHEMA}`);
  }
  if (parsed.evidence !== "dispatcher-declared") {
    errors.push("receipt evidence must be labelled dispatcher-declared");
  }
  if (parsed.repository !== expected.repository) {
    errors.push(`receipt repository ${String(parsed.repository)} is not ${expected.repository}`);
  }
  if (parsed.candidateSha !== expected.candidateSha) {
    errors.push(`receipt candidate ${String(parsed.candidateSha)} is not ${expected.candidateSha}`);
  }
  if (parsed.baseSha !== expected.baseSha) {
    errors.push(`receipt base ${String(parsed.baseSha)} is not ${expected.baseSha}`);
  }
  if (parsed.worktreeClean !== true) errors.push("receipt was not recorded from a clean worktree");
  if (!sameToolchain(parsed.toolchain, expected.toolchain)) {
    errors.push(
      `receipt toolchain is not the pinned node ${expected.toolchain.node}/pnpm ${expected.toolchain.pnpm}`,
    );
  }
  const platform = rec(parsed.platform);
  if (platform.os !== "win32" || platform.arch !== "x64" || typeof platform.release !== "string") {
    errors.push("receipt must be recorded on Windows x64");
  }
  errors.push(
    ...windowsPrerequisiteErrors(parsed.windowsPrerequisites).map((error) => `receipt: ${error}`),
  );
  if (typeof parsed.recordedAt !== "string" || Number.isNaN(Date.parse(parsed.recordedAt))) {
    errors.push("receipt recordedAt must be an ISO timestamp");
  }
  errors.push(...packageFileErrors(parsed.package, "receipt package"));
  const commands = parsed.commands;
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_COMMANDS) {
    errors.push(`receipt must list 1-${MAX_COMMANDS} commands`);
  } else {
    commands.forEach((command, index) =>
      errors.push(...packageCommandErrors(command, index, expected.baseSha, rec(parsed.package))),
    );
    const kinds = commands.map((command) => rec(command).kind);
    for (const kind of PACKAGE_COMMAND_KINDS) {
      if (!kinds.includes(kind)) errors.push(`receipt has no ${kind} command`);
    }
    if (kinds.filter((kind) => kind === "package").length > 1) {
      errors.push("receipt records more than one package");
    }
    if (kinds.some((kind, index) => kind === "smoke" && index < kinds.indexOf("package"))) {
      errors.push("receipt smokes before it packages");
    }
  }
  return errors.length > 0
    ? { sha256: digest, errors }
    : { receipt: parsed as unknown as PackageReceipt, sha256: digest, errors };
}

/** Reads a stored or deflated ZIP (no ZIP64, no encryption) and verifies each entry's CRC. */
export function readZipEntries(bytes: Uint8Array): Map<string, Buffer> {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("not a ZIP archive");
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP directory is malformed");
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const crc = zip.readUInt32LE(offset + 16);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error(`ZIP entry ${name} is encrypted`);
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`ZIP entry ${name} is malformed`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`ZIP entry ${name} uses method ${method}`);
    const data = method === 0 ? Buffer.from(raw) : NodeZlib.inflateRawSync(raw);
    if (data.length !== size || NodeZlib.crc32(data) !== crc) {
      throw new Error(`ZIP entry ${name} is corrupt`);
    }
    if (entries.has(name)) throw new Error(`ZIP holds ${name} twice`);
    entries.set(name, data);
  }
  return entries;
}

export const manifestArtifactName = (attempt: string) => `factory-check-manifest-a${attempt}`;

function validationManifestErrors(value: unknown, request: ValidationRequest) {
  const at = "validation manifest";
  const shardTotals = new Map<string, number>();
  if (!isRecord(value)) {
    return {
      errors: [`${at} is not a JSON object`],
      shardTotals,
      workflowRef: "",
      localEvidence: {},
    };
  }
  const errors: string[] = [];
  if (value.schema !== MANIFEST_SCHEMA) errors.push(`${at} schema is not ${MANIFEST_SCHEMA}`);
  if (value.status !== "passed" || !Array.isArray(value.failures) || value.failures.length !== 0) {
    errors.push(`${at} did not pass: ${JSON.stringify(value.failures ?? value.status)}`);
  }
  if (value.repository !== request.repository) errors.push(`${at} names another repository`);
  const workflow = rec(value.workflow);
  if (
    workflow.path !== CHECK_WORKFLOW_PATH ||
    workflow.sha !== request.controlSha ||
    workflow.ref !==
      `${request.repository}/${CHECK_WORKFLOW_PATH}@refs/heads/${request.dispatchBranch}`
  ) {
    errors.push(`${at} names another workflow, ref or control revision`);
  }
  const run = rec(value.run);
  if (
    String(run.id) !== request.runId ||
    String(run.attempt) !== request.runAttempt ||
    run.event !== "workflow_dispatch"
  ) {
    errors.push(`${at} names another run or attempt`);
  }
  const candidate = rec(value.candidate);
  if (candidate.sha !== request.candidateSha || candidate.ref !== request.candidateRef) {
    errors.push(`${at} validated candidate ${String(candidate.sha)} on ${String(candidate.ref)}`);
  }
  if (
    !["branch", "tag"].includes(candidate.refKind as string) ||
    !SHA_PATTERN.test(String(candidate.refSha))
  ) {
    errors.push(`${at} has no resolved candidate ref`);
  }
  if (value.baseSha !== request.baseSha) errors.push(`${at} names base ${String(value.baseSha)}`);
  if (!sameToolchain(rec(value.toolchain).pinned, request.toolchain)) {
    errors.push(`${at} pinned another toolchain`);
  }

  const lanes = Array.isArray(value.lanes) ? value.lanes.map(rec) : [];
  for (const lane of lanes) {
    if (!CHECK_LANES.includes(lane.name as CheckLane)) {
      errors.push(`${at} has unknown lane ${String(lane.name)}`);
    }
  }
  for (const name of CHECK_LANES) {
    const matches = lanes.filter((lane) => lane.name === name);
    if (matches.length !== 1) {
      errors.push(`${at} lists lane ${name} ${matches.length} times`);
      continue;
    }
    const lane = matches[0]!;
    if (lane.requested !== true) errors.push(`required lane ${name} was not requested`);
    if (lane.result !== "success")
      errors.push(`required lane ${name} result is ${String(lane.result)}`);
    const runs = Array.isArray(lane.runs) ? lane.runs.map(rec) : [];
    const shards = runs.map((entry) => rec(entry.shard));
    if (
      !shards.every(
        (shard) => Number.isSafeInteger(shard.index) && Number.isSafeInteger(shard.total),
      )
    ) {
      errors.push(`lane ${name} has malformed shards`);
    } else {
      errors.push(
        ...laneShardErrors(
          name,
          shards.map((shard) => ({
            shard: { index: shard.index as number, total: shard.total as number },
          })),
        ),
      );
    }
    if (!runs.every((entry) => sameToolchain(entry.toolchain, request.toolchain))) {
      errors.push(`lane ${name} ran another toolchain`);
    }
    shardTotals.set(name, runs.length);
  }

  const evidence = rec(value.localEvidence);
  const receiptPath = `factory-resolve-a${request.runAttempt}/receipt.json`;
  if (
    evidence.evidence !== "dispatcher-declared" ||
    evidence.attested !== false ||
    typeof evidence.sha256 !== "string" ||
    !DIGEST_PATTERN.test(evidence.sha256)
  ) {
    errors.push(`${at} local evidence is not labelled dispatcher-declared with a digest`);
  } else {
    const uploaded = (Array.isArray(value.artifacts) ? value.artifacts.map(rec) : []).filter(
      (artifact) => artifact.path === receiptPath,
    );
    if (uploaded.length !== 1 || uploaded[0]!.sha256 !== evidence.sha256) {
      errors.push(`${at} local receipt ${evidence.sha256} is not its uploaded ${receiptPath}`);
    }
    const bytes = Buffer.from(JSON.stringify(evidence.receipt ?? null));
    const receipt = validateReceipt(bytes, sha256(bytes), request);
    errors.push(...receipt.errors.map((error) => `validation local ${error}`));
  }
  return { errors, shardTotals, workflowRef: String(workflow.ref), localEvidence: evidence };
}

/**
 * Decides whether one factory-check run attempt validated the candidate. Every claim comes from
 * the GitHub API and the downloaded manifest artifact; dispatched inputs only name what to check.
 */
export function evaluateValidationRun(input: {
  readonly request: ValidationRequest;
  readonly run: unknown;
  readonly jobs: unknown;
  readonly artifacts: unknown;
  readonly artifactZip: Uint8Array | undefined;
}) {
  const { request } = input;
  const at = `factory-check run ${request.runId}`;
  const errors: string[] = [];
  if (!SHA_PATTERN.test(request.controlSha)) {
    errors.push("validation_control_sha must be a 40-character lowercase SHA");
  } else if (!request.controlReachable) {
    errors.push(
      `validation control revision ${request.controlSha} is not this workflow's revision or an ancestor`,
    );
  }
  if (!POSITIVE_INTEGER.test(request.runId) || !POSITIVE_INTEGER.test(request.runAttempt)) {
    errors.push("validation_run_id and validation_run_attempt must be positive integers");
  }
  if (!DIGEST_PATTERN.test(request.manifestSha256)) {
    errors.push("validation_manifest_sha256 must be a lowercase SHA-256");
  }

  const run = rec(input.run);
  if (String(run.id) !== request.runId) errors.push(`${at} was not returned by the API`);
  if (
    rec(run.repository).full_name !== request.repository ||
    rec(run.head_repository).full_name !== request.repository
  ) {
    errors.push(`${at} is not a run of ${request.repository}`);
  }
  if (run.path !== CHECK_WORKFLOW_PATH) {
    errors.push(`${at} ran ${String(run.path)}, not ${CHECK_WORKFLOW_PATH}`);
  }
  if (run.event !== "workflow_dispatch")
    errors.push(`${at} event ${String(run.event)} is not workflow_dispatch`);
  if (run.head_sha !== request.controlSha) {
    errors.push(`${at} ran control revision ${String(run.head_sha)}, not ${request.controlSha}`);
  }
  if (run.head_branch !== request.dispatchBranch) {
    errors.push(
      `${at} ran from ${String(run.head_branch)}, not the trusted ${request.dispatchBranch}`,
    );
  }
  if (String(run.run_attempt) !== request.runAttempt) {
    errors.push(
      `${at} attempt ${request.runAttempt} is not its current attempt ${String(run.run_attempt)}`,
    );
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    errors.push(`${at} is ${String(run.status)}/${String(run.conclusion)}, not completed/success`);
  }

  const name = manifestArtifactName(request.runAttempt);
  const listing = rec(input.artifacts);
  const listed = Array.isArray(listing.artifacts) ? listing.artifacts.map(rec) : [];
  if (listing.total_count !== listed.length) errors.push(`${at} artifact listing is incomplete`);
  const matches = listed.filter((artifact) => artifact.name === name);
  let manifestBytes: Buffer | undefined;
  let artifact: Record<string, unknown> = {};
  if (matches.length !== 1) {
    errors.push(`${at} has ${matches.length} ${name} artifacts, expected exactly one`);
  } else {
    artifact = matches[0]!;
    const owner = rec(artifact.workflow_run);
    if (artifact.expired !== false) errors.push(`${name} has expired`);
    if (String(owner.id) !== request.runId || owner.head_sha !== request.controlSha) {
      errors.push(`${name} belongs to another run or revision`);
    }
    const digest = String(artifact.digest);
    if (!ARTIFACT_DIGEST_PATTERN.test(digest)) {
      errors.push(`${name} has no SHA-256 digest`);
    } else if (!input.artifactZip) {
      errors.push(`${name} was not downloaded`);
    } else if (`sha256:${sha256(input.artifactZip)}` !== digest) {
      errors.push(`${name} download does not match its digest ${digest}`);
    } else {
      try {
        const entries = readZipEntries(input.artifactZip);
        const names = [...entries.keys()].toSorted();
        if (JSON.stringify(names) !== JSON.stringify([MANIFEST_FILE, `${MANIFEST_FILE}.sha256`])) {
          errors.push(`${name} holds ${names.join(", ")}, not exactly the manifest and its digest`);
        } else {
          manifestBytes = entries.get(MANIFEST_FILE)!;
          const digestFile = entries.get(`${MANIFEST_FILE}.sha256`)!.toString("utf8");
          if (sha256(manifestBytes) !== request.manifestSha256) {
            errors.push(
              `${MANIFEST_FILE} hashes to ${sha256(manifestBytes)}, not ${request.manifestSha256}`,
            );
          }
          if (digestFile !== `${sha256(manifestBytes)}  ${MANIFEST_FILE}\n`) {
            errors.push(`${MANIFEST_FILE}.sha256 does not match the manifest`);
          }
        }
      } catch (error) {
        errors.push(
          `${name} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  let manifest: ReturnType<typeof validationManifestErrors> | undefined;
  if (manifestBytes) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      parsed = undefined;
    }
    manifest = validationManifestErrors(parsed, request);
    errors.push(...manifest.errors);
  }

  const jobListing = rec(input.jobs);
  const jobs = Array.isArray(jobListing.jobs) ? jobListing.jobs.map(rec) : [];
  if (jobListing.total_count !== jobs.length) errors.push(`${at} job listing is incomplete`);
  const expectedJobs = [
    CHECK_JOB_NAMES.resolve,
    ...CHECK_LANES.flatMap((lane) =>
      SHARDED_CHECK_LANES.includes(lane)
        ? Array.from(
            { length: manifest?.shardTotals.get(lane) ?? 0 },
            (_, index) => `${CHECK_JOB_NAMES[lane]} ${index + 1}`,
          )
        : [CHECK_JOB_NAMES[lane]],
    ),
    CHECK_JOB_NAMES.check,
  ];
  for (const job of jobs) {
    const jobName = String(job.name);
    if (!expectedJobs.includes(jobName)) errors.push(`${at} has unexpected job ${jobName}`);
    if (
      String(job.run_id) !== request.runId ||
      String(job.run_attempt) !== request.runAttempt ||
      job.head_sha !== request.controlSha
    ) {
      errors.push(`${at} job ${jobName} belongs to another run, attempt or revision`);
    }
    if (job.status !== "completed" || job.conclusion !== "success") {
      errors.push(`${at} job ${jobName} is ${String(job.status)}/${String(job.conclusion)}`);
    }
  }
  for (const jobName of expectedJobs) {
    const count = jobs.filter((job) => job.name === jobName).length;
    if (count !== 1) errors.push(`${at} has ${count} ${jobName} jobs, expected exactly one`);
  }

  if (errors.length > 0 || !manifest || !manifestBytes) {
    return { errors, manifestBytes: undefined, validation: undefined };
  }
  return {
    errors,
    manifestBytes,
    validation: {
      workflow: { path: CHECK_WORKFLOW_PATH, ref: manifest.workflowRef, sha: request.controlSha },
      run: {
        id: request.runId,
        attempt: request.runAttempt,
        event: "workflow_dispatch",
        headBranch: request.dispatchBranch,
        conclusion: "success",
        url: String(run.html_url),
      },
      manifest: {
        sha256: request.manifestSha256,
        bytes: manifestBytes.byteLength,
        artifact: {
          id: String(artifact.id),
          name,
          bytes: artifact.size_in_bytes,
          digest: artifact.digest,
        },
      },
      jobs: jobs.map((job) => ({ id: String(job.id), name: job.name, conclusion: job.conclusion })),
      lanes: CHECK_LANES.map((lane) => ({
        name: lane,
        result: "success",
        runs: manifest.shardTotals.get(lane),
      })),
      localEvidence: {
        evidence: "dispatcher-declared",
        attested: false,
        sha256: manifest.localEvidence.sha256,
        bytes: manifest.localEvidence.bytes,
      },
    },
  };
}

function packageRecordErrors(
  value: unknown,
  expected: { candidateSha: string; runAttempt: string; toolchain: ToolchainPins },
): string[] {
  if (!isRecord(value)) return ["package record is missing"];
  const errors: string[] = [];
  if (value.schema !== PACKAGE_RECORD_SCHEMA)
    errors.push("package record schema is not recognized");
  if (value.candidateHead !== expected.candidateSha) {
    errors.push(`package job built ${String(value.candidateHead)}, not ${expected.candidateSha}`);
  }
  if (value.runAttempt !== expected.runAttempt)
    errors.push("package record is from another run attempt");
  if (!sameToolchain(value.toolchain, expected.toolchain)) {
    errors.push("package job ran another Node.js or pnpm than the candidate pins");
  }
  errors.push(
    ...windowsPrerequisiteErrors(value.windowsPrerequisites).map(
      (error) => `package job: ${error}`,
    ),
  );
  if (
    value.distribution !== "factory-preview" ||
    value.platform !== "win" ||
    value.arch !== "x64" ||
    value.signed !== false
  ) {
    errors.push("package record is not the unsigned factory-preview Windows x64 build");
  }
  errors.push(...packageFileErrors(value.package, "package record package"));
  return errors;
}

/** Decides the build result and writes the versioned artifact manifest. Any failure fails the run. */
export function evaluateBuild(input: {
  readonly context: CheckRunContext;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly needs: Readonly<Record<string, { readonly result?: string } | undefined>>;
  readonly provenance: unknown;
  readonly packageReceiptSha256: string | undefined;
  readonly packageRecord: unknown;
  readonly packageFiles: ReadonlyArray<ArtifactDigest>;
  readonly artifacts: ReadonlyArray<ArtifactDigest>;
}) {
  const { context, inputs, needs } = input;
  const failures: string[] = [];
  const candidateSha = String(inputs.candidate_sha ?? "");
  if (context.eventName !== "workflow_dispatch") {
    failures.push(`event ${context.eventName} is not workflow_dispatch`);
  }
  if (!context.workflowRef.startsWith(`${context.repository}/${BUILD_WORKFLOW_PATH}@`)) {
    failures.push(
      `workflow ${context.workflowRef} is not ${context.repository}/${BUILD_WORKFLOW_PATH}`,
    );
  }
  if (!SHA_PATTERN.test(context.workflowSha)) failures.push("workflow SHA is not a commit SHA");
  for (const job of Object.keys(needs)) {
    if (!["verify", "package"].includes(job)) failures.push(`manifest needs unknown job ${job}`);
  }
  for (const job of ["verify", "package"]) {
    if (needs[job]?.result !== "success") {
      failures.push(`${job} result is ${needs[job]?.result ?? "missing"}`);
    }
  }

  const provenance = rec(input.provenance);
  const candidate = rec(provenance.candidate);
  const validation = rec(provenance.validation);
  const receipt = rec(provenance.packageReceipt);
  const pins = rec(provenance.toolchainPins);
  if (provenance.schema !== PROVENANCE_SCHEMA) {
    failures.push("provenance record is missing or not recognized");
  } else {
    if (
      provenance.repository !== context.repository ||
      provenance.workflowSha !== context.workflowSha ||
      provenance.runAttempt !== context.runAttempt
    ) {
      failures.push("provenance record is from another repository, revision or attempt");
    }
    if (
      candidate.sha !== candidateSha ||
      candidate.ref !== inputs.candidate_ref ||
      provenance.baseSha !== inputs.base_sha
    ) {
      failures.push("provenance record names another candidate, ref or base");
    }
    if (
      rec(validation.run).id !== inputs.validation_run_id ||
      rec(validation.run).attempt !== inputs.validation_run_attempt ||
      rec(validation.workflow).sha !== inputs.validation_control_sha ||
      rec(validation.manifest).sha256 !== inputs.validation_manifest_sha256
    ) {
      failures.push("provenance record names another validation run, revision or manifest");
    }
    if (
      receipt.attested !== false ||
      receipt.sha256 !== inputs.package_receipt_sha256 ||
      input.packageReceiptSha256 !== inputs.package_receipt_sha256
    ) {
      failures.push("uploaded package receipt is not the dispatched, unattested receipt");
    }
  }
  const toolchain = { node: String(pins.node), pnpm: String(pins.pnpm) };
  failures.push(
    ...packageRecordErrors(input.packageRecord, {
      candidateSha,
      runAttempt: context.runAttempt,
      toolchain,
    }),
  );
  const record = rec(input.packageRecord);
  const recorded = rec(record.package);
  if (
    input.packageFiles.length !== 1 ||
    input.packageFiles[0]!.path.split("/").at(-1) !== recorded.file ||
    input.packageFiles[0]!.sha256 !== recorded.sha256 ||
    input.packageFiles[0]!.bytes !== recorded.bytes
  ) {
    failures.push(
      `package artifact holds ${input.packageFiles.map((file) => file.path).join(", ") || "nothing"}, not exactly the recorded ${String(recorded.file)}`,
    );
  }

  return {
    schema: BUILD_MANIFEST_SCHEMA,
    status: failures.length === 0 ? ("passed" as const) : ("failed" as const),
    failures,
    repository: context.repository,
    workflow: { path: BUILD_WORKFLOW_PATH, ref: context.workflowRef, sha: context.workflowSha },
    run: {
      id: context.runId,
      attempt: context.runAttempt,
      event: context.eventName,
      dispatchRef: context.ref,
    },
    candidate: {
      sha: candidateSha,
      ref: String(inputs.candidate_ref ?? ""),
      refKind: candidate.refKind ?? null,
      refSha: candidate.refSha ?? null,
    },
    baseSha: String(inputs.base_sha ?? ""),
    validation: provenance.validation ?? null,
    packageReceipt: provenance.packageReceipt
      ? {
          ...receipt,
          note: "Declared by the dispatcher from a local packaging run; not independently verified.",
        }
      : null,
    toolchain: {
      pinned: provenance.toolchainPins ?? null,
      build: record.toolchain ?? null,
      windowsPrerequisites: record.windowsPrerequisites ?? null,
      runner: record.runner ?? null,
    },
    package: {
      distribution: "factory-preview",
      platform: "win",
      arch: "x64",
      signed: false,
      smoke: needs.package?.result ?? "missing",
      files: input.packageFiles,
    },
    provenance: {
      evidence: "dispatcher-declared",
      attested: false,
      note: "Inputs and local receipts are dispatcher-declared; this manifest is not a signed attestation.",
    },
    publication: "none",
    artifacts: input.artifacts,
  };
}

function fileDigest(file: string, root: string): ArtifactDigest {
  const bytes = NodeFS.readFileSync(file);
  return {
    path: NodePath.relative(root, file).split(NodePath.sep).join("/"),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function packageOutput(outputDir: string): PackageFile {
  const zips = NodeFS.readdirSync(outputDir, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && PACKAGE_FILE_PATTERN.test(entry.name),
  );
  if (zips.length !== 1) {
    throw new Error(`${outputDir} holds ${zips.length} T3Factory ZIPs, expected exactly one`);
  }
  const { bytes, sha256: digest } = fileDigest(NodePath.join(outputDir, zips[0]!.name), outputDir);
  return { file: zips[0]!.name, bytes, sha256: digest };
}

async function githubApi(path: string) {
  const response = await fetch(`${requireEnv("GITHUB_API_URL")}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requireEnv("GH_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
  return response;
}

async function runVerify(options: { candidateDir: string; out: string }) {
  const repository = requireEnv("GITHUB_REPOSITORY");
  const ref = requireEnv("GITHUB_REF");
  if (!ref.startsWith("refs/heads/"))
    throw new Error(`Dispatch factory-build from a branch, not ${ref}`);
  const workflowSha = requireEnv("GITHUB_WORKFLOW_SHA");
  const candidate = resolveCandidate(options.candidateDir, {
    candidateSha: requireEnv("CANDIDATE_SHA"),
    baseSha: requireEnv("BASE_SHA"),
    candidateRef: requireEnv("CANDIDATE_REF"),
  });
  const toolchain = readToolchainPins(
    NodeFS.readFileSync(NodePath.join(options.candidateDir, "package.json"), "utf8"),
  );
  const controlSha = requireEnv("VALIDATION_CONTROL_SHA");
  const request: ValidationRequest = {
    repository,
    candidateSha: candidate.sha,
    baseSha: requireEnv("BASE_SHA"),
    candidateRef: candidate.ref,
    controlSha,
    controlReachable:
      SHA_PATTERN.test(controlSha) &&
      gitSucceeds(options.candidateDir, ["merge-base", "--is-ancestor", controlSha, workflowSha]),
    dispatchBranch: ref.slice("refs/heads/".length),
    runId: requireEnv("VALIDATION_RUN_ID"),
    runAttempt: requireEnv("VALIDATION_RUN_ATTEMPT"),
    manifestSha256: requireEnv("VALIDATION_MANIFEST_SHA256"),
    toolchain,
  };
  if (!POSITIVE_INTEGER.test(request.runId) || !POSITIVE_INTEGER.test(request.runAttempt)) {
    throw new Error("validation_run_id and validation_run_attempt must be positive integers");
  }
  const runPath = `/repos/${repository}/actions/runs/${request.runId}`;
  const name = manifestArtifactName(request.runAttempt);
  const run: unknown = await (await githubApi(runPath)).json();
  const jobs: unknown = await (
    await githubApi(`${runPath}/attempts/${request.runAttempt}/jobs?per_page=100`)
  ).json();
  const artifacts: unknown = await (
    await githubApi(`${runPath}/artifacts?per_page=100&name=${encodeURIComponent(name)}`)
  ).json();
  const matches = (
    Array.isArray(rec(artifacts).artifacts) ? (rec(artifacts).artifacts as unknown[]) : []
  )
    .map(rec)
    .filter((artifact) => artifact.name === name);
  const artifactZip =
    matches.length === 1 && Number.isSafeInteger(matches[0]!.id)
      ? new Uint8Array(
          await (
            await githubApi(`/repos/${repository}/actions/artifacts/${String(matches[0]!.id)}/zip`)
          ).arrayBuffer(),
        )
      : undefined;
  const result = evaluateValidationRun({ request, run, jobs, artifacts, artifactZip });

  let receiptBytes: Buffer = Buffer.alloc(0);
  const receiptErrors: string[] = [];
  try {
    receiptBytes = decodeReceiptInput(requireEnv("PACKAGE_RECEIPT_B64"));
  } catch (error) {
    receiptErrors.push(
      `package_receipt_b64: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const receipt = validatePackageReceipt(
    receiptBytes,
    requireEnv("PACKAGE_RECEIPT_SHA256"),
    request,
  );
  receiptErrors.push(...receipt.errors.map((error) => `package ${error}`));
  const errors = [...result.errors, ...receiptErrors];
  if (errors.length > 0 || !result.validation || !result.manifestBytes || !receipt.receipt) {
    throw new Error(`Refusing to package:\n- ${errors.join("\n- ")}`);
  }
  NodeFS.mkdirSync(options.out, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(options.out, MANIFEST_FILE), result.manifestBytes);
  NodeFS.writeFileSync(NodePath.join(options.out, "package-receipt.json"), receiptBytes);
  writeJson(NodePath.join(options.out, "provenance.json"), {
    schema: PROVENANCE_SCHEMA,
    repository,
    workflowSha,
    runAttempt: requireEnv("GITHUB_RUN_ATTEMPT"),
    candidate,
    baseSha: request.baseSha,
    toolchainPins: toolchain,
    validation: result.validation,
    packageReceipt: {
      evidence: "dispatcher-declared",
      attested: false,
      sha256: receipt.sha256,
      bytes: receiptBytes.byteLength,
      receipt: receipt.receipt,
    },
  });
  console.log(
    `Validation run ${request.runId} attempt ${request.runAttempt} accepted for ${candidate.sha}.`,
  );
  console.log(`Package receipt ${receipt.sha256} accepted as dispatcher-declared evidence.`);
}

function runPackageRecord(options: { candidateDir: string; packageDir: string; out: string }) {
  const head = requireCleanCandidate(options.candidateDir, requireEnv("CANDIDATE_SHA"));
  const packageFile = packageOutput(options.packageDir);
  const runner: Record<string, string> = {};
  for (const [key, name] of [
    ["os", "RUNNER_OS"],
    ["arch", "RUNNER_ARCH"],
    ["environment", "RUNNER_ENVIRONMENT"],
    ["imageOS", "ImageOS"],
    ["imageVersion", "ImageVersion"],
  ] as const) {
    runner[key] = process.env[name] ?? "unknown";
  }
  const record = {
    schema: PACKAGE_RECORD_SCHEMA,
    candidateHead: head,
    runAttempt: requireEnv("GITHUB_RUN_ATTEMPT"),
    toolchain: { node: process.version.slice(1), pnpm: pnpmVersion(options.candidateDir) },
    windowsPrerequisites: probeWindowsPrerequisites(),
    runner,
    distribution: "factory-preview",
    platform: "win",
    arch: "x64",
    signed: false,
    package: packageFile,
  };
  writeJson(options.out, record);
  console.log(JSON.stringify(record, null, 2));
  const errors = windowsPrerequisiteErrors(record.windowsPrerequisites);
  if (errors.length > 0) throw new Error(`Windows prerequisites:\n- ${errors.join("\n- ")}`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    NodeFS.appendFileSync(
      output,
      `zip=${NodePath.join(options.packageDir, packageFile.file)}\nsha256=${packageFile.sha256}\n`,
    );
  }
}

function runBuildManifest(options: { evidence: string; out: string }) {
  const attempt = requireEnv("GITHUB_RUN_ATTEMPT");
  const dir = (name: string) => NodePath.join(options.evidence, `factory-${name}-a${attempt}`);
  const readJson = (file: string): unknown =>
    NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : undefined;
  const receiptFile = NodePath.join(dir("build-provenance"), "package-receipt.json");
  const artifacts = listFiles(options.evidence).map((file) => fileDigest(file, options.evidence));
  const packagePrefix = `factory-package-a${attempt}/`;
  const manifest = evaluateBuild({
    context: {
      repository: requireEnv("GITHUB_REPOSITORY"),
      workflowRef: requireEnv("GITHUB_WORKFLOW_REF"),
      workflowSha: requireEnv("GITHUB_WORKFLOW_SHA"),
      runId: requireEnv("GITHUB_RUN_ID"),
      runAttempt: attempt,
      eventName: requireEnv("GITHUB_EVENT_NAME"),
      ref: requireEnv("GITHUB_REF"),
    },
    inputs: JSON.parse(requireEnv("FACTORY_INPUTS")),
    needs: JSON.parse(requireEnv("FACTORY_NEEDS")),
    provenance: readJson(NodePath.join(dir("build-provenance"), "provenance.json")),
    packageReceiptSha256: NodeFS.existsSync(receiptFile)
      ? sha256(NodeFS.readFileSync(receiptFile))
      : undefined,
    packageRecord: readJson(NodePath.join(dir("package-record"), "package.json")),
    packageFiles: artifacts.filter((artifact) => artifact.path.startsWith(packagePrefix)),
    artifacts,
  });
  const manifestFile = NodePath.join(options.out, "factory-build-manifest.json");
  writeJson(manifestFile, manifest);
  const digest = sha256(NodeFS.readFileSync(manifestFile));
  NodeFS.writeFileSync(`${manifestFile}.sha256`, `${digest}  factory-build-manifest.json\n`);
  console.log(`Manifest ${digest}: ${manifest.status}`);
  for (const failure of manifest.failures) console.error(`- ${failure}`);
  if (manifest.status !== "passed") process.exitCode = 1;
}

export function windowsSmokeEnvironment(
  inherited: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        ([key]) =>
          !/^(T3CODE_|VITE_|ELECTRON_|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$)/i.test(key),
      ),
    ),
    HOME: home,
    USERPROFILE: home,
    APPDATA: NodePath.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
  };
}

const PROTOCOL_HANDLER_KEY = `HKCU\\Software\\Classes\\${FACTORY_PREVIEW_IDENTITY.scheme}`;

interface ProtocolHandlerSnapshot {
  readonly key: string;
  readonly file: string;
  /** The `reg export` of the key held in `file`; null when the key did not exist. */
  readonly before: Buffer | null;
}

/** The reg.exe calls that bring the handler key back to its snapshot, given its current export. */
export function protocolHandlerRestoreSteps(
  snapshot: ProtocolHandlerSnapshot,
  current: Buffer | null,
  importTried: boolean,
) {
  const remove = ["delete", snapshot.key, "/f"];
  if (snapshot.before === null) return current === null ? [] : [remove];
  if (current !== null && snapshot.before.equals(current)) return [];
  const restore = ["import", snapshot.file];
  // Import keeps the key and its permissions; only what it cannot remove needs the delete.
  return importTried && current !== null ? [remove, restore] : [restore];
}

/** Whether `reg query` output lists `name` as a subkey; values are indented, key paths are not. */
export function regQueryListsSubkey(output: string, name: string) {
  const wanted = `\\${name.toLowerCase()}`;
  const keys = output.split("\n").filter((line) => line.startsWith("HKEY_"));
  return keys.some((key) => key.trimEnd().toLowerCase().endsWith(wanted));
}

function runReg(args: ReadonlyArray<string>) {
  const reg = NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  const result = NodeChildProcess.spawnSync(reg, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Listing HKCU\Software\Classes can outgrow spawnSync's 1 MiB default.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0) return { stdout: result.stdout, failure: undefined };
  const failure =
    result.error?.message ??
    (result.stderr.trim() || `reg.exe exited ${String(result.status ?? result.signal)}`);
  return { stdout: "", failure };
}

/** Exports the key to `file`; null only when its parent's listing shows it is absent. */
function exportProtocolHandler(key: string, file: string) {
  const query = runReg(["query", key]);
  if (query.failure !== undefined) {
    // reg.exe exits 1 on any failure, so only the parent's listing proves the key is absent.
    const parent = NodePath.win32.dirname(key);
    const listing = runReg(["query", parent]);
    if (listing.failure !== undefined) {
      throw new Error(`reg.exe could not list ${parent}: ${listing.failure}`);
    }
    if (regQueryListsSubkey(listing.stdout, NodePath.win32.basename(key))) {
      throw new Error(`reg.exe could not read ${key}: ${query.failure}`);
    }
    return null;
  }
  const exported = runReg(["export", key, file, "/y"]);
  if (exported.failure !== undefined) {
    throw new Error(`reg.exe could not export ${key}: ${exported.failure}`);
  }
  return NodeFS.readFileSync(file);
}

/** Reports a failed restore instead of throwing, so the smoke's own result or error stands. */
function restoreProtocolHandler(snapshot: ProtocolHandlerSnapshot, scratch: string) {
  try {
    const failures: string[] = [];
    for (const importTried of [false, true]) {
      const current = exportProtocolHandler(snapshot.key, scratch);
      const steps = protocolHandlerRestoreSteps(snapshot, current, importTried);
      if (steps.length === 0) return;
      for (const args of steps) {
        const { failure } = runReg(args);
        if (failure !== undefined) failures.push(`reg ${args.join(" ")}: ${failure}`);
      }
      // After a failed import, the delete would only leave the key missing.
      if (failures.length > 0) break;
    }
    const restored = exportProtocolHandler(snapshot.key, scratch);
    if (protocolHandlerRestoreSteps(snapshot, restored, true).length > 0) {
      throw new Error(failures.join("; ") || "it still differs from before the smoke");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Could not restore ${snapshot.key} after the smoke: ${reason}`);
    if (snapshot.before === null) {
      console.error("It did not exist before the smoke; delete it.");
    } else {
      const exported = snapshot.before.toString("utf16le").trim();
      console.error(`Before the smoke it held this; import it as a .reg file:\n${exported}`);
    }
  }
}

function runSmoke(options: { package: string; sha256: string; artifactsDir: string }) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Dependency-free control script; no Effect runtime to inject.
  if (NodeOS.platform() !== "win32") throw new Error("The T3Factory ZIP smoke runs on Windows");
  const zip = NodePath.resolve(options.package);
  const digest = sha256(NodeFS.readFileSync(zip));
  if (digest !== options.sha256)
    throw new Error(`${zip} hashes to ${digest}, not ${options.sha256}`);
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3factory-smoke-"));
  let handler: ProtocolHandlerSnapshot | undefined;
  try {
    // System tar (bsdtar) reads ZIPs; Git Bash's GNU tar does not.
    const tar = NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    NodeChildProcess.execFileSync(tar, ["-xf", zip, "-C", dir], { stdio: "inherit" });
    const exe = `${FACTORY_PREVIEW_IDENTITY.productName}.exe`;
    const found = [
      dir,
      ...NodeFS.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => NodePath.join(dir, entry.name)),
    ]
      .map((appDir) => NodePath.join(appDir, exe))
      .filter((file) => NodeFS.existsSync(file));
    if (found.length !== 1) throw new Error(`${zip} holds ${found.length} copies of ${exe}`);
    const monitor = NodePath.join(
      NodePath.dirname(found[0]!),
      "resources",
      "resource-monitor",
      "t3-resource-monitor.exe",
    );
    if (!NodeFS.existsSync(monitor)) throw new Error(`${zip} has no bundled resource monitor`);
    // The app registers its URL handler in HKCU, which the redirected profile does not cover.
    const saved = NodePath.join(dir, "handler-before.reg");
    handler = {
      key: PROTOCOL_HANDLER_KEY,
      file: saved,
      before: exportProtocolHandler(PROTOCOL_HANDLER_KEY, saved),
    };
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(root, "scripts", "smoke-desktop-app.ts"),
        "--executable",
        found[0]!,
        "--artifacts-dir",
        NodePath.resolve(options.artifactsDir),
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: windowsSmokeEnvironment(process.env, NodePath.join(dir, "home")),
      },
    );
    if (result.status !== 0) throw new Error(`Desktop launch smoke failed for ${zip}`);
    console.log(`Smoke passed for ${NodePath.basename(zip)} (${digest}).`);
  } finally {
    if (handler) restoreProtocolHandler(handler, NodePath.join(dir, "handler-now.reg"));
    cleanupSmokeDirectory(dir);
  }
}

async function runRecord(options: {
  receipt: string;
  repository: string;
  base: string;
  kind: string;
  argv: ReadonlyArray<string>;
}) {
  if (!PACKAGE_COMMAND_KINDS.includes(options.kind as PackageCommandKind)) {
    throw new Error(`--kind must be one of ${PACKAGE_COMMAND_KINDS.join(", ")}`);
  }
  if (!REPOSITORY_PATTERN.test(options.repository))
    throw new Error("--repository must be owner/name");
  if (options.argv.length === 0) throw new Error("Pass the command after --");
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Dependency-free control script; no Effect runtime to inject.
  const platform = { os: NodeOS.platform(), arch: NodeOS.arch(), release: NodeOS.release() };
  if (platform.os !== "win32" || platform.arch !== "x64") {
    throw new Error("Record the packaging receipt on Windows x64");
  }
  const root = NodePath.resolve(git(process.cwd(), ["rev-parse", "--show-toplevel"]));
  const receiptFile = NodePath.resolve(options.receipt);
  if (isInside(root, receiptFile)) {
    throw new Error("Keep the receipt outside the candidate worktree so it stays clean");
  }
  const head = requireCleanCandidate(root);
  if (
    !SHA_PATTERN.test(options.base) ||
    options.base === head ||
    !gitSucceeds(root, ["merge-base", "--is-ancestor", options.base, head])
  ) {
    throw new Error(`--base ${options.base} must be a full SHA and a strict ancestor of HEAD`);
  }
  const pins = readToolchainPins(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"));
  const toolchain = { node: process.version.slice(1), pnpm: pnpmVersion(root) };
  if (toolchain.node !== pins.node || toolchain.pnpm !== pins.pnpm) {
    throw new Error(
      `Running node ${toolchain.node}/pnpm ${toolchain.pnpm}; pinned ${pins.node}/${pins.pnpm}. Use vp env exec.`,
    );
  }
  const existing = NodeFS.existsSync(receiptFile)
    ? (JSON.parse(NodeFS.readFileSync(receiptFile, "utf8")) as PackageReceipt)
    : undefined;
  if (
    existing &&
    (existing.schema !== PACKAGE_RECEIPT_SCHEMA ||
      existing.repository !== options.repository ||
      existing.candidateSha !== head ||
      existing.baseSha !== options.base ||
      JSON.stringify(existing.toolchain) !== JSON.stringify(toolchain) ||
      JSON.stringify(existing.platform) !== JSON.stringify(platform))
  ) {
    throw new Error(`${receiptFile} records another candidate, base, toolchain or platform`);
  }
  let windowsPrerequisites = existing?.windowsPrerequisites ?? null;
  let packageFile = existing?.package ?? null;
  let outputDir: string | undefined;
  if (options.kind === "package") {
    if (packageFile)
      throw new Error(`${receiptFile} already records a package; start a new receipt`);
    const argvErrors = packageArgvErrors(options.argv);
    if (argvErrors.length > 0) throw new Error(`Package command ${argvErrors.join("; ")}`);
    outputDir = NodePath.resolve(root, flagValue(options.argv, "--output-dir")!);
    if (isInside(root, outputDir))
      throw new Error("Keep --output-dir outside the candidate worktree");
    if (NodeFS.existsSync(outputDir) && NodeFS.readdirSync(outputDir).length > 0) {
      throw new Error(`--output-dir ${outputDir} must be empty so its ZIP is unambiguous`);
    }
    windowsPrerequisites = probeWindowsPrerequisites();
    const errors = windowsPrerequisiteErrors(windowsPrerequisites);
    if (errors.length > 0) {
      throw new Error(`Windows prerequisites are incomplete:\n- ${errors.join("\n- ")}`);
    }
  }
  if (options.kind === "smoke" && flagValue(options.argv, "--sha256") !== packageFile?.sha256) {
    throw new Error("Record the package first, then smoke it with --sha256 <its recorded SHA-256>");
  }
  const commands = existing?.commands ?? [];
  const logFile = `${receiptFile}.logs/${String(commands.length + 1).padStart(2, "0")}-${options.kind}.log`;
  const result = await runLogged(options.argv, root, logFile);
  requireCleanCandidate(root, head);
  if (outputDir && result.exitCode === 0) packageFile = packageOutput(outputDir);
  const receipt: PackageReceipt = {
    schema: PACKAGE_RECEIPT_SCHEMA,
    evidence: "dispatcher-declared",
    repository: options.repository,
    candidateSha: head,
    baseSha: options.base,
    worktreeClean: true,
    toolchain,
    platform,
    windowsPrerequisites,
    recordedAt: new Date().toISOString(),
    commands: [
      ...commands,
      { kind: options.kind as PackageCommandKind, argv: [...options.argv], ...result },
    ],
    package: packageFile,
  };
  writeJson(receiptFile, receipt);
  console.log(
    `Recorded ${options.kind} (exit ${result.exitCode}) in ${receiptFile}; output ${logFile}`,
  );
  if (packageFile && outputDir) console.log(`Package ${packageFile.file}: ${packageFile.sha256}`);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

function runFinalize(options: { receipt: string; ref: string }) {
  const receiptFile = NodePath.resolve(options.receipt);
  const bytes = NodeFS.readFileSync(receiptFile);
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const parsed = rec(JSON.parse(bytes.toString("utf8")));
  const head = requireCleanCandidate(root);
  const validation = validatePackageReceipt(bytes, sha256(bytes), {
    repository: String(parsed.repository),
    candidateSha: head,
    baseSha: String(parsed.baseSha),
    toolchain: readToolchainPins(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8")),
  });
  if (!validation.receipt) {
    throw new Error(`Receipt is not dispatchable:\n- ${validation.errors.join("\n- ")}`);
  }
  const encodedFile = `${receiptFile}.b64`;
  NodeFS.writeFileSync(encodedFile, bytes.toString("base64"));
  console.log(`Receipt SHA-256: ${validation.sha256}`);
  console.log(`Package ${validation.receipt.package?.file}: ${validation.receipt.package?.sha256}`);
  console.log("Dispatch only after reviewing this evidence (not run by this script):");
  console.log(
    [
      `gh workflow run factory-build.yml --repo ${validation.receipt.repository} --ref <trusted-branch>`,
      `-f candidate_sha=${head} -f base_sha=${validation.receipt.baseSha}`,
      `-f candidate_ref=${options.ref}`,
      "-f validation_run_id=<factory-check run ID> -f validation_run_attempt=<its current attempt>",
      "-f validation_control_sha=<that run's head SHA>",
      "-f validation_manifest_sha256=<SHA-256 in factory-check-manifest.json.sha256>",
      `-f package_receipt_sha256=${validation.sha256}`,
      `-f package_receipt_b64="$(cat '${encodedFile}')"`,
    ].join(" \\\n  "),
  );
}

const USAGE = `Usage:
  node scripts/factory-build.ts record --receipt <file> --repository <owner/name> --base <sha> --kind <${PACKAGE_COMMAND_KINDS.join("|")}> -- <command...>
  node scripts/factory-build.ts smoke --package <zip> --sha256 <digest> [--artifacts-dir <dir>]
  node scripts/factory-build.ts finalize --receipt <file> --ref <candidate branch or tag>
  node scripts/factory-build.ts prerequisites
Workflow-only: verify, package-record, manifest (see .github/workflows/factory-build.yml).`;

async function main(argv: ReadonlyArray<string>) {
  const separator = argv.indexOf("--");
  const { values, positionals } = NodeUtil.parseArgs({
    args: separator === -1 ? [...argv] : argv.slice(0, separator),
    allowPositionals: true,
    options: {
      receipt: { type: "string" },
      repository: { type: "string" },
      base: { type: "string" },
      kind: { type: "string" },
      ref: { type: "string" },
      package: { type: "string" },
      sha256: { type: "string" },
      "artifacts-dir": {
        type: "string",
        default: NodePath.join(NodeOS.tmpdir(), "t3factory-smoke-diagnostics"),
      },
      "candidate-dir": { type: "string", default: "candidate" },
      "package-dir": { type: "string" },
      evidence: { type: "string" },
      out: { type: "string" },
    },
  });
  const need = (name: keyof typeof values) => {
    const value = values[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`--${name} is required\n${USAGE}`);
    }
    return value;
  };
  switch (positionals[0]) {
    case "record":
      return runRecord({
        receipt: need("receipt"),
        repository: need("repository"),
        base: need("base"),
        kind: need("kind"),
        argv: separator === -1 ? [] : argv.slice(separator + 1),
      });
    case "smoke":
      return runSmoke({
        package: need("package"),
        sha256: need("sha256"),
        artifactsDir: need("artifacts-dir"),
      });
    case "finalize":
      return runFinalize({ receipt: need("receipt"), ref: need("ref") });
    case "prerequisites":
      return console.log(JSON.stringify(probeWindowsPrerequisites()));
    case "verify":
      return runVerify({ candidateDir: need("candidate-dir"), out: need("out") });
    case "package-record":
      return runPackageRecord({
        candidateDir: need("candidate-dir"),
        packageDir: need("package-dir"),
        out: need("out"),
      });
    case "manifest":
      return runBuildManifest({ evidence: need("evidence"), out: need("out") });
    default:
      throw new Error(USAGE);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
