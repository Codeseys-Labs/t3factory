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
  localGitHasRemote,
  localWriterBranches,
  localWriterHead,
  mergeApproved,
  mergeAtHead,
  mergePullRequest,
  projectPullRequest,
  pullRequestHead,
  readConfig,
  readOriginHead,
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
const LOCAL_DELIVERY_FAILED = "a part could not deliver a verified pull request";

const matchesLocalWriterBranch = (branch: string, requested: string) =>
  branch === requested ||
  (branch.startsWith(`${requested}-`) &&
    /^(?:[2-9]|[1-9]\d+)$/.test(branch.slice(requested.length + 1)));

const terminalPr = ({ state }: { readonly state: string }) =>
  state === "merged" || state === "closed";

const checksOnHead = (
  checks: ReadonlyArray<{
    readonly placeholder?: boolean | undefined;
    readonly required?: boolean | undefined;
    readonly status: string;
  }>,
) => {
  const listed = checks.filter((check) => check.placeholder !== true);
  const counted = listed.some((check) => check.required === true)
    ? listed.filter((check) => check.required === true)
    : listed;
  if (counted.length === 0) return "none";
  if (counted.some((check) => check.status === "pending")) return "pending";
  return counted.some(
    ({ status }) => status === "failure" || status === "cancelled" || status === "action-required",
  )
    ? "failing"
    : "passing";
};

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
  localHasRemote: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
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
const PullRequestPosition = Schema.Struct({
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
const PinnedScopeReport = Schema.Struct({
  report: Schema.Union([
    ScopeSuccess,
    ScopeFailure,
    Schema.Struct({ missingBase: Schema.Literal(true) }),
  ]),
});
type ScopeResult = typeof PinnedScopeReport.Type;
const ReviewBase = Schema.Struct({ target: Schema.String, baseSha: HeadSha });

const PullRequestRiskSnapshot = Schema.Struct({
  state: Schema.String,
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
    const localFolder =
      writer === null && target.workspace === "worktree" ? target.workspaceRoot : null;
    if (input.localHasRemote === null) {
      return yield* stop(`${LOCAL_DELIVERY_FAILED}: could not determine the project's Git remotes`);
    }
    const localBranch =
      input.localHasRemote === true ? writerBranch(input.taskId, attempt, input.part) : null;
    const previousBranches =
      localFolder !== null && localBranch !== null
        ? yield* step(
            "deliver/branches",
            { returns: Schema.NullOr(Schema.Array(Schema.String)) },
            localWriterBranches(localFolder, localBranch),
          )
        : [];
    if (previousBranches === null) {
      return yield* stop(`${LOCAL_DELIVERY_FAILED}: could not read the launch branch namespace`);
    }
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
            ...(localBranch === null
              ? [
                  "If the project is a Git repository with a remote, commit, push a branch, open a pull request and return its URL as `prUrl`. Otherwise return `prUrl: null`.",
                  "If there is no pull request and you left files a person should look at, return them as `artifacts`: at most 10, each with its absolute `path` and a short `label`.",
                ]
              : [
                  "Commit on this worktree's branch and push it under its own name. Do not create, switch or rename branches unless you are updating one of the earlier pull requests listed above. Return `prUrl` after the pull request is open, not while publication is still in flight.",
                ]),
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
          ? {
              project,
              workspace:
                workspace.type === "worktree" && localBranch !== null
                  ? { ...workspace, branch: again ? againBranch(localBranch) : localBranch }
                  : workspace,
              ...(workerModel === null ? {} : { model: workerModel }),
            }
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
    let done =
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
    const assignedLocalBranch =
      localBranch !== null && tried.outcome === "failed" && tried.thread === undefined
        ? againBranch(localBranch)
        : localBranch;
    let recovered = false;
    if (done.value.prUrl === null && localFolder !== null && assignedLocalBranch !== null) {
      const delivery = yield* holdWrite(
        agent.try("do/deliver", {
          thread: done.thread,
          brief: [
            `Finish publishing part ${input.part + 1} of task T-${input.number}; its last result did not include a pull request.`,
            "Stay on the branch already checked out in this worktree. Do not start over, switch branches, or open a duplicate pull request.",
            "Finish the requested checks, commit and push this branch if needed without force, and return the existing pull request URL if one is already open for it. Otherwise open one. Do not merge.",
            ...(config.baseRef === null
              ? []
              : [`The pull request must target \`${baseTarget(config.baseRef)}\`.`]),
            ...issueLine,
            "Return `prUrl` only once the pull request is open, and include a short summary of the change.",
          ].join("\n"),
          timeout: config.stepTimeout,
          returns: Done,
        }),
      );
      if (delivery.outcome === "failed" || delivery.value.prUrl === null) {
        return yield* stop(`${LOCAL_DELIVERY_FAILED}: the writer did not return a pull request`);
      }
      recovered = true;
      done = delivery;
    }
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
      continued: tried.outcome !== "done" || recovered,
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
    const recordDelivery = recordAttemptPullRequest(input.taskId, attempt, prUrl);
    let localWriter: {
      readonly branch: string;
      readonly target: string;
      readonly state: "open" | "merged";
      expectedHead: string;
    } | null = null;
    if (localFolder !== null && assignedLocalBranch !== null) {
      const base = config.baseRef === null ? null : baseTarget(config.baseRef);
      const verified = yield* step(
        "deliver/verify",
        {
          returns: Schema.Union([
            Schema.Literals(["unverified", "mismatch", "unreadable"]),
            Schema.Struct({
              branch: Schema.String,
              target: Schema.String,
              state: Schema.Literals(["open", "merged"]),
              expectedHead: Schema.String,
            }),
          ]),
        },
        Effect.gen(function* () {
          const detail = yield* pullRequests.read(pr);
          if (detail.provider !== "github") return "unverified" as const;
          const branch = detail.headBranch;
          const priorAttempt = Number(branch.match(/\/a([1-9]\d*)-p/)?.[1]);
          const priorBranch = writerBranch(input.taskId, priorAttempt, input.part);
          const reusesOwnPart =
            priorPrUrls.includes(prUrl) &&
            priorAttempt < attempt &&
            (matchesLocalWriterBranch(branch, priorBranch) ||
              matchesLocalWriterBranch(branch, againBranch(priorBranch)));
          if (
            (detail.state !== "open" && detail.state !== "merged") ||
            detail.headRepositoryNameWithOwner?.toLowerCase() !== detail.repository.toLowerCase() ||
            (base !== null && detail.baseBranch !== base) ||
            ((!matchesLocalWriterBranch(branch, assignedLocalBranch) ||
              previousBranches.includes(branch)) &&
              !reusesOwnPart)
          ) {
            return "mismatch" as const;
          }
          const head = yield* localWriterHead(localFolder, branch);
          if (head === null && detail.state === "open") return "unreadable" as const;
          return head !== null && detail.headSha === head
            ? { branch, target: detail.baseBranch, state: detail.state, expectedHead: head }
            : ("mismatch" as const);
        }),
      );
      if (verified === "unreadable") {
        yield* step("pr-record", { returns: Schema.Void }, recordDelivery);
        return yield* stop(
          `${LOCAL_DELIVERY_FAILED}: could not read the local branch tip; the pull request was recorded for a retry`,
        );
      }
      if (verified === "mismatch") {
        return yield* stop(
          `${LOCAL_DELIVERY_FAILED}: no open pull request matches the writer's repository, branch, commit, and target`,
        );
      }
      if (verified === "unverified") {
        if (recovered) {
          return yield* stop(
            `${LOCAL_DELIVERY_FAILED}: the forge cannot verify the source repository of the recovered pull request`,
          );
        }
      } else {
        localWriter = verified;
      }
    }
    const verifiedWriter = remoteWriter ?? localWriter;
    const checkedRead = Effect.fnUntraced(function* <A, I, E>(
      name: string,
      returns: Parameters<typeof step<A, I, E>>[1]["returns"],
      read: Parameters<typeof step<A, I, E>>[2],
      headOf: (value: A) => string | null,
      options: {
        readonly expected?: string;
        readonly refresh?: true;
        readonly invalid?: (value: A) => string | undefined;
        readonly terminal?: (value: A) => boolean;
        readonly moved?: (seen: string) => string;
      } = {},
    ) {
      const expected = options.expected ?? verifiedWriter?.expectedHead;
      for (let fresh = false; ; fresh = true) {
        const refresh = fresh || options.refresh === true;
        const snapshot = yield* step(
          fresh ? `${name}/fresh` : name,
          { returns },
          refresh && expected !== undefined
            ? Effect.andThen(pullRequests.comment(pr, headCheck(expected)), read)
            : read,
        );
        if (options.terminal?.(snapshot)) return snapshot;
        const refusal = options.invalid?.(snapshot);
        if (refusal !== undefined) return yield* stop(refusal);
        if (expected === undefined) return snapshot;
        const seen = headOf(snapshot);
        if (seen === null || !isFullSha(seen)) return yield* stop(headUnusable(name));
        if (seen === expected) return snapshot;
        if (refresh) return yield* stop(options.moved?.(seen) ?? headMoved(name, seen, expected));
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
    yield* step("pr-record", { returns: Schema.Void }, recordDelivery);

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
    const expectedTarget = verifiedWriter?.target;
    const rulings: Array<string> = [];
    let latest = questionEvidence(null);
    // The tier a part's changes earn only goes up: a later round can raise it, never lower it.
    const risk: {
      tier: RiskTier | undefined;
      headSha: string | null;
      baseSha: string | null;
      reasons: Array<string>;
    } = {
      tier: undefined,
      headSha: null,
      baseSha: null,
      reasons: [],
    };
    let reviewedHead: string | null = null;
    let acceptedHead: string | null = null;
    const readPrPosition = Effect.map(pullRequests.read(pr), (detail) => ({
      state: detail.state,
      baseBranch: detail.baseBranch,
      headSha: detail.headSha ?? null,
    }));
    const merged = Effect.fnUntraced(function* (
      tier = risk.tier ?? null,
      authorizedHead: string | null = null,
    ) {
      if (verifiedWriter !== null) {
        const { expectedHead, target: expectedTarget } = verifiedWriter;
        const { state, baseBranch, headSha } = yield* step(
          "merged-head",
          { returns: PullRequestPosition },
          readPrPosition,
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
    if (localWriter?.state === "merged") return yield* merged();
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
      if (
        localWriter === null &&
        standing.value.checks !== "passing" &&
        standing.value.checks !== "none"
      ) {
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
          state: detail.state,
          headSha: detail.headSha ?? null,
          baseBranch: detail.baseBranch,
          changedFiles: detail.changedFiles,
          checks: localWriter === null ? checks : checksOnHead(detail.checks),
        })),
        (value) => value.headSha,
        {
          ...(localWriter === null ? {} : { terminal: terminalPr }),
          invalid: ({ baseBranch }) =>
            expectedTarget !== undefined && baseBranch !== expectedTarget
              ? wrongBase(baseBranch, expectedTarget)
              : undefined,
        },
      );
      if (localWriter !== null) {
        if (snapshot.state === "merged") return "merged" as const;
        if (snapshot.state === "closed") return yield* stop("pull request closed");
        if (snapshot.checks !== "passing" && !(snapshot.checks === "none" && checks === "none")) {
          return {
            problem: "Its checks have not passed on the writer's verified commit.",
            notes: null,
          };
        }
      }
      const head = snapshot.headSha;
      const reviewBase =
        writer === null
          ? null
          : yield* step(
              `review-base/${at}`,
              { returns: ReviewBase },
              Effect.map(readOriginHead(writer.folder, writer.target), (baseSha) => ({
                target: writer.target,
                baseSha,
              })),
            );
      if (reviewBase !== null && reviewBase.baseSha === null) {
        return yield* stop(
          `Could not pin the review base origin/${reviewBase.target}. Nothing was merged.`,
        );
      }
      const range = reviewBase === null ? null : `${reviewBase.baseSha}...${head}`;
      const basis =
        reviewBase === null
          ? []
          : [
              `Compare the configured target \`${reviewBase.target}\` with this head using the pinned commits below. Do not substitute the live pull request diff, a branch tip, or another base.`,
            ];
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
      if (remote && reviewBase !== null) {
        readLines.push(
          "Run every Git command with `GIT_NO_LAZY_FETCH=1` and `GIT_ALLOW_PROTOCOL=factory-review-no-transport` in its environment. This prevents implicit fetches from partial clones. If you cannot set both variables, do not run Git.",
        );
      }
      const holdRead = <A, E, R>(body: Parameters<typeof within<A, E, R>>[2]) =>
        remote
          ? within(pool, slot, within(placement.pool, { limit: placement.limit }, body))
          : held(body);
      let staleScope = false;
      if (
        risk.tier === undefined ||
        (reviewBase !== null && reviewBase.baseSha !== risk.baseSha) ||
        (snapshot.headSha !== null && snapshot.headSha !== risk.headSha)
      ) {
        const pinnedReader = remote && reviewBase !== null;
        const scoped = yield* holdRead(
          agent.try<ScopeResult, ScopeResult>(`scope/${at}`, {
            ...readOptions,
            title: `${label} scope: ${input.title}`,
            brief: [
              READER_LINE,
              `List the files pull request ${prUrl} changes.`,
              "",
              ...readLines,
              ...basis,
              ...(pinnedReader
                ? [
                    `First run \`git rev-parse --verify "${reviewBase.baseSha}^{commit}"\`. If the commit is missing from this clone, return \`{"report":{"missingBase":true}}\` immediately. Do not fetch it.`,
                  ]
                : []),
              range !== null
                ? `Run \`git diff --name-only ${range}\`.`
                : remote
                  ? remoteScopeBase(snapshot.baseBranch)
                  : `Fetch the pull request's head commit${snapshot.headSha === null ? "" : ` \`${snapshot.headSha}\``} and run \`git diff --name-only <base>...<head>\`, where <head> is that commit and <base> is the branch the pull request targets.`,
              "Return `report` containing `headSha`: the full SHA of the commit you listed, and `files`: every path the command printed, exactly as printed.",
              pinnedReader
                ? "For any other failure, return `report` containing only `error`: the last line of output."
                : SCOPE_ERROR_LINE,
              quotation,
            ].join("\n"),
            timeout: config.stepTimeout,
            returns: pinnedReader ? PinnedScopeReport : ScopeReport,
          }),
        );
        let files: ReadonlyArray<string> | null = null;
        if (scoped.outcome !== "done") {
          noteRisk([`the changed files could not be listed: ${scoped.reason}`]);
        } else {
          const { report } = scoped.value;
          if (pinnedReader && "missingBase" in report) {
            return yield* stop(
              `The reader in environment ${placement.environment}, project ${placement.project}, lacks the pinned base commit ${reviewBase.baseSha}. Fetch the target branch ${reviewBase.target} from origin in that project's clone, verify it contains ${reviewBase.baseSha}, then start the task again. Nothing was merged.`,
            );
          }
          if ("error" in report) {
            noteRisk([scopeFailed(report.error)]);
          } else if ("files" in report && snapshot.headSha !== null) {
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
        risk.baseSha = reviewBase?.baseSha ?? null;
      }
      const commit = head === null ? [] : [`Review commit \`${head}\`.`];
      if (range !== null) commit.push(...basis, `Run \`git diff ${range}\`.`);
      const rulingLines = quoteRulings(rulings);
      const reportInstructions =
        "Return `reviewedHead` (the full SHA you read, or null if unknown) and `findings` (severity, category, repository-relative path or empty string, line or null, claim, and quoted evidence). An empty findings list means it can be merged as it is. Blocker and major findings block the merge; minor and nit do not.";
      const reviewInstructions =
        range === null
          ? reportInstructions
          : `${reportInstructions} If you cannot read the pinned comparison, return null for \`reviewedHead\`.`;
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
                  range === null
                    ? "Change nothing. Read its diff and check that it does what the brief asks, works, and changes nothing else."
                    : "Change nothing. Check that the pinned diff does what the brief asks, works, and changes nothing else.",
                  "Actively try to disprove the change: name one concrete input, edge case, or counterfactual state that could break it, verify whether the diff handles it, and cite exact file paths and line numbers for every finding.",
                  ...(issueUrl === null
                    ? []
                    : [
                        `It is for issue ${issueUrl}: check that the pull request description, or a comment on it, references that issue.`,
                      ]),
                  ...rulingLines,
                  reviewInstructions,
                ]
              : [
                  `Review pull request ${prUrl}.`,
                  ...commit,
                  ...readLines,
                  "What input or state breaks the changed lines? Quote the line. Change nothing.",
                  ...rulingLines,
                  reviewInstructions,
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
              ...(range === null
                ? []
                : ["If you cannot read the pinned comparison, do not refute any finding."]),
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
      let after: string | null;
      if (localWriter === null) {
        after = yield* readHead(`head/${at}`);
      } else {
        const position = yield* checkedRead(
          `head/${at}`,
          PullRequestPosition,
          readPrPosition,
          (value) => value.headSha,
          // A merge can leave the cached head unchanged while the open state is stale.
          { refresh: true, terminal: terminalPr },
        );
        if (position.state === "merged") return "merged" as const;
        if (position.state === "closed") return yield* stop("pull request closed");
        after = position.headSha;
      }
      const requiresReviewedHead = localWriter !== null || reviewBase !== null || remote;
      const stale =
        head !== null &&
        (staleScope ||
          (after !== null && after !== head) ||
          reports.some(
            ({ report }) =>
              (requiresReviewedHead || report.reviewedHead !== null) &&
              report.reviewedHead !== head,
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
      if (verifiedWriter !== null) reviewedHead = head;
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
          if (localWriter !== null && localFolder !== null) {
            const branch = localWriter.branch;
            const expected = yield* step(
              `fix-local-head/${at}`,
              { returns: HeadSha },
              localWriterHead(localFolder, branch),
            );
            if (expected === null) return yield* stop(headUnusable(name));
            const confirmed = yield* readHead(afterName, {
              expected,
              moved: (seen) =>
                seen === before
                  ? fixContradicts(name, expected, seen)
                  : headMoved(afterName, seen, expected),
            });
            localWriter.expectedHead = expected;
            return confirmed;
          }
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
      verifiedWriter === null ? yield* pullRequestHead(pr) : yield* readHead("head-sha");
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
      verifiedWriter !== null && stats.mergedAnyway && acceptedHead !== headSha;
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
            ...(expectedTarget !== undefined && (localWriter !== null || needsAuthorization)
              ? { baseBranch: expectedTarget }
              : {}),
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
    if (verifiedWriter === null) {
      yield* mergePullRequest(pr, headSha, config.mergeMethod);
    } else {
      const outcome = yield* mergeAtHead(
        pr,
        verifiedWriter,
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
    const writePlacement = yield* resolveWritePlacement(
      input.projectId,
      config,
      config.workerModel ?? input.model,
    );
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
    const localHasRemote =
      writePlacement.where === "local" &&
      target.workspace === "worktree" &&
      target.workspaceRoot !== null
        ? yield* step(
            "local-delivery",
            { returns: Schema.NullOr(Schema.Boolean) },
            localGitHasRemote(target.workspaceRoot),
          )
        : false;
    if (localHasRemote === null) {
      return yield* stop(`${LOCAL_DELIVERY_FAILED}: could not determine the project's Git remotes`);
    }
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
            localHasRemote,
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
    for (const { title, ended } of children) {
      if (
        ended.outcome !== "completed" &&
        (localHasRemote === true ||
          (ended.outcome === "stopped" && ended.reason?.startsWith(LOCAL_DELIVERY_FAILED)))
      ) {
        return yield* stop(
          `${title}: ${ended.outcome === "stopped" ? (ended.reason ?? "stopped") : ended.outcome}`,
        );
      }
    }
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
