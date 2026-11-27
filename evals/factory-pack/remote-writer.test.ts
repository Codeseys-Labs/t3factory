// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import type { AgentResult } from "../../apps/server/src/workflows/WorkflowAgents.ts";
import * as WorkflowForge from "../../apps/server/src/workflows/WorkflowForge.ts";
import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import * as Placement from "../../factory/workflows/lib/placement.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Service = Workflows.Workflows["Service"];
type Script = Parameters<typeof withWorld>[0];
type PullRequestDetail = Parameters<NonNullable<Script["readPullRequest"]>>[1];
const TASK_ID = "b0000000-0000-4000-8000-000000000021";
const OTHER_TASK = "b0000000-0000-4000-8000-000000000022";
const PROJECT = "project-1";
const E = "env-writer";
const RP = "writer-project";
const POOL = `factory-env:${E}`;
const WRITE_ON = { environment: E, project: RP, limit: 2 };
const MODEL = { instanceId: "codex", model: "task-model" };
const WORKER = { instanceId: "claude", model: "writer-model" };
const PERSON = { label: "Person", sessionId: "person-session" };
const AT = "2026-01-01T00:00:00.000Z";
const PART = { title: "Guard the parser", brief: "Reject empty input." };
const SECOND = { title: "Document the parser", brief: "Document the input rules." };
const REPOSITORY = "factory/pack";
const URL = `https://github.com/${REPOSITORY}/pull/41`;
const H = "1".repeat(40);
const H2 = "2".repeat(40);
const H3 = "3".repeat(40);
// W3 uses a one-based part number on the branch, not the zero-based ledger index.
const branchFor = (taskId: string, attempt: number, part: number) =>
  `factory-task/${taskId}/a${attempt}-p${part + 1}`;
const B = branchFor(TASK_ID, 1, 0);
const B2 = `${B}-again`;
const FOLLOW_UPS =
  "If you discover an out-of-scope bug or follow-up while working, do not widen this pull request: list it at the end of your `summary`.";
const WRITER_RETURN =
  "Return `prUrl`: the pull request's URL, or null if you could not push or open it, saying why in `summary`; `branch`: the output of `git rev-parse --abbrev-ref HEAD`; `baseSha`: what `git rev-parse HEAD` printed before your first change; `headSha`: the output of `git rev-parse HEAD` after your last push, or null; and a short `summary` of what you changed. Return no `artifacts`: the machine that runs this task cannot read files here.";
const FIX_PUSH =
  "Push the branch this worktree is on, under its own name, with `git push origin HEAD`; never force-push or switch branches. Return `branch`: the output of `git rev-parse --abbrev-ref HEAD`; `headSha`: the output of `git rev-parse HEAD` after your last push, or null if you pushed nothing; and a short `summary` of what you changed.";
const writerLine = (base: string, target = "main") =>
  `You are on another machine than the one this task is run from, in a worktree made for this part from \`origin/${target}\`, which should be at commit \`${base}\`. Before you change anything, run \`git rev-parse HEAD\`; if it does not print \`${base}\`, change nothing and return \`prUrl: null\`. Do not create, switch or rename branches: commit on the branch this worktree is on, push it under its own name with \`git push -u origin HEAD\`, never force-push, and open the pull request from it against \`${target}\`.`;
const continueReturn = (base: string) =>
  WRITER_RETURN.replace(
    "what `git rev-parse HEAD` printed before your first change",
    `the output of \`git merge-base HEAD ${base}\``,
  );
const priorLine = (url: string) =>
  `An earlier attempt at this task left this pull request open: ${url}. Do not push to its branch; this attempt opens its own pull request.`;
const branchNotGiven = (step: string, seen: string, given: string) =>
  `At step ${step} the work is on the branch ${seen}, not ${given}, the branch made for this part's worker, so it may be another worker's. Nothing was merged.`;
const baseDiffers = (step: string, seen: string, base: string) =>
  `Step ${step} reported its work starts from ${seen}, not ${base}, the commit this server read for the base branch. Nothing was merged.`;
const unreportedHead = (step: string) =>
  `Step ${step} did not report the full commit it pushed, so its pushes cannot be told apart from anyone else's. Nothing was merged.`;
const headUnusable = (step: string) =>
  `At step ${step} the host did not report the pull request's full head commit, so pushes to it cannot be told apart. Nothing was merged.`;
const headMoved = (step: string, seen: string, expected = H) =>
  `At step ${step} the pull request's head is ${seen}, but the last commit this part's worker reported is ${expected}: something else pushed to its branch. Nothing was merged. Check the pull request's commits before starting the task again.`;
const wrongRepository = (seen: string, repository = REPOSITORY) =>
  `The pull request the worker returned is from the repository ${seen}, not ${repository}. Nothing was merged.`;
const wrongBase = (seen: string, target = "main") =>
  `The pull request the worker returned targets ${seen}, not ${target}. Nothing was merged.`;
const noPullRequest =
  "The worker on another machine returned no pull request, so nothing was reviewed, accepted or merged. Its summary, in the step's result, says why.";
const needsGitHub =
  "writeOn needs a pull request on GitHub: on other hosts this server cannot read the pull request's head fresh before it merges. Nothing was merged.";
const fixContradicts = (step: string, reported: string, seen: string) =>
  `Step ${step} reported pushing ${reported}, but the pull request's head is still ${seen}. Nothing was merged.`;
const ranElsewhere = (step: string) =>
  `Step ${step} came back without the machine writeOn names, so it ran somewhere else, perhaps on this server if writeOn names it. Nothing was merged.`;
const headCheck = (head: string) =>
  `Factory is checking this pull request's head against ${head}, the last commit its worker reported.`;
const mergeMark = (head: string) =>
  `Factory is merging this pull request at ${head}, the commit its review covered.`;
const mergedUnreviewed = (seen: string, expected = H, url = URL) =>
  `${url} was merged at ${seen}, but the last commit reviewed was ${expected}: commits nobody reviewed were merged. Check them now.`;
const mergeUnconfirmed = (state: string, expected = H, url = URL) =>
  `The host accepted the merge of ${url} at ${expected}, but the merge had not completed when Factory last read it: the pull request was ${state}. Nothing here says it merged, and anything pushed before the host merges it is unreviewed. Check it.`;
const needsTarget =
  "writeOn is set for this project, but the server has no usable record of where its tasks work. Start the task from the Work page, which writes that record, or remove writeOn from the project's Factory config.";
const needsWorktree =
  "writeOn is set for this project, but its tasks work in a plain folder, which another machine does not have. Remove writeOn from the project's Factory config, then start the task again.";
const needsBase =
  "writeOn is set for this project, but baseRef is not: a worker on another machine needs the branch its pull request targets. Set baseRef in the project's Factory config.";
const needsModel =
  "writeOn is set for this project, but no model is named for its workers: set workerModel in the project's Factory config, or give the task a model.";
const baseUnread = (target: string) =>
  `This server could not read the branch ${target} from the project's origin, so a worker on another machine has no base commit to start from. Nothing was started.`;
const placementsDiffer = (key: string) =>
  `The Factory config at ${key} is not valid: readOnlyOn and writeOn name the same environment, so they must name the same project and limit.`;
const globalWrite =
  "The Factory config at factory/v1/config is not valid: writeOn names one project on another machine, so it belongs in factory/v1/config/<projectId>.";
const globalRead =
  "The Factory config at factory/v1/config is not valid: readOnlyOn names one project on another machine, so it belongs in factory/v1/config/<projectId>.";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
type Repo = { readonly folder: string; readonly X: string };
const withOrigin = async (use: (repo: Repo) => Promise<void>, baseBranch = "main") => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-writer-"));
  try {
    const folder = NodeFS.realpathSync.native(dir);
    const origin = NodePath.join(folder, "origin.git");
    git(folder, "init", "--bare", origin);
    git(folder, "init", "-b", baseBranch, "project");
    const project = NodePath.join(folder, "project");
    git(
      project,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Base",
    );
    git(project, "remote", "add", "origin", origin);
    git(project, "push", "origin", baseBranch);
    await use({ folder: project, X: git(project, "rev-parse", "HEAD") });
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
};

const decodePr = Schema.decodeSync(WorkflowForge.PullRequest);
const decodeStarted = Schema.decodeUnknownSync(
  Schema.Struct({ runId: Schema.String, attempt: Schema.Number }),
);
const turnBranch = (turn: AgentTurnInput) =>
  turn.launch?.workspace?.type === "worktree" ? turn.launch.workspace.branch : undefined;
// The engine keys launches by run, step and round (W F10).
const firstRound = (turn: AgentTurnInput) =>
  turn.key === `${turn.origin.runId}/${turn.origin.step}/0`;
const writerStep = /^(?:do(?:\/again|\/continue)?$|fix\/)/;
const isWriter = (turn: AgentTurnInput) => writerStep.test(turn.origin.step);
const only = (turns: ReadonlyArray<AgentTurnInput>, step: string, runId?: string) => {
  const matches = turns.filter(
    (t) => t.origin.step === step && (runId === undefined || t.origin.runId === runId),
  );
  expect(matches, step).toHaveLength(1);
  const [turn] = matches;
  if (!turn) throw new Error(`No ${step} turn`);
  return turn;
};
const threadOf = (turn: AgentTurnInput) => `thread-${turn.key}`;
const row = <S extends { readonly name: string }>(steps: ReadonlyArray<S>, name: string) => {
  const step = steps.find((s) => s.name === name);
  if (!step) throw new Error(`Missing step ${name}`);
  return step;
};
const named = (steps: ReadonlyArray<{ readonly name: string }>) => steps.map((s) => s.name);
const launchFor = (branch: string) => ({
  workspace: { type: "worktree", baseRef: "origin/main", branch, startFromOrigin: true },
  runtimeMode: "full-access",
  interactionMode: "default",
});
const exactLine = (turn: AgentTurnInput, text: string) =>
  expect(turn.prompt.split("\n").filter((line) => line === text)).toEqual([text]);
