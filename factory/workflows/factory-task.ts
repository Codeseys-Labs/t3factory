// A Factory task as durable work: plan it, do its parts side by side, then review and merge each
// part's pull request. Also the ways in for agents and the CLI: capturing a task, starting one.
import {
  FACTORY_TASK,
  FACTORY_TASK_VERSION,
  FactoryTaskRunInput,
  ModelChoice,
  PackConfig,
  RunTarget,
  StartOutcome,
  TaskLane,
  capturedKey,
  createTask,
  hashFile,
  listAttempts,
  mergeApproved,
  mergePullRequest,
  projectPullRequest,
  pullRequestHead,
  readConfig,
  recordAttemptPullRequest,
  resolvePlacement,
  resolveTarget,
  rootPool,
  startPool,
  startTask,
  taskTags,
  writeArtifact,
  writeReceipt,
} from "./lib/records.ts";
import {
  LENSES,
  ReviewReport,
  DisproofReport,
  collectFindings,
  blockingSeverity,
  applyDisproof,
  deriveVerdict,
  questionEvidence,
  writeReviewRound,
} from "./lib/ledger.ts";
import { PartStats, Outcome, finishAttempt } from "./lib/metrics.ts";
import { isFullSha, remoteLine, remoteScopeLine } from "./lib/placement.ts";
import { classifyRisk, ratchetRiskTier, type RiskTier } from "./lib/risk.ts";

const { workflow, step, agent, ask, invoke, stop, title, tags, within, pullRequests } = T3;

// Upstream's wording (workflowAgent.ts) for a turn stopped at its time limit, and for a stop that
// may not have held.
const TIMED_OUT = "was not done after";
const NOT_STOPPED = "could not be stopped";
const STILL_AT_WORK = "may still be at work";
const STALE_RETRIES = 1;
const HEAD_KEPT_CHANGING = "The pull request's head kept changing while it was reviewed.";

const Plan = Schema.Struct({
  summary: Schema.String,
  parts: Schema.Array(Schema.Struct({ title: Schema.String, brief: Schema.String })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(6),
  ),
});

const PullRequestUrls = Schema.Array(Schema.String);

const PartPayload = Schema.Struct({
  taskId: Schema.String,
  number: Schema.Number,
  attempt: Schema.optionalKey(Schema.Int),
  part: Schema.Number,
  title: Schema.String,
  brief: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  target: Schema.optionalKey(RunTarget),
  issueUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  priorPrUrls: Schema.optional(PullRequestUrls),
  model: Schema.NullOr(ModelChoice),
  config: PackConfig,
});

const PartResult = Schema.Struct({
  outcome: Schema.Literals(["accepted", "merged"]),
  prUrl: Schema.NullOr(Schema.String),
  stats: PartStats,
});

const TaskResult = Schema.Struct({ parts: Outcome.fields.parts });

const Done = Schema.Struct({
  summary: Schema.String,
  prUrl: Schema.NullOr(Schema.String),
  artifacts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, label: Schema.String })).check(
      Schema.isMaxLength(10),
    ),
  ),
});

const Hashed = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    label: Schema.String,
    sha256: Schema.String,
    bytes: Schema.Number,
  }),
);

const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

const CapturePayload = Schema.Struct({
  title: Schema.String,
  description: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  blockedBy: Schema.optional(Schema.Array(Schema.String)),
  lane: Schema.optional(TaskLane),
  assignee: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(ModelChoice)),
  issue: Schema.optional(Schema.Struct({ url: Schema.String, displayKey: Schema.String })),
  start: Schema.optional(Schema.Boolean),
  kind: Schema.optionalKey(Schema.String),
});

const Problem = Schema.Struct({ problem: Schema.String });

const Captured = Schema.Union([
  Problem,
  Schema.Struct({ taskId: Schema.String, number: Schema.Number }),
]);

const Started = Schema.Struct({
  taskId: Schema.String,
  attempt: Schema.Number,
  runId: Schema.String,
});

const HeadSha = Schema.NullOr(Schema.String);

const ScopeReport = Schema.Struct({ headSha: Schema.String, files: Schema.Array(Schema.String) });

const PullRequestRiskSnapshot = Schema.Struct({
  headSha: Schema.NullOr(Schema.String),
  changedFiles: Schema.Number,
  checks: Schema.Literals(["passing", "failing", "pending", "none"]),
});

const IssueLink = Schema.Literals(["linked", "commented"]);

