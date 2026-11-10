import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../state/factory", () => ({
  factoryEnvironment: {
    listPlans: (target: object) => ({ kind: "list", target }),
    readPlan: (target: object) => ({ kind: "read", target }),
    readExecution: (target: object) => ({ kind: "execution", target }),
    readExecutionOutputs: (target: object) => ({ kind: "outputs", target }),
    readExecutionOutput: (target: object) => ({ kind: "output", target }),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { kind: string; target: { input: { revision?: number } } }) => ({
    data: !query
      ? null
      : query.kind === "list"
        ? { items: [{ ref, title: "Parent", revision: 3 }], nextRootId: null }
        : query.kind === "execution"
          ? {
              currentRevision: 3,
              tasks: [{ taskId: "child", status: "sealed", hold: null, binding: null }],
            }
          : query.kind === "outputs"
            ? {
                items: [{ resultId: "result", slot: "draft", status: "sealed" }],
                nextBeforeResultId: null,
              }
            : query.kind === "output"
              ? {
                  text: "Protected full child result",
                  output: { kind: "sealed-draft", status: "sealed", digest: "digest" },
                  binding: {
                    driver: "codex",
                    spec: { modelSelection: { model: "model", instanceId: "provider" } },
                    selection: { ref },
                    threadId: "thread",
                    runId: "run",
                    runAttemptId: "attempt",
                  },
                }
              : {
                  ref,
                  revision: query.target.input.revision,
                  tasks: [
                    {
                      id: "root",
                      parentId: null,
                      title: "Parent",
                      context: "Parent context",
                      retired: false,
                    },
                    {
                      id: "child",
                      parentId: "root",
                      title: "Child",
                      context: "Child context",
                      retired: false,
                    },
                  ],
                },
    error: null,
    refresh: vi.fn(),
    failure: null,
  }),
}));

import { FactoryLocalPlans } from "./FactoryLocalPlans";
import type { EnvironmentPresentation } from "../../state/environments";

const ref = {
  environmentId: EnvironmentId.make("owner"),
  projectId: ProjectId.make("project"),
  rootId: "root",
};
const environment = {
  connection: { phase: "connected" },
  serverConfig: { environment: { capabilities: { factoryPlans: true, factoryExecution: true } } },
} as unknown as EnvironmentPresentation;

it("returns from a child to the pinned parent and removes protected content on read revocation", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  onTestFinished(() => act(() => root.unmount()));
  const render = (canRead: boolean) =>
    act(() =>
      root.render(
        <FactoryLocalPlans
          environmentId={ref.environmentId}
          projectId={ref.projectId}
          environment={environment}
          canRead={canRead}
        />,
      ),
    );
  const press = (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    if (!button) throw new Error(`Missing ${label}`);
    act(() => button.click());
  };
  render(true);
  press("Local tasks");
  press("Parent · revision 3");
  press("Read Child");
  expect(container.textContent).toContain("Child context");
  expect(container.textContent).toContain("Revision 3");
  press("Read draft · sealed");
  expect(container.textContent).toContain("Protected full child result");
  expect(container.textContent).toContain("harness codex");
  press("Back to results");
  press("Return to parent task");
  expect(container.textContent).toContain("Parent context");
  expect(container.textContent).toContain("Revision 3");
  render(false);
  expect(container.textContent).not.toContain("Parent context");
  expect(container.textContent).not.toContain("Protected full child result");
  render(true);
  expect(container.textContent).not.toContain("Parent context");
});
