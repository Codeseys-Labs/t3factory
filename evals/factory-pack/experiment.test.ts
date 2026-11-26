// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FactoryArtifact, FactoryReceipt, FactoryTask } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import type { AgentResult } from "../../apps/server/src/workflows/WorkflowAgents.ts";
import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Service = Workflows.Workflows["Service"];
const TASK_ID = "20000000-0000-4000-8000-000000000001";
const PROJECT = "project-1";
const SCRATCH_PROJECT = "scratch-proj-1";
const AT = "2026-01-01T00:00:00.000Z";
const SHA256 = /^[0-9a-f]{64}$/;
const MODEL = { instanceId: "codex", model: "test-worker" };
const PERSON = { label: "Test person", sessionId: "session-1" };
const TASK = {
  v: 1,
  id: TASK_ID,
  number: 7,
  rev: 1,
  projectId: PROJECT,
  kind: "research",
  title: "Lower the loss",
  description: "Find a model setting with a lower loss.",
  lane: "ready",
  laneSetAt: AT,
  parentId: null,
  blockedBy: [],
  assignee: null,
  model: MODEL,
  source: { _tag: "local" },
  createdAt: AT,
  updatedAt: AT,
};
const PROTOCOL = {
  hypothesis: "A smaller learning rate lowers the loss.",
  metric: { name: "loss", direction: "min", minImprovement: 0.1 },
  evaluator: { path: "eval.mjs", command: ["node", "eval.mjs"] },
  editGlobs: ["model.txt"],
  sealedPaths: ["sealed.txt"],
  budget: { iterations: 3, wallClock: "1 hour", measureTimeout: "1 minute" },
};
const PROMOTE_CHOICES = ["Promote to task", "Promote to brief", "Keep as result"];
const RESULTS_HEADER = [
  "iter",
  "node",
  "parent",
  "commit",
  "status",
  "metric",
  "delta",
  "evaluator_sha256",
  "idea",
];
const EVALUATOR = [
  'import * as NodeFS from "node:fs";',
  'const loss = Number(NodeFS.readFileSync("model.txt", "utf8").trim());',
  'console.log("scoring model.txt");',
  "console.log('{\"metric\": ' + loss + '}');",
  "",
].join("\n");
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const EVALUATOR_SHA = sha256(EVALUATOR);
const CANDIDATES = new Map([
  ["candidate/1", { file: "model.txt", text: "0.7\n", idea: "Halve the learning rate" }],
  ["candidate/2", { file: "model.txt", text: "0.8\n", idea: "Double the batch size" }],
  ["candidate/3", { file: "outside.txt", text: "cache\n", idea: "Cache the dataset outside" }],
]);
const IDEAS = [...CANDIDATES.values()].map((candidate) => candidate.idea);
const STANDING = {
  state: "open",
  checks: "none",
  mergeability: "unknown",
  url: "https://github.com/factory/pack/pull/1",
} as const;

const ExperimentRow = Schema.Struct({
  v: Schema.Literal(1),
  taskId: Schema.String,
  attempt: Schema.Number,
  iter: Schema.Number,
  node: Schema.String,
  parent: Schema.NullOr(Schema.String),
  commit: Schema.String,
  status: Schema.Literals(["baseline", "keep", "discard", "invalid", "crash"]),
  metric: Schema.NullOr(Schema.Number),
  delta: Schema.NullOr(Schema.Number),
  evaluatorSha256: Schema.String,
  idea: Schema.String,
  logSha256: Schema.NullOr(Schema.String),
  logTail: Schema.String,
  at: Schema.String,
});
const decodeRow = Schema.decodeUnknownEffect(ExperimentRow);
const decodeArtifact = Schema.decodeUnknownEffect(FactoryArtifact);
const decodeReceipt = Schema.decodeUnknownEffect(FactoryReceipt);
const decodeTask = Schema.decodeUnknownEffect(FactoryTask);
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

interface Repo {
  readonly project: string;
  readonly worktree: string;
  readonly baseline: string;
}

