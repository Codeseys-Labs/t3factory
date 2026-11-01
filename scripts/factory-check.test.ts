// @effect-diagnostics nodeBuiltinImport:off - Builds disposable git repositories to prove candidate reachability checks.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  CHECK_LANES,
  decodeReceiptInput,
  evaluateCheckRun,
  type LaneRecord,
  type LocalReceipt,
  MAX_RECEIPT_BYTES,
  type ResolveRecord,
  resolveCandidate,
  validateReceipt,
} from "./factory-check.ts";

const candidateSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const toolchain = { node: "26.12.1", pnpm: "12.14.0" };
const expected = { repository: "owner/factory", candidateSha, baseSha, toolchain };
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

function receipt(overrides: Record<string, unknown> = {}) {
  const output = { exitCode: 0, durationMs: 1000, outputBytes: 10, outputSha256: "c".repeat(64) };
  return {
    schema: "t3factory.local-evidence/v1",
    evidence: "dispatcher-declared",
    repository: "owner/factory",
    candidateSha,
    baseSha,
    worktreeClean: true,
    toolchain,
    platform: { os: "win32", arch: "x64", release: "10.0.22631" },
    recordedAt: "2026-11-01T22:00:00.000Z",
    commands: [
      { kind: "check-changed", argv: ["vp", "run", "check:changed", baseSha], ...output },
      { kind: "test", argv: ["vp", "test", "run", "scripts/factory-check.test.ts"], ...output },
      { kind: "build-desktop", argv: ["vp", "run", "build:desktop"], ...output },
    ],
    ...overrides,
  };
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("validateReceipt", () => {
  it("accepts a receipt bound to the candidate, base, toolchain and passing commands", () => {
    const bytes = encode(receipt());
    const result = validateReceipt(bytes, digest(bytes), expected);
    expect(result.errors).toEqual([]);
    expect(result.receipt?.commands.map((command) => command.kind)).toEqual([
      "check-changed",
      "test",
      "build-desktop",
    ]);
  });

  const [checkChanged, test, build] = receipt().commands;
  it.each([
    ["another candidate", receipt({ candidateSha: "d".repeat(40) }), "receipt candidate"],
    ["another base", receipt({ baseSha: "d".repeat(40) }), "receipt base"],
    ["another repository", receipt({ repository: "other/factory" }), "receipt repository"],
    [
      "an unpinned Node.js",
      receipt({ toolchain: { ...toolchain, node: "24.13.1" } }),
      "pinned 26.12.1",
    ],
    ["a claim of attestation", receipt({ evidence: "attested" }), "dispatcher-declared"],
    ["a dirty worktree", receipt({ worktreeClean: false }), "clean worktree"],
    ["an undeclared field", receipt({ signature: "x" }), "unknown field signature"],
    [
      "a failed test",
      receipt({ commands: [checkChanged, { ...test, exitCode: 1 }, build] }),
      "(test) did not pass",
    ],
    ["no desktop build", receipt({ commands: [checkChanged, test] }), "no build-desktop command"],
    [
      "check:changed against another base",
      receipt({
        commands: [{ ...checkChanged, argv: ["vp", "run", "check:changed"] }, test, build],
      }),
      "against the base SHA",
    ],
  ])("rejects %s", (_name, value, message) => {
    const bytes = encode(value);
    const result = validateReceipt(bytes, digest(bytes), expected);
    expect(result.receipt).toBeUndefined();
    expect(result.errors.join("\n")).toContain(message);
  });

  it("rejects bytes that do not match the declared digest", () => {
    const result = validateReceipt(encode(receipt()), "e".repeat(64), expected);
    expect(result.errors.join("\n")).toContain("does not match");
  });

  it("rejects a receipt over the size bound", () => {
    const bytes = encode(receipt({ padding: "x".repeat(MAX_RECEIPT_BYTES) }));
    expect(validateReceipt(bytes, digest(bytes), expected).errors).toEqual([
      `receipt must be 1-${MAX_RECEIPT_BYTES} bytes`,
    ]);
  });

  it("decodes only canonical base64 so the digest covers exactly what was dispatched", () => {
    const bytes = encode(receipt());
    expect(decodeReceiptInput(bytes.toString("base64"))).toEqual(bytes);
    expect(() => decodeReceiptInput(`${bytes.toString("base64")}\n`)).toThrow("canonical");
  });
});

describe("evaluateCheckRun", () => {
  const receiptBytes = encode(receipt());
  const receiptSha256 = digest(receiptBytes);
  const resolve: ResolveRecord = {
    schema: "t3factory.check-resolve/v1",
    repository: "owner/factory",
    candidate: {
      sha: candidateSha,
      ref: "feat/t3factory",
      refKind: "branch",
      refSha: candidateSha,
    },
    baseSha,
    toolchainPins: toolchain,
    runAttempt: "1",
    localEvidence: {
      evidence: "dispatcher-declared",
      attested: false,
      sha256: receiptSha256,
      bytes: receiptBytes.byteLength,
      receipt: receipt() as LocalReceipt,
    },
  };
  const laneRecord = (lane: string, index = 1, total = 1): LaneRecord => ({
    schema: "t3factory.check-lane/v1",
    lane,
    shard: { index, total },
    candidateHead: candidateSha,
    runAttempt: "1",
    toolchain,
    runner: { os: "Linux" },
  });
  const requestedLanes = CHECK_LANES.filter((lane) => lane !== "windows");
  const passing = {
    context: {
      repository: "owner/factory",
      workflowRef: "owner/factory/.github/workflows/factory-check.yml@refs/heads/feat/t3factory",
      workflowSha: "f".repeat(40),
      runId: "123",
      runAttempt: "1",
      eventName: "workflow_dispatch",
      ref: "refs/heads/feat/t3factory",
    },
    inputs: {
      candidate_sha: candidateSha,
      base_sha: baseSha,
      candidate_ref: "feat/t3factory",
      local_receipt_sha256: receiptSha256,
      ...Object.fromEntries(CHECK_LANES.map((lane) => [`lane_${lane}`, lane !== "windows"])),
    },
    needs: {
      resolve: { result: "success" },
      ...Object.fromEntries(
        CHECK_LANES.map((lane) => [lane, { result: lane === "windows" ? "skipped" : "success" }]),
      ),
    },
    resolve,
    receiptSha256,
    laneRecords: requestedLanes.flatMap((lane) =>
      lane === "test_server"
        ? [1, 2, 3].map((index) => laneRecord(lane, index, 3))
        : [laneRecord(lane)],
    ),
    artifacts: [{ path: "factory-resolve-a1/receipt.json", bytes: 1, sha256: receiptSha256 }],
  };

  it("passes and keeps an explicitly unrequested lane and unsupported coverage visible", () => {
    const manifest = evaluateCheckRun(passing);
    expect(manifest.failures).toEqual([]);
    expect(manifest.status).toBe("passed");
    expect(manifest.lanes.find((lane) => lane.name === "windows")).toMatchObject({
      requested: false,
      result: "skipped",
    });
    expect(manifest.unsupportedLanes).toEqual([
      expect.objectContaining({ name: "mobile_native_static_analysis", result: "not-run" }),
    ]);
    expect(manifest.localEvidence).toMatchObject({
      evidence: "dispatcher-declared",
      attested: false,
    });
    expect(manifest).toMatchObject({
      workflow: { path: ".github/workflows/factory-check.yml", sha: "f".repeat(40) },
      run: { id: "123", attempt: "1" },
      candidate: { sha: candidateSha, refKind: "branch" },
      baseSha,
    });
  });

  const without = (lane: string) => passing.laneRecords.filter((record) => record.lane !== lane);
  it.each([
    [
      "a requested lane was skipped",
      { needs: { ...passing.needs, build: { result: "skipped" } } },
      "required lane build was skipped",
    ],
    [
      "a requested lane was cancelled",
      { needs: { ...passing.needs, lint: { result: "cancelled" } } },
      "required lane lint result is cancelled",
    ],
    [
      "resolve failed",
      { needs: { ...passing.needs, resolve: { result: "failure" } } },
      "resolve result is failure",
    ],
    [
      "an unrequested lane ran",
      { needs: { ...passing.needs, windows: { result: "success" } } },
      "lane windows was not requested",
    ],
    [
      "a lane is missing from the aggregate",
      { needs: { ...passing.needs, rust: undefined } },
      "lane rust is missing",
    ],
    [
      "no lane was requested",
      {
        inputs: {
          ...passing.inputs,
          ...Object.fromEntries(CHECK_LANES.map((lane) => [`lane_${lane}`, false])),
        },
        needs: {
          resolve: { result: "success" },
          ...Object.fromEntries(CHECK_LANES.map((lane) => [lane, { result: "skipped" }])),
        },
      },
      "no lane was requested",
    ],
    [
      "the run was not dispatched",
      { context: { ...passing.context, eventName: "push" } },
      "is not workflow_dispatch",
    ],
    [
      "another workflow ran",
      {
        context: {
          ...passing.context,
          workflowRef: "owner/factory/.github/workflows/ci.yml@refs/heads/main",
        },
      },
      "is not owner/factory/.github/workflows/factory-check.yml",
    ],
    [
      "resolve validated another candidate",
      { resolve: { ...resolve, candidate: { ...resolve.candidate, sha: "d".repeat(40) } } },
      "names another candidate",
    ],
    [
      "the uploaded receipt differs",
      { receiptSha256: "e".repeat(64) },
      "uploaded receipt hashes to",
    ],
    [
      "evidence came from an earlier attempt",
      { context: { ...passing.context, runAttempt: "2" } },
      "from another run attempt",
    ],
    [
      "a lane ran another Node.js",
      {
        laneRecords: [
          ...without("test"),
          { ...laneRecord("test"), toolchain: { ...toolchain, node: "24.13.1" } },
        ],
      },
      "ran node 24.13.1, pinned 26.12.1",
    ],
    [
      "a lane tested another commit",
      {
        laneRecords: [...without("lint"), { ...laneRecord("lint"), candidateHead: "d".repeat(40) }],
      },
      `tested ${"d".repeat(40)}`,
    ],
    [
      "a server shard reported nothing",
      { laneRecords: passing.laneRecords.filter((record) => record.shard.index !== 2) },
      "do not cover shards 1-3",
    ],
  ])("fails when %s", (_name, override, message) => {
    const manifest = evaluateCheckRun({ ...passing, ...override } as typeof passing);
    expect(manifest.status).toBe("failed");
    expect(manifest.failures.join("\n")).toContain(message);
  });
});

describe("resolveCandidate", () => {
  function repository() {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-check-"));
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync(
        "git",
        ["-c", "user.name=Factory", "-c", "user.email=factory@example.com", ...args],
        { cwd: dir, encoding: "utf8" },
      ).trim();
    git("init", "--quiet", "--initial-branch=main");
    git("commit", "--quiet", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("commit", "--quiet", "--allow-empty", "-m", "candidate");
    const candidate = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/feat/t3factory", candidate);
    git("checkout", "--quiet", "--orphan", "unrelated");
    git("commit", "--quiet", "--allow-empty", "-m", "unrelated");
    const unrelated = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/unrelated", unrelated);
    git("tag", "v-unrelated", unrelated);
    git("checkout", "--quiet", "--detach", candidate);
    return {
      dir,
      base,
      candidate,
      unrelated,
      [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("accepts a candidate reachable from its branch that descends from base", () => {
    using repo = repository();
    expect(
      resolveCandidate(repo.dir, {
        candidateSha: repo.candidate,
        baseSha: repo.base,
        candidateRef: "feat/t3factory",
      }),
    ).toEqual({
      sha: repo.candidate,
      ref: "feat/t3factory",
      refKind: "branch",
      refSha: repo.candidate,
    });
  });

  it("rejects unreachable candidates, non-ancestor bases and SHA refs", () => {
    using repo = repository();
    const request = {
      candidateSha: repo.candidate,
      baseSha: repo.base,
      candidateRef: "feat/t3factory",
    };
    expect(() => resolveCandidate(repo.dir, { ...request, candidateRef: "unrelated" })).toThrow(
      "is not reachable from branch unrelated",
    );
    expect(() => resolveCandidate(repo.dir, { ...request, candidateRef: "v-unrelated" })).toThrow(
      "is not reachable from tag v-unrelated",
    );
    expect(() => resolveCandidate(repo.dir, { ...request, baseSha: repo.unrelated })).toThrow(
      "is not an ancestor",
    );
    expect(() => resolveCandidate(repo.dir, { ...request, candidateRef: repo.candidate })).toThrow(
      "must be a branch or tag name",
    );
  });
});
