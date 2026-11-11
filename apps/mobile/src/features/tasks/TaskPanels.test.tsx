import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import {
  resolveFactoryTaskLiveState,
  type FactoryTaskThreadFacts,
} from "@t3tools/client-runtime/state/factory-task-view";
import {
  EnvironmentId,
  type FactoryTaskSummary,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const routeMocks = vi.hoisted(() => ({ detail: vi.fn(), dispatch: vi.fn() }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: (name: string, params: unknown) => ({ name, params }) },
  useNavigation: () => ({ dispatch: routeMocks.dispatch, goBack: vi.fn() }),
}));
vi.mock("../../state/factoryTasks", () => ({
  useFactoryTaskDetailByDisplayId: routeMocks.detail,
  useFactoryTaskActivity: () => AsyncResult.success({ entries: [] }),
  useFactoryTaskCatalogs: () => new Map(),
  useFactoryTaskEntries: (tasks: readonly FactoryTaskSummary[]) =>
    tasks.map((task) => ({
      task,
      live: resolveFactoryTaskLiveState(task, []),
    })),
  useFactoryTaskRequests: () => ({ approvals: [], userInputs: [] }),
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => Date.parse(FACTORY_TASK_FIXTURES.at) }));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
  }) => (
    <button
      aria-label={accessibilityLabel}
      aria-pressed={accessibilityState?.selected}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <div role="progressbar" />,
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({ title }: { title: string }) => <h2>{title}</h2>,
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: {
    accessibilityLabel?: string;
    value?: string;
    editable?: boolean;
    onChangeText?: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      disabled={props.editable === false}
      value={props.value}
      onChange={(event) => props.onChangeText?.(event.target.value)}
    />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));

const { TaskApprovalPanel, TaskQuestionPanel } = await import("./TaskPanels");
const { resolveTaskAsk } = await import("./taskAsk");
const { TaskRouteScreen } = await import("./TaskRouteScreen");

const { tasks, threadFacts } = FACTORY_TASK_FIXTURES;
const frame = {
  displayId: "T-38.2",
  title: "Move the list API to tasks",
  assignee: { label: "Codex · Sol", monogram: "Cx" },
  lines: [],
  onBack: () => {},
};

function askOf(displayId: string, edit?: (fact: FactoryTaskThreadFacts) => FactoryTaskThreadFacts) {
  const task = tasks.find((entry) => entry.displayId === displayId)!;
  const facts = threadFacts.map((fact) => (edit ? edit(fact) : fact));
  const live = resolveFactoryTaskLiveState(task, facts);
  const requests = facts.find((fact) => fact.threadId === live.attention[0]?.threadId)!.requests!;
  return resolveTaskAsk({ task, attention: live.attention, requests })!;
}

