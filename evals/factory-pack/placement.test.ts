import type { PullRequestDetail } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { type AgentResult, isProjectPath } from "../../apps/server/src/workflows/WorkflowAgents.ts";
import * as WorkflowForge from "../../apps/server/src/workflows/WorkflowForge.ts";
import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import {
  isFullSha,
  namesFolder,
  placementFor,
  REMOTE_NEEDS_TARGET,
  REMOTE_NEEDS_WORKTREE,
  remoteLine,
  remotePool,
  remoteScopeBase,
} from "../../factory/workflows/lib/placement.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Service = Workflows.Workflows["Service"];
type Reported = {
  readonly severity: "blocker" | "major" | "minor" | "nit";
  readonly category: "correctness" | "scope" | "test" | "security" | "other";
  readonly path: string;
  readonly line: number | null;
  readonly claim: string;
  readonly evidence: string;
};

const AT = "2026-01-01T00:00:00.000Z";
const PROJECT = "project-1";
const OTHER_PROJECT = "project-2";
const SCRATCH_PROJECT = "scratch-proj-1";
const TASK_ID = "b0000000-0000-4000-8000-000000000010";
const OTHER_TASK_ID = "b0000000-0000-4000-8000-000000000011";
const E = "env-linked-1";
const RP = "remote-project-1";
const OTHER_RP = "remote-project-2";
const READ_ONLY_ON = { environment: E, project: RP, limit: 2 };
const POOL = `factory-env:${E}`;
const QUEUED = `queue ${POOL}`;
const MODEL = { instanceId: "codex", model: "task-model" };
const REVIEW_MODEL = { instanceId: "claude", model: "review-model" };
const PERSON = { label: "Person", sessionId: "person-session" };
const PART = { title: "Guard the parser", brief: "Make the parser reject empty input." };
const SECOND_PART = { title: "Document the parser", brief: "Document that empty input fails." };
// The pull request's head after `pushes` pushes: full 40-character SHAs.
const headAt = (pushes: number) => String(pushes + 1).repeat(40);
const H = headAt(0);
const HEAD_9 = "9".repeat(40);
const KEPT_CHANGING = "The pull request's head kept changing while it was reviewed.";
const NEEDS_WORKTREE =
  "readOnlyOn is set for this project, but its tasks work in a plain folder, which another machine does not have. Remove readOnlyOn from the project's Factory config, then start the task again.";
const NEEDS_TARGET =
  "readOnlyOn is set for this project, but the server has no usable record of where its tasks work. Start the task from the Work page, which writes that record, or remove readOnlyOn from the project's Factory config.";
// `<projectId>` is literal here: the contract says the eleven characters before the full stop are.
const GLOBAL_ROW_REFUSED =
  "The Factory config at factory/v1/config is not valid: readOnlyOn names one project on another machine, so it belongs in factory/v1/config/<projectId>.";
// REMOTE_LINE with `<sha>` filled in, written out from the contract rather than imported.
const remoteLineOf = (sha: string) =>
  `You are on another machine than the one this task is run from, in a worktree made at commit \`${sha}\`. No approval will be given here: use only file reads and read-only git (\`git diff\`, \`git show\`, \`git log\`, \`git rev-parse\`), and do not edit, commit, push, fetch, install, build or run tests. Report the output of \`git rev-parse HEAD\` as the commit you read.`;
// AMBIGUOUS: only `<remoteBase>` is filled in (X2 says so); `<base>` is read as literal text the
// agent reads. The other reading would put the remote base in both places.
const scopeLineOf = (remoteBase: string) =>
  `Run \`git diff --name-only <base>...HEAD\`, where \`<base>\` is \`${remoteBase}\` as this clone has it.`;
const FETCH_LINE = "Fetch the pull request's head commit";
const REMOTE_MARK = "You are on another machine";
const SCOPE_MARK = "Run `git diff --name-only <base>...HEAD`";
const REMOTE_PLACEMENT = { where: "remote", environment: E, project: RP, pool: POOL, limit: 2 };
const remoteLaunch = (sha: string) => ({
  workspace: { type: "worktree", baseRef: sha, startFromOrigin: false },
  runtimeMode: "approval-required",
  interactionMode: "plan",
});
// Revision 9's effective config with every field at its default (run.test.ts's DEFAULT_CONFIG).
const DEFAULT_CONFIG = {
  v: 1,
  concurrency: 2,
  askPlan: true,
  askMerge: true,
  mergeNeedsPerson: false,
  planModel: null,
  workerModel: null,
  reviewModel: null,
  baseRef: null,
  stepTimeout: "2 hours",
  checksTimeout: "1 hour",
  fixRounds: 2,
  mergeMethod: "squash",
  protectedPaths: [],
  lowRiskPaths: [],
};
const configOf = (global: Schema.JsonObject = {}, readOnlyOn?: typeof READ_ONLY_ON) => ({
  ...DEFAULT_CONFIG,
  askPlan: false,
  askMerge: false,
  ...global,
  ...(readOnlyOn === undefined ? {} : { readOnlyOn }),
});
// What revision 9 and the harness already write under factory/v1/; X8 adds no key.
const REVISION_9_KEY =
  /^factory\/v1\/(?:seq$|config$|config\/|task\/|attempt\/|note\/|orchestrator\/|intake\/|intake-seen\/|captured\/|ledger\/|outcome\/|metrics\/|target\/|artifact\/|receipt\/)/;

const MAJOR: Reported = {
  severity: "major",
  category: "correctness",
  path: "src/part.ts",
  line: 3,
  claim: "Throws on empty input.",
  evidence: "",
};
const DEAD: Partial<AgentResult> = {
  ending: "failed",
  detail: "The linked machine reports the turn's provider exited.",
};
const TIMED_OUT: Partial<AgentResult> = {
  ending: "stopped",
  detail: "it was not done after 2h",
};
const STOP_FAILED = "E did not answer the stop.";
const report = (
  findings: ReadonlyArray<Reported>,
  reviewedHead: string | null,
): Partial<AgentResult> => ({ output: { reviewedHead, findings } });

const decodePullRequest = Schema.decodeSync(WorkflowForge.PullRequest);
const pullRequestAt = (url: string, projectId: string) =>
  decodePullRequest({
    provider: "github",
    host: "github.com",
    repository: "factory/pack",
    projectId,
    projectTitle: "Factory",
    number: Number(url.split("/").at(-1)),
    title: PART.title,
    url,
    author: null,
    headBranch: "factory-part",
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
  });
const decodeRisk = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({ riskTier: Schema.String, riskReasons: Schema.Array(Schema.String) }),
  }),
);
const decodeStarted = Schema.decodeUnknownSync(
  Schema.Struct({ taskId: Schema.String, attempt: Schema.Number, runId: Schema.String }),
);

const baseRefOf = (turn: AgentTurnInput) => {
  const workspace = turn.launch?.workspace;
  return workspace?.type === "worktree" ? workspace.baseRef : undefined;
};
// The engine keys a step's turns `<runId>/<step>/<round>`; round 0 is the first launch.
const firstRound = (turn: AgentTurnInput) =>
  turn.key === `${turn.origin.runId}/${turn.origin.step}/0`;

type HeadState = { pushes: number };
type Respond = (turn: AgentTurnInput, state: HeadState) => Partial<AgentResult> | undefined;

const scenario = (
  respond: Respond = () => undefined,
  options: {
    readonly head?: (pushes: number) => string | undefined;
    readonly parts?: ReadonlyArray<typeof PART>;
    readonly noPullRequest?: boolean;
    readonly baseBranch?: string;
  } = {},
) => {
  const state: HeadState = { pushes: 0 };
  const head = options.head ?? headAt;
  const urls = new Map<string, string>();
  const urlOf = (runId: string) => {
    const known = urls.get(runId);
    if (known !== undefined) return known;
    const url = `https://github.com/factory/pack/pull/${60 + urls.size}`;
    urls.set(runId, url);
    return url;
  };
  return {
    listPullRequests: (query: WorkflowForge.PullRequestQuery) =>
      Effect.succeed([...urls.values()].map((url) => pullRequestAt(url, query.project))),
    standing: (address: WorkflowForge.PullRequestAddress): WorkflowForge.PullRequestStanding => ({
      url:
        "url" in address
          ? address.url
          : `https://${address.host}/${address.repository}/pull/${address.number}`,
      state: "open",
      checks: "passing",
      mergeability: "mergeable",
    }),
    readPullRequest: (_address: WorkflowForge.PullRequestAddress, detail: PullRequestDetail) =>
      Effect.succeed({
        ...detail,
        headSha: head(state.pushes),
        baseBranch: options.baseBranch ?? detail.baseBranch,
      }),
    agent: (turn: AgentTurnInput): Partial<AgentResult> => {
      const answer = respond(turn, state);
      if (answer !== undefined) return answer;
      const step = turn.origin.step;
      if (step === "plan") {
        return { output: { summary: "A small plan.", parts: [...(options.parts ?? [PART])] } };
      }
      if (/^do(?:\/continue|\/again)?$/.test(step)) {
        return {
          output: {
            summary: "Guarded the parser.",
            prUrl: options.noPullRequest === true ? null : urlOf(turn.origin.runId),
          },
        };
      }
      if (step.startsWith("scope/")) return {};
      // A remote reviewer reads its worktree's commit; one here reads the head as it is now.
      if (step.startsWith("review/")) {
        const read = turn.environment === undefined ? head(state.pushes) : baseRefOf(turn);
        return report([], read ?? null);
      }
      if (step.startsWith("disprove/")) return { output: { results: [] } };
      if (step.startsWith("fix/")) {
        state.pushes++;
        return { reply: "Pushed a fix." };
      }
      throw new Error(`Unexpected agent step ${step}`);
    },
  };
};