const ISSUE_NUMBER = /\/issues\/(\d+)$/;

const mentionsIssue = (body: string, issueUrl: string) => {
  if (body.toLowerCase().includes(issueUrl.toLowerCase())) return true;
  const number = ISSUE_NUMBER.exec(issueUrl)?.[1];
  return number !== undefined && new RegExp(`#${number}\\b`).test(body);
};

const factoryTaskPart = workflow(
  "factory-task-part",
  {
    version: FACTORY_TASK_VERSION,
    payload: PartPayload,
    returns: PartResult,
    asks: { accept: "Accept the result?", stuck: "Review did not pass", merge: "Merge?" },
  },
  Effect.fn(function* (input, run) {
    const { config } = input;
    const label = `T-${input.number} part ${input.part + 1}`;
    const pool = `factory-task:${input.taskId}`;
    const slot = { limit: config.concurrency };
    yield* tags(taskTags(input.taskId, input.projectId, "doing"));
    const target = input.target ?? (yield* resolveTarget(input.projectId));
    const placement = yield* resolvePlacement(input.projectId, config.readOnlyOn);
    if ("problem" in target) return yield* stop(target.problem);
    const project = target.projectId;
    const rooted = target.workspace === "root";
    const where = target.workspace === "worktree" ? "this worktree" : "this folder";
    // A folder agents work in directly is shared by every task on its project. The task's place
    // is always taken before the folder's, so no two runs each hold what the other waits for.
    const held = <A, E, R>(body: Parameters<typeof within<A, E, R>>[2]) =>
      within(pool, slot, rooted ? within(rootPool(project), { limit: 1 }, body) : body);
    const issueUrl = input.issueUrl ?? null;
    const attempt = input.attempt ?? 1;
    const workerModel = config.workerModel ?? input.model;
    const taskProject = input.projectId === null ? "null" : `"${input.projectId}"`;
    const followUps = `If you discover an out-of-scope bug or follow-up while working, do not widen this pull request: capture it as a new task with \`t3 workflow start factory-capture --input '{"title":"…","projectId":${taskProject},"lane":"ready","blockedBy":["${input.taskId}"]}' --key capture/<slug>\`.`;
    const priorPrUrls = input.priorPrUrls ?? [];
    const priorPrs =
      priorPrUrls.length === 0
        ? []
        : [
            `An earlier attempt at this task left ${priorPrUrls.length === 1 ? "this pull request" : "these pull requests"} open: ${priorPrUrls.join(", ")}`,
            "If one of them is for this part, check out its branch, make the change there, and push to that branch so that pull request is updated; return its URL as `prUrl`. Do not open a second pull request for the same change.",
          ];
    const returnRules = [
      "If the project is a Git repository with a remote, commit, push a branch, open a pull request and return its URL as `prUrl`. Otherwise return `prUrl: null`.",
      "If there is no pull request and you left files a person should look at, return them as `artifacts`: at most 10, each with its absolute `path` and a short `label`.",
      ...(config.baseRef === null
        ? []
        : [
            `Open the pull request against the branch \`${config.baseRef.replace(/^(?:origin\/|refs\/heads\/)/, "")}\`.`,
          ]),
      ...(issueUrl === null
        ? []
        : [
            `Include a reference to \`${issueUrl}\` in the pull request description (for example \`Closes #N\` or \`Refs <url>\`).`,
          ]),
      "Return a short `summary` of what you changed.",
    ];
    const workspace = rooted
      ? ({ type: "root" } as const)
      : ({ type: "worktree", baseRef: config.baseRef ?? "HEAD" } as const);
    const doOptions = {
      project,
      title: `${label}: ${input.title}`,
      brief: [
        `Do part ${input.part + 1} of task T-${input.number}: ${input.title}`,
        "",
        input.brief,
        "",
        `Make the change in ${where} and check that it works.`,
        followUps,
        ...priorPrs,
        ...returnRules,
      ].join("\n"),
      workspace,
      runtimeMode: "full-access",
      ...(workerModel === null ? {} : { model: workerModel }),
      timeout: config.stepTimeout,
      returns: Done,
    } as const;
    const tried = yield* held(agent.try("do", doOptions));
    if (
      tried.outcome === "failed" &&
      tried.thread !== undefined &&
      !(
        tried.reason.includes(TIMED_OUT) &&
        !tried.reason.includes(NOT_STOPPED) &&
        !tried.reason.includes(STILL_AT_WORK)
      )
    ) {
      return yield* stop(`worker stopped: ${tried.reason}`);
    }
    // A turn cut off cleanly at its time limit leaves its work where it was: carry on there.
    const done =
      tried.outcome === "done"
        ? tried
        : yield* held(
            tried.thread === undefined
              ? agent("do/again", doOptions)
              : agent("do/continue", {
                  thread: tried.thread,
                  brief: [
                    `Your last turn on part ${input.part + 1} of task T-${input.number} was stopped before it returned a result: ${tried.reason}`,
                    "",
                    target.workspace === "worktree"
                      ? "Do not start over. Run `git status` and `git log` in this worktree to see what is already done, then carry on from there: finish the part and check that it works."
                      : "Do not start over. Look through this folder to see what is already done, then carry on from there: finish the part and check that it works.",
                    followUps,
                    ...returnRules,
                  ].join("\n"),
                  timeout: config.stepTimeout,
                  returns: Done,
                }),
          );
    const { summary, prUrl: reported } = done.value;
    const stats = {
      tier: null,
      fixRounds: 0,
      noOpFixRounds: 0,
      continued: tried.outcome !== "done",
      asks: 0,
      rulings: 0,
      mergedAnyway: false,
      reviewRounds: 0,
      findingsRaised: 0,
      findingsRefuted: 0,
    };
    if (reported === null) {
      let artifacts: typeof Hashed.Type = [];
      const listed = done.value.artifacts ?? [];
      if (listed.length > 0) {
        const hashed = yield* step.try(
          "artifacts",
          { returns: Hashed },
          Effect.forEach(listed, (file) =>
            Effect.gen(function* () {
              const { sha256, bytes } = yield* hashFile(file.path, ARTIFACT_MAX_BYTES);
              yield* writeArtifact({
                taskId: input.taskId,
                attempt,
                sha256,
                kind: "file",
                location: { _tag: "file", path: file.path },
                bytes,
                label: file.label,
                step: "artifacts",
                runId: run.id,
              });
              return { path: file.path, label: file.label, sha256, bytes };
            }),
          ),
        );
        if (hashed.outcome === "failed") {
          return yield* stop(`artifacts could not be recorded: ${hashed.reason}`);
        }
        artifacts = hashed.value;
      }
      stats.asks++;
      const accepted = yield* ask("accept", {
        title: `Accept ${label}: ${input.title}?`,
        kind: "accept",
        choices: ["Accept", "Redo"],
        data: artifacts.length === 0 ? { summary } : { summary, artifacts },
      });
      if (Option.isNone(accepted) || accepted.value.choice !== "Accept") {
        return yield* stop("not accepted");
      }
      if (artifacts.length > 0) {
        const by = accepted.value.answeredBySession === undefined ? "agent" : "person";
        const unchanged = yield* step(
          "accepted",
          { returns: Schema.Boolean },
          Effect.gen(function* () {
            const changed = (yield* Effect.forEach(artifacts, (file) =>
              Effect.map(Effect.option(hashFile(file.path, ARTIFACT_MAX_BYTES)), (again) =>
                Option.isSome(again) && again.value.sha256 === file.sha256 ? [] : [file],
              ),
            )).flat();
            if (changed.length > 0) {
              yield* Effect.forEach(
                changed,
                (file) =>
                  writeReceipt({
                    taskId: input.taskId,
                    attempt,
                    sha256: file.sha256,
                    kind: "rejected",
                    by: "pack",
                    runId: run.id,
                    detail: { reason: "changed after review" },
                  }),
                { discard: true },
              );
              return false;
            }
            yield* Effect.forEach(
              artifacts,
              (file) =>
                writeReceipt({
                  taskId: input.taskId,
                  attempt,
                  sha256: file.sha256,
                  kind: "accepted",
                  by,
                  runId: run.id,
                }),
              { discard: true },
            );
            return true;
          }),
        );
        if (!unchanged) return yield* stop("artifact changed after review");
      }
      return { outcome: "accepted", prUrl: null, stats } as const;
    }

    const prUrl = yield* projectPullRequest(project, reported);
    if (prUrl === null) return yield* stop("pull request is not this project's");
    yield* step(
      "pr-record",
      { returns: Schema.Void },
      recordAttemptPullRequest(input.taskId, attempt, prUrl),
    );

    const pr = { project, url: prUrl };
    if (issueUrl !== null) {
      yield* step(
        "issue-link",
        { returns: IssueLink },
        Effect.gen(function* () {
          const detail = yield* pullRequests.read(pr);
          if (mentionsIssue(detail.body, issueUrl)) return "linked" as const;
          yield* pullRequests.comment(pr, `Refs ${issueUrl}`);
          return "commented" as const;
        }),
      );
    }
    const links = [{ label: "Pull request", url: prUrl }];
    const reviewModel = config.reviewModel ?? input.model;
    const rulings: Array<string> = [];
    let latest = questionEvidence(null);
    // The tier a part's changes earn only goes up: a later round can raise it, never lower it.
    const risk: { tier: RiskTier | undefined; headSha: string | null; reasons: Array<string> } = {
      tier: undefined,
      headSha: null,
      reasons: [],
    };
    const merged = (tier = risk.tier ?? null) =>
      ({ outcome: "merged", prUrl, stats: { ...stats, tier } }) as const;
    const noteRisk = (reasons: ReadonlyArray<string>) => {
      for (const reason of reasons) {
        if (!risk.reasons.includes(reason)) risk.reasons.push(reason);
      }
    };
    // Checks, then a review once they pass: `approved`, `merged`, or what still stands in the way.
    const reviewOnce = Effect.fnUntraced(function* (at: string) {
      const standing = yield* pullRequests.wait(`checks/${at}`, pr, {
        until: "checks",
        timeout: config.checksTimeout,
      });
      if (Option.isSome(standing) && standing.value.state === "merged") return "merged" as const;
      if (Option.isSome(standing) && standing.value.state === "closed") {
        return yield* stop("pull request closed");
      }
      if (Option.isNone(standing)) {
        return {
          problem: `Its checks were still running after ${config.checksTimeout}.`,
          notes: null,
        };
      }
      if (standing.value.checks !== "passing" && standing.value.checks !== "none") {
        return {
          problem: "Its checks are failing: read them on the pull request to find out why.",
          notes: null,
        };
      }
      const { checks } = standing.value;
      const snapshot = yield* step(
        `risk-pr/${at}`,
        { returns: PullRequestRiskSnapshot },
        Effect.map(pullRequests.read(pr), (detail) => ({
          headSha: detail.headSha ?? null,
          changedFiles: detail.changedFiles,
          checks,
        })),
      );
      const head = snapshot.headSha;
      const remote =
        placement.where === "remote" && head !== null && isFullSha(head) && reviewModel !== null;
      const readOptions = remote
        ? ({
            environment: placement.environment,
            project: placement.project,
            model: reviewModel,
            workspace: { type: "worktree", baseRef: head, startFromOrigin: false },
            runtimeMode: "approval-required",
            interactionMode: "plan",
          } as const)
        : { project, ...(reviewModel === null ? {} : { model: reviewModel }) };
      const readLines = remote ? [remoteLine(head)] : [];
      const holdRead = <A, E, R>(body: Parameters<typeof within<A, E, R>>[2]) =>
        remote
          ? within(pool, slot, within(placement.pool, { limit: placement.limit }, body))
          : held(body);
      let staleScope = false;
      if (
        risk.tier === undefined ||
        (snapshot.headSha !== null && snapshot.headSha !== risk.headSha)
      ) {
        const scoped = yield* holdRead(
          agent.try(`scope/${at}`, {
            ...readOptions,
            title: `${label} scope: ${input.title}`,
            brief: [
              `List the files pull request ${prUrl} changes.`,
              "",
              "Change nothing: no edits, commits or pushes.",
              ...readLines,
              remote
                ? remoteScopeLine(config.baseRef)
                : `Fetch the pull request's head commit${snapshot.headSha === null ? "" : ` \`${snapshot.headSha}\``} and run \`git diff --name-only <base>...<head>\`, where <head> is that commit and <base> is the branch the pull request targets.`,
              "Return `headSha`: the full SHA of the commit you listed, and `files`: every path the command printed, exactly as printed.",
            ].join("\n"),
            timeout: config.stepTimeout,
            returns: ScopeReport,
          }),
        );
        if (scoped.outcome !== "done") {
          noteRisk([`the changed files could not be listed: ${scoped.reason}`]);
        } else if (snapshot.headSha !== null && scoped.value.headSha !== snapshot.headSha) {
          staleScope = remote;
          noteRisk([
            `the changed files were listed at ${scoped.value.headSha}, not at the head ${snapshot.headSha}`,
          ]);
        }
        const classified = classifyRisk({
          files:
            scoped.outcome === "done" &&
            snapshot.headSha !== null &&
            scoped.value.headSha === snapshot.headSha
              ? scoped.value.files
              : null,
          changedFiles: snapshot.changedFiles,
          headSha: snapshot.headSha ?? undefined,
          checks: snapshot.checks,
          fixRoundsUsed: stats.fixRounds,
          fixRounds: config.fixRounds,
          protectedPaths: config.protectedPaths,
          lowRiskPaths: config.lowRiskPaths,
        });
        risk.tier = ratchetRiskTier(risk.tier ?? null, classified.tier);
        noteRisk(classified.reasons);
        risk.headSha = snapshot.headSha;
      }
      const commit = head === null ? [] : [`Review commit \`${head}\`.`];
      const rulingLines =
        rulings.length === 0
          ? []
          : [
              "",
              "A person has ruled on this pull request. Follow these rulings, and do not ask again for what they overrule:",
              ...rulings.map((ruling) => `- ${ruling}`),
            ];
      const reportInstructions =
        "Return `reviewedHead` (the full SHA you read, or null if unknown) and `findings` (severity, category, repository-relative path or empty string, line or null, claim, and quoted evidence). An empty findings list means it can be merged as it is. Blocker and major findings block the merge; minor and nit do not.";
      const lenses = risk.tier === "high" ? LENSES : ([LENSES[0]] as const);
      const reports = yield* Effect.forEach(
        lenses,
        (lens) => {
          const brief =
            lens === "brief"
              ? [
                  `Review pull request ${prUrl}. It does part ${input.part + 1} of task T-${input.number}: ${input.title}`,
                  ...commit,
                  ...readLines,
                  "",
                  "Its brief:",
                  "",
                  input.brief,
                  "",
                  "Change nothing. Read its diff and check that it does what the brief asks, works, and changes nothing else.",
                  "Actively try to disprove the change: name one concrete input, edge case, or counterfactual state that could break it, verify whether the diff handles it, and cite exact file paths and line numbers for every finding.",
                  ...(issueUrl === null
                    ? []
                    : [
                        `It is for issue ${issueUrl}: check that the pull request description, or a comment on it, references that issue.`,
                      ]),
                  ...rulingLines,
                  reportInstructions,
                ]
              : [
                  `Review pull request ${prUrl}.`,
                  ...commit,
                  ...readLines,
                  "What input or state breaks the changed lines? Quote the line. Change nothing.",
                  ...rulingLines,
                  reportInstructions,
                ];
          return Effect.map(
            holdRead(
              agent(lens === "brief" ? `review/${at}` : `review/${at}/defects`, {
                ...readOptions,
                title: `${label} ${lens === "brief" ? "review" : "defects"}: ${input.title}`,
                brief: brief.join("\n"),
                timeout: config.stepTimeout,
                returns: ReviewReport,
              }),
            ),
            ({ value: report }) => ({ lens, report }),
          );
        },
        { concurrency: "unbounded" },
      );
      let findings = collectFindings(reports);
      const blocking = findings.filter(blockingSeverity);
      if (blocking.length > 0) {
        const model = config.planModel ?? input.model;
        const disproof = yield* held(
          agent.try(`disprove/${at}`, {
            project,
            title: `${label} disprove: ${input.title}`,
            brief: [
              `Try to refute each finding on pull request ${prUrl} by reproducing it or by a counter-example.`,
              ...commit,
              "Change nothing. Answer refuted only when you have shown the claim false; otherwise answer survived. For each id, say what you tried.",
              JSON.stringify(
                blocking.map(({ id, path, line, claim, evidence }) => ({
                  id,
                  path,
                  line,
                  claim,
                  evidence,
                })),
              ),
            ].join("\n"),
            ...(model === null ? {} : { model }),
            timeout: config.stepTimeout,
            returns: DisproofReport,
          }),
        );
        if (disproof.outcome === "done") findings = applyDisproof(findings, disproof.value.results);
      }
      const after = yield* step(
        `head/${at}`,
        { returns: HeadSha },
        Effect.map(pullRequests.read(pr), (detail) => detail.headSha ?? null),
      );
      const stale =
        head !== null &&
        (staleScope ||
          (after !== null && after !== head) ||
          reports.some(
            ({ report }) =>
              (remote || report.reviewedHead !== null) && report.reviewedHead !== head,
          ));
      const verdict = stale ? "stale" : deriveVerdict(findings);
      yield* step(
        `ledger/${at}`,
        { returns: Schema.Void },
        writeReviewRound({
          taskId: input.taskId,
          attempt,
          part: input.part,
          at,
          runId: run.id,
          head,
          lenses,
          verdict,
          findings,
        }),
      );
      if (verdict === "stale") return "stale" as const;
      latest = questionEvidence(findings);
      stats.reviewRounds++;
      stats.findingsRaised += blocking.length;
      stats.findingsRefuted += latest.refuted;
      if (verdict === "approve") return "approved" as const;
      return {
        problem: `A review asked for changes:\n\n${latest.lastReviewNotes}`,
        notes: latest.lastReviewNotes,
      };
    });
    const round = Effect.fnUntraced(function* (at: string) {
      for (let retry = 0; retry <= STALE_RETRIES; retry++) {
        const result = yield* reviewOnce(retry === 0 ? at : `${at}/again`);
        if (result !== "stale") return result;
      }
      return { problem: HEAD_KEPT_CHANGING, notes: null };
    });
    // A fix that leaves the head where it was is not checked or reviewed again: its problem stands.
    const fix = Effect.fnUntraced(function* (at: string, problem: string, brief: string) {
      const before = yield* step(
        `fix-before/${at}`,
        { returns: HeadSha },
        Effect.map(pullRequests.read(pr), (detail) => detail.headSha ?? null),
      );
      yield* held(agent(`fix/${at}`, { thread: done.thread, brief, timeout: config.stepTimeout }));
      const after = yield* step(
        `fix-after/${at}`,
        { returns: HeadSha },
        Effect.map(pullRequests.read(pr), (detail) => detail.headSha ?? null),
      );
      if (before === null || after === null || after !== before) {
        stats.fixRounds++;
        return undefined;
      }
      stats.noOpFixRounds++;
      return {
        problem: `Fix round ${at} pushed no new commit to ${prUrl} (head stayed ${after}). Previous issue remains open:\n\n${problem}`,
        notes: latest.lastReviewNotes,
      };
    });

    yield* tags(taskTags(input.taskId, input.projectId, "review"));
    let failure: { readonly problem: string; readonly notes: string | null } | undefined;
    let pushed = true;
    for (let r = 0; r <= config.fixRounds; r++) {
      if (pushed) {
        const result = yield* round(`${r}`);
        if (result === "merged") return merged();
        failure = result === "approved" ? undefined : result;
      }
      if (failure === undefined || failure.problem === HEAD_KEPT_CHANGING || r === config.fixRounds)
        break;
      const stalled = yield* fix(
        `${r}`,
        failure.problem,
        [
          `Pull request ${prUrl} is not ready to merge. ${failure.problem}`,
          "",
          "Fix it in your worktree, check it, and push to the same branch. Then say what you changed.",
          followUps,
        ].join("\n"),
      );
      pushed = stalled === undefined;
      failure = stalled ?? failure;
    }
    for (let n = 1; failure !== undefined; n++) {
      stats.asks++;
      const stuck = yield* ask(n === 1 ? "stuck" : `stuck/x${n - 1}`, {
        title: `${label} did not pass review: ${input.title}`,
        kind: "stuck",
        choices: ["Merge anyway", { value: "Fix again", requireReason: true }, "Stop"],
        data: {
          prUrl,
          problem: failure.problem,
          summary,
          fixRoundsUsed: stats.fixRounds,
          noOpFixRounds: stats.noOpFixRounds,
          ...latest,
          rulings,
        },
        links,
      });
      if (Option.isNone(stuck) || stuck.value.choice === "Stop") {
        return yield* stop("review did not pass");
      }
      if (stuck.value.choice === "Merge anyway") {
        stats.mergedAnyway = true;
        break;
      }
      stats.rulings++;
      const ruling = (stuck.value.reason ?? "").trim();
      rulings.push(ruling);
      const stalled = yield* fix(
        `x${n}`,
        failure.problem,
        [
          `A person looked at why pull request ${prUrl} did not pass review and ruled: ${ruling}`,
          "",
          "Follow that ruling wherever it differs from the review.",
          ...(latest.lastReviewNotes === null
            ? []
            : ["", "The review's last notes:", "", latest.lastReviewNotes]),
          ...(failure.notes === null ? ["", failure.problem] : []),
          "",
          "Make the changes in your worktree, check them, and push to the same branch so they land on the same pull request. Then say what you changed.",
          followUps,
        ].join("\n"),
      );
      if (stalled !== undefined) {
        failure = stalled;
        continue;
      }
      const result = yield* round(`x${n}`);
      if (result === "merged") return merged();
      failure = result === "approved" ? undefined : result;
    }

    const headSha = yield* pullRequestHead(pr);
    const exhausted = config.fixRounds > 0 && stats.fixRounds >= config.fixRounds;
    if (risk.tier === undefined) noteRisk(["no review round listed the changed files"]);
    if (headSha === null) {
      noteRisk(["the host did not report the head commit"]);
    } else if (risk.tier !== undefined && headSha !== risk.headSha) {
      noteRisk([`the head moved to ${headSha} after its changed files were listed`]);
    }
    if (exhausted) noteRisk([`${stats.fixRounds} of ${config.fixRounds} fix rounds used`]);
    const finalTier = ratchetRiskTier(
      risk.tier ?? "high",
      headSha === null || headSha !== risk.headSha || exhausted ? "high" : "low",
    );
    const mustAskMerge = finalTier === "high" || config.askMerge || config.mergeNeedsPerson;
    const needsPerson = finalTier === "high" || config.mergeNeedsPerson;
    if (mustAskMerge) stats.asks++;
    if (
      mustAskMerge &&
      !(yield* mergeApproved(
        {
          title: `Merge ${label}: ${input.title}?`,
          kind: "merge",
          links,
          data: {
            prUrl,
            headSha,
            summary,
            fixRoundsUsed: stats.fixRounds,
            noOpFixRounds: stats.noOpFixRounds,
            ...latest,
            rulings,
            riskTier: finalTier,
            riskReasons: risk.reasons,
          },
        },
        needsPerson,
      ))
    ) {
      return yield* stop("merge held");
    }
    yield* mergePullRequest(pr, headSha, config.mergeMethod);
    return merged(finalTier);
  }),
);

