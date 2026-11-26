import type {
  FactorySignalCandidate,
  FactorySignalFeedState,
  FactorySignalFeedView,
  FactorySignalsList,
  FactoryTaskSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canFollowMore,
  decisionInput,
  feedStatus,
  pendingTotal,
  selectSignalRows,
  signalDecisionWaits,
  type SignalDecisionLock,
} from "./signals.logic";

const firstFeedId = "00000000-0000-4000-8000-000000000001";
const secondFeedId = "00000000-0000-4000-8000-000000000002";
const missingFeedId = "00000000-0000-4000-8000-000000000003";
const earlier = "2026-11-01T10:00:00.000Z";
const later = "2026-11-01T11:00:00.000Z";

const feed = (id: string, label: string, pending: number): FactorySignalFeedView => ({
  feed: { v: 1, id, url: "https://example.com/feed", label, projectId: null, addedAt: earlier },
  state: null,
  pending,
});

const candidate = (
  id: string,
  fields: Partial<FactorySignalCandidate> = {},
): FactorySignalCandidate => ({
  v: 1,
  id,
  feedId: firstFeedId,
  projectId: null,
  itemKey: "item-key",
  revision: 1,
  sha256: "f".repeat(64),
  title: "An item",
  summary: "A summary",
  link: "https://example.com/item",
  state: "pending",
  firstSeenAt: earlier,
  changedAt: later,
  decidedAt: null,
  decidedRevision: null,
  decidedSha256: null,
  taskId: null,
  ...fields,
});

const task = (id: string, number: number): FactoryTaskSummary => ({
  v: 1,
  id,
  number,
  rev: 1,
  projectId: null,
  title: id,
  lane: "backlog",
  laneSetAt: earlier,
  parentId: null,
  blockedBy: [],
  assignee: null,
  model: null,
  source: { _tag: "local" },
  createdAt: earlier,
  updatedAt: later,
  hasDescription: false,
  attempt: null,
});

const list = (
  feeds: ReadonlyArray<FactorySignalFeedView>,
  candidates: ReadonlyArray<FactorySignalCandidate> = [],
): FactorySignalsList => ({ feeds, candidates, damaged: 0, truncated: false });

const state = (fields: Partial<FactorySignalFeedState> = {}): FactorySignalFeedState => ({
  v: 1,
  feedId: firstFeedId,
  lastPullAt: later,
  lastOkAt: earlier,
  etag: null,
  lastModified: null,
  failures: 0,
  failure: null,
  httpStatus: 200,
  items: 3,
  ...fields,
});

describe("selectSignalRows", () => {
  it("preserves list order and derives labels, task numbers, actions, and revision changes", () => {
    const dismissed = candidate("d".repeat(64), {
      feedId: secondFeedId,
      state: "dismissed",
      revision: 4,
      decidedRevision: 2,
      decidedAt: earlier,
      decidedSha256: "e".repeat(64),
    });
    const admittedMissingTask = candidate("a".repeat(64), {
      state: "admitted",
      taskId: "missing-task",
      decidedRevision: 1,
      decidedAt: earlier,
      decidedSha256: "f".repeat(64),
    });
    const pendingUnknownFeed = candidate("b".repeat(64), { feedId: missingFeedId });
    const admittedSameRevision = candidate("c".repeat(64), {
      state: "admitted",
      revision: 2,
      taskId: "task-42",
      decidedRevision: 2,
      decidedAt: earlier,
      decidedSha256: "f".repeat(64),
    });
    const admittedChanged = candidate("e".repeat(64), {
      feedId: secondFeedId,
      state: "admitted",
      revision: 3,
      taskId: "task-17",
      decidedRevision: 2,
      decidedAt: earlier,
      decidedSha256: "f".repeat(64),
    });
    const admittedBeforeDecision = candidate("f".repeat(64), {
      state: "admitted",
      revision: 1,
      taskId: null,
      decidedRevision: 2,
      decidedAt: earlier,
      decidedSha256: "f".repeat(64),
    });
    const input = list(
      [feed(firstFeedId, "First feed", 2), feed(secondFeedId, "Second feed", 3)],
      [
        dismissed,
        admittedMissingTask,
        pendingUnknownFeed,
        admittedSameRevision,
        admittedChanged,
        admittedBeforeDecision,
      ],
    );

    // The input order is deliberate; the task array is in a different order from the rows.
    expect(selectSignalRows(input, [task("task-17", 17), task("task-42", 42)])).toEqual([
      {
        candidate: dismissed,
        feedLabel: "Second feed",
        taskNumber: null,
        changedAfterAdmit: false,
        actions: ["admit"],
      },
      {
        candidate: admittedMissingTask,
        feedLabel: "First feed",
        taskNumber: null,
        changedAfterAdmit: false,
        actions: [],
      },
      {
        candidate: pendingUnknownFeed,
        feedLabel: null,
        taskNumber: null,
        changedAfterAdmit: false,
        actions: ["admit", "dismiss"],
      },
      {
        candidate: admittedSameRevision,
        feedLabel: "First feed",
        taskNumber: 42,
        changedAfterAdmit: false,
        actions: ["open-task"],
      },
      {
        candidate: admittedChanged,
        feedLabel: "Second feed",
        taskNumber: 17,
        changedAfterAdmit: true,
        actions: ["open-task"],
      },
      {
        candidate: admittedBeforeDecision,
        feedLabel: "First feed",
        taskNumber: null,
        changedAfterAdmit: false,
        actions: [],
      },
    ]);
  });

  it("does not mark an admitted candidate changed without a decided revision", () => {
    const admitted = candidate("1".repeat(64), {
      state: "admitted",
      revision: 3,
      decidedRevision: null,
    });

    // r10b S13: a missing decided revision cannot establish a later revision.
    expect(selectSignalRows(list([feed(firstFeedId, "First feed", 0)], [admitted]), [])).toEqual([
      {
        candidate: admitted,
        feedLabel: "First feed",
        taskNumber: null,
        changedAfterAdmit: false,
        actions: [],
      },
    ]);
  });
});

