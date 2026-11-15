// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { OrchestratorMcpDelegateTaskResult } from "../../packages/contracts/src/orchestratorMcp.ts";
import {
  OrchestrationV2RunJson,
  OrchestrationV2CheckpointJson,
} from "../../packages/contracts/src/orchestrationV2.ts";
import { root } from "./dataset.ts";
import type { QualificationCase } from "./schema.ts";

const sha256 = (bytes: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const nullFile = HostProcess.Platform.defaultValue() === "win32" ? "NUL" : "/dev/null";
const environment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp)$/i.test(key)),
  );
const git = (repo: string, args: string[]) => {
  const result = NodeChildProcess.spawnSync(
    "git",
    [
      "-c",
      `core.hooksPath=${nullFile}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      `core.attributesFile=${nullFile}`,
      ...args,
    ],
    {
      cwd: repo,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...environment(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: nullFile,
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_GRAFT_FILE: nullFile,
      },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Git infrastructure error: ${result.error?.message ?? result.stderr.toString()}`,
    );
  return result.stdout;
};
const json = (path: string, value: unknown) =>
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const external = (path: string) => {
  const absolute = NodePath.resolve(path);
  const relative = NodePath.relative(root, absolute);
  if (!relative || (!relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)))
    throw new Error("Output must be external to the source checkout");
  return absolute;
};
const plainAncestors = (path: string) => {
  const absolute = NodePath.resolve(path);
  const parent = NodePath.dirname(absolute);
  if (parent !== absolute) plainAncestors(parent);
  if (NodeFS.existsSync(absolute) && NodeFS.lstatSync(absolute).isSymbolicLink())
    throw new Error(`Symlink/reparse path: ${absolute}`);
};
const plainTree = (path: string) => {
  const stat = NodeFS.lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Symlink/reparse path: ${path}`);
  if (stat.isDirectory())
    for (const child of NodeFS.readdirSync(path)) plainTree(NodePath.join(path, child));
};
const safePath = (path: string) => {
  if (
    !path ||
    path.includes("\\") ||
    NodePath.posix.isAbsolute(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !/^[a-zA-Z0-9_.-]+$/.test(part) ||
          part === "." ||
          part === ".." ||
          part.endsWith(".") ||
          /^(\.git|con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error(`Unsafe seed/export path: ${path}`);
};
const caseDefinition = (caseId: string, includeHoldout = false, recordedCommit?: string) => {
  if (caseId !== "repair-cache-expiry" && caseId !== "native-parent-child-review")
    throw new Error(`Unsupported native case: ${caseId}`);
  if (caseId === "native-parent-child-review" && !includeHoldout)
    throw new Error("Holdout requires explicit includeHoldout");
  const sourceCommit = recordedCommit ?? git(root, ["rev-parse", "HEAD"]).toString().trim();
  commitId(sourceCommit);
  if (
    git(root, ["rev-parse", "--verify", `${sourceCommit}^{commit}`])
      .toString()
      .trim() !== sourceCommit
  )
    throw new Error("Source commit mismatch");
  const bytes = git(root, ["show", `${sourceCommit}:evals/factory-qualification/v1/cases.json`]);
  const cases: QualificationCase[] = JSON.parse(bytes.toString());
  const entry = cases.find((c) => c.id === caseId);
  if (!entry?.specification) throw new Error("Missing committed seed");
  return { entry, sourceCommit, caseSha256: sha256(JSON.stringify(entry)) };
};

export const createSeedRepository = (
  out: string,
  files: ReadonlyArray<{ path: string; content: string }>,
) => {
  const sample = external(out);
  plainAncestors(sample);
  const names = new Set<string>();
  for (const file of files) {
    safePath(file.path);
    const name = file.path.toLowerCase();
    if (
      [...names].some(
        (other) => name === other || name.startsWith(`${other}/`) || other.startsWith(`${name}/`),
      )
    )
      throw new Error("Seed path collision");
    names.add(name);
  }
  NodeFS.mkdirSync(sample);
  for (const dir of ["repo", "evidence", "export"]) NodeFS.mkdirSync(NodePath.join(sample, dir));
  const repo = NodePath.join(sample, "repo");
  for (const file of files) {
    const path = NodePath.join(repo, file.path);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, file.content, { flag: "wx" });
  }
  git(repo, ["init", "--template=", "--initial-branch=main"]);
  git(repo, ["add", "--all"]);
  git(repo, [
    "-c",
    "user.name=Offline fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "qualification seed",
  ]);
  return { sample, repo, baseCommit: git(repo, ["rev-parse", "HEAD"]).toString().trim() };
};

export const hydrateNative = (options: {
  caseId: string;
  out: string;
  includeHoldout?: boolean;
}) => {
  const definition = caseDefinition(options.caseId, options.includeHoldout);
  const seed = createSeedRepository(options.out, definition.entry.specification!.files);
  const receipt = {
    ...seed,
    caseId: options.caseId,
    sourceCommit: definition.sourceCommit,
    caseSha256: definition.caseSha256,
  };
  json(NodePath.join(seed.sample, "evidence/seed.json"), receipt);
  return receipt;
};

const commitId = (value: string) => {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("An exact commit SHA is required");
  return value;
};
// @effect-diagnostics-next-line extendsNativeError:off - a local throw sentinel in synchronous export code.
class SubmissionError extends Error {}
const exportCommit = (repo: string, commit: string, destination: string) => {
  commitId(commit);
  if (
    git(repo, ["rev-parse", "--verify", `${commit}^{commit}`])
      .toString()
      .trim() !== commit
  )
    throw new Error("Commit mismatch");
  const rows = git(repo, ["ls-tree", "-rz", "--full-tree", commit])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const seen = new Set<string>();
  const files = rows.map((row) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match) throw new SubmissionError("Unsafe export: symlink/submodule/unsupported mode");
    const mode = match[1]!;
    const oid = match[2]!;
    const path = match[3]!;
    try {
      safePath(path);
    } catch (error) {
      throw new SubmissionError(String(error));
    }
    const name = path.toLowerCase();
    if (
      [...seen].some(
        (other) => name === other || name.startsWith(`${other}/`) || other.startsWith(`${name}/`),
      )
    )
      throw new SubmissionError("Export path collision");
    seen.add(name);
    const bytes = git(repo, ["cat-file", "blob", oid]);
    return { path, mode, oid, bytes, sha256: sha256(bytes) };
  });
  NodeFS.mkdirSync(destination);
  for (const file of files) {
    const path = NodePath.join(destination, file.path);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, file.bytes, {
      flag: "wx",
      mode: file.mode === "100755" ? 0o755 : 0o644,
    });
  }
  return files.map(({ bytes: _bytes, ...file }) => file);
};
const probeSource = (caseId: string, directory: string) => {
  const module = NodeURL.pathToFileURL(
    NodePath.join(directory, caseId === "repair-cache-expiry" ? "src/cache.ts" : "src/sum.ts"),
  ).href;
  const assertions =
    caseId === "repair-cache-expiry"
      ? [
          ["cache-boundary", "visible(10,10)", "false"],
          ["cache-future", "visible(11,10)", "true"],
          ["cache-expired", "visible(9,10)", "false"],
        ]
      : [
          ["sum-positive", "sum(2,3)", "5"],
          ["sum-negative", "sum(-2,2)", "0"],
        ];
  return (
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ${caseId === "repair-cache-expiry" ? "visible" : "sum"} } from ${JSON.stringify(module)};\n` +
    assertions
      .map(
        ([name, actual, expected]) =>
          `test(${JSON.stringify(name)}, () => assert.equal(${actual}, ${expected}));`,
      )
      .join("\n")
  );
};
const runTests = (
  directory: string,
  testPath: string,
  phase: string,
  evidence: string,
  sourceCommit: string,
  expectedNames?: readonly string[],
) => {
  const execArgv = [
    "--permission",
    `--allow-fs-read=${directory}`,
    `--allow-fs-read=${NodePath.dirname(testPath)}`,
  ];
  const runner = NodePath.join(evidence, `${phase}.runner.mjs`);
  NodeFS.writeFileSync(
    runner,
    'import { run } from "node:test";\n' +
      `const events = run({ ...${JSON.stringify({ files: [testPath], cwd: directory, isolation: "process", execArgv })}, signal: AbortSignal.timeout(12000) });\n` +
      "for await (const event of events) {\n" +
      'process.stdout.write(JSON.stringify(event, (_key, value) => value instanceof Error ? { name: value.name, message: value.message, code: value.code, failureType: value.failureType, cause: value.cause } : value) + "\\n");\n' +
      'if (event.type === "test:summary" && !event.data.file) process.exitCode = event.data.success ? 0 : 1;\n}\n',
    { flag: "wx" },
  );
  const args = [runner];
  const result = NodeChildProcess.spawnSync(process.execPath, args, {
    cwd: directory,
    env: environment(),
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  NodeFS.writeFileSync(NodePath.join(evidence, `${phase}.stdout.txt`), result.stdout ?? "", {
    flag: "wx",
  });
  NodeFS.writeFileSync(NodePath.join(evidence, `${phase}.stderr.txt`), result.stderr ?? "", {
    flag: "wx",
  });
  const stdout = result.stdout ?? "";
  const events = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => decodeTestEvent(JSON.parse(line)));
  const summaries = events.filter(
    (e) => e.type === "test:summary" && e.data.file === testPath && e.data.entryFile === testPath,
  );
  const summary = summaries.length === 1 ? summaries[0]!.data.counts : undefined;
  const tests = summary?.tests ?? 0;
  const passed = summary?.passed ?? 0;
  const failed = summary?.failed ?? 0;
  const completed = events.filter(
    (e) => (e.type === "test:pass" || e.type === "test:fail") && e.data.entryFile === testPath,
  );
  const namesMatch =
    expectedNames === undefined ||
    NodeUtil.isDeepStrictEqual(
      completed
        .filter((e) => e.data.file === testPath && e.data.nesting === 0)
        .map((e) => e.data.name)
        .sort(),
      [...expectedNames].sort(),
    );
  const complete =
    tests > 0 &&
    tests === passed + failed &&
    !summary?.cancelled &&
    !summary?.skipped &&
    !summary?.todo &&
    namesMatch;
  const failures = completed
    .filter((e) => e.type === "test:fail")
    .map((e) => e.data.details?.error);
  const assertionOnly =
    failures.length > 0 &&
    failures.every(
      (error) =>
        error?.failureType === "subtestsFailed" ||
        error?.code === "ERR_ASSERTION" ||
        isAssertionFailure(error?.cause),
    );
  const status =
    !result.error && complete && result.status === 0 && failed === 0
      ? "pass"
      : !result.error && complete && result.status === 1 && failed > 0 && assertionOnly
        ? "fail"
        : !result.error && result.status === 0 && !complete
          ? "fail"
          : "infrastructure_error";
  return {
    phase,
    status,
    sourceCommit,
    commandArgv: [process.execPath, ...args],
    testExecArgv: execArgv,
    cwd: directory,
    nodeVersion: process.version,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    tests,
    passed,
    failed,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(result.stderr ?? ""),
  };
};
const isAssertionFailure = Schema.is(Schema.Struct({ code: Schema.Literal("ERR_ASSERTION") }));
const decodeTestEvent = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.String,
    data: Schema.Struct({
      name: Schema.optional(Schema.String),
      file: Schema.optional(Schema.String),
      entryFile: Schema.optional(Schema.String),
      nesting: Schema.optional(Schema.Number),
      counts: Schema.optional(
        Schema.Struct({
          tests: Schema.Int,
          passed: Schema.Int,
          failed: Schema.Int,
          cancelled: Schema.Int,
          skipped: Schema.Int,
          todo: Schema.Int,
        }),
      ),
      details: Schema.optional(
        Schema.Struct({
          error: Schema.optional(
            Schema.Struct({
              code: Schema.optional(Schema.String),
              failureType: Schema.optional(Schema.String),
              cause: Schema.optional(Schema.Unknown),
            }),
          ),
        }),
      ),
    }),
  }),
);
type Gate = "pass" | "fail" | "missing";
const Artifact = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  complete: Schema.Literal(true),
  sourceKind: Schema.Literals([
    "mcp_result",
    "service_snapshot",
    "native_protocol",
    "review_response",
    "process_output",
  ]),
});
const Participant = Schema.Struct({ taskStatus: Artifact, run: Artifact, checkpoint: Artifact });
const Capture = Schema.Struct({
  subject: Participant,
  reviewer: Participant,
  review: Artifact,
  subjectProtocol: Artifact,
  reviewerProtocol: Artifact,
  reviewTreeBefore: Artifact,
  reviewTreeAfter: Artifact,
});
const Review = Schema.Struct({
  reviewerTaskId: Schema.String,
  reviewerThreadId: Schema.String,
  reviewerTerminalRunId: Schema.String,
  reviewedSubjectTuple: Schema.Struct({
    taskId: Schema.String,
    childThreadId: Schema.String,
    terminalRunId: Schema.String,
    baseCommit: Schema.String,
    resultCommit: Schema.String,
  }),
  verdict: Schema.Literals(["approve", "reject", "blocked", "unparseable"]),
  findings: Schema.Array(Schema.Unknown),
});
const decodeCapture = Schema.decodeUnknownSync(Capture);
const decodeTask = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeRun = Schema.decodeUnknownSync(OrchestrationV2RunJson);
const decodeCheckpoint = Schema.decodeUnknownSync(OrchestrationV2CheckpointJson);
const decodeReview = Schema.decodeUnknownSync(Review);
const checkCapture = (sample: string, baseCommit: string, resultCommit: string) => {
  const directory = NodePath.join(sample, "evidence");
  const manifest = NodePath.join(directory, "capture.json");
  if (!NodeFS.existsSync(manifest))
    return { gate: "missing" as Gate, reason: "No supplied capture" };
  try {
    plainAncestors(manifest);
    const capture = decodeCapture(JSON.parse(NodeFS.readFileSync(manifest, "utf8")));
    const artifact = (ref: typeof Artifact.Type, kind: (typeof Artifact.Type)["sourceKind"]) => {
      safePath(ref.path);
      const path = NodePath.join(directory, ref.path);
      plainAncestors(path);
      if (ref.sourceKind !== kind || !NodeFS.lstatSync(path).isFile())
        throw new Error("Artifact source kind/file mismatch");
      const bytes = NodeFS.readFileSync(path);
      if (
        bytes.length > 4 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(ref.sha256) ||
        sha256(bytes) !== ref.sha256
      )
        throw new Error("Artifact hash/size mismatch");
      return bytes.toString("utf8");
    };
    const participant = (refs: typeof Participant.Type, base: string, result?: string) => {
      const task = decodeTask(JSON.parse(artifact(refs.taskStatus, "mcp_result")));
      const run = decodeRun(JSON.parse(artifact(refs.run, "service_snapshot")));
      const checkpoint = decodeCheckpoint(
        JSON.parse(artifact(refs.checkpoint, "service_snapshot")),
      );
      if (
        task.status !== "completed" ||
        task.latestTerminalStatus !== "completed" ||
        task.workState !== "result_available" ||
        task.hasPendingChildRuns ||
        task.hasPendingQuestion ||
        task.pendingApproval !== null ||
        task.waitTimedOut ||
        run.status !== "completed" ||
        run.delegatedTaskId !== task.taskId ||
        run.id !== task.latestTerminalRunId ||
        run.threadId !== task.childThreadId ||
        run.checkpointId !== checkpoint.id ||
        run.rootNodeId === null ||
        checkpoint.nodeId !== run.rootNodeId ||
        checkpoint.runId !== run.id ||
        checkpoint.threadId !== run.threadId ||
        checkpoint.status !== "ready" ||
        task.baseCommit !== base ||
        !task.resultCommit ||
        (result !== undefined && task.resultCommit !== result)
      )
        throw new Error("Task/run/checkpoint tuple mismatch or non-ready subject");
      commitId(task.resultCommit);
      if (
        !checkpoint.ref.startsWith("refs/") ||
        git(NodePath.join(sample, "repo"), ["rev-parse", "--verify", `${checkpoint.ref}^{commit}`])
          .toString()
          .trim() !== task.resultCommit
      )
        throw new Error("Checkpoint ref/result mismatch");
      if (
        task.providerInstanceId !== run.providerInstanceId ||
        task.providerInstanceId !== run.modelSelection.instanceId ||
        task.model !== run.modelSelection.model ||
        !NodeUtil.isDeepStrictEqual(task.options ?? [], run.modelSelection.options ?? [])
      )
        throw new Error("Selected model/options mismatch");
      return { task, run, checkpoint };
    };
    const subject = participant(capture.subject, baseCommit, resultCommit);
    const reviewer = participant(capture.reviewer, resultCommit);
    if (
      subject.task.taskId === reviewer.task.taskId ||
      subject.run.threadId === reviewer.run.threadId ||
      subject.run.id === reviewer.run.id
    )
      throw new Error("Reviewer must be a fresh independent task/thread/run");
    const review = decodeReview(JSON.parse(artifact(capture.review, "review_response")));
    if (
      review.verdict !== "approve" ||
      review.findings.length ||
      review.reviewerTaskId !== reviewer.task.taskId ||
      review.reviewerThreadId !== reviewer.run.threadId ||
      review.reviewerTerminalRunId !== reviewer.run.id ||
      !NodeUtil.isDeepStrictEqual(review.reviewedSubjectTuple, {
        taskId: subject.task.taskId,
        childThreadId: subject.task.childThreadId,
        terminalRunId: subject.run.id,
        baseCommit,
        resultCommit,
      })
    )
      throw new Error("Reviewer rejection or reviewed tuple mismatch");
    const repo = NodePath.join(sample, "repo");
    if (
      artifact(capture.reviewTreeBefore, "process_output").trim() ||
      artifact(capture.reviewTreeAfter, "process_output").trim() ||
      !git(repo, ["rev-parse", `${resultCommit}^{tree}`]).equals(
        git(repo, ["rev-parse", `${reviewer.task.resultCommit}^{tree}`]),
      )
    )
      throw new Error("Dirty or changed reviewer tree");
    for (const ref of [capture.subjectProtocol, capture.reviewerProtocol]) {
      const raw = artifact(ref, "native_protocol");
      if (!raw.trim() || !raw.endsWith("\n")) throw new Error("Missing/truncated native protocol");
      for (const line of raw.trimEnd().split("\n")) JSON.parse(line);
    }
    return {
      gate: "pass" as Gate,
      reason: "Record consistency only; raw provider identity and lifecycle validation unsupported",
    };
  } catch (error) {
    return { gate: "fail" as Gate, reason: String(error) };
  }
};
export const evaluateNative = (options: {
  sample: string;
  resultCommit: string;
  includeHoldout?: boolean;
}) => {
  const sample = external(options.sample);
  plainAncestors(sample);
  plainAncestors(NodePath.join(sample, "evidence/seed.json"));
  const seed: ReturnType<typeof hydrateNative> = JSON.parse(
    NodeFS.readFileSync(NodePath.join(sample, "evidence/seed.json"), "utf8"),
  );
  const definition = caseDefinition(
    seed.caseId,
    options.includeHoldout,
    commitId(seed.sourceCommit),
  );
  const repo = NodePath.join(sample, "repo");
  for (const path of [
    repo,
    NodePath.join(repo, ".git"),
    NodePath.join(sample, "evidence"),
    NodePath.join(sample, "export"),
  ])
    plainAncestors(path);
  const evidence = NodePath.join(sample, "evidence/evaluation");
  NodeFS.mkdirSync(evidence);
  const gates: Record<string, Gate> = {
    "native-identity": "missing",
    "service-provenance": "missing",
    checkpoint: "missing",
    "app-owned-child-lifecycle": "missing",
    "independent-review": "missing",
    "reviewer-session-independence": "missing",
    "test-evidence": "missing",
    "candidate-regression": "missing",
    "no-product-acceptance-or-publication": "missing",
  };
  const probes: ReturnType<typeof runTests>[] = [];
  const errors: string[] = [];
  const failures: string[] = [];
  let capture = { gate: "missing" as Gate, reason: "Capture not inspected" };
  try {
    if (process.version !== "v26.12.1") throw new Error("Requires Node 26.12.1");
    if (
      !NodeFS.lstatSync(NodePath.join(repo, ".git")).isDirectory() ||
      NodeFS.existsSync(NodePath.join(repo, ".git/objects/info/alternates")) ||
      NodeFS.existsSync(NodePath.join(repo, ".git/commondir"))
    )
      throw new Error("Requires standalone Git storage without indirection/alternates");
    plainTree(NodePath.join(repo, ".git"));
    capture = checkCapture(sample, seed.baseCommit, options.resultCommit);
    gates["capture-consistency"] = capture.gate;
    const base = exportCommit(repo, seed.baseCommit, NodePath.join(sample, "export/base"));
    const result = exportCommit(repo, options.resultCommit, NodePath.join(sample, "export/result"));
    gates["result-tree"] = "pass";
    gates["base-ancestry"] = git(repo, ["rev-list", options.resultCommit, "--"])
      .toString()
      .trim()
      .split("\n")
      .includes(seed.baseCommit)
      ? "pass"
      : "fail";
    const expected = definition.entry.specification!.files;
    gates["seed-integrity"] =
      seed.caseSha256 === definition.caseSha256 &&
      base.length === expected.length &&
      expected.every((file) =>
        base.some(
          (b) => b.path === file.path && b.mode === "100644" && b.sha256 === sha256(file.content),
        ),
      )
        ? "pass"
        : "fail";
    const allowed =
      seed.caseId === "repair-cache-expiry"
        ? ["src/cache.ts", "tests/cache.test.ts"]
        : ["src/sum.ts"];
    const changedPaths = [...new Set([...base, ...result].map((f) => f.path))].filter((path) => {
      const before = base.find((f) => f.path === path);
      const after = result.find((f) => f.path === path);
      return before?.oid !== after?.oid || before?.mode !== after?.mode;
    });
    gates.ownership = changedPaths.every((path) => allowed.includes(path)) ? "pass" : "fail";
    json(NodePath.join(evidence, "files.json"), {
      baseCommit: seed.baseCommit,
      resultCommit: options.resultCommit,
      baseTree: git(repo, ["rev-parse", `${seed.baseCommit}^{tree}`])
        .toString()
        .trim(),
      resultTree: git(repo, ["rev-parse", `${options.resultCommit}^{tree}`])
        .toString()
        .trim(),
      base,
      result,
      changedPaths,
    });
    if (
      gates["seed-integrity"] === "pass" &&
      gates.ownership === "pass" &&
      gates["base-ancestry"] === "pass"
    ) {
      for (const phase of ["seed", "result"]) {
        const directory = NodePath.join(sample, `export/${phase === "seed" ? "base" : "result"}`);
        const probe = NodePath.join(evidence, `${phase}.test.mjs`);
        NodeFS.writeFileSync(probe, probeSource(seed.caseId, directory), { flag: "wx" });
        probes.push(
          runTests(
            directory,
            probe,
            phase,
            evidence,
            phase === "seed" ? seed.baseCommit : options.resultCommit,
            seed.caseId === "repair-cache-expiry"
              ? ["cache-boundary", "cache-future", "cache-expired"]
              : ["sum-positive", "sum-negative"],
          ),
        );
      }
      const seedProbe = probes[0]!;
      gates["seed-failure"] =
        seedProbe.status === "infrastructure_error"
          ? "missing"
          : seedProbe.status === "fail" &&
              seedProbe.failed === (seed.caseId === "repair-cache-expiry" ? 1 : 2)
            ? "pass"
            : "fail";
      gates.behavior =
        probes[1]!.status === "pass" ? "pass" : probes[1]!.status === "fail" ? "fail" : "missing";
      if (seed.caseId === "repair-cache-expiry") {
        const testPath = NodePath.join(sample, "export/result/tests/cache.test.ts");
        if (NodeFS.existsSync(testPath)) {
          const focused = runTests(
            NodePath.join(sample, "export/result"),
            testPath,
            "focused",
            evidence,
            options.resultCommit,
          );
          probes.push(focused);
          gates["focused-tests"] =
            focused.status === "pass" ? "pass" : focused.status === "fail" ? "fail" : "missing";
        } else gates["focused-tests"] = "fail";
      } else gates["focused-tests"] = gates.behavior;
    }
  } catch (error) {
    if (error instanceof SubmissionError) {
      gates["result-tree"] = "fail";
      failures.push(error.message);
    } else errors.push(String(error));
  }
  const status =
    errors.length || probes.some((p) => p.status === "infrastructure_error")
      ? "infrastructure_error"
      : Object.values(gates).includes("fail")
        ? "fail"
        : "blocked";
  const outcome = {
    status,
    exitCode: status === "fail" ? 1 : status === "blocked" ? 2 : 3,
    gates,
    probes,
    errors,
    failures,
    capture,
    evaluator: { kind: "machine", taskTuple: null },
    nativeQualificationClaim: false,
    productAcceptancePerformed: false,
    caseSourceCommit: definition.sourceCommit,
  };
  json(NodePath.join(evidence, "outcome.json"), outcome);
  return outcome;
};