const stopped = (reason: string) => ({ status: "stopped", detail: reason, result: null });
const merged = (url = URL) => ({ status: "completed", result: { outcome: "merged", prUrl: url } });
const refusedBranch = (branch: string) =>
  `Environment ${E} refused t3_thread_launch: Branch "${branch}" already exists in project "${RP}". No thread was created.`;
const loseFirstDo = (turn: AgentTurnInput, read: number) =>
  turn.origin.step === "do" && firstRound(turn) && read === 0
    ? "Lost the first writer result."
    : undefined;
const major = {
  severity: "major",
  category: "correctness",
  path: "src/part.ts",
  line: 3,
  claim: "Empty input still throws.",
  evidence: "",
};
const review = (head: string | null, block = false) => ({
  output: { reviewedHead: head, findings: block ? [major] : [] },
});

type Done = {
  summary: string;
  prUrl: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
};
type Pr = { url: string; branch: string; head: string; runId: string };
type HostRead = { detail: PullRequestDetail; pr: Pr; count: number; world: World };
type Scenario = {
  readonly parts?: ReadonlyArray<typeof PART>;
  readonly done?: (value: Done, turn: AgentTurnInput) => Done;
  readonly respond?: (turn: AgentTurnInput, pr: Pr | undefined) => Partial<AgentResult> | undefined;
  readonly read?: (input: HostRead) => PullRequestDetail;
  readonly needsFix?: boolean;
  readonly starts?: Pick<
    Script,
    "holdAgent" | "startError" | "resultError" | "interrupt" | "startedIn"
  >;
};

const scenario = <A, Err>(
  X: string,
  options: Scenario,
  check: (world: World, workflows: Service) => Effect.Effect<A, Err>,
) => {
  const prs = new Map<string, Pr>();
  const counts = new Map<string, number>();
  let observedWorld: World;
  return withWorld(
    {
      ...options.starts,
      standing: (address) => ({
        url:
          "url" in address
            ? address.url
            : `https://${address.host}/${address.repository}/pull/${address.number}`,
        checks: "passing",
        state: "open",
        mergeability: "mergeable",
      }),
      listPullRequests: (query) =>
        Effect.succeed(
          [...prs.values()].map((pr) =>
            decodePr({
              provider: "github",
              host: "github.com",
              repository: REPOSITORY,
              projectId: query.project,
              projectTitle: "Factory",
              number: Number(pr.url.split("/").at(-1)),
              title: PART.title,
              url: pr.url,
              author: null,
              headBranch: pr.branch,
              baseBranch: "main",
              state: "open",
              isDraft: false,
              mergeability: "mergeable",
              additions: 1,
              deletions: 0,
              createdAt: AT,
              updatedAt: AT,
              viewerReviewRequested: false,
              labels: [],
            }),
          ),
        ),
      readPullRequest: (_address, detail) => {
        const pr = [...prs.values()].find((candidate) => candidate.url === detail.url);
        if (!pr) throw new Error(`Unexpected host read of ${detail.url}`);
        const count = counts.get(pr.url) ?? 0;
        counts.set(pr.url, count + 1);
        const state = observedWorld.acts.some(
          ([address]) => "url" in address && address.url === pr.url,
        )
          ? "merged"
          : "open";
        const snapshot: PullRequestDetail = {
          ...detail,
          state,
          headBranch: pr.branch,
          headRepositoryNameWithOwner: REPOSITORY,
          headSha: pr.head,
        };
        return Effect.succeed(
          options.read?.({ detail: snapshot, pr, count, world: observedWorld }) ?? snapshot,
        );
      },
      agent: (turn) => {
        const { step, runId } = turn.origin;
        const existing = prs.get(runId);
        const answer = options.respond?.(turn, existing);
        if (answer !== undefined) return answer;
        if (step === "plan")
          return { output: { summary: "One change per part.", parts: options.parts ?? [PART] } };
        if (step === "do" || step === "do/continue" || step === "do/again") {
          const pr = {
            url: `https://github.com/${REPOSITORY}/pull/${41 + prs.size}`,
            branch: turnBranch(turn) ?? B,
            head: H,
            runId,
          };
          prs.set(runId, pr);
          const done = {
            summary: "Guarded the parser.",
            prUrl: pr.url,
            branch: pr.branch,
            baseSha: X,
            headSha: H,
          };
          return { output: options.done?.(done, turn) ?? done };
        }
        if (!existing) throw new Error(`No pull request for ${step}`);
        if (step.startsWith("scope/"))
          return { output: { report: { headSha: existing.head, files: ["src/part.ts"] } } };
        if (step.startsWith("review/"))
          return review(existing.head, options.needsFix && step === "review/0");
        if (step.startsWith("disprove/")) return { output: { results: [] } };
        if (step.startsWith("fix/")) {
          existing.head = H2;
          return {
            output: { summary: "Fixed empty input.", branch: existing.branch, headSha: H2 },
          };
        }
        throw new Error(`Unexpected agent step ${step}`);
      },
    },
    (world) => {
      observedWorld = world;
      return world.server((workflows) => check(world, workflows));
    },
  );
};

type Seed = {
  readonly taskId?: string;
  readonly project?: string;
  readonly model?: typeof MODEL | null;
  readonly workspace?: "worktree" | "root" | "scratch" | "missing";
  readonly folder?: string | null;
  readonly settings?: Schema.JsonObject;
  readonly global?: Schema.JsonObject;
  readonly issueUrl?: string;
  readonly projectRow?: Schema.JsonObject;
};
const configKey = (project = PROJECT) => `factory/v1/config/${project}`;
const targetKey = (project = PROJECT) => `factory/v1/target/${project}`;
const target = (
  project: string,
  workspace: "worktree" | "root" | "scratch",
  folder: string | null,
) => ({ v: 1, projectId: project, workspace, workspaceRoot: folder, checkedAt: AT, problem: null });
const seed = Effect.fn("factoryPack.writer.seed")(function* (
  workflows: Service,
  options: Seed = {},
) {
  const taskId = options.taskId ?? TASK_ID;
  const projectId = options.project ?? PROJECT;
  const model = options.model === undefined ? MODEL : options.model;
  const task = {
    number: taskId === TASK_ID ? 9 : 10,
    title: PART.title,
    description: PART.brief,
    projectId,
    model,
  };
  yield* workflows.storeSet(`factory/v1/task/${taskId}`, {
    v: 1,
    id: taskId,
    ...task,
    rev: 1,
    lane: "ready",
    laneSetAt: AT,
    parentId: null,
    blockedBy: [],
    assignee: null,
    source: { _tag: "local" },
    createdAt: AT,
    updatedAt: AT,
  });
  if (options.global) yield* workflows.storeSet("factory/v1/config", { v: 1, ...options.global });
  yield* workflows.storeSet(
    configKey(projectId),
    options.projectRow ?? {
      v: 1,
      askPlan: false,
      askMerge: false,
      baseRef: "main",
      ...options.settings,
    },
  );
  if (options.workspace !== "missing") {
    yield* workflows.storeSet(
      targetKey(projectId),
      target(
        projectId,
        options.workspace ?? "worktree",
        options.folder === undefined ? "/factory-pack-test" : options.folder,
      ),
    );
  }
  return { ...task, taskId, attempt: 1, issueUrl: options.issueUrl ?? null };
});
const start = Effect.fn("factoryPack.writer.start")(function* (
  workflows: Service,
  options: Seed = {},
) {
  const input = yield* seed(workflows, options);
  return yield* workflows.start("factory-task", input, {
    idempotencyKey: `task/${input.taskId}/a1`,
  });
});
const remote = (folder: string, settings: Schema.JsonObject = {}): Seed => ({
  folder,
  settings: { writeOn: WRITE_ON, ...settings },
});
const settle = (workflows: Service, runId: string) =>
  workflows.waitFor(runId, (run) => run.status === "paused" || run.endedAt !== null);
const ask = Effect.fn("factoryPack.writer.ask")(function* (
  world: World,
  workflows: Service,
  runId: string,
  name: string,
) {
  const question = yield* world.question(workflows, runId);
  expect(question.name).toBe(name);
  return question;
});

it.each([false, true])(
  "WT1 unset writeOn preserves the local writer (remote readers: %s)",
  (remoteReaders) =>
    scenario(
      H,
      {},
      Effect.fn(function* (world, workflows) {
        const { runId } = yield* start(workflows, {
          settings: remoteReaders ? { readOnlyOn: WRITE_ON } : {},
        });
        const part = yield* world.child(workflows, runId, 0);
        expect(yield* world.ended(workflows, part.runId, true)).toMatchObject(merged());
        const worker = only(world.turns, "do");
        expect(worker.environment).toBeUndefined();
        expect(worker.title).toBe(`T-9 part 1: ${PART.title}`);
        expect(worker.launch?.workspace).toEqual({ type: "worktree", baseRef: "main" });
        expect(worker.prompt).toContain("t3 workflow start factory-capture");
        for (const id of [runId, part.runId]) {
          const { steps } = yield* workflows.get(id);
          expect(named(steps)).not.toContain("write-placement");
          expect(named(steps)).not.toContain("writer-base");
          if (id === runId) expect(row(steps, "config").result).not.toHaveProperty("writeOn");
        }
      }),
    ),
);

