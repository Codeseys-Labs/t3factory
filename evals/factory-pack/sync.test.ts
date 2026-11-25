// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
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
  } = {},
) => ({
  pullRequests: [pullRequestAt(17)],
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

const startSync = (workflows: Service, ref = REF) =>
  workflows.start(
    "factory-sync-upstream",
    { projectId: PROJECT, ref },
    { idempotencyKey: `sync/${ref}` },
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
        expect(turn?.prompt).toContain(`POSIX shell (bash, zsh, sh): '${REF}'`);
        expect(turn?.prompt).toContain("`git merge <ref>`");
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

effectIt.effect.each(["own", "foreign", "unreadable"] as const)(
  "P2a sync reads an unlisted pull request: %s",
  (ownership) =>
    Effect.promise(() => {
      const answers = script();
      const foreignUrl = "https://github.com/other/repository/pull/17";
      const reportedUrl = ownership === "foreign" ? foreignUrl : PR_URL;
      const canonicalUrl = "https://github.com/Factory/Pack/pull/17";
      return withWorld(
        {
          ...answers,
          pullRequests: [pullRequestAt(99)],
          agent: (turn) => ({
            ...answers.agent(turn),
            output: { ...SYNCED, prUrl: reportedUrl },
          }),
          readPullRequest: Effect.fn("factoryPack.test.syncReadUnlisted")(
            function* (_address, detail) {
              if (ownership === "unreadable") {
                return yield* new WorkflowForge.WorkflowForgeError({
                  reason: "Pull request read failed",
                });
              }
              return {
                ...detail,
                number: 17,
                repository: ownership === "foreign" ? "other/repository" : "factory/pack",
                url: ownership === "foreign" ? foreignUrl : canonicalUrl,
              };
            },
          ),
        },
        (world) =>
          world.server(
            Effect.fn("factoryPack.test.syncOwnership")(function* (workflows) {
              const { runId } = yield* startSync(workflows);
              if (ownership === "own") {
                const question = yield* world.question(workflows, runId);
                expect(question).toMatchObject({ name: "approve-merge", kind: "merge" });
                expect(question.request).toMatchObject({
                  title: "Merge the upstream sync?",
                  choices: ["Merge", "Hold"],
                  data: { ...SYNCED, prUrl: canonicalUrl, ref: REF },
                });
                expect(world.acts).toEqual([]);
                yield* workflows.answer(runId, question.name, { choice: "Merge" });
              }
              const done = yield* world.ended(workflows, runId, ownership !== "own");
              const { steps } = yield* workflows.get(runId);
              expect(world.pullRequestQueries).toHaveLength(1);
              expect(world.pullRequestQueries[0]).toMatchObject({ project: PROJECT, state: "all" });
              expect(world.turns.map((turn) => turn.origin.step)).toEqual(["sync"]);
              expect(world.turns[0]?.thread).toBeUndefined();
              if (ownership === "own") {
                expect(done).toMatchObject({
                  status: "completed",
                  result: { prUrl: canonicalUrl },
                });
                expect(done.tags?.at(-1)).toBe("stage:done");
                expect(world.readCalls).toEqual([
                  { project: PROJECT, url: reportedUrl },
                  { project: PROJECT, url: canonicalUrl },
                  { project: PROJECT, url: canonicalUrl },
                  { project: PROJECT, url: canonicalUrl },
                ]);
                expect(steps.find((step) => step.name === "checks/0")?.result).toMatchObject({
                  url: canonicalUrl,
                  checks: "passing",
                });
                expect(world.acts).toEqual([
                  [{ project: PROJECT, url: canonicalUrl }, "merge", { mergeMethod: "merge" }],
                ]);
                expect(world.questions.map(({ name, kind }) => [name, kind])).toEqual([
                  ["approve-merge", "merge"],
                ]);
              } else {
                expect(done).toMatchObject({
                  status: "stopped",
                  detail: "pull request is not this project's",
                  result: null,
                });
                expect(steps.filter((step) => step.kind === "wait")).toEqual([]);
                expect(world.readCalls).toEqual([{ project: PROJECT, url: reportedUrl }]);
                expect(world.questions).toEqual([]);
                expect(world.acts).toEqual([]);
              }
            }),
          ),
      );
    }),
);

it("P2a sync reads an unlisted pull request through a lowercase GitHub URL", () => {
  const answers = script();
  const reportedUrl = PR_URL.toUpperCase();
  const canonicalUrl = "https://github.com/Factory/Pack/pull/17";
  return withWorld(
    {
      ...answers,
      pullRequests: [pullRequestAt(99)],
      agent: (turn) => ({
        ...answers.agent(turn),
        output: { ...SYNCED, prUrl: reportedUrl },
      }),
      readPullRequest: (_address, detail) =>
        Effect.succeed({ ...detail, number: 17, repository: "factory/pack", url: canonicalUrl }),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.test.syncUppercaseUnlisted")(function* (workflows) {
          const { runId } = yield* startSync(workflows);
          const question = yield* world.question(workflows, runId);
          expect(question.request).toMatchObject({
            data: { ...SYNCED, prUrl: canonicalUrl, ref: REF },
          });
          yield* workflows.answer(runId, question.name, { choice: "Merge" });
          const done = yield* world.ended(workflows, runId);
          expect(done).toMatchObject({ status: "completed", result: { prUrl: canonicalUrl } });
          const [fallback, ...rest] = world.readCalls;
          expect(fallback).toMatchObject({
            project: PROJECT,
            url: expect.stringMatching(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/17$/),
          });
          expect(rest.length).toBeGreaterThan(0);
          expect(rest).toEqual(rest.map(() => ({ project: PROJECT, url: canonicalUrl })));
          expect(world.acts).toEqual([
            [{ project: PROJECT, url: canonicalUrl }, "merge", { mergeMethod: "merge" }],
          ]);
        }),
      ),
  );
});

effectIt.effect.each([
  { label: "unchanged", pushed: "aaa111", merged: true },
  { label: "pushed", pushed: "bbb222", merged: false },
] as const)("H1 sync: the pull request head is $label while the merge waits", (entry) =>
  Effect.promise(() => {
    const answers = script();
    let approved = false;
    return withWorld(
      {
        ...answers,
        readPullRequest: (_address, detail) =>
          Effect.succeed({ ...detail, headSha: approved ? entry.pushed : "aaa111" }),
      },
      (world) =>
        world.server(
          Effect.fn("factoryPack.test.syncHeadBinding")(function* (workflows) {
            const { runId } = yield* startSync(workflows);
            yield* askMerge(world, workflows, runId);
            approved = true;
            yield* workflows.answer(runId, "approve-merge", { choice: "Merge" });
            const done = yield* world.ended(workflows, runId);
            if (entry.merged) {
              expect(done).toMatchObject({ status: "completed", result: { prUrl: PR_URL } });
              expect(world.acts).toEqual([
                [{ project: PROJECT, url: PR_URL }, "merge", { mergeMethod: "merge" }],
              ]);
            } else {
              expect(done).toMatchObject({
                status: "stopped",
                detail: "pull request head changed after review",
              });
              expect(world.acts).toEqual([]);
            }
          }),
        ),
    );
  }),
);

const REFS = [
  { ref: "v1", branch: "sync/upstream-v1" },
  { ref: "v1-", branch: "sync/upstream-v1-" },
  { ref: "release/v1", branch: "sync/upstream-release/v1" },
  { ref: "release-v1", branch: "sync/upstream-release-v1" },
  { ref: "release$build", branch: "sync/upstream-release%24build" },
  { ref: "nightly'oct", branch: "sync/upstream-nightly%27oct" },
  { ref: "a`b;c&d|(e)", branch: "sync/upstream-a%60b%3Bc%26d%7C%28e%29" },
  { ref: "v\u20181", branch: "sync/upstream-v%E2%80%981" },
  { ref: "feat/.x..y.lock", branch: "sync/upstream-feat/%2Ex%2E.y%2Elock" },
];

const SHELLS = [
  { name: "POSIX shell", label: "POSIX shell (bash, zsh, sh)", commands: ["sh"], args: ["-c"] },
  {
    name: "PowerShell",
    label: "PowerShell",
    commands: ["pwsh", "powershell.exe"],
    args: ["-NoProfile", "-Command"],
  },
];

it("every ref reaches the agent as one literal argument and gets a branch of its own", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-sync-"));
  try {
    const printArguments = NodePath.join(directory, "arguments.js").replaceAll("\\", "/");
    NodeFS.writeFileSync(
      printArguments,
      'console.log(Buffer.from(JSON.stringify(process.argv.slice(2))).toString("hex"));',
    );
    const shells = SHELLS.flatMap((shell) => {
      const command = shell.commands.find(
        (candidate) =>
          NodeChildProcess.spawnSync(candidate, [...shell.args, "exit 0"]).status === 0,
      );
      return command === undefined ? [] : [{ ...shell, command }];
    });
    expect(shells.length).toBeGreaterThan(0);
    await withWorld(script({ checks: REFS.map(() => "failing" as const) }), (world) =>
      world.server(
        Effect.fn("factoryPack.test.syncRef")(function* (workflows) {
          const branches = new Set<string>();
          for (const { ref, branch } of REFS) {
            const { runId } = yield* startSync(workflows, ref);
            yield* world.ended(workflows, runId, true);
            const prompt = world.turns.find((turn) => turn.origin.runId === runId)?.prompt ?? "";
            expect(prompt).toContain(`Create the branch \`${branch}\` and run \`git merge <ref>\``);
            expect(() =>
              NodeChildProcess.execFileSync("git", ["check-ref-format", `refs/heads/${branch}`]),
            ).not.toThrow();
            branches.add(branch);
            let rest = prompt.replaceAll(branch, "");
            for (const shell of shells) {
              const line = prompt.split("\n").find((entry) => entry.startsWith(`${shell.label}: `));
              const literal = line?.slice(shell.label.length + 2) ?? "";
              const out = NodeChildProcess.execFileSync(shell.command, [
                ...shell.args,
                `node '${printArguments}' ${literal}`,
              ]);
              expect({
                shell: shell.name,
                received: JSON.parse(Buffer.from(out.toString().trim(), "hex").toString()),
              }).toEqual({
                shell: shell.name,
                received: [ref],
              });
              rest = rest.replaceAll(literal, "");
            }
            if (shells.length === SHELLS.length) expect(rest).not.toContain(ref);
          }
          expect(branches.size).toBe(REFS.length);
        }),
      ),
    );
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("the brief completes the merge before it regenerates and validates", () =>
  withWorld(script({ checks: ["failing"] }), (world) =>
    world.server(
      Effect.fn("factoryPack.test.syncOrder")(function* (workflows) {
        const { runId } = yield* startSync(workflows);
        yield* world.ended(workflows, runId, true);
        const prompt = world.turns[0]?.prompt ?? "";
        const at = (text: string) => prompt.indexOf(text);
        expect(at("git commit --no-edit")).toBeGreaterThan(at("Resolve conflicts"));
        expect(at("vp build")).toBeGreaterThan(at("git commit --no-edit"));
        expect(at("factory-i18n.ts merge")).toBeGreaterThan(at("vp build"));
        expect(at("Commit everything")).toBeGreaterThan(at("vp test run"));
        expect(at("Commit everything")).toBeLessThan(at("open a pull request"));
      }),
    ),
  ));

effectIt.effect.each([
  {
    label: "a signal followed by a person",
    needsPerson: true,
    first: "signal",
    second: "session",
    merged: true,
  },
  {
    label: "two signals cannot merge",
    needsPerson: true,
    first: "signal",
    second: "signal",
    merged: false,
  },
  {
    label: "a second Hold stops",
    needsPerson: true,
    first: "signal",
    second: "hold",
    merged: false,
  },
  {
    label: "a second timeout stops",
    needsPerson: true,
    first: "signal",
    second: "timeout",
    merged: false,
  },
  {
    label: "a person answers the first question",
    needsPerson: true,
    first: "session",
    second: null,
    merged: true,
  },
  {
    label: "an ordinary merge accepts a signal",
    needsPerson: false,
    first: "signal",
    second: null,
    merged: true,
  },
] as const)("P1 sync: $label", (entry) =>
  Effect.promise(() =>
    withWorld(script(), (world) =>
      world.server(
        Effect.fn("factoryPack.test.syncPersonOnly")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", {
            v: 1,
            askMerge: !entry.needsPerson,
            mergeNeedsPerson: entry.needsPerson,
          });
          const { runId } = yield* startSync(workflows);
          const first = yield* askMerge(world, workflows, runId);
          expect(world.acts).toEqual([]);
          if (entry.first === "signal") {
            yield* workflows.signal(
              { runId, wait: first.name },
              { choice: "Merge" },
              { id: "sync-agent-first", answeredBy: "t3 workflow signal" },
            );
          } else {
            yield* workflows.answer(
              runId,
              first.name,
              { choice: "Merge" },
              { label: "Person", sessionId: "trusted-sync-session" },
            );
          }
          if (entry.second !== null) {
            const second = yield* world.question(workflows, runId);
            expect(second).toMatchObject({ name: "approve-merge/person", kind: "merge" });
            expect(second.request).toMatchObject({
              title: "Merge the upstream sync?",
              choices: ["Merge", "Hold"],
            });
            expect(world.acts).toEqual([]);
            expect(
              (yield* workflows.get(runId)).steps.find((step) => step.name === first.name)?.result,
            ).not.toHaveProperty("answeredBySession");
            if (entry.second === "timeout") {
              yield* world.expireQuestion(workflows, runId, second.name);
            } else if (entry.second === "signal") {
              yield* workflows.signal(
                { runId, wait: second.name },
                { choice: "Merge" },
                { id: "sync-agent-second", answeredBy: "t3 workflow signal" },
              );
            } else {
              yield* workflows.answer(
                runId,
                second.name,
                { choice: entry.second === "hold" ? "Hold" : "Merge" },
                { label: "Person", sessionId: "trusted-sync-session" },
              );
            }
          }
          const done = yield* world.ended(workflows, runId);
          if (entry.merged) {
            expect(done).toMatchObject({ status: "completed", result: { prUrl: PR_URL } });
            expect(world.acts).toEqual([
              [{ project: PROJECT, url: PR_URL }, "merge", { mergeMethod: "merge" }],
            ]);
            expect(done.tags?.at(-1)).toBe("stage:done");
            if (entry.needsPerson) {
              const name = entry.second === null ? first.name : "approve-merge/person";
              expect(
                (yield* workflows.get(runId)).steps.find((step) => step.name === name)?.result,
              ).toHaveProperty("answeredBySession", "trusted-sync-session");
            }
          } else {
            expect(done).toMatchObject({ status: "stopped", detail: "merge held", result: null });
            expect(world.acts).toEqual([]);
          }
          expect(world.questions.map(({ name, kind }) => [name, kind])).toEqual(
            entry.second === null
              ? [["approve-merge", "merge"]]
              : [
                  ["approve-merge", "merge"],
                  ["approve-merge/person", "merge"],
                ],
          );
          expect(world.turns.map((turn) => turn.origin.step)).toEqual(["sync"]);
        }),
      ),
    ),
  ),
);
