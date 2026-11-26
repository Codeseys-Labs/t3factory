import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { RelativeLabel } from "../components/workflows/WorkflowRunFeed";
import type { FindingView, PartReviewView, ReviewRoundView } from "./workDetail.logic";

const VERDICT_LABELS: Record<ReviewRoundView["verdict"], string> = {
  approve: msg("Approved", { $context: "a review round found nothing that blocks the merge" }),
  changes: msg("Changes asked", {
    $context: "a review round found something that blocks the merge",
  }),
  stale: msg("Head moved", {
    $context: "a review round read a pull request head that then changed",
  }),
};

const VERDICT_VARIANTS = {
  approve: "success",
  changes: "error",
  stale: "warning",
} as const satisfies Record<ReviewRoundView["verdict"], string>;

const SEVERITY_LABELS: Record<FindingView["severity"], string> = {
  blocker: msg("Blocker", { $context: "severity of a review finding: stops the merge" }),
  major: msg("Major", { $context: "severity of a review finding: stops the merge" }),
  minor: msg("Minor", { $context: "severity of a review finding: does not stop the merge" }),
  nit: msg("Nit", { $context: "severity of a review finding: a small style remark" }),
};

const SEVERITY_VARIANTS = {
  blocker: "error",
  major: "warning",
  minor: "secondary",
  nit: "outline",
} as const satisfies Record<FindingView["severity"], string>;

const STATUS_LABELS: Record<FindingView["status"], string> = {
  open: msg("Open", { $context: "a review finding still stands" }),
  refuted: msg("Refuted", { $context: "a review finding was shown to be false" }),
};

const DISPROOF_LABELS: Record<FindingView["disproof"]["outcome"], string> = {
  survived: msg("Survived the disprove step", {
    $context: "an agent tried to show a review finding false and could not",
  }),
  refuted: msg("Refuted by the disprove step", {
    $context: "an agent showed a review finding to be false",
  }),
  "not-run": msg("The disprove step did not run", {
    $context: "no agent tried to show this blocking review finding false",
  }),
};

/** An attempt's review rounds by part: each part's latest verdict, then its rounds on request. */
export function AttemptReviews({ parts }: { readonly parts: ReadonlyArray<PartReviewView> }) {
  return (
    <div className="ms-6 flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-xs">
      <h3 className="font-medium text-foreground">
        <T context="what the reviews of an attempt's pull requests found">Review findings</T>
      </h3>
      <ul className="flex flex-col gap-2">
        {parts.map((part) => (
          <PartReview key={part.part} part={part} />
        ))}
      </ul>
    </div>
  );
}

function PartReview({ part }: { readonly part: PartReviewView }) {
  const gt = useGT();
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const verdict = part.latestVerdict ?? "stale";
  const n = part.part + 1;
  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span className="font-medium text-foreground">
          {gt("Part {n}", { n, $context: "one of the parts a task's plan split it into" })}
        </span>
        <Badge size="sm" variant={VERDICT_VARIANTS[verdict]}>
          {m(VERDICT_LABELS[verdict])}
        </Badge>
        <span className="tabular-nums">
          {gt("{count, plural, one {{count} blocking finding} other {{count} blocking findings}}", {
            count: part.blocking,
          })}
        </span>
        <span className="tabular-nums">
          {gt("{count, plural, one {{count} refuted} other {{count} refuted}}", {
            count: part.refuted,
            $context: "how many review findings were shown to be false",
          })}
        </span>
        <span className="min-w-0 flex-1" />
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open}
          aria-label={
            open ? gt("Hide findings for part {n}", { n }) : gt("Show findings for part {n}", { n })
          }
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <T context="verb, hides a part's review rounds and findings">Hide findings</T>
          ) : (
            <T context="verb, shows a part's review rounds and findings">Show findings</T>
          )}
        </Button>
      </span>
      {open ? (
        <ol className="flex flex-col gap-2 border-s ps-3">
          {part.rounds.map((round) => (
            <ReviewRound key={round.at} round={round} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function ReviewRound({ round }: { readonly round: ReviewRoundView }) {
  const gt = useGT();
  const m = useMessages();
  const head = round.head?.slice(0, 7) ?? null;
  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span className="font-medium text-foreground">
          {gt("Round {at}", {
            at: round.at,
            $context: "a review round, named by its address such as 0, x1 or 0/again",
          })}
        </span>
        <Badge size="sm" variant={VERDICT_VARIANTS[round.verdict]}>
          {m(VERDICT_LABELS[round.verdict])}
        </Badge>
        <RelativeLabel value={round.createdAt} />
        {head === null || round.verdict === "stale" ? null : (
          <span className="font-mono">{head}</span>
        )}
      </span>
      {round.verdict !== "stale" ? null : (
        <p className="text-muted-foreground">
          {head === null
            ? gt("Reviewed at a head that then moved. Its findings decide nothing.")
            : gt("Reviewed at {head}, a head that then moved. Its findings decide nothing.", {
                head,
              })}
        </p>
      )}
      {round.findings.length === 0 ? (
        <p className="text-muted-foreground">
          <T context="a review round raised nothing">No findings.</T>
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {round.findings.map((finding) => (
            <ReviewFinding key={finding.id} finding={finding} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ReviewFinding({ finding }: { readonly finding: FindingView }) {
  const m = useMessages();
  const place =
    finding.path === ""
      ? null
      : finding.line === null
        ? finding.path
        : `${finding.path}:${finding.line}`;
  // Only a blocking finding goes to the disprove step, so "did not run" says something only there.
  const disproof =
    finding.disproof.outcome !== "not-run" || finding.blocking ? finding.disproof : null;
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground">
        <Badge size="sm" variant={SEVERITY_VARIANTS[finding.severity]}>
          {m(SEVERITY_LABELS[finding.severity])}
        </Badge>
        <Badge size="sm" variant={finding.status === "open" ? "outline" : "secondary"}>
          {m(STATUS_LABELS[finding.status])}
        </Badge>
        {place === null ? null : <span className="min-w-0 font-mono wrap-anywhere">{place}</span>}
        {finding.raisedAgain === null ? null : finding.raisedAgain ? (
          <T context="a later review round raised this finding again">Raised again</T>
        ) : (
          <T context="no later review round raised this finding; that does not mean it was fixed">
            Not raised again
          </T>
        )}
      </span>
      <p className="text-sm whitespace-pre-wrap wrap-anywhere text-foreground">{finding.claim}</p>
      {finding.evidence === "" ? null : (
        <p className="flex min-w-0 flex-col gap-0.5">
          <span className="text-muted-foreground">
            <T context="label: the quoted line or output a review finding rests on">Evidence</T>
          </span>
          <span className="font-mono whitespace-pre-wrap wrap-anywhere">{finding.evidence}</span>
        </p>
      )}
      {disproof === null ? null : (
        <p className="flex min-w-0 flex-col gap-0.5">
          <span className="text-muted-foreground">{m(DISPROOF_LABELS[disproof.outcome])}</span>
          {disproof.tried === "" ? null : (
            <span className="whitespace-pre-wrap wrap-anywhere">
              <span className="text-muted-foreground">
                <T context="label: what the disprove step did to try to show a finding false">
                  Tried:
                </T>
              </span>{" "}
              {disproof.tried}
            </span>
          )}
        </p>
      )}
    </li>
  );
}
