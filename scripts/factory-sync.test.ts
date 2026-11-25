import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";

import type { SeamConfig } from "./factory-seams.ts";
import {
  classifyConflict,
  formatPlan,
  gitNoFetchEnv,
  parseMergeTreeConflicts,
  planExitCode,
  planUpstreamSync,
  type UpstreamSyncPlan,
} from "./factory-sync.ts";

const config = {
  base: "origin/main",
  owned: ["factory/**", "scripts/factory-*.ts"],
  seams: ["apps/server/src/ws.ts", { path: "factory/owned-seam.ts", maxAdded: 3 }],
  generated: ["apps/web/src/i18n/translations/*.json"],
} satisfies SeamConfig;

it.effect.each([
  { path: "apps/server/src/ws.ts", expected: "seam" },
  { path: "apps/web/src/i18n/translations/de.json", expected: "generated" },
  { path: "factory/workflows/factory-task.ts", expected: "owned" },
  { path: "factory/owned-seam.ts", expected: "seam" },
  { path: "apps/server/src/upstream.ts", expected: "outside" },
])("classifies $path as $expected", ({ path, expected }) =>
  Effect.sync(() => {
    assert.strictEqual(classifyConflict(path, config), expected);
  }),
);

it.effect.each([
  { name: "only the tree id", stdout: "abc123\0", expected: [] },
  { name: "nothing", stdout: "", expected: [] },
  { name: "several paths", stdout: "abc123\0a.ts\0b/c.ts\0", expected: ["a.ts", "b/c.ts"] },
  {
    name: "duplicates and empty entries",
    stdout: "abc123\0a.ts\0\0b.ts\0a.ts\0\0",
    expected: ["a.ts", "b.ts"],
  },
  {
    name: "paths with non-ASCII, spaces and newlines",
    stdout: "abc123\0factory/café.txt\0a b\nc.ts\0",
    expected: ["factory/café.txt", "a b\nc.ts"],
  },
  { name: "newline format, only the tree id", stdout: "abc123\n", expected: [] },
  {
    name: "newline format, several paths",
    stdout: "abc123\na.ts\nb/c.ts\n",
    expected: ["a.ts", "b/c.ts"],
  },
  {
    name: "newline format, duplicates and blank lines",
    stdout: "abc123\r\na.ts\r\n\r\nb.ts\r\na.ts\r\n\r\n",
    expected: ["a.ts", "b.ts"],
  },
])("parses merge-tree output: $name", ({ stdout, expected }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(parseMergeTreeConflicts(stdout), expected);
  }),
);

const goodPlan = {
  clean: true,
  ref: "v1",
  refFound: true,
  mergeBase: { status: "found", sha: "abc" },
  conflicts: [
    { kind: "seam", path: "apps/server/src/ws.ts" },
    { kind: "generated", path: "apps/web/src/i18n/translations/de.json" },
    { kind: "owned", path: "factory/a.ts" },
  ],
} satisfies UpstreamSyncPlan;

const exitCodeCases: ReadonlyArray<{
  readonly name: string;
  readonly plan: UpstreamSyncPlan;
  readonly expected: number;
}> = [
  { name: "accepts seam, generated and owned conflicts", plan: goodPlan, expected: 0 },
  { name: "rejects a dirty tree", plan: { ...goodPlan, clean: false }, expected: 1 },
  {
    name: "rejects an unknown ref",
    plan: { ...goodPlan, refFound: false, mergeBase: { status: "skipped" }, conflicts: [] },
    expected: 1,
  },
  {
    name: "rejects a missing merge base",
    plan: { ...goodPlan, mergeBase: { status: "none" }, conflicts: [] },
    expected: 1,
  },
  {
    name: "rejects an outside conflict",
    plan: { ...goodPlan, conflicts: [{ kind: "outside", path: "apps/server/src/upstream.ts" }] },
    expected: 1,
  },
];

it.effect.each(exitCodeCases)("exit code: $name", ({ plan, expected }) =>
  Effect.sync(() => {
    assert.strictEqual(planExitCode(plan), expected);
  }),
);

it.effect("treats an unclassified merge-tree failure as an outside conflict", () =>
  Effect.sync(() => {
    const conflicts = parseMergeTreeConflicts("abc123\0", 1).map((path) => ({
      kind: classifyConflict(path, config),
      path,
    }));
    assert.deepStrictEqual(conflicts, [{ kind: "outside", path: "<unclassified merge conflict>" }]);
    assert.strictEqual(
      classifyConflict("<unclassified merge conflict>", { ...config, owned: ["**"] }),
      "outside",
    );
    assert.strictEqual(planExitCode({ ...goodPlan, conflicts }), 1);
  }),
);

