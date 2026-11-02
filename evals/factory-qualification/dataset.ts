// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { QualificationCase, roles, splits } from "./schema.ts";

export const root = NodePath.resolve(import.meta.dirname, "../..");
export const target = {
  triage: 20,
  evidence: 25,
  coordination: 30,
  implementation: 25,
  review: 20,
};
export const included = {
  triage: 10,
  evidence: 12,
  coordination: 15,
  implementation: 13,
  review: 10,
};
export const allocation = { development: 30, calibration: 15, holdout: 15 };
export const digest = (content: string) =>
  NodeCrypto.createHash("sha256").update(content).digest("hex");
const decodeCases = Schema.decodeUnknownSync(Schema.Array(QualificationCase));
export const readCases = () =>
  decodeCases(
    JSON.parse(NodeFS.readFileSync(NodePath.join(import.meta.dirname, "v1/cases.json"), "utf8")),
  );

const readLocal = (path: string) => {
  const resolved = NodePath.resolve(root, path);
  if (!resolved.startsWith(`${root}${NodePath.sep}`))
    throw new Error(`Outside repository: ${path}`);
  return NodeFS.readFileSync(resolved, "utf8");
};

export const validate = (cases: ReadonlyArray<QualificationCase>) => {
  const errors: Array<string> = [];
  const ids = new Set<string>();
  const references = new Set<string>();
  const scenarios = new Set<string>();
  const isolation = new Map<string, string>();
  for (const c of cases) {
    const fail = (message: string) => errors.push(`${c.id}: ${message}`);
    if (!/^[a-z0-9-]+$/.test(c.id) || ids.has(c.id)) fail("invalid or duplicate id");
    ids.add(c.id);
    if (scenarios.has(c.scenario.trim())) fail("duplicate scenario");
    scenarios.add(c.scenario.trim());
    for (const key of [`family:${c.family}`, `example:${c.repositoryExample}`]) {
      if (isolation.has(key) && isolation.get(key) !== c.split) fail(`split leakage: ${key}`);
      isolation.set(key, c.split);
    }
    if (!c.family.trim() || !c.repositoryExample.trim() || !c.source.origin.trim())
      fail("missing provenance");
    if (
      [c.expectedActions, c.forbiddenActions, c.transitions].some(
        (values) => !values.length || values.some((value) => !value.trim()),
      )
    )
      fail("empty action contract");
    try {
      const source = readLocal(c.source.path);
      if (!c.source.anchor || !source.includes(c.source.anchor)) fail("source anchor missing");
      if (digest(source) !== c.source.sha256) fail("source changed; re-review provenance");
    } catch {
      fail("source does not resolve");
    }
    const spec = c.route === "native-spec" || c.route === "decision-spec";
    if (spec) {
      if (
        c.execution.readiness !== "unrunnable-driver" ||
        c.execution.driver !== null ||
        c.reference
      )
        fail("spec route cannot claim execution");
      if (
        !c.specification?.files.length ||
        !c.specification.acceptance.length ||
        !c.specification.missing.length ||
        !c.specification.task.trim() ||
        c.specification.acceptance.some(
          ({ artifact, assertion }) => !artifact.trim() || !assertion.trim(),
        ) ||
        c.specification.missing.some((value) => !value.trim())
      )
        fail("incomplete specification");
      for (const file of c.specification?.files ?? []) {
        if (
          !file.path.trim() ||
          NodePath.posix.isAbsolute(file.path) ||
          NodePath.win32.isAbsolute(file.path) ||
          file.path.includes(":") ||
          file.path.split(/[\\/]/).includes("..") ||
          !file.content
        )
          fail("unsafe or empty fixture file");
      }
      if (
        c.route === "native-spec" &&
        !c.specification?.acceptance.some(({ artifact }) => artifact === "checkpoint.json")
      )
        fail("native task lacks checkpoint assertion");
      if (c.route === "native-spec") {
        const required = {
          triage: ["decision"],
          evidence: ["lifecycle", "preservation"],
          coordination: ["lifecycle"],
          implementation: ["result-tree", "behavior", "test-evidence", "ownership"],
          review: ["review"],
        } as const;
        const gates = new Set(
          c.specification?.acceptance.filter((a) => a.assertion.trim()).map((a) => a.gate),
        );
        for (const gate of ["checkpoint", "native-identity", ...required[c.role]] as const)
          if (!gates.has(gate)) fail(`native task lacks mandatory gate: ${gate}`);
      }
    } else {
      if (!c.reference || c.specification)
        fail("replay requires reference, not a native specification");
      const driver =
        c.route === "mcp-replay" ? "evals/mcp-tool-use/run.ts" : "evals/test-signal/run.ts";
      if (c.execution.driver !== driver || c.execution.readiness === "unrunnable-driver")
        fail("dishonest replay route");
      if (c.route === "test-signal" && c.execution.readiness !== "blocked-fixture")
        fail("historical fixtures have not been verified");
      if (c.reference) {
        const key = `${c.reference.path}#${c.reference.id}`;
        if (references.has(key)) fail("same referenced scenario counted twice");
        references.add(key);
        try {
          const source = readLocal(c.reference.path);
          if (c.reference.path !== c.source.path) fail("reference and provenance differ");
          const anchor = c.route === "mcp-replay" ? c.reference.id : `id: "${c.reference.id}"`;
          if (anchor !== c.source.anchor) fail("reference identity differs from provenance anchor");
          if (c.route === "mcp-replay") {
            const rows = source
              .split("\n")
              .filter((line) => line.trim())
              .map((line): { id: string } => JSON.parse(line));
            if (rows.filter(({ id }) => id === c.reference?.id).length !== 1)
              fail("reference id does not resolve uniquely");
          } else if (!source.includes(`id: "${c.reference.id}"`))
            fail("test-signal id does not resolve");
        } catch {
          fail("reference does not resolve");
        }
      }
    }
    if (!c.execution.reason.trim() || !c.execution.proves.trim()) fail("missing execution limits");
  }
  for (const role of roles)
    if (cases.filter((c) => c.role === role).length !== included[role])
      errors.push(`role count: ${role}`);
  for (const split of splits)
    if (cases.filter((c) => c.split === split).length !== allocation[split])
      errors.push(`split count: ${split}`);
  return errors;
};

export const select = (
  cases: ReadonlyArray<QualificationCase>,
  split: (typeof splits)[number] = "development",
  includeHoldout = false,
) => {
  if (split === "holdout" && !includeHoldout)
    throw new Error("Holdout requires explicit includeHoldout");
  return cases.filter((c) => c.split === split);
};

export const exportReplay = (cases: ReadonlyArray<QualificationCase>) => {
  const ready = cases.filter((c) => c.route === "mcp-replay" && c.execution.readiness === "ready");
  if (!ready.length) throw new Error("No ready MCP replay cases in this selection");
  return ready
    .map((c) => {
      if (!c.reference) throw new Error("Missing replay reference");
      const line = readLocal(c.reference.path)
        .split("\n")
        .find((row) => row.trim() && JSON.parse(row).id === c.reference?.id);
      if (!line) throw new Error(`Missing replay: ${c.id}`);
      return line;
    })
    .join("\n");
};
