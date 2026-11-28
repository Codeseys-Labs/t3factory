import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DEFAULT_INSPECT_RULES,
  FactoryDesktopInspectError,
  formatInspectResult,
  inspectDesktopApp,
  scanDesktopApp,
  type InspectInput,
} from "./factory-desktop-inspect.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const validAppAsarText = (omitLiteral?: string): string =>
  DEFAULT_INSPECT_RULES.required
    .filter((rule) => rule.literal !== omitLiteral)
    .map((rule) => JSON.stringify(rule.literal))
    .join("\n");

const validInput = (overrides?: {
  readonly files?: ReadonlyArray<string>;
  readonly appAsarText?: string;
  readonly serverAsarText?: string;
}): InspectInput => ({
  files: overrides?.files ?? ["T3 Factory v2.exe", "resources/app.asar", "resources/server.asar"],
  resources: [
    {
      path: "resources/app.asar",
      bytes: utf8(overrides?.appAsarText ?? validAppAsarText()),
    },
    {
      path: "resources/server.asar",
      bytes: utf8(
        overrides?.serverAsarText ??
          [
            'PayloadType:"com.t3tools.t3code"',
            '"https://play.google.com/store/apps/details?id=com.t3tools.t3code"',
            '"T3 Code failed to start"',
            '"t3code://pair?pairingUrl=https://example.invalid"',
          ].join("\n"),
      ),
    },
  ],
});

it.effect("passes when all required literals are present and none forbidden appear", () =>
  Effect.sync(() => {
    const result = scanDesktopApp(validInput());
    assert.deepStrictEqual(result, {
      ok: true,
      requiredCount: DEFAULT_INSPECT_RULES.required.length,
      forbiddenCount: DEFAULT_INSPECT_RULES.forbidden.length,
      problems: [],
    });
    assert.deepStrictEqual(formatInspectResult(result), [
      `factory-desktop-inspect: ok (${DEFAULT_INSPECT_RULES.required.length} required, ${DEFAULT_INSPECT_RULES.forbidden.length} forbidden)`,
    ]);
  }),
);

it.effect.each(DEFAULT_INSPECT_RULES.required)(
  "reports missing required literal $literal",
  (rule) =>
    Effect.sync(() => {
      const result = scanDesktopApp(validInput({ appAsarText: validAppAsarText(rule.literal) }));
      assert.isFalse(result.ok);
      assert.deepStrictEqual(result.problems, [
        {
          kind: "missing-literal",
          literal: rule.literal,
          reason: rule.reason,
        },
      ]);
      assert.deepStrictEqual(formatInspectResult(result), [`missing ${rule.literal}`]);
    }),
);

const forbiddenPatternCases = DEFAULT_INSPECT_RULES.forbidden.flatMap((rule) =>
  (rule.patterns ?? [rule.literal]).map((snippet) => ({
    name: `${rule.literal} as ${snippet}`,
    rule,
    snippet,
  })),
);

it.effect.each(forbiddenPatternCases)(
  "reports forbidden literal with its file ($name)",
  ({ rule, snippet }) =>
    Effect.sync(() => {
      const result = scanDesktopApp(
        validInput({ appAsarText: `${validAppAsarText()}\n${snippet}` }),
      );
      assert.isFalse(result.ok);
      assert.deepStrictEqual(result.problems, [
        {
          kind: "forbidden-literal",
          literal: rule.literal,
          file: "resources/app.asar",
          reason: rule.reason,
        },
      ]);
      assert.deepStrictEqual(formatInspectResult(result), [
        `forbidden ${rule.literal} in resources/app.asar`,
      ]);
    }),
);

it.effect("does not join a literal split across two resource files", () =>
  Effect.sync(() => {
    const [required] = DEFAULT_INSPECT_RULES.required;
    if (required === undefined) {
      assert.fail("expected at least one required rule");
      return;
    }
    const split = (text: string, head: string, tail: string) =>
      scanDesktopApp({
        files: ["T3 Factory v2.exe", "resources/part-a.bin", "resources/part-b.bin"],
        resources: [
          { path: "resources/part-a.bin", bytes: utf8(`${text}\n${head}`) },
          { path: "resources/part-b.bin", bytes: utf8(tail) },
        ],
      });
    const midpoint = Math.floor(required.literal.length / 2);
    assert.deepStrictEqual(
      split(
        validAppAsarText(required.literal),
        required.literal.slice(0, midpoint),
        required.literal.slice(midpoint),
      ).problems,
      [{ kind: "missing-literal", literal: required.literal, reason: required.reason }],
    );
    assert.deepStrictEqual(split(validAppAsarText(), '"com.t3tools.', 't3code"').problems, []);
  }),
);

