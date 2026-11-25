import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import * as WorkflowForge from "../../apps/server/src/workflows/WorkflowForge.ts";
import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Service = Workflows.Workflows["Service"];
const PROJECT = "project-1";
const REF = "v0.0.1-nightly";
const AT = "2026-01-01T00:00:00.000Z";
const PR_URL = "https://github.com/factory/pack/pull/17";
const decodePullRequest = Schema.decodeSync(WorkflowForge.PullRequest);

const pullRequestAt = (number: number) =>
  decodePullRequest({
    provider: "github",
    host: "github.com",
    projectId: PROJECT,
    projectTitle: "Factory",
    repository: "factory/pack",
    number,
    title: `Sync ${number}`,
    url: `https://github.com/factory/pack/pull/${number}`,
    author: null,
    headBranch: `sync-${number}`,
    baseBranch: "factory",
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

const SYNCED = {
  prUrl: PR_URL,
  summary: "Merged the nightly.",
  conflicts: ["apps/server/src/ws.ts: kept both sides' lines"],
};

const script = (
  options: {
    readonly checks?: ReadonlyArray<WorkflowForge.PullRequestStanding["checks"]>;
    readonly listed?: boolean;
  } = {},
) => ({
  pullRequests: options.listed === false ? [] : [pullRequestAt(17)],
  agent: (turn: AgentTurnInput) => {
    if (turn.origin.step !== "sync") throw new Error(`Unexpected agent step ${turn.origin.step}`);
    return { output: SYNCED };
  },
  standing: (pullRequest: WorkflowForge.PullRequestAddress, read: number) => ({
    state: "open" as const,
    checks: options.checks?.[read] ?? "passing",
    mergeability: "mergeable" as const,
    url:
      "url" in pullRequest
        ? pullRequest.url
        : `https://${pullRequest.host}/${pullRequest.repository}/pull/${pullRequest.number}`,
  }),
});

const startSync = (workflows: Service) =>
  workflows.start(
    "factory-sync-upstream",
    { projectId: PROJECT, ref: REF },
    { idempotencyKey: `sync/${REF}` },
  );

const askMerge = Effect.fn("factoryPack.test.askMerge")(function* (
  world: World,
  workflows: Service,
  runId: string,
) {
  const question = yield* world.question(workflows, runId);
  expect({ name: question.name, kind: question.kind }).toEqual({
    name: "approve-merge",
    kind: "merge",
  });
  expect(question.request).toMatchObject({
    title: "Merge the upstream sync?",
    choices: ["Merge", "Hold"],
    data: { prUrl: PR_URL, ref: REF, conflicts: SYNCED.conflicts, summary: SYNCED.summary },
  });
  return question;
});

it("an approved sync merges its pull request once, with a merge commit", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.syncMerge")(function* (workflows) {
        const { runId } = yield* startSync(workflows);
        yield* askMerge(world, workflows, runId);
        expect((yield* workflows.get(runId)).run.tags).toEqual([
          `task:sync-${runId}`,
          `project:${PROJECT}`,
          "stage:review",
        ]);
        yield* workflows.answer(runId, "approve-merge", { choice: "Merge" });
        const done = yield* world.ended(workflows, runId);
        expect(done).toMatchObject({ status: "completed", result: { prUrl: PR_URL } });
        expect(done.tags?.at(-1)).toBe("stage:done");
        expect(world.acts).toEqual([
          [{ project: PROJECT, url: PR_URL }, "merge", { mergeMethod: "merge" }],
        ]);
        expect(world.turns).toHaveLength(1);
        const turn = world.turns[0];
        expect(turn?.project).toBe(PROJECT);
        expect(turn?.launch).toMatchObject({
          workspace: { type: "worktree", baseRef: "HEAD" },
          runtimeMode: "full-access",
        });
        expect(turn?.prompt).toContain(`git merge ${REF}`);
        expect(turn?.prompt).toContain("sync/upstream-v0.0.1-nightly");
        expect(turn?.prompt).toContain("the project's default branch");
        expect(turn?.prompt).not.toContain("scripts/factory-sync.ts");
      }),
    ),
  ));

it("a held sync stops without merging", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.syncHold")(function* (workflows) {
        const { runId } = yield* startSync(workflows);
        yield* askMerge(world, workflows, runId);
        yield* workflows.answer(runId, "approve-merge", { choice: "Hold" });
        expect(yield* world.ended(workflows, runId)).toMatchObject({
          status: "stopped",
          detail: "merge held",
        });
        expect(world.acts).toEqual([]);
      }),
    ),
  ));

it("a question left unanswered holds the sync", () =>
  withWorld(script(), (world) =>
    world.server(
      Effect.fn("factoryPack.test.syncTimeout")(function* (workflows) {
        const { runId } = yield* startSync(workflows);
        yield* askMerge(world, workflows, runId);
        yield* world.expireQuestion(workflows, runId, "approve-merge");
        expect(yield* world.ended(workflows, runId)).toMatchObject({
          status: "stopped",
          detail: "merge held",
        });
        expect(world.acts).toEqual([]);
      }),
    ),
  ));

it("failing checks stop the sync before any question", () =>
  withWorld(script({ checks: ["failing"] }), (world) =>
    world.server(
      Effect.fn("factoryPack.test.syncFailing")(function* (workflows) {
        const { runId } = yield* startSync(workflows);
        expect(yield* world.ended(workflows, runId, true)).toMatchObject({
          status: "stopped",
          detail: "checks are not passing",
        });
        expect(world.questions).toEqual([]);
        expect(world.acts).toEqual([]);
      }),
    ),
  ));

it("a pull request outside the project stops the sync before its checks", () =>
  withWorld(script({ listed: false }), (world) =>
    world.server(
      Effect.fn("factoryPack.test.syncUnlisted")(function* (workflows) {
        const { runId } = yield* startSync(workflows);
        const done = yield* world.ended(workflows, runId, true);
        expect(done).toMatchObject({
          status: "stopped",
          detail: "pull request is not this project's",
        });
        const { steps } = yield* workflows.get(runId);
        expect(steps.some((step) => step.name.startsWith("checks/"))).toBe(false);
        expect(world.questions).toEqual([]);
        expect(world.reads).toEqual([]);
        expect(world.acts).toEqual([]);
      }),
    ),
  ));