type Seed = {
  readonly taskId?: string;
  readonly number?: number;
  readonly projectId?: string | null;
  readonly model?: typeof MODEL | null;
  readonly global?: Schema.JsonObject;
  readonly globalRow?: Schema.Json;
  readonly readOnlyOn?: Schema.Json;
  readonly target?: "worktree" | "root" | "missing";
  readonly targetRow?: Schema.Json;
};

const taskOf = (options: Seed) => ({
  number: options.number ?? 9,
  title: PART.title,
  description: PART.brief,
  projectId: options.projectId === undefined ? PROJECT : options.projectId,
  model: options.model === undefined ? MODEL : options.model,
});

const seedTarget = (workflows: Service, projectId: string, workspace: "worktree" | "root") =>
  workflows.storeSet(`factory/v1/target/${projectId}`, {
    v: 1,
    projectId,
    workspace,
    workspaceRoot: "/factory-pack-test",
    problem: null,
    checkedAt: AT,
  });

const seedTask = Effect.fn("factoryPack.placement.seedTask")(function* (
  workflows: Service,
  options: Seed = {},
) {
  const taskId = options.taskId ?? TASK_ID;
  const task = taskOf(options);
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
  yield* workflows.storeSet(
    "factory/v1/config",
    options.globalRow ?? {
      v: 1,
      askPlan: false,
      askMerge: false,
      mergeNeedsPerson: false,
      ...options.global,
    },
  );
  if (task.projectId === null) return;
  if (options.readOnlyOn !== undefined) {
    yield* workflows.storeSet(`factory/v1/config/${task.projectId}`, {
      v: 1,
      readOnlyOn: options.readOnlyOn,
    });
  }
  if (options.targetRow !== undefined) {
    yield* workflows.storeSet(`factory/v1/target/${task.projectId}`, options.targetRow);
  } else if (options.target !== "missing") {
    yield* seedTarget(workflows, task.projectId, options.target ?? "worktree");
  }
});

const launchTask = (workflows: Service, options: Seed = {}) => {
  const taskId = options.taskId ?? TASK_ID;
  return workflows.start(
    "factory-task",
    { ...taskOf(options), taskId, attempt: 1, issueUrl: null },
    { idempotencyKey: `task/${taskId}/a1` },
  );
};

const start = Effect.fn("factoryPack.placement.start")(function* (
  workflows: Service,
  options: Seed = {},
) {
  yield* seedTask(workflows, options);
  return yield* launchTask(workflows, options);
});

const stepsOf = Effect.fn("factoryPack.placement.steps")(function* (
  workflows: Service,
  runId: string,
) {
  return (yield* workflows.get(runId)).steps;
});
const stepNamed = <S extends { readonly name: string }>(steps: ReadonlyArray<S>, name: string) => {
  const found = steps.find((step) => step.name === name);
  if (found === undefined) throw new Error(`Expected a ${name} step`);
  return found;
};
const launches = (attempts: ReadonlyArray<AgentTurnInput>, runId: string, step: string) =>
  attempts.filter((turn) => turn.origin.runId === runId && turn.origin.step === step);
const onlyLaunch = (attempts: ReadonlyArray<AgentTurnInput>, runId: string, step: string) => {
  const found = launches(attempts, runId, step);
  expect(found, step).toHaveLength(1);
  const [turn] = found;
  if (turn === undefined) throw new Error(`Expected a ${step} launch`);
  return turn;
};
const remoteSteps = /^(?:scope|review)\//;
const settled = (workflows: Service, runId: string) =>
  workflows.waitFor(runId, (run) => run.status === "paused" || run.endedAt !== null);
const asked = Effect.fn("factoryPack.placement.asked")(function* (
  world: World,
  workflows: Service,
  runId: string,
  name: string,
) {
  const question = yield* world.question(workflows, runId);
  expect(question.name).toBe(name);
  return question;
});
const ledgerKey = (at: string) => `factory/v1/ledger/${TASK_ID}/a1/p0/${at}`;
const roundAt = Effect.fn("factoryPack.placement.round")(function* (
  workflows: Service,
  at: string,
) {
  const key = ledgerKey(at);
  const row = (yield* workflows.stored(key)).find((entry) => entry.key === key);
  expect(row, key).toBeDefined();
  return row?.value;
});
const scrub = (text: string, runIds: ReadonlyArray<string>) =>
  runIds.reduce((value, runId) => value.replaceAll(runId, "<run>"), text);
const textLines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");
// Everything a launch is given, with run ids taken out so two worlds compare.
const optionsOf = (turn: AgentTurnInput, runIds: ReadonlyArray<string>) => ({
  title: scrub(turn.title, runIds),
  prompt: scrub(turn.prompt, runIds),
  outputSchema: turn.outputSchema,
  model: turn.model,
  project: turn.project,
  environment: turn.environment,
  thread: turn.thread,
  launch: turn.launch,
  issue: turn.issue,
});

// One task with one part through review and merge, with no question on the way.
const standard = (
  readOnlyOn: typeof READ_ONLY_ON | undefined,
  options: {
    readonly baseRef?: string | null;
    readonly baseBranch?: string;
    readonly die?: boolean;
  } = {},
) =>
  withWorld(
    scenario(
      (turn) =>
        options.die === true && /^(?:scope|review)\/0$/.test(turn.origin.step) && firstRound(turn)
          ? DEAD
          : undefined,
      options.baseBranch === undefined ? {} : { baseBranch: options.baseBranch },
    ),
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.standard")(function* (workflows) {
          const { runId } = yield* start(workflows, {
            global: { reviewModel: REVIEW_MODEL, baseRef: options.baseRef ?? null },
            ...(readOnlyOn === undefined ? {} : { readOnlyOn }),
          });
          const child = yield* world.child(workflows, runId, 0);
          const part = yield* world.ended(workflows, child.runId, true);
          const done = yield* world.ended(workflows, runId, true);
          return {
            runIds: [runId, child.runId],
            partRunId: child.runId,
            part,
            done,
            startAttempts: [...world.startAttempts],
            taskSteps: yield* stepsOf(workflows, runId),
            partSteps: yield* stepsOf(workflows, child.runId),
            acts: [...world.acts],
            readCalls: [...world.readCalls],
            pullRequestQueries: [...world.pullRequestQueries],
            prComments: [...world.prComments],
          };
        }),
      ),
  );

it("T1 with readOnlyOn unset a task plans, works, reviews and merges with no machine, no placement and revision 9's config", () =>
  withWorld(scenario(), (world) =>
    world.server(
      Effect.fn("factoryPack.placement.unset")(function* (workflows) {
        const { runId } = yield* start(workflows, { global: { reviewModel: REVIEW_MODEL } });
        const child = yield* world.child(workflows, runId, 0);
        const part = yield* world.ended(workflows, child.runId, true);
        const done = yield* world.ended(workflows, runId, true);
        expect(part).toMatchObject({ status: "completed", result: { outcome: "merged" } });
        expect(done.status).toBe("completed");
        expect(world.turns.map((turn) => turn.origin.step)).toEqual([
          "plan",
          "do",
          "scope/0",
          "review/0",
        ]);
        expect(world.acts).toHaveLength(1);
        expect(world.startAttempts.filter((turn) => turn.environment !== undefined)).toEqual([]);
        for (const id of [runId, child.runId]) {
          const names = (yield* stepsOf(workflows, id)).map((step) => step.name);
          expect(names).not.toContain("placement");
          expect(names.filter((name) => name.startsWith("@pool:factory-env:"))).toEqual([]);
        }
        expect(stepNamed(yield* stepsOf(workflows, runId), "config").result).toStrictEqual(
          configOf({ reviewModel: REVIEW_MODEL }),
        );
      }),
    ),
  ));

