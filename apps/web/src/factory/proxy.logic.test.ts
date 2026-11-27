import type { FactoryProxyStatus as Status } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import {
  consoleNote,
  installInput,
  isOutdated,
  keyProblem,
  proxyActions,
  stateLine,
} from "./proxy.logic";

type Action = {
  action: "install" | "start" | "stop" | "uninstall" | "forget-sign-ins" | "retry-hub";
  enabled: boolean;
};

const versions = { proxy: "8.0.78", console: "1.28.3" };
const status = (fields: Partial<Status> = {}): Status => ({
  state: "stopped",
  desired: "stopped",
  hub: "disconnected",
  platform: "win32-x64",
  supported: true,
  pinned: versions,
  installed: versions,
  port: 8317,
  consoleUrl: "http://127.0.0.1:8317/management.html",
  consoleKey: "typed",
  credentials: true,
  restarts: 0,
  pid: null,
  exitCode: null,
  problem: null,
  ...fields,
});

const allowed = { install: true, start: true, stop: true, uninstall: true };
const sorted = (actions: ReadonlyArray<Action>) =>
  [...actions].sort((a, b) => a.action.localeCompare(b.action));

describe("proxyActions", () => {
  // Intent is independent of process and hub state; it does not add or remove actions.
  it.each([
    { state: "not-installed", desired: null, expected: ["install", "forget-sign-ins"] },
    { state: "installing", desired: "stopped", expected: [] },
    { state: "stopped", desired: "stopped", expected: ["start", "uninstall"] },
    { state: "starting", desired: "running", expected: ["stop", "uninstall"] },
    { state: "running", desired: "running", expected: ["stop", "uninstall", "retry-hub"] },
    { state: "failed", desired: "running", expected: ["start", "stop", "uninstall"] },
    { state: "port-in-use", desired: "running", expected: ["start", "stop", "uninstall"] },
  ] satisfies ReadonlyArray<{
    state: Status["state"];
    desired: Status["desired"];
    expected: ReadonlyArray<Action["action"]>;
  }>)("offers only the actions for $state", ({ state, desired, expected }) => {
    const actions = proxyActions(status({ state, desired }), allowed, true);
    expect(actions.map(({ action }) => action).sort()).toEqual([...expected].sort());
    expect(actions.every(({ enabled }) => enabled)).toBe(true);
  });

  it("keeps process, intent and hub independent when offering actions", () => {
    const cases: ReadonlyArray<{
      state: Status["state"];
      ordinary: ReadonlyArray<Action["action"]>;
      retry: ReadonlyArray<Action["action"]>;
    }> = [
      {
        state: "not-installed",
        ordinary: ["install", "forget-sign-ins"],
        retry: ["install", "forget-sign-ins"],
      },
      { state: "installing", ordinary: [], retry: [] },
      {
        state: "stopped",
        ordinary: ["start", "uninstall"],
        retry: ["start", "uninstall", "retry-hub"],
      },
      { state: "starting", ordinary: ["stop", "uninstall"], retry: ["stop", "uninstall"] },
      {
        state: "running",
        ordinary: ["stop", "uninstall"],
        retry: ["stop", "uninstall", "retry-hub"],
      },
      {
        state: "failed",
        ordinary: ["start", "stop", "uninstall"],
        retry: ["start", "stop", "uninstall"],
      },
      {
        state: "port-in-use",
        ordinary: ["start", "stop", "uninstall"],
        retry: ["start", "stop", "uninstall"],
      },
    ];
    const hubs: ReadonlyArray<Status["hub"]> = [
      "connected",
      "disconnected",
      "enable-refused",
      "disable-refused",
      "remove-refused",
    ];
    const intents: ReadonlyArray<Status["desired"]> = [null, "running", "stopped"];
    for (const { state, ordinary, retry } of cases) {
      for (const desired of intents) {
        for (const hub of hubs) {
          const showRetry =
            (state === "stopped" && hub === "disable-refused") ||
            (state === "running" && hub !== "connected");
          const expected = showRetry ? retry : ordinary;
          const actions = proxyActions(status({ state, desired, hub }), allowed, true);
          expect(actions.map(({ action }) => action).sort()).toEqual([...expected].sort());
          expect(actions.every(({ enabled }) => enabled)).toBe(true);
          const disconnected = proxyActions(status({ state, desired, hub }), allowed, false);
          expect(disconnected.map(({ action }) => action).sort()).toEqual([...expected].sort());
          expect(disconnected.every(({ enabled }) => !enabled)).toBe(true);
        }
      }
    }
  });

  it.each([
    {
      supported: true,
      pinned: versions,
      credentials: true,
      expected: ["install", "forget-sign-ins"],
    },
    { supported: true, pinned: versions, credentials: false, expected: ["install"] },
    { supported: false, pinned: versions, credentials: true, expected: ["forget-sign-ins"] },
    { supported: true, pinned: null, credentials: true, expected: ["forget-sign-ins"] },
    { supported: false, pinned: null, credentials: false, expected: [] },
  ] satisfies ReadonlyArray<{
    supported: boolean;
    pinned: Status["pinned"];
    credentials: boolean;
    expected: ReadonlyArray<Action["action"]>;
  }>)(
    "gates installation and kept sign-ins independently: $supported, $pinned, $credentials",
    (row) => {
      const actions = proxyActions(status({ state: "not-installed", ...row }), allowed, true);
      expect(actions.map(({ action }) => action).sort()).toEqual([...row.expected].sort());
    },
  );

  // A running proxy retries any disconnected hub; a stopped one retries only a refused disable.
  it.each([
    { hub: "connected", running: false, stopped: false },
    { hub: "disconnected", running: true, stopped: false },
    { hub: "enable-refused", running: true, stopped: false },
    { hub: "disable-refused", running: true, stopped: true },
    { hub: "remove-refused", running: true, stopped: false },
  ] satisfies ReadonlyArray<{ hub: Status["hub"]; running: boolean; stopped: boolean }>)(
    "offers retry for $hub in the specified states only",
    ({ hub, running, stopped }) => {
      for (const [state, expected] of [
        ["running", running],
        ["stopped", stopped],
        ["starting", false],
        ["failed", false],
        ["port-in-use", false],
        ["installing", false],
        ["not-installed", false],
      ] satisfies ReadonlyArray<readonly [Status["state"], boolean]>) {
        expect(
          proxyActions(status({ state, hub }), allowed, true).some((a) => a.action === "retry-hub"),
        ).toBe(expected);
      }
    },
  );

  it.each([
    { problem: null, start: true },
    { problem: "download", start: true },
    { problem: "verify", start: true },
    { problem: "archive", start: true },
    { problem: "write", start: true },
    { problem: "interrupted", start: false },
    { problem: "leftover", start: true },
    { problem: "damaged", start: true },
    { problem: "config-unreadable", start: false },
    { problem: "spawn", start: true },
    { problem: "exited", start: true },
    { problem: "unhealthy", start: true },
  ] satisfies ReadonlyArray<{ problem: Status["problem"]; start: boolean }>)(
    "offers start after failure $problem only when permitted by the problem",
    ({ problem, start }) => {
      const actions = proxyActions(status({ state: "failed", problem }), allowed, true);
      expect(actions.map(({ action }) => action).sort()).toEqual(
        (start ? ["start", "stop", "uninstall"] : ["stop", "uninstall"]).sort(),
      );
    },
  );

  it.each([
    { installed: versions, expected: ["start", "stop", "uninstall"] },
    { installed: null, expected: ["stop", "uninstall"] },
  ])("r11d P10: damaged with installed=$installed", ({ installed, expected }) => {
    const actions = proxyActions(
      status({ state: "failed", problem: "damaged", installed }),
      allowed,
      true,
    );
    expect(actions.map(({ action }) => action).sort()).toEqual([...expected].sort());
  });

  // Retry uses start permission while running and stop permission while stopped.
  it.each([
    {
      state: "not-installed",
      hub: "disconnected",
      denied: "install",
      expected: [
        { action: "install", enabled: false },
        { action: "forget-sign-ins", enabled: true },
      ],
    },
    {
      state: "not-installed",
      hub: "disconnected",
      denied: "uninstall",
      expected: [
        { action: "install", enabled: true },
        { action: "forget-sign-ins", enabled: false },
      ],
    },
    {
      state: "stopped",
      hub: "disable-refused",
      denied: "start",
      expected: [
        { action: "start", enabled: false },
        { action: "uninstall", enabled: true },
        { action: "retry-hub", enabled: true },
      ],
    },
    {
      state: "stopped",
      hub: "disable-refused",
      denied: "stop",
      expected: [
        { action: "start", enabled: true },
        { action: "uninstall", enabled: true },
        { action: "retry-hub", enabled: false },
      ],
    },
    {
      state: "running",
      hub: "enable-refused",
      denied: "start",
      expected: [
        { action: "stop", enabled: true },
        { action: "uninstall", enabled: true },
        { action: "retry-hub", enabled: false },
      ],
    },
    {
      state: "running",
      hub: "enable-refused",
      denied: "stop",
      expected: [
        { action: "stop", enabled: false },
        { action: "uninstall", enabled: true },
        { action: "retry-hub", enabled: true },
      ],
    },
    {
      state: "running",
      hub: "enable-refused",
      denied: "uninstall",
      expected: [
        { action: "stop", enabled: true },
        { action: "uninstall", enabled: false },
        { action: "retry-hub", enabled: true },
      ],
    },
  ] satisfies ReadonlyArray<{
    state: Status["state"];
    hub: Status["hub"];
    denied: keyof typeof allowed;
    expected: ReadonlyArray<Action>;
  }>)("disables only $denied actions in $state", ({ state, hub, denied, expected }) => {
    expect(
      sorted(proxyActions(status({ state, hub }), { ...allowed, [denied]: false }, true)),
    ).toEqual(sorted(expected));
    expect(sorted(proxyActions(status({ state, hub }), allowed, false))).toEqual(
      sorted(expected.map(({ action }) => ({ action, enabled: false }))),
    );
  });
});

