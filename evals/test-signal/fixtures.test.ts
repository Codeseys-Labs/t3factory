// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import type { Case } from "./cases.ts";
import { createFixtures, selectCases } from "./fixtures.ts";

const setup = () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signal-fixture-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false");
  NodeFS.mkdirSync(NodePath.join(repo, "docs/internals"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, "AGENTS.md"), "current rule\n");
  NodeFS.writeFileSync(NodePath.join(repo, "docs/internals/testing.md"), "testing rule\n");
  NodeFS.writeFileSync(NodePath.join(repo, "a.test.ts"), 'it("old", () => {});\n');
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  NodeFS.appendFileSync(
    NodePath.join(repo, "a.test.ts"),
    'it("new", () => {\n  expect(1).toBe(1);\n});\n',
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "head");
  const entry: Case = {
    id: "local",
    kind: "bad",
    source: "local regression",
    type: "real",
    rev: git("rev-parse", "HEAD"),
    paths: ["a.test.ts"],
    targets: [{ path: "a.test.ts", title: "new" }],
  };
  return {
    repo,
    git,
    base,
    entry,
    ...createFixtures(repo),
    [Symbol.dispose]: () => NodeFS.rmSync(repo, { recursive: true, force: true }),
  };
};

it("does not serve unavailable commits as absent files or no grep matches", () => {
  using f = setup();
  const entry = { ...f.entry, rev: "1234567890123456789012345678901234567890" };
  expect(() => f.readAt(entry, new Map(), "a.test.ts")).toThrow();
  expect(() => f.grepAt(entry, new Map(), "missing", "a.test.ts")).toThrow();
});

it("does not serve missing blobs as absent files or no grep matches", () => {
  using f = setup();
  const oid = f.git("rev-parse", `${f.entry.rev}:a.test.ts`);
  NodeFS.unlinkSync(NodePath.join(f.repo, ".git/objects", oid.slice(0, 2), oid.slice(2)));
  expect(() => f.readAt(f.entry, new Map(), "a.test.ts")).toThrow();
  expect(() => f.grepAt(f.entry, new Map(), "missing", "a.test.ts")).toThrow();
});

it("requires exactly one synthetic anchor", () => {
  using f = setup();
  const entry: Case = {
    id: "synthetic",
    kind: "guard",
    source: "local regression",
    type: "synthetic",
    rev: f.entry.rev,
    path: "a.test.ts",
    after: "it(",
    insert: "insertion",
    targets: [],
  };
  expect(() => f.world(entry)).toThrow(/anchor/);
  expect(() => f.world({ ...entry, after: "absent" })).toThrow(/anchor/);
  expect(() => f.world({ ...entry, after: "" })).toThrow(/anchor/);
});

it("rejects empty or unknown selections and invalid fixture evidence", () => {
  using f = setup();
  expect(() => selectCases([f.entry], ["unknown"])).toThrow(/Unknown/);
  expect(() => selectCases([f.entry], [])).toThrow(/Empty/);
  expect(() => selectCases([])).toThrow(/Empty/);
  expect(() => f.world({ ...f.entry, paths: ["AGENTS.md"], targets: [] })).toThrow(/empty diff/);
  expect(() => f.world({ ...f.entry, paths: ["absent"] })).toThrow(/missing path/);
  expect(() => f.world({ ...f.entry, targets: [{ path: "a.test.ts", title: "absent" }] })).toThrow(
    /target/,
  );
  expect(() => f.world({ ...f.entry, targets: [{ path: "a.test.ts", title: "old" }] })).toThrow(
    /no added lines/,
  );
  expect(() => f.world({ ...f.entry, rev: "unknown" })).toThrow(/Offline git/);
  const parentBlob = f.git("rev-parse", `${f.base}:a.test.ts`);
  NodeFS.unlinkSync(
    NodePath.join(f.repo, ".git/objects", parentBlob.slice(0, 2), parentBlob.slice(2)),
  );
  expect(() => f.world(f.entry)).toThrow(/Offline git/);
});

