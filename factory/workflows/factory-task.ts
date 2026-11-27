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
  addNote,
  capturedKey,
  createTask,
  hashFile,
  listAttempts,
  mergeApproved,
  mergeAtHead,
  mergePullRequest,
  projectPullRequest,
  pullRequestHead,
  readConfig,
  recordAttemptPullRequest,
  resolvePlacement,
  resolveTarget,
  resolveWritePlacement,
  rootPool,
  startPool,
  startTask,
  taskTags,
  writeArtifact,
  writeReceipt,
  writerBase,
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
import {
  FIX_PUSH_LINE,
  PLAN_FOLDER_LINE,
  PLAN_WORKTREE_LINE,
  READER_LINE,
  REMOTE_FOLLOW_UPS,
  REMOTE_NEEDS_GITHUB,
  REMOTE_NO_PULL_REQUEST,
  SCOPE_ERROR_LINE,
  WRITER_RETURN_LINE,
  againBranch,
  baseDiffers,
  baseTarget,
  branchNotGiven,
  continueReturnLine,
  continueWriterLine,
  fixContradicts,
  headCheck,
  headMoved,
  headUnusable,
  isFullSha,
  mergeUnconfirmed,
  mergedUnreviewed,
  mergedWrongBase,
  quoteBrief,
  quoteRulings,
  ranElsewhere,
  remoteBase,
  remoteLine,
  remotePriorLine,
  remoteScopeBase,
  scopeFailed,
  unreportedHead,
  writerBranch,
  writerLine,
  wrongBase,
  wrongRepository,
} from "./lib/placement.ts";
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

const HeadSha = Schema.NullOr(Schema.String);
const RemoteDone = Schema.Struct({
  summary: Schema.String,
  prUrl: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  baseSha: HeadSha,
  headSha: HeadSha,
});
const Pushed = Schema.Struct({
  summary: Schema.String,
  branch: Schema.NullOr(Schema.String),
  headSha: HeadSha,
});
type WorkerReport = typeof Done.Type | typeof RemoteDone.Type;