it("WT2 writer-base bounds the noninteractive Git read and aborts it on interruption", () =>
  scenario(
    H,
    {},
    Effect.fn(function* () {
      const { readOriginHead } = yield* Effect.promise(
        () => import("../../factory/workflows/lib/records.ts"),
      );
      const started = Promise.withResolvers<NodeChildProcess.ExecFileOptionsWithStringEncoding>();
      const read = yield* Effect.forkChild(
        readOriginHead("/project", "main", (_command, _args, options) => {
          const pending = Promise.withResolvers<never>();
          options.signal?.addEventListener(
            "abort",
            () => pending.reject(new Error("Git interrupted")),
            { once: true },
          );
          started.resolve(options);
          return pending.promise;
        }),
      );
      const options = yield* Effect.promise(() => started.promise);
      expect(options.timeout).toBe(30_000);
      expect(options.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" });
      expect(options.signal?.aborted).toBe(false);
      yield* Fiber.interrupt(read);
      expect(options.signal?.aborted).toBe(true);
    }),
  ));

it("WT2 the coordinator pins origin/main and starts only the writer on E with the exact launch", () =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      {
        read: ({ detail }) => ({ ...detail, headRepositoryNameWithOwner: "FACTORY/PACK" }),
      },
      Effect.fn(function* (world, workflows) {
        const issueUrl = `https://github.com/${REPOSITORY}/issues/191`;
        const { runId } = yield* start(workflows, {
          ...remote(folder, { workerModel: WORKER, askMerge: true }),
          issueUrl,
        });
        const child = yield* world.child(workflows, runId, 0);
        yield* ask(world, workflows, child.runId, "approve-merge");
        const worker = only(world.turns, "do");
        expect(worker).toMatchObject({
          environment: E,
          project: RP,
          model: WORKER,
          launch: launchFor(B),
        });
        expect(worker.launch).toStrictEqual(launchFor(B));
        expect(worker.issue).toBeUndefined();
        expect(worker.thread).toBeUndefined();
        expect(worker.title).toBe(`T-9 part 1: ${PART.title}`);
        const string = { type: "string" };
        const nullableString = { anyOf: [string, { type: "null" }] };
        expect(worker.outputSchema).toMatchObject({
          properties: {
            summary: string,
            prUrl: nullableString,
            branch: nullableString,
            baseSha: nullableString,
            headSha: nullableString,
          },
          required: ["summary", "prUrl", "branch", "baseSha", "headSha"],
          additionalProperties: false,
        });
        expect(Object.keys(worker.outputSchema?.properties ?? {})).toHaveLength(5);
        for (const line of [writerLine(X), WRITER_RETURN, FOLLOW_UPS]) exactLine(worker, line);
        expect(worker.prompt.split("\n").filter((line) => line.includes(issueUrl))).toHaveLength(1);
        expect(worker.prompt).not.toContain(B);
        expect(worker.prompt).not.toContain("t3 workflow start");
        // The sole artifacts reference is W12's prohibition, not the old artifacts rule.
        expect(worker.prompt.match(/artifacts/g)).toEqual(["artifacts"]);
        for (const step of ["plan", "scope/0", "review/0"]) {
          const turn = only(world.turns, step);
          expect(turn.environment).toBeUndefined();
          expect(turn.project).toBe(PROJECT);
        }
        const partSteps = (yield* workflows.get(child.runId)).steps;
        expect(row(partSteps, "writer-base").result).toBe(X);
        expect(row(partSteps, "writer-pr").result).toStrictEqual({
          provider: "github",
          repository: REPOSITORY,
          headRepository: "FACTORY/PACK",
          headBranch: B,
          baseBranch: "main",
          headSha: H,
        });
        expect(named(partSteps).indexOf("write-placement")).toBeLessThan(
          named(partSteps).indexOf("writer-base"),
        );
        const queue = named(partSteps);
        expect(queue.indexOf(`@pool:factory-task:${TASK_ID}`)).toBeGreaterThanOrEqual(0);
        expect(queue.indexOf(`@pool:${POOL}`)).toBeGreaterThan(
          queue.indexOf(`@pool:factory-task:${TASK_ID}`),
        );
        expect(queue.some((name) => name.startsWith("@pool:factory-root:"))).toBe(false);
        const parentSteps = named((yield* workflows.get(runId)).steps);
        expect(parentSteps.indexOf("write-placement")).toBeGreaterThanOrEqual(0);
        expect(parentSteps.indexOf("plan")).toBeGreaterThan(parentSteps.indexOf("write-placement"));
        expect(
          world.readCalls.every(
            (address) => ("project" in address ? address.project : address.projectId) === PROJECT,
          ),
        ).toBe(true);
        yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" }, PERSON);
        expect(yield* world.ended(workflows, child.runId)).toMatchObject(merged());
      }),
    ),
  ));

it("WT3 a second part uses p2, and the next attempt uses a2 and opens its own pull requests", () =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      { parts: [PART, SECOND] },
      Effect.fn(function* (world, workflows) {
        yield* seed(workflows, remote(folder, { askMerge: true }));
        const launch = Effect.fn(function* (attempt: number) {
          const started = yield* workflows.start(
            "factory-start",
            { taskId: TASK_ID },
            { idempotencyKey: `start/${attempt}` },
          );
          const result = decodeStarted((yield* world.ended(workflows, started.runId)).result);
          expect(result.attempt).toBe(attempt);
          return result.runId;
        });
        const firstRun = yield* launch(1);
        for (const part of [0, 1]) {
          const child = yield* world.child(workflows, firstRun, part);
          yield* ask(world, workflows, child.runId, "approve-merge");
          expect(turnBranch(only(world.turns, "do", child.runId))).toBe(
            branchFor(TASK_ID, 1, part),
          );
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Hold" }, PERSON);
        }
        yield* world.ended(workflows, firstRun);
        const secondRun = yield* launch(2);
        for (const part of [0, 1]) {
          const child = yield* world.child(workflows, secondRun, part);
          yield* ask(world, workflows, child.runId, "approve-merge");
          const worker = only(world.turns, "do", child.runId);
          expect(turnBranch(worker)).toBe(branchFor(TASK_ID, 2, part));
          // Either first-attempt part may get pull/41; the contract doesn't order simultaneous parts.
          const urls = [URL, URL.replace(/41$/, "42")];
          const plural = (ordered: string[]) =>
            `An earlier attempt at this task left these pull requests open: ${ordered.join(", ")}. Do not push to their branches; this attempt opens its own pull request.`;
          expect(
            worker.prompt.split("\n").filter((line) => line.startsWith("An earlier attempt")),
          ).toEqual([
            expect.stringMatching(
              /^An earlier attempt at this task left these pull requests open:/,
            ),
          ]);
          expect(
            [plural(urls), plural(urls.toReversed())].some((line) =>
              worker.prompt.split("\n").includes(line),
            ),
          ).toBe(true);
          expect(
            worker.prompt
              .split("\n")
              .some((line) => line.startsWith("If one of them is for this part")),
          ).toBe(false);
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Hold" }, PERSON);
        }
        yield* world.ended(workflows, secondRun);
      }),
    ),
  ));

it("WT4 an ordinary clone rejects a replacement on B; the sole do/again turn on B2 is reviewed", () =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      {
        starts: {
          resultError: loseFirstDo,
          interrupt: () => "stopped",
          startError: (turn) =>
            turn.origin.step === "do" && !firstRound(turn) && turnBranch(turn) === B
              ? refusedBranch(B)
              : undefined,
        },
      },
      Effect.fn(function* (world, workflows) {
        const { runId } = yield* start(workflows, remote(folder));
        const child = yield* world.child(workflows, runId, 0);
        expect(yield* world.ended(workflows, child.runId, true)).toMatchObject(merged());
        expect(
          world.startAttempts
            .filter(isWriter)
            .map((turn) => [turn.origin.step, turn.environment, turnBranch(turn)]),
        ).toEqual([
          ["do", E, B],
          ["do", E, B],
          ["do/again", E, B2],
        ]);
        const first = only(world.turns, "do");
        expect(world.interrupts).toEqual([
          { threadId: threadOf(first), environment: E, turnId: first.key },
        ]);
        const again = only(world.turns, "do/again");
        expect(again.launch).toStrictEqual(launchFor(B2));
        const { steps } = yield* workflows.get(child.runId);
        expect(row(steps, "writer-pr").result).toMatchObject({ headBranch: B2, headSha: H });
        expect(only(world.turns, "review/0").prompt).toContain(URL);
        expect(world.turns.filter(isWriter).map((turn) => turn.environment)).toEqual([E, E]);
      }),
    ),
  ));

it.each([false, true])(
  "WT5 B may survive a lost launch; do/again uses B2 (B2 already exists: %s)",
  (taken) =>
    withOrigin(({ folder, X }) => {
      const branches = new Set(taken ? [B2] : []);
      return scenario(
        X,
        {
          starts: {
            startError: (turn) => {
              const branch = turnBranch(turn);
              if (branch === undefined) return undefined;
              if (branches.has(branch)) return refusedBranch(branch);
              branches.add(branch);
              return turn.origin.step === "do"
                ? `Environment ${E} lost its launch reply.`
                : undefined;
            },
          },
        },
        Effect.fn(function* (world, workflows) {
          const { runId } = yield* start(workflows, remote(folder));
          const child = yield* world.child(workflows, runId, 0);
          const result = yield* settle(workflows, child.runId);
          expect(
            world.startAttempts
              .filter(isWriter)
              .map((turn) => [turn.origin.step, turn.environment, turnBranch(turn)]),
          ).toEqual([
            ["do", E, B],
            ["do/again", E, B2],
          ]);
          expect(branches.has(B)).toBe(true);
          if (taken) {
            expect(result.status).toBe("paused");
            expect(result.detail).toContain("do/again:");
            expect(result.detail).toContain(refusedBranch(B2));
            expect(result.resumesAt).not.toBeNull();
            expect(world.turns.filter(isWriter)).toEqual([]);
          } else {
            expect(result).toMatchObject(merged());
            expect(only(world.turns, "do/again").environment).toBe(E);
          }
        }),
      );
    }),
);