it("keeps absence distinct from access errors and serves overlays and current rules", () => {
  using f = setup();
  const files = new Map([["a.test.ts", 'it("overlay", () => {});\n']]);
  expect(f.readAt(f.entry, files, "absent")).toBeUndefined();
  expect(f.grepAt(f.entry, files, "unknown", "a.test.ts")).toBe("No matches.");
  expect(f.grepAt(f.entry, files, "overlay", "a.test.ts")).toBe(
    'a.test.ts:1:it("overlay", () => {});',
  );
  expect(f.grepAt(f.entry, files, "new", "a.test.ts")).toBe("No matches.");
  expect(f.grepAt(f.entry, files, "[", "a.test.ts")).not.toBe("No matches.");
  NodeFS.writeFileSync(NodePath.join(f.repo, "AGENTS.md"), "replacement policy\n");
  const oid = f.git("rev-parse", `${f.entry.rev}:AGENTS.md`);
  NodeFS.unlinkSync(NodePath.join(f.repo, ".git/objects", oid.slice(0, 2), oid.slice(2)));
  expect(f.readAt(f.entry, files, "AGENTS.md")).toBe("replacement policy\n");
  expect(f.grepAt(f.entry, files, "replacement", "AGENTS.md")).toBe(
    "AGENTS.md:1:replacement policy",
  );
  expect(f.grepAt(f.entry, files, "current rule", "AGENTS.md")).toBe("No matches.");
  f.git("rm", "a.test.ts");
  expect(f.grepAt(f.entry, files, "overlay", "a.test.ts")).toBe(
    'a.test.ts:1:it("overlay", () => {});',
  );
});

it("validates real additions/deletions and synthetic diff paths without changing grader ranges", () => {
  using f = setup();
  const fixture = f.world(f.entry);
  expect(fixture.targets).toEqual([
    { path: "a.test.ts", title: "new", start: 2, end: 5, addedLines: [2, 3, 4] },
  ]);
  const synthetic = f.world({
    id: "synthetic",
    kind: "bad",
    source: "local regression",
    type: "synthetic",
    rev: f.base,
    path: "a.test.ts",
    after: 'it("old", () => {});\n',
    insert: 'it("inserted", () => {});\n',
    targets: [{ path: "a.test.ts", title: "inserted" }],
  });
  expect(synthetic.diff).toContain("diff --git a/a.test.ts b/a.test.ts");
  expect(synthetic.diff).toContain("--- a/a.test.ts\n+++ b/a.test.ts");
  expect(synthetic.targets[0]).toMatchObject({ start: 2, addedLines: [2] });
  NodeFS.writeFileSync(NodePath.join(f.repo, "new.test.ts"), 'it("added", () => {});\n');
  f.git("rm", "a.test.ts");
  f.git("add", ".");
  f.git("commit", "--quiet", "-m", "add and delete");
  const rev = f.git("rev-parse", "HEAD");
  const added = f.world({
    ...f.entry,
    rev,
    paths: ["new.test.ts"],
    targets: [{ path: "new.test.ts", title: "added" }],
  });
  expect(added.sources[0]?.before).toBeNull();
  const deleted = f.world({ ...f.entry, rev, kind: "guard", paths: ["a.test.ts"], targets: [] });
  expect(deleted.sources[0]?.after).toBeNull();
  expect(f.readAt({ ...f.entry, rev }, new Map(), "a.test.ts")).toBeUndefined();
});

it("persists bounded preflight identities and access evidence, and marks failed reruns", () => {
  using f = setup();
  const out = NodePath.join(f.repo, "preflight");
  const prompt = NodePath.join(f.repo, "prompt.md");
  NodeFS.writeFileSync(prompt, "prompt\n");
  f.preflight(f.entry, out, prompt);
  const json = (name: string) => JSON.parse(NodeFS.readFileSync(NodePath.join(out, name), "utf8"));
  expect(NodeFS.readFileSync(NodePath.join(out, "test.diff"), "utf8")).toContain('+it("new"');
  expect(json("provenance.json")).toMatchObject({
    rev: f.entry.rev,
    parent: f.base,
    runtime: { gitNoLazyFetch: "1" },
  });
  expect(json("targets.json")[0]).toMatchObject({ start: 2, addedLines: [2, 3, 4] });
  expect(json("served-files.json")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "a.test.ts",
        read: expect.objectContaining({ kind: "historical" }),
        grep: expect.objectContaining({ output: expect.stringContaining("a.test.ts:1:") }),
      }),
    ]),
  );
  expect(json("offline-preflight.json")).toMatchObject({
    status: "complete",
    limits: {
      arbitraryHistoricalSourceClosure: false,
      historicalTestsExecuted: false,
      modelQualified: false,
      datasetLabelsChanged: false,
    },
  });
  expect(() => f.preflight(f.entry, out, prompt, ["missing-context.ts"])).toThrow(
    /inspected source missing/,
  );
  expect(json("offline-preflight.json")).toMatchObject({ status: "failed" });
});

it("rejects invalid CLI selections before any proxy setup in either mode", () => {
  using f = setup();
  for (const preflight of [[], ["--preflight"]]) {
    for (const id of ["unknown-fixture", ""]) {
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(import.meta.dirname, "run.ts"), "--out", f.repo, "--case", id, ...preflight],
        { encoding: "utf8", env: { ...process.env, PATH: "" } },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown case selection");
      expect(result.stderr).not.toContain("config.toml");
    }
  }
});
