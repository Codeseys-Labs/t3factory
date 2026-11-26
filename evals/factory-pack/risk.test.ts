// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import {
  classifyRisk,
  FORK_SEAM_PATHS,
  matchesRiskGlob,
  ratchetRiskTier,
  type RiskInput,
  type RiskTier,
} from "../../factory/workflows/lib/risk.ts";

const decodeSeams = Schema.decodeUnknownSync(
  Schema.Struct({ seams: Schema.Array(Schema.Struct({ path: Schema.String })) }),
);

it.effect("pins fork seam paths to the seam manifest", () =>
  Effect.sync(() => {
    const manifest = decodeSeams(
      JSON.parse(NodeFS.readFileSync(new URL("../../factory/seams.json", import.meta.url), "utf8")),
    );
    const paths = [...new Set(manifest.seams.map((seam) => seam.path))].sort();
    expect([...FORK_SEAM_PATHS].sort()).toEqual(paths);
  }),
);

it.effect.each([
  { glob: "src/**/file.ts", path: "src/file.ts", matches: true },
  { glob: "src/**/file.ts", path: "src/a/b/file.ts", matches: true },
  { glob: "src/**/file.ts", path: "src/a/b/other.ts", matches: false },
  { glob: "src/*.ts", path: "src/file.ts", matches: true },
  { glob: "src/*.ts", path: "src/nested/file.ts", matches: false },
  { glob: "a\\*.ts", path: "a/b.ts", matches: true },
  { glob: "a/*.ts", path: "a\\b.ts", matches: true },
  { glob: "package.json", path: "package.json", matches: true },
  { glob: "package.json", path: "apps/web/package.json", matches: false },
])("matches $path against $glob: $matches", ({ glob, path, matches }) =>
  Effect.sync(() => expect(matchesRiskGlob(glob, path)).toBe(matches)),
);

const baseline: RiskInput = {
  files: ["src/feature.ts"],
  changedFiles: 1,
  headSha: "abc123",
  checks: "passing",
  fixRoundsUsed: 0,
  fixRounds: 3,
  protectedPaths: [],
  lowRiskPaths: [],
};

const classificationCases: ReadonlyArray<{
  readonly name: string;
  readonly input: Partial<RiskInput>;
  readonly tier: RiskTier;
}> = [
  { name: "unknown files", input: { files: null }, tier: "high" },
  { name: "file count mismatch", input: { changedFiles: 2 }, tier: "high" },
  { name: "missing head SHA", input: { headSha: undefined }, tier: "high" },
  { name: "no checks", input: { checks: "none" }, tier: "high" },
  {
    name: "unknown checks override low-risk paths",
    input: { checks: "none", lowRiskPaths: ["src/**"] },
    tier: "high",
  },
  {
    name: "workflow path",
    input: { files: [".github/workflows/factory.yml"] },
    tier: "high",
  },
  { name: "lockfile", input: { files: ["pnpm-lock.yaml"] }, tier: "high" },
  {
    name: "migration path",
    input: { files: ["apps/server/src/persistence/Migrations/110.ts"] },
    tier: "high",
  },
  {
    name: "custom protected path",
    input: { files: ["sensitive/file.ts"], protectedPaths: ["sensitive/**"] },
    tier: "high",
  },
  { name: "fix rounds exhausted", input: { fixRoundsUsed: 3 }, tier: "high" },
  { name: "fix rounds exceeded", input: { fixRoundsUsed: 4 }, tier: "high" },
  {
    name: "zero configured fix rounds are not exhausted",
    input: { fixRounds: 0 },
    tier: "standard",
  },
  {
    name: "all paths opted into low risk",
    input: {
      files: ["docs/a.md", "docs/nested/b.md"],
      changedFiles: 2,
      lowRiskPaths: ["docs/**"],
    },
    tier: "low",
  },
  {
    name: "one path outside the low-risk globs",
    input: {
      files: ["docs/a.md", "src/feature.ts"],
      changedFiles: 2,
      lowRiskPaths: ["docs/**"],
    },
    tier: "standard",
  },
  {
    name: "a fix prevents low risk",
    input: { lowRiskPaths: ["src/**"], fixRoundsUsed: 1 },
    tier: "standard",
  },
  {
    name: "pending checks prevent low risk",
    input: { lowRiskPaths: ["src/**"], checks: "pending" },
    tier: "standard",
  },
  {
    name: "failing checks prevent low risk",
    input: { lowRiskPaths: ["src/**"], checks: "failing" },
    tier: "standard",
  },
  {
    name: "protected paths override low-risk paths",
    input: { files: ["pnpm-lock.yaml"], lowRiskPaths: ["**"] },
    tier: "high",
  },
  { name: "no low-risk opt-in", input: {}, tier: "standard" },
];

it.effect.each(classificationCases)("classifies $name as $tier", ({ input, tier }) =>
  Effect.sync(() => expect(classifyRisk({ ...baseline, ...input }).tier).toBe(tier)),
);

const ratchetCases: ReadonlyArray<{
  readonly previous: RiskTier | null;
  readonly next: RiskTier;
  readonly expected: RiskTier;
}> = [
  { previous: null, next: "low", expected: "low" },
  { previous: "low", next: "low", expected: "low" },
  { previous: "low", next: "standard", expected: "standard" },
  { previous: "low", next: "high", expected: "high" },
  { previous: "standard", next: "low", expected: "standard" },
  { previous: "standard", next: "standard", expected: "standard" },
  { previous: "standard", next: "high", expected: "high" },
  { previous: "high", next: "low", expected: "high" },
  { previous: "high", next: "standard", expected: "high" },
  { previous: "high", next: "high", expected: "high" },
];

it.effect.each(ratchetCases)(
  "ratchets $previous and $next to $expected",
  ({ previous, next, expected }) =>
    Effect.sync(() => expect(ratchetRiskTier(previous, next)).toBe(expected)),
);