it.each(["continue", "again"] as const)(
  "WT6 and WT17 do/%s and fix/0 keep the acknowledged thread and machine",
  (path) =>
    withOrigin(({ folder, X }) =>
      scenario(
        X,
        {
          needsFix: true,
          starts: {
            startError: (turn) =>
              path === "again" && turn.origin.step === "do" ? "Lost the launch reply." : undefined,
          },
          respond: (turn) =>
            path === "continue" && turn.origin.step === "do"
              ? { ending: "stopped", detail: "it was not done after 2h" }
              : undefined,
        },
        Effect.fn(function* (world, workflows) {
          const { runId } = yield* start(workflows, remote(folder));
          const child = yield* world.child(workflows, runId, 0);
          expect(yield* world.ended(workflows, child.runId, true)).toMatchObject(merged());
          const continuation = only(world.turns, `do/${path}`);
          const owner = path === "continue" ? only(world.turns, "do") : continuation;
          const thread = threadOf(owner);
          const fix = only(world.turns, "fix/0");
          if (path === "continue") {
            expect(continuation).toMatchObject({ thread, environment: E });
            expect(continuation.project).toBeUndefined();
            expect(continuation.launch).toBeUndefined();
            expect(continuation.model).toBeUndefined();
            expect(continuation.issue).toBeUndefined();
            exactLine(continuation, continueReturn(X));
            exactLine(
              continuation,
              `Stay on this worktree's branch and keep any commits from your last turn. Before you resume, run \`git merge-base HEAD ${X}\`; if it does not print \`${X}\`, change nothing and return \`prUrl: null\`. Do not create, switch or rename branches. Push this branch under its own name with \`git push -u origin HEAD\`, never force-push, and use or open its pull request against \`main\`.`,
            );
            expect(continuation.prompt).not.toContain(
              "run `git rev-parse HEAD`; if it does not print",
            );
            exactLine(continuation, FOLLOW_UPS);
            expect(continuation.prompt).not.toContain(WRITER_RETURN);
            expect(continuation.outputSchema).toEqual(owner.outputSchema);
          }
          expect(fix).toMatchObject({ thread, environment: E });
          expect(fix.project).toBeUndefined();
          expect(fix.launch).toBeUndefined();
          expect(fix.model).toBeUndefined();
          expect(fix.issue).toBeUndefined();
          const string = { type: "string" };
          const nullableString = { anyOf: [string, { type: "null" }] };
          expect(fix.outputSchema).toMatchObject({
            properties: { summary: string, branch: nullableString, headSha: nullableString },
            required: ["summary", "branch", "headSha"],
            additionalProperties: false,
          });
          expect(Object.keys(fix.outputSchema?.properties ?? {})).toHaveLength(3);
          exactLine(fix, FOLLOW_UPS);
          expect(fix.prompt.trimEnd().split("\n").at(-1)).toBe(FIX_PUSH);
          const { steps } = yield* workflows.get(child.runId);
          for (const step of [owner.origin.step, `do/${path}`, "fix/0"]) {
            expect(row(steps, step)).toMatchObject({ threadId: thread, environmentId: E });
          }
          expect(row(steps, "writer-base").result).toBe(X);
          for (const id of [runId, child.runId]) {
            expect(row((yield* workflows.get(id)).steps, "write-placement").result).toStrictEqual({
              where: "remote",
              ...WRITE_ON,
              pool: POOL,
              folder,
            });
          }
          // Revision 10's key families; W adds steps, not a new row namespace.
          for (const { key } of yield* workflows.stored("factory/v1/")) {
            expect(key).toMatch(
              /^factory\/v1\/(?:seq$|config$|config\/|task\/|attempt\/|note\/|orchestrator\/|intake\/|intake-seen\/|captured\/|ledger\/|outcome\/|metrics\/|target\/|artifact\/|receipt\/)/,
            );
          }
        }),
      ),
    ),
);

const withoutHead = ({ headSha: _headSha, ...detail }: PullRequestDetail): PullRequestDetail =>
  detail;

type Rejected = {
  readonly label: string;
  readonly done?: Partial<Done>;
  readonly host?: (detail: PullRequestDetail) => PullRequestDetail;
  readonly reason: (base: string) => string;
};
const rejected: Rejected[] = [
  { label: "no pull request", done: { prUrl: null }, reason: () => noPullRequest },
  { label: "wrong base", done: { baseSha: H3 }, reason: (X) => baseDiffers("do", H3, X) },
  {
    label: "wrong base and no pull request",
    done: { baseSha: H3, prUrl: null },
    reason: (X) => baseDiffers("do", H3, X),
  },
  {
    label: "missing base",
    done: { baseSha: null },
    reason: (X) => baseDiffers("do", "nothing", X),
  },
  {
    label: "writer reported another branch",
    done: { branch: "other" },
    reason: () => branchNotGiven("do", "other", B),
  },
  {
    label: "writer reported a short head",
    done: { headSha: "abc" },
    reason: () => unreportedHead("do"),
  },
  { label: "writer reported no head", done: { headSha: null }, reason: () => unreportedHead("do") },
  {
    label: "GitLab",
    host: (detail): PullRequestDetail => ({
      ...detail,
      provider: SourceControlProviderKind.make("gitlab"),
    }),
    reason: () => needsGitHub,
  },
  {
    label: "missing head repository",
    host: ({ headRepositoryNameWithOwner: _repository, ...detail }) => detail,
    reason: () => wrongRepository("unknown"),
  },
  {
    label: "fork",
    host: (detail) => ({ ...detail, headRepositoryNameWithOwner: "someone/fork" }),
    reason: () => wrongRepository("someone/fork"),
  },
  {
    label: "wrong PR base",
    host: (detail) => ({ ...detail, baseBranch: "release" }),
    reason: () => wrongBase("release"),
  },
  {
    label: "wrong PR branch",
    host: (detail) => ({ ...detail, headBranch: "other" }),
    reason: () => branchNotGiven("writer-pr", "other", B),
  },
  { label: "host reported no head", host: withoutHead, reason: () => headUnusable("writer-pr") },
  {
    label: "host reported a short head",
    host: (detail) => ({ ...detail, headSha: "abc" }),
    reason: () => headUnusable("writer-pr"),
  },
];
it.each(rejected)("WT7 $label stops before any record, check, review, question or act", (test) =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      {
        done: (done) => ({ ...done, ...test.done }),
        read: ({ detail }) => test.host?.(detail) ?? detail,
      },
      Effect.fn(function* (world, workflows) {
        const { runId } = yield* start(workflows, remote(folder, { askMerge: true }));
        const child = yield* world.child(workflows, runId, 0);
        expect(yield* world.ended(workflows, child.runId, true)).toMatchObject(
          stopped(test.reason(X)),
        );
        const names = named((yield* workflows.get(child.runId)).steps);
        expect(
          names.filter((name) => /^(?:pr-record$|artifacts|accept$|checks\/|ledger\/)/.test(name)),
        ).toEqual([]);
        expect(yield* workflows.stored(`factory/v1/ledger/${TASK_ID}/`)).toEqual([]);
        expect(
          world.turns
            .filter((turn) => turn.origin.runId === child.runId)
            .map((turn) => turn.origin.step),
        ).toEqual(["do"]);
        expect(world.acts).toEqual([]);
        expect(world.questions).toEqual([]);
        expect(yield* world.ended(workflows, runId, true)).toMatchObject({
          status: "completed",
          result: { parts: [{ title: PART.title, outcome: "stopped", prUrl: null, stats: null }] },
        });
      }),
    ),
  ),
);

it.each(["head moved", "head restored", "retarget before scope"] as const)(
  "WT8 risk-pr/0 checks the review target and confirms a head mismatch: %s",
  (mode) =>
    withOrigin(({ folder, X }) => {
      const returns = mode === "head restored";
      const freshReads: number[] = [];
      return scenario(
        X,
        {
          read: ({ detail, count, world }) => {
            // W6.1, L4: writer-pr, checks/0, then risk-pr/0 and its confirming read.
            if (mode === "retarget before scope") {
              return count === 2 ? { ...detail, baseBranch: "release" } : detail;
            }
            if (count === 2) return { ...detail, headSha: H2 };
            if (count === 3) {
              freshReads.push(world.prComments.length);
              return { ...detail, headSha: returns ? H : H2 };
            }
            return detail;
          },
        },
        Effect.fn(function* (world, workflows) {
          const { runId } = yield* start(workflows, remote(folder));
          const child = yield* world.child(workflows, runId, 0);
          const result = yield* world.ended(workflows, child.runId, true);
          const names = named((yield* workflows.get(child.runId)).steps);
          if (mode === "retarget before scope") {
            expect(result).toMatchObject(stopped(wrongBase("release")));
            expect(names).toContain("risk-pr/0");
            expect(world.prComments).toEqual([]);
          } else {
            expect(result).toMatchObject(returns ? merged() : stopped(headMoved("risk-pr/0", H2)));
            expect(freshReads).toEqual([1]);
            expect(world.prComments[0]).toEqual({
              pullRequest: { project: PROJECT, url: URL },
              body: headCheck(H),
            });
            expect(names.indexOf("risk-pr/0/fresh")).toBeGreaterThan(names.indexOf("risk-pr/0"));
          }
          if (returns) expect(only(world.turns, "scope/0").environment).toBeUndefined();
          else {
            expect(names).not.toContain("scope/0");
            expect(world.acts).toEqual([]);
          }
        }),
      );
    }),
);

it.each(["remote push", "local push", "remote null lens"] as const)(
  "WT9 %s: only a remote writer's unexpected push stops without another round",
  (mode) =>
    withOrigin(({ folder, X }) =>
      scenario(
        X,
        {
          respond: (turn, pr) => {
            if (turn.origin.step !== "review/0" || !pr) return undefined;
            if (mode === "remote null lens") return review(null);
            pr.head = H2;
            return review(H);
          },
        },
        Effect.fn(function* (world, workflows) {
          const { runId } = yield* start(
            workflows,
            mode === "local push"
              ? {}
              : remote(folder, mode === "remote null lens" ? { readOnlyOn: WRITE_ON } : {}),
          );
          const child = yield* world.child(workflows, runId, 0);
          const result = yield* world.ended(workflows, child.runId, true);
          const steps = (yield* workflows.get(child.runId)).steps;
          if (mode === "remote push") {
            expect(result).toMatchObject(stopped(headMoved("head/0", H2)));
            expect(named(steps)).toContain("head/0/fresh");
            expect(named(steps)).not.toContain("review/0/again");
            expect(world.acts).toEqual([]);
          } else {
            expect(result).toMatchObject(merged());
            expect(only(world.turns, "review/0/again").environment).toBe(
              mode === "local push" ? undefined : E,
            );
            expect(row(steps, "risk-pr/0/again").result).toMatchObject({
              headSha: mode === "local push" ? H2 : H,
            });
          }
        }),
      ),
    ),
);

