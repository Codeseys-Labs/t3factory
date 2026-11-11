import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  type FactoryTaskLane,
  type FactoryTaskRun,
  type FactoryTaskRunState,
  type FactoryTaskStatus,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import {
  checkLaneMove,
  deliveryState,
  deriveTask,
  deriveTree,
  planningRunState,
  workRunState,
  type SubtaskFacts,
  type TaskDeliveryFact,
  type TaskFacts,
  type TaskResultFact,
} from "./FactoryTaskDerivation.ts";

const at = "2026-11-10T00:00:00.000Z";
const run = (
  ordinal: number,
  state: FactoryTaskRunState,
  purpose: FactoryTaskRun["purpose"] = "work",
): FactoryTaskRun => ({
  ordinal,
  threadId: ThreadId.make(`thread-${ordinal}`),
  runId: RunId.make(`run-${ordinal}`),
  state,
  purpose,
  setup: {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspace: "worktree",
  },
  startedAt: at,
  endedAt: null,
  note: state === "failed" ? "Tests failed on attempt 2" : null,
});
const result = (revision: number): TaskResultFact => ({
  revision,
  kind: "code",
  summary: `+${revision} −0 · 1 file`,
  runOrdinal: revision,
  threadId: ThreadId.make(`thread-${revision}`),
  observedAt: at,
  pullRequest: null,
  delivery: null,
});
const pullRequest = {
  number: 108,
  url: "https://github.com/owner/repo/pull/108",
  host: "github.com",
  repository: "owner/repo",
  state: "open",
} as const;
const facts = (overrides: Partial<TaskFacts> = {}): TaskFacts => ({
  taskId: "task",
  displayId: "T-1",
  lane: "ready",
  runs: [],
  results: [],
  acceptedRevision: null,
  proposalItems: null,
  ...overrides,
});
const subtask = (status: FactoryTaskStatus): SubtaskFacts => ({
  status,
  attention: [],
  liveRuns: [],
});