if (import.meta.main) {
  try {
    const { values, positionals } = NodeUtil.parseArgs({
      allowPositionals: true,
      options: {
        case: { type: "string" },
        out: { type: "string" },
        sample: { type: "string" },
        "result-commit": { type: "string" },
        "include-holdout": { type: "boolean", default: false },
      },
    });
    const action = positionals[0];
    if (positionals.length !== 1) throw new Error("Expected hydrate or evaluate");
    if (
      action === "hydrate" &&
      values.case &&
      values.out &&
      !values.sample &&
      !values["result-commit"]
    ) {
      if (process.version !== "v26.12.1") throw new Error("Requires Node 26.12.1");
      const seed = hydrateNative({
        caseId: values.case,
        out: values.out,
        includeHoldout: values["include-holdout"],
      });
      process.stdout.write(
        `${JSON.stringify({ status: "blocked", stage: "hydrated", ...seed, nativeQualificationClaim: false })}\n`,
      );
      process.exitCode = 2;
    } else if (
      action === "evaluate" &&
      values.sample &&
      values["result-commit"] &&
      !values.case &&
      !values.out
    ) {
      const result = evaluateNative({
        sample: values.sample,
        resultCommit: values["result-commit"],
        includeHoldout: values["include-holdout"],
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.exitCode;
    } else
      throw new Error(
        "Use hydrate --case <id> --out <new-external-directory>, or evaluate --sample <directory> --result-commit <SHA>",
      );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ status: "infrastructure_error", error: String(error), nativeQualificationClaim: false })}\n`,
    );
    process.exitCode = 3;
  }
}