describe("feed summaries", () => {
  it("sums pending counts from feed views, not the candidate list", () => {
    const input = list(
      [feed(firstFeedId, "First feed", 2), feed(secondFeedId, "Second feed", 5)],
      [candidate("a".repeat(64))],
    );
    // Two plus five is seven, even though only one candidate is in this answer.
    expect(pendingTotal(input)).toBe(7);
    expect(pendingTotal(list([]))).toBe(0);
  });

  it.each([
    {
      name: "no state",
      state: null,
      expected: { kind: "unread" },
    },
    {
      name: "reserved but not yet read",
      state: state({ lastOkAt: null, failure: null, httpStatus: null }),
      expected: { kind: "unread" },
    },
    {
      name: "successful read",
      state: state(),
      expected: { kind: "ok", at: earlier },
    },
    {
      name: "failure after a successful read",
      state: state({ failure: "status", failures: 1, httpStatus: 500 }),
      expected: {
        kind: "failed",
        at: later,
        failure: "status",
        httpStatus: 500,
        lastOkAt: earlier,
      },
    },
    {
      name: "failure before any successful read",
      state: state({ failure: "dns", failures: 1, httpStatus: null, lastOkAt: null }),
      expected: { kind: "failed", at: later, failure: "dns", httpStatus: null, lastOkAt: null },
    },
  ])("reports $name", ({ state: feedState, expected }) => {
    // Failure wins over read history; a reservation alone is not a successful read.
    expect(feedStatus({ ...feed(firstFeedId, "First feed", 0), state: feedState })).toEqual(
      expected,
    );
  });

  it.each([
    { count: 0, expected: true },
    { count: 19, expected: true },
    { count: 20, expected: false },
    { count: 21, expected: false },
  ])("allows following at $count feeds: $expected", ({ count, expected }) => {
    const feeds = Array.from({ length: count }, (_, index) =>
      feed(`feed-${index}`, `Feed ${index}`, 0),
    );
    // The maximum is 20, so 19 is below it and 20 is not.
    expect(canFollowMore(list(feeds))).toBe(expected);
  });
});

describe("decisionInput", () => {
  it("copies exactly the displayed candidate's four decision fields", () => {
    const shown = candidate("a".repeat(64), {
      feedId: secondFeedId,
      revision: 7,
      sha256: "b".repeat(64),
      title: "Displayed title",
    });

    // The candidate id is renamed; title and every other field are excluded.
    expect(decisionInput(shown)).toStrictEqual({
      feedId: secondFeedId,
      candidateId: "a".repeat(64),
      revision: 7,
      sha256: "b".repeat(64),
    });
  });
});

it.each([
  {
    name: "no lock",
    lock: undefined,
    candidate: { revision: 2, state: "pending" },
    expected: false,
  },
  {
    name: "running",
    lock: { phase: "running" },
    candidate: { revision: 3, state: "dismissed" },
    expected: true,
  },
  {
    name: "decided at the displayed revision and state",
    lock: { phase: "decided", revision: 2, state: "pending" },
    candidate: { revision: 2, state: "pending" },
    expected: true,
  },
  {
    name: "decided at a different revision",
    lock: { phase: "decided", revision: 2, state: "pending" },
    candidate: { revision: 3, state: "pending" },
    expected: false,
  },
  {
    name: "decided in a different state",
    lock: { phase: "decided", revision: 2, state: "pending" },
    candidate: { revision: 2, state: "admitted" },
    expected: false,
  },
] satisfies ReadonlyArray<{
  name: string;
  lock: SignalDecisionLock | undefined;
  candidate: Pick<FactorySignalCandidate, "revision" | "state">;
  expected: boolean;
}>)("r10b S13 decision wait: $name", ({ lock, candidate: shown, expected }) => {
  // A completed decision blocks only the exact row that the list still shows.
  expect(signalDecisionWaits(lock, shown)).toBe(expected);
});