const WriterPr = Schema.Struct({
  provider: Schema.String,
  repository: Schema.String,
  headRepository: Schema.NullOr(Schema.String),
  headBranch: Schema.String,
  baseBranch: Schema.String,
  headSha: HeadSha,
});
const MergedHead = Schema.Struct({
  state: Schema.String,
  baseBranch: Schema.String,
  headSha: HeadSha,
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

const ScopeSuccess = Schema.Struct({ headSha: Schema.String, files: Schema.Array(Schema.String) });
const ScopeFailure = Schema.Struct({ error: Schema.String });
const ScopeReport = Schema.Struct({ report: Schema.Union([ScopeSuccess, ScopeFailure]) });

const PullRequestRiskSnapshot = Schema.Struct({
  headSha: Schema.NullOr(Schema.String),
  baseBranch: Schema.String,
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
    asks: {
      accept: "Accept the result?",
      stuck: "Review did not pass",
      merge: "Merge?",
      unreviewed: "Unreviewed commits merged",
    },
  },
  Effect.fn(function* (input, run) {
    const { config } = input;
    const label = `T-${input.number} part ${input.part + 1}`;
    const pool = `factory-task:${input.taskId}`;
    const slot = { limit: config.concurrency };
    yield* tags(taskTags(input.taskId, input.projectId, "doing"));
    const target = input.target ?? (yield* resolveTarget(input.projectId));
    const placement = yield* resolvePlacement(input.projectId, config.readOnlyOn);
    const workerModel = config.workerModel ?? input.model;
    const writePlacement = yield* resolveWritePlacement(input.projectId, config, workerModel);
    if ("problem" in target) return yield* stop(target.problem);
    const project = target.projectId;
    const rooted = target.workspace === "root";
    const attempt = input.attempt ?? 1;
    const writer =
      writePlacement.where === "remote"
        ? {
            ...writePlacement,
            target: baseTarget(writePlacement.baseRef),
            base: yield* writerBase(writePlacement.folder, baseTarget(writePlacement.baseRef)),
            branch: writerBranch(input.taskId, attempt, input.part),
          }
        : null;
    const where =
      writer !== null || target.workspace === "worktree" ? "this worktree" : "this folder";
    // A folder agents work in directly is shared by every task on its project. The task's place
    // is always taken before the folder's, so no two runs each hold what the other waits for.
    const held = <A, E, R>(body: Parameters<typeof within<A, E, R>>[2]) =>
      within(pool, slot, rooted ? within(rootPool(project), { limit: 1 }, body) : body);
    const holdWrite = <A, E, R>(body: Parameters<typeof within<A, E, R>>[2]) =>
      writer === null
        ? held(body)
        : within(pool, slot, within(writer.pool, { limit: writer.limit }, body));
    const issueUrl = input.issueUrl ?? null;
    const taskProject = input.projectId === null ? "null" : `"${input.projectId}"`;
    const followUps =
      writer !== null
        ? REMOTE_FOLLOW_UPS
        : `If you discover an out-of-scope bug or follow-up while working, do not widen this pull request: capture it as a new task with \`t3 workflow start factory-capture --input '{"title":"…","projectId":${taskProject},"lane":"ready","blockedBy":["${input.taskId}"]}' --key capture/<slug>\`.`;
    const priorPrUrls = input.priorPrUrls ?? [];
    const priorPrs =
      priorPrUrls.length === 0
        ? []
        : writer !== null
          ? [remotePriorLine(priorPrUrls)]
          : [
              `An earlier attempt at this task left ${priorPrUrls.length === 1 ? "this pull request" : "these pull requests"} open: ${priorPrUrls.join(", ")}`,
              "If one of them is for this part, check out its branch, make the change there, and push to that branch so that pull request is updated; return its URL as `prUrl`. Do not open a second pull request for the same change.",
            ];
    const issueLine =
      issueUrl === null
        ? []
        : [
            `Include a reference to \`${issueUrl}\` in the pull request description (for example \`Closes #N\` or \`Refs <url>\`).`,
          ];
    const returnRules = (continuing: boolean) =>
      writer !== null
        ? [
            continuing
              ? continueWriterLine(writer.base, writer.target)
              : writerLine(writer.base, writer.target),
            ...issueLine,
            continuing ? continueReturnLine(writer.base) : WRITER_RETURN_LINE,
          ]
        : [
            "If the project is a Git repository with a remote, commit, push a branch, open a pull request and return its URL as `prUrl`. Otherwise return `prUrl: null`.",
            "If there is no pull request and you left files a person should look at, return them as `artifacts`: at most 10, each with its absolute `path` and a short `label`.",
            ...(config.baseRef === null
              ? []
              : [`Open the pull request against the branch \`${baseTarget(config.baseRef)}\`.`]),
            ...issueLine,
            "Return a short `summary` of what you changed.",
          ];
    const workspace = rooted
      ? ({ type: "root" } as const)
      : ({ type: "worktree", baseRef: config.baseRef ?? "HEAD" } as const);
    const returns = writer === null ? Done : RemoteDone;
    const doOptions = (again: boolean) =>
      ({
        ...(writer === null
          ? { project, workspace, ...(workerModel === null ? {} : { model: workerModel }) }
          : {
              environment: writer.environment,
              project: writer.project,
              model: writer.model,
              workspace: {
                type: "worktree" as const,
                baseRef: remoteBase(writer.baseRef),
                branch: again ? againBranch(writer.branch) : writer.branch,
                startFromOrigin: true,
              },
              interactionMode: "default" as const,
            }),
        title: `${label}: ${input.title}`,
        brief: [
          `Do part ${input.part + 1} of task T-${input.number}: ${input.title}`,
          "",
          input.brief,
          "",
          `Make the change in ${where} and check that it works.`,
          followUps,
          ...priorPrs,
          ...returnRules(false),
        ].join("\n"),
        runtimeMode: "full-access",
        timeout: config.stepTimeout,
        returns,
      }) as const;
    const tried = yield* holdWrite(agent.try<WorkerReport, WorkerReport>("do", doOptions(false)));
    if (
      writer !== null &&
      tried.thread !== undefined &&
      tried.thread.environment !== writer.environment
    ) {
      return yield* stop(ranElsewhere("do"));
    }
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
        : yield* holdWrite(
            tried.thread === undefined
              ? agent<WorkerReport, WorkerReport>("do/again", doOptions(true))
              : agent<WorkerReport, WorkerReport>("do/continue", {
                  thread: tried.thread,
                  brief: [
                    `Your last turn on part ${input.part + 1} of task T-${input.number} was stopped before it returned a result: ${tried.reason}`,
                    "",
                    where === "this worktree"
                      ? "Do not start over. Run `git status` and `git log` in this worktree to see what is already done, then carry on from there: finish the part and check that it works."
                      : "Do not start over. Look through this folder to see what is already done, then carry on from there: finish the part and check that it works.",
                    followUps,
                    ...returnRules(true),
                  ].join("\n"),
                  timeout: config.stepTimeout,
                  returns,
                }),
          );
    const remoteWriter = yield* Effect.gen(function* () {
      if (writer === null) return null;
      const name =
        tried.outcome === "done" ? "do" : tried.thread === undefined ? "do/again" : "do/continue";
      if (done.thread.environment !== writer.environment) return yield* stop(ranElsewhere(name));
      const report = "baseSha" in done.value ? done.value : null;
      if (report === null || report.baseSha !== writer.base) {
        return yield* stop(baseDiffers(name, report?.baseSha ?? "nothing", writer.base));
      }
      if (report.prUrl === null) return yield* stop(REMOTE_NO_PULL_REQUEST);
      const given = name === "do/again" ? againBranch(writer.branch) : writer.branch;
      if (report.branch !== given) return yield* stop(branchNotGiven(name, report.branch, given));
      if (report.headSha === null || !isFullSha(report.headSha)) {
        return yield* stop(unreportedHead(name));
      }
      return {
        environment: writer.environment,
        target: writer.target,
        given,
        expectedHead: report.headSha,
      };
    });
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
      const listed = "artifacts" in done.value ? (done.value.artifacts ?? []) : [];
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
    const pr = { project, url: prUrl };
    const checkedRead = Effect.fnUntraced(function* <A, I, E>(
      name: string,
      returns: Parameters<typeof step<A, I, E>>[1]["returns"],
      read: Parameters<typeof step<A, I, E>>[2],
      headOf: (value: A) => string | null,
      options: {
        readonly expected?: string;
        readonly invalid?: (value: A) => string | undefined;
        readonly moved?: (seen: string) => string;
      } = {},
    ) {
      const expected = options.expected ?? remoteWriter?.expectedHead;
      for (let fresh = false; ; fresh = true) {
        const snapshot = yield* step(
          fresh ? `${name}/fresh` : name,
          { returns },
          fresh && expected !== undefined
            ? Effect.andThen(pullRequests.comment(pr, headCheck(expected)), read)
            : read,
        );
        const refusal = options.invalid?.(snapshot);
        if (refusal !== undefined) return yield* stop(refusal);
        if (expected === undefined) return snapshot;
        const seen = headOf(snapshot);
        if (seen === null || !isFullSha(seen)) return yield* stop(headUnusable(name));
        if (seen === expected) return snapshot;
        if (fresh) return yield* stop(options.moved?.(seen) ?? headMoved(name, seen, expected));
      }
    });
    const readHead = (
      name: string,
      options?: { expected: string; moved: (seen: string) => string },
    ) =>
      checkedRead(
        name,
        HeadSha,
        Effect.map(pullRequests.read(pr), (detail) => detail.headSha ?? null),
        (sha) => sha,
        options,
      );
    if (remoteWriter !== null) {
      yield* checkedRead(
        "writer-pr",
        WriterPr,
        Effect.map(pullRequests.read(pr), (detail) => ({
          provider: detail.provider,
          repository: detail.repository,
          headRepository: detail.headRepositoryNameWithOwner ?? null,
          headBranch: detail.headBranch,
          baseBranch: detail.baseBranch,
          headSha: detail.headSha ?? null,
        })),
        (snapshot) => snapshot.headSha,
        {
          invalid: ({ provider, repository, headRepository, baseBranch, headBranch }) => {
            if (provider !== "github") return REMOTE_NEEDS_GITHUB;
            if (headRepository?.toLowerCase() !== repository.toLowerCase()) {
              return wrongRepository(headRepository ?? "unknown", repository);
            }
            if (baseBranch !== remoteWriter.target) {
              return wrongBase(baseBranch, remoteWriter.target);
            }
            if (headBranch !== remoteWriter.given) {
              return branchNotGiven("writer-pr", headBranch, remoteWriter.given);
            }
            return undefined;
          },
        },
      );
    }
    yield* step(
      "pr-record",
      { returns: Schema.Void },
      recordAttemptPullRequest(input.taskId, attempt, prUrl),
    );

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
    let reviewedHead: string | null = null;
    let acceptedHead: string | null = null;
    const merged = Effect.fnUntraced(function* (
      tier = risk.tier ?? null,
      authorizedHead: string | null = null,
    ) {
      if (remoteWriter !== null) {
        const { expectedHead, target: expectedTarget } = remoteWriter;
        const { state, baseBranch, headSha } = yield* step(
          "merged-head",
          { returns: MergedHead },
          Effect.map(pullRequests.read(pr), (detail) => ({
            state: detail.state,
            baseBranch: detail.baseBranch,
            headSha: detail.headSha ?? null,
          })),
        );
        const mergedHead = state === "merged" ? headSha : null;
        let text: string | null = null;
        if (state !== "merged") {
          text = mergeUnconfirmed(prUrl, expectedHead, state);
        } else if (baseBranch !== expectedTarget) {
          text =
            authorizedHead === null
              ? mergedWrongBase(baseBranch, expectedTarget, prUrl)
              : `${prUrl} was merged into ${baseBranch}, not the authorized target ${expectedTarget}. Check the merge now.`;
        } else if (acceptedHead !== expectedHead && authorizedHead !== expectedHead) {
          text = `${prUrl} was merged at ${mergedHead ?? "unknown"}, but Factory had no accepted review of that commit. Check the merge now.`;
        } else if (mergedHead !== expectedHead) {
          text =
            authorizedHead === null
              ? mergedUnreviewed(mergedHead ?? "unknown", expectedHead, prUrl)
              : `${prUrl} was merged at ${mergedHead ?? "unknown"}, but a person authorized only ${authorizedHead}. Check the merge now.`;
        }
        if (text !== null) {
          yield* step(
            "unreviewed-note",
            { returns: Schema.Void },
            addNote(input.taskId, text, "factory-task", capturedKey(run.id, "unreviewed-note")),
          );
          yield* ask("unreviewed", {
            title: text,
            kind: "unreviewed",
            choices: ["Seen"],
            data: { prUrl, expectedHead, mergedHead },
            links,
          });
          return yield* stop(text);
        }
      }
      return { outcome: "merged", prUrl, stats: { ...stats, tier } } as const;
    });
    const noteRisk = (reasons: ReadonlyArray<string>) => {
      for (const reason of reasons) {
        if (!risk.reasons.includes(reason)) risk.reasons.push(reason);
      }
    };
    const quotation = quoteBrief(input.brief);
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
      const snapshot = yield* checkedRead(
        `risk-pr/${at}`,
        PullRequestRiskSnapshot,
        Effect.map(pullRequests.read(pr), (detail) => ({
          headSha: detail.headSha ?? null,
          baseBranch: detail.baseBranch,
          changedFiles: detail.changedFiles,
          checks,
        })),
        (value) => value.headSha,
        {
          invalid: ({ baseBranch }) =>
            remoteWriter !== null && baseBranch !== remoteWriter.target
              ? wrongBase(baseBranch, remoteWriter.target)
              : undefined,
        },
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
              READER_LINE,
              `List the files pull request ${prUrl} changes.`,
              "",
              ...readLines,
              remote
                ? remoteScopeBase(snapshot.baseBranch)
                : `Fetch the pull request's head commit${snapshot.headSha === null ? "" : ` \`${snapshot.headSha}\``} and run \`git diff --name-only <base>...<head>\`, where <head> is that commit and <base> is the branch the pull request targets.`,
              "Return `report` containing `headSha`: the full SHA of the commit you listed, and `files`: every path the command printed, exactly as printed.",
              SCOPE_ERROR_LINE,
              quotation,
            ].join("\n"),
            timeout: config.stepTimeout,
            returns: ScopeReport,
          }),
        );
        let files: ReadonlyArray<string> | null = null;
        if (scoped.outcome !== "done") {
          noteRisk([`the changed files could not be listed: ${scoped.reason}`]);
        } else {
          const { report } = scoped.value;
          if ("error" in report) {
            noteRisk([scopeFailed(report.error)]);
          } else if (snapshot.headSha !== null) {
            if (report.headSha === snapshot.headSha) {
              files = report.files;
            } else {
              staleScope = remote;
              noteRisk([
                `the changed files were listed at ${report.headSha}, not at the head ${snapshot.headSha}`,
              ]);
            }
          }
        }
        const classified = classifyRisk({
          files,
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
      const rulingLines = quoteRulings(rulings);
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
                brief: [READER_LINE, ...brief, quotation].join("\n"),
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
              READER_LINE,
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
              quotation,
            ].join("\n"),
            ...(model === null ? {} : { model }),
            timeout: config.stepTimeout,
            returns: DisproofReport,
          }),
        );
        if (disproof.outcome === "done") findings = applyDisproof(findings, disproof.value.results);
      }
      const after = yield* readHead(`head/${at}`);
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
      if (remoteWriter !== null) reviewedHead = head;
      latest = questionEvidence(findings);
      stats.reviewRounds++;
      stats.findingsRaised += blocking.length;
      stats.findingsRefuted += latest.refuted;
      if (verdict === "approve") {
        acceptedHead = reviewedHead;
        return "approved" as const;
      }
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
      const before = yield* readHead(`fix-before/${at}`);
      const name = `fix/${at}`;
      const afterName = `fix-after/${at}`;
      const after = yield* Effect.gen(function* () {
        if (remoteWriter === null) {
          yield* held(agent(name, { thread: done.thread, brief, timeout: config.stepTimeout }));
          return yield* readHead(afterName);
        }
        const fixed = yield* holdWrite(
          agent(name, {
            thread: done.thread,
            brief: `${brief}\n${FIX_PUSH_LINE}`,
            timeout: config.stepTimeout,
            returns: Pushed,
          }),
        );
        if (fixed.thread.environment !== remoteWriter.environment) {
          return yield* stop(ranElsewhere(name));
        }
        const { branch, headSha } = fixed.value;
        if (branch !== remoteWriter.given) {
          return yield* stop(branchNotGiven(name, branch, remoteWriter.given));
        }
        if (headSha !== null && !isFullSha(headSha)) return yield* stop(unreportedHead(name));
        const expected = headSha ?? remoteWriter.expectedHead;
        const confirmed = yield* readHead(afterName, {
          expected,
          moved: (seen) =>
            seen === before
              ? fixContradicts(name, expected, seen)
              : headMoved(afterName, seen, expected),
        });
        remoteWriter.expectedHead = expected;
        return confirmed;
      });
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
        if (result === "merged") return yield* merged();
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
        acceptedHead = reviewedHead;
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
      if (result === "merged") return yield* merged();
      failure = result === "approved" ? undefined : result;
    }

    const headSha =
      remoteWriter === null ? yield* pullRequestHead(pr) : yield* readHead("head-sha");
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
    const needsAuthorization =
      remoteWriter !== null && stats.mergedAnyway && acceptedHead !== headSha;
    const needsPerson = needsAuthorization || finalTier === "high" || config.mergeNeedsPerson;
    const mustAskMerge = needsPerson || config.askMerge;
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
            ...(needsAuthorization ? { baseBranch: remoteWriter.target } : {}),
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
    const authorizedHead = needsAuthorization ? headSha : null;
    if (remoteWriter === null) {
      yield* mergePullRequest(pr, headSha, config.mergeMethod);
    } else {
      const outcome = yield* mergeAtHead(
        pr,
        remoteWriter,
        config.mergeMethod,
        authorizedHead === null ? "reviewed" : "authorized",
      );
      if (outcome === "requested") {
        yield* pullRequests.wait("merge-wait", pr, {
          until: "merged",
          timeout: config.checksTimeout,
        });
      }
    }
    return yield* merged(finalTier, authorizedHead);
  }),
);