it("T2 a remote round starts scope/0 and review/0 on E at the pinned head, and plan and do here as revision 9", async () => {
  const here = await standard(undefined);
  const there = await standard(READ_ONLY_ON);
  for (const step of ["scope/0", "review/0"]) {
    const remote = onlyLaunch(there.startAttempts, there.partRunId, step);
    const local = onlyLaunch(here.startAttempts, here.partRunId, step);
    expect(remote.environment).toBe(E);
    expect(remote.project).toBe(RP);
    expect(remote.launch).toEqual(remoteLaunch(H));
    expect(remote.thread).toBeUndefined();
    expect(remote.issue).toBeUndefined();
    // The model, title and returns are what revision 9 gives the step.
    expect(remote.model).toEqual(local.model);
    expect(scrub(remote.title, there.runIds)).toBe(scrub(local.title, here.runIds));
    expect(remote.outputSchema).toEqual(local.outputSchema);
  }
  expect(onlyLaunch(there.startAttempts, there.partRunId, "review/0").model).toEqual(REVIEW_MODEL);
  for (const step of ["plan", "do"]) {
    const [remote, ...moreRemote] = there.startAttempts.filter((turn) => turn.origin.step === step);
    const [local, ...moreLocal] = here.startAttempts.filter((turn) => turn.origin.step === step);
    expect([moreRemote, moreLocal]).toEqual([[], []]);
    if (remote === undefined || local === undefined) throw new Error(`Expected ${step} launches`);
    expect(remote.environment).toBeUndefined();
    expect(remote.project).toBe(PROJECT);
    expect(optionsOf(remote, there.runIds)).toEqual(optionsOf(local, here.runIds));
  }
  expect(there.part).toMatchObject({ status: "completed", result: { outcome: "merged" } });
});

it.each([
  { baseBranch: "factory", remoteBase: "origin/factory" },
  { baseBranch: "origin/release", remoteBase: "origin/origin/release" },
] as const)(
  "T7 every launch on E carries the remote line once, scope its own diff line, and no launch here either (baseBranch $baseBranch)",
  async ({ baseBranch, remoteBase }) => {
    // Each round's first scope/0 and review/0 turn dies, so each step has a replacement launch.
    const here = await standard(undefined, { baseRef: "not-the-host-base", baseBranch, die: true });
    const there = await standard(READ_ONLY_ON, {
      baseRef: "not-the-host-base",
      baseBranch,
      die: true,
    });
    const line = remoteLineOf(H);
    for (const step of ["scope/0", "review/0"]) {
      const remote = launches(there.startAttempts, there.partRunId, step);
      expect(remote, step).toHaveLength(2);
      for (const turn of remote) {
        expect(turn.environment).toBe(E);
        expect(turn.prompt.split("\n").filter((entry) => entry === line)).toHaveLength(1);
        expect(turn.prompt.split(line)).toHaveLength(2);
      }
    }
    for (const turn of launches(there.startAttempts, there.partRunId, "scope/0")) {
      const lines = turn.prompt.split("\n");
      expect(lines).toContain(scopeLineOf(remoteBase));
      expect(lines.filter((entry) => entry.startsWith(FETCH_LINE))).toEqual([]);
    }
    // Revision 9's brief with the remote line added and, in scope/0, the fetch line replaced.
    const [remoteScope] = launches(there.startAttempts, there.partRunId, "scope/0");
    const [localScope] = launches(here.startAttempts, here.partRunId, "scope/0");
    const [remoteReview] = launches(there.startAttempts, there.partRunId, "review/0");
    const [localReview] = launches(here.startAttempts, here.partRunId, "review/0");
    if (!remoteScope || !localScope || !remoteReview || !localReview) {
      throw new Error("Expected scope/0 and review/0 in both worlds");
    }
    const scopeHere = textLines(scrub(localScope.prompt, here.runIds));
    expect(scopeHere.filter((entry) => entry.startsWith(FETCH_LINE))).toHaveLength(1);
    expect(
      textLines(scrub(remoteScope.prompt, there.runIds)).filter((entry) => entry !== line),
    ).toEqual(
      scopeHere.map((entry) => (entry.startsWith(FETCH_LINE) ? scopeLineOf(remoteBase) : entry)),
    );
    expect(
      textLines(scrub(remoteReview.prompt, there.runIds)).filter((entry) => entry !== line),
    ).toEqual(textLines(scrub(localReview.prompt, here.runIds)));
    for (const turn of [...here.startAttempts, ...there.startAttempts]) {
      if (turn.environment !== undefined || turn.key.includes("/correct/")) continue;
      expect(turn.prompt).not.toContain(REMOTE_MARK);
      expect(turn.prompt).not.toContain(SCOPE_MARK);
    }
  },
);

it("T6 every pull request call of a part reviewed on E names the task's own project", async () => {
  const there = await standard(READ_ONLY_ON);
  const projectOf = (address: WorkflowForge.PullRequestAddress) =>
    "project" in address ? address.project : address.projectId;
  expect(there.pullRequestQueries.length).toBeGreaterThan(0);
  expect(there.pullRequestQueries.map((query) => query.project)).toEqual(
    there.pullRequestQueries.map(() => PROJECT),
  );
  // A checks wait reads the pull request through `pullRequests.read`, so these cover waits.
  expect(there.readCalls.length).toBeGreaterThan(0);
  expect(there.readCalls.map(projectOf)).toEqual(there.readCalls.map(() => PROJECT));
  expect(there.acts).toHaveLength(1);
  expect(there.acts.map(([address, action]) => [projectOf(address), action])).toEqual([
    [PROJECT, "merge"],
  ]);
  expect(there.prComments.map(({ pullRequest }) => projectOf(pullRequest))).toEqual(
    there.prComments.map(() => PROJECT),
  );
  expect(
    JSON.stringify([there.pullRequestQueries, there.readCalls, there.acts, there.prComments]),
  ).not.toContain(RP);
  // RP reaches only the remote steps' launches.
  for (const turn of there.startAttempts) {
    if (turn.project !== RP) continue;
    expect(turn.environment).toBe(E);
    expect(turn.origin.step).toMatch(remoteSteps);
  }
});

it("T3 a high remote round runs its defects lens on E, disproves and fixes here, and each round pins its own head", () => {
  const ruling = "Keep the parser's API; only reject empty input.";
  return withWorld(
    scenario((turn, state) => {
      const step = turn.origin.step;
      if (step === "review/0" || step === "review/1/again") {
        return report([MAJOR], baseRefOf(turn) ?? null);
      }
      // A push lands while round 1 is reviewed, so head/1 makes it stale and 1/again follows.
      if (step === "review/1") {
        const read = baseRefOf(turn) ?? null;
        state.pushes++;
        return report([], read);
      }
      return undefined;
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.highRound")(function* (workflows) {
          const { runId } = yield* start(workflows, {
            global: { protectedPaths: ["src/**"], fixRounds: 1 },
            readOnlyOn: READ_ONLY_ON,
          });
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "stuck");
          yield* workflows.answer(child.runId, "stuck", { choice: "Fix again", reason: ruling });
          yield* asked(world, workflows, child.runId, "approve-merge");
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" }, PERSON);
          const part = yield* world.ended(workflows, child.runId);
          yield* world.ended(workflows, runId);
          expect(part).toMatchObject({ status: "completed", result: { outcome: "merged" } });
          const attempts = world.startAttempts;
          const review = onlyLaunch(attempts, child.runId, "review/0");
          const defects = onlyLaunch(attempts, child.runId, "review/0/defects");
          const shape = (turn: AgentTurnInput) => ({
            environment: turn.environment,
            project: turn.project,
            model: turn.model,
            launch: turn.launch,
          });
          expect(shape(defects)).toEqual(shape(review));
          expect(shape(defects)).toEqual({
            environment: E,
            project: RP,
            model: MODEL,
            launch: remoteLaunch(H),
          });
          const work = onlyLaunch(attempts, child.runId, "do");
          for (const step of ["disprove/0", "disprove/1/again"]) {
            const disprove = onlyLaunch(attempts, child.runId, step);
            expect(disprove.environment, step).toBeUndefined();
            expect(disprove.project, step).toBe(PROJECT);
            expect(disprove.launch, step).toBeUndefined();
            expect(disprove.thread, step).toBeUndefined();
          }
          for (const step of ["fix/0", "fix/x1"]) {
            const fix = onlyLaunch(attempts, child.runId, step);
            expect(fix.thread, step).toBe(`thread-${work.key}`);
            expect(fix.environment, step).toBeUndefined();
            expect(fix.project, step).toBeUndefined();
            expect(fix.launch, step).toBeUndefined();
          }
          // Pinned heads: round 1 after fix/0 (one push), 1/again after the push in review/1
          // (two), x1 after fix/x1 (three).
          for (const [at, sha] of [
            ["1", headAt(1)],
            ["1/again", headAt(2)],
            ["x1", headAt(3)],
          ] as const) {
            const lens = onlyLaunch(attempts, child.runId, `review/${at}`);
            expect(lens.environment, at).toBe(E);
            expect(lens.launch, at).toEqual(remoteLaunch(sha));
            // The scope and defects steps of that round, where revision 9 runs them, agree.
            for (const step of [`scope/${at}`, `review/${at}/defects`]) {
              for (const turn of launches(attempts, child.runId, step)) {
                expect(turn.environment, step).toBe(E);
                expect(turn.launch, step).toEqual(remoteLaunch(sha));
              }
            }
          }
          expect(yield* roundAt(workflows, "1")).toMatchObject({
            head: headAt(1),
            verdict: "stale",
          });
          expect(yield* roundAt(workflows, "1/again")).toMatchObject({
            head: headAt(2),
            verdict: "changes",
          });
          expect(yield* roundAt(workflows, "x1")).toMatchObject({
            head: headAt(3),
            verdict: "approve",
          });
        }),
      ),
  );
});

