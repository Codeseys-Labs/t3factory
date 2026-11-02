// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createSeedRepository, evaluateNative, hydrateNative } from "./native.ts";
import { root } from "./dataset.ts";

const output = () => {
  const parent = process.env.FACTORY_NATIVE_TEST_ROOT ?? NodeOS.tmpdir();
  NodeFS.mkdirSync(parent, { recursive: true });
  return NodePath.join(NodeFS.mkdtempSync(NodePath.join(parent, "native-")), "sample");
};
const git = (repo: string, ...args: string[]) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      `core.hooksPath=${HostProcess.Platform.defaultValue() === "win32" ? "NUL" : "/dev/null"}`,
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd: repo,
      encoding: "utf8",
    },
  ).trim();

it("hydrates committed seed bytes into a new standalone external repository", () => {
  const out = output();
  const seed = hydrateNative({ caseId: "repair-cache-expiry", out });
  expect(NodeFS.readFileSync(NodePath.join(out, "repo/src/cache.ts"), "utf8")).toBe(
    "export const visible = (expiresAt: number, now: number) => expiresAt >= now;\n",
  );
  expect(NodeFS.readFileSync(NodePath.join(out, "repo/UNOWNED.txt"), "utf8")).toBe(
    "parent work: preserve exactly\n",
  );
  expect(git(NodePath.join(out, "repo"), "rev-parse", "HEAD")).toBe(seed.baseCommit);
  expect(git(NodePath.join(out, "repo"), "remote")).toBe("");
  expect(NodeFS.statSync(NodePath.join(out, "repo/.git")).isDirectory()).toBe(true);
  expect(NodeFS.readdirSync(NodePath.join(out, "export"))).toEqual([]);
  expect(NodeFS.existsSync(NodePath.join(out, "repo/.git/hooks"))).toBe(false);
  expect(() => hydrateNative({ caseId: "repair-cache-expiry", out })).toThrow(/exist|collision/i);
});

