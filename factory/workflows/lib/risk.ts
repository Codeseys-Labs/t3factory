// How much review a pull request gets, from facts the host and the scope agent reported. Pure, with
// no imports and no globals, so a workflow and a plain test can both load it.

export type RiskTier = "low" | "standard" | "high";

export interface RiskInput {
  /** The changed paths an agent reported; null when none were. */
  readonly files: ReadonlyArray<string> | null;
  /** The host's own count of changed files, which `files` has to match. */
  readonly changedFiles: number;
  readonly headSha: string | undefined;
  readonly checks: "passing" | "failing" | "pending" | "none";
  readonly fixRoundsUsed: number;
  readonly fixRounds: number;
  readonly protectedPaths: ReadonlyArray<string>;
  readonly lowRiskPaths: ReadonlyArray<string>;
}

// The paths in factory/seams.json, which the pack cannot read at run time; a test pins the two.
export const FORK_SEAM_PATHS: ReadonlyArray<string> = [
  "packages/contracts/src/index.ts",
  "packages/contracts/src/rpc.ts",
  "packages/contracts/src/clientRpcPermissions.ts",
  "apps/server/src/auth/RpcAuthorization.ts",
  "apps/server/src/ws.ts",
  "apps/server/src/orchestration-v2/runtimeLayer.ts",
  "apps/server/src/observability/RpcInstrumentation.ts",
  "packages/client-runtime/src/rpc/client.ts",
  "apps/web/src/components/sidebar/SidebarChrome.tsx",
  "apps/web/src/components/sidebar/mainAppLocation.ts",
  "apps/web/src/components/CommandPalette.tsx",
];

export const DEFAULT_PROTECTED_PATHS: ReadonlyArray<string> = [
  ".github/workflows/**",
  "package.json",
  "pnpm-lock.yaml",
  "**/migrations/**",
  "**/Migrations/**",
  ".env*",
  "factory/seams.json",
  ...FORK_SEAM_PATHS,
];

const MAX_LISTED = 5;

const normalizePath = (value: string) => value.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");

const REGEXP_SPECIALS = /[.+?^${}()|[\]\\]/g;

const segmentPattern = (segment: string) => {
  const parts = segment.split("*").map((part) => part.replace(REGEXP_SPECIALS, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`);
};

/**
 * Whether `filePath` is one `glob` names, with the seam guard's two forms: `*` is any run of
 * characters inside one path segment, and a `**` segment is any number of segments, none included.
 */
export const matchesRiskGlob = (glob: string, filePath: string): boolean => {
  const globSegments = normalizePath(glob)
    .split("/")
    .map((segment) => (segment === "**" ? null : segmentPattern(segment)));
  const pathSegments = normalizePath(filePath).split("/");
  const matchesFrom = (globIndex: number, pathIndex: number): boolean => {
    if (globIndex === globSegments.length) return pathIndex === pathSegments.length;
    const pattern = globSegments[globIndex];
    if (pattern === null) {
      for (let next = pathIndex; next <= pathSegments.length; next += 1) {
        if (matchesFrom(globIndex + 1, next)) return true;
      }
      return false;
    }
    const segment = pathSegments[pathIndex];
    return (
      pattern !== undefined &&
      segment !== undefined &&
      pattern.test(segment) &&
      matchesFrom(globIndex + 1, pathIndex + 1)
    );
  };
  return matchesFrom(0, 0);
};

const listed = (paths: ReadonlyArray<string>) =>
  paths.length > MAX_LISTED
    ? `${paths.slice(0, MAX_LISTED).join(", ")} and ${paths.length - MAX_LISTED} more`
    : paths.join(", ");

const matchesAny = (globs: ReadonlyArray<string>, filePath: string) =>
  globs.some((glob) => matchesRiskGlob(glob, filePath));

/** Why `files` cannot be trusted as the set of changed paths, or undefined when it can. */
const untrustworthy = (files: ReadonlyArray<string>): string | undefined => {
  const seen = new Set<string>();
  for (const file of files) {
    const segments = file.split("/");
    if (file.includes("\\") || segments.some((s) => s === "" || s === "." || s === "..")) {
      return `a reported path is not a plain relative path: "${file}"`;
    }
    if (seen.has(file)) return `a path was reported twice: "${file}"`;
    seen.add(file);
  }
  return undefined;
};

/**
 * The first rule that fits, with no weights: `high` for anything unknown, unchecked or protected,
 * `low` only where a project listed its low-risk paths, `standard` otherwise. `reasons` say why.
 */
export const classifyRisk = (
  input: RiskInput,
): { readonly tier: RiskTier; readonly reasons: ReadonlyArray<string> } => {
  const { files, changedFiles, headSha, checks, fixRoundsUsed, fixRounds, lowRiskPaths } = input;
  const protectedGlobs = [...DEFAULT_PROTECTED_PATHS, ...input.protectedPaths];

  const high: Array<string> = [];
  if (files === null) {
    high.push("changed files were not reported");
  } else {
    const untrusted = untrustworthy(files);
    if (untrusted !== undefined) return { tier: "high", reasons: [untrusted] };
    if (files.length !== changedFiles) {
      high.push(`${files.length} changed files reported, but the host counts ${changedFiles}`);
    }
    const touched = files.filter((file) => matchesAny(protectedGlobs, file));
    if (touched.length > 0) high.push(`protected paths changed: ${listed(touched)}`);
  }
  if (headSha === undefined) high.push("the host did not report the head commit");
  if (checks === "none") high.push("no checks ran");
  if (fixRounds > 0 && fixRoundsUsed >= fixRounds) {
    high.push(`${fixRoundsUsed} of ${fixRounds} fix rounds used`);
  }
  if (files === null || high.length > 0) return { tier: "high", reasons: high };

  const standard: Array<string> = [];
  if (lowRiskPaths.length === 0) standard.push("no low-risk paths are configured");
  if (files.length === 0) standard.push("no changed files");
  const outside = files.filter((file) => !matchesAny(lowRiskPaths, file));
  if (lowRiskPaths.length > 0 && outside.length > 0) {
    standard.push(`changed outside the low-risk paths: ${listed(outside)}`);
  }
  if (checks !== "passing") standard.push(`checks are ${checks}`);
  if (fixRoundsUsed > 0) standard.push(`${fixRoundsUsed} fix rounds used`);
  if (standard.length > 0) return { tier: "standard", reasons: standard };

  return {
    tier: "low",
    reasons: ["every changed file is under the low-risk paths", "checks pass", "no fix round used"],
  };
};

const RANK: Readonly<Record<RiskTier, number>> = { low: 0, standard: 1, high: 2 };

/** `next`, unless `previous` is higher: a part's tier only goes up. */
export const ratchetRiskTier = (previous: RiskTier | null, next: RiskTier): RiskTier =>
  previous !== null && RANK[previous] > RANK[next] ? previous : next;