describe("deriveTask", () => {
  // Facts carry no plan revision: a run or result made before a title edit counts the same.
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly facts: Partial<TaskFacts>;
    readonly subtasks?: ReadonlyArray<SubtaskFacts>;
    readonly status: FactoryTaskStatus;
    readonly attention?: ReadonlyArray<string>;
    readonly live?: number;
    readonly result?: "ready" | "accepted" | "changed" | null;
  }> = [
    { name: "backlog follows the lane", facts: { lane: "backlog" }, status: "backlog" },
    { name: "ready follows the lane", facts: {}, status: "ready" },
    {
      name: "a running run is in progress",
      facts: { runs: [run(1, "running")] },
      status: "in-progress",
      live: 1,
    },
    {
      name: "a stopping run is in progress",
      facts: { runs: [run(1, "stopping")] },
      status: "in-progress",
      live: 1,
    },
    {
      name: "a failed run keeps the status and raises failed",
      facts: { runs: [run(1, "failed")] },
      status: "in-progress",
      attention: ["failed:Tests failed on attempt 2"],
      live: 0,
    },
    {
      name: "a held run is live and raises failed",
      facts: { runs: [{ ...run(1, "held"), note: "Waiting for the run's processes to exit" }] },
      status: "in-progress",
      attention: ["failed:Waiting for the run's processes to exit"],
      live: 1,
    },
    {
      name: "a stopped run is in progress and asks for nothing",
      facts: { runs: [run(1, "stopped")] },
      status: "in-progress",
      attention: [],
    },
    {
      name: "a result with no live run is in review",
      facts: { runs: [run(1, "completed")], results: [result(1)] },
      status: "in-review",
      attention: ["review:+1 −0 · 1 file"],
      result: "ready",
    },
    {
      name: "an accepted latest result is done",
      facts: { runs: [run(1, "completed")], results: [result(1)], acceptedRevision: 1 },
      status: "done",
      attention: [],
      result: "accepted",
    },
    {
      name: "an unconfirmed merge of a done task asks for a check and keeps it done",
      facts: {
        runs: [run(1, "completed")],
        results: [
          {
            ...result(1),
            pullRequest,
            delivery: { action: "merge", state: "unconfirmed", detail: null },
          },
        ],
        acceptedRevision: 1,
      },
      status: "done",
      attention: ["unconfirmed:Merge of PR #108 sent · outcome unknown"],
      result: "accepted",
    },
    {
      name: "a failed or sending publish asks for nothing",
      facts: {
        runs: [run(1, "completed"), run(2, "completed")],
        results: [
          { ...result(1), delivery: { action: "publish", state: "failed", detail: "rejected" } },
          { ...result(2), delivery: { action: "publish", state: "sending", detail: null } },
        ],
        acceptedRevision: 2,
      },
      status: "done",
      attention: [],
      result: "accepted",
    },
    {
      name: "a result newer than the accepted one is changed",
      facts: {
        runs: [run(1, "completed"), run(2, "completed")],
        results: [result(1), result(2)],
        acceptedRevision: 1,
      },
      status: "in-review",
      attention: ["changed:+2 −0 · 1 file"],
      result: "changed",
    },
    {
      name: "a new run over a result under review is in progress again",
      facts: { runs: [run(1, "completed"), run(2, "running")], results: [result(1)] },
      status: "in-progress",
      attention: [],
      live: 1,
      result: "ready",
    },
    {
      name: "a failed retry leaves the earlier result in review",
      facts: { runs: [run(1, "completed"), run(2, "failed")], results: [result(1)] },
      status: "in-review",
      attention: ["failed:Tests failed on attempt 2", "review:+1 −0 · 1 file"],
    },
    { name: "the done lane is done without a result", facts: { lane: "done" }, status: "done" },
    {
      name: "the done lane hides a failed run",
      facts: { lane: "done", runs: [run(1, "failed")] },
      status: "done",
      attention: [],
    },
    {
      name: "canceled wins over everything",
      facts: {
        lane: "canceled",
        runs: [run(1, "completed")],
        results: [result(1)],
        acceptedRevision: 1,
      },
      status: "canceled",
      attention: [],
    },
    {
      name: "a waiting proposal raises plan and moves nothing",
      facts: { lane: "backlog", proposalItems: 4 },
      status: "backlog",
      attention: ["plan:4 sub-tasks"],
    },
    {
      name: "a planning run is live and is not work",
      facts: { lane: "backlog", runs: [run(1, "running", "planning")] },
      status: "backlog",
      live: 1,
    },
    {
      name: "a parent with a sub-task in progress is in progress",
      facts: { lane: "backlog" },
      subtasks: [subtask("in-progress"), subtask("ready")],
      status: "in-progress",
    },
    {
      name: "a parent with a done sub-task is in progress",
      facts: {},
      subtasks: [subtask("done"), subtask("backlog")],
      status: "in-progress",
    },
    {
      name: "a parent whose sub-tasks have not started keeps its lane",
      facts: { lane: "backlog" },
      subtasks: [subtask("ready"), subtask("canceled")],
      status: "backlog",
    },
    {
      name: "sub-tasks do not reopen a done parent",
      facts: { lane: "done" },
      subtasks: [subtask("in-progress")],
      status: "done",
    },
  ];
  it.each(cases)("$name", (entry) => {
    const derived = deriveTask(facts(entry.facts), entry.subtasks ?? []);
    assert.equal(derived.status, entry.status);
    if (entry.attention !== undefined)
      assert.deepEqual(
        derived.attention.map((item) => `${item.reason}:${item.detail}`),
        entry.attention,
      );
    if (entry.live !== undefined) assert.equal(derived.liveRuns.length, entry.live);
    if (entry.result !== undefined) assert.equal(derived.result?.state ?? null, entry.result);
  });

  it("counts progress over direct sub-tasks and leaves canceled ones out", () => {
    const derived = deriveTask(facts(), [subtask("done"), subtask("ready"), subtask("canceled")]);
    assert.deepEqual(derived.progress, { done: 1, total: 2 });
    assert.equal(deriveTask(facts(), [subtask("canceled")]).progress, null);
  });
});