it.effect("does not trip on a stock name held in a form the app's code does not use", () =>
  Effect.sync(() => {
    const result = scanDesktopApp(
      validInput({
        appAsarText: [
          validAppAsarText(),
          '"com.t3tools.t3code.dev"',
          "'com.t3tools.t3code.dev'",
          "`com.t3tools.t3code.dev`",
          '"com.t3tools.t3code.service"',
          '"https://play.google.com/store/apps/details?id=com.t3tools.t3code"',
          '${If} $1 == "T3 Code (Alpha)"',
          "Where-Object { $$_ -in 'T3 Code (Alpha)', 'T3 Code (Beta)' }",
        ].join("\n"),
      }),
    );
    assert.isTrue(result.ok);
    assert.deepStrictEqual(result.problems, []);
  }),
);

it.effect.each([
  "app-update.yml",
  "resources/app-update.yml",
  "resources/nested/APP-UPDATE.YML",
] as const)("fails when %s exists anywhere under the app folder", (updateFile) =>
  Effect.sync(() => {
    const result = scanDesktopApp(
      validInput({
        files: ["T3 Factory v2.exe", "resources/app.asar", "resources/server.asar", updateFile],
      }),
    );
    assert.isFalse(result.ok);
    assert.deepStrictEqual(result.problems, [
      {
        kind: "forbidden-file",
        name: "app-update.yml",
        file: updateFile,
      },
    ]);
    assert.deepStrictEqual(formatInspectResult(result), [
      `forbidden app-update.yml in ${updateFile}`,
    ]);
  }),
);

const executableCases: ReadonlyArray<{
  readonly name: string;
  readonly files: ReadonlyArray<string>;
  readonly expectedLines: ReadonlyArray<string>;
}> = [
  {
    name: "stock executable instead of Factory executable",
    files: ["T3 Code (Beta).exe", "resources/app.asar", "resources/server.asar"],
    expectedLines: ["missing T3 Factory v2.exe", "forbidden T3 Code (Beta).exe"],
  },
  {
    name: "stock Beta executable beside Factory executable",
    files: [
      "T3 Factory v2.exe",
      "T3 Code (Beta).exe",
      "resources/app.asar",
      "resources/server.asar",
    ],
    expectedLines: ["forbidden T3 Code (Beta).exe"],
  },
  {
    name: "stock Nightly executable beside Factory executable",
    files: [
      "T3 Factory v2.exe",
      "T3 Code (Nightly).exe",
      "resources/app.asar",
      "resources/server.asar",
    ],
    expectedLines: ["forbidden T3 Code (Nightly).exe"],
  },
];

it.effect.each(executableCases)("fails on stock executable ($name)", ({ files, expectedLines }) =>
  Effect.sync(() => {
    const result = scanDesktopApp(validInput({ files }));
    assert.isFalse(result.ok);
    assert.deepStrictEqual(formatInspectResult(result), expectedLines);
  }),
);

it.layer(NodeServices.layer)("inspectDesktopApp", (it) => {
  it.effect("scans raw bytes under resources without parsing .asar", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "factory-desktop-inspect-" });
      const resourcesDir = path.join(root, "resources");
      yield* fs.makeDirectory(resourcesDir, { recursive: true });
      yield* fs.writeFile(path.join(root, "T3 Factory v2.exe"), utf8("MZ"));
      yield* fs.writeFile(
        path.join(resourcesDir, "app.asar"),
        utf8(`NOT-A-VALID-ASAR-HEADER\0${validAppAsarText()}`),
      );
      const result = yield* inspectDesktopApp(root);
      assert.isTrue(result.ok);
      assert.deepStrictEqual(result.problems, []);
    }),
  );

  it.effect("fails with FactoryDesktopInspectError when the app directory is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "factory-desktop-inspect-" });
      const missing = path.join(root, "does-not-exist");
      const error = yield* Effect.flip(inspectDesktopApp(missing));
      assert.instanceOf(error, FactoryDesktopInspectError);
      assert.strictEqual(error.operation, "stat-app");
    }),
  );
});
