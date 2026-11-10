import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import { resolveFactoryTaskLiveState } from "@t3tools/client-runtime/state/factory-task-view";
import {
  EnvironmentAuthorizationError,
  type FactoryTaskAttentionReason,
  FactoryTaskError,
  type FactoryTaskSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskErrorMessage } from "./taskErrors";
import { resolveTaskStateMark, type TaskLivePill } from "./taskStateMark";

const fixture = (displayId: string) =>
  FACTORY_TASK_FIXTURES.tasks.find((task) => task.displayId === displayId)!;
const working: TaskLivePill = { label: "Working", tone: "working", duration: "13m" };
const needs = (task: FactoryTaskSummary, withThreads = true) =>
  resolveFactoryTaskLiveState(task, withThreads ? FACTORY_TASK_FIXTURES.threadFacts : []).attention;
const withAttention = (reason: FactoryTaskAttentionReason): FactoryTaskSummary => ({
  ...fixture("T-42"),
  attention: [{ reason, taskId: "task-42", displayId: "T-42", detail: "" }],
});

describe("resolveTaskStateMark", () => {
  it.each([
    {
      name: "a live run shows its pill even while a need waits",
      input: { pill: working, needs: needs(fixture("T-29")), blockedBy: [] },
      expected: { kind: "live", pill: working },
    },
    ...(["failed", "review", "plan", "changed", "unconfirmed"] as const).map((reason) => ({
      name: `${reason} shows its Needs-you badge`,
      input: { pill: null, needs: needs(withAttention(reason)), blockedBy: [] },
      expected: { kind: "needs", reason },
    })),
    {
      name: "a pending approval shows Approve",
      input: { pill: null, needs: needs(fixture("T-39")), blockedBy: [] },
      expected: { kind: "needs", reason: "approve" },
    },
    {
      name: "a waiting question shows Question",
      input: { pill: null, needs: needs(fixture("T-38.2")), blockedBy: [] },
      expected: { kind: "needs", reason: "question" },
    },
    {
      name: "a parent carries its sub-task's question",
      input: { pill: null, needs: needs(fixture("T-38")), blockedBy: [] },
      expected: { kind: "needs", reason: "question" },
    },
    {
      name: "the most urgent reason wins",
      input: {
        pill: null,
        needs: [{ reason: "failed" as const }, { reason: "review" as const }],
        blockedBy: [],
      },
      expected: { kind: "needs", reason: "failed" },
    },
    {
      name: "a blocked task without needs shows its first blocker",
      input: { pill: null, needs: [], blockedBy: fixture("T-38.3").blockedBy },
      expected: { kind: "blocked", blockerId: "T-38.2" },
    },
    {
      name: "a quiet task shows nothing",
      input: { pill: null, needs: needs(fixture("T-42")), blockedBy: [] },
      expected: null,
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveTaskStateMark(input)).toEqual(expected);
  });
});

describe("taskErrorMessage", () => {
  it.each([
    {
      error: new FactoryTaskError({ reason: "run-active" }),
      task: null,
      text: "Stop the run first.",
    },
    {
      error: new FactoryTaskError({ reason: "blocked" }),
      task: fixture("T-38.3"),
      text: "This task waits on T-38.2.",
    },
    {
      error: new FactoryTaskError({ reason: "invalid-transition" }),
      task: fixture("T-36"),
      text: "Accept the result first.",
    },
    {
      error: new FactoryTaskError({ reason: "invalid-transition" }),
      task: fixture("T-38.1"),
      text: "Reopen the task first.",
    },
    {
      error: new EnvironmentAuthorizationError({
        requiredScope: "orchestration:operate",
        message: "denied",
      }),
      task: null,
      text: "Ask the owner of this environment for access.",
    },
    { error: new Error("boom"), task: null, text: "Something went wrong. Try again." },
  ])("$text", ({ error, task, text }) => {
    expect(taskErrorMessage(error, { task })).toBe(text);
  });
});
