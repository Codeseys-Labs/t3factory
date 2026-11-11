import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  FactoryTaskSummary,
  FactoryAgentProfile,
  FactoryIntakeArrival,
  FactoryIntakeSource,
  FactoryIntakeRule,
  type FactoryTaskStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { FACTORY_TASK_FIXTURES as fixtures } from "./factoryTaskFixtures.ts";
import { FACTORY_INTAKE_FIXTURES as intake } from "./factoryIntakeFixtures.ts";
import {
  factoryTaskKey,
  groupFactoryTaskNeeds,
  groupFactoryTasks,
  nestFactoryTasks,
  presentFactoryTaskAssignee,
  presentFactoryTaskActivity,
  presentFactoryTaskBanner,
  resolveFactoryTaskDrop,
  resolveFactoryTaskLiveState,
} from "./factoryTaskView.ts";
import { decodeFactoryTaskViewState, encodeFactoryTaskViewState } from "./factoryTaskUrl.ts";
import {
  aggregateFactoryTasks,
  planFactoryTaskOwners,
  type FactoryTaskOwner,
} from "./factoryTaskList.ts";

const task = (id: string) => fixtures.tasks.find((task) => task.displayId === id)!;
const state = (id: string) => resolveFactoryTaskLiveState(task(id), fixtures.threadFacts);

describe("task attention", () => {
  it("carries a sub-task's question through its parent and deduplicates both in the Inbox", () => {
    const parent = state("T-38");
    expect(
      parent.attention.map((need) => [need.reason, need.ref.taskId, need.threadId, need.detail]),
    ).toEqual([
      ["question", "task-38.2", "task-38.2-run", "Keep cursor paging or switch to offsets?"],
    ]);
    const inbox = groupFactoryTaskNeeds(
      fixtures.tasks.map((task) => resolveFactoryTaskLiveState(task, fixtures.threadFacts)),
    );
    expect(inbox.blocking.map((need) => [need.displayId, need.reason])).toEqual([
      ["T-29", "failed"],
      ["T-39", "approve"],
      ["T-38.2", "question"],
    ]);
    expect(inbox.review.map((need) => [need.displayId, need.reason])).toEqual([
      ["T-36", "review"],
      ["T-33", "review"],
    ]);
    expect(inbox.count).toBe(5);
    expect(parent.liveRuns[0]?.pill).toBe(fixtures.threadFacts[0]?.pill);
    const failedChild = {
      ...task("T-38.2"),
      liveRuns: [],
      attention: [
        {
          taskId: "task-38.2",
          displayId: "T-38.2",
          reason: "failed" as const,
          detail: "Tests failed",
        },
      ],
    };
    const failedParent = { ...task("T-38"), liveRuns: [], attention: failedChild.attention };
    const failedNeeds = groupFactoryTaskNeeds([
      resolveFactoryTaskLiveState(failedParent, []),
      resolveFactoryTaskLiveState(failedChild, []),
    ]);
    expect(failedNeeds.count).toBe(1);
    expect(failedNeeds.rows[0]?.threadId).toBe(failedChild.run?.threadId);
  });
  it("keeps two reasons, orders failed before a pending approval, and ignores non-waiting requests", () => {
    const approval = task("T-39");
    const failed = {
      ...approval,
      attention: [
        {
          taskId: approval.ref.taskId,
          displayId: approval.displayId,
          reason: "failed" as const,
          detail: "Run failed",
        },
      ],
    };
    expect(
      resolveFactoryTaskLiveState(failed, fixtures.threadFacts).attention.map(
        (need) => need.reason,
      ),
    ).toEqual(["failed", "approve"]);
    expect(
      resolveFactoryTaskLiveState(
        failed,
        fixtures.threadFacts.map((fact) => ({ ...fact, waiting: false })),
      ).attention.map((need) => need.reason),
    ).toEqual(["failed"]);
    const reasons = [
      "review",
      "plan",
      "changed",
      "unconfirmed",
      "question",
      "approve",
      "failed",
    ] as const;
    const all = resolveFactoryTaskLiveState(
      {
        ...approval,
        attention: reasons.map((reason) => ({
          reason,
          taskId: approval.ref.taskId,
          displayId: approval.displayId,
          detail: reason,
        })),
      },
      [],
    );
    expect(all.attention.map((need) => need.reason)).toEqual([
      "failed",
      "approve",
      "question",
      "unconfirmed",
      "changed",
      "plan",
      "review",
    ]);
    expect(groupFactoryTaskNeeds([all]).count).toBe(7);
  });
});