const repaired = () => {
  const seed = hydrateNative({ caseId: "repair-cache-expiry", out: output() });
  NodeFS.writeFileSync(
    NodePath.join(seed.repo, "src/cache.ts"),
    "export const visible = (expiresAt: number, now: number) => expiresAt > now;\n",
  );
  NodeFS.mkdirSync(NodePath.join(seed.repo, "tests"));
  NodeFS.writeFileSync(
    NodePath.join(seed.repo, "tests/cache.test.ts"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\n' +
      'import { visible } from "../src/cache.ts";\ntest("boundary", () => assert.equal(visible(10, 10), false));\n',
  );
  git(seed.repo, "add", "--all");
  git(
    seed.repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "repair",
  );
  return { ...seed, resultCommit: git(seed.repo, "rev-parse", "HEAD") };
};

it("probes exact seed and result commits with real tests but blocks absent native evidence", () => {
  const fixture = repaired();
  NodeFS.writeFileSync(
    NodePath.join(fixture.repo, "src/cache.ts"),
    "dirty HEAD must not be evaluated",
  );
  const result = evaluateNative(fixture);
  expect(result.status).toBe("blocked");
  expect(result.exitCode).not.toBe(0);
  expect(result.gates).toMatchObject({
    "seed-failure": "pass",
    behavior: "pass",
    ownership: "pass",
    "focused-tests": "pass",
    "native-identity": "missing",
    "candidate-regression": "missing",
  });
  expect(result.probes[0]).toMatchObject({ phase: "seed", status: "fail", exitCode: 1 });
  expect(result.probes[1]).toMatchObject({ phase: "result", status: "pass", exitCode: 0 });
  const saved = NodeFS.readFileSync(
    NodePath.join(fixture.sample, "evidence/evaluation/outcome.json"),
  );
  expect(() => evaluateNative(fixture)).toThrow(/exist/i);
  expect(
    NodeFS.readFileSync(NodePath.join(fixture.sample, "evidence/evaluation/outcome.json")),
  ).toEqual(saved);
});

it("rejects unsafe seed paths and file/directory collisions before creating output", () => {
  for (const path of [
    "../escape",
    "/absolute",
    "C:/escape",
    "src\\escape",
    ".git/config",
    "NUL.txt",
    "src/../escape",
    "src/space ",
    "src/trailing.",
  ]) {
    const out = output();
    expect(() => createSeedRepository(out, [{ path, content: "unsafe" }])).toThrow(/unsafe/i);
    expect(NodeFS.existsSync(out)).toBe(false);
  }
  for (const files of [
    [
      { path: "a.ts", content: "1" },
      { path: "A.ts", content: "2" },
    ],
    [
      { path: "src", content: "1" },
      { path: "src/cache.ts", content: "2" },
    ],
  ]) {
    const out = output();
    expect(() => createSeedRepository(out, files)).toThrow(/collision/i);
    expect(NodeFS.existsSync(out)).toBe(false);
  }
});

it("rejects summary-only native provenance instead of accepting invented verification booleans", () => {
  const fixture = repaired();
  NodeFS.writeFileSync(
    NodePath.join(fixture.sample, "evidence/capture.json"),
    JSON.stringify({
      nativeVerified: true,
      checkpointReady: true,
      reviewApproved: true,
    }),
  );
  const result = evaluateNative(fixture);
  expect(result.status).toBe("fail");
  expect(result.gates["capture-consistency"]).toBe("fail");
  expect(result.gates["native-identity"]).toBe("missing");
});

const captureFor = (fixture: ReturnType<typeof repaired>) => {
  const directory = NodePath.join(fixture.sample, "evidence");
  const write = (path: string, value: unknown, sourceKind: string) => {
    const bytes = `${JSON.stringify(value)}\n`;
    NodeFS.writeFileSync(NodePath.join(directory, path), bytes);
    return {
      path,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      sourceKind,
      complete: true,
    };
  };
  const participant = (name: string, baseCommit: string) => {
    const ref = `refs/qualification/${name}`;
    git(fixture.repo, "update-ref", ref, fixture.resultCommit);
    const task = {
      taskId: `${name}-task`,
      childThreadId: `${name}-thread`,
      childRunId: `${name}-run`,
      childNodeId: `${name}-task`,
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      latestTerminalRunId: `${name}-run`,
      latestTerminalStatus: "completed",
      baseCommit,
      resultCommit: fixture.resultCommit,
      latestTerminalSummary: null,
      latestTerminalResultContextTransferId: null,
      providerInstanceId: "codex",
      model: "fixture-model",
      options: [],
      summary: null,
      resultContextTransferId: null,
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    };
    const run = {
      id: `${name}-run`,
      threadId: `${name}-thread`,
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "fixture-model", options: [] },
      providerThreadId: null,
      userMessageId: `${name}-message`,
      rootNodeId: `${name}-task`,
      activeAttemptId: null,
      status: "completed",
      requestedAt: "2026-11-02T00:00:00Z",
      startedAt: "2026-11-02T00:00:00Z",
      completedAt: "2026-11-02T00:01:00Z",
      checkpointId: `${name}-checkpoint`,
      contextHandoffId: null,
      delegatedTaskId: `${name}-task`,
    };
    const checkpoint = {
      id: `${name}-checkpoint`,
      threadId: `${name}-thread`,
      scopeId: `${name}-scope`,
      runId: `${name}-run`,
      nodeId: `${name}-task`,
      parentCheckpointId: null,
      ordinalWithinScope: 0,
      appRunOrdinal: 1,
      ref,
      status: "ready",
      files: [],
      capturedAt: "2026-11-02T00:01:00Z",
    };
    return {
      taskStatus: write(`${name}-task.json`, task, "mcp_result"),
      run: write(`${name}-run.json`, run, "service_snapshot"),
      checkpoint: write(`${name}-checkpoint.json`, checkpoint, "service_snapshot"),
    };
  };
  const capture = {
    subject: participant("subject", fixture.baseCommit),
    reviewer: participant("reviewer", fixture.resultCommit),
    review: write(
      "review.json",
      {
        reviewerTaskId: "reviewer-task",
        reviewerThreadId: "reviewer-thread",
        reviewerTerminalRunId: "reviewer-run",
        reviewedSubjectTuple: {
          taskId: "subject-task",
          childThreadId: "subject-thread",
          terminalRunId: "subject-run",
          baseCommit: fixture.baseCommit,
          resultCommit: fixture.resultCommit,
        },
        verdict: "approve",
        findings: [],
      },
      "review_response",
    ),
    subjectProtocol: write("subject.ndjson", { synthetic: "self-test only" }, "native_protocol"),
    reviewerProtocol: write("reviewer.ndjson", { synthetic: "self-test only" }, "native_protocol"),
    reviewTreeBefore: {
      path: "before.txt",
      sha256: NodeCrypto.createHash("sha256").update("").digest("hex"),
      sourceKind: "process_output",
      complete: true,
    },
    reviewTreeAfter: {
      path: "after.txt",
      sha256: NodeCrypto.createHash("sha256").update("").digest("hex"),
      sourceKind: "process_output",
      complete: true,
    },
  };
  NodeFS.writeFileSync(NodePath.join(directory, "before.txt"), "");
  NodeFS.writeFileSync(NodePath.join(directory, "after.txt"), "");
  const save = () =>
    NodeFS.writeFileSync(NodePath.join(directory, "capture.json"), JSON.stringify(capture));
  save();
  return { capture, save, write };
};