const factoryTask = workflow(
  FACTORY_TASK,
  {
    version: FACTORY_TASK_VERSION,
    payload: FactoryTaskRunInput,
    returns: TaskResult,
    asks: { plan: "Approve the plan?" },
  },
  Effect.fn(function* (input, run) {
    yield* title(`T-${input.number} ${input.title}`);
    yield* tags(taskTags(input.taskId, input.projectId, "planning"));
    const config = yield* step("config", { returns: PackConfig }, readConfig(input.projectId));
    const target = yield* resolveTarget(input.projectId);
    yield* resolvePlacement(input.projectId, config.readOnlyOn);
    if ("problem" in target) return yield* stop(target.problem);
    const planModel = config.planModel ?? input.model;
    const layout =
      target.workspace === "worktree"
        ? "separate agents can do at the same time, each in its own worktree of this project"
        : target.workspace === "root"
          ? "agents do one after another in this project's folder"
          : "separate agents can do at the same time, each in its own empty folder";
    const plan = yield* agent("plan", {
      project: target.projectId,
      title: `T-${input.number} plan: ${input.title}`,
      brief: [
        `Plan task T-${input.number}: ${input.title}`,
        ...(input.description.trim() === "" ? [] : ["", input.description]),
        ...(input.issueUrl === null ? [] : ["", `Issue: ${input.issueUrl}`]),
        "",
        `Change nothing: no edits, commits, branches or pull requests. Read what you need, then split the work into 1 to 6 parts that ${layout}.`,
        "Each agent sees only its part's brief, so make every brief complete: what to change, where, and how to check it.",
        "Return a short summary of the plan and the parts, each with a title and its brief.",
      ].join("\n"),
      interactionMode: "plan",
      ...(planModel === null ? {} : { model: planModel }),
      timeout: config.stepTimeout,
      returns: Plan,
    });
    if (config.askPlan) {
      const answer = yield* ask("approve-plan", {
        title: `Start T-${input.number} ${input.title} in ${plan.value.parts.length} parts?`,
        kind: "plan",
        choices: ["Start", "Drop"],
        data: plan.value,
      });
      if (Option.isNone(answer) || answer.value.choice !== "Start") {
        return yield* stop("plan not approved");
      }
    }

    yield* tags(taskTags(input.taskId, input.projectId, "doing"));
    const priorPrUrls =
      input.attempt >= 2 && target.workspace === "worktree"
        ? yield* step(
            "prior-prs",
            { returns: PullRequestUrls },
            Effect.gen(function* () {
              const urls = new Set(
                (yield* listAttempts(input.taskId))
                  .filter((earlier) => earlier.n < input.attempt)
                  .flatMap((earlier) => earlier.prUrls ?? []),
              );
              const open = yield* Effect.forEach([...urls], (url) =>
                Effect.map(
                  Effect.option(pullRequests.read({ project: target.projectId, url })),
                  (detail) => (Option.isSome(detail) && detail.value.state === "open" ? [url] : []),
                ),
              );
              return open.flat();
            }),
          )
        : [];
    // All at once: each part takes a place in the task's pool only while one of its agents works.
    const parts = yield* Effect.all(
      plan.value.parts.map((part, i) =>
        Effect.map(
          invoke(`part-${i}`, factoryTaskPart, {
            taskId: input.taskId,
            number: input.number,
            attempt: input.attempt,
            part: i,
            title: part.title,
            brief: part.brief,
            projectId: input.projectId,
            target,
            issueUrl: input.issueUrl,
            model: input.model,
            config,
            ...(priorPrUrls.length === 0 ? {} : { priorPrUrls }),
          }),
          (ended) =>
            ended.outcome === "completed"
              ? { title: part.title, ...ended.value }
              : { title: part.title, outcome: ended.outcome, prUrl: null, stats: null },
        ),
      ),
      { concurrency: "unbounded" },
    );
    const note = [
      `Attempt ${input.attempt} ended:`,
      ...parts.map(
        (part) => `- ${part.title}: ${part.outcome}${part.prUrl === null ? "" : ` ${part.prUrl}`}`,
      ),
    ].join("\n");
    yield* step(
      "finish",
      { returns: Schema.Void },
      finishAttempt({
        taskId: input.taskId,
        attempt: input.attempt,
        runId: run.id,
        projectId: input.projectId,
        note,
        parts,
      }),
    );
    yield* tags(taskTags(input.taskId, input.projectId, "done"));
    return { parts };
  }),
);

