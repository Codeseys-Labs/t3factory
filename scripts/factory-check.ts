// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - factory-check.yml runs this from the control checkout before any install.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export const RECEIPT_SCHEMA = "t3factory.local-evidence/v1";
export const RESOLVE_SCHEMA = "t3factory.check-resolve/v1";
export const LANE_SCHEMA = "t3factory.check-lane/v1";
export const MANIFEST_SCHEMA = "t3factory.check-manifest/v1";
export const CHECK_WORKFLOW_PATH = ".github/workflows/factory-check.yml";
export const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_COMMANDS = 32;
const MAX_ARGV = 64;
const MAX_ARG_CHARS = 512;

// Each lane is a factory-check.yml job gated by its `lane_<name>` boolean input.
export const CHECK_LANES = [
  "lint",
  "build",
  "test",
  "test_web",
  "test_server",
  "rust",
  "release_smoke",
  "windows",
] as const;
export type CheckLane = (typeof CHECK_LANES)[number];

// Inherited CI coverage with no hosted runner here. Listed in every manifest as not run.
export const UNSUPPORTED_LANES = [
  {
    name: "mobile_native_static_analysis",
    reason: "Needs a macOS runner; factory-check provisions only ubuntu-24.04 and windows-2025.",
  },
] as const;

export const COMMAND_KINDS = ["check-changed", "test", "build-desktop"] as const;
type CommandKind = (typeof COMMAND_KINDS)[number];

export const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface ToolchainPins {
  readonly node: string;
  readonly pnpm: string;
}

export interface ReceiptCommand {
  readonly kind: CommandKind;
  readonly argv: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly outputSha256: string;
}

export interface LocalReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly evidence: "dispatcher-declared";
  readonly repository: string;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly worktreeClean: true;
  readonly toolchain: ToolchainPins;
  readonly platform: { readonly os: string; readonly arch: string; readonly release: string };
  readonly recordedAt: string;
  readonly commands: ReadonlyArray<ReceiptCommand>;
}

export interface ReceiptExpectation {
  readonly repository: string;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly toolchain: ToolchainPins;
}

export interface ResolveRecord {
  readonly schema: typeof RESOLVE_SCHEMA;
  readonly repository: string;
  readonly candidate: {
    readonly sha: string;
    readonly ref: string;
    readonly refKind: "branch" | "tag";
    readonly refSha: string;
  };
  readonly baseSha: string;
  readonly toolchainPins: ToolchainPins;
  readonly runAttempt: string;
  readonly localEvidence: {
    readonly evidence: "dispatcher-declared";
    readonly attested: false;
    readonly sha256: string;
    readonly bytes: number;
    readonly receipt: LocalReceipt;
  };
}

export interface LaneRecord {
  readonly schema: typeof LANE_SCHEMA;
  readonly lane: string;
  readonly shard: { readonly index: number; readonly total: number };
  readonly candidateHead: string;
  readonly runAttempt: string;
  readonly toolchain: ToolchainPins;
  readonly runner: Readonly<Record<string, string>>;
}