it.each([
  {
    label: "moved before fix",
    seen: H3,
    reported: H2,
    branch: B,
    reason: headMoved("fix-before/0", H3),
  },
  { label: "worker push confirmed", seen: H2, reported: H2, branch: B, reason: null },
  {
    label: "another push after fix",
    seen: H3,
    reported: H2,
    branch: B,
    reason: headMoved("fix-after/0", H3, H2),
  },
  { label: "unchanged and no push", seen: H, reported: null, branch: B, reason: null },
  {
    label: "unchanged despite reported push",
    seen: H,
    reported: H2,
    branch: B,
    reason: fixContradicts("fix/0", H2, H),
  },
  {
    label: "wrong fix branch",
    seen: H2,
    reported: H2,
    branch: "other",
    reason: branchNotGiven("fix/0", "other", B),
  },
  {
    label: "unusable fix head",
    seen: H2,
    reported: "abc",
    branch: B,
    reason: unreportedHead("fix/0"),
  },
] as const)("WT10 $label determines whether the fix advances the expected head", (test) =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      {
        needsFix: true,
        read: ({ detail, pr, count }) => {
          // writer-pr, checks, risk-pr, head, fix-before (W6.1–W6.4).
          if (test.label === "moved before fix" && count === 4) pr.head = H3;
          return { ...detail, headSha: pr.head };
        },
        respond: (turn, pr) => {
          if (turn.origin.step !== "fix/0" || !pr) return undefined;
          pr.head = test.seen;
          return {
            output: { summary: "Tried a fix.", branch: test.branch, headSha: test.reported },
          };
        },
      },
      Effect.fn(function* (world, workflows) {
        const { runId } = yield* start(workflows, remote(folder, { fixRounds: 1, askMerge: true }));
        const child = yield* world.child(workflows, runId, 0);
        if (test.reason !== null) {
          expect(yield* world.ended(workflows, child.runId, true)).toMatchObject(
            stopped(test.reason),
          );
          const names = named((yield* workflows.get(child.runId)).steps);
          expect(names).not.toContain("risk-pr/1");
          if (test.label === "moved before fix") {
            expect(names).toContain("fix-before/0/fresh");
            expect(names).not.toContain("fix/0");
          } else if (test.label === "wrong fix branch" || test.label === "unusable fix head") {
            expect(names).not.toContain("fix-after/0");
          } else {
            expect(names).toContain("fix-after/0/fresh");
            expect(world.prComments.at(-1)?.body).toBe(headCheck(H2));
          }
          expect(world.acts).toEqual([]);
          return;
        }
        if (test.reported === null) {
          const stuck = yield* ask(world, workflows, child.runId, "stuck");
          expect(stuck.request).toMatchObject({ data: { noOpFixRounds: 1, fixRoundsUsed: 0 } });
          expect(JSON.stringify(stuck.request)).toMatch(/no new commit/i);
          expect(named((yield* workflows.get(child.runId)).steps)).not.toContain("checks/1");
          yield* workflows.answer(child.runId, "stuck", { choice: "Merge anyway" }, PERSON);
        }
        const expected = test.reported ?? H;
        const question = yield* ask(world, workflows, child.runId, "approve-merge");
        expect(question.request).toMatchObject({ data: { headSha: expected } });
        const steps = (yield* workflows.get(child.runId)).steps;
        expect(row(steps, "head-sha").result).toBe(expected);
        if (test.reported !== null)
          expect(row(steps, "risk-pr/1").result).toMatchObject({ headSha: expected });
        yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" }, PERSON);
        expect(yield* world.ended(workflows, child.runId)).toMatchObject(merged());
        expect(world.prComments.map((comment) => comment.body)).toEqual([mergeMark(expected)]);
      }),
    ),
  ),
);

it("WT10 failing checks can be overridden by a person for the exact unreviewed head", () =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      {
        read: ({ detail }) => ({
          ...detail,
          checks: detail.checks.map((check) => ({ ...check, status: "failure" })),
        }),
      },
      Effect.fn(function* (world, workflows) {
        const { runId } = yield* start(workflows, remote(folder, { fixRounds: 0 }));
        const child = yield* world.child(workflows, runId, 0);
        const stuck = yield* ask(world, workflows, child.runId, "stuck");
        expect(stuck.request).toMatchObject({
          data: { problem: expect.stringContaining("checks are failing") },
        });
        yield* workflows.answer(child.runId, "stuck", { choice: "Merge anyway" }, PERSON);
        const approve = yield* ask(world, workflows, child.runId, "approve-merge");
        const target = { data: { prUrl: URL, headSha: H, baseBranch: "main" } };
        expect(approve.request).toMatchObject(target);
        yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" });
        const person = yield* ask(world, workflows, child.runId, "approve-merge/person");
        expect(person.request).toMatchObject(target);
        expect(world.acts).toEqual([]);
        yield* workflows.answer(child.runId, "approve-merge/person", { choice: "Merge" }, PERSON);
        expect(yield* world.ended(workflows, child.runId, true)).toMatchObject({
          status: "completed",
          result: { outcome: "merged", stats: { reviewRounds: 0, mergedAnyway: true } },
        });
        expect(world.acts).toHaveLength(1);
        expect(world.prComments.map((comment) => comment.body)).toEqual([
          `Factory is merging this pull request at ${H}, the commit a person authorized without review.`,
        ]);
      }),
    ),
  ));

it("WT11 a changed head at head-sha stops before asking to merge", () =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      {
        read: ({ detail, pr, count }) => {
          // After writer-pr, checks/0, risk-pr/0 and head/0, the fifth read is head-sha.
          if (count === 4) pr.head = H2;
          return { ...detail, headSha: pr.head };
        },
      },
      Effect.fn(function* (world, workflows) {
        const { runId } = yield* start(workflows, remote(folder, { askMerge: true }));
        const child = yield* world.child(workflows, runId, 0);
        expect(yield* world.ended(workflows, child.runId, true)).toMatchObject(
          stopped(headMoved("head-sha", H2)),
        );
        expect(world.questions).toEqual([]);
        expect(world.acts).toEqual([]);
        expect(world.prComments.map((comment) => comment.body)).toEqual([headCheck(H)]);
      }),
    ),
  ));

it.each([
  { label: "usable unchanged head", head: H, reason: null },
  { label: "absent head", head: undefined, reason: headUnusable("merge") },
  { label: "short head", head: "abc", reason: headUnusable("merge") },
  { label: "push after answer", head: H2, reason: "pull request head changed after review" },
  { label: "retarget after answer", head: H, baseBranch: "release", reason: wrongBase("release") },
])("WT11 merge comments before it reads: $label", ({ head, baseBranch, reason }) =>
  withOrigin(({ folder, X }) => {
    let answered = false;
    const seen: Array<{ comments: string[]; acts: number }> = [];
    return scenario(
      X,
      {
        read: ({ detail, world }) => {
          if (!answered || world.acts.length > 0) return detail;
          seen.push({
            comments: world.prComments.map((comment) => comment.body),
            acts: world.acts.length,
          });
          return head === undefined
            ? withoutHead(detail)
            : { ...detail, headSha: head, baseBranch: baseBranch ?? detail.baseBranch };
        },
      },
      Effect.fn(function* (world, workflows) {
        const { runId } = yield* start(workflows, remote(folder, { askMerge: true }));
        const child = yield* world.child(workflows, runId, 0);
        yield* ask(world, workflows, child.runId, "approve-merge");
        expect(world.prComments).toEqual([]);
        answered = true;
        yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" }, PERSON);
        const result = yield* world.ended(workflows, child.runId);
        expect(seen).toEqual([{ comments: [mergeMark(H)], acts: 0 }]);
        expect(result).toMatchObject(reason === null ? merged() : stopped(reason));
        expect(world.acts).toEqual(
          reason === null
            ? [[{ project: PROJECT, url: URL }, "merge", { mergeMethod: "squash" }]]
            : [],
        );
      }),
    );
  }),
);

it.each([
  "matched",
  "unreviewed",
  "unusable",
  "retarget after act",
  "timeout",
  "wrong wake",
  "merged at checks",
  "matched at checks before review",
  "merged at merge",
] as const)("WT12 merged-head owns the verdict after %s", (mode) =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      {
        read: ({ detail, count, world }) => {
          if (count >= 1 && mode === "merged at checks") {
            return { ...detail, state: "merged", headSha: H2 };
          }
          if (count >= 1 && mode === "matched at checks before review") {
            return { ...detail, state: "merged" };
          }
          if (
            mode === "merged at merge" &&
            world.prComments.some((comment) => comment.body === mergeMark(H))
          ) {
            return { ...detail, state: "merged", headSha: H2 };
          }
          if (world.acts.length === 0) return detail;
          if (mode === "timeout" || mode === "wrong wake") return { ...detail, state: "open" };
          if (mode === "unreviewed") return { ...detail, headSha: H2 };
          if (mode === "unusable") return withoutHead(detail);
          if (mode === "retarget after act") return { ...detail, baseBranch: "release" };
          return detail;
        },
      },
      Effect.fn(function* (world, workflows) {
        const { runId } = yield* start(workflows, remote(folder));
        const child = yield* world.child(workflows, runId, 0);
        const beforeReview =
          mode === "merged at checks" || mode === "matched at checks before review";
        const alreadyMerged = beforeReview || mode === "merged at merge";
        if (mode === "timeout" || mode === "wrong wake") {
          const atWait = yield* workflows.waitFor(
            child.runId,
            (run) => run.detail === "merge-wait" || run.endedAt !== null || run.status === "paused",
          );
          expect(atWait).toMatchObject({ status: "waiting", detail: "merge-wait" });
          expect(world.acts).toHaveLength(1);
          if (mode === "timeout") {
            yield* world.expireQuestion(workflows, child.runId, "merge-wait");
          } else {
            yield* workflows.signal(
              { runId: child.runId, wait: "merge-wait" },
              { url: URL, state: "merged", checks: "passing", mergeability: "mergeable" },
              { id: "schema-valid-merge-signal" },
            );
          }
        }
        if (mode === "matched") {
          expect(yield* world.ended(workflows, child.runId, true)).toMatchObject(merged());
          expect(world.acts).toHaveLength(1);
        } else {
          const reason =
            mode === "timeout" || mode === "wrong wake"
              ? mergeUnconfirmed("open")
              : mode === "retarget after act"
                ? `${URL} was merged into release, not the reviewed target main. Check the merge now.`
                : beforeReview
                  ? `${URL} was merged at ${mode === "merged at checks" ? H2 : H}, but Factory had no accepted review of that commit. Check the merge now.`
                  : mergedUnreviewed(mode === "unusable" ? "unknown" : H2);
          const question = yield* ask(world, workflows, child.runId, "unreviewed");
          expect(question.kind).toBe("unreviewed");
          expect(question.request).toMatchObject({
            title: reason,
            choices: ["Seen"],
            links: [{ label: "Pull request", url: URL }],
            data: {
              prUrl: URL,
              expectedHead: H,
              mergedHead:
                mode === "retarget after act" || mode === "matched at checks before review"
                  ? H
                  : mode === "unreviewed" || alreadyMerged
                    ? H2
                    : null,
            },
          });
          const notes = yield* workflows.stored(`factory/v1/note/${TASK_ID}/`);
          expect(notes.map((note) => note.value)).toContainEqual(
            expect.objectContaining({ text: reason, by: "factory-task" }),
          );
          expect(
            yield* workflows.stored(`factory/v1/captured/${child.runId}/unreviewed-note`),
          ).toHaveLength(1);
          yield* workflows.answer(child.runId, "unreviewed", { choice: "Seen" }, PERSON);
          expect(yield* world.ended(workflows, child.runId)).toMatchObject(stopped(reason));
          expect(world.acts).toHaveLength(alreadyMerged ? 0 : 1);
        }
        const names = named((yield* workflows.get(child.runId)).steps);
        expect(names).toContain("merged-head");
        if (!alreadyMerged) {
          expect(names.indexOf("merge-wait")).toBeGreaterThan(names.indexOf("merge"));
          expect(names.indexOf("merged-head")).toBeGreaterThan(names.indexOf("merge-wait"));
        } else {
          if (beforeReview) {
            expect(names).not.toContain("review/0");
            expect(names).not.toContain("merge");
          } else expect(names.indexOf("merged-head")).toBeGreaterThan(names.indexOf("merge"));
          expect(names).not.toContain("merge-wait");
        }
      }),
    ),
  ),
);