it("a parent carries its sub-tasks' reasons and live runs, most urgent first", () => {
  const tree = deriveTree([
    { ...facts({ taskId: "root", displayId: "T-1", proposalItems: 2 }), parentId: null },
    {
      ...facts({
        taskId: "review",
        displayId: "T-1.1",
        runs: [run(1, "completed")],
        results: [result(1)],
      }),
      parentId: "root",
    },
    {
      ...facts({ taskId: "failed", displayId: "T-1.2", runs: [run(2, "failed")] }),
      parentId: "root",
    },
    {
      ...facts({ taskId: "deep", displayId: "T-1.2.1", runs: [run(3, "running")] }),
      parentId: "failed",
    },
  ]);
  const root = tree.get("root")!;
  assert.equal(root.status, "in-progress");
  assert.deepEqual(
    root.attention.map((item) => [item.reason, item.displayId]),
    [
      ["failed", "T-1.2"],
      ["plan", "T-1"],
      ["review", "T-1.1"],
    ],
  );
  assert.deepEqual(
    root.liveRuns.map((live) => live.displayId),
    ["T-1.2.1"],
  );
  assert.deepEqual(root.progress, { done: 0, total: 2 });
  assert.deepEqual(tree.get("failed")!.progress, { done: 0, total: 1 });
});

describe("deliveryState", () => {
  const delivery = (
    kind: TaskDeliveryFact["kind"],
    status: TaskDeliveryFact["status"],
    failure: string | null = null,
  ): TaskDeliveryFact => ({
    kind,
    status,
    remote:
      kind === "merge-pr" || status === "confirmed" ? { number: 108, url: pullRequest.url } : null,
    host: "github.com",
    repository: "owner/repo",
    failure,
  });
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly deliveries: ReadonlyArray<TaskDeliveryFact>;
    readonly pullRequest: "open" | "merged" | null;
    readonly delivery: string | null;
  }> = [
    { name: "nothing published", deliveries: [], pullRequest: null, delivery: null },
    {
      name: "a publish on its way",
      deliveries: [delivery("publish-pr", "sending")],
      pullRequest: null,
      delivery: "publish:sending",
    },
    {
      name: "a refused publish keeps its reason",
      deliveries: [delivery("publish-pr", "failed", "push failed: rejected")],
      pullRequest: null,
      delivery: "publish:failed:push failed: rejected",
    },
    {
      name: "a confirmed publish opens the pull request",
      deliveries: [delivery("publish-pr", "failed"), delivery("publish-pr", "confirmed")],
      pullRequest: "open",
      delivery: null,
    },
    {
      name: "an unknown merge leaves it open and unconfirmed",
      deliveries: [delivery("publish-pr", "confirmed"), delivery("merge-pr", "unknown")],
      pullRequest: "open",
      delivery: "merge:unconfirmed",
    },
    {
      name: "a confirmed merge after a failed one is merged",
      deliveries: [
        delivery("publish-pr", "confirmed"),
        delivery("merge-pr", "failed", "pull request is not merged"),
        delivery("merge-pr", "confirmed"),
      ],
      pullRequest: "merged",
      delivery: null,
    },
  ];
  it.each(cases)("$name", (testCase) => {
    const state = deliveryState(testCase.deliveries);
    assert.equal(state.pullRequest?.state ?? null, testCase.pullRequest);
    assert.equal(
      state.delivery === null
        ? null
        : [state.delivery.action, state.delivery.state, state.delivery.detail]
            .filter((part) => part !== null)
            .join(":"),
      testCase.delivery,
    );
  });
});

