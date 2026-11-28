// @effect-diagnostics nodeBuiltinImport:off - The rendered module is imported from a temporary file.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  applyEntries,
  decodeOverlay,
  factoryVersion,
  planEntries,
  renderPackModule,
  scrubEnvironment,
  stageDesktop,
  validateOverlay,
} from "./factory-desktop.ts";

const entry = {
  id: "app",
  file: "app.ts",
  find: "old",
  replace: "new",
  why: "Give the application a separate identity.",
};
const generated = ["apps/web/src/i18n/translations/*.json"];
const tracked = new Set([entry.file]);

it.effect("decodes the versioned overlay and rejects an invalid entry shape", () =>
  Effect.gen(function* () {
    const overlay = { v: 1, entries: [entry] } as const;
    assert.deepStrictEqual(yield* decodeOverlay(JSON.stringify(overlay)), overlay);
    assert.deepStrictEqual(validateOverlay(overlay, generated, tracked), []);
    const malformed = { v: 1, entries: [{ ...entry, count: "2" }] };
    assert.isTrue(yield* Effect.isFailure(decodeOverlay(JSON.stringify(malformed))));
  }),
);

it.each([
  { name: "once", source: "old stock", edits: [entry], expected: "new stock" },
  {
    name: "explicit count",
    source: "old old",
    edits: [{ ...entry, count: 2 }],
    expected: "new new",
  },
  {
    name: "each entry matches the original file",
    source: "old new",
    edits: [entry, { ...entry, id: "second", find: "new", replace: "third" }],
    expected: "new third",
  },
])("applies $name", ({ source, edits, expected }) => {
  assert.deepStrictEqual(applyEntries(source, edits), { text: expected, problems: [] });
});

it.each([
  { source: "other", count: undefined, found: 0 },
  { source: "old old", count: undefined, found: 2 },
  { source: "old", count: 2, found: 1 },
])("reports drift for $source with count $count", ({ source, count, found }) => {
  const edits = [count === undefined ? entry : { ...entry, count }];
  assert.deepStrictEqual(applyEntries(source, edits), {
    problems: [`drift app app.ts: found ${found}, expected ${count ?? 1}`],
    text: source,
  });
});

it("refuses an entry whose only match would come from another replacement", () => {
  const result = applyEntries("old", [
    entry,
    { ...entry, id: "second", find: "new", replace: "third" },
  ]);
  assert.deepStrictEqual(result, {
    text: "old",
    problems: ["drift second app.ts: found 0, expected 1"],
  });
});

it.each([
  {
    source: "old",
    edits: [entry, { ...entry, id: "tail", find: "ld" }],
    error: "app overlaps tail",
  },
  { source: "aaa", edits: [{ ...entry, find: "aa", count: 2 }], error: "app overlaps app" },
])("rejects overlapping matches in $source", ({ source, edits, error }) => {
  assert.deepStrictEqual(planEntries(source, edits).problems, [`A4 app.ts: ${error}`]);
});

it.each([
  "factory/desktop/code.ts",
  "apps/server/src/factory/file.ts",
  "apps/web/src/factory/file.ts",
  "apps/web/src/i18n/translations/fr.json",
  "pnpm-lock.yaml",
  "packages/some/Cargo.lock",
  "../app.ts",
  "C:/app.ts",
  "apps\\file.ts",
])("rejects ineligible overlay target %s even when tracked", (file) => {
  assert.deepStrictEqual(
    validateOverlay({ v: 1, entries: [{ ...entry, file }] }, generated, new Set([file])),
    [`A2 app: forbidden or untracked file ${file}`],
  );
});

it("checks the budget, tracked files, ids, reasons and literal substitutions", () => {
  const entries = Array.from({ length: 24 }, (_, index) => ({ ...entry, id: String(index) }));
  assert.deepStrictEqual(validateOverlay({ v: 1, entries }, generated, tracked), []);
  const invalid = { ...entries[0]!, why: "", file: "untracked.ts", replace: entry.find };
  const problems = validateOverlay({ v: 1, entries: [...entries, invalid] }, generated, tracked);
  assert.deepStrictEqual(
    problems.map((message) => message.slice(0, 2)),
    ["A1", "A1", "A1", "A2", "A3"],
  );
});

it("matches CRLF checkout text and preserves literal commit bytes during staging", () => {
  const edits = [{ ...entry, find: "old\nname", replace: "new\nname" }];
  assert.deepStrictEqual(applyEntries("old\r\nname\r\n", edits, true), {
    text: "new\nname\n",
    problems: [],
  });
  assert.deepStrictEqual(applyEntries("old\r\nname\r\n", [entry]), {
    text: "new\r\nname\r\n",
    problems: [],
  });
});

it("imports the rendered module with exact workflow filenames and contents", async () => {
  const pack = {
    "lib/z.ts": 'export const value = "λ\\n";\r\n',
    "a.ts": "\uFEFF`\u2028\n",
    ["__proto__"]: "own file",
  };
  const source = NodeModule.stripTypeScriptTypes(renderPackModule(pack));
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const imported = await import(/* @vite-ignore */ url);
  assert.deepStrictEqual(imported.BUNDLED_FACTORY_PACK, pack);
  assert.deepStrictEqual(Object.keys(imported.BUNDLED_FACTORY_PACK), [
    "__proto__",
    "a.ts",
    "lib/z.ts",
  ]);
});

it("prefixes a leading-zero numeric commit abbreviation in the prerelease version", () => {
  assert.equal(factoryVersion("0.1.12", "0001234" + "a".repeat(33)), "0.1.12-factory.g0001234");
});

it("scrubs inherited build, signing, update and local environment overrides case-insensitively", () => {
  const env = {
    Path: "tools",
    SystemRoot: "windows",
    TEMP: "temp",
    GITHUB_REPOSITORY: "repo",
    GH_TOKEN: "token",
    github_token: "token",
    T3CODE_DESKTOP_UPDATE_REPOSITORY: "feed",
    T3CODE_DESKTOP_SIGNED: "true",
    T3CODE_DESKTOP_MOCK_UPDATES: "true",
    T3CODE_HOME: "home",
    t3code_dev_auth_token: "dev",
    Vite_WS_URL: "origin",
    CSC_LINK: "key",
    WIN_CSC_KEY_PASSWORD: "password",
    AZURE_TRUSTED_SIGNING_ENDPOINT: "endpoint",
    APPLE_API_KEY: "key",
    SIGNTOOL_PATH: "tool",
    GIT_DIR: "other",
  };
  assert.deepStrictEqual(scrubEnvironment(env), {
    Path: "tools",
    SystemRoot: "windows",
    TEMP: "temp",
  });
  assert.equal(env.CSC_LINK, "key");
});

it.effect.each([
  { sha: "d9328b9", error: "40-hex commit SHA" },
  { sha: "d9328b964c87d2a7e29bd550fa646645127fe962", error: "inside the repository" },
])("stage refuses $error before exporting or writing", ({ sha, error }) =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      stageDesktop(sha, NodePath.join(import.meta.dirname, "refused-stage")),
    );
    assert.include(failure.message, error);
  }).pipe(Effect.provide(NodeServices.layer)),
);
