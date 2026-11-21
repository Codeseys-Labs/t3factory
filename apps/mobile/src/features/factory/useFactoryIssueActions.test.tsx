import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type FactoryIssue,
  type FactoryRepository,
} from "@t3tools/contracts";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

import type { FactoryIssueAction } from "./factoryIssues";
import type { FactoryIssueReview, FactoryStartSettings } from "./useFactoryIssueActions";

const harness = vi.hoisted(() => ({
  calls: [] as Array<string>,
  startInputs: [] as Array<Record<string, unknown>>,
  readIssue: null as FactoryIssue | null,
  alerts: [] as Array<{ readonly title: string; readonly detail: string }>,
  openedThreads: [] as Array<unknown>,
  review: null as FactoryIssueReview | null,
  perform: null as ((issue: FactoryIssue, action: FactoryIssueAction) => void) | null,
  confirmReview: null as (() => void) | null,
}));

vi.mock("@effect/atom-react", async () => {
  const { createContext } = await import("react");
  return {
    RegistryContext: createContext({ refresh: vi.fn(), get: vi.fn(), set: vi.fn() }),
    useAtomValue: () => false,
    useAtomRefresh: () => vi.fn(),
  };
});
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>();
  return {
    ...actual,
    executeAtomQuery: async () => {
      harness.calls.push("read");
      const issue = harness.readIssue;
      if (issue === null)
        return { _tag: "Failure", cause: { _tag: "Fail", error: new Error("read failed") } };
      return { _tag: "Success", value: { issue } };
    },
  };
});
vi.mock("../../lib/uuid", () => {
  let counter = 0;
  return { uuidv4: () => `command-${++counter}` };
});
vi.mock("../../state/factory", () => ({
  factoryEnvironment: {
    start: { permissionAtom: () => null },
    readIssue: (target: unknown) => target,
  },
  factoryAcceptanceSupportedAtom: () => null,
  factoryDeliverySupportedAtom: () => null,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async (request: { input: Record<string, unknown> & { expectedIssueRevision: string } }) => {
      harness.calls.push(`start:${request.input.expectedIssueRevision}`);
      harness.startInputs.push(request.input);
      return { _tag: "Success", value: { threadId: ThreadId.make("thread-1") } };
    },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (title: string, detail: string) => {
    harness.alerts.push({ title, detail });
  },
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => (detail: unknown) => {
    harness.openedThreads.push(detail);
  },
}));

import { useFactoryIssueActions } from "./useFactoryIssueActions";

const repository: FactoryRepository = {
  provider: SourceControlProviderKind.make("github"),
  host: "github.com",
  repository: "owner/name",
  canonicalKey: "github.com/owner/name",
  url: "https://github.com/owner/name",
};

const settings: FactoryStartSettings = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("project"),
  repository,
  displayName: "GitHub",
  factoryIssueKeys: false,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  modelLabel: "gpt-5.1-codex",
  baseRef: null,
  runtimeMode: "approval-required",
};

const issue = (overrides: Partial<FactoryIssue>): FactoryIssue => ({
  number: 7,
  title: "Row title",
  body: null,
  state: "open",
  url: "https://github.com/owner/name/issues/7",
  labels: [],
  updatedAt: "2026-11-20T00:00:00.000Z",
  revision: "row-revision",
  task: null,
  ...overrides,
});

function Probe({ startSettings }: { readonly startSettings: FactoryStartSettings }) {
  const actions = useFactoryIssueActions({
    settings: startSettings,
    scopeKey: "scope",
    onSettled: () => {},
  });
  useEffect(() => {
    harness.perform = actions.perform;
    harness.confirmReview = actions.confirmReview;
    harness.review = actions.review;
  });
  return null;
}

function mount(startSettings: FactoryStartSettings = settings) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  onTestFinished(() => act(() => root.unmount()));
  act(() => root.render(<Probe startSettings={startSettings} />));
}

it("start reads the issue first: the review shows the read body and the launch pins the read revision", async () => {
  harness.calls = [];
  harness.openedThreads = [];
  mount();
  harness.readIssue = issue({
    title: "Read title",
    body: "Full body from the read",
    revision: "read-revision",
  });

  await act(async () => {
    harness.perform?.(issue({}), { kind: "start", label: "Start task" });
  });

  expect(harness.calls).toEqual(["read"]);
  expect(harness.review?.snapshot.titleText).toBe("Read title");
  expect(harness.review?.snapshot.bodyText).toBe("Full body from the read");
  expect(harness.review?.snapshot.request.input.expectedIssueRevision).toBe("read-revision");

  await act(async () => {
    harness.confirmReview?.();
  });

  expect(harness.calls).toEqual(["read", "start:read-revision"]);
  expect(harness.openedThreads).toHaveLength(1);
  expect(harness.review).toBeNull();
});

it("restart reads the issue first and marks the attempt as a restart", async () => {
  harness.calls = [];
  mount();
  harness.readIssue = issue({ body: "Read body", revision: "read-revision" });

  await act(async () => {
    harness.perform?.(issue({}), { kind: "restart", label: "Start new attempt" });
  });

  expect(harness.calls).toEqual(["read"]);
  expect(harness.review?.snapshot.request.input.restartDeleted).toBe(true);
  expect(harness.review?.snapshot.request.input.expectedIssueRevision).toBe("read-revision");
});

it("resume launches from the row without reading the issue again", async () => {
  harness.calls = [];
  mount();
  harness.readIssue = issue({ revision: "read-revision" });
  const launching = issue({
    task: {
      projectId: ProjectId.make("project"),
      threadId: ThreadId.make("thread-1"),
      status: "launching",
      baseRef: "0123456789abcdef",
      createdAt: "2026-11-20T00:00:00.000Z",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
      runtimeMode: "approval-required",
      interactionMode: "default",
    },
  });

  await act(async () => {
    harness.perform?.(launching, { kind: "resume", label: "Resume launch" });
  });

  expect(harness.calls).toEqual(["start:row-revision"]);
  expect(harness.review).toBeNull();
});

it("start addresses a number-less issue by native key when the server reads keys", async () => {
  harness.calls = [];
  harness.startInputs = [];
  mount({ ...settings, factoryIssueKeys: true });
  harness.readIssue = issue({
    number: null,
    key: "ENG-7",
    tracker: IssueTrackerKind.make("linear"),
    body: "Linear body from the read",
    revision: "read-revision",
  });

  await act(async () => {
    harness.perform?.(issue({ number: null, key: "ENG-7" }), {
      kind: "start",
      label: "Start task",
    });
  });

  expect(harness.calls).toEqual(["read"]);
  expect(harness.review?.snapshot.bodyText).toBe("Linear body from the read");

  await act(async () => {
    harness.confirmReview?.();
  });

  expect(harness.calls).toEqual(["read", "start:read-revision"]);
  expect(harness.startInputs[0]?.["key"]).toBe("ENG-7");
  expect(harness.startInputs[0]?.["issueNumber"]).toBeUndefined();
});
