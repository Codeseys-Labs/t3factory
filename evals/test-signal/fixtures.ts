// Eval-only offline fixture access.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Case } from "./cases.ts";
import { testRange } from "./grade.ts";

const ruleFiles = ["docs/internals/testing.md", "AGENTS.md"];
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const identity = (text: string) => ({ sha256: sha256(text), bytes: Buffer.byteLength(text) });
const offlineEnv = () => ({ ...process.env, GIT_NO_LAZY_FETCH: "1" });

export const selectCases = (cases: ReadonlyArray<Case>, ids?: ReadonlyArray<string>) => {
  if (ids?.some((id) => !cases.some((entry) => entry.id === id)))
    throw new Error(
      `Unknown case selection: ${ids.filter((id) => !cases.some((entry) => entry.id === id)).join(", ")}`,
    );
  const selected = ids ? cases.filter((entry) => ids.includes(entry.id)) : cases;
  if (selected.length === 0) throw new Error("Empty case selection.");
  return selected;
};

export const createFixtures = (repo: string) => {
  const git = (args: ReadonlyArray<string>, statuses = [0]) => {
    const result = NodeChildProcess.spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 1 << 26,
      env: offlineEnv(),
    });
    if (result.error || !statuses.includes(result.status ?? -1) || result.stderr.trim())
      throw new Error(
        `Offline git ${args.join(" ")} failed: ${result.error?.message ?? (result.stderr.trim() || result.status)}`,
      );
    return result.stdout;
  };
  const resolve = (rev: string, type: "commit" | "tree") =>
    git(["rev-parse", "--verify", `${rev}^{${type}}`]).trim();
  const historical = (rev: string, path: string) => {
    resolve(rev, "commit");
    const rows = git(["ls-tree", "-z", rev, "--", `:(literal)${path}`]).split("\0");
    const row = rows.find((line) => line.slice(line.indexOf("\t") + 1) === path);
    if (!row) return undefined;
    const [mode, type, blob] = row.slice(0, row.indexOf("\t")).split(" ");
    if (type !== "blob" || mode === "120000")
      throw new Error(`${rev}:${path} is not a regular file.`);
    const text = git(["cat-file", "blob", blob!]);
    return { text, source: { kind: "historical", rev, path, blob, ...identity(text) } };
  };
  // Historical cases intentionally use the current checkout's review policy.
  const readSource = (entry: Case, files: Map<string, string>, path: string) => {
    if (ruleFiles.includes(path)) {
      const text = NodeFS.readFileSync(NodePath.join(repo, path), "utf8");
      return { text, source: { kind: "current-rule", path, ...identity(text) } };
    }
    const text = files.get(path);
    if (text !== undefined) return { text, source: { kind: "overlay", path, ...identity(text) } };
    return historical(entry.rev, path);
  };
  const readAt = (entry: Case, files: Map<string, string>, path: string) =>
    readSource(entry, files, path)?.text;
  const grep = (pattern: string, text: string, numbered: boolean) => {
    const result = NodeChildProcess.spawnSync(
      "grep",
      [...(numbered ? ["-n"] : []), "-E", "--", pattern],
      {
        input: text,
        encoding: "utf8",
        maxBuffer: 1 << 26,
      },
    );
    if (result.error || (result.status !== 0 && result.status !== 1))
      throw new Error(result.error?.message ?? (result.stderr.trim() || "grep failed."));
    return result.stdout;
  };
  const grepAt = (entry: Case, files: Map<string, string>, pattern: string, scope: string) => {
    // Invalid expressions remain tool feedback, while source access failures abort the sample.
    const check = NodeChildProcess.spawnSync("grep", ["-E", "--", pattern], {
      input: "",
      encoding: "utf8",
    });
    if (check.error) throw check.error;
    if (check.status !== 0 && check.status !== 1) return check.stderr.trim() || "grep failed.";
    resolve(entry.rev, "commit");
    const served = new Map(files);
    for (const path of ruleFiles) served.set(path, readAt(entry, files, path)!);
    const matched = new Set(
      git(["ls-files", `--with-tree=${entry.rev}`, "-z", "--", scope || "."]).split("\0"),
    );
    const fromRev = git(
      [
        "grep",
        "--no-textconv",
        "-n",
        "-E",
        "-e",
        pattern,
        entry.rev,
        "--",
        scope || ".",
        ...[...served.keys()].map((path) => `:(exclude,literal)${path}`),
      ],
      [0, 1],
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(`${entry.rev}:`, ""))
      .filter((line) => !served.has(line.slice(0, line.indexOf(":"))));
    const fromServed = [...served]
      .filter(([path]) => matched.has(path))
      .flatMap(([path, text]) =>
        grep(pattern, text, true)
          .split("\n")
          .filter(Boolean)
          .map((line) => `${path}:${line}`),
      );
    return [...fromServed, ...fromRev].slice(0, 80).join("\n") || "No matches.";
  };
  const world = (entry: Case) => {
    const rev = resolve(entry.rev, "commit");
    const tree = resolve(rev, "tree");
    const files = new Map<string, string>();
    const paths = entry.type === "real" ? entry.paths : [entry.path];
    const parent = entry.type === "real" ? resolve(`${rev}^1`, "commit") : null;
    const sources = paths.map((path) => {
      const before = historical(parent ?? rev, path);
      const after = parent ? historical(rev, path) : before;
      if (!before && !after) throw new Error(`${entry.id}: missing path ${path}.`);
      return { path, before: before?.source ?? null, after: after?.source ?? null };
    });
    let diff: string;
    if (entry.type === "real") {
      diff = git([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        parent!,
        rev,
        "--",
        ...paths,
      ]);
    } else {
      const before = historical(rev, entry.path)!.text;
      const start = before.indexOf(entry.after);
      if (!entry.after || start < 0 || before.indexOf(entry.after, start + 1) >= 0)
        throw new Error(`${entry.id}: expected exactly one synthetic anchor.`);
      const after = before.replace(entry.after, entry.after + entry.insert);
      files.set(entry.path, after);
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-test-signal-"));
      try {
        NodeFS.writeFileSync(NodePath.join(directory, "before"), before);
        NodeFS.writeFileSync(NodePath.join(directory, "after"), after);
        const raw = NodeChildProcess.spawnSync(
          "git",
          ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "before", "after"],
          {
            cwd: directory,
            encoding: "utf8",
            env: offlineEnv(),
            maxBuffer: 1 << 26,
          },
        );
        if (raw.error || raw.status !== 1)
          throw new Error(
            `${entry.id}: synthetic diff failed: ${raw.error?.message ?? raw.stderr}`,
          );
        diff = raw.stdout
          .replace("diff --git a/before b/after", `diff --git a/${entry.path} b/${entry.path}`)
          .replace("--- a/before", `--- a/${entry.path}`)
          .replace("+++ b/after", `+++ b/${entry.path}`);
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }
    if (!diff.trim()) throw new Error(`${entry.id}: empty diff.`);
    const added = new Map<string, number[]>();
    let path = "";
    let line = 0;
    let inHunk = false;
    for (const row of diff.split("\n")) {
      if (row.startsWith("diff --git ")) inHunk = false;
      else if (!inHunk && row.startsWith("+++ b/")) {
        path = row.slice(6);
        added.set(path, []);
      } else if (row.startsWith("@@")) {
        line = Number(/\+(\d+)/.exec(row)?.[1]);
        inHunk = true;
      } else if (inHunk && row.startsWith("+")) {
        added.get(path)?.push(line);
        line++;
      } else if (inHunk && row.startsWith(" ")) line++;
    }
    const targets = entry.targets.map((target) => {
      const range = testRange(readAt(entry, files, target.path) ?? "", target.title);
      if (!range) throw new Error(`${entry.id}: target "${target.title}" not found.`);
      const addedLines = (added.get(target.path) ?? []).filter(
        (n) => n >= range.start && n <= range.end,
      );
      if (addedLines.length === 0)
        throw new Error(`${entry.id}: target "${target.title}" has no added lines.`);
      return { ...target, ...range, addedLines };
    });
    return { diff, files, targets, rev, tree, parent, sources };
  };

  const preflight = (
    entry: Case,
    directory: string,
    promptFile: string,
    inspect: ReadonlyArray<string> = [],
  ) => {
    NodeFS.mkdirSync(directory, { recursive: true });
    const write = (path: string, value: unknown) =>
      NodeFS.writeFileSync(NodePath.join(directory, path), JSON.stringify(value, null, 2) + "\n");
    const limits = {
      scope:
        "Selected diff, configured targets, current rules and explicitly inspected source paths only.",
      arbitraryHistoricalSourceClosure: false,
      historicalTestsExecuted: false,
      modelQualified: false,
      datasetLabelsChanged: false,
      toolAccess:
        "Arbitrary historical reads/greps remain available offline; unavailable objects abort rather than become absence. Uninspected scopes are not proven.",
    };
    write("offline-preflight.json", { status: "checking", limits });
    try {
      const fixture = world(entry);
      const paths = [
        ...new Set([
          ...(entry.type === "real" ? entry.paths : [entry.path]),
          ...entry.targets.map((t) => t.path),
          ...ruleFiles,
          ...inspect,
        ]),
      ];
      const served = paths.map((path) => {
        const source = readSource(entry, fixture.files, path);
        if (!source && (inspect.includes(path) || ruleFiles.includes(path)))
          throw new Error(`${entry.id}: inspected source missing: ${path}`);
        const pattern =
          source?.text
            .split("\n")
            .find((line) => line.trim())
            ?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? ".";
        const output = grepAt(entry, fixture.files, pattern, path);
        if (source?.text.trim() && output === "No matches.")
          throw new Error(`${entry.id}: served grep did not find ${path}.`);
        return {
          path,
          read: source?.source ?? { kind: "absent", rev: fixture.rev, path },
          grep: { pattern, output, ...identity(output) },
        };
      });
      NodeFS.writeFileSync(NodePath.join(directory, "test.diff"), fixture.diff);
      write("targets.json", fixture.targets);
      write("served-files.json", served);
      const code = ["run.ts", "fixtures.ts", "cases.ts", "grade.ts"].map((name) => {
        const text = NodeFS.readFileSync(NodePath.join(import.meta.dirname, name), "utf8");
        return { path: `evals/test-signal/${name}`, ...identity(text) };
      });
      write("provenance.json", {
        case: entry,
        rev: fixture.rev,
        tree: fixture.tree,
        parent: fixture.parent,
        parentTree: fixture.parent ? resolve(fixture.parent, "tree") : null,
        sources: fixture.sources,
        overlays: [...fixture.files].map(([path, text]) => ({ path, ...identity(text) })),
        code,
        prompt: { path: promptFile, ...identity(NodeFS.readFileSync(promptFile, "utf8")) },
        rules: served
          .filter((source) => ruleFiles.includes(source.path))
          .map((source) => source.read),
        runtime: { node: process.version, git: git(["--version"]).trim(), gitNoLazyFetch: "1" },
        diff: identity(fixture.diff),
      });
      write("offline-preflight.json", { status: "complete", case: entry.id, limits });
      return fixture;
    } catch (error) {
      write("offline-preflight.json", {
        status: "failed",
        case: entry.id,
        error: String(error),
        limits,
      });
      throw error;
    }
  };
  return { world, readAt, grepAt, preflight };
};