it("T4 with readOnlyOn set do/again starts here in a worktree of the task's project", () =>
  withWorld(
    {
      ...scenario(),
      startError: (turn) =>
        turn.origin.step === "do" ? "The provider could not create the thread." : undefined,
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.doAgain")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          const part = yield* world.ended(workflows, child.runId, true);
          expect(part).toMatchObject({ status: "completed", result: { outcome: "merged" } });
          const first = onlyLaunch(world.startAttempts, child.runId, "do");
          const again = onlyLaunch(world.startAttempts, child.runId, "do/again");
          expect(again.environment).toBeUndefined();
          expect(again.project).toBe(PROJECT);
          expect(again.thread).toBeUndefined();
          expect(again.launch?.workspace?.type).toBe("worktree");
          expect(again.launch?.runtimeMode).toBe("full-access");
          expect(again.launch).toEqual(first.launch);
          expect(again.model).toEqual(first.model);
          expect(again.prompt).toBe(first.prompt);
          expect(again.prompt).not.toContain(REMOTE_MARK);
          expect(onlyLaunch(world.startAttempts, child.runId, "review/0").environment).toBe(E);
        }),
      ),
  ));

it("T4 with readOnlyOn set do/continue continues the worker's thread with no project and no environment", () =>
  withWorld(
    scenario((turn) => (turn.origin.step === "do" ? TIMED_OUT : undefined)),
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.doContinue")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          const part = yield* world.ended(workflows, child.runId, true);
          expect(part).toMatchObject({ status: "completed", result: { outcome: "merged" } });
          const work = onlyLaunch(world.startAttempts, child.runId, "do");
          const continued = onlyLaunch(world.startAttempts, child.runId, "do/continue");
          expect(work.environment).toBeUndefined();
          expect(continued.thread).toBe(`thread-${work.key}`);
          expect(continued.project).toBeUndefined();
          expect(continued.environment).toBeUndefined();
          expect(continued.launch).toBeUndefined();
          expect(continued.prompt).not.toContain(REMOTE_MARK);
        }),
      ),
  ));

it.each([
  {
    label: "a null pinned head",
    head: (pushes: number) => (pushes === 0 ? undefined : headAt(pushes)),
    model: MODEL,
    laterRemote: true,
  },
  {
    label: "a pinned head that is not a full SHA",
    head: (pushes: number) => (pushes === 0 ? "abc1234" : headAt(pushes)),
    model: MODEL,
    laterRemote: true,
  },
  { label: "a null model", head: headAt, model: null, laterRemote: false },
])("T5 a round with $label runs here as revision 9", ({ head, model, laterRemote }) =>
  withWorld(
    scenario((turn) => (turn.origin.step === "review/0" ? report([MAJOR], null) : undefined), {
      head,
    }),
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.localRound")(function* (workflows) {
          const { runId } = yield* start(workflows, {
            model,
            global: { protectedPaths: ["src/**"], fixRounds: 1, askMerge: true },
            readOnlyOn: READ_ONLY_ON,
          });
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "approve-merge");
          const attempts = world.startAttempts.filter((turn) => turn.origin.runId === child.runId);
          const roundZero = attempts.filter((turn) =>
            /^(?:scope|review|disprove)\/0(?:\/defects)?$/.test(turn.origin.step),
          );
          expect(roundZero.map((turn) => turn.origin.step)).toContain("review/0");
          for (const turn of roundZero) {
            expect(turn.environment, turn.origin.step).toBeUndefined();
            expect(turn.project, turn.origin.step).toBe(PROJECT);
            expect(turn.prompt).not.toContain(REMOTE_MARK);
            expect(turn.prompt).not.toContain(SCOPE_MARK);
          }
          const names = (yield* stepsOf(workflows, child.runId)).map((step) => step.name);
          const machinePlace = names.findIndex((name) => name.startsWith("@pool:factory-env:"));
          const review = onlyLaunch(attempts, child.runId, "review/1");
          if (laterRemote) {
            // No machine place before round 1 pinned its full SHA.
            expect(machinePlace === -1 || machinePlace > names.indexOf("risk-pr/1")).toBe(true);
            expect(review.environment).toBe(E);
            expect(review.launch).toEqual(remoteLaunch(headAt(1)));
            expect(review.prompt.split("\n")).toContain(remoteLineOf(headAt(1)));
          } else {
            expect(machinePlace).toBe(-1);
            expect(attempts.filter((turn) => turn.environment !== undefined)).toEqual([]);
            expect(review.prompt).not.toContain(REMOTE_MARK);
          }
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Hold" }, PERSON);
          expect(yield* world.ended(workflows, child.runId)).toMatchObject({
            status: "stopped",
            detail: "merge held",
          });
          yield* world.ended(workflows, runId);
        }),
      ),
  ),
);

it("T8 a remote review/0 that reports no head makes the round stale and reviews again as 0/again", () =>
  withWorld(
    scenario((turn) => (turn.origin.step === "review/0" ? report([], null) : undefined)),
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.nullHeadOnce")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          const part = yield* world.ended(workflows, child.runId, true);
          expect(part).toMatchObject({ status: "completed", result: { outcome: "merged" } });
          expect(yield* roundAt(workflows, "0")).toMatchObject({ head: H, verdict: "stale" });
          expect(yield* roundAt(workflows, "0/again")).toMatchObject({
            head: H,
            verdict: "approve",
          });
          const again = onlyLaunch(world.startAttempts, child.runId, "review/0/again");
          expect(again.environment).toBe(E);
          expect(again.launch).toEqual(remoteLaunch(H));
        }),
      ),
  ));

it("T8 a remote review that reports no head twice asks stuck with the kept-changing problem and spends no fix round", () =>
  withWorld(
    scenario((turn) =>
      turn.origin.step === "review/0" || turn.origin.step === "review/0/again"
        ? report([], null)
        : undefined,
    ),
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.nullHeadTwice")(function* (workflows) {
          const { runId } = yield* start(workflows, {
            global: { fixRounds: 2 },
            readOnlyOn: READ_ONLY_ON,
          });
          const child = yield* world.child(workflows, runId, 0);
          const stuck = yield* asked(world, workflows, child.runId, "stuck");
          expect(JSON.stringify(stuck.request)).toContain(KEPT_CHANGING);
          const names = (yield* stepsOf(workflows, child.runId)).map((step) => step.name);
          expect(names.filter((name) => name.startsWith("fix"))).toEqual([]);
          expect(yield* roundAt(workflows, "0")).toMatchObject({ verdict: "stale" });
          expect(yield* roundAt(workflows, "0/again")).toMatchObject({ verdict: "stale" });
          yield* workflows.answer(child.runId, "stuck", { choice: "Stop" });
          expect(yield* world.ended(workflows, child.runId)).toMatchObject({
            status: "stopped",
            detail: "review did not pass",
          });
          yield* world.ended(workflows, runId);
        }),
      ),
  ));

it("T8 a remote scope/0 that reports another head makes the round stale", () =>
  withWorld(
    scenario((turn) =>
      turn.origin.step === "scope/0"
        ? { output: { report: { headSha: HEAD_9, files: ["src/part.ts"] } } }
        : undefined,
    ),
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.scopeHead")(function* (workflows) {
          const { runId } = yield* start(workflows, {
            global: { askMerge: true },
            readOnlyOn: READ_ONLY_ON,
          });
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "approve-merge");
          expect(yield* roundAt(workflows, "0")).toMatchObject({ head: H, verdict: "stale" });
          expect(yield* roundAt(workflows, "0/again")).toMatchObject({ head: H });
          expect(onlyLaunch(world.startAttempts, child.runId, "review/0/again").environment).toBe(
            E,
          );
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Hold" }, PERSON);
          yield* world.ended(workflows, runId);
        }),
      ),
  ));

