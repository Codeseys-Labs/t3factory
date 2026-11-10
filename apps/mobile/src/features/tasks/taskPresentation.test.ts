import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import {
  resolveFactoryTaskLiveState,
  type FactoryTaskThreadFacts,
} from "@t3tools/client-runtime/state/factory-task-view";
import {
  EnvironmentId,
  RuntimeRequestId,
  type FactoryTaskSummary,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agoLabel, approvalAvailability, resolveTaskAsk } from "./taskAsk";
import {
  buildInboxListItems,
  buildTasksListItems,
  buildTasksSections,
  resolveTasksListState,
  taskThreadPill,
  type TaskEntry,
} from "./taskPresentation";

const { tasks, threadFacts, at } = FACTORY_TASK_FIXTURES;
const task = (displayId: string): FactoryTaskSummary =>
  tasks.find((entry) => entry.displayId === displayId)!;

const PILLS = {
  "Pending Approval": taskThreadPill("approval"),
  "Awaiting Input": taskThreadPill("input"),
  Working: taskThreadPill("working"),
};
const phoneFacts: readonly FactoryTaskThreadFacts[] = threadFacts.map((fact) => ({
  ...fact,
  pill: fact.pill ? (PILLS[fact.pill.label as keyof typeof PILLS] ?? null) : null,
}));
const entry = (
  summary: FactoryTaskSummary,
  facts: readonly FactoryTaskThreadFacts[] = phoneFacts,
): TaskEntry => ({ task: summary, live: resolveFactoryTaskLiveState(summary, facts) });
const THIRTEEN_MINUTES_LATER = Date.parse(at) + 13 * 60_000;
const ids = (rows: readonly { need: { displayId: string } }[]) =>
  rows.map((row) => row.need.displayId);

describe("buildTasksSections", () => {
  const sections = buildTasksSections(
    tasks.map((summary) => entry(summary)),
    THIRTEEN_MINUTES_LATER,
  );

  it("lists Needs you one row per ask, most urgent first, then what is in progress", () => {
    expect(sections.count).toBe(5);
    expect(sections.needs.map((row) => [row.need.displayId, row.need.reason])).toEqual([
      ["T-29", "failed"],
      ["T-39", "approve"],
      ["T-38.2", "question"],
      ["T-33", "review"],
      ["T-36", "review"],
    ]);
    expect(
      sections.groups.map((group) => [group.status, group.rows.map((r) => r.task.displayId)]),
    ).toEqual([["in-progress", ["T-41"]]]);
    expect(sections.groups[0]!.rows[0]!.pill).toMatchObject({ label: "Working", elapsed: "13m" });
  });

  it("words each ask the way its thread does", () => {
    expect(sections.needs.map((row) => row.pill.label)).toEqual([
      "Failed",
      "Pending Approval",
      "Awaiting Input",
      "Review",
      "Review",
    ]);
  });

  it("splits the Inbox into asks that block a run and asks ready to review", () => {
    expect(ids(sections.blocking)).toEqual(["T-29", "T-39", "T-38.2"]);
    expect(ids(sections.review)).toEqual(["T-33", "T-36"]);
  });

  it("carries a sub-task's question on its parent without listing the parent twice", () => {
    const parentOnly = buildTasksSections([entry(task("T-38"))], THIRTEEN_MINUTES_LATER);
    expect(parentOnly.needs).toHaveLength(1);
    expect(parentOnly.needs[0]).toMatchObject({
      task: null,
      need: { displayId: "T-38.2", reason: "question", requestId: "question-paging" },
    });
    expect(parentOnly.groups).toEqual([]);
  });

  it("gives a task with two asks one row for each", () => {
    const second = {
      ...phoneFacts.find((fact) => fact.threadId === task("T-39").liveRuns[0]!.threadId)!,
    };
    const approvals = second.requests!.approvals;
    const two: FactoryTaskThreadFacts = {
      ...second,
      requests: {
        userInputs: [],
        approvals: [
          approvals[0]!,
          { ...approvals[0]!, requestId: RuntimeRequestId.make("approval-second") },
        ],
      },
    };
    const facts = [two, ...phoneFacts.filter((fact) => fact.threadId !== two.threadId)];
    const twice = buildTasksSections(
      tasks.map((summary) => entry(summary, facts)),
      THIRTEEN_MINUTES_LATER,
    );
    expect(twice.count).toBe(6);
    expect(
      twice.needs.filter((row) => row.need.displayId === "T-39").map((row) => row.need.requestId),
    ).toEqual(["approval-backtest", "approval-second"]);
  });

  it("writes the list as Needs you, then In progress, and the Inbox as two groups", () => {
    expect(
      buildTasksListItems(sections)
        .filter((item) => item.type === "header")
        .map((item) => item.title),
    ).toEqual(["Needs you · 5", "In progress"]);
    expect(
      buildInboxListItems(sections)
        .filter((item) => item.type === "header")
        .map((item) => item.title),
    ).toEqual(["Blocking a run", "Ready to review"]);
  });
});