describe("task drop rules", () => {
  const statuses: readonly FactoryTaskStatus[] = [
    "backlog",
    "ready",
    "in-progress",
    "in-review",
    "done",
    "canceled",
  ];
  const expected = [
    ["none", "move", "start", "refuse", "move", "move"],
    ["move", "none", "start", "refuse", "move", "move"],
    ["refuse", "refuse", "none", "refuse", "move", "move"],
    ["refuse", "refuse", "refuse", "none", "refuse", "move"],
    ["move", "move", "refuse", "refuse", "none", "move"],
    ["move", "move", "refuse", "refuse", "move", "none"],
  ];
  it.each(
    statuses.flatMap((from, row) =>
      statuses.map((to, column) => ({ from, to, expected: expected[row]![column] })),
    ),
  )("$from → $to", ({ from, to, expected }) => {
    expect(
      resolveFactoryTaskDrop(
        { ...task("T-45"), status: from, lane: from === "done" ? "done" : "backlog" },
        to,
      ).kind,
    ).toBe(expected);
  });
  it.each([
    ["T-41", "done", "run-active"],
    ["T-41", "canceled", "run-active"],
    ["T-36", "done", "invalid-transition"],
    ["T-38.1", "ready", "invalid-transition"],
    ["T-38.3", "in-progress", "blocked"],
  ] as const)("refuses %s → %s with %s", (id, target, reason) =>
    expect(resolveFactoryTaskDrop(task(id), target)).toEqual({ kind: "refuse", reason }),
  );
});