it("keeps internally consistent synthetic records blocked and rejects mismatched captured evidence", () => {
  for (const defect of [
    "none",
    "hash",
    "truncated",
    "unrelated-run",
    "null-result",
    "not-ready",
    "reject",
    "dirty-review",
    "model",
    "missing-artifact",
    "truncated-protocol",
    "reviewed-tuple",
    "checkpoint-node",
    "null-root",
  ]) {
    const fixture = repaired();
    const { capture, save, write } = captureFor(fixture);
    const replaceRecord = (path: string, change: Record<string, unknown>, kind: string) => {
      const record = JSON.parse(
        NodeFS.readFileSync(NodePath.join(fixture.sample, "evidence", path), "utf8"),
      );
      return write(path, { ...record, ...change }, kind);
    };
    if (defect === "hash") capture.subject.run.sha256 = "0".repeat(64);
    if (defect === "truncated") capture.subject.run.complete = false;
    if (defect === "unrelated-run")
      capture.subject.run = replaceRecord(
        "subject-run.json",
        { delegatedTaskId: "another-task" },
        "service_snapshot",
      );
    if (defect === "checkpoint-node" || defect === "null-root")
      capture.subject.run = replaceRecord(
        "subject-run.json",
        { rootNodeId: defect === "null-root" ? null : "unrelated-node" },
        "service_snapshot",
      );
    if (defect === "null-result")
      capture.subject.taskStatus = replaceRecord(
        "subject-task.json",
        { resultCommit: null },
        "mcp_result",
      );
    if (defect === "not-ready")
      capture.subject.checkpoint = replaceRecord(
        "subject-checkpoint.json",
        { status: "missing" },
        "service_snapshot",
      );
    if (defect === "reject")
      capture.review = replaceRecord("review.json", { verdict: "reject" }, "review_response");
    if (defect === "dirty-review")
      capture.reviewTreeAfter = write("after.txt", " M src/cache.ts", "process_output");
    if (defect === "model")
      capture.subject.run = replaceRecord(
        "subject-run.json",
        { modelSelection: { instanceId: "codex", model: "different" } },
        "service_snapshot",
      );
    if (defect === "missing-artifact") capture.subject.run.path = "absent.json";
    if (defect === "truncated-protocol") {
      NodeFS.writeFileSync(NodePath.join(fixture.sample, "evidence/subject.ndjson"), "{}");
      capture.subjectProtocol.sha256 = NodeCrypto.createHash("sha256").update("{}").digest("hex");
    }
    if (defect === "reviewed-tuple")
      capture.review = replaceRecord(
        "review.json",
        { reviewedSubjectTuple: {} },
        "review_response",
      );
    save();
    const result = evaluateNative(fixture);
    expect(result.capture, defect).toMatchObject({ gate: defect === "none" ? "pass" : "fail" });
    expect(result.status, defect).toBe(defect === "none" ? "blocked" : "fail");
    expect(result.gates["native-identity"], defect).toBe("missing");
  }
});

