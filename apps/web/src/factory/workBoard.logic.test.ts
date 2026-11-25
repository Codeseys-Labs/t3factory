import type { FactoryTaskSummary, WorkflowQuestion, WorkflowRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveWorkCards,
  deriveWorkGraph,
  filterWorkCards,
  groupWorkCards,
  WORK_COLUMNS,
} from "./workBoard.logic";

const at = (minute: number) => `2026-11-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

const task = (id: string, fields: Partial<FactoryTaskSummary> = {}): FactoryTaskSummary => ({
  v: 1,
  id,
  number: 1,
  rev: 1,
  projectId: null,
  title: id,
  lane: "backlog",
  laneSetAt: at(10),
  parentId: null,
  blockedBy: [],
  assignee: null,
  model: null,
  source: { _tag: "local" },
  createdAt: at(0),
  updatedAt: at(10),
  hasDescription: false,
  attempt: null,
  ...fields,
});

const run = (runId: string, fields: Partial<WorkflowRun> = {}): WorkflowRun => ({
  runId,
  workflow: "factory-task",
  version: 1,
  title: runId,
  status: "running",
  detail: null,
  result: null,
  pauses: 0,
  retired: false,
  resumesAt: null,
  parentRunId: null,
  parentStep: null,
  startedAt: at(0),
  updatedAt: at(10),
  endedAt: null,
  ...fields,
});

const question = (runId: string, name = "approve"): WorkflowQuestion => ({
  runId,
  name,
  request: { title: "Approve?" } as never,
  askedAt: at(10),
  thread: null,
});

const taskRun = (runId: string) => ({
  v: 1 as const,
  taskId: "task",
  n: 1,
  key: `task/${runId}`,
  workflow: "factory-task",
  runId,
  requestedBy: "client",
  startedAt: at(0),
});

const cardsFor = (
  tasks: ReadonlyArray<FactoryTaskSummary>,
  runs: ReadonlyArray<WorkflowRun> = [],
  questions: ReadonlyArray<WorkflowQuestion> = [],
) => deriveWorkCards({ tasks, runs, questions });

const ids = (cards: ReadonlyArray<{ readonly task: FactoryTaskSummary }>) =>
  cards.map((card) => card.task.id);

const model = (instanceId: string) =>
  ({ instanceId, model: "factory" }) as FactoryTaskSummary["model"];

describe("deriveWorkCards", () => {
  // B1: dropped tasks have no card, and cards sort by updatedAt descending then id ascending.
  it("leaves out dropped tasks and orders the remaining cards", () => {
    const cards = cardsFor([
      task("dropped", { lane: "dropped", updatedAt: at(30) }),
      task("bravo", { updatedAt: at(20) }),
      task("alpha", { updatedAt: at(20) }),
      task("newest", { updatedAt: at(30) }),
    ]);

    expect(ids(cards)).toEqual(["newest", "alpha", "bravo"]);
  });

  // B2: a card uses the matching latest-attempt run and otherwise has no run.
  it("finds only a task attempt's matching run", () => {
    const matching = run("matching");
    const cards = cardsFor(
      [
        task("matched", { attempt: taskRun("matching") }),
        task("missing", { attempt: taskRun("not-listed") }),
        task("no-attempt"),
      ],
      [matching, run("unrelated")],
    );

    expect(cards.map((card) => card.run?.runId ?? null)).toEqual(["matching", null, null]);
  });

  // B3: a task without a run stays in its person's lane.
  it("uses the task lane when no attempt run is listed", () => {
    const [card] = cardsFor([task("review-task", { lane: "review" })]);

    expect(card?.column).toBe("review");
  });

  // B4: every unended run status uses review only for the review stage and otherwise doing.
  it("derives running, waiting, and paused columns without considering the person's lane", () => {
    const cases = [
      { status: "running" as const, tags: ["stage:review"], expected: "review" },
      { status: "running" as const, tags: [], expected: "doing" },
      { status: "waiting" as const, tags: ["stage:review"], expected: "review" },
      { status: "waiting" as const, tags: [], expected: "doing" },
      { status: "paused" as const, tags: ["stage:review"], expected: "review" },
      { status: "paused" as const, tags: [], expected: "doing" },
    ];

    for (const [index, entry] of cases.entries()) {
      const runId = `active-${index}`;
      const [card] = cardsFor(
        [task(`task-${index}`, { lane: "done", attempt: taskRun(runId) })],
        [run(runId, { status: entry.status, tags: entry.tags })],
      );
      expect(card?.column).toBe(entry.expected);
    }
  });

  // B5: ended completed runs finish only when the lane was not changed afterward; other ended statuses keep the lane.
  it("uses each ended status and compares laneSetAt with endedAt", () => {
    const cases = [
      { status: "completed" as const, before: "done", after: "ready" },
      { status: "stopped" as const, before: "ready", after: "ready" },
      { status: "cancelled" as const, before: "ready", after: "ready" },
      { status: "skipped" as const, before: "ready", after: "ready" },
    ];

    for (const [index, entry] of cases.entries()) {
      const beforeRunId = `${entry.status}-before`;
      const afterRunId = `${entry.status}-after`;
      const cards = cardsFor(
        [
          task(`before-${index}`, {
            lane: "ready",
            laneSetAt: at(10),
            attempt: taskRun(beforeRunId),
          }),
          task(`after-${index}`, {
            lane: "ready",
            laneSetAt: at(30),
            attempt: taskRun(afterRunId),
          }),
        ],
        [
          run(beforeRunId, { status: entry.status, endedAt: at(20) }),
          run(afterRunId, { status: entry.status, endedAt: at(20) }),
        ],
      );

      expect(cards.find((card) => card.task.id === `before-${index}`)?.column).toBe(entry.before);
      expect(cards.find((card) => card.task.id === `after-${index}`)?.column).toBe(entry.after);
    }
  });

  // B6: direct and descendant questions, paused failures, open blockers, and ended stops produce ordered badges.
  it("adds badges from related questions and keeps unrelated questions out", () => {
    const cards = cardsFor(
      [
        task("paused-task", { attempt: taskRun("paused-root"), blockedBy: ["open"] }),
        task("stopped-task", {
          laneSetAt: at(10),
          attempt: taskRun("stopped-root"),
          blockedBy: ["open"],
        }),
        task("unrelated-task", { attempt: taskRun("unrelated-run") }),
        task("open", { lane: "ready" }),
      ],
      [
        run("paused-root", { status: "paused" }),
        run("paused-child", { parentRunId: "paused-root" }),
        run("stopped-root", { status: "stopped", endedAt: at(20) }),
        run("stopped-child", { parentRunId: "stopped-root" }),
        run("stopped-grandchild", { parentRunId: "stopped-child" }),
        run("unrelated-run"),
        run("other-root"),
      ],
      [
        question("paused-root"),
        question("paused-child", "child-approve"),
        question("stopped-grandchild"),
        question("other-root"),
      ],
    );

    expect(cards.find((card) => card.task.id === "paused-task")?.badges).toEqual([
      "needs-you",
      "failed",
      "blocked",
    ]);
    expect(cards.find((card) => card.task.id === "stopped-task")?.badges).toEqual([
      "needs-you",
      "blocked",
      "stopped",
    ]);
    expect(cards.find((card) => card.task.id === "unrelated-task")?.badges).toEqual([]);
  });

  // B7: only listed tasks whose cards are not done remain blockers, and dropped children are not counted.
  it("derives open blockers and child counts from cards", () => {
    const cards = cardsFor(
      [
        task("parent", {
          blockedBy: ["done-lane", "open", "missing", "done-run"],
        }),
        task("done-lane", { lane: "done" }),
        task("open", { lane: "ready" }),
        task("done-run", {
          lane: "backlog",
          laneSetAt: at(10),
          attempt: taskRun("completed-run"),
        }),
        task("listed-child", { parentId: "parent" }),
        task("dropped-child", { parentId: "parent", lane: "dropped" }),
      ],
      [run("completed-run", { status: "completed", endedAt: at(20) })],
    );
    const parent = cards.find((card) => card.task.id === "parent");

    expect(parent?.openBlockers).toEqual(["open"]);
    expect(parent?.childCount).toBe(1);
  });
});

describe("filterWorkCards", () => {
  // B8: each supplied filter condition narrows cards, project null differs from absent, and text covers titles and task numbers.
  it("filters projects, assignees, models, and text together or separately", () => {
    const cards = cardsFor([
      task("no-project", {
        number: 1,
        title: "Local alpha",
        assignee: "Ada",
        model: model("model-a"),
      }),
      task("project-a", {
        number: 12,
        projectId: "project-a" as FactoryTaskSummary["projectId"],
        title: "Release candidate",
        assignee: "Ada",
        model: model("model-a"),
      }),
      task("project-b", {
        number: 13,
        projectId: "project-b" as FactoryTaskSummary["projectId"],
        title: "Other work",
        assignee: "Bea",
        model: model("model-b"),
      }),
    ]);

    expect(ids(filterWorkCards(cards, { projectId: null }))).toEqual(["no-project"]);
    expect(ids(filterWorkCards(cards, { projectId: "project-a" }))).toEqual(["project-a"]);
    expect(ids(filterWorkCards(cards, {}))).toEqual(["no-project", "project-a", "project-b"]);
    expect(ids(filterWorkCards(cards, { assignee: "Ada" }))).toEqual(["no-project", "project-a"]);
    expect(ids(filterWorkCards(cards, { modelInstanceId: "model-a" }))).toEqual([
      "no-project",
      "project-a",
    ]);
    expect(ids(filterWorkCards(cards, { text: "LOCAL ALPHA" }))).toEqual(["no-project"]);
    expect(ids(filterWorkCards(cards, { text: "t-12" }))).toEqual(["project-a"]);
    expect(
      ids(
        filterWorkCards(cards, {
          projectId: "project-a",
          assignee: "Ada",
          modelInstanceId: "model-a",
          text: "T-12",
        }),
      ),
    ).toEqual(["project-a"]);
  });
});

describe("groupWorkCards", () => {
  // B9: every board column is present and cards retain their input order within it.
  it("groups cards under all five keys without reordering them", () => {
    const [backlog] = cardsFor([task("backlog", { lane: "backlog" })]);
    const [readyFirst] = cardsFor([task("ready-first", { lane: "ready" })]);
    const [readySecond] = cardsFor([task("ready-second", { lane: "ready" })]);
    const [doing] = cardsFor([task("doing", { lane: "doing" })]);
    const [review] = cardsFor([task("review", { lane: "review" })]);
    const [done] = cardsFor([task("done", { lane: "done" })]);
    const groups = groupWorkCards([readyFirst!, backlog!, readySecond!, doing!, review!, done!]);

    expect(Object.keys(groups)).toEqual([...WORK_COLUMNS]);
    expect(ids(groups.backlog)).toEqual(["backlog"]);
    expect(ids(groups.ready)).toEqual(["ready-first", "ready-second"]);
    expect(ids(groups.doing)).toEqual(["doing"]);
    expect(ids(groups.review)).toEqual(["review"]);
    expect(ids(groups.done)).toEqual(["done"]);
  });
});

describe("deriveWorkGraph", () => {
  // B10: parent and blocker edges set chain depths, while a two-node cycle is assigned depth zero and returns.
  it("builds parent and blocks edges, calculates depths, and terminates cycles", () => {
    const cards = cardsFor([
      task("root"),
      task("middle", { parentId: "root" }),
      task("leaf", { parentId: "middle", blockedBy: ["root"] }),
      task("cycle-a", { parentId: "cycle-b" }),
      task("cycle-b", { parentId: "cycle-a" }),
    ]);
    const graph = deriveWorkGraph(cards);
    const depths = Object.fromEntries(graph.nodes.map((node) => [node.id, node.depth]));

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: "root", to: "middle", kind: "parent" },
        { from: "middle", to: "leaf", kind: "parent" },
        { from: "root", to: "leaf", kind: "blocks" },
        { from: "cycle-b", to: "cycle-a", kind: "parent" },
        { from: "cycle-a", to: "cycle-b", kind: "parent" },
      ]),
    );
    expect(depths).toEqual({
      root: 0,
      middle: 1,
      leaf: 2,
      "cycle-a": 0,
      "cycle-b": 0,
    });
  });
});
