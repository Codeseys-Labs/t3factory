import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  classifySeamChanges,
  matchesSeamGlob,
  type SeamChange,
  type SeamChangeClassification,
  type SeamConfig,
} from "./factory-seams.ts";

const baseConfig = {
  base: "origin/main",
  owned: ["factory/**"],
  seams: [],
  generated: ["apps/web/src/i18n/translations/*.json"],
} satisfies SeamConfig;

const seamPaths = Array.from({ length: 13 }, (_, index) => `apps/server/src/seam-${index}.ts`);

const classificationCases: ReadonlyArray<{
  readonly name: string;
  readonly changes: ReadonlyArray<SeamChange>;
  readonly config: SeamConfig;
  readonly expected: SeamChangeClassification;
}> = [
  {
    name: "allows an owned add",
    changes: [{ status: "A", path: "factory/workflows/factory-task.ts" }],
    config: baseConfig,
    expected: { ok: true, offences: [] },
  },
  {
    name: "reports an unowned add",
    changes: [{ status: "A", path: "apps/server/src/upstream.ts" }],
    config: baseConfig,
    expected: {
      ok: false,
      offences: [{ path: "apps/server/src/upstream.ts", reason: "unowned-add" }],
    },
  },
  {
    name: "allows an edit to a listed seam",
    changes: [{ status: "M", path: "apps/server/src/ws.ts" }],
    config: { ...baseConfig, seams: ["apps/server/src/ws.ts"] },
    expected: { ok: true, offences: [] },
  },
  {
    name: "reports an edit to an unlisted upstream file",
    changes: [{ status: "M", path: "apps/server/src/upstream.ts" }],
    config: baseConfig,
    expected: {
      ok: false,
      offences: [{ path: "apps/server/src/upstream.ts", reason: "unlisted-edit" }],
    },
  },
  {
    name: "reports an upstream delete",
    changes: [{ status: "D", path: "apps/server/src/upstream.ts" }],
    config: baseConfig,
    expected: {
      ok: false,
      offences: [{ path: "apps/server/src/upstream.ts", reason: "upstream-delete" }],
    },
  },
  {
    name: "allows a generated file edit",
    changes: [{ status: "M", path: "apps/web/src/i18n/translations/en.json" }],
    config: baseConfig,
    expected: { ok: true, offences: [] },
  },
  {
    name: "reports more than twelve seams",
    changes: seamPaths.map((path) => ({ status: "M", path })),
    config: { ...baseConfig, seams: seamPaths },
    expected: {
      ok: false,
      offences: [{ path: "factory/seams.json", reason: "too-many-seams" }],
    },
  },
  {
    name: "reports a seam that did not change",
    changes: [{ status: "A", path: "factory/workflows/factory-task.ts" }],
    config: { ...baseConfig, seams: ["apps/server/src/ws.ts"] },
    expected: {
      ok: false,
      offences: [{ path: "apps/server/src/ws.ts", reason: "stale-seam" }],
    },
  },
];

it.effect.each(classificationCases)("$name", ({ changes, config, expected }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(classifySeamChanges(changes, config), expected);
  }),
);

it.effect.each([
  { added: 3, expected: { ok: true, offences: [] } },
  {
    added: 4,
    expected: {
      ok: false,
      offences: [
        { path: "seam.ts", reason: "too-many-added-lines" as const, added: 4, maxAdded: 3 },
      ],
    },
  },
])("enforces seam cap with $added added lines", ({ added, expected }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(
      classifySeamChanges(
        [{ status: "M", path: "seam.ts" }],
        { ...baseConfig, seams: [{ path: "seam.ts", maxAdded: 3 }] },
        new Map([["seam.ts", added]]),
      ),
      expected,
    );
  }),
);

it.effect.each([
  { added: [30, 30], expected: { ok: true, offences: [] } },
  {
    added: [30, 31],
    expected: {
      ok: false,
      offences: [
        {
          path: "factory/seams.json",
          reason: "too-many-added-lines-in-total" as const,
          added: 61,
          maxAdded: 60,
        },
      ],
    },
  },
])("enforces the total cap with $added added lines", ({ added, expected }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(
      classifySeamChanges(
        [
          { status: "M", path: "a.ts" },
          { status: "M", path: "b.ts" },
        ],
        { ...baseConfig, seams: ["a.ts", { path: "b.ts", maxAdded: 40 }], maxAddedTotal: 60 },
        new Map([
          ["a.ts", added[0] ?? 0],
          ["b.ts", added[1] ?? 0],
        ]),
      ),
      expected,
    );
  }),
);

const globCases: ReadonlyArray<{
  readonly glob: string;
  readonly path: string;
  readonly expected: boolean;
}> = [
  { glob: "factory/**", path: "factory/a/b.ts", expected: true },
  { glob: "factory/**", path: "factory/a.ts", expected: true },
  { glob: "scripts/factory-*.ts", path: "scripts/factory-seams.ts", expected: true },
  { glob: "scripts/factory-*.ts", path: "scripts/x/factory-a.ts", expected: false },
];

it.effect.each(globCases)("$glob $path", ({ glob, path, expected }) =>
  Effect.sync(() => {
    assert.equal(matchesSeamGlob(glob, path), expected);
  }),
);