it("refuses a gitdir indirection instead of treating a delegated worktree as the standalone seed", () => {
  const fixture = repaired();
  const saved = NodePath.join(fixture.sample, "saved-git");
  NodeFS.renameSync(NodePath.join(fixture.repo, ".git"), saved);
  NodeFS.writeFileSync(NodePath.join(fixture.repo, ".git"), `gitdir: ${saved}\n`);
  const result = evaluateNative(fixture);
  expect(result.status).toBe("infrastructure_error");
  expect(result.errors.join("\n")).toMatch(/standalone/i);
  expect(result.probes).toEqual([]);
});

it("rejects tracked symlink exports before running candidate code", () => {
  const fixture = repaired();
  const linkText = NodePath.join(fixture.sample, "link-text");
  NodeFS.writeFileSync(linkText, "../../outside");
  const blob = git(fixture.repo, "hash-object", "-w", linkText);
  git(fixture.repo, "update-index", "--add", "--cacheinfo", `120000,${blob},src/escape`);
  git(
    fixture.repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "unsafe symlink",
  );
  const result = evaluateNative({
    ...fixture,
    resultCommit: git(fixture.repo, "rev-parse", "HEAD"),
  });
  expect(result.status).toBe("fail");
  expect(result.gates["result-tree"]).toBe("fail");
  expect(result.probes).toEqual([]);
  expect(NodeFS.existsSync(NodePath.join(fixture.sample, "export/result"))).toBe(false);
});

it("returns a nonzero blocked outcome through the offline command line", () => {
  const hydration = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(import.meta.dirname, "native.ts"),
      "hydrate",
      "--case",
      "repair-cache-expiry",
      "--out",
      output(),
    ],
    { encoding: "utf8" },
  );
  expect(hydration.status).toBe(2);
  expect(JSON.parse(hydration.stdout)).toMatchObject({
    status: "blocked",
    stage: "hydrated",
    nativeQualificationClaim: false,
  });
  const fixture = repaired();
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(import.meta.dirname, "native.ts"),
      "evaluate",
      "--sample",
      fixture.sample,
      "--result-commit",
      fixture.resultCommit,
    ],
    { encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "blocked",
    nativeQualificationClaim: false,
  });
});

it.each(["bytes", "addition", "deletion", "mode"])("rejects unowned %s changes", (change) => {
  const fixture = repaired();
  if (change === "bytes")
    NodeFS.writeFileSync(NodePath.join(fixture.repo, "UNOWNED.txt"), "changed\n");
  if (change === "addition")
    NodeFS.writeFileSync(NodePath.join(fixture.repo, "extra.txt"), "unowned\n");
  if (change === "deletion") NodeFS.unlinkSync(NodePath.join(fixture.repo, "UNOWNED.txt"));
  git(fixture.repo, "add", "--all");
  if (change === "mode") git(fixture.repo, "update-index", "--chmod=+x", "UNOWNED.txt");
  git(
    fixture.repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "unowned change",
  );
  const result = evaluateNative({
    ...fixture,
    resultCommit: git(fixture.repo, "rev-parse", "HEAD"),
  });
  expect(result.status).toBe("fail");
  expect(result.gates.ownership).toBe("fail");
  expect(result.probes).toEqual([]);
});