it.each([
  "invalid_request: not linked",
  "runtime_mode_escalation_denied",
  "The operation could not be completed.",
  `Model ${WORKER.model} is not advertised by provider ${WORKER.instanceId}`,
])("WT13 no fallback on refusal %s; resume starts do/again on E under the same key", (reason) =>
  withOrigin(({ folder, X }) => {
    let refused = true;
    const refusedMessage = `Environment ${E} refused t3_thread_launch: ${reason}`;
    return scenario(
      X,
      {
        starts: {
          startError: (turn) => (refused && turn.environment === E ? refusedMessage : undefined),
        },
      },
      Effect.fn(function* (world, workflows) {
        const { runId } = yield* start(workflows, remote(folder, { workerModel: WORKER }));
        const child = yield* world.child(workflows, runId, 0);
        const paused = yield* settle(workflows, child.runId);
        const attempts = () =>
          world.startAttempts.filter((turn) => turn.origin.runId === child.runId);
        expect(paused).toMatchObject({
          status: "paused",
          detail: expect.stringContaining("do/again:"),
        });
        expect(paused.detail).toContain(refusedMessage);
        expect(paused.resumesAt).not.toBeNull();
        expect(attempts().map((turn) => [turn.origin.step, turn.environment])).toEqual([
          ["do", E],
          ["do/again", E],
        ]);
        expect(world.turns.filter((turn) => turn.origin.runId === child.runId)).toEqual([]);
        const key = only(attempts(), "do/again").key;
        refused = false;
        yield* workflows.resume(child.runId);
        expect(yield* world.ended(workflows, child.runId, true)).toMatchObject(merged());
        expect(only(world.turns, "do/again")).toMatchObject({
          key,
          environment: E,
          project: RP,
          launch: launchFor(B2),
        });
        expect(
          attempts()
            .filter(isWriter)
            .map((turn) => turn.environment),
        ).toEqual([E, E, E]);
      }),
    );
  }),
);

const invalidWriteOn: ReadonlyArray<Schema.Json> = [
  E,
  [E, RP, 2],
  { project: RP, limit: 2 },
  { environment: E, limit: 2 },
  { environment: E, project: RP },
  { ...WRITE_ON, environment: "" },
  { ...WRITE_ON, environment: ` ${E} ` },
  { ...WRITE_ON, environment: "e".repeat(201) },
  { ...WRITE_ON, project: "/srv/app" },
  { ...WRITE_ON, project: "C:\\app" },
  { ...WRITE_ON, project: "c:/app" },
  { ...WRITE_ON, project: ` ${RP} ` },
  { ...WRITE_ON, project: "" },
  { ...WRITE_ON, environment: "   " },
  { ...WRITE_ON, project: "p".repeat(201) },
  { ...WRITE_ON, limit: 0 },
  { ...WRITE_ON, limit: 5 },
  { ...WRITE_ON, limit: 1.5 },
];
type BadConfig = { readonly seed: Seed; readonly reason: string; readonly exact: boolean };
const badConfigs: ReadonlyArray<BadConfig> = [
  { seed: { global: { writeOn: WRITE_ON } }, reason: globalWrite, exact: true },
  { seed: { global: { writeOn: true, readOnlyOn: WRITE_ON } }, reason: globalRead, exact: true },
  {
    seed: { settings: { writeOn: WRITE_ON, readOnlyOn: { ...WRITE_ON, project: "other" } } },
    reason: placementsDiffer(configKey()),
    exact: true,
  },
  {
    seed: { settings: { writeOn: WRITE_ON, readOnlyOn: { ...WRITE_ON, limit: 3 } } },
    reason: placementsDiffer(configKey()),
    exact: true,
  },
  ...invalidWriteOn.map((writeOn) => ({
    seed: { settings: { writeOn } },
    reason: configKey(),
    exact: false,
  })),
];
it.each(badConfigs)("WT14 invalid placement row %# fails config before any agent", (test) =>
  scenario(
    H,
    {},
    Effect.fn(function* (world, workflows) {
      const { runId } = yield* start(workflows, test.seed);
      expect(yield* settle(workflows, runId)).toMatchObject({ status: "paused" });
      const config = row((yield* workflows.get(runId)).steps, "config");
      expect(config.status).toBe("failed");
      if (test.exact) expect(config.detail).toBe(test.reason);
      else expect(config.detail).toContain(test.reason);
      expect(world.startAttempts).toEqual([]);
    }),
  ),
);

it("WT14 null writeOn in the global and project rows is unset", () =>
  scenario(
    H,
    {},
    Effect.fn(function* (world, workflows) {
      const { runId } = yield* start(workflows, {
        global: { writeOn: null },
        settings: { writeOn: null },
      });
      expect(yield* world.ended(workflows, runId, true)).toMatchObject({ status: "completed" });
      expect(only(world.turns, "do").environment).toBeUndefined();
      const steps = (yield* workflows.get(runId)).steps;
      expect(row(steps, "config").result).not.toHaveProperty("writeOn");
      expect(named(steps)).not.toContain("write-placement");
    }),
  ));

const badPlacements: ReadonlyArray<{ readonly seed: Seed; readonly reason: string }> = [
  { seed: { workspace: "root" }, reason: needsWorktree },
  { seed: { workspace: "scratch" }, reason: needsWorktree },
  { seed: { workspace: "missing" }, reason: needsTarget },
  { seed: { folder: null }, reason: needsTarget },
  { seed: { settings: { baseRef: null } }, reason: needsBase },
  { seed: { model: null }, reason: needsModel },
];
it.each(badPlacements)("WT15 unusable write placement stops the task before plan (%#)", (test) =>
  scenario(
    H,
    {},
    Effect.fn(function* (world, workflows) {
      const { runId } = yield* start(workflows, {
        ...test.seed,
        settings: { writeOn: WRITE_ON, ...test.seed.settings },
      });
      expect(yield* world.ended(workflows, runId, true)).toMatchObject(stopped(test.reason));
      expect(row((yield* workflows.get(runId)).steps, "write-placement").result).toEqual({
        where: "refused",
        reason: test.reason,
      });
      expect(world.startAttempts).toEqual([]);
    }),
  ),
);

it.each(["root", "missing", "no folder", "missing origin branch"] as const)(
  "WT15 the part reads its own target despite the worktree supplied by plan: %s",
  (mode) =>
    withOrigin(
      ({ folder, X }) =>
        scenario(
          X,
          {
            starts: { holdAgent: (turn) => turn.origin.step === "plan" },
          },
          Effect.fn(function* (world, workflows) {
            const { runId } = yield* start(workflows, remote(folder));
            const plan = yield* world.nextTurn;
            expect(plan.origin.step).toBe("plan");
            expect(row((yield* workflows.get(runId)).steps, "target").result).toMatchObject({
              workspace: "worktree",
            });
            if (mode === "root")
              yield* workflows.storeSet(targetKey(), target(PROJECT, "root", folder));
            if (mode === "missing") yield* workflows.storeDelete(targetKey());
            if (mode === "no folder")
              yield* workflows.storeSet(targetKey(), target(PROJECT, "worktree", null));
            yield* world.releaseTurn(plan);
            const child = yield* world.child(workflows, runId, 0);
            const reason =
              mode === "root"
                ? needsWorktree
                : mode === "missing origin branch"
                  ? baseUnread("main")
                  : needsTarget;
            expect(yield* world.ended(workflows, child.runId, true)).toMatchObject(stopped(reason));
            expect(world.startAttempts.map((turn) => turn.origin.step)).toEqual(["plan"]);
            if (mode === "missing origin branch") {
              expect(
                row((yield* workflows.get(child.runId)).steps, "writer-base").result,
              ).toBeNull();
            }
          }),
        ),
      mode === "missing origin branch" ? "release" : "main",
    ),
);