describe("management key input", () => {
  it.each([
    { text: "", problem: false },
    { text: " \t\n ", problem: false },
    { text: "a".repeat(15), problem: true },
    { text: "a".repeat(16), problem: false },
    { text: "a".repeat(64), problem: false },
    { text: "a".repeat(65), problem: true },
    { text: "abcdefgh ijklmnop", problem: true },
    { text: "abcdefghéjklmnop", problem: true },
    { text: "  abcdefghijklmnop  ", problem: false },
  ])("validates trimmed input $text", ({ text, problem }) => {
    expect(keyProblem(text)).toBe(problem);
  });

  it("omits a blank key and redacts the trimmed typed key", () => {
    expect(installInput("")).toEqual({});
    expect(installInput(" \t\n ")).toEqual({});
    const input = installInput(" \tabcdefghijklmnop!\n ");
    expect(input).toHaveProperty("managementKey");
    if (input.managementKey === undefined) throw new Error("Expected a management key");
    expect(Redacted.value(input.managementKey)).toBe("abcdefghijklmnop!");
  });
});

describe("proxy status presentation", () => {
  // Either component of the pin can move; absence on either side is not an update.
  it.each([
    { pinned: versions, installed: versions, expected: false },
    { pinned: { proxy: "8.0.79", console: "1.28.3" }, installed: versions, expected: true },
    { pinned: { proxy: "8.0.78", console: "1.28.4" }, installed: versions, expected: true },
    { pinned: { proxy: "8.0.79", console: "1.28.4" }, installed: versions, expected: true },
    { pinned: null, installed: versions, expected: false },
    { pinned: versions, installed: null, expected: false },
    { pinned: null, installed: null, expected: false },
  ])("detects moved versions with pinned=$pinned and installed=$installed", (row) => {
    expect(isOutdated(status({ pinned: row.pinned, installed: row.installed }))).toBe(row.expected);
  });

  it.each([
    { installed: versions, consoleKey: "typed", expected: "typed" },
    { installed: versions, consoleKey: "generated", expected: "generated" },
    { installed: null, consoleKey: null, expected: null },
  ] satisfies ReadonlyArray<{
    installed: Status["installed"];
    consoleKey: Status["consoleKey"];
    expected: Status["consoleKey"];
  }>)("selects the console note for $consoleKey", ({ installed, consoleKey, expected }) => {
    expect(consoleNote(status({ installed, consoleKey }))).toBe(expected);
  });

  it.each(["typed", "generated"] satisfies ReadonlyArray<Status["consoleKey"]>)(
    "r11d P10: installing with no installed version has no console note for %s",
    (consoleKey) => {
      expect(consoleNote(status({ state: "installing", installed: null, consoleKey }))).toBe(null);
    },
  );

  it.each([
    { fields: { state: "not-installed", pinned: null, supported: false }, expected: "no-manifest" },
    { fields: { state: "not-installed", pinned: null, supported: true }, expected: "no-manifest" },
    {
      fields: { state: "not-installed", pinned: versions, supported: false },
      expected: "unsupported",
    },
    {
      fields: { state: "not-installed", pinned: versions, supported: true },
      expected: "not-installed",
    },
    { fields: { state: "installing" }, expected: "installing" },
    { fields: { state: "stopped" }, expected: "stopped" },
    { fields: { state: "starting", restarts: 0 }, expected: "starting" },
    { fields: { state: "starting", restarts: 1 }, expected: "starting-again" },
    { fields: { state: "starting", restarts: 4 }, expected: "starting-again" },
    { fields: { state: "running" }, expected: "running" },
    { fields: { state: "failed" }, expected: "failed" },
    { fields: { state: "port-in-use", pid: null }, expected: "port-held" },
    { fields: { state: "port-in-use", pid: 4242 }, expected: "port-held-by" },
  ] satisfies ReadonlyArray<{ fields: Partial<Status>; expected: string }>)(
    "chooses $expected for the process status",
    ({ fields, expected }) => {
      expect(stateLine(status(fields))).toBe(expected);
    },
  );
});