it.effect("formats the plan as tab-separated lines", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(formatPlan(goodPlan), [
      "tree\tclean",
      "ref\tv1\tfound",
      "merge-base\tabc",
      "conflict\tseam\tapps/server/src/ws.ts",
      "conflict\tgenerated\tapps/web/src/i18n/translations/de.json",
      "conflict\towned\tfactory/a.ts",
      "factory-sync: ok",
    ]);
    assert.deepStrictEqual(
      formatPlan({
        ...goodPlan,
        clean: false,
        conflicts: [{ kind: "outside", path: "x.ts" }],
      }).slice(-3),
      ["merge-base\tabc", "conflict\toutside\tx.ts", "factory-sync: 2 problem(s)"],
    );
  }),
);

it.effect("prints one three-field record per conflict, escaping control characters", () =>
  Effect.sync(() => {
    const path = "factory/a\tb\nc\\d\x01.txt";
    const lines = formatPlan({
      ...goodPlan,
      ref: "v1\tx",
      conflicts: [
        { kind: "owned", path },
        { kind: "owned", path: "factory/café.txt" },
      ],
    });
    assert.deepStrictEqual(lines.slice(1, 2), ["ref\tv1\\tx\tfound"]);
    const records = lines.filter((line) => line.startsWith("conflict\t"));
    assert.deepStrictEqual(records, [
      "conflict\towned\tfactory/a\\tb\\nc\\\\d\\x01.txt",
      "conflict\towned\tfactory/café.txt",
    ]);
    for (const record of records) assert.lengthOf(record.split("\t"), 3);
    assert.lengthOf(lines, 1 + 1 + 1 + 2 + 1);
    assert.strictEqual(classifyConflict(path, config), "owned");
  }),
);

const seamsJson = `${JSON.stringify(config, null, 2)}\n`;

// The planner's git subprocesses inherit the process environment, so the fixture
// points git at an empty global file and ignores the system file while a test runs.
const isolateGitConfig = Effect.fn("factorySyncTest.isolateGitConfig")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const globalConfig = path.join(root, "empty-gitconfig");
  yield* fs.writeFileString(globalConfig, "");
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    }),
    () => Effect.sync(() => vi.unstubAllEnvs()),
  );
});

const makeGit = Effect.fn("factorySyncTest.makeGit")(function* (cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return (...args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("git", ["-c", "commit.gpgsign=false", ...args], { cwd }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (all, chunk) => all + chunk,
              ),
            ),
            child.stderr.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (all, chunk) => all + chunk,
              ),
            ),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(Number(exitCode), 0, `git ${args.join(" ")} failed: ${stderr}`);
        return stdout;
      }),
    );
});

const makeRepository = Effect.fn("factorySyncTest.makeRepository")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "factory-sync-" });
  yield* isolateGitConfig(root);
  const cwd = path.join(root, "repository");
  yield* fs.makeDirectory(cwd);
  const git = yield* makeGit(cwd);

  const write = (file: string, text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, file), text);
    });
  const commit = (message: string) =>
    Effect.gen(function* () {
      yield* git("add", "-A");
      yield* git("commit", "-m", message);
    });

  yield* git("init", "-b", "main");
  yield* git("config", "user.name", "Factory Test");
  yield* git("config", "user.email", "factory-test@example.com");
  yield* git("config", "core.autocrlf", "false");
  yield* write("factory/seams.json", seamsJson);
  yield* write("factory/café.txt", "one\ntwo\nthree\n");
  yield* write("shared.txt", "one\ntwo\nthree\n");
  yield* write("other.txt", "untouched\n");
  yield* commit("base");

  return { root, cwd, git, write, commit };
});

const missingObjects = (git: Effect.Success<ReturnType<typeof makeGit>>, ref: string) =>
  git("rev-list", "--objects", "--missing=print", ref).pipe(
    Effect.map((out) => out.split("\n").filter((line) => line.startsWith("?"))),
  );