it.each([
  { label: "readOnlyOn unset", readOnlyOn: undefined, model: MODEL },
  { label: "a null model", readOnlyOn: READ_ONLY_ON, model: null },
])(
  "T8 a round run here whose review reports no head is not stale ($label)",
  ({ readOnlyOn, model }) =>
    withWorld(
      scenario((turn) => (turn.origin.step === "review/0" ? report([], null) : undefined)),
      (world) =>
        world.server(
          Effect.fn("factoryPack.placement.nullHeadHere")(function* (workflows) {
            const { runId } = yield* start(workflows, {
              model,
              ...(readOnlyOn === undefined ? {} : { readOnlyOn }),
            });
            const child = yield* world.child(workflows, runId, 0);
            const part = yield* world.ended(workflows, child.runId, true);
            expect(part).toMatchObject({ status: "completed", result: { outcome: "merged" } });
            expect(onlyLaunch(world.startAttempts, child.runId, "review/0").environment).toBe(
              undefined,
            );
            expect(
              (yield* workflows.stored(`factory/v1/ledger/${TASK_ID}/`)).map((row) => row.key),
            ).toEqual([ledgerKey("0")]);
            expect(yield* roundAt(workflows, "0")).toMatchObject({ head: H, verdict: "approve" });
            const names = (yield* stepsOf(workflows, child.runId)).map((step) => step.name);
            expect(names.filter((name) => name.includes("/again"))).toEqual([]);
          }),
        ),
    ),
);

it.each([
  { label: "a stored root target", seed: { target: "root" }, reason: NEEDS_WORKTREE },
  { label: "no target row", seed: { target: "missing" }, reason: NEEDS_TARGET },
  {
    label: "a target row that does not decode",
    seed: { targetRow: { v: 1, workspace: 7 } },
    reason: NEEDS_TARGET,
  },
] as const)("T9 $label stops factory-task before any start attempt", ({ seed, reason }) =>
  withWorld(scenario(), (world) =>
    world.server(
      Effect.fn("factoryPack.placement.taskRefused")(function* (workflows) {
        const { runId } = yield* start(workflows, { ...seed, readOnlyOn: READ_ONLY_ON });
        const done = yield* world.ended(workflows, runId, true);
        expect(done).toMatchObject({ status: "stopped", detail: reason, result: null });
        expect(world.startAttempts).toEqual([]);
        expect(stepNamed(yield* stepsOf(workflows, runId), "placement").result).toStrictEqual({
          where: "refused",
          reason,
        });
        expect((yield* workflows.list()).filter((run) => run.parentRunId === runId)).toEqual([]);
      }),
    ),
  ),
);

it.each([
  { label: "a root target", change: "root", reason: NEEDS_WORKTREE },
  { label: "no target row", change: "missing", reason: NEEDS_TARGET },
] as const)(
  "T9 factory-task-part reads the stored target itself: $label stops the part though its payload says worktree",
  ({ change, reason }) =>
    withWorld({ ...scenario(), holdAgent: (turn) => turn.origin.step === "plan" }, (world) =>
      world.server(
        Effect.fn("factoryPack.placement.partRefused")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const plan = yield* world.nextTurn;
          expect(plan.origin.step).toBe("plan");
          // The task decided on a worktree before plan; that is what its part is handed.
          const taskSteps = yield* stepsOf(workflows, runId);
          expect(stepNamed(taskSteps, "placement").result).toStrictEqual(REMOTE_PLACEMENT);
          expect(JSON.stringify(stepNamed(taskSteps, "target").result)).toContain("worktree");
          if (change === "root") yield* seedTarget(workflows, PROJECT, "root");
          else yield* workflows.storeDelete(`factory/v1/target/${PROJECT}`);
          yield* world.releaseTurn(plan);
          const child = yield* world.child(workflows, runId, 0);
          const part = yield* world.ended(workflows, child.runId, true);
          expect(part).toMatchObject({ status: "stopped", detail: reason, result: null });
          expect(
            stepNamed(yield* stepsOf(workflows, child.runId), "placement").result,
          ).toStrictEqual({ where: "refused", reason });
          expect(world.startAttempts.filter((turn) => turn.origin.runId === child.runId)).toEqual(
            [],
          );
          yield* world.ended(workflows, runId, true);
        }),
      ),
    ),
);

it("T9 a task with no project reads only the global row and runs every step here", () =>
  withWorld(scenario(undefined, { noPullRequest: true }), (world) =>
    world.server(
      Effect.fn("factoryPack.placement.scratch")(function* (workflows) {
        yield* seedTask(workflows, { projectId: null });
        yield* workflows.storeSet(`factory/v1/config/${PROJECT}`, {
          v: 1,
          readOnlyOn: READ_ONLY_ON,
        });
        yield* workflows.storeSet("factory/v1/target/scratch", {
          v: 1,
          projectId: SCRATCH_PROJECT,
          workspace: "scratch",
          workspaceRoot: "/tmp/scratch",
          problem: null,
          checkedAt: AT,
        });
        const { runId } = yield* launchTask(workflows, { projectId: null });
        const child = yield* world.child(workflows, runId, 0);
        yield* asked(world, workflows, child.runId, "accept");
        yield* workflows.answer(child.runId, "accept", { choice: "Accept" });
        expect(yield* world.ended(workflows, child.runId)).toMatchObject({
          status: "completed",
          result: { outcome: "accepted" },
        });
        yield* world.ended(workflows, runId);
        expect(
          world.startAttempts.map((turn) => [turn.origin.step, turn.project, turn.environment]),
        ).toEqual([
          ["plan", SCRATCH_PROJECT, undefined],
          ["do", SCRATCH_PROJECT, undefined],
        ]);
        for (const id of [runId, child.runId]) {
          expect((yield* stepsOf(workflows, id)).map((step) => step.name)).not.toContain(
            "placement",
          );
        }
        expect(stepNamed(yield* stepsOf(workflows, runId), "config").result).toStrictEqual(
          configOf(),
        );
      }),
    ),
  ));

it.each([
  { label: "a readOnlyOn", row: { v: 1, readOnlyOn: READ_ONLY_ON }, projectId: PROJECT },
  { label: "a malformed readOnlyOn", row: { v: 1, readOnlyOn: E }, projectId: PROJECT },
  {
    label: "a readOnlyOn beside a field that does not decode",
    row: { v: 1, concurrency: 9, readOnlyOn: { environment: "" } },
    projectId: PROJECT,
  },
  {
    label: "a readOnlyOn, for a task with no project",
    row: { v: 1, readOnlyOn: READ_ONLY_ON },
    projectId: null,
  },
])(
  "T10 $label in factory/v1/config fails config with GLOBAL_ROW_REFUSED and starts no agent",
  ({ row, projectId }) =>
    withWorld(scenario(), (world) =>
      world.server(
        Effect.fn("factoryPack.placement.globalRow")(function* (workflows) {
          const { runId } = yield* start(workflows, { globalRow: row, projectId });
          const run = yield* settled(workflows, runId);
          expect(run.status).toBe("paused");
          expect(run.detail).toContain(GLOBAL_ROW_REFUSED);
          expect(stepNamed(yield* stepsOf(workflows, runId), "config")).toMatchObject({
            status: "failed",
            detail: GLOBAL_ROW_REFUSED,
          });
          expect(world.startAttempts).toEqual([]);
        }),
      ),
    ),
);

it.each([
  { label: "in factory/v1/config", seed: { global: { readOnlyOn: null } } },
  { label: "in the project row", seed: { readOnlyOn: null } },
] as const)("T10 a null readOnlyOn $label behaves as unset", ({ seed }) =>
  withWorld(scenario(), (world) =>
    world.server(
      Effect.fn("factoryPack.placement.nullRow")(function* (workflows) {
        const { runId } = yield* start(workflows, seed);
        const child = yield* world.child(workflows, runId, 0);
        expect(yield* world.ended(workflows, child.runId, true)).toMatchObject({
          status: "completed",
          result: { outcome: "merged" },
        });
        yield* world.ended(workflows, runId, true);
        expect(world.startAttempts.filter((turn) => turn.environment !== undefined)).toEqual([]);
        for (const id of [runId, child.runId]) {
          expect((yield* stepsOf(workflows, id)).map((step) => step.name)).not.toContain(
            "placement",
          );
        }
        expect(stepNamed(yield* stepsOf(workflows, runId), "config").result).toStrictEqual(
          configOf(),
        );
      }),
    ),
  ),
);

const BAD_READ_ONLY_ON: ReadonlyArray<{ readonly label: string; readonly value: Schema.Json }> = [
  { label: "not an object", value: E },
  { label: "a list", value: [E, RP, 2] },
  { label: "no environment", value: { project: RP, limit: 2 } },
  { label: "no project", value: { environment: E, limit: 2 } },
  { label: "no limit", value: { environment: E, project: RP } },
  { label: "a blank environment", value: { ...READ_ONLY_ON, environment: "" } },
  { label: "a whitespace environment", value: { ...READ_ONLY_ON, environment: "   " } },
  { label: "a padded environment", value: { ...READ_ONLY_ON, environment: ` ${E} ` } },
  {
    label: "a 201-character environment",
    value: { ...READ_ONLY_ON, environment: "e".repeat(201) },
  },
  { label: "project /srv/app", value: { ...READ_ONLY_ON, project: "/srv/app" } },
  { label: "project C:\\app", value: { ...READ_ONLY_ON, project: "C:\\app" } },
  { label: "project c:/app", value: { ...READ_ONLY_ON, project: "c:/app" } },
  { label: "limit 0", value: { ...READ_ONLY_ON, limit: 0 } },
  { label: "limit 5", value: { ...READ_ONLY_ON, limit: 5 } },
  { label: "limit 1.5", value: { ...READ_ONLY_ON, limit: 1.5 } },
];