const withTempDirectory = async (use: (directory: string) => Promise<unknown>) => {
  // Git prints long paths, which a short (8.3) temp path would not compare equal to.
  const directory = NodeFS.realpathSync.native(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-experiment-")),
  );
  try {
    await use(directory);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
};

const withRepo = (use: (repo: Repo) => Promise<unknown>) =>
  withTempDirectory((directory) => {
    const project = NodePath.join(directory, "project");
    NodeFS.mkdirSync(project);
    git(project, "init", "-b", "main");
    git(project, "config", "user.name", "Factory Test");
    git(project, "config", "user.email", "factory-test@example.com");
    git(project, "config", "commit.gpgsign", "false");
    git(project, "config", "core.autocrlf", "false");
    NodeFS.writeFileSync(NodePath.join(project, "eval.mjs"), EVALUATOR);
    NodeFS.writeFileSync(NodePath.join(project, "model.txt"), "1.0\n");
    NodeFS.writeFileSync(NodePath.join(project, "sealed.txt"), "held-out data\n");
    git(project, "add", "-A");
    git(project, "commit", "-m", "Baseline");
    const worktree = NodePath.join(directory, "experiment");
    git(project, "worktree", "add", "-b", "experiment", worktree);
    return use({ project, worktree, baseline: git(worktree, "rev-parse", "HEAD") });
  });

// Commits once per step, so a replayed result never adds a second commit.
const experiment = (repo: Repo | null, commits = new Map<string, string>()) => ({
  standing: () => STANDING,
  agent: (turn: AgentTurnInput): Partial<AgentResult> => {
    const step = turn.origin.step;
    if (step === "protocol") return { output: PROTOCOL };
    if (repo !== null && step === "baseline") return { output: { root: repo.worktree } };
    const candidate = CANDIDATES.get(step);
    if (repo === null || candidate === undefined) throw new Error(`Unexpected agent step ${step}`);
    if (!commits.has(step)) {
      NodeFS.writeFileSync(NodePath.join(repo.worktree, candidate.file), candidate.text);
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "-m", candidate.idea);
      commits.set(step, git(repo.worktree, "rev-parse", "HEAD"));
    }
    return { output: { idea: candidate.idea } };
  },
});

const seedTarget = (
  workflows: Service,
  key: string,
  target: {
    readonly projectId: string | null;
    readonly workspace: "worktree" | "root" | "scratch";
    readonly workspaceRoot: string | null;
  },
) =>
  workflows.storeSet(`factory/v1/target/${key}`, {
    v: 1,
    ...target,
    problem: null,
    checkedAt: AT,
  });

const startExperiment = Effect.fn("factoryExperiment.test.start")(function* (
  workflows: Service,
  projectId: string | null = PROJECT,
) {
  yield* workflows.storeSet("factory/v1/seq", TASK.number);
  yield* workflows.storeSet(`factory/v1/task/${TASK_ID}`, { ...TASK, projectId });
  return yield* workflows.start(
    "factory-experiment",
    {
      taskId: TASK_ID,
      number: TASK.number,
      attempt: 1,
      title: TASK.title,
      description: TASK.description,
      projectId,
      model: MODEL,
      issueUrl: null,
    },
    { idempotencyKey: `task/${TASK_ID}/a1` },
  );
});

const ask = Effect.fn("factoryExperiment.test.ask")(function* (
  world: World,
  workflows: Service,
  runId: string,
  name: string,
  choices: ReadonlyArray<string>,
) {
  const question = yield* world.question(workflows, runId);
  expect(question.name).toBe(name);
  expect(question.request).toMatchObject({ choices });
  return question;
});

const storedArtifacts = Effect.fn("factoryExperiment.test.artifacts")(function* (
  workflows: Service,
) {
  return yield* Effect.forEach(yield* workflows.stored(`factory/v1/artifact/${TASK_ID}/`), (row) =>
    decodeArtifact(row.value).pipe(
      Effect.map((artifact) => ({ key: row.key, artifact })),
      Effect.orDie,
    ),
  );
});

const storedReceipts = Effect.fn("factoryExperiment.test.receipts")(function* (workflows: Service) {
  return yield* Effect.forEach(yield* workflows.stored(`factory/v1/receipt/${TASK_ID}/`), (row) =>
    decodeReceipt(row.value).pipe(
      Effect.map((receipt) => ({ key: row.key, receipt })),
      Effect.orDie,
    ),
  );
});

