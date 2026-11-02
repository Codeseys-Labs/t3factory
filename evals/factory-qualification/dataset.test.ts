// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { McpToolUseCase } from "../mcp-tool-use/run.ts";
import {
  allocation,
  exportReplay,
  included,
  readCases,
  root,
  select,
  target,
  validate,
} from "./dataset.ts";
import { QualificationCase, roles, splits } from "./schema.ts";

const decodeReplay = Schema.decodeUnknownSync(McpToolUseCase);
const decodeCase = Schema.decodeUnknownSync(QualificationCase);

it("reconciles the bounded version against the exact target and remainder", () => {
  const cases = readCases();
  const protocol = JSON.parse(
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "v1/protocol.json"), "utf8"),
  );
  expect(validate(cases)).toEqual([]);
  expect(cases).toHaveLength(60);
  expect(protocol.version).toBe("1.0.0");
  expect(protocol.target).toEqual(target);
  expect(protocol.included).toEqual(included);
  expect(protocol.splitIncluded).toEqual(allocation);
  for (const role of roles) expect(protocol.remainder[role]).toBe(target[role] - included[role]);
  for (const split of splits)
    expect(protocol.splitRemainder[split]).toBe(protocol.splitTarget[split] - allocation[split]);
});

it("rejects duplicate identities, duplicate scenarios, role drift and allocation drift", () => {
  const cases = readCases();
  const first = cases[0]!;
  const second = cases[1]!;
  expect(validate([first, ...cases.slice(0, -1)]).join("\n")).toContain("duplicate id");
  expect(
    validate([{ ...first, scenario: second.scenario }, ...cases.slice(1)]).join("\n"),
  ).toContain("duplicate scenario");
  expect(validate([{ ...first, role: "triage" }, ...cases.slice(1)]).join("\n")).toContain(
    "role count",
  );
  expect(validate([{ ...first, split: "holdout" }, ...cases.slice(1)]).join("\n")).toContain(
    "split count",
  );
});

it("rejects family and repository example leakage even with unique case ids", () => {
  const cases = readCases();
  const heldout = cases.find((c) => c.split === "holdout")!;
  const first = cases[0]!;
  for (const change of [
    { family: heldout.family },
    { repositoryExample: heldout.repositoryExample },
  ]) {
    expect(validate([{ ...first, ...change }, ...cases.slice(1)]).join("\n")).toContain(
      "split leakage",
    );
  }
});

it("keeps calibration and holdout out of default selection and preserves referenced replay payloads", () => {
  const cases = readCases();
  const development = select(cases);
  expect(development).toHaveLength(30);
  expect(development.every((c) => c.split === "development")).toBe(true);
  expect(() => select(cases, "holdout")).toThrow("explicit includeHoldout");
  expect(select(cases, "holdout", true)).toHaveLength(15);
  expect(select(cases, "calibration")).toHaveLength(15);
  expect(() => exportReplay(select(cases, "holdout", true))).toThrow("No ready MCP replay");
  const exported = exportReplay(development).split("\n");
  expect(exported).toHaveLength(20);
  for (const line of exported) {
    const row = decodeReplay(JSON.parse(line));
    const c = development.find(({ reference }) => reference?.id === row.id)!;
    expect(c.route).toBe("mcp-replay");
    expect(
      NodeFS.readFileSync(NodePath.join(root, c.reference!.path), "utf8").split("\n"),
    ).toContain(line);
  }
});

it("fails closed on missing references, changed provenance and a repeated existing scenario", () => {
  const cases = readCases();
  const first = cases[0]!;
  for (const reference of [
    { ...first.reference!, id: "no-such-case" },
    { ...first.reference!, path: "evals/no-such-suite.ndjson" },
    { ...first.reference!, path: "../outside-repository.ndjson" },
  ]) {
    expect(validate([{ ...first, reference }, ...cases.slice(1)]).join("\n")).toMatch(/reference/);
  }
  expect(
    validate([
      { ...first, source: { ...first.source, sha256: "0".repeat(64) } },
      ...cases.slice(1),
    ]).join("\n"),
  ).toContain("source changed");
  const replacement = { ...cases[1]!, reference: first.reference!, source: first.source };
  expect(validate([first, replacement, ...cases.slice(2)]).join("\n")).toContain("counted twice");
  const substituted = {
    ...first,
    reference: { ...first.reference!, id: "work-prerequisites-not-modeled-feed" },
  };
  expect(validate([substituted, ...cases.slice(1)]).join("\n")).toContain(
    "reference identity differs",
  );
});

it("rejects native and decision execution claims and unverified historical fixture claims", () => {
  const cases = readCases();
  for (const route of ["native-spec", "decision-spec", "test-signal"] as const) {
    const index = cases.findIndex((c) => c.route === route);
    const c = cases[index]!;
    const changed = cases.with(index, { ...c, execution: { ...c.execution, readiness: "ready" } });
    expect(validate(changed).join("\n")).toMatch(/cannot claim execution|not been verified/);
  }
  const index = cases.findIndex((c) => c.route === "native-spec");
  const c = cases[index]!;
  const repairIndex = cases.findIndex((c) => c.id === "repair-cache-expiry");
  const repair = cases[repairIndex]!;
  for (const gate of ["behavior", "test-evidence", "ownership", "native-identity"]) {
    const weakened = {
      ...repair.specification!,
      acceptance: repair.specification!.acceptance.filter((a) => a.gate !== gate),
    };
    expect(
      validate(cases.with(repairIndex, { ...repair, specification: weakened })).join("\n"),
    ).toContain(`native task lacks mandatory gate: ${gate}`);
  }
  expect(
    validate(
      cases.with(repairIndex, {
        ...repair,
        specification: {
          ...repair.specification!,
          task: "",
          acceptance: [{ artifact: "checkpoint.json", assertion: "" }],
        },
      }),
    ).join("\n"),
  ).toContain("incomplete specification");
  const specification = {
    ...c.specification!,
    acceptance: c.specification!.acceptance.filter(
      ({ artifact }) => artifact !== "checkpoint.json",
    ),
  };
  expect(validate(cases.with(index, { ...c, specification })).join("\n")).toContain(
    "lacks checkpoint assertion",
  );
  for (const path of [
    "",
    "C:escape",
    "seed.txt:payload",
    "C:\\outside.txt",
    "/outside.txt",
    "../escape",
  ]) {
    const unsafe = {
      ...c.specification!,
      files: [{ ...c.specification!.files[0]!, path }],
    };
    expect(validate(cases.with(index, { ...c, specification: unsafe })).join("\n")).toContain(
      "unsafe or empty fixture file",
    );
  }
  expect(
    validate([
      { ...cases[0]!, execution: { ...cases[0]!.execution, driver: "native-driver" } },
      ...cases.slice(1),
    ]).join("\n"),
  ).toContain("dishonest replay route");
});

it("decodes only known roles, routes, splits and execution states", () => {
  const first = readCases()[0]!;
  for (const change of [
    { role: "unknown" },
    { route: "native-replay" },
    { split: "all" },
    { execution: { readiness: "passed" } },
  ]) {
    expect(() => decodeCase({ ...first, ...change })).toThrow();
  }
});
