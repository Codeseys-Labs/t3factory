import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type FactoryWorkPrerequisitesResult,
  type FactoryWorkRef,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

const { harness } = vi.hoisted(() => ({
  harness: {
    readable: true,
    connected: true,
    supported: true,
    result: null as FactoryWorkPrerequisitesResult | null,
    read: vi.fn(),
    refresh: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  Linking: { openURL: vi.fn() },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    label: string;
    accessibilityLabel?: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button aria-label={accessibilityLabel ?? label} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => Date.parse("2026-11-05T12:00:00Z") }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "owner",
        connection: { phase: harness.connected ? "connected" : "disconnected" },
        serverConfig: {
          environment: {
            capabilities: { factoryWork: true, factoryWorkPrerequisites: harness.supported },
          },
        },
      },
    ],
  }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => harness.readable }));
vi.mock("../../state/factory", () => ({
  factoryEnvironment: { readWorkPrerequisites: harness.read },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: harness.result,
    error: null,
    failure: null,
    isPending: false,
    refresh: harness.refresh,
  }),
}));
vi.mock("./factoryIssues", () => ({ safeFactoryIssueUrl: () => null }));

import { FactoryWorkPrerequisites } from "./FactoryWorkPrerequisites";

const reference: FactoryWorkRef = {
  version: 1,
  environmentId: EnvironmentId.make("owner"),
  kind: "issue",
  id: "root",
};
const retained: FactoryWorkRef = { ...reference, id: "retained-root" };
const observedAt = "2026-11-05T12:00:00Z";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.readable = true;
  harness.connected = true;
  harness.supported = true;
  harness.read.mockReset();
  harness.refresh.mockReset();
  harness.result = {
    status: "observed",
    reviewProjectId: ProjectId.make("review"),
    repository: {
      provider: SourceControlProviderKind.make("github"),
      host: "github.com",
      repository: "acme/app",
      canonicalKey: "github.com/acme/app",
      url: "https://github.com/acme/app",
    },
    issueNumber: 1,
    readiness: {
      status: "blocked",
      reasons: ["open-blocker"],
      basis: null,
      overrides: [],
      complete: true,
      listedCount: 1,
      summaryTotal: 1,
      observedAt,
    },
    prerequisites: [
      {
        edge: {
          targetId: 2,
          targetHost: "github.com",
          targetRepository: "acme/app",
          targetNumber: 2,
          targetUrl: "https://github.com/acme/app/issues/2",
          title: "Protected blocker title",
          state: "open",
          stateReason: null,
          closedAt: null,
          resolution: "open",
          status: "present",
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          fingerprint: "2",
          override: null,
        },
        link: { kind: "retained", ref: retained, projectId: ProjectId.make("other-project") },
      },
    ],
    omittedCount: 0,
    fetchedAt: observedAt,
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  onTestFinished(() => act(() => root.unmount()));
  const onOpen = vi.fn();
  const render = (ref = reference) =>
    act(() =>
      root.render(
        <FactoryWorkPrerequisites
          reference={ref}
          status="current"
          withinFilter={() => false}
          onOpen={onOpen}
        />,
      ),
    );
  const press = (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (entry) => entry.getAttribute("aria-label") === label,
    );
    if (!button) throw new Error(`Button missing: ${label}`);
    act(() => button.click());
  };
  render();
  return { container, render, press, onOpen };
}

it("observes lazily and opens the exact retained root outside the filter, resetting for another item", () => {
  const screen = setup();
  expect(harness.read).not.toHaveBeenCalled();
  screen.press("Show prerequisites");
  expect(harness.read).toHaveBeenCalledWith({
    environmentId: reference.environmentId,
    input: { ref: reference },
  });
  expect(screen.container.textContent).toContain("Protected blocker title");
  screen.press("Open retained Work (outside current filter): acme/app#2");
  expect(screen.onOpen).toHaveBeenCalledWith(retained);
  const reads = harness.read.mock.calls.length;
  screen.render({ ...reference, id: "other-root" });
  expect(screen.container.textContent).not.toContain("Protected blocker title");
  expect(harness.read).toHaveBeenCalledTimes(reads);
  screen.press("Show prerequisites");
  expect(harness.read).toHaveBeenLastCalledWith({
    environmentId: reference.environmentId,
    input: { ref: { ...reference, id: "other-root" } },
  });
});

it.each(["revoked", "disconnected", "unsupported"] as const)(
  "removes retained protected content when %s even if the query keeps its success",
  (state) => {
    const screen = setup();
    screen.press("Show prerequisites");
    expect(screen.container.textContent).toContain("Protected blocker title");
    if (state === "revoked") harness.readable = false;
    if (state === "disconnected") harness.connected = false;
    if (state === "unsupported") harness.supported = false;
    const reads = harness.read.mock.calls.length;
    screen.render();
    expect(screen.container.textContent).not.toContain("Protected blocker title");
    expect(screen.container.textContent).not.toContain("Open retained Work");
    expect(harness.read).toHaveBeenCalledTimes(reads);
    expect(screen.container.textContent).toContain(
      state === "revoked"
        ? "Owner read access denied"
        : state === "disconnected"
          ? "Owner offline"
          : "cannot report Work prerequisites",
    );
  },
);