const inlineText = (artifact: FactoryArtifact | undefined) => {
  expect(artifact?.location).toMatchObject({ _tag: "inline" });
  return artifact?.location._tag === "inline" ? artifact.location.text : "";
};

effectIt.effect.each([
  {
    label: "a project folder without Git",
    key: PROJECT,
    projectId: PROJECT,
    targetProject: PROJECT,
    workspace: "root",
  },
  {
    label: "the scratch folder",
    key: "scratch",
    projectId: null,
    targetProject: SCRATCH_PROJECT,
    workspace: "scratch",
  },
] as const)("an experiment on $label stops before any agent launches", (entry) =>
  Effect.promise(() =>
    withTempDirectory((directory) =>
      withWorld(experiment(null), (world) =>
        world.server(
          Effect.fn("factoryExperiment.test.notGit")(function* (workflows) {
            yield* seedTarget(workflows, entry.key, {
              projectId: entry.targetProject,
              workspace: entry.workspace,
              workspaceRoot: directory,
            });
            const { runId } = yield* startExperiment(workflows, entry.projectId);
            const done = yield* world.ended(workflows, runId, true);
            expect(done).toMatchObject({
              status: "stopped",
              detail: "an experiment needs a Git project",
              result: null,
            });
            expect(world.startAttempts).toEqual([]);
            expect(yield* workflows.stored(`factory/v1/result/${TASK_ID}/`)).toEqual([]);
            expect(yield* workflows.stored(`factory/v1/receipt/${TASK_ID}/`)).toEqual([]);
          }),
        ),
      ),
    ),
  ),
);

it("a dropped protocol stops before the baseline and seals nothing", () =>
  withRepo((repo) =>
    withWorld(experiment(repo), (world) =>
      world.server(
        Effect.fn("factoryExperiment.test.drop")(function* (workflows) {
          yield* seedTarget(workflows, PROJECT, {
            projectId: PROJECT,
            workspace: "worktree",
            workspaceRoot: repo.project,
          });
          const { runId } = yield* startExperiment(workflows);
          yield* ask(world, workflows, runId, "approve-protocol", ["Seal", "Drop"]);
          yield* workflows.answer(runId, "approve-protocol", { choice: "Drop" }, PERSON);
          const done = yield* world.ended(workflows, runId);
          expect(done).toMatchObject({
            status: "stopped",
            detail: "protocol not approved",
            result: null,
          });
          expect(world.turns.map((turn) => turn.origin.step)).toEqual(["protocol"]);
          expect(world.turns[0]?.launch?.interactionMode).toBe("plan");
          expect(yield* workflows.stored(`factory/v1/result/${TASK_ID}/`)).toEqual([]);
          expect(
            (yield* storedReceipts(workflows)).filter((entry) => entry.receipt.kind === "sealed"),
          ).toEqual([]);
          expect(git(repo.worktree, "rev-parse", "HEAD")).toBe(repo.baseline);
          expect(git(repo.project, "for-each-ref", "refs/t3factory/")).toBe("");
        }),
      ),
    ),
  ));

