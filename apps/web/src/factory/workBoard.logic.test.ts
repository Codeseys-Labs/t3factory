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
  // B11: activity and live parts derive from active descendants, without treating ended roots or cycles as active work.
  it("derives activity and live parts across root, descendant, ended, and cyclic runs", () => {
    const cases = [
      {
        name: "no attempt",
        task: task("no-attempt"),
        runs: [],
        activity: null,
        liveParts: 0,
      },
      {
        name: "missing attempt run",
        task: task("missing-run", { attempt: taskRun("missing") }),
        runs: [],
        activity: null,
        liveParts: 0,
      },
      {
        name: "completed root with a running part",
        task: task("completed-root", { attempt: taskRun("completed-root-run") }),
        runs: [
          run("completed-root-run", { status: "completed", endedAt: at(20) }),
          run("completed-part", { status: "running", parentRunId: "completed-root-run" }),
        ],
        activity: null,
        liveParts: 1,
      },
      {
        name: "stopped root with a running part",
        task: task("stopped-root", { attempt: taskRun("stopped-root-run") }),
        runs: [
          run("stopped-root-run", { status: "stopped", endedAt: at(20) }),
          run("stopped-part", { status: "running", parentRunId: "stopped-root-run" }),
        ],
        activity: null,
        liveParts: 1,
      },
      {
        name: "running root",
        task: task("running-root", { attempt: taskRun("running-root-run") }),
        runs: [run("running-root-run", { status: "running" })],
        activity: "working",
        liveParts: 0,
      },
      {
        name: "waiting agent plan",
        task: task("agent-plan", { attempt: taskRun("agent-plan-run") }),
        runs: [run("agent-plan-run", { status: "waiting", detail: "agent plan" })],
        activity: "working",
        liveParts: 0,
      },
      {
        name: "waiting root with two working parts",
        task: task("working-parts", { attempt: taskRun("working-parts-root") }),
        runs: [
          run("working-parts-root", { status: "waiting", detail: "part-1" }),
          run("working-part-one", {
            status: "waiting",
            detail: "agent do",
            parentRunId: "working-parts-root",
          }),
          run("working-part-two", {
            status: "waiting",
            detail: "agent do",
            parentRunId: "working-parts-root",
          }),
        ],
        activity: "working",
        liveParts: 2,
      },
      {
        name: "waiting root with two waiting parts",
        task: task("waiting-parts", { attempt: taskRun("waiting-parts-root") }),
        runs: [
          run("waiting-parts-root", { status: "waiting", detail: "part-1" }),
          run("waiting-part-one", {
            status: "waiting",
            detail: "checks/0",
            parentRunId: "waiting-parts-root",
          }),
          run("waiting-part-two", { status: "waiting", parentRunId: "waiting-parts-root" }),
        ],
        activity: "waiting",
        liveParts: 2,
      },
      {
        name: "ended working part",
        task: task("ended-part", { attempt: taskRun("ended-part-root") }),
        runs: [
          run("ended-part-root", { status: "waiting", detail: "part-1" }),
          run("ended-working-part", {
            status: "completed",
            detail: "agent do",
            parentRunId: "ended-part-root",
            endedAt: at(20),
          }),
        ],
        activity: "waiting",
        liveParts: 0,
      },
      {
        name: "working grandchild",
        task: task("working-grandchild", { attempt: taskRun("working-grandchild-root") }),
        runs: [
          run("working-grandchild-root", { status: "waiting", detail: "part-1" }),
          run("waiting-part", {
            status: "waiting",
            detail: "checks/0",
            parentRunId: "working-grandchild-root",
          }),
          run("working-grandchild-run", {
            status: "running",
            parentRunId: "waiting-part",
          }),
        ],
        activity: "working",
        liveParts: 1,
      },
      {
        name: "agents is not agent work",
        task: task("agents-detail", { attempt: taskRun("agents-detail-run") }),
        runs: [run("agents-detail-run", { status: "waiting", detail: "agents" })],
        activity: "waiting",
        liveParts: 0,
      },
      {
        name: "capitalized agent is not agent work",
        task: task("capital-agent", { attempt: taskRun("capital-agent-run") }),
        runs: [run("capital-agent-run", { status: "waiting", detail: "Agent do" })],
        activity: "waiting",
        liveParts: 0,
      },
      {
        name: "parent cycle",
        task: task("cycle-root", { attempt: taskRun("cycle-root-run") }),
        runs: [
          run("cycle-root-run", {
            status: "waiting",
            detail: "checks/0",
            parentRunId: "cycle-part-run",
          }),
          run("cycle-part-run", {
            status: "waiting",
            detail: "checks/0",
            parentRunId: "cycle-root-run",
          }),
        ],
        activity: "waiting",
        liveParts: 1,
      },
    ];

    for (const entry of cases) {
      const [card] = cardsFor([entry.task], entry.runs);
      expect(card?.activity).toBe(entry.activity);
      expect(card?.liveParts).toBe(entry.liveParts);
    }
  });
  // B12 AMBIGUOUS: ended roots suppress failed from paused descendants, while B6 still preserves cancelled roots' stopped badge.
  it("adds failed for every live paused descendant and keeps it out of ended branches", () => {
    const cases = [
      {
        name: "paused root",
        task: task("paused-root", { attempt: taskRun("paused-root-run") }),
        runs: [run("paused-root-run", { status: "paused" })],
        badges: ["failed"],
      },
      {
        name: "paused part beside a waiting part",
        task: task("paused-part", { attempt: taskRun("paused-part-root") }),
        runs: [
          run("paused-part-root", { status: "waiting" }),
          run("paused-part-run", { status: "paused", parentRunId: "paused-part-root" }),
          run("waiting-part-run", { status: "waiting", parentRunId: "paused-part-root" }),
        ],
        badges: ["failed"],
      },
      {
        name: "paused grandchild",
        task: task("paused-grandchild", { attempt: taskRun("paused-grandchild-root") }),
        runs: [
          run("paused-grandchild-root", { status: "waiting" }),
          run("paused-grandchild-part", {
            status: "waiting",
            parentRunId: "paused-grandchild-root",
          }),
          run("paused-grandchild-run", {
            status: "paused",
            parentRunId: "paused-grandchild-part",
          }),
        ],
        badges: ["failed"],
      },
      {
        name: "ended paused part",
        task: task("ended-paused-part", { attempt: taskRun("ended-paused-part-root") }),
        runs: [
          run("ended-paused-part-root", { status: "waiting" }),
          run("ended-paused-part-run", {
            status: "paused",
            parentRunId: "ended-paused-part-root",
            endedAt: at(20),
          }),
        ],
        badges: [],
      },
      {
        name: "completed root with a paused part",
        task: task("completed-paused-part", { attempt: taskRun("completed-paused-part-root") }),
        runs: [
          run("completed-paused-part-root", { status: "completed", endedAt: at(20) }),
          run("completed-paused-part-run", {
            status: "paused",
            parentRunId: "completed-paused-part-root",
          }),
        ],
        badges: [],
      },
      {
        name: "cancelled root with a paused part",
        task: task("cancelled-paused-part", {
          laneSetAt: at(10),
          attempt: taskRun("cancelled-paused-part-root"),
        }),
        runs: [
          run("cancelled-paused-part-root", { status: "cancelled", endedAt: at(20) }),
          run("cancelled-paused-part-run", {
            status: "paused",
            parentRunId: "cancelled-paused-part-root",
          }),
        ],
        badges: ["stopped"],
      },
      {
        name: "no paused run",
        task: task("no-paused-run", { attempt: taskRun("no-paused-run-root") }),
        runs: [
          run("no-paused-run-root", { status: "waiting" }),
          run("no-paused-run-part", { status: "waiting", parentRunId: "no-paused-run-root" }),
        ],
        badges: [],
      },
      {
        name: "question and paused part",
        task: task("question-paused-part", { attempt: taskRun("question-paused-part-root") }),
        runs: [
          run("question-paused-part-root", { status: "waiting" }),
          run("question-part", {
            status: "waiting",
            parentRunId: "question-paused-part-root",
          }),
          run("paused-question-part", {
            status: "paused",
            parentRunId: "question-paused-part-root",
          }),
        ],
        questions: [question("question-part")],
        badges: ["needs-you", "failed"],
      },
    ];

    for (const entry of cases) {
      const questions = "questions" in entry ? entry.questions : [];
      const [card] = cardsFor([entry.task], entry.runs, questions);
      expect(card?.badges).toEqual(entry.badges);
    }
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