it("requires explicit holdout opt-in for hydration and evaluation", () => {
  const out = output();
  expect(() => hydrateNative({ caseId: "native-parent-child-review", out })).toThrow(/holdout/i);
  expect(NodeFS.existsSync(out)).toBe(false);
  const fixture = hydrateNative({
    caseId: "native-parent-child-review",
    out,
    includeHoldout: true,
  });
  NodeFS.writeFileSync(
    NodePath.join(fixture.repo, "src/sum.ts"),
    "export const sum = (a: number, b: number) => a + b;\n",
  );
  git(fixture.repo, "add", "--all");
  git(
    fixture.repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "sum repair",
  );
  const input = { sample: fixture.sample, resultCommit: git(fixture.repo, "rev-parse", "HEAD") };
  expect(() => evaluateNative(input)).toThrow(/holdout/i);
  const result = evaluateNative({ ...input, includeHoldout: true });
  expect(result.status).toBe("blocked");
  expect(result.gates).toMatchObject({
    behavior: "pass",
    ownership: "pass",
    "seed-failure": "pass",
  });
});

it("rejects output junction/reparse escapes without touching their target", () => {
  const fixture = repaired();
  const target = NodePath.dirname(output());
  const link = NodePath.join(fixture.sample, "redirect");
  NodeFS.symlinkSync(
    target,
    link,
    HostProcess.Platform.defaultValue() === "win32" ? "junction" : "dir",
  );
  expect(() =>
    createSeedRepository(NodePath.join(link, "new"), [{ path: "a.ts", content: "safe" }]),
  ).toThrow(/symlink|reparse/i);
  NodeFS.renameSync(
    NodePath.join(fixture.sample, "export"),
    NodePath.join(fixture.sample, "saved-export"),
  );
  NodeFS.symlinkSync(
    target,
    NodePath.join(fixture.sample, "export"),
    HostProcess.Platform.defaultValue() === "win32" ? "junction" : "dir",
  );
  expect(() => evaluateNative(fixture)).toThrow(/symlink|reparse/i);
  expect(NodeFS.readdirSync(target)).toEqual([]);
});

it("rejects Git object-store junction/reparse escapes before exporting source", () => {
  const fixture = repaired();
  const objects = NodePath.join(fixture.repo, ".git/objects");
  const target = NodePath.join(fixture.sample, "object-store");
  NodeFS.renameSync(objects, target);
  NodeFS.symlinkSync(
    target,
    objects,
    HostProcess.Platform.defaultValue() === "win32" ? "junction" : "dir",
  );
  const result = evaluateNative(fixture);
  expect(result.status).toBe("infrastructure_error");
  expect(result.errors.join("\n")).toMatch(/symlink|reparse/i);
  expect(result.probes).toEqual([]);
});

it("rejects an unrelated result history even when its file bytes form a mechanical repair", () => {
  const fixture = repaired();
  const tree = git(fixture.repo, "rev-parse", `${fixture.resultCommit}^{tree}`);
  const orphan = git(
    fixture.repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit-tree",
    tree,
    "-m",
    "unrelated root",
  );
  const result = evaluateNative({ ...fixture, resultCommit: orphan });
  expect(result.status).toBe("fail");
  expect(result.gates["base-ancestry"]).toBe("fail");
  expect(result.probes).toEqual([]);
});

