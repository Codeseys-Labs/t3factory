import type {
  FactoryReviewFinding,
  FactoryReviewRound,
  FactoryTaskSummary,
  WorkflowRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkCards } from "./workBoard.logic";
import {
  combineAttentionCounts,
  nextAttentionFocus,
  selectDirectRelations,
  selectReviewParts,
} from "./workDetail.logic";

const time = (minute: number) => `2026-11-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

const finding = (id: string, fields: Partial<FactoryReviewFinding> = {}): FactoryReviewFinding => ({
  id,
  lens: "brief",
  severity: "major",
  category: "correctness",
  path: "src/file.ts",
  line: 42,
  claim: `claim ${id}`,
  evidence: `evidence ${id}`,
  status: "open",
  disproof: { outcome: "not-run", tried: "" },
  ...fields,
});

const round = (
  fields: Partial<FactoryReviewRound> & Pick<FactoryReviewRound, "at">,
): FactoryReviewRound => ({
  v: 1,
  taskId: "task",
  attempt: 1,
  part: 0,
  runId: "run",
  head: "head-1",
  lenses: ["brief"],
  verdict: "changes",
  findings: [],
  createdAt: time(1),
  ...fields,
});

const task = (id: string, fields: Partial<FactoryTaskSummary> = {}): FactoryTaskSummary => ({
  v: 1,
  id,
  number: 1,
  rev: 1,
  projectId: null,
  title: id,
  lane: "backlog",
  laneSetAt: time(10),
  parentId: null,
  blockedBy: [],
  assignee: null,
  model: null,
  source: { _tag: "local" },
  createdAt: time(0),
  updatedAt: time(10),
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
  startedAt: time(0),
  updatedAt: time(10),
  endedAt: null,
  ...fields,
});

const attempt = (taskId: string, runId: string) => ({
  v: 1 as const,
  taskId,
  n: 1,
  key: `task/${taskId}/a1`,
  workflow: "factory-task",
  runId,
  requestedBy: "client",
  startedAt: time(0),
});

const cardsFor = (
  tasks: ReadonlyArray<FactoryTaskSummary>,
  runs: ReadonlyArray<WorkflowRun> = [],
) => deriveWorkCards({ tasks, runs, questions: [] });

describe("selectReviewParts (E1)", () => {
  it("accepts an older server without reviews and ignores other attempts", () => {
    // No supplied rounds, or no rounds for attempt 2, yields no parts.
    expect(selectReviewParts(undefined, 1)).toEqual([]);
    expect(selectReviewParts([round({ at: "0", attempt: 1 })], 2)).toEqual([]);
  });

  it("sorts parts and rounds, annotates every finding, and counts across all rounds", () => {
    const repeated = finding("aaaaaaaaaaaaaaaa", {
      status: "refuted",
      disproof: { outcome: "refuted", tried: "counterexample" },
    });
    const vanished = finding("bbbbbbbbbbbbbbbb", { severity: "blocker" });
    const minor = finding("cccccccccccccccc", { severity: "minor" });
    const nit = finding("dddddddddddddddd", { severity: "nit" });
    const openAgain = finding("aaaaaaaaaaaaaaaa", { severity: "blocker" });
    const refutedBlocker = finding("eeeeeeeeeeeeeeee", {
      severity: "blocker",
      status: "refuted",
      disproof: { outcome: "refuted", tried: "reproduced" },
    });
    const staleMajor = finding("ffffffffffffffff");
    const staleRefuted = finding("9999999999999999", { status: "refuted" });
    const openMajor = finding("8888888888888888");
    const early = round({
      at: "a",
      createdAt: time(1),
      findings: [repeated, vanished, minor, nit],
    });
    const middle = round({
      at: "b",
      createdAt: time(1),
      head: null,
      lenses: ["brief", "defects"],
      verdict: "changes",
      findings: [openAgain, refutedBlocker, openMajor],
    });
    const latestStale = round({
      at: "0/again",
      createdAt: time(2),
      verdict: "stale",
      findings: [staleMajor, { ...repeated }, { ...minor }, staleRefuted],
    });
    const partTwo = round({ at: "0", part: 2, verdict: "approve" });
    const otherAttempt = round({ at: "other", part: 0, attempt: 2 });

    // Part 0 sorts a,b,0/again by time then address; part 2 follows it.
    // The last non-stale round has one open blocker and one open major; stale findings do not add.
    // Across all rounds ids a, e and 9 are refuted, even though a occurs refuted twice.
    expect(selectReviewParts([latestStale, partTwo, middle, otherAttempt, early], 1)).toEqual([
      {
        part: 0,
        latestVerdict: "changes",
        blocking: 2,
        refuted: 3,
        rounds: [
          {
            at: "a",
            head: "head-1",
            createdAt: time(1),
            verdict: "changes",
            lenses: ["brief"],
            findings: [
              { ...repeated, blocking: false, raisedAgain: true },
              { ...vanished, blocking: true, raisedAgain: false },
              { ...minor, blocking: false, raisedAgain: true },
              { ...nit, blocking: false, raisedAgain: false },
            ],
          },
          {
            at: "b",
            head: null,
            createdAt: time(1),
            verdict: "changes",
            lenses: ["brief", "defects"],
            findings: [
              { ...openAgain, blocking: true, raisedAgain: true },
              { ...refutedBlocker, blocking: false, raisedAgain: false },
              { ...openMajor, blocking: true, raisedAgain: false },
            ],
          },
          {
            at: "0/again",
            head: "head-1",
            createdAt: time(2),
            verdict: "stale",
            lenses: ["brief"],
            findings: [
              { ...staleMajor, blocking: true, raisedAgain: null },
              { ...repeated, blocking: false, raisedAgain: null },
              { ...minor, blocking: false, raisedAgain: null },
              { ...staleRefuted, blocking: false, raisedAgain: null },
            ],
          },
        ],
      },
      {
        part: 2,
        latestVerdict: "approve",
        blocking: 0,
        refuted: 0,
        rounds: [
          {
            at: "0",
            head: "head-1",
            createdAt: time(1),
            verdict: "approve",
            lenses: ["brief"],
            findings: [],
          },
        ],
      },
    ]);
  });

  it("orders sub-millisecond round timestamps as strings before addresses", () => {
    const blocker = finding("1111111111111111", { severity: "blocker" });
    const earlier = round({
      at: "b",
      createdAt: "2026-11-01T00:00:00.000001Z",
      findings: [blocker],
    });
    const later = round({
      at: "a",
      createdAt: "2026-11-01T00:00:00.000002Z",
      verdict: "approve",
    });
    // r9c E1: .000001 precedes .000002 as strings despite b sorting after a.
    // The later approval has no findings, so it sets the verdict and blocking count to approve and 0.
    expect(selectReviewParts([later, earlier], 1)).toEqual([
      {
        part: 0,
        latestVerdict: "approve",
        blocking: 0,
        refuted: 0,
        rounds: [
          {
            at: "b",
            head: "head-1",
            createdAt: "2026-11-01T00:00:00.000001Z",
            verdict: "changes",
            lenses: ["brief"],
            findings: [{ ...blocker, blocking: true, raisedAgain: false }],
          },
          {
            at: "a",
            head: "head-1",
            createdAt: "2026-11-01T00:00:00.000002Z",
            verdict: "approve",
            lenses: ["brief"],
            findings: [],
          },
        ],
      },
    ]);
  });

  it("returns stale and zero blocking when every round is stale", () => {
    const first = finding("1111111111111111");
    const refuted = finding("2222222222222222", { status: "refuted" });
    // The only round is stale: its open major does not block the part, but its refutation counts.
    expect(
      selectReviewParts([round({ at: "0", verdict: "stale", findings: [first, refuted] })], 1),
    ).toEqual([
      {
        part: 0,
        latestVerdict: "stale",
        blocking: 0,
        refuted: 1,
        rounds: [
          {
            at: "0",
            head: "head-1",
            createdAt: time(1),
            verdict: "stale",
            lenses: ["brief"],
            findings: [
              { ...first, blocking: true, raisedAgain: null },
              { ...refuted, blocking: false, raisedAgain: null },
            ],
          },
        ],
      },
    ]);
  });
});

describe("selectDirectRelations (E2)", () => {
  it("returns no relations for a missing task, even if another task names it as parent", () => {
    const tasks = [task("child", { parentId: "missing" })];
    // A missing root suppresses the otherwise matching child.
    expect(selectDirectRelations("missing", tasks, cardsFor(tasks))).toEqual({
      blockers: [],
      children: [],
      omitted: { blockers: 0, children: 0 },
    });
  });

  it("uses stored blocker order, card columns, and numbered children, omitting dropped children", () => {
    const tasks = [
      task("root", { blockedBy: ["live", "missing", "finished", "dropped", "ready"] }),
      task("live", { number: 2, lane: "done", attempt: attempt("live", "live-run") }),
      task("finished", { number: 3, lane: "doing", attempt: attempt("finished", "finished-run") }),
      task("dropped", { number: 4, lane: "dropped" }),
      task("ready", { number: 5, lane: "ready" }),
      task("child-high", { number: 30, parentId: "root", lane: "done" }),
      task("child-dropped", { number: 10, parentId: "root", lane: "dropped" }),
      task("child-low", { number: 20, parentId: "root" }),
      task("unrelated", { number: 6 }),
    ];
    const runs = [run("live-run"), run("finished-run", { status: "completed", endedAt: time(20) })];
    // The live run overrides its done lane; the completed run overrides its doing lane.
    // Unknown and dropped blockers remain visible; child 10 has no card and is absent.
    expect(selectDirectRelations("root", tasks, cardsFor(tasks, runs))).toEqual({
      blockers: [
        { taskId: "live", number: 2, title: "live", status: "open" },
        { taskId: "missing", number: null, title: null, status: "unknown" },
        { taskId: "finished", number: 3, title: "finished", status: "completed" },
        { taskId: "dropped", number: 4, title: "dropped", status: "dropped" },
        { taskId: "ready", number: 5, title: "ready", status: "open" },
      ],
      children: [
        { taskId: "child-low", number: 20, title: "child-low", status: "open" },
        { taskId: "child-high", number: 30, title: "child-high", status: "completed" },
      ],
      omitted: { blockers: 0, children: 0 },
    });
  });

  it("spends an explicit limit on blockers before children", () => {
    const tasks = [
      task("root", { blockedBy: ["b2", "b1"] }),
      task("b1", { number: 1 }),
      task("b2", { number: 2 }),
      task("c3", { number: 3, parentId: "root" }),
      task("c1", { number: 1, parentId: "root" }),
      task("c2", { number: 2, parentId: "root" }),
    ];
    const cards = cardsFor(tasks);
    // Two blockers consume two of three slots; only the lowest-numbered child fits.
    expect(selectDirectRelations("root", tasks, cards, 3)).toEqual({
      blockers: [
        { taskId: "b2", number: 2, title: "b2", status: "open" },
        { taskId: "b1", number: 1, title: "b1", status: "open" },
      ],
      children: [{ taskId: "c1", number: 1, title: "c1", status: "open" }],
      omitted: { blockers: 0, children: 2 },
    });
    // One slot admits the first blocker only; the remaining blocker and all three children are lost.
    expect(selectDirectRelations("root", tasks, cards, 1)).toEqual({
      blockers: [{ taskId: "b2", number: 2, title: "b2", status: "open" }],
      children: [],
      omitted: { blockers: 1, children: 3 },
    });
    // A zero limit loses both blockers and all three children.
    expect(selectDirectRelations("root", tasks, cards, 0)).toEqual({
      blockers: [],
      children: [],
      omitted: { blockers: 2, children: 3 },
    });
  });

  it("defaults to 25 slots shared by blockers and children", () => {
    const blockerIds = Array.from({ length: 26 }, (_, index) => `b${index + 1}`);
    const tasks = [
      task("root", { blockedBy: blockerIds }),
      ...blockerIds.map((id, index) => task(id, { number: index + 1 })),
      task("child", { number: 30, parentId: "root" }),
    ];
    // The first 25 of 26 blockers consume every slot; one blocker and the child are omitted.
    expect(selectDirectRelations("root", tasks, cardsFor(tasks))).toEqual({
      blockers: Array.from({ length: 25 }, (_, index) => ({
        taskId: `b${index + 1}`,
        number: index + 1,
        title: `b${index + 1}`,
        status: "open",
      })),
      children: [],
      omitted: { blockers: 1, children: 1 },
    });
  });
});

describe("nextAttentionFocus (E3)", () => {
  it("keeps current if it remains, regardless of after order", () => {
    // Current b survives even though c is first in the new list.
    expect(nextAttentionFocus(["a", "b", "c"], ["c", "b"], "b")).toBe("b");
  });

  it("prefers the first surviving later item in before order, then the nearest earlier one", () => {
    // c is the first later survivor in before, even though d appears first in after.
    expect(nextAttentionFocus(["a", "b", "c", "d"], ["d", "c", "a"], "b")).toBe("c");
    // With no later survivor, c is the nearest earlier survivor, not a.
    expect(nextAttentionFocus(["a", "b", "c", "d"], ["a", "c"], "d")).toBe("c");
    // No item from before survives, so no existing row can receive focus.
    expect(nextAttentionFocus(["a", "b"], ["new"], "b")).toBeNull();
  });

  it("uses the first after item when current is absent from before, or null for empty after", () => {
    // A missing current has no relative position, so the first new item wins.
    expect(nextAttentionFocus(["a"], ["new", "a"], "missing")).toBe("new");
    // r9b E3 keeps current when it survives, even if it was missing from before.
    expect(nextAttentionFocus(["a"], ["new", "missing"], "missing")).toBe("missing");
    // Neither an empty before nor an empty after provides a candidate.
    expect(nextAttentionFocus([], [], "missing")).toBeNull();
    // A current that was present but disappears with every row has no replacement.
    expect(nextAttentionFocus(["a"], [], "a")).toBeNull();
    // With no prior rows, the first new row is selected.
    expect(nextAttentionFocus([], ["x", "y"], "missing")).toBe("x");
  });
});

describe("combineAttentionCounts (E4)", () => {
  it("sums known counts and marks only null-bearing inputs as lower bounds", () => {
    // Empty sum is zero and no input is unknown.
    expect(combineAttentionCounts([])).toEqual({ total: 0, atLeast: false });
    // 2 + 0 + 5 = 7; every environment is known.
    expect(combineAttentionCounts([2, 0, 5])).toEqual({ total: 7, atLeast: false });
    // 2 + 5 = 7; a null environment makes it a lower bound.
    expect(combineAttentionCounts([2, null, 5])).toEqual({ total: 7, atLeast: true });
    // There are no known contributions, and both environments are unknown.
    expect(combineAttentionCounts([null, null])).toEqual({ total: 0, atLeast: true });
  });
});