it.each(BAD_READ_ONLY_ON)(
  "T10 a project row readOnlyOn with $label fails config naming factory/v1/config/<projectId>",
  ({ value }) =>
    withWorld(scenario(), (world) =>
      world.server(
        Effect.fn("factoryPack.placement.badRow")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: value });
          const run = yield* settled(workflows, runId);
          expect(run.status).toBe("paused");
          const config = stepNamed(yield* stepsOf(workflows, runId), "config");
          expect(config.status).toBe("failed");
          expect(config.detail).toContain(`factory/v1/config/${PROJECT}`);
          expect(world.startAttempts).toEqual([]);
        }),
      ),
    ),
);

const nextOnE = Effect.fn("factoryPack.placement.nextOnE")(function* (world: World) {
  for (;;) {
    const turn = yield* world.nextTurn;
    if (turn.environment === E) return turn;
  }
});

// Two tasks of two projects whose rows both name E, each with one part.
const twoTasks = Effect.fn("factoryPack.placement.twoTasks")(function* (
  world: World,
  workflows: Service,
  limit: number,
) {
  const first = yield* start(workflows, { readOnlyOn: { environment: E, project: RP, limit } });
  const second = yield* start(workflows, {
    taskId: OTHER_TASK_ID,
    number: 10,
    projectId: OTHER_PROJECT,
    readOnlyOn: { environment: E, project: OTHER_RP, limit },
  });
  return [
    { part: yield* world.child(workflows, first.runId, 0), remoteProject: RP },
    { part: yield* world.child(workflows, second.runId, 0), remoteProject: OTHER_RP },
  ] as const;
});

it("T11 with limit 1 one turn at a time is admitted to E across two projects, and a lost watch gives its place back", () => {
  const lost = "The watch on the linked environment was lost.";
  let lostKey: string | undefined;
  return withWorld(
    {
      ...scenario(),
      holdAgent: (turn) => turn.environment === E,
      // The first review/0 turn to be read loses its watch once; the turn stays active.
      resultError: (turn, read) => {
        if (turn.origin.step !== "review/0") return undefined;
        lostKey ??= turn.key;
        return turn.key === lostKey && read === 0 ? lost : undefined;
      },
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.limitOne")(function* (workflows) {
          const tasks = yield* twoTasks(world, workflows, 1);
          const first = yield* nextOnE(world);
          expect(first.origin.step).toBe("scope/0");
          const holder = tasks.find((task) => task.part.runId === first.origin.runId);
          const other = tasks.find((task) => task.part.runId !== first.origin.runId);
          if (holder === undefined || other === undefined) throw new Error("Expected two parts");
          const waiting = yield* workflows.waitFor(
            other.part.runId,
            (run) =>
              run.detail === QUEUED ||
              /^agent (?:scope|review)\//.test(run.detail ?? "") ||
              run.status === "paused" ||
              run.endedAt !== null,
          );
          expect(waiting).toMatchObject({ status: "waiting", detail: QUEUED });
          expect(world.turns.filter((turn) => turn.environment === E)).toEqual([first]);
          yield* world.releaseTurn(first);
          const second = yield* nextOnE(world);
          expect(second.origin).toMatchObject({ runId: other.part.runId, step: "scope/0" });
          const behind = yield* workflows.waitFor(
            holder.part.runId,
            (run) =>
              run.detail === QUEUED ||
              run.detail === "agent review/0" ||
              run.status === "paused" ||
              run.endedAt !== null,
          );
          expect(behind).toMatchObject({ status: "waiting", detail: QUEUED });
          yield* world.releaseTurn(second);
          const review = yield* nextOnE(world);
          expect(review.origin).toMatchObject({ runId: holder.part.runId, step: "review/0" });
          const paused = yield* settled(workflows, holder.part.runId);
          expect(paused.status).toBe("paused");
          expect(paused.detail).toContain(lost);
          const next = yield* nextOnE(world);
          expect(next.origin).toMatchObject({ runId: other.part.runId, step: "review/0" });
          // Counted when `next` started: the holder's review/0 was never stopped.
          expect(world.activeCounts[world.turns.indexOf(next)]).toBe(2);
          expect(world.interrupts).toEqual([]);
          for (const turn of world.turns.filter((entry) => entry.environment === E)) {
            const task = tasks.find((entry) => entry.part.runId === turn.origin.runId);
            expect(turn.project).toBe(task?.remoteProject);
          }
        }),
      ),
  );
});

it("T11 with limit 2 two turns of two projects are admitted to E at once", () =>
  withWorld({ ...scenario(), holdAgent: (turn) => turn.environment === E }, (world) =>
    world.server(
      Effect.fn("factoryPack.placement.limitTwo")(function* (workflows) {
        const tasks = yield* twoTasks(world, workflows, 2);
        const first = yield* nextOnE(world);
        const other = tasks.find((task) => task.part.runId !== first.origin.runId);
        if (other === undefined) throw new Error("Expected a second part");
        const admitted = yield* workflows.waitFor(
          other.part.runId,
          (run) =>
            run.detail === QUEUED ||
            run.detail === "agent scope/0" ||
            run.status === "paused" ||
            run.endedAt !== null,
        );
        expect(admitted).toMatchObject({ status: "waiting", detail: "agent scope/0" });
        const second = yield* nextOnE(world);
        expect(second.origin).toMatchObject({ runId: other.part.runId, step: "scope/0" });
        expect(world.activeCounts[world.turns.indexOf(second)]).toBe(2);
      }),
    ),
  ));

it("T12 with concurrency 1 and limit 2 a remote step still holds its task place", () =>
  withWorld(
    {
      ...scenario(undefined, { parts: [PART, SECOND_PART] }),
      holdAgent: (turn) => turn.origin.step !== "plan",
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.taskPlace")(function* (workflows) {
          const { runId } = yield* start(workflows, {
            global: { concurrency: 1 },
            readOnlyOn: READ_ONLY_ON,
          });
          expect((yield* world.nextTurn).origin.step).toBe("plan");
          const children = yield* Effect.forEach(
            [0, 1],
            (index) => world.child(workflows, runId, index),
            {
              concurrency: "unbounded",
            },
          );
          const queued = `queue factory-task:${TASK_ID}`;
          let remote = 0;
          // Each part: do here, then scope/0 and review/0 on E.
          for (let index = 0; index < 6; index++) {
            const turn = yield* world.nextTurn;
            expect(["do", "scope/0", "review/0"]).toContain(turn.origin.step);
            if (turn.environment === E) remote++;
            const sibling = children.find((child) => child.runId !== turn.origin.runId);
            if (sibling === undefined) throw new Error("Expected another part");
            const seen = yield* workflows.waitFor(
              sibling.runId,
              (run) =>
                run.detail === queued ||
                run.status === "paused" ||
                run.endedAt !== null ||
                world.activeCounts.some((count) => count > 1),
            );
            expect(seen.status).not.toBe("paused");
            if (seen.endedAt === null) expect(seen.detail).toBe(queued);
            expect(Math.max(...world.activeCounts)).toBe(1);
            yield* world.releaseTurn(turn);
          }
          expect(remote).toBe(4);
          expect((yield* world.ended(workflows, runId, true)).status).toBe("completed");
          expect(Math.max(...world.activeCounts)).toBe(1);
        }),
      ),
  ));

it("T13 a review/0 that cannot start on E pauses to resume by itself, and a resume starts it there under the same key", () => {
  const refused = `Environment ${E} refused t3_thread_launch: invalid_request: not linked`;
  let refusing = true;
  return withWorld(
    {
      ...scenario(),
      startError: (turn) => (refusing && turn.origin.step === "review/0" ? refused : undefined),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.reviewRefused")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          const paused = yield* settled(workflows, child.runId);
          expect(paused.status).toBe("paused");
          expect(paused.detail).toContain(refused);
          expect(paused.resumesAt).not.toBeNull();
          refusing = false;
          yield* workflows.resume(child.runId);
          expect(yield* world.ended(workflows, child.runId, true)).toMatchObject({
            status: "completed",
            result: { outcome: "merged" },
          });
          const attempts = launches(world.startAttempts, child.runId, "review/0");
          expect(attempts.length).toBeGreaterThanOrEqual(2);
          expect(new Set(attempts.map((turn) => turn.key)).size).toBe(1);
          for (const turn of attempts) {
            expect(turn.environment).toBe(E);
            expect(turn.project).toBe(RP);
            expect(turn.launch).toEqual(remoteLaunch(H));
          }
          expect(
            world.turns
              .filter((turn) => turn.origin.step === "review/0")
              .map((turn) => turn.environment),
          ).toEqual([E]);
          expect(
            world.startAttempts.filter(
              (turn) => remoteSteps.test(turn.origin.step) && turn.environment !== E,
            ),
          ).toEqual([]);
        }),
      ),
  );
});