it.layer(NodeServices.layer)("factory sync plan", (it) => {
  it.effect("reports a clean merge", () =>
    Effect.gen(function* () {
      const repository = yield* makeRepository();
      yield* repository.git("switch", "-c", "upstream");
      yield* repository.write("other.txt", "changed upstream\n");
      yield* repository.commit("upstream edit");
      yield* repository.git("switch", "main");
      yield* repository.write("shared.txt", "one\ntwo\nthree\nfour\n");
      yield* repository.commit("local edit");

      const plan = yield* planUpstreamSync(repository.cwd, "upstream");
      assert.isTrue(plan.clean);
      assert.isTrue(plan.refFound);
      assert.strictEqual(plan.mergeBase.status, "found");
      assert.deepStrictEqual(plan.conflicts, []);
      assert.strictEqual(planExitCode(plan), 0);
      assert.strictEqual((yield* repository.git("status", "--porcelain")).trim(), "");
    }),
  );

  it.effect("reports a conflict in a file outside the seams", () =>
    Effect.gen(function* () {
      const repository = yield* makeRepository();
      yield* repository.git("switch", "-c", "upstream");
      yield* repository.write("shared.txt", "one\nupstream\nthree\n");
      yield* repository.commit("upstream edit");
      yield* repository.git("switch", "main");
      yield* repository.write("shared.txt", "one\nlocal\nthree\n");
      yield* repository.commit("local edit");
      const head = (yield* repository.git("rev-parse", "HEAD")).trim();

      const plan = yield* planUpstreamSync(repository.cwd, "upstream");
      assert.deepStrictEqual(plan.conflicts, [{ kind: "outside", path: "shared.txt" }]);
      assert.strictEqual(planExitCode(plan), 1);
      assert.strictEqual((yield* repository.git("rev-parse", "HEAD")).trim(), head);
      assert.strictEqual((yield* repository.git("status", "--porcelain")).trim(), "");
    }),
  );

  it.effect("classifies a conflict in a non-ASCII path by its real name", () =>
    Effect.gen(function* () {
      const repository = yield* makeRepository();
      yield* repository.git("switch", "-c", "upstream");
      yield* repository.write("factory/café.txt", "one\nupstream\nthree\n");
      yield* repository.commit("upstream edit");
      yield* repository.git("switch", "main");
      yield* repository.write("factory/café.txt", "one\nlocal\nthree\n");
      yield* repository.commit("local edit");

      const plan = yield* planUpstreamSync(repository.cwd, "upstream");
      assert.deepStrictEqual(plan.conflicts, [{ kind: "owned", path: "factory/café.txt" }]);
      assert.strictEqual(planExitCode(plan), 0);
    }),
  );

  it.effect("fails on an unknown ref and a dirty tree", () =>
    Effect.gen(function* () {
      const repository = yield* makeRepository();

      const unknown = yield* planUpstreamSync(repository.cwd, "no-such-ref");
      assert.isFalse(unknown.refFound);
      assert.strictEqual(unknown.mergeBase.status, "skipped");
      assert.strictEqual(planExitCode(unknown), 1);

      const option = yield* planUpstreamSync(repository.cwd, "--all");
      assert.isFalse(option.refFound);

      yield* repository.write("other.txt", "edited\n");
      const dirty = yield* planUpstreamSync(repository.cwd, "main");
      assert.isFalse(dirty.clean);
      assert.isTrue(dirty.refFound);
      assert.strictEqual(planExitCode(dirty), 1);
    }),
  );

  it.effect("fails when the ref shares no history with HEAD", () =>
    Effect.gen(function* () {
      const repository = yield* makeRepository();
      yield* repository.git("switch", "--orphan", "unrelated");
      yield* repository.write("unrelated.txt", "x\n");
      yield* repository.commit("unrelated root");
      yield* repository.git("switch", "main");

      const plan = yield* planUpstreamSync(repository.cwd, "unrelated");
      assert.strictEqual(plan.mergeBase.status, "none");
      assert.deepStrictEqual(plan.conflicts, []);
      assert.strictEqual(planExitCode(plan), 1);
    }),
  );

  it.effect("does not fetch missing objects in a partial clone", () =>
    Effect.gen(function* () {
      const source = yield* makeRepository();
      yield* source.git("config", "uploadpack.allowFilter", "true");
      yield* source.git("config", "uploadpack.allowAnySHA1InWant", "true");
      yield* source.git("switch", "-c", "upstream");
      yield* source.write("shared.txt", "one\nupstream\nthree\n");
      yield* source.commit("upstream edit");
      yield* source.git("switch", "main");
      yield* source.write("shared.txt", "one\ntwo\nlocal\n");
      yield* source.commit("local edit");

      const path = yield* Path.Path;
      const clone = path.join(source.root, "clone");
      yield* source.git(
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--filter=blob:none",
        "--branch",
        "main",
        NodeURL.pathToFileURL(source.cwd).href,
        clone,
      );
      const git = yield* makeGit(clone);
      const before = yield* missingObjects(git, "origin/upstream");
      assert.isAbove(before.length, 0);

      const error = yield* Effect.flip(planUpstreamSync(clone, "origin/upstream"));
      assert.strictEqual(error._tag, "FactorySyncGitError");
      assert.deepStrictEqual(yield* missingObjects(git, "origin/upstream"), before);

      // A git that ignores GIT_NO_LAZY_FETCH must still be unable to fetch.
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const exitCode = yield* spawner.exitCode(
        ChildProcess.make(
          "git",
          ["merge-tree", "--write-tree", "--name-only", "-z", "HEAD", "origin/upstream"],
          {
            cwd: clone,
            env: { GIT_ALLOW_PROTOCOL: gitNoFetchEnv.GIT_ALLOW_PROTOCOL },
            extendEnv: true,
          },
        ),
      );
      assert.notStrictEqual(Number(exitCode), 0);
      assert.deepStrictEqual(yield* missingObjects(git, "origin/upstream"), before);
    }),
  );
});