export interface ArtifactDigest {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface CheckRunContext {
  readonly repository: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly eventName: string;
  readonly ref: string;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export function unknownKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

export function readToolchainPins(packageJson: string): ToolchainPins {
  const parsed: unknown = JSON.parse(packageJson);
  if (!isRecord(parsed)) throw new Error("package.json is not an object");
  const node = isRecord(parsed.engines) ? parsed.engines.node : undefined;
  const manager = typeof parsed.packageManager === "string" ? parsed.packageManager : "";
  const pnpm = manager.startsWith("pnpm@") ? manager.slice(5).split("+")[0] : undefined;
  if (typeof node !== "string" || !VERSION_PATTERN.test(node)) {
    throw new Error(`package.json engines.node must be an exact version, got ${String(node)}`);
  }
  if (!pnpm || !VERSION_PATTERN.test(pnpm)) {
    throw new Error(`package.json packageManager must pin pnpm@x.y.z, got ${manager || "nothing"}`);
  }
  return { node, pnpm };
}

export function decodeReceiptInput(base64: string): Buffer {
  if (base64.length === 0) throw new Error("local_receipt_b64 is empty");
  if (base64.length > Math.ceil(MAX_RECEIPT_BYTES / 3) * 4) {
    throw new Error(`local_receipt_b64 exceeds ${MAX_RECEIPT_BYTES} decoded bytes`);
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) {
    throw new Error("local_receipt_b64 is not canonical base64");
  }
  return bytes;
}

function commandErrors(value: unknown, index: number, baseSha: string): string[] {
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
  const kind = value.kind;
  if (!COMMAND_KINDS.includes(kind as CommandKind)) errors.push(`${at}.kind is not recognized`);
  const argv = value.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.length > MAX_ARGV ||
    !argv.every((arg) => typeof arg === "string" && arg.length > 0 && arg.length <= MAX_ARG_CHARS)
  ) {
    errors.push(`${at}.argv must hold 1-${MAX_ARGV} non-empty strings`);
  } else if (
    kind === "check-changed" &&
    !(argv.includes("check:changed") && argv.includes(baseSha))
  ) {
    errors.push(`${at} must run check:changed against the base SHA`);
  } else if (kind === "build-desktop" && !argv.includes("build:desktop")) {
    errors.push(`${at} must run build:desktop`);
  }
  if (value.exitCode !== 0)
    errors.push(`${at} (${String(kind)}) did not pass: exit ${String(value.exitCode)}`);
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

/** Checks the receipt bytes against their declared digest and the candidate they must describe. */
export function validateReceipt(
  bytes: Uint8Array,
  declaredSha256: string,
  expected: ReceiptExpectation,
): { readonly receipt?: LocalReceipt; readonly sha256: string; readonly errors: string[] } {
  const digest = sha256(bytes);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECEIPT_BYTES) {
    return { sha256: digest, errors: [`receipt must be 1-${MAX_RECEIPT_BYTES} bytes`] };
  }
  if (!DIGEST_PATTERN.test(declaredSha256)) {
    return { sha256: digest, errors: ["declared receipt digest must be a lowercase SHA-256"] };
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
    "recordedAt",
    "commands",
  ]).map((key) => `receipt has unknown field ${key}`);
  if (parsed.schema !== RECEIPT_SCHEMA) errors.push(`receipt schema must be ${RECEIPT_SCHEMA}`);
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
  if (parsed.baseSha === parsed.candidateSha)
    errors.push("receipt base must differ from candidate");
  if (parsed.worktreeClean !== true) errors.push("receipt was not recorded from a clean worktree");
  const toolchain = isRecord(parsed.toolchain) ? parsed.toolchain : {};
  for (const tool of ["node", "pnpm"] as const) {
    if (toolchain[tool] !== expected.toolchain[tool]) {
      errors.push(
        `receipt ${tool} ${String(toolchain[tool])} is not the pinned ${expected.toolchain[tool]}`,
      );
    }
  }
  const platform = isRecord(parsed.platform) ? parsed.platform : {};
  if (
    !["win32", "linux", "darwin"].includes(platform.os as string) ||
    typeof platform.arch !== "string" ||
    typeof platform.release !== "string"
  ) {
    errors.push("receipt platform must declare os (win32, linux or darwin), arch and release");
  }
  if (typeof parsed.recordedAt !== "string" || Number.isNaN(Date.parse(parsed.recordedAt))) {
    errors.push("receipt recordedAt must be an ISO timestamp");
  }
  const commands = parsed.commands;
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_COMMANDS) {
    errors.push(`receipt must list 1-${MAX_COMMANDS} commands`);
  } else {
    commands.forEach((command, index) =>
      errors.push(...commandErrors(command, index, expected.baseSha)),
    );
    for (const kind of COMMAND_KINDS) {
      if (!commands.some((command) => isRecord(command) && command.kind === kind)) {
        errors.push(`receipt has no ${kind} command`);
      }
    }
  }
  return errors.length > 0
    ? { sha256: digest, errors }
    : { receipt: parsed as unknown as LocalReceipt, sha256: digest, errors };
}

export function laneShardErrors(
  lane: string,
  records: ReadonlyArray<{ readonly shard: LaneRecord["shard"] }>,
): string[] {
  if (records.length === 0) return [`lane ${lane} produced no lane record`];
  const total = records[0]!.shard.total;
  const indexes = new Set(records.map((record) => record.shard.index));
  const complete =
    records.every((record) => record.shard.total === total) &&
    indexes.size === records.length &&
    records.length === total &&
    [...indexes].every((index) => index >= 1 && index <= total);
  return complete ? [] : [`lane ${lane} lane records do not cover shards 1-${total} exactly once`];
}