describe("task presentation", () => {
  it("uses catalog labels for unprofiled activity actors and keeps unknown labels", () => {
    const entry = {
      id: "actor",
      at: fixtures.at,
      actor: {
        kind: "agent" as const,
        label: "codex · gpt-6.1-sol",
        modelSelection: {
          instanceId: task("T-41").run!.setup.modelSelection.instanceId,
          model: "gpt-6.1-sol",
        },
      },
      event: { type: "plan-proposed" as const, count: 2 },
    };
    expect(presentFactoryTaskActivity(entry, fixtures.catalog)).toBe("Codex · Sol proposed a plan");
    expect(presentFactoryTaskActivity(entry, [])).toBe("codex · gpt-6.1-sol proposed a plan");
  });
  it("links a parent to its running descendant and reserves Stop for its own run", () => {
    const parent = task("T-38");
    const banner = presentFactoryTaskBanner({
      task: parent,
      attention: [],
      assigneeLabel: "Agent",
    });
    expect(banner.primary).toEqual({
      kind: "open-task",
      label: "Open T-38.2",
      taskId: "task-38.2",
    });
    const own = task("T-41");
    expect(
      presentFactoryTaskBanner({ task: own, attention: [], assigneeLabel: "Agent" }).primary,
    ).toEqual({ kind: "stop", label: "Stop" });
  });
  it.each([
    ["C1", "T-43", "backlog", "start", null],
    ["C2", "T-38.3", "blocked", "open-task", null],
    ["C3", "T-38", "plan", "approve-plan", "edit-plan"],
    ["C4", "T-38", "subtask-attention", "open-task", null],
    ["C5", "T-38.2", "question", "answer", null],
    ["C6", "T-36", "review", "accept", "request-changes"],
    ["C7", "T-38.1", "done", "merge", "check"],
    ["C8", "T-29", "failed", "retry", "reassign"],
    ["C9", "T-41", "working", "stop", null],
    ["C10", "T-39", "approval", "approve", "always-allow"],
  ])("resolves %s action semantics", (code, id, expectedState, primary, secondary) => {
    const item = task(id!);
    const attention =
      code === "C3"
        ? [
            {
              ref: item.ref,
              displayId: item.displayId,
              reason: "plan" as const,
              detail: "",
              threadId: null,
              requestId: null,
            },
          ]
        : state(id!).attention;
    const banner = presentFactoryTaskBanner({
      task: item,
      attention,
      assigneeLabel: "Agent",
      planCount: 4,
    });
    expect([banner.state, banner.primary?.kind ?? null, banner.secondary?.kind ?? null]).toEqual([
      expectedState,
      primary,
      secondary,
    ]);
    if (code === "C10") expect(banner.additional.map((action) => action.kind)).toEqual(["deny"]);
    if (code === "C4") expect(banner.primary?.taskId).toBe("task-38.2");
  });
  it.each([
    ["accepted, not published", null, null, "Accepted · rev 1", "+212 −48 · 7 files", "Publish"],
    [
      "publishing",
      null,
      { action: "publish", state: "sending", detail: null },
      "Accepted · rev 1",
      "Opening a pull request…",
      null,
    ],
    [
      "publish refused",
      null,
      { action: "publish", state: "failed", detail: "push failed: rejected" },
      "Accepted · rev 1",
      "Publish failed: push failed: rejected",
      "Publish",
    ],
    [
      "open",
      "open",
      null,
      "Accepted · rev 1",
      "PR #108 is open · +212 −48 · 7 files · checks pass",
      "Merge PR #108",
    ],
    [
      "merging",
      "open",
      { action: "merge", state: "sending", detail: null },
      "Accepted · rev 1",
      "Merging PR #108…",
      null,
    ],
    ["merged", "merged", null, "Accepted · PR #108 merged", "+212 −48 · 7 files", null],
  ] as const)(
    "walks an accepted code result through Publish and Merge: %s",
    (_name, pullRequest, delivery, title, detail, primary) => {
      const accepted = task("T-38.1");
      const banner = presentFactoryTaskBanner({
        task: {
          ...accepted,
          result: {
            ...accepted.result!,
            pullRequest:
              pullRequest === null
                ? null
                : { ...accepted.result!.pullRequest!, state: pullRequest },
            delivery,
          },
        },
        attention: [],
        assigneeLabel: "Agent",
        checks: "passing",
      });
      expect([banner.state, banner.title, banner.detail, banner.primary?.label ?? null]).toEqual([
        "done",
        title,
        detail,
        primary,
      ]);
    },
  );
  it("puts an unconfirmed send before Done and checks it, and records the pull request in activity", () => {
    const accepted = task("T-38.1");
    const banner = presentFactoryTaskBanner({
      task: accepted,
      attention: [
        {
          ref: accepted.ref,
          displayId: accepted.displayId,
          reason: "unconfirmed",
          detail: "Merge of PR #108 sent · outcome unknown",
          threadId: null,
          requestId: null,
        },
      ],
      assigneeLabel: "Agent",
    });
    expect([banner.state, banner.title, banner.detail, banner.primary?.kind]).toEqual([
      "unconfirmed",
      "Unconfirmed",
      "Merge of PR #108 sent · outcome unknown",
      "check",
    ]);
    const review = presentFactoryTaskBanner({
      task: task("T-36"),
      attention: state("T-36").attention,
      assigneeLabel: "Agent",
      checks: "passing",
    });
    expect([review.title, review.detail]).toEqual([
      "Result ready: PR #112",
      "+184 −20 · 6 files · checks pass",
    ]);
    expect(
      presentFactoryTaskActivity({
        id: "1",
        at: fixtures.at,
        actor: { kind: "person", label: "You" },
        event: {
          type: "pull-request",
          action: "merged",
          revision: 1,
          number: 108,
          url: "https://github.com/Codeseys-Labs/t3factory/pull/108",
        },
      }),
    ).toBe("PR #108 merged");
  });
  it.each([
    ["unassigned", "Unassigned", ""],
    ["person", "You", ""],
    ["auto", "Auto → Codex · Sol", "Cx"],
    ["profile", "Codex · Sol", "Cx"],
    ["pinned", "Codex · Sol", "Cx"],
  ] as const)("labels %s using the model catalog", (mode, label, monogram) => {
    const assigned = task("T-41").assignee;
    const assignment =
      mode === "profile"
        ? { mode, profileId: "implementer" }
        : mode === "pinned"
          ? { mode, setup: assigned.resolved!.setup }
          : { mode };
    expect(presentFactoryTaskAssignee({ ...assigned, assignment }, fixtures.catalog)).toMatchObject(
      { label, monogram },
    );
  });
  it("nests children even before their parents, leaves filtered orphans visible and scopes identities", () => {
    const parent = task("T-38");
    const child = task("T-38.2");
    const other = { ...child, ref: { ...child.ref, environmentId: EnvironmentId.make("other") } };
    expect(
      nestFactoryTasks([child, other, parent]).map(({ task, depth }) => [
        factoryTaskKey(task.ref),
        depth,
      ]),
    ).toEqual([
      [factoryTaskKey(other.ref), 0],
      [factoryTaskKey(parent.ref), 0],
      [factoryTaskKey(child.ref), 1],
    ]);
    expect(groupFactoryTasks([child, other], "project")).toHaveLength(2);
    expect(groupFactoryTasks([child, parent], "assignee")).toHaveLength(2);
    expect(nestFactoryTasks([child])).toMatchObject([{ depth: 0 }]);
    expect(
      nestFactoryTasks([
        { ...parent, parent: { taskId: child.ref.taskId, displayId: child.displayId } },
        child,
      ]),
    ).toHaveLength(2);
  });
});