describe("resolveTasksListState", () => {
  const a = EnvironmentId.make("a");
  const b = EnvironmentId.make("b");
  const owners = (...statuses: readonly string[]) =>
    statuses.map((status, index) => ({
      environmentId: index === 0 ? a : b,
      status: status as "current",
    }));

  it.each([
    [[], 0, "none"],
    [["loading"], 0, "loading"],
    [["offline"], 0, "offline"],
    [["forbidden"], 0, "forbidden"],
    [["unsupported"], 0, "unsupported"],
    [["failed"], 0, "failed"],
    [["current"], 0, "caught-up"],
    [["current"], 3, "ready"],
    [["offline", "failed"], 0, "failed"],
    [["loading", "current"], 0, "loading"],
    [["offline", "current"], 0, "caught-up"],
  ] as const)("owners %j with %i rows is %s", (statuses, rowCount, kind) => {
    expect(resolveTasksListState({ owners: owners(...statuses), rowCount }).kind).toBe(kind);
  });

  it("names the environment that could not be read while another was", () => {
    expect(resolveTasksListState({ owners: owners("current", "offline"), rowCount: 2 })).toEqual({
      kind: "ready",
      notices: [{ environmentId: b, status: "offline" }],
    });
  });
});

describe("task asks", () => {
  const withAsk = (displayId: string) => {
    const live = entry(task(displayId)).live;
    const facts = phoneFacts.find((fact) => fact.threadId === live.attention[0]?.threadId);
    return { attention: live.attention, requests: facts!.requests! };
  };

  it("answers the task's own approval or question", () => {
    expect(resolveTaskAsk({ task: task("T-39"), ...withAsk("T-39") })?.kind).toBe("approval");
    expect(resolveTaskAsk({ task: task("T-38.2"), ...withAsk("T-38.2") })?.kind).toBe("question");
  });

  it("leaves a sub-task's question to the sub-task's own screen", () => {
    const own = withAsk("T-38.2");
    expect(
      resolveTaskAsk({ task: task("T-38"), attention: own.attention, requests: own.requests }),
    ).toBeNull();
  });

  it("offers only the decisions the provider lists", () => {
    const approval = withAsk("T-39").requests.approvals[0]!;
    expect(approvalAvailability(approval)).toEqual({
      approve: true,
      alwaysAllow: true,
      deny: true,
    });
    const options: ProviderApprovalOption[] = [
      { decision: "accept", label: "Allow" },
      { decision: "decline", label: "Deny" },
    ];
    expect(approvalAvailability({ ...approval, options })).toEqual({
      approve: true,
      alwaysAllow: false,
      deny: true,
    });
    expect(approvalAvailability({ ...approval, responseCapability: "not_resumable" })).toEqual({
      approve: false,
      alwaysAllow: false,
      deny: false,
    });
  });

  it("says how long ago, or just now inside the first minute", () => {
    expect(agoLabel(at, Date.parse(at) + 4 * 60_000)).toBe("4m ago");
    expect(agoLabel(at, Date.parse(at) + 10_000)).toBe("just now");
  });
});