const requests = (canRespond = true) => ({
  canRespond,
  answer: vi.fn(() => Promise.resolve({ _tag: "Success" as const })),
  approveOnce: vi.fn(() => Promise.resolve({ _tag: "Success" as const })),
  alwaysAllow: vi.fn(() => Promise.resolve({ _tag: "Success" as const })),
  deny: vi.fn(() => Promise.resolve({ _tag: "Success" as const })),
});
type Requests = ReturnType<typeof requests>;

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  onTestFinished(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return {
    button: (name: string) =>
      [...host.querySelectorAll("button")].find(
        (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
      ) as HTMLButtonElement | undefined,
    input: () => host.querySelector("input") as HTMLInputElement,
    text: () => host.textContent ?? "",
  };
}

const click = (button: HTMLButtonElement | undefined) =>
  act(async () => {
    button?.click();
  });

async function mountQuestion(r: Requests, onDone = vi.fn()) {
  const ask = askOf("T-38.2");
  if (ask.kind !== "question") throw new Error("expected a question");
  const screen = await mount(
    <TaskQuestionPanel
      {...frame}
      ask={ask}
      agentLabel="Codex · Sol"
      requests={r as never}
      onDone={onDone}
    />,
  );
  return { screen, onDone };
}

describe("TaskQuestionPanel", () => {
  it("sends the chosen option as the answer and returns to the list", async () => {
    const r = requests();
    const { screen, onDone } = await mountQuestion(r);
    expect(screen.text()).toContain("Keep cursor paging or switch to offsets?");
    expect(screen.button("Send answer")!.disabled).toBe(true);
    await click(screen.button("Switch to offsets"));
    expect(screen.button("Switch to offsets")!.getAttribute("aria-pressed")).toBe("true");
    await click(screen.button("Send answer"));
    expect(r.answer).toHaveBeenCalledExactlyOnceWith("question-paging", {
      paging: "Switch to offsets",
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("sends typed text as the answer and clears the chosen option", async () => {
    const r = requests();
    const { screen } = await mountQuestion(r);
    await click(screen.button("Keep cursor paging"));
    await act(async () => {
      const input = screen.input();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Offsets for the public API only",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(screen.button("Keep cursor paging")!.getAttribute("aria-pressed")).toBe("false");
    await click(screen.button("Send answer"));
    expect(r.answer).toHaveBeenCalledExactlyOnceWith("question-paging", {
      paging: "Offsets for the public API only",
    });
  });

  it.each([
    { result: undefined, note: "This question can't be answered from here." },
    { result: { _tag: "Failure" }, note: "Your answer wasn't sent. Try again." },
  ])("stays on the task and says why when the answer is not taken", async ({ result, note }) => {
    const r = requests();
    r.answer.mockResolvedValueOnce(result as never);
    const { screen, onDone } = await mountQuestion(r);
    await click(screen.button("Keep cursor paging"));
    await click(screen.button("Send answer"));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.text()).toContain(note);
  });

  it("does not send without permission to respond", async () => {
    const r = requests(false);
    const { screen } = await mountQuestion(r);
    await click(screen.button("Keep cursor paging"));
    expect(screen.button("Send answer")!.disabled).toBe(true);
    expect(r.answer).not.toHaveBeenCalled();
  });
});

async function mountApproval(r: Requests, options?: ProviderApprovalOption[], onDone = vi.fn()) {
  const ask = askOf("T-39", (fact) =>
    options && fact.requests
      ? {
          ...fact,
          requests: {
            ...fact.requests,
            approvals: fact.requests.approvals.map((approval) => ({ ...approval, options })),
          },
        }
      : fact,
  );
  if (ask.kind !== "approval") throw new Error("expected an approval");
  const screen = await mount(
    <TaskApprovalPanel
      {...frame}
      displayId="T-39"
      title="Backtest the momentum signal"
      ask={ask}
      requests={r as never}
      onDone={onDone}
    />,
  );
  return { screen, onDone };
}

describe("TaskApprovalPanel", () => {
  it("shows what wants to run and sends each decision for that request", async () => {
    const r = requests();
    const { screen, onDone } = await mountApproval(r);
    expect(screen.text()).toContain("Wants to run");
    expect(screen.text()).toContain("python backtest.py --full");
    await click(screen.button("Approve once"));
    await click(screen.button("Always allow for this task"));
    await click(screen.button("Deny"));
    expect(r.approveOnce).toHaveBeenCalledExactlyOnceWith("approval-backtest");
    expect(r.alwaysAllow).toHaveBeenCalledExactlyOnceWith("approval-backtest");
    expect(r.deny).toHaveBeenCalledExactlyOnceWith("approval-backtest");
    expect(onDone).toHaveBeenCalledTimes(3);
  });

  it.each([
    { result: undefined, note: "This request can't be answered from here." },
    { result: { _tag: "Failure" }, note: "Your response wasn't sent. Try again." },
  ])("stays on the task and says why when the decision is not taken", async ({ result, note }) => {
    const r = requests();
    r.approveOnce.mockResolvedValueOnce(result as never);
    const { screen, onDone } = await mountApproval(r);
    await click(screen.button("Approve once"));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.text()).toContain(note);
  });

  it("offers only the decisions the provider lists", async () => {
    const { screen } = await mountApproval(requests(), [
      { decision: "accept", label: "Allow" },
      { decision: "decline", label: "Deny" },
    ]);
    expect(screen.button("Always allow for this task")).toBeUndefined();
    expect(screen.button("Approve once")!.disabled).toBe(false);
  });

  it("does not answer without permission to respond", async () => {
    const r = requests(false);
    const { screen } = await mountApproval(r);
    await click(screen.button("Approve once"));
    expect(r.approveOnce).not.toHaveBeenCalled();
    expect(screen.button("Approve once")!.disabled).toBe(true);
    expect(screen.button("Deny")!.disabled).toBe(true);
  });
});

it("opens a normally running sub-task from its parent's banner", async () => {
  routeMocks.dispatch.mockReset();
  const parent = tasks.find((task) => task.displayId === "T-38")!;
  const task = { ...parent, attention: [], liveRuns: parent.liveRuns, blockedBy: [] };
  routeMocks.detail.mockReturnValue({
    result: AsyncResult.success({ task }),
    refresh: vi.fn(),
    status: "current",
  });
  const screen = await mount(
    <TaskRouteScreen
      route={{ params: { environmentId: task.ref.environmentId, displayId: task.displayId } }}
    />,
  );
  expect(screen.button("Open T-38.2")).toBeDefined();
  await click(screen.button("Open T-38.2"));
  expect(routeMocks.dispatch).toHaveBeenCalledExactlyOnceWith({
    name: "Task",
    params: { environmentId: task.ref.environmentId, displayId: "T-38.2" },
  });
});

it.each(["forbidden", "offline", "unsupported"] as const)(
  "shows the owning connection's %s state for a task link",
  async (status) => {
    routeMocks.detail.mockReset();
    routeMocks.detail.mockReturnValue({
      result: AsyncResult.initial(false),
      refresh: vi.fn(),
      status,
    });
    const environmentId = EnvironmentId.make("other-owner");
    const screen = await mount(
      <TaskRouteScreen route={{ params: { environmentId, displayId: "T-99" } }} />,
    );
    expect(screen.text()).toContain(
      status === "forbidden" ? "No access" : status === "offline" ? "Offline" : "Update the server",
    );
    expect(routeMocks.detail).toHaveBeenCalledWith(environmentId, "T-99");
  },
);