it.each(["assertion", "infrastructure", "mixed", "nested-assertion", "nested-mixed"])(
  "distinguishes %s failures in real process probes",
  (failure) => {
    const fixture = repaired();
    if (failure.startsWith("nested"))
      NodeFS.writeFileSync(
        NodePath.join(fixture.repo, "tests/cache.test.ts"),
        'import { test } from "node:test";\nimport assert from "node:assert/strict";\n' +
          'import { readFileSync } from "node:fs";\ntest("parent", async t => {\n' +
          'await t.test("boundary", () => assert.fail("real assertion"));\n' +
          (failure === "nested-mixed"
            ? 'await t.test("missing", () => readFileSync("missing-fixture.txt"));\n'
            : "") +
          "});\n",
      );
    else if (failure === "mixed")
      NodeFS.writeFileSync(
        NodePath.join(fixture.repo, "tests/cache.test.ts"),
        'import { test } from "node:test";\nimport assert from "node:assert/strict";\n' +
          'import { readFileSync } from "node:fs";\ntest("assertion", () => assert.fail("real assertion"));\n' +
          'test("infrastructure", () => readFileSync("missing-fixture.txt"));\n',
      );
    else
      NodeFS.writeFileSync(
        NodePath.join(fixture.repo, "src/cache.ts"),
        failure === "assertion"
          ? "export const visible = (expiresAt: number, now: number) => expiresAt >= now;\n"
          : 'throw new Error("fixture import infrastructure failure");\nexport const visible = () => true;\n',
      );
    git(fixture.repo, "add", "--all");
    git(
      fixture.repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "broken result",
    );
    const result = evaluateNative({
      ...fixture,
      resultCommit: git(fixture.repo, "rev-parse", "HEAD"),
    });
    const assertionOnly = failure === "assertion" || failure === "nested-assertion";
    expect(result.status).toBe(assertionOnly ? "fail" : "infrastructure_error");
    expect(result.gates.behavior).toBe(
      failure === "assertion" ? "fail" : failure === "infrastructure" ? "missing" : "pass",
    );
    expect(result.exitCode).toBe(assertionOnly ? 1 : 3);
  },
);

it.each(["focused", "implementation"])("rejects fabricated TAP from %s code", (location) => {
  const fixture = repaired();
  const fake =
    'console.log("TAP version 13\\nok 1 - invented\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0");\n';
  NodeFS.writeFileSync(
    NodePath.join(fixture.repo, location === "focused" ? "tests/cache.test.ts" : "src/cache.ts"),
    location === "focused" ? fake : `export const visible = () => true;\n${fake}process.exit(0);\n`,
  );
  git(fixture.repo, "add", "--all");
  git(
    fixture.repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fabricated output",
  );
  const result = evaluateNative({
    ...fixture,
    resultCommit: git(fixture.repo, "rev-parse", "HEAD"),
  });
  expect(result.gates[location === "focused" ? "focused-tests" : "behavior"]).not.toBe("pass");
  expect(
    result.probes.find((p) => p.phase === (location === "focused" ? "focused" : "result"))?.tests,
  ).toBe(0);
});

it("rejects missing recorded source commits rather than substituting current HEAD", () => {
  const fixture = repaired();
  NodeFS.writeFileSync(
    NodePath.join(fixture.sample, "evidence/seed.json"),
    JSON.stringify({ ...fixture, sourceCommit: "f".repeat(40) }),
  );
  expect(() => evaluateNative(fixture)).toThrow(/source|Git infrastructure/);
});

it("replays the recorded catalog commit after the source catalog advances", () => {
  const catalogPath = "evals/factory-qualification/v1/cases.json";
  const catalog = JSON.parse(git(root, "show", `HEAD:${catalogPath}`));
  const source = createSeedRepository(output(), [
    { path: catalogPath, content: JSON.stringify(catalog) },
  ]);
  const spawn = NodeChildProcess.spawnSync;
  const childProcess = NodeModule.createRequire(import.meta.url)(
    "node:child_process",
  ) as typeof NodeChildProcess;
  using restoreExports = new DisposableStack();
  using _sourceGit = vi
    .spyOn(childProcess, "spawnSync")
    .mockImplementation((command, args, options) =>
      spawn(command, args, { ...options, cwd: options?.cwd === root ? source.repo : options?.cwd }),
    );
  NodeModule.syncBuiltinESMExports();
  restoreExports.defer(NodeModule.syncBuiltinESMExports);
  const fixture = repaired();
  catalog.find((c: { id: string }) => c.id === "repair-cache-expiry").scenario +=
    " Later clarification.";
  NodeFS.writeFileSync(NodePath.join(source.repo, catalogPath), JSON.stringify(catalog));
  git(source.repo, "add", "--all");
  git(
    source.repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "catalog revision",
  );
  expect(evaluateNative(fixture).gates["seed-integrity"]).toBe("pass");
});
