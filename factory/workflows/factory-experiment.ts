import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeUtil from "node:util";

import {
  FactoryTaskRunInput,
  PackConfig,
  addNote,
  capturedKey,
  createTask,
  hashFile,
  readConfig,
  resolveTarget,
  taskTags,
  writeArtifact,
  writeReceipt,
} from "./lib/records.ts";

const { workflow, step, ask, agent, title, tags, within, stop, store } = T3;
const NAME = "factory-experiment";
const taskPool = (taskId: string) => `factory-task:${taskId}`;
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const EVALUATOR_MAX_BYTES = 25 * 1024 * 1024;
const LOG_TAIL_MAX = 8192;
const segment = (n: number) => String(n).padStart(4, "0");
const durationMillis = (text: string) => {
  const duration = Duration.fromInput(text as Parameters<typeof Duration.fromInput>[0]);
  return Option.isSome(duration) ? Duration.toMillis(duration.value) : NaN;
};
const boundedDuration = (minMillis: number, maxMillis: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (text: string) => {
        const millis = durationMillis(text);
        return Number.isInteger(millis) && millis >= minMillis && millis <= maxMillis;
      },
      { expected: `a duration of ${minMillis} to ${maxMillis} milliseconds` },
    ),
  );
const RepoPath = Schema.String.check(
  Schema.makeFilter(
    (path: string) =>
      path.length > 0 &&
      !path.includes("\0") &&
      !path.includes("\\") &&
      !NodePath.win32.parse(path).root &&
      !path.split("/").includes(".."),
    { expected: "a repository-relative path without parent traversal" },
  ),
);
const Protocol = Schema.Struct({
  hypothesis: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  metric: Schema.Struct({
    name: Schema.String,
    direction: Schema.Literals(["min", "max"]),
    minImprovement: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  evaluator: Schema.Struct({
    path: RepoPath,
    command: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  }),
  editGlobs: Schema.Array(RepoPath).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  sealedPaths: Schema.Array(RepoPath).check(Schema.isMaxLength(20)),
  budget: Schema.Struct({
    iterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    wallClock: boundedDuration(0, 12 * 60 * 60 * 1000),
    measureTimeout: boundedDuration(1, 60 * 60 * 1000),
  }),
  orx: Schema.optionalKey(Schema.Boolean),
});
const ROOT = Schema.Struct({ root: Schema.String });
const Draft = Schema.Struct({ idea: Schema.String.check(Schema.isMaxLength(500)) });
const ExperimentRow = Schema.Struct({
  v: Schema.Literal(1),
  taskId: Schema.String,
  attempt: Schema.Int,
  iter: Schema.Int,
  node: Schema.String,
  parent: Schema.NullOr(Schema.String),
  commit: Schema.String,
  status: Schema.Literals(["baseline", "invalid", "discard", "keep", "crash"]),
  evaluatorSha256: Sha256,
  idea: Draft.fields.idea,
  logSha256: Schema.NullOr(Sha256),
  logTail: Schema.String.check(Schema.isMaxLength(LOG_TAIL_MAX)),
  metric: Schema.NullOr(Schema.Finite),
  delta: Schema.NullOr(Schema.Finite),
  orxRun: Schema.optionalKey(Schema.String),
  orxParent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  at: Schema.String,
});
type ExperimentRow = typeof ExperimentRow.Type;
const Metric = Schema.Struct({
  metric: Schema.Finite,
  orx: Schema.optionalKey(
    Schema.Struct({ run: Schema.String, parent: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
});
const Results = Schema.Struct({ resultsSha: Sha256, preview: Schema.String });
const Sealed = Schema.Struct({
  root: Schema.String,
  baselineCommit: Schema.String,
  evaluatorSha256: Sha256,
  ignored: Schema.Array(Schema.String),
  sealedAt: Schema.Number,
});
const Scope = Schema.Struct({ invalid: Schema.NullOr(Schema.String), commit: Schema.String });
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Metric));
const encodeProtocol = Schema.encodeSync(
  Schema.fromJsonString(Protocol, {
    replacer: (_key: string, value: unknown) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    },
  }),
);
const encodeRows = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ExperimentRow)));
const encodeIso = Schema.encodeSync(Schema.DateTimeUtcFromString);
const fromEpoch = Schema.decodeSync(Schema.DateTimeUtcFromMillis);
const currentMillis = Effect.clockWith((clock) => clock.currentTimeMillis);
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const git = (root: string, ...args: ReadonlyArray<string>) =>
  Effect.tryPromise(() =>
    execFile("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  ).pipe(Effect.map(({ stdout }) => stdout));
const realpath = (path: string) => Effect.tryPromise(() => NodeFSP.realpath(path));
const evaluatorFile = Effect.fn("factoryExperiment.evaluatorFile")(function* (
  root: string,
  path: string,
) {
  const resolved = yield* realpath(NodePath.resolve(root, path));
  const relative = NodePath.relative(root, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  ) {
    return yield* Effect.fail("evaluator is outside the worktree");
  }
  return yield* Effect.map(hashFile(resolved, EVALUATOR_MAX_BYTES), (file) => ({
    ...file,
    path: resolved,
  }));
});
const sealRoot = Effect.fn("factoryExperiment.sealRoot")(function* (root: string, project: string) {
  if (!NodePath.isAbsolute(root)) return yield* Effect.fail("worktree root must be absolute");
  const resolved = yield* realpath(root);
  const common = yield* git(resolved, "rev-parse", "--git-common-dir");
  const projectCommon = yield* git(project, "rev-parse", "--git-common-dir");
  const projectDir = yield* realpath(NodePath.resolve(project, projectCommon.trimEnd()));
  const commonDir = yield* realpath(NodePath.resolve(resolved, common.trimEnd()));
  const privateDir = yield* realpath(
    (yield* git(resolved, "rev-parse", "--absolute-git-dir")).trimEnd(),
  );
  const top = (yield* git(resolved, "rev-parse", "--show-toplevel")).trimEnd();
  const isSame = (a: string, b: string) => NodePath.relative(a, b) === "";
  if (
    !isSame(projectDir, commonDir) ||
    isSame(privateDir, commonDir) ||
    !isSame(top, resolved) ||
    isSame(resolved, yield* realpath(project))
  )
    return yield* Effect.fail("not a worktree of this project");
  return resolved;
});

const worktreeStatus = Effect.fn("factoryExperiment.worktreeStatus")(function* (root: string) {
  const status = yield* git(
    root,
    "status",
    "--porcelain",
    "-z",
    "--no-renames",
    "--untracked-files=all",
    "--ignored=matching",
  );
  const ignored: string[] = [];
  let dirty = false;
  for (const entry of status.split("\0")) {
    if (entry.startsWith("!! ")) ignored.push(entry.slice(3));
    else if (entry !== "") dirty = true;
  }
  // Matching an ignored directory hides its children, including new files in an old directory.
  if (ignored.some((path) => path.endsWith("/"))) {
    const files = yield* git(root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard");
    return { dirty, ignored: [...new Set([...ignored, ...files.split("\0").filter(Boolean)])] };
  }
  return { dirty, ignored };
});

const cleanTrial = Effect.fn("factoryExperiment.cleanTrial")(function* (
  root: string,
  commit: string,
  baselineIgnored: ReadonlySet<string>,
) {
  yield* git(root, "reset", "--hard", commit);
  if (baselineIgnored.size === 0) {
    yield* git(root, "clean", "-fdx");
  } else {
    // Ignore rules may have changed. Clean literal untracked paths, never a baseline file or its parent.
    const untracked = yield* git(root, "ls-files", "-z", "--others");
    const directories = yield* git(root, "ls-files", "-z", "--others", "--directory");
    const protectedPaths = new Set(baselineIgnored);
    for (const path of baselineIgnored) {
      for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
        protectedPaths.add(path.slice(0, slash + 1));
      }
    }
    const paths = new Set([...directories.split("\0"), ...untracked.split("\0")]);
    paths.delete("");
    let batch: string[] = [];
    let length = 0;
    for (const path of paths) {
      if (protectedPaths.has(path)) continue;
      if (length + path.length > 12_000 && batch.length !== 0) {
        yield* git(root, "--literal-pathspecs", "clean", "-fdx", "--", ...batch);
        batch = [];
        length = 0;
      }
      batch.push(path);
      length += path.length + 3;
    }
    if (batch.length !== 0) {
      yield* git(root, "--literal-pathspecs", "clean", "-fdx", "--", ...batch);
    }
  }
  const remaining = yield* worktreeStatus(root);
  if (remaining.dirty || remaining.ignored.some((path) => !baselineIgnored.has(path))) {
    return yield* Effect.fail("Trial cleanup left new paths in the experiment worktree.");
  }
});

// Only the last nonblank stdout line is a measurement; stderr and trailing blank lines must
// not displace it. An oversized result line is invalid, not a valid JSON suffix of that line.
const metricLine = (capacity: number) => {
  const pending = Buffer.allocUnsafe(capacity);
  let length = 0;
  let nonblank = false;
  let last = "";
  const finish = () => {
    if (nonblank) last = length > capacity ? "" : pending.toString("utf8", 0, length).trim();
    length = 0;
    nonblank = false;
  };
  return {
    append(chunk: Buffer) {
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const size = end - start;
        if (length + size <= capacity) chunk.copy(pending, length, start, end);
        length = Math.min(length + size, capacity + 1);
        if (!nonblank) nonblank = chunk.toString("utf8", start, end).trim() !== "";
        if (newline < 0) break;
        finish();
        start = newline + 1;
      }
    },
    value() {
      finish();
      return last;
    },
  };
};
const command = (
  file: string,
  argv: ReadonlyArray<string>,
  cwd: string,
  timeout: number,
  logPath: string,
) =>
  Effect.tryPromise(async () => {
    await NodeFSP.mkdir(NodePath.dirname(logPath), { recursive: true });
    const child = NodeChildProcess.spawn(file, argv, {
      cwd,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const merged = new NodeStream.PassThrough();
    const digest = NodeCrypto.createHash("sha256");
    const tail = Buffer.allocUnsafe(LOG_TAIL_MAX * 4);
    const metric = metricLine(tail.length);
    let cursor = 0;
    let used = 0;
    merged.on("data", (chunk: Buffer) => {
      digest.update(chunk);
      const bytes = chunk.subarray(-tail.length);
      const first = Math.min(bytes.length, tail.length - cursor);
      bytes.copy(tail, cursor, 0, first);
      bytes.copy(tail, 0, first);
      cursor = (cursor + bytes.length) % tail.length;
      used = Math.min(used + bytes.length, tail.length);
    });
    child.stdout.on("data", (chunk: Buffer) => metric.append(chunk));
    child.stdout.pipe(merged, { end: false });
    child.stderr.pipe(merged, { end: false });

    let failed: string | null = null;
    let closed = false;
    let treeKill: Promise<void> | undefined;
    const terminate = () => {
      const pid = child.pid;
      if (!closed && pid !== undefined) {
        try {
          NodeProcess.kill(-pid, "SIGKILL");
        } catch {
          const systemRoot = NodeProcess.env.SystemRoot;
          if (
            systemRoot &&
            NodePath.win32.isAbsolute(systemRoot) &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            treeKill ??= execFile(
              NodePath.win32.join(systemRoot, "System32", "taskkill.exe"),
              ["/PID", String(pid), "/T", "/F"],
              { timeout: 1000, windowsHide: true },
            ).then(
              () => undefined,
              () => {
                child.kill("SIGKILL");
              },
            );
          } else {
            child.kill("SIGKILL");
          }
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      merged.end();
    };
    child.once("error", (error) => {
      failed ??= error.message;
    });
    child.once("close", (code, signal) => {
      closed = true;
      if (code !== 0) failed ??= `Evaluator exited with ${signal ?? code}.`;
      merged.end();
    });
    const timer = setTimeout(() => {
      if (closed) return;
      failed = "Evaluator timed out.";
      terminate();
    }, timeout);
    try {
      await NodeStreamPromises.pipeline(merged, NodeFS.createWriteStream(logPath));
    } catch (error) {
      terminate();
      throw error;
    } finally {
      clearTimeout(timer);
      await treeKill;
    }
    const bytes =
      used === tail.length
        ? Buffer.concat([tail.subarray(cursor), tail.subarray(0, cursor)])
        : tail.subarray(0, used);
    return {
      failed,
      logSha256: digest.digest("hex"),
      logTail: bytes.toString("utf8").slice(-LOG_TAIL_MAX),
      line: metric.value(),
    };
  });
const matchedBy = (glob: string) => {
  const chunks = NodePath.posix.normalize(glob).replace(/\/$/, "").split("/");
  let pattern = "";
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    if (chunk === "**") {
      if (index < chunks.length - 1) pattern += "(?:[^/]+/)*";
      else pattern += ".*";
    } else {
      pattern += chunk
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
      if (index < chunks.length - 1) pattern += "/";
    }
  }
  return new RegExp(`^${pattern}$`, "s");
};
const resultEntry = (taskId: string, attempt: number, iter: number) =>
  store.entry(`factory/v1/result/${taskId}/${segment(attempt)}/${segment(iter)}`, ExperimentRow);

const rowAbsent = Effect.fn("factoryExperiment.settleRow")(function* (row: ExperimentRow) {
  const entry = resultEntry(row.taskId, row.attempt, row.iter);
  return yield* store.transaction(
    Effect.gen(function* () {
      const saved = yield* entry.get;
      if (Option.isSome(saved)) return saved.value;
      yield* entry.set(row);
      return row;
    }),
  );
});

const persistedInline = Effect.fn("factoryExperiment.writeInline")(function* (
  kind: "protocol" | "results",
  text: string,
  record: { runId: string; taskId: string; attempt: number },
) {
  const sha256 = NodeCrypto.createHash("sha256").update(text).digest("hex");
  yield* writeArtifact({
    ...record,
    kind,
    sha256,
    step: kind === "protocol" ? "seal" : "results",
    label: kind === "protocol" ? "Protocol" : "results.tsv",
    location: { _tag: "inline", text },
    bytes: Buffer.byteLength(text),
  });
  return sha256;
});

type Protocol = typeof Protocol.Type;
const measure = Effect.fn("factoryExperiment.measure")(function* (
  iter: number,
  expectedEvaluatorSha: string,
  root: string,
  protocol: Protocol,
  runId: string,
  draft: ExperimentRow,
  keepMetric: number | null,
) {
  return yield* step(
    `measure/${iter}`,
    { returns: ExperimentRow },
    Effect.gen(function* () {
      const saved = yield* resultEntry(draft.taskId, draft.attempt, iter).get;
      if (Option.isSome(saved)) return saved.value;
      const file = yield* Effect.option(evaluatorFile(root, protocol.evaluator.path));
      let row: ExperimentRow = draft;
      if (Option.isNone(file) || file.value.sha256 !== expectedEvaluatorSha) {
        row = {
          ...draft,
          status: "invalid",
          logTail: "The sealed evaluator changed or is missing.",
        };
      } else {
        const [executable, ...argv] = protocol.evaluator.command;
        if (executable === undefined) return yield* Effect.fail("empty evaluator command");
        const result = yield* command(
          executable,
          argv,
          root,
          durationMillis(protocol.budget.measureTimeout),
          NodePath.join(NodeOS.tmpdir(), "t3factory", runId, `${iter}.log`),
        ).pipe(Effect.result);
        const after = yield* Effect.option(evaluatorFile(root, protocol.evaluator.path));
        if (Option.isNone(after) || after.value.sha256 !== expectedEvaluatorSha) {
          row = {
            ...draft,
            status: "invalid",
            logSha256: result._tag === "Success" ? result.success.logSha256 : null,
            logTail:
              `${result._tag === "Success" ? result.success.logTail : ""}\nThe evaluator changed during measurement.`.slice(
                -LOG_TAIL_MAX,
              ),
          };
        } else if (result._tag === "Failure") {
          row = { ...draft, status: "crash", logTail: String(result.failure).slice(-LOG_TAIL_MAX) };
        } else {
          const output = result.success;
          const value = decodeLine(output.line);
          const logged = { ...draft, logSha256: output.logSha256, logTail: output.logTail };
          if (output.failed !== null || Option.isNone(value)) {
            row = {
              ...logged,
              status: "crash",
              logTail:
                logged.logTail ||
                (output.failed ?? "Missing metric on the last stdout line.").slice(-LOG_TAIL_MAX),
            };
          } else {
            const { metric, orx } = value.value;
            const delta =
              keepMetric === null
                ? null
                : protocol.metric.direction === "min"
                  ? keepMetric - metric
                  : metric - keepMetric;
            row =
              delta !== null && !Number.isFinite(delta)
                ? { ...logged, status: "crash" }
                : {
                    ...logged,
                    metric,
                    delta,
                    status:
                      delta === null
                        ? "baseline"
                        : delta >= protocol.metric.minImprovement
                          ? "keep"
                          : "discard",
                    ...(protocol.orx && orx !== undefined
                      ? {
                          orxRun: orx.run,
                          ...(orx.parent === undefined ? {} : { orxParent: orx.parent }),
                        }
                      : {}),
                  };
          }
        }
      }
      return iter === 0 ? yield* rowAbsent(row) : row;
    }),
  );
});

export default workflow(
  NAME,
  {
    version: 1,
    payload: FactoryTaskRunInput,
    asks: {
      protocol: "Approve the experiment protocol?",
      promote: "Promote the experiment result?",
    },
    returns: Schema.Struct({
      outcome: Schema.Literals(["kept", "promoted"]),
      bestMetric: Schema.Number,
      iterations: Schema.Number,
      resultsSha: Sha256,
      promotedTaskId: Schema.NullOr(Schema.String),
    }),
  },
  Effect.fn("factory-experiment.run")(function* (input, run) {
    yield* title(`T-${input.number} ${input.title}`);
    yield* tags(taskTags(input.taskId, input.projectId, "planning"));
    const config = yield* step("config", { returns: PackConfig }, readConfig(input.projectId));
    const checkout = yield* resolveTarget(input.projectId);
    if ("problem" in checkout) return yield* stop(checkout.problem);
    if (checkout.workspace !== "worktree" || checkout.workspaceRoot === null)
      return yield* stop("an experiment needs a Git project");
    const workspaceRoot = checkout.workspaceRoot;
    const planModel = config.planModel ?? input.model;
    const workerModel = config.workerModel ?? input.model;
    const { value: protocol } = yield* agent("protocol", {
      project: checkout.projectId,
      workspace: { type: "root" },
      interactionMode: "plan",
      ...(planModel === null ? {} : { model: planModel }),
      returns: Protocol,
      timeout: config.stepTimeout,
      brief: [
        `T-${input.number}: ${input.title}`,
        input.description,
        "Propose a bounded experiment. Make no changes and do not run it.",
        "Choose an existing evaluator and its executable and argv (no shell). Its last nonempty stdout line must be JSON with a numeric metric. Seal the data and code on which that measurement depends.",
        "Choose repository-relative paths, edit globs using only * and **, a hypothesis, metric, direction, minimum improvement, and 1–20 iterations.",
        "Use duration strings for both the wall clock (up to 12 hours) and per-command timeout (up to one hour).",
      ].join("\n"),
    });
    const approval = yield* ask("approve-protocol", {
      title: `Seal this experiment protocol for T-${input.number}?`,
      kind: "protocol",
      choices: ["Seal", "Drop"],
      data: protocol,
    });
    if (Option.isNone(approval) || approval.value.choice !== "Seal")
      return yield* stop("protocol not approved");
    const sealedAnswer = approval.value;
    const baseline = yield* agent("baseline", {
      project: checkout.projectId,
      returns: ROOT,
      workspace: { type: "worktree", baseRef: config.baseRef ?? "HEAD" },
      runtimeMode: "full-access",
      timeout: config.stepTimeout,
      ...(workerModel === null ? {} : { model: workerModel }),
      brief:
        "Start this experiment on its own clean worktree. Change nothing: do not run the evaluator or change files, branches, or commits. Return only its absolute root. If the engine created the worktree, leave the baseline repository as-is.",
    });
    const { taskId, attempt } = input;
    const runId = run.id;
    const record = { taskId, attempt, runId };
    const sealed = yield* step(
      "seal",
      { returns: Sealed },
      Effect.gen(function* () {
        const root = yield* sealRoot(baseline.value.root, workspaceRoot);
        const { dirty, ignored } = yield* worktreeStatus(root);
        if (dirty) return yield* Effect.fail("experiment worktree is not clean");
        const file = yield* evaluatorFile(root, protocol.evaluator.path);
        const baselineCommit = (yield* git(root, "rev-parse", "HEAD")).trim();
        const protocolSha = yield* persistedInline("protocol", encodeProtocol(protocol), record);
        yield* writeArtifact({
          ...record,
          kind: "evaluator",
          step: "seal",
          label: "Evaluator",
          location: { _tag: "file", path: file.path },
          sha256: file.sha256,
          bytes: file.bytes,
        });
        yield* writeReceipt({
          ...record,
          kind: "sealed",
          sha256: protocolSha,
          by: sealedAnswer.answeredBySession === undefined ? "agent" : "person",
          detail: { reason: `Baseline ${baselineCommit}; evaluator SHA-256 ${file.sha256}` },
        });
        return {
          root,
          baselineCommit,
          ignored,
          evaluatorSha256: file.sha256,
          sealedAt: yield* currentMillis,
        };
      }),
    );
    const { root, baselineCommit, evaluatorSha256, sealedAt } = sealed;
    const firstDraft: ExperimentRow = {
      v: 1,
      taskId,
      attempt,
      iter: 0,
      node: "e0",
      parent: null,
      commit: baselineCommit,
      status: "baseline",
      evaluatorSha256,
      idea: "Baseline",
      metric: null,
      delta: null,
      logSha256: null,
      logTail: "",
      at: encodeIso(fromEpoch(sealedAt)),
    };
    yield* tags(taskTags(taskId, input.projectId, "doing"));
    const first = yield* measure(0, evaluatorSha256, root, protocol, runId, firstDraft, null);
    const baselineIgnored = new Set(sealed.ignored);
    yield* step(
      "settle/0",
      { returns: Schema.Void },
      Effect.gen(function* () {
        const checkedRoot = yield* sealRoot(root, workspaceRoot);
        if (NodePath.relative(root, checkedRoot) !== "")
          return yield* Effect.fail("experiment worktree moved");
        if ((yield* git(root, "rev-parse", "HEAD")).trim() !== baselineCommit)
          return yield* Effect.fail("baseline HEAD changed during measurement");
        yield* cleanTrial(root, baselineCommit, baselineIgnored);
      }),
    );
    if (first.status !== "baseline" || first.metric === null)
      return yield* stop("baseline measurement failed");
    const rows: ExperimentRow[] = [first];
    let bestRow = first;
    let bestMetric = first.metric;
    let consecutiveCrashes = 0;
    const deadline = sealedAt + durationMillis(protocol.budget.wallClock);
    const editGlobs = protocol.editGlobs.map(matchedBy);
    const sealedPaths = [protocol.evaluator.path, ...protocol.sealedPaths].map((path) =>
      NodePath.posix.normalize(path).replace(/\/$/, ""),
    );
    for (let i = 1; i <= protocol.budget.iterations; i++) {
      if (consecutiveCrashes >= 3) break;
      const clock = yield* step(`clock/${i}`, { returns: Schema.Number }, currentMillis);
      if (clock >= deadline) break;
      const keepCommit = bestRow.commit;
      const candidate = yield* within(
        taskPool(taskId),
        { limit: config.concurrency },
        agent(`candidate/${i}`, {
          thread: baseline.thread,
          returns: Draft,
          timeout: config.stepTimeout,
          brief: [
            `Trial ${i}. Hypothesis: ${protocol.hypothesis}`,
            `Start at ${keepCommit} in this worktree. Make one candidate commit. Leave the worktree clean; never push or open a pull request.`,
            `Only edit paths matching: ${protocol.editGlobs.join(", ")}.`,
            `Never edit the evaluator (${protocol.evaluator.path}) or sealed paths: ${protocol.sealedPaths.join(", ")}.`,
            `Return a short idea describing what you tried. Prior observations (including failed trials):`,
            encodeRows(rows),
          ].join("\n"),
        }),
      );
      const scope = yield* step(
        `scope/${i}`,
        { returns: Scope },
        Effect.gen(function* () {
          const commit = (yield* git(root, "rev-parse", "HEAD")).trim();
          const diff = yield* git(
            root,
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            `${keepCommit}..${commit}`,
            "--",
          );
          const { dirty, ignored } = yield* worktreeStatus(root);
          const addedIgnored = ignored.find((path) => !baselineIgnored.has(path));
          if (addedIgnored !== undefined)
            return { commit, invalid: `New ignored path: ${addedIgnored}` };
          const outside = diff
            .split("\0")
            .find(
              (path) =>
                path !== "" &&
                (!editGlobs.some((glob) => glob.test(path)) ||
                  sealedPaths.some(
                    (sealedPath) =>
                      sealedPath === "." ||
                      path === sealedPath ||
                      path.startsWith(`${sealedPath}/`),
                  )),
            );
          if (outside !== undefined) return { commit, invalid: `Out-of-scope change: ${outside}` };
          if (dirty) return { commit, invalid: "Candidate left uncommitted changes." };
          const parents = (yield* git(root, "show", "-s", "--format=%P", commit)).trim();
          if (parents !== keepCommit)
            return { commit, invalid: "Expected one candidate commit on the kept commit." };
          const file = yield* Effect.option(evaluatorFile(root, protocol.evaluator.path));
          const invalid =
            Option.isNone(file) || file.value.sha256 !== evaluatorSha256
              ? "The sealed evaluator changed or is missing."
              : null;
          return { commit, invalid };
        }),
      );
      const draft: ExperimentRow = {
        ...firstDraft,
        iter: i,
        node: `e${i}`,
        parent: bestRow.node,
        commit: scope.commit,
        idea: candidate.value.idea,
        at: encodeIso(fromEpoch(clock)),
        status: "invalid",
        logTail: (scope.invalid ?? "").slice(-LOG_TAIL_MAX),
      };
      const measured =
        scope.invalid === null
          ? yield* measure(i, evaluatorSha256, root, protocol, runId, draft, bestMetric)
          : draft;
      const row = yield* step(
        `settle/${i}`,
        { returns: ExperimentRow },
        Effect.gen(function* () {
          const checkedRoot = yield* sealRoot(root, workspaceRoot);
          if (NodePath.relative(root, checkedRoot) !== "")
            return yield* Effect.fail("experiment worktree moved");
          const head = (yield* git(root, "rev-parse", "HEAD")).trim();
          if (head !== scope.commit && !(measured.status !== "keep" && head === keepCommit)) {
            return yield* Effect.fail("worktree HEAD changed since the candidate was inspected");
          }
          // Pin the journaled HEAD, not the live HEAD: a replay can follow a completed reset.
          if (scope.commit !== keepCommit) {
            yield* git(
              root,
              "update-ref",
              `refs/t3factory/exp/${taskId}/${attempt}/${i}`,
              scope.commit,
            );
          }
          const saved = yield* rowAbsent(measured);
          yield* cleanTrial(
            root,
            saved.status === "keep" ? saved.commit : keepCommit,
            baselineIgnored,
          );
          return saved;
        }),
      );
      rows.push(row);
      if (row.status === "keep" && row.metric !== null) {
        bestRow = row;
        bestMetric = row.metric;
      }
      consecutiveCrashes = row.status === "crash" ? consecutiveCrashes + 1 : 0;
    }
    const { resultsSha, preview } = yield* step(
      "results",
      { returns: Results },
      Effect.gen(function* () {
        const text =
          [
            "iter\tnode\tparent\tcommit\tstatus\tmetric\tdelta\tevaluator_sha256\tidea",
            ...rows.map((row) =>
              [
                row.iter,
                row.node,
                row.parent,
                row.commit,
                row.status,
                row.metric,
                row.delta,
                row.evaluatorSha256,
                row.idea.replace(/[\t\r\n]+/g, " "),
              ].join("\t"),
            ),
          ].join("\n") + "\n";
        const resultsSha = yield* persistedInline("results", text, record);
        return { resultsSha, preview: text.slice(0, 2000) };
      }),
    );
    yield* tags(taskTags(taskId, input.projectId, "review"));
    const question = {
      title: `Promote the result of T-${input.number}?`,
      kind: "promote",
      choices: ["Promote to task", "Promote to brief", "Keep as result"],
      data: { bestRow, rowsCount: rows.length, resultsSha, resultsTsvPreview: preview },
    } as const;
    let answer = yield* ask("promote", question);
    if (
      config.mergeNeedsPerson &&
      Option.isSome(answer) &&
      answer.value.choice !== "Keep as result" &&
      answer.value.answeredBySession === undefined
    )
      answer = yield* ask("promote/person", question);
    let promotedTaskId: string | null = null;
    if (
      Option.isSome(answer) &&
      answer.value.choice !== "Keep as result" &&
      (!config.mergeNeedsPerson || answer.value.answeredBySession !== undefined)
    ) {
      const { choice, answeredBySession } = answer.value;
      promotedTaskId = yield* step(
        "promote/task",
        { returns: Schema.String },
        Effect.gen(function* () {
          const created = yield* createTask(
            {
              title: input.title,
              description: [
                `Promoted experiment T-${input.number}, attempt ${attempt}.`,
                protocol.hypothesis,
                `Best result: ${protocol.metric.name} = ${bestMetric} (${bestRow.node}, commit ${bestRow.commit}).`,
                `Results SHA-256: ${resultsSha}`,
                preview,
              ].join("\n"),
              projectId: input.projectId,
              lane: "backlog",
              kind: choice === "Promote to task" ? "software" : "knowledge",
              source: { _tag: "promoted", fromTaskId: taskId, artifactSha256: resultsSha },
              parentId: null,
              blockedBy: [],
              assignee: null,
              model: input.model,
            },
            capturedKey(runId, "promote"),
          );
          if ("problem" in created) return yield* Effect.fail(created.problem);
          const id = created.task.id;
          yield* writeReceipt({
            ...record,
            kind: "promoted",
            sha256: resultsSha,
            by: answeredBySession === undefined ? "agent" : "person",
            detail: { taskId: id },
          });
          return id;
        }),
      );
    }
    const iterations = rows.length - 1;
    const outcome = promotedTaskId === null ? "kept" : "promoted";
    yield* step(
      "finish",
      { returns: Schema.Void },
      addNote(
        taskId,
        [
          `Experiment attempt ${attempt}: ${iterations} iterations; best ${protocol.metric.name} = ${bestMetric} at ${bestRow.commit}.`,
          `Results SHA-256: ${resultsSha}.`,
          promotedTaskId === null ? "Kept as a result." : `Promoted to task ${promotedTaskId}.`,
        ].join("\n"),
        NAME,
        capturedKey(runId, "finish"),
      ),
    );
    yield* tags(taskTags(taskId, input.projectId, "done"));
    return { outcome, bestMetric, iterations, resultsSha, promotedTaskId } as const;
  }),
);
