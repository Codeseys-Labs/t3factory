import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import { FactoryTaskError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { toastManager } from "../../ui/toast";
import { useTaskActions } from "./taskActions";

const state = vi.hoisted(() => ({
  update: [] as unknown[],
  accept: [] as unknown[],
  updateReplies: [] as unknown[],
  acceptReplies: [] as unknown[],
}));

vi.mock(import("../../../state/factoryTasks"), async () => {
  const { Atom } = await import("effect/reactivity");
  const command = (calls: unknown[], replies: unknown[]) => ({
    label: "test",
    run: (_registry: unknown, target: unknown) => {
      calls.push(target);
      return Promise.resolve(replies.shift());
    },
    permissionAtom: () => Atom.make(true),
  });
  return {
    factoryTasks: {
      updateTask: command(state.update, state.updateReplies),
      acceptTaskResult: command(state.accept, state.acceptReplies),
    },
  } as never;
});

const conflict = () =>
  AsyncResult.failure(
    Cause.fail(new FactoryTaskError({ reason: "version-conflict", currentVersion: 7 })),
  );
const refused = (reason: FactoryTaskError["reason"]) =>
  AsyncResult.failure(Cause.fail(new FactoryTaskError({ reason })));
const ok = () => AsyncResult.success({ replayed: false });

function setup(replies: { update?: unknown[]; accept?: unknown[] }) {
  state.update.length = 0;
  state.accept.length = 0;
  state.updateReplies.splice(0, Infinity, ...(replies.update ?? []));
  state.acceptReplies.splice(0, Infinity, ...(replies.accept ?? []));
}

const task = FACTORY_TASK_FIXTURES.tasks.find((entry) => entry.displayId === "T-36")!;

function Harness() {
  const actions = useTaskActions();
  return (
    <>
      <button type="button" onClick={() => void actions.setLane(task, "done")}>
        Done
      </button>
      <button type="button" onClick={() => void actions.accept(task, 1)}>
        Accept
      </button>
    </>
  );
}

const inputOf = (call: unknown) => (call as { input: Record<string, unknown> }).input;

it("shows a refusal's sentence", async () => {
  setup({ update: [refused("run-active")] });
  using toast = vi.spyOn(toastManager, "add");
  await using screen = await render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith({ type: "error", title: "Stop the run first." }),
  );
  expect(state.update).toHaveLength(1);
});

it("retries an update once with the current version", async () => {
  setup({ update: [conflict(), ok()] });
  using toast = vi.spyOn(toastManager, "add");
  await using screen = await render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  await vi.waitFor(() => expect(state.update).toHaveLength(2));
  const [first, second] = state.update.map(inputOf);
  expect(first).toMatchObject({ lane: "done", expectedVersion: task.version });
  expect(second).toMatchObject({ lane: "done", expectedVersion: 7 });
  expect(second?.commandId).not.toBe(first?.commandId);
  expect(toast).not.toHaveBeenCalled();
});

it("retries an update no more than once", async () => {
  setup({ update: [conflict(), conflict()] });
  using toast = vi.spyOn(toastManager, "add");
  await using screen = await render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith({
      type: "error",
      title: "Someone else changed this. Try again.",
    }),
  );
  expect(state.update).toHaveLength(2);
});

it("does not retry accept on a version conflict", async () => {
  setup({ accept: [conflict()] });
  using toast = vi.spyOn(toastManager, "add");
  await using screen = await render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Accept" }));
  await vi.waitFor(() => expect(toast).toHaveBeenCalledOnce());
  expect(state.accept).toHaveLength(1);
  expect(inputOf(state.accept[0])).toMatchObject({ ref: task.ref, revision: 1 });
});
