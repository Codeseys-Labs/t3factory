import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { TaskAsk } from "./TaskAsk";

const state = vi.hoisted(() => ({
  requests: { approvals: [], userInputs: [] } as PendingThreadRequests,
  answer: (() => {}) as (...args: unknown[]) => unknown,
  approveOnce: (() => {}) as (...args: unknown[]) => unknown,
  alwaysAllow: (() => {}) as (...args: unknown[]) => unknown,
  deny: (() => {}) as (...args: unknown[]) => unknown,
}));

vi.mock(import("../../../state/factoryTasks"), () => ({
  useFactoryTaskRequests: (() => ({
    ...state.requests,
    question: state.requests.userInputs[0] ?? null,
    approval: state.requests.approvals[0] ?? null,
    canRespond: true,
    answer: state.answer,
    approveOnce: state.approveOnce,
    alwaysAllow: state.alwaysAllow,
    deny: state.deny,
  })) as never,
}));

const success = () => Promise.resolve(AsyncResult.success(undefined));
const facts = (threadId: string) =>
  FACTORY_TASK_FIXTURES.threadFacts.find((fact) => fact.threadId === threadId)!.requests!;

function setup(requests: PendingThreadRequests) {
  state.requests = requests;
  state.answer = vi.fn(success);
  state.approveOnce = vi.fn(success);
  state.alwaysAllow = vi.fn(success);
  state.deny = vi.fn(success);
  return state;
}

const ask = (
  <TaskAsk
    environmentId={FACTORY_TASK_FIXTURES.environmentId}
    threadId={ThreadId.make("task-38.2-run")}
    from="Codex · Sol"
  />
);

it("sends the chosen option as the answer", async () => {
  const mocks = setup(facts("task-38.2-run"));
  await using screen = await render(ask);
  await userEvent.click(screen.getByRole("button", { name: "Keep cursor paging" }));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(mocks.answer).toHaveBeenCalledExactlyOnceWith(RuntimeRequestId.make("question-paging"), {
    paging: "Keep cursor paging",
  });
});

it("sends a typed reply as text", async () => {
  const mocks = setup(facts("task-38.2-run"));
  await using screen = await render(ask);
  await userEvent.type(screen.getByRole("textbox", { name: "Reply" }), "Use keyset paging{Enter}");
  expect(mocks.answer).toHaveBeenCalledExactlyOnceWith(RuntimeRequestId.make("question-paging"), {
    paging: "Use keyset paging",
  });
});

it("asks several questions in order and sends one answer set", async () => {
  const request = facts("task-38.2-run").userInputs[0]!;
  const mocks = setup({
    approvals: [],
    userInputs: [
      {
        ...request,
        questions: [
          ...request.questions,
          {
            id: "size",
            header: "Size",
            question: "How many rows per page?",
            multiSelect: false,
            options: [
              { label: "50", description: "Fifty." },
              { label: "100", description: "One hundred." },
            ],
          },
        ],
      },
    ],
  });
  await using screen = await render(ask);
  await userEvent.click(screen.getByRole("button", { name: "Switch to offsets" }));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await expect.element(screen.getByText("How many rows per page? (2 of 2)")).toBeVisible();
  expect(mocks.answer).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "100" }));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(mocks.answer).toHaveBeenCalledExactlyOnceWith(RuntimeRequestId.make("question-paging"), {
    paging: "Switch to offsets",
    size: "100",
  });
});

it.each([
  { button: "Approve once", call: "approveOnce" },
  { button: "Always allow for this task", call: "alwaysAllow" },
  { button: "Deny", call: "deny" },
] as const)("$button sends its decision", async ({ button, call }) => {
  const mocks = setup(facts("task-39-run"));
  await using screen = await render(ask);
  await expect.element(screen.getByText("python backtest.py --full")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: button }));
  expect(mocks[call]).toHaveBeenCalledExactlyOnceWith(RuntimeRequestId.make("approval-backtest"));
  for (const other of ["approveOnce", "alwaysAllow", "deny"] as const)
    if (other !== call) expect(mocks[other]).not.toHaveBeenCalled();
});

it("renders nothing while nothing waits", async () => {
  setup({ approvals: [], userInputs: [] });
  await using screen = await render(ask);
  expect(screen.container.textContent).toBe("");
});
