import type { ReactNode } from "react";
import * as Cause from "effect/Cause";
import { EnvironmentId, ProjectId, type FactoryPlanSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ input: { commandId: string } }>,
  fail: true,
}));
vi.mock("../../state/factory", async () => {
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(true);
  const command = (name: string) => ({ name, permissionAtom: () => permission });
  return {
    factoryEnvironment: {
      readExecution: () => "execution",
      readPreparationHistory: () => "history",
      issueExecutionGrant: command("grant"),
      revokeExecutionGrant: command("revoke"),
      admitExecution: command("start"),
      retryExecution: command("retry"),
      stopExecution: command("stop"),
      acceptPreparation: command("accept"),
      reopenPreparation: command("reopen"),
    },
  };
});
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "owner", id: "project" }],
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (name: string) => ({
    data:
      name === "execution"
        ? {
            currentRevision: 1,
            grant: null,
            tasks: [],
            assembly: null,
            acceptance: null,
            reopened: false,
          }
        : { items: [] },
    error: null,
    isSuccess: true,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    (command: { name: string }) => async (value: { input: { commandId: string } }) => {
      if (command.name === "grant") harness.calls.push(value);
      return harness.fail
        ? { _tag: "Failure", cause: Cause.fail(new Error("response lost")) }
        : { _tag: "Success", value: {} };
    },
}));
vi.mock("./FactoryExecutionPolicyEditor", () => ({
  FactoryExecutionPolicyEditor: ({ onGrant }: { onGrant: (policy: object) => void }) => (
    <button onClick={() => onGrant({ version: 1 })}>Grant fixture</button>
  ),
}));
vi.mock("../ui/button", () => ({
  buttonVariants: () => "",
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/textarea", () => ({ Textarea: () => <textarea /> }));

import { FactoryExecutionPanel } from "./FactoryExecutionPanel";

it("retries an uncertain grant with the same command rather than creating another grant", async () => {
  harness.calls = [];
  harness.fail = true;
  const plan: FactoryPlanSnapshot = {
    ref: {
      environmentId: EnvironmentId.make("owner"),
      projectId: ProjectId.make("project"),
      rootId: "root",
    },
    revision: 1,
    tasks: [{ id: "root", parentId: null, title: "Note", context: "", order: 0, retired: false }],
    edges: [],
    workContexts: [],
    editorThreadIds: [],
    createdAt: "2026-11-05T00:00:00Z",
    updatedAt: "2026-11-05T00:00:00Z",
  };
  await using screen = await render(<FactoryExecutionPanel plan={plan} />, { router: "/factory" });
  await userEvent.click(screen.getByText("Configure an execution grant"));
  await userEvent.click(screen.getByRole("button", { name: "Grant fixture" }));
  await expect.element(screen.getByText(/outcome may be uncertain/)).toBeVisible();
  harness.fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  expect(harness.calls).toHaveLength(2);
  expect(harness.calls[1]).toEqual(harness.calls[0]);
});