it("T14 a scope/0 that cannot start on E fails without a pause, runs nowhere else, and makes the tier high", () => {
  const refused = `Environment ${E} refused t3_thread_launch: Base ref "${H}" does not resolve to a commit`;
  return withWorld(
    {
      ...scenario(),
      startError: (turn) => (turn.origin.step === "scope/0" ? refused : undefined),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.scopeRefused")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          // `question` fails if the part paused on the way.
          const question = yield* asked(world, workflows, child.runId, "approve-merge");
          const { riskTier, riskReasons } = decodeRisk(question.request).data;
          expect(riskTier).toBe("high");
          expect(
            riskReasons.filter((reason) =>
              reason.startsWith(
                "the changed files could not be listed: the agent could not be started:",
              ),
            ),
          ).toHaveLength(1);
          expect((yield* workflows.get(child.runId)).run.pauses).toBe(0);
          const scopes = launches(world.startAttempts, child.runId, "scope/0");
          expect(scopes.map((turn) => turn.environment)).toEqual([E]);
          expect(world.turns.filter((turn) => turn.origin.step === "scope/0")).toEqual([]);
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Hold" }, PERSON);
          yield* world.ended(workflows, runId);
        }),
      ),
  );
});

it("T15 a lost result read of review/0 pauses the part, and a resume takes the same turn's result", () => {
  const lost = "The link to the linked environment dropped mid-turn.";
  return withWorld(
    {
      ...scenario(),
      resultError: (turn, read) =>
        turn.origin.step === "review/0" && read === 0 ? lost : undefined,
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.lostRead")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          const paused = yield* settled(workflows, child.runId);
          expect(paused.status).toBe("paused");
          expect(paused.detail).toContain(lost);
          expect(paused.resumesAt).not.toBeNull();
          yield* workflows.resume(child.runId);
          expect(yield* world.ended(workflows, child.runId, true)).toMatchObject({
            status: "completed",
            result: { outcome: "merged" },
          });
          const review = onlyLaunch(world.startAttempts, child.runId, "review/0");
          expect(review.environment).toBe(E);
          expect(world.turns.filter((turn) => turn.origin.step === "review/0")).toEqual([review]);
          expect(stepNamed(yield* stepsOf(workflows, child.runId), "review/0")).toMatchObject({
            status: "completed",
            threadId: `thread-${review.key}`,
            environmentId: E,
          });
        }),
      ),
  );
});

it.each([
  {
    label: "an acknowledged stop pauses for a person",
    interrupt: "stopped",
    resumes: false,
    detail: "was not done after",
  },
  {
    label: "a failed stop pauses to resume by itself",
    interrupt: { error: STOP_FAILED },
    resumes: true,
    detail: STOP_FAILED,
  },
] as const)(
  "T16 a resume after review/0's time is up asks E to stop that turn: $label",
  ({ interrupt, resumes, detail }) => {
    const lost = "The link to the linked environment dropped mid-turn.";
    return withWorld(
      {
        ...scenario(),
        holdAgent: (turn) => turn.origin.step === "review/0",
        resultError: (turn, read) =>
          turn.origin.step === "review/0" && read === 0 ? lost : undefined,
        interrupt: () => (typeof interrupt === "string" ? interrupt : { error: interrupt.error }),
      },
      (world) =>
        world.server(
          Effect.fn("factoryPack.placement.timeUp")(function* (workflows) {
            // AMBIGUOUS: the contract gives no way to let the time run out without waiting; read as a
            // step timeout of one millisecond, which every unheld turn beats and the held one cannot.
            const { runId } = yield* start(workflows, {
              global: { stepTimeout: "1 millis" },
              readOnlyOn: READ_ONLY_ON,
            });
            const child = yield* world.child(workflows, runId, 0);
            const first = yield* settled(workflows, child.runId);
            expect(first.status).toBe("paused");
            expect(first.detail).toContain(lost);
            expect(world.interrupts).toEqual([]);
            yield* workflows.resume(child.runId);
            const second = yield* workflows.waitFor(
              child.runId,
              (run) =>
                (run.status === "paused" && run.detail !== first.detail) || run.endedAt !== null,
            );
            expect(second.status).toBe("paused");
            expect(second.detail).toContain(detail);
            expect(second.resumesAt !== null).toBe(resumes);
            const review = onlyLaunch(world.startAttempts, child.runId, "review/0");
            expect(world.interrupts.length).toBeGreaterThan(0);
            for (const target of world.interrupts) {
              expect(target).toEqual({
                threadId: `thread-${review.key}`,
                environment: E,
                turnId: review.key,
              });
            }
            expect(world.turns.filter((turn) => turn.origin.step === "review/0")).toEqual([review]);
          }),
        ),
    );
  },
);

it("T17 a review/0 turn reported dead on E is replaced once there with the same options after an acknowledged stop", () =>
  withWorld(
    {
      ...scenario((turn) =>
        turn.origin.step === "review/0" && firstRound(turn) ? DEAD : undefined,
      ),
      interrupt: () => "stopped" as const,
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.replaced")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          expect(yield* world.ended(workflows, child.runId, true)).toMatchObject({
            status: "completed",
            result: { outcome: "merged" },
          });
          const [first, replacement, ...more] = launches(
            world.startAttempts,
            child.runId,
            "review/0",
          );
          expect(more).toEqual([]);
          if (first === undefined || replacement === undefined) {
            throw new Error("Expected a replacement launch");
          }
          expect(first.environment).toBe(E);
          expect(replacement.key).not.toBe(first.key);
          expect(optionsOf(replacement, [])).toEqual(optionsOf(first, []));
          expect(world.interrupts).toEqual([
            { threadId: `thread-${first.key}`, environment: E, turnId: first.key },
          ]);
          expect(
            world.startAttempts.filter(
              (turn) => remoteSteps.test(turn.origin.step) && turn.environment !== E,
            ),
          ).toEqual([]);
        }),
      ),
  ));

it("T17 a second death of review/0 on E leaves the part paused for a person", () =>
  withWorld(
    scenario((turn) => (turn.origin.step === "review/0" ? DEAD : undefined)),
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.diedTwice")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          const paused = yield* settled(workflows, child.runId);
          expect(paused).toMatchObject({ status: "paused", resumesAt: null });
          expect(
            launches(world.startAttempts, child.runId, "review/0").map((turn) => turn.environment),
          ).toEqual([E, E]);
          expect(
            world.startAttempts.filter(
              (turn) => remoteSteps.test(turn.origin.step) && turn.environment !== E,
            ),
          ).toEqual([]);
        }),
      ),
  ));

it("T17 a stop that fails after review/0 died pauses the part to resume by itself, with no replacement", () =>
  withWorld(
    {
      ...scenario((turn) => (turn.origin.step === "review/0" ? DEAD : undefined)),
      interrupt: () => ({ error: STOP_FAILED }),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.stopFailed")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          const paused = yield* settled(workflows, child.runId);
          expect(paused.status).toBe("paused");
          expect(paused.resumesAt).not.toBeNull();
          const review = onlyLaunch(world.startAttempts, child.runId, "review/0");
          expect(review.environment).toBe(E);
          expect(world.interrupts.length).toBeGreaterThan(0);
          for (const target of world.interrupts) expect(target.environment).toBe(E);
        }),
      ),
  ));

it("T18 a lost read of scope/0 with an acknowledged stop gives exactly one more scope/0 turn, on E", () =>
  withWorld(
    {
      ...scenario(),
      resultError: (turn, read) =>
        turn.origin.step === "scope/0" && firstRound(turn) && read === 0
          ? "The link dropped while scope/0 ran."
          : undefined,
      interrupt: () => "stopped" as const,
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.scopeReplaced")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          expect(yield* world.ended(workflows, child.runId, true)).toMatchObject({
            status: "completed",
            result: { outcome: "merged" },
          });
          const scopes = launches(world.startAttempts, child.runId, "scope/0");
          expect(scopes.map((turn) => turn.environment)).toEqual([E, E]);
          const [first] = scopes;
          expect(world.interrupts).toEqual([
            { threadId: `thread-${first?.key}`, environment: E, turnId: first?.key },
          ]);
        }),
      ),
  ));

it("T18 a lost read of scope/0 whose stop fails gives no other scope/0 turn and a high tier", () =>
  withWorld(
    {
      ...scenario(),
      resultError: (turn, read) =>
        turn.origin.step === "scope/0" && read === 0
          ? "The link dropped while scope/0 ran."
          : undefined,
      interrupt: () => ({ error: STOP_FAILED }),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.scopeLingers")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          const question = yield* asked(world, workflows, child.runId, "approve-merge");
          const { riskTier, riskReasons } = decodeRisk(question.request).data;
          expect(riskTier).toBe("high");
          expect(
            riskReasons.filter((reason) => reason.endsWith("its turn could not be stopped")),
          ).toHaveLength(1);
          expect(
            launches(world.startAttempts, child.runId, "scope/0").map((turn) => turn.environment),
          ).toEqual([E]);
          for (const target of world.interrupts) expect(target.environment).toBe(E);
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Hold" }, PERSON);
          yield* world.ended(workflows, runId);
        }),
      ),
  ));