it.each([
  { model: MODEL, baseRef: null, reason: needsBase },
  { model: null, baseRef: "main", reason: needsModel },
] as const)("WT15 the part itself refuses a worktree without a base or worker model (%#)", (test) =>
  scenario(
    H,
    {},
    Effect.fn(function* (world, workflows) {
      const input = yield* seed(workflows, {
        model: test.model,
        settings: { writeOn: WRITE_ON, baseRef: test.baseRef },
      });
      const { runId } = yield* workflows.start(
        "factory-task-part",
        {
          ...input,
          ...PART,
          part: 0,
          target: target(PROJECT, "worktree", "/factory-pack-test"),
          priorPrUrls: [],
          config: {
            v: 1,
            concurrency: 2,
            askPlan: false,
            askMerge: false,
            mergeNeedsPerson: false,
            planModel: null,
            workerModel: null,
            reviewModel: null,
            baseRef: test.baseRef,
            stepTimeout: "2 hours",
            checksTimeout: "1 hour",
            fixRounds: 2,
            mergeMethod: "squash",
            protectedPaths: [],
            lowRiskPaths: [],
            writeOn: WRITE_ON,
          },
        },
        { idempotencyKey: "part-without-placement" },
      );
      expect(yield* world.ended(workflows, runId, true)).toMatchObject(stopped(test.reason));
      expect(world.startAttempts).toEqual([]);
      const { steps } = yield* workflows.get(runId);
      expect(named(steps)).not.toContain("writer-base");
      expect(row(steps, "write-placement").result).toEqual({
        where: "refused",
        reason: test.reason,
      });
    }),
  ),
);

it("WT16 a writer and another task's reader share the environment's one admission", () =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      {
        starts: {
          holdAgent: (turn) =>
            turn.environment === E && (turn.origin.step === "scope/0" || turn.origin.step === "do"),
        },
      },
      Effect.fn(function* (world, workflows) {
        const one = { ...WRITE_ON, limit: 1 };
        const reader = yield* start(workflows, {
          taskId: OTHER_TASK,
          project: "project-2",
          folder,
          settings: { readOnlyOn: one },
        });
        const readerPart = yield* world.child(workflows, reader.runId, 0);
        // nextTurn is a queue event, not a check for a turn that might still be starting.
        let turn = yield* world.nextTurn;
        while (turn.environment !== E) turn = yield* world.nextTurn;
        expect(turn.origin).toMatchObject({ runId: readerPart.runId, step: "scope/0" });
        const reading = turn;
        const writer = yield* start(workflows, remote(folder, { writeOn: one, readOnlyOn: one }));
        const writerPart = yield* world.child(workflows, writer.runId, 0);
        const queued = yield* workflows.waitFor(
          writerPart.runId,
          (run) =>
            run.detail === `queue ${POOL}` ||
            run.detail === "agent do" ||
            run.status === "paused" ||
            run.endedAt !== null,
        );
        expect(queued).toMatchObject({ status: "waiting", detail: `queue ${POOL}` });
        expect(world.turns.filter((attempt) => attempt.environment === E)).toEqual([reading]);
        yield* world.releaseTurn(reading);
        while (turn.origin.runId !== writerPart.runId || turn.origin.step !== "do") {
          turn = yield* world.nextTurn;
        }
        expect(turn.environment).toBe(E);
        expect(world.activeCounts[world.turns.indexOf(turn)]).toBe(1);
        yield* world.releaseTurn(turn);
        while (turn.origin.runId !== writerPart.runId || turn.origin.step !== "scope/0") {
          turn = yield* world.nextTurn;
        }
        yield* world.releaseTurn(turn);
        yield* world.ended(workflows, writer.runId, true);
        yield* world.ended(workflows, reader.runId, true);
        expect(
          world.turns
            .filter((attempt) => attempt.environment === E)
            .map((attempt) => world.activeCounts[world.turns.indexOf(attempt)]),
        ).toEqual([1, 1, 1, 1, 1]);
      }),
    ),
  ));

it("WT16 concurrency one takes the task place even when the writer environment allows two", () =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      {
        parts: [PART, SECOND],
        starts: { holdAgent: (turn) => turn.origin.step === "do" },
      },
      Effect.fn(function* (world, workflows) {
        const { runId } = yield* start(workflows, remote(folder, { concurrency: 1 }));
        expect((yield* world.nextTurn).origin.step).toBe("plan");
        const first = yield* world.nextTurn;
        expect(first.origin.step).toBe("do");
        const child0 = yield* world.child(workflows, runId, 0);
        const sibling =
          first.origin.runId === child0.runId ? yield* world.child(workflows, runId, 1) : child0;
        const waiting = yield* workflows.waitFor(
          sibling.runId,
          (run) =>
            run.detail?.startsWith("queue ") === true ||
            run.detail === "agent do" ||
            run.status === "paused" ||
            run.endedAt !== null,
        );
        expect(waiting).toMatchObject({
          status: "waiting",
          detail: `queue factory-task:${TASK_ID}`,
        });
        expect(world.turns.filter(isWriter)).toEqual([first]);
        yield* world.releaseTurn(first);
        let next = yield* world.nextTurn;
        while (next.origin.step !== "do") next = yield* world.nextTurn;
        expect(next.origin.runId).toBe(sibling.runId);
        yield* world.releaseTurn(next);
        yield* world.ended(workflows, runId, true);
        expect(Math.max(...world.activeCounts)).toBe(1);
      }),
    ),
  ));

it("WT16 distinct environments leave the writer on E and pin scope and review on the reader", () =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      { needsFix: true },
      Effect.fn(function* (world, workflows) {
        const readOnlyOn = { environment: "env-reader", project: "reader-project", limit: 1 };
        const { runId } = yield* start(
          workflows,
          remote(folder, { readOnlyOn, protectedPaths: ["src/**"] }),
        );
        const child = yield* world.child(workflows, runId, 0);
        yield* ask(world, workflows, child.runId, "approve-merge");
        const steps = (yield* workflows.get(child.runId)).steps;
        for (const [at, head] of [
          ["0", H],
          ["1", H2],
        ] as const) {
          expect(row(steps, `review-base/${at}`).result).toEqual({ target: "main", baseSha: X });
          const readers = [`scope/${at}`, `review/${at}`, `review/${at}/defects`];
          if (at === "0") readers.push("disprove/0");
          for (const name of readers) {
            const turn = only(world.turns, name);
            const command = name.startsWith("scope/") ? "git diff --name-only" : "git diff";
            expect(turn.prompt).toContain(`\`${command} ${X}...${head}\``);
            expect(turn.prompt).toContain("Do not substitute the live pull request diff");
            if (name !== "disprove/0") {
              expect(turn.prompt).toContain("GIT_NO_LAZY_FETCH=1");
              expect(turn.prompt).toContain("GIT_ALLOW_PROTOCOL=factory-review-no-transport");
            }
          }
        }
        yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" }, PERSON);
        yield* world.ended(workflows, runId, true);
        expect(only(world.turns, "do")).toMatchObject({ environment: E, project: RP });
        for (const step of ["scope/0", "review/0"]) {
          expect(only(world.turns, step)).toMatchObject({
            environment: readOnlyOn.environment,
            project: readOnlyOn.project,
            launch: { workspace: { type: "worktree", baseRef: H, startFromOrigin: false } },
          });
        }
      }),
    ),
  ));

it("WT16 a missing pinned base stops remote review before any lens or merge override", () =>
  withOrigin(({ folder, X }) =>
    scenario(
      X,
      {
        respond: (turn) =>
          turn.origin.step === "scope/0"
            ? { output: { report: { missingBase: true } } }
            : undefined,
      },
      Effect.fn(function* (world, workflows) {
        const readOnlyOn = { environment: "env-reader", project: "reader-project", limit: 1 };
        const { runId } = yield* start(workflows, remote(folder, { readOnlyOn }));
        const child = yield* world.child(workflows, runId, 0);
        expect(yield* world.ended(workflows, child.runId, true)).toMatchObject(
          stopped(
            `The reader in environment env-reader, project reader-project, lacks the pinned base commit ${X}. Fetch the target branch main from origin in that project's clone, verify it contains ${X}, then start the task again. Nothing was merged.`,
          ),
        );
        const scope = only(world.turns, "scope/0");
        expect(scope.prompt).toContain(`git rev-parse --verify "${X}^{commit}"`);
        expect(scope.prompt).toContain('{"report":{"missingBase":true}}');
        expect(world.turns.map((turn) => turn.origin.step)).toEqual(["plan", "do", "scope/0"]);
        expect(world.acts).toEqual([]);
      }),
    ),
  ));

it("WT18 only version 4 is registered and factory-start dispatches it", () =>
  scenario(
    H,
    {},
    Effect.fn(function* (world, workflows) {
      for (const name of ["factory-task", "factory-task-part"]) {
        expect(
          world.definitions
            .filter((definition) => definition.name === name)
            .map((definition) => definition.version),
        ).toEqual([4]);
      }
      expect(
        world.definitions.find((definition) => definition.name === "factory-task-part")?.asks
          .unreviewed,
      ).toBe("Unreviewed commits merged");
      yield* seed(workflows);
      const started = yield* workflows.start(
        "factory-start",
        { taskId: TASK_ID },
        { idempotencyKey: "version" },
      );
      const { runId } = decodeStarted((yield* world.ended(workflows, started.runId)).result);
      expect((yield* workflows.get(runId)).run).toMatchObject({
        workflow: "factory-task",
        version: 4,
      });
      expect(yield* world.ended(workflows, runId, true)).toMatchObject({ status: "completed" });
    }),
  ));