describe("task URL", () => {
  it.each([
    undefined,
    null,
    42,
    {},
    "layout=table&group=__proto__",
    "layout=list&layout=board",
    "filters=%7Bbad",
    `filters=${encodeURIComponent(JSON.stringify({ statuses: ["invalid"] }))}`,
    `filters=${encodeURIComponent('{"statuses":["ready"],"__proto__":{"admin":true}}')}`,
    `peek=${encodeURIComponent(JSON.stringify({ environmentId: "evil" }))}`,
  ])("defaults hostile or partial input %s", (input) => {
    const decoded = decodeFactoryTaskViewState(input);
    expect(decoded).toEqual({ layout: "board", grouping: "status", filters: {}, peek: null });
  });
  it("round trips all filters and peek in a stable order", () => {
    const view = {
      layout: "list" as const,
      grouping: "assignee" as const,
      filters: {
        projectIds: [task("T-45").ref.projectId],
        statuses: ["ready", "backlog"] as const,
        types: ["bug"] as const,
        sourceKinds: ["issue"] as const,
        assigneeKeys: ["z", "a", "a"],
        text: "<script> & ?",
        scope: "all" as const,
      },
      peek: task("T-38.2").ref,
    };
    const encoded = encodeFactoryTaskViewState(view);
    const decoded = decodeFactoryTaskViewState(encoded);
    expect(decoded.filters.assigneeKeys).toEqual(["a", "z"]);
    expect(decoded.peek).toEqual(view.peek);
    expect(decoded.filters.text).toBe(view.filters.text);
    expect(encodeFactoryTaskViewState(decoded)).toBe(encoded);
    expect(decodeFactoryTaskViewState("layout=list").layout).toBe("list");
  });
});

describe("task owners", () => {
  const owner = (status: FactoryTaskOwner["status"], item = task("T-45")): FactoryTaskOwner => ({
    environmentId: item.ref.environmentId,
    status,
    pages: [
      {
        environmentId: item.ref.environmentId,
        items: [item],
        fetchedAt: fixtures.at,
        nextCursor: "more",
      },
    ],
    counts: {
      environmentId: item.ref.environmentId,
      byStatus: [{ status: "backlog", count: 100 }],
      fetchedAt: fixtures.at,
    },
    countsStatus: status,
    nextCursor: "more",
    capped: false,
  });
  it.each(["current", "loading", "offline", "unsupported", "forbidden", "failed"] as const)(
    "preserves %s as an owner state",
    (status) => {
      const aggregate = aggregateFactoryTasks([owner(status)]);
      expect(aggregate.owners[0]?.status).toBe(status);
      expect(aggregate.incomplete).toBe(true);
      expect(aggregate.items).toHaveLength(
        status === "forbidden" || status === "unsupported" ? 0 : 1,
      );
      if (aggregate.items[0]) expect(aggregate.items[0].stale).toBe(status !== "current");
      expect(aggregate.byStatus.backlog).toBe(
        status === "forbidden" || status === "unsupported" ? 0 : 100,
      );
    },
  );
  it("merges newest updates, deduplicates pages and uses server counts", () => {
    const other = {
      ...task("T-44"),
      ref: { ...task("T-44").ref, environmentId: EnvironmentId.make("other") },
      updatedAt: "2026-11-10T17:00:00.000Z",
    };
    const first = owner("current");
    const combined = aggregateFactoryTasks([
      { ...first, pages: [...first.pages, ...first.pages], capped: true },
      owner("current", other),
    ]);
    expect(combined.items.map((entry) => entry.task.displayId)).toEqual(["T-44", "T-45"]);
    expect(combined.byStatus.backlog).toBe(200);
    expect(combined.more.map((entry) => entry.available)).toEqual([false, true]);
    expect(
      planFactoryTaskOwners({
        environmentIds: [fixtures.environmentId, fixtures.environmentId],
        projects: [],
      }),
    ).toEqual([{ environmentId: fixtures.environmentId, projectIds: [] }]);
  });
});

it("shares contract-valid design fixtures", () => {
  expect(fixtures.tasks.every(Schema.is(FactoryTaskSummary))).toBe(true);
  expect(fixtures.profiles.every(Schema.is(FactoryAgentProfile))).toBe(true);
  expect(intake.arrivals.every(Schema.is(FactoryIntakeArrival))).toBe(true);
  expect(intake.sources.every(Schema.is(FactoryIntakeSource))).toBe(true);
  expect(intake.rules.every(Schema.is(FactoryIntakeRule))).toBe(true);
});