/** Decides the aggregate result and builds the versioned manifest. Any failure fails the run. */
export function evaluateCheckRun(input: {
  readonly context: CheckRunContext;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly needs: Readonly<Record<string, { readonly result?: string } | undefined>>;
  readonly resolve: ResolveRecord | undefined;
  readonly receiptSha256: string | undefined;
  readonly laneRecords: ReadonlyArray<LaneRecord>;
  readonly artifacts: ReadonlyArray<ArtifactDigest>;
}) {
  const { context, inputs, needs, resolve } = input;
  const failures: string[] = [];
  const candidateSha = String(inputs.candidate_sha ?? "");
  const baseSha = String(inputs.base_sha ?? "");
  const declaredDigest = String(inputs.local_receipt_sha256 ?? "");

  if (context.eventName !== "workflow_dispatch") {
    failures.push(`event ${context.eventName} is not workflow_dispatch`);
  }
  if (!context.workflowRef.startsWith(`${context.repository}/${CHECK_WORKFLOW_PATH}@`)) {
    failures.push(
      `workflow ${context.workflowRef} is not ${context.repository}/${CHECK_WORKFLOW_PATH}`,
    );
  }
  if (!SHA_PATTERN.test(context.workflowSha)) failures.push("workflow SHA is not a commit SHA");
  if (!/^[1-9]\d*$/.test(context.runId) || !/^[1-9]\d*$/.test(context.runAttempt)) {
    failures.push("run ID and attempt must be positive integers");
  }
  if (!SHA_PATTERN.test(candidateSha) || !SHA_PATTERN.test(baseSha)) {
    failures.push("candidate_sha and base_sha must be 40-character lowercase SHAs");
  }

  if (needs.resolve?.result !== "success") {
    failures.push(`resolve result is ${needs.resolve?.result ?? "missing"}`);
  }
  if (!resolve) {
    failures.push("resolve record is missing");
  } else {
    if (resolve.schema !== RESOLVE_SCHEMA) failures.push("resolve record schema is not recognized");
    if (resolve.repository !== context.repository)
      failures.push("resolve record names another repository");
    if (resolve.candidate.sha !== candidateSha)
      failures.push("resolve record names another candidate");
    if (resolve.candidate.ref !== inputs.candidate_ref)
      failures.push("resolve record names another candidate ref");
    if (resolve.baseSha !== baseSha) failures.push("resolve record names another base");
    if (resolve.runAttempt !== context.runAttempt)
      failures.push("resolve record is from another run attempt");
    if (resolve.localEvidence.sha256 !== declaredDigest) {
      failures.push("resolve record names another local receipt");
    }
    if (
      resolve.localEvidence.attested !== false ||
      resolve.localEvidence.evidence !== "dispatcher-declared"
    ) {
      failures.push("local evidence must stay labelled dispatcher-declared and unattested");
    }
  }
  if (input.receiptSha256 !== declaredDigest) {
    failures.push(
      `uploaded receipt hashes to ${input.receiptSha256 ?? "nothing"}, not ${declaredDigest}`,
    );
  }

  const knownJobs = new Set<string>(["resolve", ...CHECK_LANES]);
  for (const job of Object.keys(needs)) {
    if (!knownJobs.has(job)) failures.push(`aggregate needs unknown job ${job}`);
  }
  const lanes = CHECK_LANES.map((lane) => {
    const requested = inputs[`lane_${lane}`] === true || inputs[`lane_${lane}`] === "true";
    const result = needs[lane]?.result ?? "missing";
    const records = input.laneRecords.filter((record) => record.lane === lane);
    if (result === "missing") {
      failures.push(`lane ${lane} is missing from the aggregate`);
    } else if (requested && result !== "success") {
      failures.push(
        `required lane ${lane} ${result === "skipped" ? "was skipped" : `result is ${result}`}`,
      );
    } else if (!requested && result !== "skipped") {
      failures.push(`lane ${lane} was not requested but its result is ${result}`);
    }
    if (requested) {
      failures.push(...laneShardErrors(lane, records));
      for (const record of records) {
        const at = `lane ${lane} shard ${record.shard.index}`;
        if (record.schema !== LANE_SCHEMA) failures.push(`${at} record schema is not recognized`);
        if (record.candidateHead !== candidateSha)
          failures.push(`${at} tested ${record.candidateHead}`);
        if (record.runAttempt !== context.runAttempt)
          failures.push(`${at} record is from another run attempt`);
        if (resolve) {
          for (const tool of ["node", "pnpm"] as const) {
            if (record.toolchain[tool] !== resolve.toolchainPins[tool]) {
              failures.push(
                `${at} ran ${tool} ${record.toolchain[tool]}, pinned ${resolve.toolchainPins[tool]}`,
              );
            }
          }
        }
      }
    }
    return {
      name: lane,
      requested,
      result,
      runs: records.map((record) => ({
        shard: record.shard,
        toolchain: record.toolchain,
        runner: record.runner,
      })),
    };
  });
  if (!lanes.some((lane) => lane.requested)) failures.push("no lane was requested");

  const manifest = {
    schema: MANIFEST_SCHEMA,
    status: failures.length === 0 ? ("passed" as const) : ("failed" as const),
    failures,
    repository: context.repository,
    workflow: { path: CHECK_WORKFLOW_PATH, ref: context.workflowRef, sha: context.workflowSha },
    run: {
      id: context.runId,
      attempt: context.runAttempt,
      event: context.eventName,
      dispatchRef: context.ref,
    },
    candidate: {
      sha: candidateSha,
      ref: String(inputs.candidate_ref ?? ""),
      refKind: resolve?.candidate.refKind ?? null,
      refSha: resolve?.candidate.refSha ?? null,
    },
    baseSha,
    toolchain: { pinned: resolve?.toolchainPins ?? null },
    lanes,
    unsupportedLanes: UNSUPPORTED_LANES.map((lane) => ({ ...lane, result: "not-run" })),
    localEvidence: resolve
      ? {
          evidence: "dispatcher-declared",
          attested: false,
          note: "Declared by the dispatcher from a local run; not independently verified.",
          sha256: resolve.localEvidence.sha256,
          bytes: resolve.localEvidence.bytes,
          receipt: resolve.localEvidence.receipt,
        }
      : null,
    artifacts: input.artifacts,
  };
  return manifest;
}