effectIt.effect.each([
  { choice: "Promote to task", outcome: "promoted" },
  { choice: "Keep as result", outcome: "kept" },
] as const)("three candidates keep, discard and break scope, then $choice", (entry) =>
  Effect.promise(() =>
    withRepo((repo) => {
      const commits = new Map<string, string>();
      return withWorld(experiment(repo, commits), (world) =>
        world.server(
          Effect.fn("factoryExperiment.test.loop")(function* (workflows) {
            yield* seedTarget(workflows, PROJECT, {
              projectId: PROJECT,
              workspace: "worktree",
              workspaceRoot: repo.project,
            });
            const { runId } = yield* startExperiment(workflows);
            yield* ask(world, workflows, runId, "approve-protocol", ["Seal", "Drop"]);
            yield* workflows.answer(runId, "approve-protocol", { choice: "Seal" }, PERSON);
            yield* ask(world, workflows, runId, "promote", PROMOTE_CHOICES);
            yield* workflows.answer(runId, "promote", { choice: entry.choice }, PERSON);
            const done = yield* world.ended(workflows, runId);

            expect(world.turns.map((turn) => turn.origin.step)).toEqual([
              "protocol",
              "baseline",
              "candidate/1",
              "candidate/2",
              "candidate/3",
            ]);
            const [protocolTurn, baselineTurn, ...candidateTurns] = world.turns;
            expect(protocolTurn?.launch?.interactionMode).toBe("plan");
            expect(baselineTurn?.project).toBe(PROJECT);
            expect(baselineTurn?.launch?.workspace?.type).toBe("worktree");
            const baselineThread = baselineTurn?.thread ?? `thread-${baselineTurn?.key ?? ""}`;
            for (const turn of candidateTurns) expect(turn.thread).toBe(baselineThread);
            const lastBrief = candidateTurns.at(-1)?.prompt ?? "";
            for (const text of [PROTOCOL.hypothesis, "model.txt", IDEAS[0], IDEAS[1], "discard"]) {
              expect(lastBrief).toContain(text);
            }

            expect(commits.size).toBe(3);
            const [first = "", second = "", third = ""] = [...CANDIDATES.keys()].map((step) =>
              commits.get(step),
            );
            const resultRows = yield* workflows.stored(`factory/v1/result/${TASK_ID}/`);
            expect(resultRows.map((row) => row.key)).toEqual(
              [0, 1, 2, 3].map(
                (iter) => `factory/v1/result/${TASK_ID}/0001/${String(iter).padStart(4, "0")}`,
              ),
            );
            const rows = yield* Effect.forEach(resultRows, (row) =>
              decodeRow(row.value).pipe(Effect.orDie),
            );
            expect(
              rows.map(({ iter, node, parent, commit, status }) => ({
                iter,
                node,
                parent,
                commit,
                status,
              })),
            ).toEqual([
              { iter: 0, node: "e0", parent: null, commit: repo.baseline, status: "baseline" },
              { iter: 1, node: "e1", parent: "e0", commit: first, status: "keep" },
              { iter: 2, node: "e2", parent: "e1", commit: second, status: "discard" },
              { iter: 3, node: "e3", parent: "e1", commit: third, status: "invalid" },
            ]);
            for (const row of rows) {
              expect(row).toMatchObject({
                v: 1,
                taskId: TASK_ID,
                attempt: 1,
                evaluatorSha256: EVALUATOR_SHA,
              });
            }
            expect(rows.slice(0, 3).map((row) => row.metric)).toEqual([1, 0.7, 0.8]);
            expect(rows[0]?.delta).toBeNull();
            expect(Math.abs(rows[1]?.delta ?? 0)).toBeCloseTo(0.3);
            expect(rows.slice(1).map((row) => row.idea)).toEqual(IDEAS);
            for (const row of rows.slice(0, 3)) {
              expect(row.logSha256).toMatch(SHA256);
              expect(row.logTail).toContain('"metric"');
            }

            expect(git(repo.worktree, "rev-parse", "HEAD")).toBe(first);
            expect(git(repo.worktree, "status", "--porcelain")).toBe("");
            expect(NodeFS.readFileSync(NodePath.join(repo.worktree, "model.txt"), "utf8")).toBe(
              "0.7\n",
            );
            expect(NodeFS.existsSync(NodePath.join(repo.worktree, "outside.txt"))).toBe(false);
            expect(git(repo.project, "rev-parse", "main")).toBe(repo.baseline);
            const refs = git(
              repo.project,
              "for-each-ref",
              "--format=%(refname) %(objectname)",
              "refs/t3factory/exp/",
            )
              .split("\n")
              .map((line) => {
                const [name = "", object = ""] = line.split(" ");
                const segments = name.split("/");
                return {
                  prefix: segments.slice(0, 4).join("/"),
                  attempt: Number(segments[4]),
                  iter: Number(segments[5]),
                  object,
                };
              });
            const prefix = `refs/t3factory/exp/${TASK_ID}`;
            expect(refs).toEqual([
              { prefix, attempt: 1, iter: 1, object: first },
              { prefix, attempt: 1, iter: 2, object: second },
              { prefix, attempt: 1, iter: 3, object: third },
            ]);
            for (const dropped of [second, third]) {
              expect(git(repo.project, "cat-file", "-t", dropped)).toBe("commit");
              expect(
                NodeChildProcess.spawnSync(
                  "git",
                  ["merge-base", "--is-ancestor", dropped, "HEAD"],
                  { cwd: repo.worktree },
                ).status,
              ).toBe(1);
            }

            const artifacts = yield* storedArtifacts(workflows);
            const ofKind = (kind: FactoryArtifact["kind"]) =>
              artifacts.filter((stored) => stored.artifact.kind === kind);
            const [protocol] = ofKind("protocol");
            expect(ofKind("protocol")).toHaveLength(1);
            const protocolText = inlineText(protocol?.artifact);
            expect(decodeJsonText(protocolText)).toMatchObject(PROTOCOL);
            expect(protocol?.artifact.sha256).toBe(sha256(protocolText));
            expect(ofKind("evaluator").map((stored) => stored.artifact.sha256)).toEqual([
              EVALUATOR_SHA,
            ]);
            const resultsArtifacts = ofKind("results");
            expect(resultsArtifacts).toHaveLength(1);
            const [results] = resultsArtifacts;
            const resultsText = inlineText(results?.artifact);
            const resultsSha = sha256(resultsText);
            expect(results).toMatchObject({
              key: `factory/v1/artifact/${TASK_ID}/0001/${resultsSha}`,
              artifact: { taskId: TASK_ID, attempt: 1, sha256: resultsSha, runId },
            });
            const [header, ...lines] = resultsText.trimEnd().split("\n");
            expect(header).toBe(RESULTS_HEADER.join("\t"));
            const cells = lines.map((line) => line.split("\t"));
            expect(cells.map((cell) => [cell[0], cell[1], cell[3], cell[4], cell[7]])).toEqual(
              rows.map((row) => [
                String(row.iter),
                row.node,
                row.commit,
                row.status,
                EVALUATOR_SHA,
              ]),
            );
            expect(cells.slice(1).map((cell) => [cell[2], cell[8]])).toEqual([
              ["e0", IDEAS[0]],
              ["e1", IDEAS[1]],
              ["e1", IDEAS[2]],
            ]);

            const receipts = yield* storedReceipts(workflows);
            const sealed = receipts.filter((stored) => stored.receipt.kind === "sealed");
            expect(sealed).toHaveLength(1);
            const [seal] = sealed;
            expect(seal?.receipt).toMatchObject({ taskId: TASK_ID, attempt: 1, runId });
            expect(seal?.key).toBe(
              `factory/v1/receipt/${TASK_ID}/0001/sealed-${seal?.receipt.sha256.slice(0, 16) ?? ""}`,
            );
            const promoted = receipts.filter((stored) => stored.receipt.kind === "promoted");
            const otherTasks = (yield* workflows.stored("factory/v1/task/")).filter(
              (row) => row.key !== `factory/v1/task/${TASK_ID}`,
            );
            if (entry.outcome === "promoted") {
              expect(otherTasks).toHaveLength(1);
              const task = yield* decodeTask(otherTasks[0]?.value).pipe(Effect.orDie);
              expect(task).toMatchObject({
                lane: "backlog",
                source: { _tag: "promoted", fromTaskId: TASK_ID, artifactSha256: resultsSha },
              });
              expect(promoted).toHaveLength(1);
              // AMBIGUOUS: the receipt names the results it promoted and the task it created.
              expect(promoted[0]?.receipt).toMatchObject({
                taskId: TASK_ID,
                attempt: 1,
                sha256: resultsSha,
                by: "person",
                detail: { taskId: task.id },
              });
              expect(promoted[0]?.key).toBe(
                `factory/v1/receipt/${TASK_ID}/0001/promoted-${resultsSha.slice(0, 16)}`,
              );
              expect(done).toMatchObject({
                status: "completed",
                result: { outcome: "promoted", bestMetric: 0.7 },
              });
            } else {
              expect(otherTasks).toEqual([]);
              expect(promoted).toEqual([]);
              expect(done).toMatchObject({ status: "completed", result: { outcome: "kept" } });
            }
            expect(
              (yield* workflows.list()).filter(
                (run) =>
                  run.runId !== runId &&
                  ["factory-task", "factory-brief", "factory-experiment"].includes(run.workflow),
              ),
            ).toEqual([]);
          }),
        ),
      );
    }),
  ),
);