const factoryTask = workflow(
  FACTORY_TASK,
  {
    version: FACTORY_TASK_VERSION,
    payload: FactoryTaskRunInput,
    returns: TaskResult,
    asks: { plan: "Approve the plan?", notAccepted: "Part not accepted" },
  },
  Effect.fn(function* (input, run) {
    yield* title(`T-${input.number} ${input.title}`);
    yield* tags(taskTags(input.taskId, input.projectId, "planning"));
    const config = yield* step("config", { returns: PackConfig }, readConfig(input.projectId));
    const target = yield* resolveTarget(input.projectId);
    yield* resolvePlacement(input.projectId, config.readOnlyOn);
    yield* resolveWritePlacement(input.projectId, config, config.workerModel ?? input.model);
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
        ...(config.baseRef === null
          ? []
          : [
              `The workers' pull requests will target the branch \`${baseTarget(config.baseRef)}\`.`,
            ]),
        target.workspace === "worktree" ? PLAN_WORKTREE_LINE : PLAN_FOLDER_LINE,
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
    const children = yield* Effect.all(
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
          (ended) => ({ title: part.title, ended }),
        ),
      ),
      { concurrency: "unbounded" },
    );
    const parts = children.map(({ title, ended }) =>
      ended.outcome === "completed"
        ? { title, ...ended.value }
        : { title, outcome: ended.outcome, prUrl: null, stats: null },
    );
    const partLines = parts.map(
      (part) => `- ${part.title}: ${part.outcome}${part.prUrl === null ? "" : ` ${part.prUrl}`}`,
    );
    const note = [`Attempt ${input.attempt} ended:`, ...partLines].join("\n");
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
    const notAccepted = partLines.filter((_, i) => {
      const ended = children[i]?.ended;
      return ended?.outcome === "stopped" && ended.reason === "not accepted";
    });
    if (notAccepted.length > 0) {
      yield* ask("not-accepted", {
        title: `T-${input.number} ${input.title}: a part was not accepted`,
        kind: "notAccepted",
        choices: ["Seen"],
        data: { parts: notAccepted },
      });
      return yield* stop("a part was not accepted");
    }
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
