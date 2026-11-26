// @effect-diagnostics nodeBuiltinImport:off - a workflow file runs in the loader, which provides no platform services.
import * as NodeCrypto from "node:crypto";
import { isStored, now } from "./records.ts";

export const LENSES = ["brief", "defects"] as const;
const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
const BLOCKING_SEVERITIES: ReadonlyArray<(typeof SEVERITIES)[number]> = ["blocker", "major"];
const FINDINGS_PER_LENS_MAX = 20;
const PATH_MAX = 500;
const CLAIM_MAX = 500;
const EVIDENCE_MAX = 2_000;
const TRIED_MAX = 1_000;

const ReportedFinding = Schema.Struct({
  severity: Schema.Literals(SEVERITIES),
  category: Schema.Literals(["correctness", "scope", "test", "security", "other"]),
  path: Schema.String,
  line: Schema.NullOr(Schema.Int),
  claim: Schema.String,
  evidence: Schema.String,
});

export const ReviewReport = Schema.Struct({
  reviewedHead: Schema.NullOr(Schema.String),
  findings: Schema.Array(ReportedFinding).check(Schema.isMaxLength(FINDINGS_PER_LENS_MAX)),
});

const DisproofResult = Schema.Struct({
  id: Schema.String,
  outcome: Schema.Literals(["survived", "refuted"]),
  tried: Schema.String,
});
export const DisproofReport = Schema.Struct({ results: Schema.Array(DisproofResult) });

const Lens = Schema.Literals(LENSES);
const FactoryReviewFinding = Schema.Struct({
  ...ReportedFinding.fields,
  id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/)),
  lens: Lens,
  path: Schema.String.check(Schema.isMaxLength(PATH_MAX)),
  claim: Schema.String.check(Schema.isMaxLength(CLAIM_MAX)),
  evidence: Schema.String.check(Schema.isMaxLength(EVIDENCE_MAX)),
  status: Schema.Literals(["open", "refuted"]),
  disproof: Schema.Struct({
    outcome: Schema.Literals(["survived", "refuted", "not-run"]),
    tried: Schema.String.check(Schema.isMaxLength(TRIED_MAX)),
  }),
});
type Finding = typeof FactoryReviewFinding.Type;
const FactoryReviewRound = Schema.Struct({
  v: Schema.Literal(1),
  taskId: Schema.String,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  part: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  at: Schema.String.check(Schema.isMaxLength(40)),
  runId: Schema.String,
  head: Schema.NullOr(Schema.String),
  lenses: Schema.Array(Lens),
  verdict: Schema.Literals(["approve", "changes", "stale"]),
  findings: Schema.Array(FactoryReviewFinding).check(Schema.isMaxLength(40)),
  createdAt: Schema.String,
});

export const boundFinding = (reported: typeof ReportedFinding.Type) => ({
  ...reported,
  path: reported.path.trim().slice(0, PATH_MAX),
  claim: reported.claim.trim().slice(0, CLAIM_MAX),
  evidence: reported.evidence.trim().slice(0, EVIDENCE_MAX),
});

export const findingId = (path: string, category: string, claim: string): string => {
  const normPath = path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "");
  const normClaim = claim.trim().toLowerCase().replace(/\s+/g, " ");
  return NodeCrypto.createHash("sha256")
    .update(`${normPath}\n${category}\n${normClaim}`)
    .digest("hex")
    .slice(0, 16);
};

export const collectFindings = (
  reports: ReadonlyArray<{
    readonly lens: typeof Lens.Type;
    readonly report: typeof ReviewReport.Type;
  }>,
) => {
  const seen = new Set<string>();
  const findings: Array<Finding> = [];
  for (const { lens, report } of reports) {
    for (const reported of report.findings) {
      const finding = boundFinding(reported);
      const id = findingId(finding.path, finding.category, finding.claim);
      if (seen.has(id)) continue;
      seen.add(id);
      findings.push({
        ...finding,
        id,
        lens,
        status: "open",
        disproof: { outcome: "not-run", tried: "" },
      });
    }
  }
  return findings;
};

export const blockingSeverity = ({ severity }: Pick<Finding, "severity">) =>
  BLOCKING_SEVERITIES.includes(severity);

export const applyDisproof = (
  findings: ReadonlyArray<Finding>,
  results: (typeof DisproofReport.Type)["results"],
) => {
  const first = new Map<string, typeof DisproofResult.Type>();
  for (const result of results) {
    if (!first.has(result.id)) first.set(result.id, result);
  }
  return findings.map((finding): Finding => {
    const result = first.get(finding.id);
    if (!blockingSeverity(finding) || result === undefined) return finding;
    return {
      ...finding,
      status: result.outcome === "refuted" ? "refuted" : "open",
      disproof: { outcome: result.outcome, tried: result.tried.slice(0, TRIED_MAX) },
    };
  });
};

export const deriveVerdict = (findings: ReadonlyArray<Pick<Finding, "severity" | "status">>) =>
  findings.some((f) => f.status === "open" && blockingSeverity(f)) ? "changes" : "approve";

const orderedOpen = (findings: ReadonlyArray<Finding>) =>
  findings
    .filter((f) => f.status === "open")
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));

export const renderFindings = (findings: ReadonlyArray<Finding>): string =>
  orderedOpen(findings)
    .map((f) => {
      const location = f.path === "" ? "" : `${f.path}${f.line === null ? "" : `:${f.line}`}: `;
      return `- [${f.severity}] ${location}${f.claim}${f.evidence === "" ? "" : `\n  Evidence: ${f.evidence}`}`;
    })
    .join("\n");

export const questionEvidence = (findings: ReadonlyArray<Finding> | null) => ({
  lastReviewNotes: findings === null ? null : renderFindings(findings),
  findings: orderedOpen(findings ?? [])
    .slice(0, 20)
    .map(({ id, severity, category, path, line, claim }) => ({
      id,
      severity,
      category,
      path,
      line,
      claim,
    })),
  refuted: findings?.filter((f) => f.status === "refuted").length ?? 0,
});

export const writeReviewRound = Effect.fn("factoryPack.writeReviewRound")(function* (
  round: Omit<typeof FactoryReviewRound.Type, "v" | "createdAt">,
) {
  const key = `factory/v1/ledger/${round.taskId}/a${round.attempt}/p${round.part}/${round.at}`;
  yield* T3.store.transaction(
    Effect.gen(function* () {
      if (yield* isStored(key)) return;
      yield* T3.store.entry(key, FactoryReviewRound).set({ ...round, v: 1, createdAt: yield* now });
    }),
  );
});