describe("workRunState", () => {
  const base = {
    quiescent: false,
    engineStop: false,
    stopByPerson: false,
    nativeStatus: "running",
    outputStatus: null,
    effectsPending: false,
  } as const;
  const cases: ReadonlyArray<
    readonly [string, Partial<Parameters<typeof workRunState>[0]>, FactoryTaskRunState]
  > = [
    ["a run nobody stopped is running", {}, "running"],
    [
      "a finished run still being captured is running",
      { engineStop: true, nativeStatus: "completed", effectsPending: true },
      "running",
    ],
    [
      "a run a person stopped is stopping until its writers are gone",
      { engineStop: true, stopByPerson: true, effectsPending: true },
      "stopping",
    ],
    [
      "an interrupted run is stopping until its writers are gone",
      { engineStop: true, nativeStatus: "interrupted", effectsPending: true },
      "stopping",
    ],
    ["a failed thread run the engine never closed is held", { nativeStatus: "failed" }, "held"],
    [
      "an ended run nothing is finishing is held",
      { engineStop: true, nativeStatus: "completed" },
      "held",
    ],
    [
      "a settled run with a kept result is completed",
      { quiescent: true, engineStop: true, nativeStatus: "completed", outputStatus: "sealed" },
      "completed",
    ],
    [
      "a settled run without a result is failed",
      { quiescent: true, engineStop: true, nativeStatus: "failed", outputStatus: "failed" },
      "failed",
    ],
    [
      "a settled run a person stopped is stopped",
      { quiescent: true, engineStop: true, stopByPerson: true, outputStatus: "failed" },
      "stopped",
    ],
    [
      "a settled interrupted run is stopped",
      { quiescent: true, engineStop: true, nativeStatus: "cancelled" },
      "stopped",
    ],
  ];
  it.each(cases)("%s", (_name, overrides, state) =>
    assert.equal(workRunState({ ...base, ...overrides }).state, state),
  );

  it("reads a planning run from its thread", () => {
    assert.equal(planningRunState(null).state, "running");
    assert.equal(planningRunState("waiting").state, "running");
    assert.equal(planningRunState("completed").state, "completed");
    assert.equal(planningRunState("failed").state, "failed");
    assert.equal(planningRunState("interrupted").state, "stopped");
  });
});

describe("checkLaneMove", () => {
  const move = (
    from: FactoryTaskLane,
    to: FactoryTaskLane,
    state: Partial<Omit<Parameters<typeof checkLaneMove>[0], "from" | "to">> = {},
  ) => {
    const outcome = checkLaneMove({
      from,
      to,
      status: from,
      accepted: false,
      runLive: false,
      resultWaiting: false,
      ...state,
    });
    return outcome.allowed ? "allowed" : outcome.reason;
  };
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["backlog to ready", move("backlog", "ready"), "allowed"],
    ["ready to backlog", move("ready", "backlog"), "allowed"],
    [
      "ready to backlog once in progress",
      move("ready", "backlog", { status: "in-progress" }),
      "invalid-transition",
    ],
    [
      "backlog to ready while in review",
      move("backlog", "ready", { status: "in-review" }),
      "invalid-transition",
    ],
    ["to done", move("ready", "done"), "allowed"],
    [
      "to done with a live run",
      move("ready", "done", { status: "in-progress", runLive: true }),
      "run-active",
    ],
    [
      "to done with a result waiting",
      move("ready", "done", { status: "in-review", resultWaiting: true }),
      "invalid-transition",
    ],
    ["to done after a failed run", move("ready", "done", { status: "in-progress" }), "allowed"],
    [
      "to canceled",
      move("ready", "canceled", { status: "in-review", resultWaiting: true }),
      "allowed",
    ],
    ["to canceled with a live run", move("backlog", "canceled", { runLive: true }), "run-active"],
    ["done by the lane back to ready", move("done", "ready", { status: "done" }), "allowed"],
    ["done by the lane back to backlog", move("done", "backlog", { status: "done" }), "allowed"],
    [
      "done by acceptance back to ready",
      move("done", "ready", { status: "done", accepted: true }),
      "invalid-transition",
    ],
    [
      "accepted task to backlog",
      move("ready", "backlog", { status: "done", accepted: true }),
      "invalid-transition",
    ],
    ["canceled to backlog", move("canceled", "backlog", { status: "canceled" }), "allowed"],
    ["canceled to ready", move("canceled", "ready", { status: "canceled" }), "allowed"],
    ["canceled to done", move("canceled", "done", { status: "canceled" }), "invalid-transition"],
    ["the same lane", move("done", "done", { status: "done", accepted: true }), "allowed"],
  ];
  it.each(cases)("%s", (_name, actual, expected) => assert.equal(actual, expected));
});