export function git(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function gitSucceeds(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}

function resolveRefName(cwd: string, ref: string): { kind: "branch" | "tag"; sha: string } {
  if (
    ref.length === 0 ||
    ref.startsWith("refs/") ||
    ref.startsWith("-") ||
    SHA_PATTERN.test(ref) ||
    !gitSucceeds(cwd, ["check-ref-format", `refs/heads/${ref}`])
  ) {
    throw new Error(`candidate_ref ${ref} must be a branch or tag name, not a SHA or full ref`);
  }
  const found = (
    [
      ["branch", `refs/remotes/origin/${ref}`],
      ["tag", `refs/tags/${ref}`],
    ] as const
  ).flatMap(([kind, full]) =>
    gitSucceeds(cwd, ["rev-parse", "--verify", "--quiet", `${full}^{commit}`])
      ? [{ kind, sha: git(cwd, ["rev-parse", `${full}^{commit}`]) }]
      : [],
  );
  if (found.length !== 1) {
    throw new Error(
      found.length === 0
        ? `candidate_ref ${ref} is not a branch or tag of this repository`
        : `candidate_ref ${ref} names both a branch and a tag`,
    );
  }
  return found[0]!;
}

/** Proves the candidate checkout is the requested commit, reachable from its ref, and descends from base. */
export function resolveCandidate(
  cwd: string,
  request: {
    readonly candidateSha: string;
    readonly baseSha: string;
    readonly candidateRef: string;
  },
) {
  const { candidateSha, baseSha, candidateRef } = request;
  if (!SHA_PATTERN.test(candidateSha))
    throw new Error("candidate_sha must be a 40-character lowercase SHA");
  if (!SHA_PATTERN.test(baseSha)) throw new Error("base_sha must be a 40-character lowercase SHA");
  if (candidateSha === baseSha) throw new Error("base_sha must differ from candidate_sha");
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (head !== candidateSha)
    throw new Error(`candidate checkout is at ${head}, not ${candidateSha}`);
  const ref = resolveRefName(cwd, candidateRef);
  if (!gitSucceeds(cwd, ["merge-base", "--is-ancestor", candidateSha, ref.sha])) {
    throw new Error(`candidate ${candidateSha} is not reachable from ${ref.kind} ${candidateRef}`);
  }
  if (!gitSucceeds(cwd, ["cat-file", "-e", `${baseSha}^{commit}`])) {
    throw new Error(`base ${baseSha} is not a commit in this repository`);
  }
  if (!gitSucceeds(cwd, ["merge-base", "--is-ancestor", baseSha, candidateSha])) {
    throw new Error(`base ${baseSha} is not an ancestor of candidate ${candidateSha}`);
  }
  return { sha: candidateSha, ref: candidateRef, refKind: ref.kind, refSha: ref.sha };
}

export function pnpmVersion(cwd: string) {
  const result = NodeChildProcess.spawnSync("vp", ["env", "exec", "--", "pnpm", "--version"], {
    cwd,
    encoding: "utf8",
  });
  const version = result.status === 0 ? result.stdout.trim() : "";
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Could not read the pnpm version: ${result.stderr || result.error?.message}`);
  }
  return version;
}

export function writeJson(file: string, value: unknown) {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function requireEnv(name: string) {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}

export function listFiles(dir: string): string[] {
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => NodePath.join(entry.parentPath, entry.name))
    .toSorted();
}

function runResolve(options: { candidateDir: string; out: string }) {
  const repository = requireEnv("GITHUB_REPOSITORY");
  const candidate = resolveCandidate(options.candidateDir, {
    candidateSha: requireEnv("CANDIDATE_SHA"),
    baseSha: requireEnv("BASE_SHA"),
    candidateRef: requireEnv("CANDIDATE_REF"),
  });
  const toolchainPins = readToolchainPins(
    NodeFS.readFileSync(NodePath.join(options.candidateDir, "package.json"), "utf8"),
  );
  const bytes = decodeReceiptInput(requireEnv("LOCAL_RECEIPT_B64"));
  const validation = validateReceipt(bytes, requireEnv("LOCAL_RECEIPT_SHA256"), {
    repository,
    candidateSha: candidate.sha,
    baseSha: requireEnv("BASE_SHA"),
    toolchain: toolchainPins,
  });
  if (!validation.receipt) {
    throw new Error(`Local receipt rejected:\n- ${validation.errors.join("\n- ")}`);
  }
  NodeFS.mkdirSync(options.out, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(options.out, "receipt.json"), bytes);
  const record: ResolveRecord = {
    schema: RESOLVE_SCHEMA,
    repository,
    candidate,
    baseSha: requireEnv("BASE_SHA"),
    toolchainPins,
    runAttempt: requireEnv("GITHUB_RUN_ATTEMPT"),
    localEvidence: {
      evidence: "dispatcher-declared",
      attested: false,
      sha256: validation.sha256,
      bytes: bytes.byteLength,
      receipt: validation.receipt,
    },
  };
  writeJson(NodePath.join(options.out, "resolve.json"), record);
  console.log(`Candidate ${candidate.sha} is on ${candidate.refKind} ${candidate.ref}.`);
  console.log(`Local receipt ${validation.sha256} accepted as dispatcher-declared evidence.`);
}

function runLaneRecord(options: {
  lane: string;
  shard: string;
  candidateDir: string;
  out: string;
}) {
  if (!CHECK_LANES.includes(options.lane as CheckLane))
    throw new Error(`Unknown lane ${options.lane}`);
  const [index, total] = options.shard.split("/").map(Number);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(total) ||
    index! < 1 ||
    index! > total!
  ) {
    throw new Error(`Invalid shard ${options.shard}`);
  }
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
  const record: LaneRecord = {
    schema: LANE_SCHEMA,
    lane: options.lane,
    shard: { index: index!, total: total! },
    candidateHead: git(options.candidateDir, ["rev-parse", "HEAD"]),
    runAttempt: requireEnv("GITHUB_RUN_ATTEMPT"),
    toolchain: { node: process.version.slice(1), pnpm: pnpmVersion(options.candidateDir) },
    runner,
  };
  writeJson(options.out, record);
  console.log(JSON.stringify(record, null, 2));
}

function runManifest(options: { evidence: string; out: string }) {
  const readJson = <T>(file: string): T | undefined =>
    NodeFS.existsSync(file) ? (JSON.parse(NodeFS.readFileSync(file, "utf8")) as T) : undefined;
  const files = listFiles(options.evidence);
  const artifacts = files.map((file) => {
    const bytes = NodeFS.readFileSync(file);
    return {
      path: NodePath.relative(options.evidence, file).split(NodePath.sep).join("/"),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    };
  });
  const resolveFiles = files.filter((file) => NodePath.basename(file) === "resolve.json");
  if (resolveFiles.length > 1) throw new Error("Evidence holds more than one resolve record");
  const receiptFile =
    resolveFiles[0] && NodePath.join(NodePath.dirname(resolveFiles[0]), "receipt.json");
  const manifest = evaluateCheckRun({
    context: {
      repository: requireEnv("GITHUB_REPOSITORY"),
      workflowRef: requireEnv("GITHUB_WORKFLOW_REF"),
      workflowSha: requireEnv("GITHUB_WORKFLOW_SHA"),
      runId: requireEnv("GITHUB_RUN_ID"),
      runAttempt: requireEnv("GITHUB_RUN_ATTEMPT"),
      eventName: requireEnv("GITHUB_EVENT_NAME"),
      ref: requireEnv("GITHUB_REF"),
    },
    inputs: JSON.parse(requireEnv("FACTORY_INPUTS")),
    needs: JSON.parse(requireEnv("FACTORY_NEEDS")),
    resolve: resolveFiles[0] ? readJson<ResolveRecord>(resolveFiles[0]) : undefined,
    receiptSha256:
      receiptFile && NodeFS.existsSync(receiptFile)
        ? sha256(NodeFS.readFileSync(receiptFile))
        : undefined,
    laneRecords: files
      .filter((file) => NodePath.basename(file) === "lane.json")
      .map((file) => readJson<LaneRecord>(file)!),
    artifacts,
  });
  const manifestFile = NodePath.join(options.out, "factory-check-manifest.json");
  writeJson(manifestFile, manifest);
  const digest = sha256(NodeFS.readFileSync(manifestFile));
  NodeFS.writeFileSync(`${manifestFile}.sha256`, `${digest}  factory-check-manifest.json\n`);
  console.log(`Manifest ${digest}: ${manifest.status}`);
  for (const failure of manifest.failures) console.error(`- ${failure}`);
  if (manifest.status !== "passed") process.exitCode = 1;
}

export function isInside(root: string, file: string) {
  const relative = NodePath.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

export function requireCleanCandidate(root: string, expectedHead?: string) {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (expectedHead && head !== expectedHead)
    throw new Error(`HEAD moved from ${expectedHead} to ${head}`);
  const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error(`Worktree is not clean:\n${status}`);
  return head;
}

/** Runs one command in `cwd`, teeing its output to `logFile`, and digests that output. */
export async function runLogged(argv: ReadonlyArray<string>, cwd: string, logFile: string) {
  NodeFS.mkdirSync(NodePath.dirname(logFile), { recursive: true });
  const log = NodeFS.createWriteStream(logFile);
  const started = performance.now();
  const child = NodeChildProcess.spawn(argv[0]!, argv.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const [stream, sink] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    stream.on("data", (chunk: Buffer) => {
      log.write(chunk);
      sink.write(chunk);
    });
  }
  const exited = Promise.withResolvers<number>();
  child.on("error", exited.reject);
  child.on("close", (code) => exited.resolve(code ?? 1));
  const flushed = Promise.withResolvers<void>();
  const exitCode = await exited.promise.finally(() => {
    log.end(flushed.resolve);
    return flushed.promise;
  });
  const output = NodeFS.readFileSync(logFile);
  return {
    exitCode,
    durationMs: Math.round(performance.now() - started),
    outputBytes: output.byteLength,
    outputSha256: sha256(output),
  };
}

async function runRecord(options: {
  receipt: string;
  repository: string;
  base: string;
  kind: string;
  argv: ReadonlyArray<string>;
}) {
  if (!COMMAND_KINDS.includes(options.kind as CommandKind)) {
    throw new Error(`--kind must be one of ${COMMAND_KINDS.join(", ")}`);
  }
  if (!REPOSITORY_PATTERN.test(options.repository))
    throw new Error("--repository must be owner/name");
  if (options.argv.length === 0) throw new Error("Pass the command after --");
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const receiptFile = NodePath.resolve(options.receipt);
  if (isInside(NodePath.resolve(root), receiptFile)) {
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
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Dependency-free control script; no Effect runtime to inject.
  const platform = { os: NodeOS.platform(), arch: NodeOS.arch(), release: NodeOS.release() };
  const existing = NodeFS.existsSync(receiptFile)
    ? (JSON.parse(NodeFS.readFileSync(receiptFile, "utf8")) as LocalReceipt)
    : undefined;
  if (
    existing &&
    (existing.repository !== options.repository ||
      existing.candidateSha !== head ||
      existing.baseSha !== options.base ||
      JSON.stringify(existing.toolchain) !== JSON.stringify(toolchain) ||
      JSON.stringify(existing.platform) !== JSON.stringify(platform))
  ) {
    throw new Error(`${receiptFile} records another candidate, base, toolchain or platform`);
  }
  const commands = existing?.commands ?? [];
  const logFile = `${receiptFile}.logs/${String(commands.length + 1).padStart(2, "0")}-${options.kind}.log`;
  const result = await runLogged(options.argv, root, logFile);
  requireCleanCandidate(root, head);
  const receipt: LocalReceipt = {
    schema: RECEIPT_SCHEMA,
    evidence: "dispatcher-declared",
    repository: options.repository,
    candidateSha: head,
    baseSha: options.base,
    worktreeClean: true,
    toolchain,
    platform,
    recordedAt: new Date().toISOString(),
    commands: [
      ...commands,
      { kind: options.kind as CommandKind, argv: [...options.argv], ...result },
    ],
  };
  writeJson(receiptFile, receipt);
  console.log(
    `Recorded ${options.kind} (exit ${result.exitCode}) in ${receiptFile}; output ${logFile}`,
  );
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

function runFinalize(options: { receipt: string; ref: string }) {
  const receiptFile = NodePath.resolve(options.receipt);
  const bytes = NodeFS.readFileSync(receiptFile);
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const parsed = JSON.parse(bytes.toString("utf8")) as Partial<LocalReceipt>;
  const head = requireCleanCandidate(root);
  const validation = validateReceipt(bytes, sha256(bytes), {
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
  console.log(`Base64 receipt: ${encodedFile}`);
  console.log("Dispatch only after reviewing this evidence (not run by this script):");
  console.log(
    [
      `gh workflow run factory-check.yml --repo ${validation.receipt.repository} --ref <default-branch>`,
      `-f candidate_sha=${head} -f base_sha=${validation.receipt.baseSha}`,
      `-f candidate_ref=${options.ref}`,
      `-f local_receipt_sha256=${validation.sha256}`,
      `-f local_receipt_b64="$(cat '${encodedFile}')"`,
    ].join(" \\\n  "),
  );
}

const USAGE = `Usage:
  node scripts/factory-check.ts record --receipt <file> --repository <owner/name> --base <sha> --kind <${COMMAND_KINDS.join("|")}> -- <command...>
  node scripts/factory-check.ts finalize --receipt <file> --ref <candidate branch or tag>
Workflow-only: resolve, lane-record, manifest (see .github/workflows/factory-check.yml).`;

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
      lane: { type: "string" },
      shard: { type: "string", default: "1/1" },
      "candidate-dir": { type: "string", default: "candidate" },
      evidence: { type: "string" },
      out: { type: "string" },
    },
  });
  const need = (name: keyof typeof values) => {
    const value = values[name];
    if (typeof value !== "string" || value.length === 0)
      throw new Error(`--${name} is required\n${USAGE}`);
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
    case "finalize":
      return runFinalize({ receipt: need("receipt"), ref: need("ref") });
    case "resolve":
      return runResolve({ candidateDir: need("candidate-dir"), out: need("out") });
    case "lane-record":
      return runLaneRecord({
        lane: need("lane"),
        shard: need("shard"),
        candidateDir: need("candidate-dir"),
        out: need("out"),
      });
    case "manifest":
      return runManifest({ evidence: need("evidence"), out: need("out") });
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