it("WT18 placement decisions obey W3's ordering and exact shapes", () => {
  const worktree = { workspace: "worktree", workspaceRoot: "the-project" } as const;
  const root = { ...worktree, workspace: "root" } as const;
  expect(Placement.writePlacementFor(undefined, null, null, false)).toStrictEqual({
    where: "local",
  });
  expect(Placement.writePlacementFor(WRITE_ON, null, null, false)).toStrictEqual({
    where: "refused",
    reason: needsTarget,
  });
  expect(
    Placement.writePlacementFor(WRITE_ON, { ...root, workspaceRoot: null }, null, false),
  ).toStrictEqual({ where: "refused", reason: needsTarget });
  expect(Placement.writePlacementFor(WRITE_ON, root, null, false)).toStrictEqual({
    where: "refused",
    reason: needsWorktree,
  });
  expect(
    Placement.writePlacementFor(WRITE_ON, { ...root, workspace: "scratch" }, "main", true),
  ).toStrictEqual({ where: "refused", reason: needsWorktree });
  expect(Placement.writePlacementFor(WRITE_ON, worktree, null, false)).toStrictEqual({
    where: "refused",
    reason: needsBase,
  });
  expect(Placement.writePlacementFor(WRITE_ON, worktree, "main", false)).toStrictEqual({
    where: "refused",
    reason: needsModel,
  });
  expect(Placement.writePlacementFor(WRITE_ON, worktree, "main", true)).toStrictEqual({
    where: "remote",
    ...WRITE_ON,
    pool: POOL,
    folder: worktree.workspaceRoot,
  });
  expect(Placement.placementsAgree(undefined, undefined)).toBe(true);
  expect(Placement.placementsAgree(undefined, WRITE_ON)).toBe(true);
  expect(Placement.placementsAgree(WRITE_ON, undefined)).toBe(true);
  expect(Placement.placementsAgree(WRITE_ON, { ...WRITE_ON })).toBe(true);
  expect(Placement.placementsAgree(WRITE_ON, { ...WRITE_ON, project: "other" })).toBe(false);
  expect(Placement.placementsAgree(WRITE_ON, { ...WRITE_ON, limit: 1 })).toBe(false);
  expect(
    Placement.placementsAgree(WRITE_ON, { environment: "other", project: "other", limit: 1 }),
  ).toBe(true);
  expect(Placement.writerBranch(TASK_ID, 1, 0)).toBe(B);
  expect(Placement.writerBranch(TASK_ID, 2, 5)).toBe(`factory-task/${TASK_ID}/a2-p6`);
  expect(Placement.againBranch(B)).toBe(B2);
});

it.each([
  ["main", "main"],
  ["origin/main", "main"],
  ["refs/heads/topic/x", "topic/x"],
  ["refs/heads/origin/topic", "origin/topic"],
] as const)("WT18 baseRef %s denotes the target %s", (ref, target) => {
  expect(Placement.baseTarget(ref)).toBe(target);
  expect(Placement.remoteBase(ref)).toBe(`origin/${target}`);
});

it.each([
  { output: "", expected: null },
  { output: `${H}\trefs/heads/main\n`, expected: H },
  { output: `${H2}\trefs/heads/release\r\n${H}\trefs/heads/main\r\n`, expected: H },
  { output: `${H}\trefs/heads/main\n${H2}\trefs/heads/main\n`, expected: null },
  { output: `${H}\trefs/tags/main\n${H2}\trefs/heads/main/other\n`, expected: null },
  { output: `abc\trefs/heads/main\n`, expected: null },
  { output: `${"d".repeat(64)}\trefs/heads/main\n`, expected: "d".repeat(64) },
])(
  "WT18 ls-remote needs one exact matching branch with a full SHA (%#)",
  ({ output, expected }) => {
    expect(Placement.baseFromLsRemote(output, "main")).toBe(expected);
  },
);

it("WT18 W12's strings render the names and observations they are given", () => {
  expect(Placement.REMOTE_FOLLOW_UPS).toBe(FOLLOW_UPS);
  expect(Placement.writerLine(H, "release")).toBe(writerLine(H, "release"));
  expect(Placement.WRITER_RETURN_LINE).toBe(WRITER_RETURN);
  expect(Placement.continueReturnLine(H)).toBe(continueReturn(H));
  expect(Placement.FIX_PUSH_LINE).toBe(FIX_PUSH);
  expect(Placement.remotePriorLine([URL])).toBe(priorLine(URL));
  const otherUrl = `${URL}0`;
  expect(Placement.remotePriorLine([URL, otherUrl])).toBe(
    `An earlier attempt at this task left these pull requests open: ${URL}, ${otherUrl}. Do not push to their branches; this attempt opens its own pull request.`,
  );
  expect(Placement.REMOTE_NO_PULL_REQUEST).toBe(noPullRequest);
  expect(Placement.REMOTE_NEEDS_GITHUB).toBe(needsGitHub);
  expect(Placement.headUnusable("fix-after/1")).toBe(headUnusable("fix-after/1"));
  expect(Placement.unreportedHead("do")).toBe(unreportedHead("do"));
  expect(Placement.branchNotGiven("do/again", "other", B2)).toBe(
    branchNotGiven("do/again", "other", B2),
  );
  expect(Placement.baseDiffers("do/continue", "nothing", H)).toBe(
    baseDiffers("do/continue", "nothing", H),
  );
  expect(Placement.baseUnread("release")).toBe(baseUnread("release"));
  expect(Placement.wrongRepository("unknown", REPOSITORY)).toBe(wrongRepository("unknown"));
  expect(Placement.wrongBase("release", "main")).toBe(wrongBase("release"));
  expect(Placement.headMoved("head/0", H2, H)).toBe(headMoved("head/0", H2));
  expect(Placement.fixContradicts("fix/1", H2, H)).toBe(fixContradicts("fix/1", H2, H));
  expect(Placement.ranElsewhere("fix/0")).toBe(ranElsewhere("fix/0"));
  expect(Placement.headCheck(H)).toBe(headCheck(H));
  expect(Placement.mergeMark(H, "reviewed")).toBe(mergeMark(H));
  expect(Placement.mergedUnreviewed(H2, H, URL)).toBe(mergedUnreviewed(H2));
  expect(Placement.mergeUnconfirmed(URL, H, "open")).toBe(mergeUnconfirmed("open"));
  expect(Placement.WRITE_NEEDS_WORKTREE).toBe(needsWorktree);
  expect(Placement.WRITE_NEEDS_TARGET).toBe(needsTarget);
  expect(Placement.WRITE_NEEDS_BASE).toBe(needsBase);
  expect(Placement.WRITE_NEEDS_MODEL).toBe(needsModel);
  expect(Placement.GLOBAL_WRITE_ROW_REFUSED).toBe(globalWrite);
  expect(Placement.placementsDiffer(configKey())).toBe(placementsDiffer(configKey()));
});

it("WT19 and WT17 a tracked-repository replacement starts but its B-2 is refused and its thread is journaled", () =>
  withOrigin(({ folder, X }) => {
    // The second worktree request is still B; only the destination changes the branch.
    const renamed = `${B}-2`;
    return scenario(
      X,
      {
        starts: { resultError: loseFirstDo, interrupt: () => "stopped" },
        done: (done) => ({ ...done, branch: renamed }),
        read: ({ detail }) => ({ ...detail, headBranch: renamed }),
      },
      Effect.fn(function* (world, workflows) {
        const { runId } = yield* start(workflows, remote(folder));
        const child = yield* world.child(workflows, runId, 0);
        expect(yield* world.ended(workflows, child.runId, true)).toMatchObject(
          stopped(branchNotGiven("do", renamed, B)),
        );
        const writers = world.turns.filter(isWriter);
        expect(
          writers.map((turn) => [turn.origin.step, turn.environment, turnBranch(turn)]),
        ).toEqual([
          ["do", E, B],
          ["do", E, B],
        ]);
        const [first, replacement] = writers;
        if (!first || !replacement) throw new Error("Expected the two acknowledged writer starts");
        expect(replacement.key).not.toBe(first.key);
        expect(world.interrupts).toEqual([
          { threadId: threadOf(first), environment: E, turnId: first.key },
        ]);
        const steps = (yield* workflows.get(child.runId)).steps;
        expect(row(steps, "do")).toMatchObject({
          threadId: threadOf(replacement),
          environmentId: E,
        });
        expect(
          named(steps).filter((name) => /^(?:pr-record|review\/|ledger\/)/.test(name)),
        ).toEqual([]);
        expect(world.acts).toEqual([]);
      }),
    );
  }));

it.each([
  { name: "do", reportedEnvironment: null },
  { name: "do/again", reportedEnvironment: "env-other-writer" },
  { name: "do/continue", reportedEnvironment: "env-other-writer" },
  { name: "fix/0", reportedEnvironment: null },
] as const)(
  "WT20 $name reporting $reportedEnvironment instead of E stops before its result is used",
  ({ name, reportedEnvironment }) =>
    withOrigin(({ folder, X }) =>
      scenario(
        X,
        {
          needsFix: name === "fix/0",
          starts: {
            startError: (turn) =>
              name === "do/again" && turn.origin.step === "do"
                ? "Lost the launch reply."
                : undefined,
            startedIn: (turn) =>
              turn.origin.step === name ? reportedEnvironment : (turn.environment ?? null),
          },
          respond: (turn) =>
            name === "do/continue" && turn.origin.step === "do"
              ? { ending: "stopped", detail: "it was not done after 2h" }
              : undefined,
        },
        Effect.fn(function* (world, workflows) {
          const { runId } = yield* start(workflows, remote(folder));
          const child = yield* world.child(workflows, runId, 0);
          expect(yield* world.ended(workflows, child.runId, true)).toMatchObject(
            stopped(ranElsewhere(name)),
          );
          const { steps } = yield* workflows.get(child.runId);
          if (name === "fix/0") {
            expect(named(steps)).not.toContain("fix-after/0");
          } else {
            expect(
              named(steps).filter((step) =>
                /^(?:pull-request$|writer-pr$|pr-record$|checks\/|scope\/|review\/|ledger\/)/.test(
                  step,
                ),
              ),
            ).toEqual([]);
          }
          expect(row(steps, name).environmentId).toBe(reportedEnvironment);
          const writer = only(world.turns, name);
          expect(writer.environment).toBe(E);
          if (name === "do/again") {
            expect(only(world.startAttempts, "do").environment).toBe(E);
            expect(world.turns.some((turn) => turn.origin.step === "do")).toBe(false);
          }
          if (name === "do/continue") {
            expect(writer.thread).toBe(threadOf(only(world.turns, "do")));
          }
          expect(world.questions).toEqual([]);
          expect(world.acts).toEqual([]);
        }),
      ),
    ),
);