it("T19 step rows show where each agent ran, and placement and config hold what X2 and X1 say", () =>
  withWorld(
    scenario((turn) =>
      turn.origin.step === "review/0" ? report([MAJOR], baseRefOf(turn) ?? null) : undefined,
    ),
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.rows")(function* (workflows) {
          const global = { protectedPaths: ["src/**"], fixRounds: 1 };
          const { runId } = yield* start(workflows, { global, readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "approve-merge");
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Merge" }, PERSON);
          yield* world.ended(workflows, child.runId);
          yield* world.ended(workflows, runId);
          const taskSteps = yield* stepsOf(workflows, runId);
          const partSteps = yield* stepsOf(workflows, child.runId);
          for (const step of ["scope/0", "review/0", "review/0/defects", "scope/1", "review/1"]) {
            const turn = onlyLaunch(world.startAttempts, child.runId, step);
            expect(stepNamed(partSteps, step), step).toMatchObject({
              threadId: `thread-${turn.key}`,
              environmentId: E,
            });
          }
          for (const [steps, step] of [
            [taskSteps, "plan"],
            [partSteps, "do"],
            [partSteps, "disprove/0"],
            [partSteps, "fix/0"],
          ] as const) {
            expect(stepNamed(steps, step), step).toMatchObject({
              threadId: expect.any(String),
              environmentId: null,
            });
          }
          expect(stepNamed(taskSteps, "placement").result).toStrictEqual(REMOTE_PLACEMENT);
          expect(stepNamed(partSteps, "placement").result).toStrictEqual(REMOTE_PLACEMENT);
          expect(stepNamed(taskSteps, "config").result).toStrictEqual(
            configOf(global, READ_ONLY_ON),
          );
          for (const { key } of yield* workflows.stored("factory/v1/")) {
            expect(key).toMatch(REVISION_9_KEY);
          }
        }),
      ),
  ));

it("T19 after a replacement the review/0 row holds the replacement's thread on E", () =>
  withWorld(
    scenario((turn) => (turn.origin.step === "review/0" && firstRound(turn) ? DEAD : undefined)),
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.replacedRow")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          yield* world.ended(workflows, child.runId, true);
          const [, replacement] = launches(world.startAttempts, child.runId, "review/0");
          expect(replacement).toBeDefined();
          expect(stepNamed(yield* stepsOf(workflows, child.runId), "review/0")).toMatchObject({
            threadId: `thread-${replacement?.key}`,
            environmentId: E,
          });
        }),
      ),
  ));

it("T19 a remote step whose launch was never acknowledged has no thread and no environment", () =>
  withWorld(
    {
      ...scenario(),
      startError: (turn) =>
        turn.origin.step === "scope/0"
          ? `Environment ${E} refused t3_thread_launch: not linked`
          : undefined,
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.placement.neverAcknowledged")(function* (workflows) {
          const { runId } = yield* start(workflows, { readOnlyOn: READ_ONLY_ON });
          const child = yield* world.child(workflows, runId, 0);
          yield* asked(world, workflows, child.runId, "approve-merge");
          expect(stepNamed(yield* stepsOf(workflows, child.runId), "scope/0")).toMatchObject({
            threadId: null,
            environmentId: null,
          });
          yield* workflows.answer(child.runId, "approve-merge", { choice: "Hold" }, PERSON);
          yield* world.ended(workflows, runId);
        }),
      ),
  ));

it("T20 both task workflows are registered at version 5 only, and factory-start runs version 5", () =>
  withWorld(scenario(), (world) =>
    world.server(
      Effect.fn("factoryPack.placement.versions")(function* (workflows) {
        for (const name of ["factory-task", "factory-task-part"]) {
          expect(
            world.definitions
              .filter((definition) => definition.name === name)
              .map((definition) => definition.version),
          ).toEqual([5]);
        }
        yield* seedTask(workflows, { global: { askPlan: true } });
        const started = yield* workflows.start(
          "factory-start",
          { taskId: TASK_ID },
          { idempotencyKey: "start-version" },
        );
        const { runId } = decodeStarted((yield* world.ended(workflows, started.runId)).result);
        expect((yield* workflows.get(runId)).run).toMatchObject({
          workflow: "factory-task",
          version: 5,
        });
        yield* asked(world, workflows, runId, "approve-plan");
        yield* workflows.answer(runId, "approve-plan", { choice: "Drop" });
        expect((yield* world.ended(workflows, runId)).status).toBe("stopped");
      }),
    ),
  ));

it.each(["worktree", "root", "scratch", null] as const)(
  "T20 placementFor with readOnlyOn undefined and workspace %s is local",
  (workspace) => {
    expect(placementFor(undefined, workspace)).toStrictEqual({ where: "local" });
  },
);

it.each([
  { workspace: "worktree", expected: REMOTE_PLACEMENT },
  { workspace: "root", expected: { where: "refused", reason: NEEDS_WORKTREE } },
  { workspace: "scratch", expected: { where: "refused", reason: NEEDS_WORKTREE } },
  { workspace: null, expected: { where: "refused", reason: NEEDS_TARGET } },
] as const)(
  "T20 placementFor with readOnlyOn set and workspace $workspace",
  ({ workspace, expected }) => {
    expect(placementFor(READ_ONLY_ON, workspace)).toStrictEqual(expected);
  },
);

it("T20 the refusals are the contract's strings and the pool is named after the environment", () => {
  expect(REMOTE_NEEDS_WORKTREE).toBe(NEEDS_WORKTREE);
  expect(REMOTE_NEEDS_TARGET).toBe(NEEDS_TARGET);
  expect(remotePool(E)).toBe(`factory-env:${E}`);
  expect(remotePool("env 2")).toBe("factory-env:env 2");
  expect(
    placementFor({ environment: "env-b", project: "proj_b", limit: 4 }, "worktree"),
  ).toStrictEqual({
    where: "remote",
    environment: "env-b",
    project: "proj_b",
    pool: "factory-env:env-b",
    limit: 4,
  });
});

it.each([
  { value: H, expected: true },
  { value: "0123456789abcdef".repeat(4).slice(0, 40), expected: true },
  { value: "f".repeat(64), expected: true },
  { value: "a".repeat(39), expected: false },
  { value: "a".repeat(41), expected: false },
  { value: "a".repeat(63), expected: false },
  { value: "a".repeat(65), expected: false },
  { value: "A".repeat(40), expected: false },
  { value: `${"a".repeat(39)}g`, expected: false },
  { value: ` ${"a".repeat(40)}`, expected: false },
  { value: `${"a".repeat(40)}\n`, expected: false },
  { value: "abc1234", expected: false },
  { value: "sha-default", expected: false },
  { value: "", expected: false },
  { value: null, expected: false },
])("T20 isFullSha($value) is $expected", ({ value, expected }) => {
  expect(isFullSha(value)).toBe(expected);
});

it("T20 remoteLine fills in the commit", () => {
  expect(remoteLine(H)).toBe(remoteLineOf(H));
  expect(remoteLine(HEAD_9)).toBe(remoteLineOf(HEAD_9));
});

// F2 fills the remote base with origin/ and the host's literal branch name.
it.each([
  { baseBranch: "main", remoteBase: "origin/main" },
  { baseBranch: "release", remoteBase: "origin/release" },
  { baseBranch: "refs/heads/release", remoteBase: "origin/refs/heads/release" },
  { baseBranch: "origin/feature/x", remoteBase: "origin/origin/feature/x" },
] as const)(
  "T20 remoteScopeBase($baseBranch) diffs against $remoteBase",
  ({ baseBranch, remoteBase }) => {
    expect(remoteScopeBase(baseBranch)).toBe(scopeLineOf(remoteBase));
  },
);

it.each([
  { value: "/srv/app", expected: true },
  { value: "/", expected: true },
  { value: "C:\\app", expected: true },
  { value: "c:/app", expected: true },
  { value: "C:", expected: true },
  { value: "z:\\", expected: true },
  { value: "proj_1", expected: false },
  { value: "a/b", expected: false },
  { value: "\\\\host\\share", expected: false },
  { value: "C:app", expected: false },
  { value: "1:/app", expected: false },
  { value: " /srv/app", expected: false },
  { value: "", expected: false },
  { value: RP, expected: false },
])(
  "T20 namesFolder($value) is $expected and agrees with the engine's isProjectPath",
  ({ value, expected }) => {
    expect(namesFolder(value)).toBe(expected);
    expect(namesFolder(value)).toBe(isProjectPath(value));
  },
);