const factoryCapture = workflow(
  "factory-capture",
  {
    version: 1,
    payload: CapturePayload,
    returns: Schema.Union([
      Schema.Struct({
        taskId: Schema.String,
        number: Schema.Number,
        runId: Schema.NullOr(Schema.String),
      }),
      Problem,
    ]),
  },
  Effect.fn(function* (input, run) {
    const captured = yield* step(
      "capture",
      { returns: Captured },
      Effect.map(
        createTask(
          {
            projectId: input.projectId ?? null,
            title: input.title,
            description: input.description ?? "",
            lane: input.lane ?? "backlog",
            parentId: input.parentId ?? null,
            blockedBy: input.blockedBy ?? [],
            assignee: input.assignee ?? null,
            model: input.model ?? null,
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            source:
              input.issue === undefined
                ? { _tag: "local" }
                : { _tag: "issue", url: input.issue.url, displayKey: input.issue.displayKey },
          },
          capturedKey(run.id, "capture"),
        ),
        (created) =>
          "problem" in created ? created : { taskId: created.task.id, number: created.task.number },
      ),
    );
    if ("problem" in captured) return { problem: captured.problem };
    if (input.start !== true) return { ...captured, runId: null };
    const started = yield* within(
      startPool(captured.taskId),
      { limit: 1 },
      step(
        "start",
        { returns: StartOutcome },
        startTask(captured.taskId, "factory-capture", {
          runId: run.id,
          slot: "start",
        }),
      ),
    );
    return { ...captured, runId: started.outcome === "dropped" ? null : started.runId };
  }),
);

const factoryStart = workflow(
  "factory-start",
  { version: 1, payload: Schema.Struct({ taskId: Schema.String }), returns: Started },
  Effect.fn(function* (input, run) {
    const started = yield* within(
      startPool(input.taskId),
      { limit: 1 },
      step(
        "start",
        { returns: StartOutcome },
        startTask(input.taskId, "factory-start", { runId: run.id, slot: "start" }),
      ),
    );
    if (started.outcome === "dropped") return yield* stop("task is dropped");
    if (started.outcome === "running") return yield* stop("already running");
    return { taskId: input.taskId, attempt: started.attempt, runId: started.runId };
  }),
);

export default [factoryTaskPart, factoryTask, factoryCapture, factoryStart];
