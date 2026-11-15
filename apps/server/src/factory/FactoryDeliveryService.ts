import {
  CommandId,
  FactoryDeliveryError,
  FACTORY_KNOWLEDGE_ARTIFACT_PREVIEW_MAX_BYTES,
  type FactoryArtifactDeliveryGrantInput,
  type FactoryArtifactDeliveryIntent,
  type FactoryArtifactDeliveryRemote,
  type FactoryCommitDeliveryIntent,
  type FactoryAcceptanceError,
  type FactoryDeliveryGrantInput,
  type FactoryDeliveryIntent,
  type FactoryDeliveryCommitKind,
  type FactoryDeliveryKind,
  type FactoryDeliveryMergePayload,
  type FactoryDeliveryPayload,
  type FactoryDeliveryPrepareInput,
  type FactoryDeliveryPrepareResult,
  type FactoryDeliveryPublishPayload,
  type FactoryDeliveryPullRequest,
  type FactoryDeliveryReadInput,
  type FactoryDeliveryReadResult,
  type FactoryDeliveryReconcileInput,
  type FactoryOriginKey,
  type FactoryRepository,
  type ProjectId,
  type PullRequestDetail,
  type PullRequestMergeMethod,
  type PullRequestRef,
  type ThreadId,
} from "@t3tools/contracts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the digest must be one pure, synchronous function so the transactional grant recheck and prepare compute byte-identical values without a service boundary between them.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as GitManager from "../git/GitManager.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as AcceptanceStore from "../persistence/FactoryAcceptanceStore.ts";
import * as Store from "../persistence/FactoryDeliveryStore.ts";
import * as KnowledgeStore from "../persistence/FactoryKnowledgeStore.ts";
import * as Projects from "../project/ProjectService.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Acceptance from "./FactoryAcceptanceService.ts";
import * as Knowledge from "./FactoryKnowledgeService.ts";
import { carriesDeliveryMarker, renderArtifactComment } from "./FactoryArtifactDeliveryBody.ts";
import { issueOriginKey, knowledgeBriefOriginKey } from "./FactoryOriginKey.ts";
import { makeRepositoryResolver } from "./FactoryTaskLaunch.ts";
import { IssueTrackerProviderRegistry } from "./IssueTrackerProviderRegistry.ts";

const FAILURE_MAX_CHARS = 1000;
const PUBLICATION_LOOKUP_LIMIT = 100;
const REMOTE_READ_TIMEOUT_MS = 30_000;
// A push that times out may still have landed; the next Publish finds the branch at this commit.
const PUSH_TIMEOUT_MS = 300_000;

// Only these GitHub rejections prove no write occurred; all other failures stay unknown.
// Other hosts cannot publish until their definite rejections are classified here.
const DEFINITE_REJECTION_TAGS = new Set([
  "GitHubApiAuthenticationError",
  "GitHubApiRateLimitError",
  "GitHubApiNotFoundError",
  "GitHubCliMissingError",
  "GitHubNotSignedInError",
  "GitHubHostDisabledError",
  "GitHubCredentialUnavailableError",
  "SourceControlRateLimitPausedError",
]);

const isDefiniteRejection = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const { _tag, status, cause } = current as {
      readonly _tag?: unknown;
      readonly status?: unknown;
      readonly cause?: unknown;
    };
    if (typeof _tag === "string" && DEFINITE_REJECTION_TAGS.has(_tag)) return true;
    if (_tag === "GitHubApiResponseError" && typeof status === "number")
      return status >= 400 && status < 500 && status !== 408;
    current = cause;
  }
  return false;
};

// What a merge request that never reached GitHub's merge can look like. The pull request service
// raises its own errors with no cause before sending anything (project, capability, access), the
// host answers a refused mutation with a GraphQL `errors` body (status 200 here, as a stale
// `expectedHeadOid` does) or a 4xx, and a credential or rate limit stops the call outright.
const NEVER_SENT_PROVIDER_REASONS = new Set([
  "missing-tool",
  "unauthenticated",
  "rate-limited",
  "not-found",
]);

const isDefiniteMergeRejection = (error: PullRequests.PullRequestError): boolean => {
  if (error._tag === "PullRequestUnavailableError") return true;
  if (error.cause === undefined) return true;
  if (isDefiniteRejection(error)) return true;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const { _tag, status, reason, cause } = current as {
      readonly _tag?: unknown;
      readonly status?: unknown;
      readonly reason?: unknown;
      readonly cause?: unknown;
    };
    if (
      _tag === "PullRequestProviderError" &&
      typeof reason === "string" &&
      NEVER_SENT_PROVIDER_REASONS.has(reason)
    )
      return true;
    if (_tag === "GitHubApiResponseError" && status === 200) return true;
    current = cause;
  }
  return false;
};

const describe = (prefix: string, error: { readonly message: string }) =>
  `${prefix}: ${error.message}`.slice(0, FAILURE_MAX_CHARS);

const isMergePayload = (payload: FactoryDeliveryPayload): payload is FactoryDeliveryMergePayload =>
  "mergeMethod" in payload;

/** A kind and the payload shape it takes; any other pairing is a payload the grantor did not see. */
type DeliveryTarget =
  | { readonly kind: "publish-pr"; readonly payload: FactoryDeliveryPublishPayload }
  | { readonly kind: "merge-pr"; readonly payload: FactoryDeliveryMergePayload };

const targetOf = (input: {
  readonly kind: FactoryDeliveryKind;
  readonly payload: FactoryDeliveryPayload;
}): DeliveryTarget | null => {
  if (input.kind === "merge-pr")
    return isMergePayload(input.payload) ? { kind: input.kind, payload: input.payload } : null;
  return input.kind === "publish-pr" && "title" in input.payload
    ? { kind: input.kind, payload: input.payload }
    : null;
};

/** The digest a grant echoes back; computed only here so a client cannot choose what it signs. */
export const deliveryPayloadDigest = (
  input: {
    readonly repository: FactoryRepository;
    readonly baseRef: string;
    readonly baseBranch: string | null;
    readonly baseSha: string;
    readonly headSha: string;
  } & (
    | { readonly kind: "publish-pr"; readonly payload: FactoryDeliveryPublishPayload }
    | {
        readonly kind: "merge-pr";
        readonly payload: FactoryDeliveryMergePayload;
        readonly pullRequestNumber: number;
      }
  ),
) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        input.kind === "merge-pr"
          ? [
              input.kind,
              input.repository.canonicalKey,
              input.baseRef,
              input.baseBranch,
              input.baseSha,
              input.repository.provider,
              input.repository.host,
              input.headSha,
              input.pullRequestNumber,
              input.payload.mergeMethod,
            ]
          : [
              input.kind,
              input.repository.canonicalKey,
              input.baseRef,
              input.baseBranch,
              input.baseSha,
              input.repository.provider,
              input.repository.host,
              input.headSha,
              input.payload.title,
              input.payload.body,
              input.payload.draft,
              // Appended only when set, so digests granted before branch publishing still match.
              ...(input.payload.headBranch === undefined ? [] : [input.payload.headBranch]),
            ],
      ),
      "utf8",
    )
    .digest("hex");

const summarizeChecks = (checks: PullRequestDetail["checks"]) => {
  let passed = 0;
  let failing = 0;
  let pending = 0;
  for (const check of checks) {
    if (check.status === "success") passed += 1;
    else if (check.status === "failure" || check.status === "cancelled") failing += 1;
    else if (check.status === "pending" || check.status === "action-required") pending += 1;
  }
  const parts = [
    passed > 0 ? `${passed} passed` : null,
    failing > 0 ? `${failing} failing` : null,
    pending > 0 ? `${pending} pending` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
};

const summarizePullRequest = (detail: PullRequestDetail): FactoryDeliveryPullRequest => ({
  number: detail.number,
  url: detail.url,
  headSha: detail.headSha ?? null,
  state: detail.state,
  mergeability: detail.mergeability,
  isDraft: detail.isDraft,
  checksSummary: summarizeChecks(detail.checks),
  mergeMethods: detail.capabilities.mergeMethods,
});

export interface FactoryCommitGrant {
  readonly kind: FactoryDeliveryCommitKind;
  readonly commandId: string;
  readonly originKey: FactoryOriginKey;
  readonly acceptanceId: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly headSha: string;
  readonly baseRef: string | null;
  /** What a `publish-pr` opens, and the new branch the commit is pushed to. */
  readonly publish: {
    readonly title: string;
    readonly body: string;
    readonly headBranch: string;
    /** The issue the result answers, closed on merge when the pull request's host can reach it. */
    readonly closes: {
      readonly provider: string;
      readonly canonicalKey: string;
      readonly number: number;
    } | null;
  };
  readonly recheck: Effect.Effect<void, FactoryDeliveryError>;
}

// The host's own order among the methods it allows, so no client setting is needed here.
const allowedMergeMethod = (detail: PullRequestDetail): PullRequestMergeMethod | null =>
  detail.capabilities.mergeMethods.find((method) => detail.mergeCapabilities[method]) ?? null;

export class FactoryDeliveryService extends Context.Service<
  FactoryDeliveryService,
  {
    /** Read-only proposal of the exact payload a person can grant; agents may call it. */
    readonly prepare: (
      input: FactoryDeliveryPrepareInput,
    ) => Effect.Effect<FactoryDeliveryPrepareResult, FactoryDeliveryError>;
    /**
     * A person's act, never an agent's: the only caller is the guarded RPC, and no MCP tool
     * exposes it. Single-use over the exact head and payload digest the grantor saw.
     */
    readonly grant: (
      input: FactoryDeliveryGrantInput,
    ) => Effect.Effect<FactoryDeliveryIntent, FactoryDeliveryError>;
    /**
     * The same single-use grant for a commit whose owner, not a Factory claim, recorded the
     * acceptance: a task result. The owner names the exact commit and rechecks its own acceptance
     * inside the grant transaction. A person's act, never an agent's.
     */
    readonly grantCommit: (
      input: FactoryCommitGrant,
    ) => Effect.Effect<FactoryCommitDeliveryIntent, FactoryDeliveryError>;
    readonly read: (
      input: FactoryDeliveryReadInput,
    ) => Effect.Effect<FactoryDeliveryReadResult, FactoryDeliveryError>;
    /** Settles an `unknown` or `failed` intent by reading remote state. Never sends. */
    readonly reconcile: (
      input: FactoryDeliveryReconcileInput,
    ) => Effect.Effect<FactoryDeliveryIntent, FactoryDeliveryError>;
    /**
     * Called only by the effect worker. A retry that finds the intent already `sending` means a
     * previous attempt may have reached the forge, so it settles `unknown` and never re-sends.
     */
    readonly execute: (intentId: string) => Effect.Effect<void, FactoryDeliveryError>;
  }
>()("t3/factory/FactoryDeliveryService") {}

const fromAcceptance = (error: FactoryAcceptanceError) =>
  new FactoryDeliveryError({
    reason:
      error.reason === "unknown-thread" || error.reason === "worktree-unavailable"
        ? error.reason
        : error.reason === "not-a-factory-task"
          ? "not-a-factory-task"
          : "persistence-failure",
    cause: error,
  });
const persistenceFailure = (cause: unknown) =>
  new FactoryDeliveryError({ reason: "persistence-failure", cause });

const makeService = Effect.gen(function* () {
  const store = yield* Store.FactoryDeliveryStore;
  const acceptanceStore = yield* AcceptanceStore.FactoryAcceptanceStore;
  const acceptance = yield* Acceptance.FactoryAcceptanceService;
  const knowledgeStore = yield* KnowledgeStore.FactoryKnowledgeStore;
  const knowledge = yield* Knowledge.FactoryKnowledgeService;
  const projects = yield* Projects.ProjectService;
  const resolveRepository = yield* makeRepositoryResolver;
  const environment = yield* ServerEnvironmentIdentity;
  const threads = yield* Threads.ThreadManagementService;
  const git = yield* Git.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const trackers = yield* IssueTrackerProviderRegistry;
  const pullRequests = yield* PullRequests.PullRequestService;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = NodeOS.tmpdir();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // What the grantor is shown and what a grant re-derives: the claim, the live acceptance, and
  // whether the worktree still sits on the accepted commit. Every caller reads it before the host,
  // so a host that cannot deliver with the exact-commit guarantee is refused without being asked.
  const observe = Effect.fn("FactoryDeliveryService.observe")(function* (input: {
    readonly projectId: FactoryDeliveryReadInput["projectId"];
    readonly threadId: FactoryDeliveryReadInput["threadId"];
    readonly kind: FactoryDeliveryKind;
  }) {
    const origin = yield* acceptanceStore
      .resolveOrigin(input.threadId)
      .pipe(Effect.mapError(fromAcceptance));
    const read = yield* acceptance
      .read({ projectId: input.projectId, threadId: input.threadId })
      .pipe(Effect.mapError(fromAcceptance));
    if (Option.isNone(origin))
      return yield* new FactoryDeliveryError({ reason: "not-a-factory-task" });
    // The provider frozen into the claim at admission, not whatever the checkout points at now.
    const capabilities = trackers.get(origin.value.repository.provider)?.capabilities;
    if (
      capabilities === undefined ||
      !capabilities.publish ||
      (input.kind === "merge-pr" && !capabilities.headPinnedMerge)
    )
      return yield* new FactoryDeliveryError({ reason: "capability-unsupported" });
    if (read.acceptance === null || read.acceptance.originKey !== origin.value.originKey)
      return yield* new FactoryDeliveryError({ reason: "not-accepted" });
    if (!read.acceptance.baseBranch || read.acceptance.baseBranch !== origin.value.baseBranch)
      return yield* new FactoryDeliveryError({ reason: "missing-base-branch" });
    const live = yield* resolveRepository(input.projectId).pipe(
      Effect.mapError(() => new FactoryDeliveryError({ reason: "repository-changed" })),
    );
    if (
      live.repository.canonicalKey !== origin.value.repository.canonicalKey ||
      live.repository.host !== origin.value.repository.host ||
      live.repository.provider !== origin.value.repository.provider
    )
      return yield* new FactoryDeliveryError({ reason: "repository-changed" });
    return {
      origin: origin.value,
      acceptance: read.acceptance,
      current: read.current,
      liveHeadSha: read.liveHeadSha,
    };
  });

  // The pull request a merge acts on is the one this origin's confirmed publish created, never one
  // the caller names.
  const publishedPullRequest = Effect.fn("FactoryDeliveryService.publishedPullRequest")(function* (
    originKey: FactoryOriginKey,
  ) {
    const published = yield* store.getLive(originKey, "publish-pr");
    if (
      Option.isNone(published) ||
      published.value.status !== "confirmed" ||
      published.value.remote === null
    )
      return yield* new FactoryDeliveryError({ reason: "not-published" });
    return published.value.remote;
  });

  const pullRequestRef = (
    projectId: PullRequestRef["projectId"],
    repository: FactoryRepository,
    number: number,
  ): PullRequestRef => ({
    projectId,
    repository: repository.repository,
    host: repository.host,
    number,
  });

  // `fresh` drops the shared one-minute read cache: a grant and a reconcile decide on the head as
  // it stands now, while prepare is advisory and may be served from it.
  const readPullRequest = Effect.fn("FactoryDeliveryService.readPullRequest")(function* (
    ref: PullRequestRef,
    options: { readonly fresh: boolean },
  ) {
    if (options.fresh) yield* pullRequests.invalidate({ reference: ref });
    return yield* pullRequests
      .detail(options.fresh ? { ...ref, allowStale: false } : ref)
      .pipe(Effect.mapError(persistenceFailure));
  });
  const observeArtifact = Effect.fn("FactoryDeliveryService.observeArtifact")(function* (
    input: FactoryDeliveryReadInput,
    attempt: string,
  ) {
    const launch = yield* knowledgeStore
      .getLaunchByThread(input.threadId)
      .pipe(Effect.mapError(persistenceFailure));
    if (Option.isNone(launch) || launch.value.intent.projectId !== input.projectId)
      return yield* new FactoryDeliveryError({ reason: "not-a-factory-task" });
    // Knowledge owns the realpath confinement and UTF-8 decoding. Delivery never reads the file
    // through a second path that could disagree with what was accepted.
    const seen = yield* knowledge
      .read({
        projectId: input.projectId,
        briefId: launch.value.intent.briefId,
      })
      .pipe(Effect.mapError(persistenceFailure));
    if (seen.acceptance === null || seen.acceptance.threadId !== input.threadId)
      return yield* new FactoryDeliveryError({ reason: "not-accepted" });
    if (seen.artifactIssue === "too-large")
      return yield* new FactoryDeliveryError({ reason: "artifact-too-large" });
    if (seen.artifact === null)
      return yield* new FactoryDeliveryError({ reason: "artifact-changed" });
    if (!seen.current) return yield* new FactoryDeliveryError({ reason: "artifact-changed" });
    if (seen.artifact.bytes > FACTORY_KNOWLEDGE_ARTIFACT_PREVIEW_MAX_BYTES)
      return yield* new FactoryDeliveryError({ reason: "artifact-too-large" });
    if (seen.artifact.preview === null)
      return yield* new FactoryDeliveryError({ reason: "artifact-not-text" });
    const rendered = {
      briefTitle: seen.brief.title,
      deliverablePath: seen.artifact.path,
      text: seen.artifact.preview,
      artifactSha256: seen.artifact.sha256,
      acceptanceId: seen.acceptance.id,
      attempt,
    };
    const body = renderArtifactComment(rendered);
    if (body === null) return yield* new FactoryDeliveryError({ reason: "artifact-too-large" });
    return {
      acceptance: seen.acceptance,
      originKey: knowledgeBriefOriginKey(seen.brief.id),
      briefId: seen.brief.id,
      artifact: seen.artifact,
      body,
    };
  });

  const artifactDestination = Effect.fn("FactoryDeliveryService.artifactDestination")(function* (
    input: FactoryDeliveryReadInput,
    issueNumber: number,
  ) {
    const resolved = yield* resolveRepository(input.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new FactoryDeliveryError({
            reason:
              cause.reason === "unsupported-provider"
                ? "capability-unsupported"
                : "persistence-failure",
            cause,
          }),
      ),
    );
    const { tracker, repository, project } = resolved;
    if (
      !tracker.capabilities.issueComment ||
      tracker.commentOnIssue === undefined ||
      tracker.listIssueComments === undefined
    )
      return yield* new FactoryDeliveryError({ reason: "capability-unsupported" });
    const issue = yield* tracker
      .getIssue({
        cwd: project.workspaceRoot,
        host: repository.host,
        repository: repository.repository,
        number: issueNumber,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new FactoryDeliveryError({
              reason:
                cause.reason === "not-found" || cause.reason === "not-an-issue"
                  ? "destination-not-found"
                  : "persistence-failure",
              cause,
            }),
        ),
      );
    return {
      repository,
      destination: { number: issue.number, title: issue.title, state: issue.state, url: issue.url },
      destinationKey: `comment:${issueOriginKey(repository.provider, repository.canonicalKey, issueNumber)}`,
    };
  });

  const artifactDigest = (
    destinationKey: string,
    seen: Effect.Success<ReturnType<typeof observeArtifact>>,
  ) =>
    NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify([
          "publish-artifact",
          destinationKey,
          seen.acceptance.id,
          seen.artifact.sha256,
          seen.body,
        ]),
        "utf8",
      )
      .digest("hex");

  const grantArtifact = Effect.fn("FactoryDeliveryService.grantArtifact")(function* (
    input: FactoryArtifactDeliveryGrantInput,
  ) {
    const destination = yield* artifactDestination(input, input.payload.issueNumber);
    const validate = Effect.gen(function* () {
      const seen = yield* observeArtifact(input, input.attempt);
      if (seen.artifact.sha256 !== input.expectedArtifactSha256)
        return yield* new FactoryDeliveryError({ reason: "artifact-changed" });
      const payloadDigest = artifactDigest(destination.destinationKey, seen);
      if (payloadDigest !== input.expectedPayloadDigest)
        return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      return { ...seen, payloadDigest };
    });
    const seen = yield* validate;
    const at = yield* nowIso;
    const intent: FactoryArtifactDeliveryIntent = {
      // The primary key consumes a prepared attempt even when its delivery later fails.
      id: `delivery:artifact:${input.attempt}`,
      originKey: seen.originKey,
      threadId: input.threadId,
      projectId: input.projectId,
      kind: "publish-artifact",
      acceptanceId: seen.acceptance.id,
      briefId: seen.briefId,
      artifactPath: seen.artifact.path,
      artifactSha256: seen.artifact.sha256,
      artifactBytes: seen.artifact.bytes,
      repository: destination.repository,
      destinationKey: destination.destinationKey,
      payload: input.payload,
      body: seen.body,
      payloadDigest: seen.payloadDigest,
      grantedBy: yield* environment.getEnvironmentId,
      grantedAt: at,
      requestCommandId: input.commandId,
      status: "pending",
      remote: null,
      failure: null,
      updatedAt: at,
    };
    const granted = yield* store.grant(intent, {
      recheck: Effect.asVoid(validate),
      enqueue: outbox
        .enqueue([
          {
            id: `${intent.id}:execute`,
            commandId: CommandId.make(input.commandId),
            threadId: input.threadId,
            request: { type: "factory.delivery.execute", intentId: intent.id },
          },
        ])
        .pipe(Effect.mapError(persistenceFailure)),
    });
    if (granted.created) yield* outbox.notifyAvailable(1);
    return granted.intent;
  });

  const prepare = Effect.fn("FactoryDeliveryService.prepare")(function* (
    input: FactoryDeliveryPrepareInput,
  ) {
    if (input.kind === "publish-artifact") {
      if (!("issueNumber" in input.payload))
        return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      const attempt = yield* random.uuidV4();
      const seen = yield* observeArtifact(input, attempt);
      const destination = yield* artifactDestination(input, input.payload.issueNumber);
      return {
        attempt,
        acceptance: seen.acceptance,
        current: true,
        ...destination,
        artifactSha256: seen.artifact.sha256,
        artifactBytes: seen.artifact.bytes,
        body: seen.body,
        payload: input.payload,
        payloadDigest: artifactDigest(destination.destinationKey, seen),
        existing: Option.getOrNull(
          yield* store.getLiveArtifact(seen.originKey, destination.destinationKey),
        ),
      };
    }
    const target = targetOf(input);
    if (target === null) return yield* new FactoryDeliveryError({ reason: "payload-changed" });
    const seen = yield* observe(input);
    if (!seen.current) return yield* new FactoryDeliveryError({ reason: "acceptance-stale" });
    const existing = yield* store.getLive(seen.origin.originKey, input.kind);
    const common = {
      acceptance: seen.acceptance,
      current: true,
      repository: seen.origin.repository,
      baseRef: seen.acceptance.baseRef,
      baseBranch: seen.acceptance.baseBranch ?? null,
      headSha: seen.acceptance.headSha,
      existing: Option.getOrNull(existing),
    };
    if (target.kind === "publish-pr")
      return {
        ...common,
        payload: target.payload,
        payloadDigest: deliveryPayloadDigest({
          kind: target.kind,
          repository: seen.origin.repository,
          baseRef: seen.acceptance.baseRef,
          baseBranch: seen.acceptance.baseBranch ?? null,
          baseSha: seen.acceptance.baseSha,
          headSha: seen.acceptance.headSha,
          payload: target.payload,
        }),
        pullRequest: null,
      };
    const remote = yield* publishedPullRequest(seen.origin.originKey);
    const detail = yield* readPullRequest(
      pullRequestRef(input.projectId, seen.origin.repository, remote.number),
      { fresh: false },
    );
    return {
      ...common,
      payload: target.payload,
      payloadDigest: deliveryPayloadDigest({
        kind: target.kind,
        repository: seen.origin.repository,
        baseRef: seen.acceptance.baseRef,
        baseBranch: seen.acceptance.baseBranch ?? null,
        baseSha: seen.acceptance.baseSha,
        headSha: seen.acceptance.headSha,
        payload: target.payload,
        pullRequestNumber: remote.number,
      }),
      pullRequest: summarizePullRequest(detail),
    };
  });

  const grant = Effect.fn("FactoryDeliveryService.grant")(function* (
    input: FactoryDeliveryGrantInput,
  ) {
    // A repeated grant is answered from the stored intent even after the head has moved on.
    const replay = yield* store.getByCommand(input.commandId);
    if (Option.isSome(replay)) {
      if (
        replay.value.threadId !== input.threadId ||
        replay.value.projectId !== input.projectId ||
        replay.value.kind !== input.kind
      )
        return yield* new FactoryDeliveryError({ reason: "intent-not-found" });
      if (replay.value.payloadDigest !== input.expectedPayloadDigest)
        return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      if (input.kind !== "publish-artifact" && replay.value.kind !== "publish-artifact") {
        if (input.expectedHeadSha !== replay.value.headSha)
          return yield* new FactoryDeliveryError({ reason: "head-moved" });
        const target = targetOf(input);
        const stored = targetOf(replay.value);
        if (
          target === null ||
          stored === null ||
          (target.kind === "publish-pr" && stored.kind === "publish-pr"
            ? target.payload.title !== stored.payload.title ||
              target.payload.body !== stored.payload.body ||
              target.payload.draft !== stored.payload.draft
            : target.kind === "merge-pr" && stored.kind === "merge-pr"
              ? target.payload.mergeMethod !== stored.payload.mergeMethod
              : true)
        )
          return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      }
      return replay.value;
    }
    if (input.kind === "publish-artifact") return yield* grantArtifact(input);
    const target = targetOf(input);
    if (target === null) return yield* new FactoryDeliveryError({ reason: "payload-changed" });
    // The host is read once, before the transaction: a network call must not hold the database
    // write lock. The transactional recheck below re-derives everything local against this read,
    // and the host pins the merge itself to the accepted head when it runs.
    const pullRequest =
      target.kind === "merge-pr"
        ? yield* Effect.gen(function* () {
            const seen = yield* observe(input);
            const remote = yield* publishedPullRequest(seen.origin.originKey);
            return {
              number: remote.number,
              detail: yield* readPullRequest(
                pullRequestRef(input.projectId, seen.origin.repository, remote.number),
                { fresh: true },
              ),
            };
          })
        : null;
    // Re-run under the grant transaction, so a head that moves between the check and the insert
    // is still refused.
    const validate = Effect.gen(function* () {
      const seen = yield* observe(input);
      const headSha = seen.acceptance.headSha;
      if (!seen.current || seen.liveHeadSha !== headSha || headSha !== input.expectedHeadSha)
        return yield* new FactoryDeliveryError({ reason: "head-moved" });
      const common = {
        repository: seen.origin.repository,
        baseRef: seen.acceptance.baseRef,
        baseBranch: seen.acceptance.baseBranch ?? null,
        baseSha: seen.acceptance.baseSha,
        headSha,
      };
      if (target.kind === "publish-pr") {
        const payloadDigest = deliveryPayloadDigest({
          ...common,
          kind: target.kind,
          payload: target.payload,
        });
        if (payloadDigest !== input.expectedPayloadDigest)
          return yield* new FactoryDeliveryError({ reason: "payload-changed" });
        return { ...seen, payloadDigest, remote: null };
      }
      const published = yield* publishedPullRequest(seen.origin.originKey);
      if (pullRequest === null || pullRequest.number !== published.number)
        return yield* new FactoryDeliveryError({ reason: "not-published" });
      const { detail } = pullRequest;
      if (detail.baseBranch !== seen.acceptance.baseBranch)
        return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      if (detail.state === "merged")
        return yield* new FactoryDeliveryError({ reason: "already-merged" });
      if (detail.headSha !== headSha)
        return yield* new FactoryDeliveryError({ reason: "pull-request-head-moved" });
      // Branch protection stays the host's call; only what it already reports as unmergeable is
      // refused here, so a person is not asked to grant a merge that cannot run.
      if (detail.state !== "open" || detail.isDraft || detail.mergeability === "conflicting")
        return yield* new FactoryDeliveryError({ reason: "not-mergeable" });
      const payloadDigest = deliveryPayloadDigest({
        ...common,
        kind: target.kind,
        payload: target.payload,
        pullRequestNumber: published.number,
      });
      if (payloadDigest !== input.expectedPayloadDigest)
        return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      return {
        ...seen,
        payloadDigest,
        remote: { number: detail.number, url: detail.url },
      };
    });
    const validated = yield* validate;
    const at = yield* nowIso;
    const intent: FactoryDeliveryIntent = {
      id: `delivery:${yield* random.uuidV4()}`,
      originKey: validated.origin.originKey,
      threadId: input.threadId,
      projectId: input.projectId,
      kind: input.kind,
      acceptanceId: validated.acceptance.id,
      repository: validated.origin.repository,
      baseRef: validated.acceptance.baseRef,
      baseBranch: validated.acceptance.baseBranch ?? null,
      baseSha: validated.acceptance.baseSha,
      headSha: validated.acceptance.headSha,
      payload: target.payload,
      payloadDigest: validated.payloadDigest,
      grantedBy: yield* environment.getEnvironmentId,
      grantedAt: at,
      requestCommandId: input.commandId,
      status: "pending",
      remote: validated.remote,
      failure: null,
      updatedAt: at,
    };
    const granted = yield* store.grant(intent, {
      recheck: Effect.asVoid(validate),
      enqueue: outbox
        .enqueue([
          {
            id: `${intent.id}:execute`,
            commandId: CommandId.make(input.commandId),
            threadId: input.threadId,
            request: { type: "factory.delivery.execute", intentId: intent.id },
          },
        ])
        .pipe(Effect.mapError(persistenceFailure)),
    });
    // The effect row is committed with the intent; wake the worker only once that commit is out.
    if (granted.created) yield* outbox.notifyAvailable(1);
    return granted.intent;
  });

  const revParse = (cwd: string, revision: string) =>
    git
      .execute({
        operation: "FactoryDeliveryService.revParse",
        cwd,
        args: ["rev-parse", "--verify", `${revision}^{commit}`],
        allowNonZeroExit: true,
        maxOutputBytes: 4096,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
        Effect.orElseSucceed(() => null),
      );

  // A commit delivery works from the project's own repository: the accepted commit is pushed by
  // its id, so where it was made no longer matters.
  const commitDestination = Effect.fn("FactoryDeliveryService.commitDestination")(function* (
    projectId: ProjectId,
    kind: FactoryDeliveryCommitKind,
  ) {
    const resolved = yield* resolveRepository(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new FactoryDeliveryError({
            reason:
              cause.reason === "unsupported-provider"
                ? "capability-unsupported"
                : "repository-changed",
            cause,
          }),
      ),
    );
    const { capabilities } = resolved.tracker;
    if (!capabilities.publish || (kind === "merge-pr" && !capabilities.headPinnedMerge))
      return yield* new FactoryDeliveryError({ reason: "capability-unsupported" });
    return resolved;
  });

  const grantCommit = Effect.fn("FactoryDeliveryService.grantCommit")(function* (
    input: FactoryCommitGrant,
  ) {
    const replay = yield* store.getByCommand(input.commandId);
    if (Option.isSome(replay)) {
      const stored = replay.value;
      if (
        stored.kind === "publish-artifact" ||
        stored.kind !== input.kind ||
        stored.originKey !== input.originKey
      )
        return yield* new FactoryDeliveryError({ reason: "intent-not-found" });
      return stored;
    }
    const destination = yield* commitDestination(input.projectId, input.kind);
    const cwd = destination.project.workspaceRoot;
    if ((yield* revParse(cwd, input.headSha)) !== input.headSha)
      return yield* new FactoryDeliveryError({ reason: "worktree-unavailable" });
    const target = yield* Effect.gen(function* () {
      if (input.kind === "publish-pr") {
        const baseBranch = yield* git
          .resolveDefaultBranchName(cwd, "origin")
          .pipe(Effect.orElseSucceed(() => null));
        if (!baseBranch) return yield* new FactoryDeliveryError({ reason: "missing-base-branch" });
        const baseRef = `refs/remotes/origin/${baseBranch}`;
        const baseSha = yield* revParse(cwd, baseRef);
        if (baseSha === null)
          return yield* new FactoryDeliveryError({ reason: "missing-base-branch" });
        const comparisonBase = input.baseRef === null ? null : yield* revParse(cwd, input.baseRef);
        if (comparisonBase === null)
          return yield* new FactoryDeliveryError({ reason: "worktree-unavailable" });
        const commits = yield* git
          .execute({
            operation: "FactoryDeliveryService.countUnreviewedBaseCommits",
            cwd,
            args: ["rev-list", "--count", `${baseSha}..${comparisonBase}`, "--"],
            maxOutputBytes: 4096,
          })
          .pipe(
            Effect.mapError(
              (cause) => new FactoryDeliveryError({ reason: "worktree-unavailable", cause }),
            ),
          );
        const count = Number(commits.stdout.trim());
        if (
          commits.exitCode !== 0 ||
          commits.stdoutTruncated ||
          !/^\d+$/.test(commits.stdout.trim()) ||
          !Number.isSafeInteger(count)
        )
          return yield* new FactoryDeliveryError({ reason: "worktree-unavailable" });
        if (count > 0)
          return yield* new FactoryDeliveryError({
            reason: "unreviewed-base-commits",
            extraCommitCount: count,
          });
        const previous = (yield* store.listByThread(input.threadId)).find(
          (intent) =>
            intent.kind === "publish-pr" &&
            intent.originKey === input.originKey &&
            intent.headSha === input.headSha &&
            intent.repository.canonicalKey === destination.repository.canonicalKey &&
            intent.repository.host === destination.repository.host &&
            intent.repository.provider === destination.repository.provider &&
            "headBranch" in intent.payload &&
            intent.payload.headBranch !== undefined,
        );
        const { repository } = destination;
        const issue = input.publish.closes;
        // Canonical keys are `hostname/path`; `repository.host` can also carry an HTTPS port.
        const hostPrefix = repository.canonicalKey.slice(
          0,
          repository.canonicalKey.indexOf("/") + 1,
        );
        const closing =
          issue === null ||
          issue.provider !== repository.provider ||
          (repository.provider !== "github" && repository.provider !== "gitlab") ||
          !issue.canonicalKey.toLowerCase().startsWith(hostPrefix.toLowerCase())
            ? null
            : issue.canonicalKey.toLowerCase() === repository.canonicalKey.toLowerCase()
              ? `Closes #${issue.number}`
              : `Closes ${issue.canonicalKey.slice(hostPrefix.length)}#${issue.number}`;
        const payload: FactoryDeliveryPublishPayload = {
          title: input.publish.title,
          body: closing === null ? input.publish.body : `${closing}\n\n${input.publish.body}`,
          draft: false,
          headBranch:
            (previous && "headBranch" in previous.payload
              ? previous.payload.headBranch
              : undefined) ?? input.publish.headBranch,
        };
        const common = {
          repository: destination.repository,
          baseRef,
          baseBranch,
          baseSha,
          headSha: input.headSha,
        };
        return {
          ...common,
          payload,
          payloadDigest: deliveryPayloadDigest({ ...common, kind: "publish-pr", payload }),
          remote: null,
        };
      }
      // A merge acts on the pull request this revision's confirmed publish opened, at its base.
      const published = yield* store.getLive(input.originKey, "publish-pr");
      if (
        Option.isNone(published) ||
        published.value.status !== "confirmed" ||
        published.value.remote === null
      )
        return yield* new FactoryDeliveryError({ reason: "not-published" });
      const { repository, baseRef, baseSha, remote } = published.value;
      const baseBranch = published.value.baseBranch ?? null;
      if (
        repository.canonicalKey !== destination.repository.canonicalKey ||
        repository.host !== destination.repository.host ||
        repository.provider !== destination.repository.provider
      )
        return yield* new FactoryDeliveryError({ reason: "repository-changed" });
      const detail = yield* readPullRequest(
        pullRequestRef(input.projectId, repository, remote.number),
        { fresh: true },
      );
      if (detail.baseBranch !== baseBranch)
        return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      if (detail.state === "merged")
        return yield* new FactoryDeliveryError({ reason: "already-merged" });
      if (detail.headSha !== input.headSha)
        return yield* new FactoryDeliveryError({ reason: "pull-request-head-moved" });
      const mergeMethod = allowedMergeMethod(detail);
      if (
        detail.state !== "open" ||
        detail.isDraft ||
        detail.mergeability === "conflicting" ||
        mergeMethod === null
      )
        return yield* new FactoryDeliveryError({ reason: "not-mergeable" });
      const payload: FactoryDeliveryMergePayload = { mergeMethod };
      const common = { repository, baseRef, baseBranch, baseSha, headSha: input.headSha };
      return {
        ...common,
        payload,
        payloadDigest: deliveryPayloadDigest({
          ...common,
          kind: "merge-pr",
          payload,
          pullRequestNumber: remote.number,
        }),
        remote: { number: detail.number, url: detail.url },
      };
    });
    const at = yield* nowIso;
    const intent: FactoryCommitDeliveryIntent = {
      id: `delivery:${yield* random.uuidV4()}`,
      originKey: input.originKey,
      threadId: input.threadId,
      projectId: input.projectId,
      kind: input.kind,
      acceptanceId: input.acceptanceId,
      repository: target.repository,
      baseRef: target.baseRef,
      baseBranch: target.baseBranch,
      baseSha: target.baseSha,
      headSha: target.headSha,
      payload: target.payload,
      payloadDigest: target.payloadDigest,
      grantedBy: yield* environment.getEnvironmentId,
      grantedAt: at,
      requestCommandId: input.commandId,
      status: "pending",
      remote: target.remote,
      failure: null,
      updatedAt: at,
    };
    const granted = yield* store.grant(intent, {
      recheck: input.recheck,
      enqueue: outbox
        .enqueue([
          {
            id: `${intent.id}:execute`,
            commandId: CommandId.make(input.commandId),
            threadId: input.threadId,
            request: { type: "factory.delivery.execute", intentId: intent.id },
          },
        ])
        .pipe(Effect.mapError(persistenceFailure)),
    });
    if (granted.created) yield* outbox.notifyAvailable(1);
    if (granted.intent.kind === "publish-artifact")
      return yield* new FactoryDeliveryError({ reason: "intent-not-found" });
    return granted.intent;
  });

  const read = Effect.fn("FactoryDeliveryService.read")(function* (
    input: FactoryDeliveryReadInput,
  ) {
    const shell = yield* threads
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(persistenceFailure));
    if (shell === null || shell.projectId !== input.projectId)
      return yield* new FactoryDeliveryError({ reason: "unknown-thread" });
    const intents = yield* store.listByThread(input.threadId);
    return { intents: intents.filter((intent) => intent.projectId === input.projectId) };
  });

  const settle = Effect.fn("FactoryDeliveryService.settle")(function* (
    intent: FactoryDeliveryIntent,
    status: "failed" | "unknown",
    failure: string,
  ) {
    yield* store.settle(intent.id, {
      status,
      failure: failure.slice(0, FAILURE_MAX_CHARS),
      updatedAt: yield* nowIso,
    });
  });

  // The forge call already succeeded, so a link that cannot be made is logged and dropped. The
  // command id is derived from the intent, so a retried link replays instead of duplicating.
  const linkPullRequest = Effect.fn("FactoryDeliveryService.linkPullRequest")(
    function* (intent: FactoryCommitDeliveryIntent, remote: { readonly url: string }) {
      const key = sourceControlDefinitions.parseChangeRequestUrl(remote.url)?.link ?? null;
      if (key === null) return;
      yield* threads
        .dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`${intent.id}:link-pull-request`),
          threadId: intent.threadId,
          ...key,
          url: remote.url,
          source: "created",
        })
        .pipe(Effect.asVoid);
    },
    (effect, intent) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.logWarning("failed to link delivered pull request to thread", {
                threadId: intent.threadId,
              }),
        ),
      ),
  );

  const confirm = Effect.fn("FactoryDeliveryService.confirm")(function* (
    intent: FactoryCommitDeliveryIntent,
    remote: { readonly number: number; readonly url: string },
    mismatchStatus: "failed" | "unknown" = "failed",
  ) {
    const detail = yield* Effect.result(
      readPullRequest(pullRequestRef(intent.projectId, intent.repository, remote.number), {
        fresh: true,
      }),
    );
    const status =
      detail._tag === "Failure"
        ? "unknown"
        : !intent.baseBranch ||
            detail.success.baseBranch !== intent.baseBranch ||
            detail.success.headSha !== intent.headSha
          ? mismatchStatus
          : "confirmed";
    const settled = yield* store.settle(intent.id, {
      status,
      remote: {
        ...remote,
        ...(status === "confirmed" && detail._tag === "Success" && detail.success.state === "merged"
          ? { merged: true as const }
          : {}),
      },
      failure:
        status === "unknown"
          ? "could not verify pull request destination"
          : status === "failed"
            ? "pull-request-target-mismatch"
            : null,
      updatedAt: yield* nowIso,
    });
    if (Option.isSome(settled) && settled.value.status === "confirmed")
      yield* linkPullRequest(intent, remote);
    return Option.getOrElse(settled, () => intent);
  });

  const worktreeOf = (shell: {
    readonly deletedAt: unknown;
    readonly worktreePath: string | null;
  }) => (shell.deletedAt === null ? shell.worktreePath : null);

  const providerContext = (intent: FactoryCommitDeliveryIntent) => ({
    provider: {
      kind: intent.repository.provider,
      name: intent.repository.provider,
      baseUrl: `https://${intent.repository.host}`,
    },
    remoteName: "origin",
    remoteUrl: intent.repository.url,
  });

  // A pull request is this publication's only when every pinned part of the intent matches it.
  const matchesPublication = (
    intent: FactoryCommitDeliveryIntent,
    candidate: {
      readonly provider: string;
      readonly number: number;
      readonly url: string;
      readonly headSha?: string | null | undefined;
      readonly baseRefName: string;
    },
  ) => {
    const parsed = sourceControlDefinitions.parseChangeRequestUrl(candidate.url);
    return (
      candidate.provider === intent.repository.provider &&
      candidate.headSha === intent.headSha &&
      candidate.baseRefName === intent.baseBranch &&
      parsed?.definition.kind === intent.repository.provider &&
      parsed.link.number === candidate.number &&
      parsed.link.host === intent.repository.host &&
      sourceControlDefinitions.canonicalRepositoryKey(
        `${parsed.link.host}/${parsed.link.repository}`,
      ) === intent.repository.canonicalKey
    );
  };

  // A task result's publish: the accepted commit is pushed by its id to a new branch from the
  // project's repository, then the pull request is opened from that branch.
  const sendBranch = Effect.fn("FactoryDeliveryService.sendBranch")(function* (
    intent: FactoryCommitDeliveryIntent,
    payload: FactoryDeliveryPublishPayload,
    headBranch: string,
  ) {
    const fail = (failure: string) => settle(intent, "failed", failure);
    if (!intent.baseBranch) return yield* fail("missing-base-branch");
    const baseBranch = intent.baseBranch;
    const destination = yield* Effect.result(resolveRepository(intent.projectId));
    if (
      destination._tag === "Failure" ||
      destination.success.repository.canonicalKey !== intent.repository.canonicalKey ||
      destination.success.repository.host !== intent.repository.host ||
      destination.success.repository.provider !== intent.repository.provider
    )
      return yield* fail("repository-changed");
    const cwd = destination.success.project.workspaceRoot;
    const [owner, repository, ...rest] = intent.repository.repository.split("/");
    if (!owner || !repository || rest.length > 0) return yield* fail("repository-changed");
    const context = providerContext(intent);
    const resolved = yield* Effect.result(providers.resolveHandle({ cwd, context }));
    if (resolved._tag === "Failure")
      return yield* fail(describe("no source control provider", resolved.failure));
    const { provider } = resolved.success;
    if (provider.kind !== intent.repository.provider) return yield* fail("repository-changed");
    if (
      provider.createsChangeRequestsIn &&
      !(yield* provider.createsChangeRequestsIn({
        cwd,
        context,
        repository: intent.repository.repository,
      }))
    )
      return yield* fail("repository-changed");
    // Suspended: the lookup runs once before the push and again after the create.
    const findOpen = Effect.suspend(() =>
      provider.listChangeRequests({
        cwd,
        context,
        headSelector: headBranch,
        state: "open",
        limit: PUBLICATION_LOOKUP_LIMIT,
      }),
    );
    // An earlier attempt for the same branch and commit may already have opened it.
    const before = yield* Effect.result(findOpen);
    if (before._tag === "Failure")
      return yield* fail(describe("could not read pull requests", before.failure));
    if (before.success.length >= PUBLICATION_LOOKUP_LIMIT)
      return yield* fail("The branch's pull requests could not be fully checked.");
    if (before.success.some((candidate) => !matchesPublication(intent, candidate)))
      return yield* fail("The branch is already used by another pull request.");
    if (before.success[0] !== undefined) {
      yield* confirm(intent, before.success[0]);
      return;
    }
    const branchRef = `refs/heads/${headBranch}`;
    const remote = yield* Effect.result(
      git.execute({
        operation: "FactoryDeliveryService.readPublicationBranch",
        cwd,
        args: ["ls-remote", "--heads", "--", "origin", branchRef],
        timeoutMs: REMOTE_READ_TIMEOUT_MS,
        maxOutputBytes: 4096,
      }),
    );
    if (remote._tag === "Failure")
      return yield* fail(describe("could not read the publication branch", remote.failure));
    if (remote.success.exitCode !== 0 || remote.success.stdoutTruncated)
      return yield* fail("The publication branch could not be checked.");
    const remoteHead = remote.success.stdout.trim();
    if (remoteHead !== "" && remoteHead !== `${intent.headSha}\t${branchRef}`)
      return yield* fail("The publication branch already points at a different commit.");
    if (remoteHead === "") {
      const pushed = yield* Effect.result(
        git.execute({
          operation: "FactoryDeliveryService.pushCommit",
          cwd,
          // An empty lease creates the branch only if it is still absent at the remote.
          args: [
            "push",
            `--force-with-lease=${branchRef}:`,
            "--",
            "origin",
            `${intent.headSha}:${branchRef}`,
          ],
          timeoutMs: PUSH_TIMEOUT_MS,
        }),
      );
      if (pushed._tag === "Failure") return yield* fail(describe("push failed", pushed.failure));
      if (pushed.success.exitCode !== 0) return yield* fail("The publication branch push failed.");
    }
    const bodyFile = path.join(tempDir, `t3code-delivery-body-${yield* random.uuidV4()}.md`);
    const written = yield* Effect.result(fileSystem.writeFileString(bodyFile, payload.body));
    if (written._tag === "Failure")
      return yield* fail(describe("could not write the pull request body", written.failure));
    // From here the request may reach the forge: only a definite rejection proves it did not.
    const created = yield* Effect.result(
      provider
        .createChangeRequest({
          cwd,
          context,
          target: { owner, repository, refName: baseBranch },
          baseRefName: baseBranch,
          headSelector: headBranch,
          title: payload.title,
          bodyFile,
          draft: payload.draft,
        })
        .pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.ignore))),
    );
    if (created._tag === "Failure")
      return isDefiniteRejection(created.failure)
        ? yield* fail(describe("pull request rejected", created.failure))
        : yield* settle(intent, "unknown", describe("response lost", created.failure));
    const after = yield* Effect.result(findOpen);
    const opened =
      after._tag === "Success"
        ? after.success.find((candidate) => matchesPublication(intent, candidate))
        : undefined;
    if (opened !== undefined) {
      yield* confirm(intent, opened);
      return;
    }
    yield* settle(intent, "unknown", "created, but the pull request could not be read back");
  });

  // Business outcomes settle the intent and return normally; only infrastructure errors escape.
  const send = Effect.fn("FactoryDeliveryService.send")(function* (
    intent: FactoryCommitDeliveryIntent,
  ) {
    const fail = (failure: string) => settle(intent, "failed", failure);
    const { payload } = intent;
    if (isMergePayload(payload)) return yield* fail("payload does not match the delivery kind");
    if (payload.headBranch !== undefined)
      return yield* sendBranch(intent, payload, payload.headBranch);
    if (!intent.baseBranch) return yield* fail("missing-base-branch");
    const shell = yield* threads
      .getThreadShell(intent.threadId)
      .pipe(Effect.mapError(persistenceFailure));
    const worktree = shell === null ? null : worktreeOf(shell);
    if (worktree === null) return yield* fail("worktree-unavailable");
    const destination = yield* Effect.result(resolveRepository(intent.projectId, worktree));
    if (
      destination._tag === "Failure" ||
      destination.success.repository.canonicalKey !== intent.repository.canonicalKey ||
      destination.success.repository.host !== intent.repository.host ||
      destination.success.repository.provider !== intent.repository.provider
    )
      return yield* fail("repository-changed");
    const observed = yield* Effect.result(
      acceptance.read({ projectId: intent.projectId, threadId: intent.threadId }),
    );
    if (observed._tag === "Failure") return yield* fail("worktree-unavailable");
    if (observed.success.liveHeadSha !== intent.headSha) return yield* fail("head-moved");
    const [owner, repository, ...rest] = intent.repository.repository.split("/");
    if (!owner || !repository || rest.length > 0) return yield* fail("repository-changed");

    const context = providerContext(intent);
    const provider = yield* Effect.result(providers.resolveHandle({ cwd: worktree, context }));
    if (provider._tag === "Failure")
      return yield* fail(describe("no source control provider", provider.failure));
    if (provider.success.provider.kind !== intent.repository.provider)
      return yield* fail("repository-changed");
    if (
      provider.success.provider.createsChangeRequestsIn &&
      !(yield* provider.success.provider.createsChangeRequestsIn({
        cwd: worktree,
        context,
        repository: intent.repository.repository,
      }))
    )
      return yield* fail("repository-changed");

    // Publishing sets the upstream, which the open-pull-request lookup needs to resolve the head.
    const pushed = yield* Effect.result(git.pushCurrentBranch(worktree, null));
    if (pushed._tag === "Failure") return yield* fail(describe("push failed", pushed.failure));
    yield* gitManager.invalidateStatus(worktree);

    // Reconcile first: a pull request for this head may already exist, and creating again would
    // fail or duplicate it.
    const before = yield* Effect.result(gitManager.findOpenPullRequestForHead(worktree));
    if (before._tag === "Failure")
      return yield* fail(describe("could not read pull requests", before.failure));
    if (Option.isSome(before.success.open)) {
      yield* confirm(intent, before.success.open.value);
      return;
    }

    const bodyFile = path.join(tempDir, `t3code-delivery-body-${yield* random.uuidV4()}.md`);
    const written = yield* Effect.result(fileSystem.writeFileString(bodyFile, payload.body));
    if (written._tag === "Failure")
      return yield* fail(describe("could not write the pull request body", written.failure));
    // From here the request may reach the forge: only a definite rejection proves it did not.
    const created = yield* Effect.result(
      provider.success.provider
        .createChangeRequest({
          cwd: worktree,
          context,
          target: { owner, repository, refName: intent.baseBranch },
          baseRefName: intent.baseBranch,
          headSelector: before.success.headSelector,
          title: payload.title,
          bodyFile,
          draft: payload.draft,
        })
        .pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.ignore))),
    );
    if (created._tag === "Failure") {
      yield* gitManager.invalidateStatus(worktree);
      return isDefiniteRejection(created.failure)
        ? yield* fail(describe("pull request rejected", created.failure))
        : yield* settle(intent, "unknown", describe("response lost", created.failure));
    }
    yield* gitManager.invalidateStatus(worktree);
    const after = yield* Effect.result(gitManager.findOpenPullRequestForHead(worktree));
    if (after._tag === "Success" && Option.isSome(after.success.open)) {
      yield* confirm(intent, after.success.open.value);
      return;
    }
    yield* settle(intent, "unknown", "created, but the pull request could not be read back");
  });

  // The pull request is already linked to the thread by its publish, so a merge only settles.
  const confirmMerged = Effect.fn("FactoryDeliveryService.confirmMerged")(function* (
    intent: FactoryCommitDeliveryIntent,
    remote: { readonly number: number; readonly url: string },
  ) {
    const settled = yield* store.settle(intent.id, {
      status: "confirmed",
      remote,
      failure: null,
      updatedAt: yield* nowIso,
    });
    return Option.getOrElse(settled, () => intent);
  });

  // A merge touches neither the worktree nor git: the host merges the pull request, pinned to the
  // head the grantor accepted, so a push since then is refused instead of merged.
  const sendMerge = Effect.fn("FactoryDeliveryService.sendMerge")(function* (
    intent: FactoryCommitDeliveryIntent,
  ) {
    const { remote, payload } = intent;
    if (remote === null || !isMergePayload(payload))
      return yield* settle(intent, "failed", "merge intent is missing its pull request");
    if (!intent.baseBranch) return yield* settle(intent, "failed", "missing-base-branch");
    const detail = yield* readPullRequest(
      pullRequestRef(intent.projectId, intent.repository, remote.number),
      { fresh: true },
    );
    if (detail.baseBranch !== intent.baseBranch)
      return yield* settle(intent, "failed", "pull-request-target-mismatch");
    const merged = yield* Effect.result(
      pullRequests.runAction({
        ...pullRequestRef(intent.projectId, intent.repository, remote.number),
        action: "merge",
        mergeMethod: payload.mergeMethod,
        expectedHeadSha: intent.headSha,
      }),
    );
    if (merged._tag === "Failure")
      return isDefiniteMergeRejection(merged.failure)
        ? yield* settle(intent, "failed", describe("merge rejected", merged.failure))
        : yield* settle(intent, "unknown", describe("response lost", merged.failure));
    yield* confirmMerged(intent, remote);
  });

  const reconcileMerge = Effect.fn("FactoryDeliveryService.reconcileMerge")(function* (
    intent: FactoryCommitDeliveryIntent,
  ) {
    if (intent.remote === null)
      return yield* new FactoryDeliveryError({ reason: "not-reconcilable" });
    const looked = yield* Effect.result(
      readPullRequest(pullRequestRef(intent.projectId, intent.repository, intent.remote.number), {
        fresh: true,
      }),
    );
    if (
      looked._tag === "Success" &&
      looked.success.state === "merged" &&
      intent.baseBranch &&
      looked.success.baseBranch === intent.baseBranch &&
      looked.success.headSha === intent.headSha
    )
      return yield* confirmMerged(intent, intent.remote);
    // A failed read proves nothing; an unmerged pull request releases the merge slot.
    const refreshed = yield* store.settle(intent.id, {
      status: looked._tag === "Failure" ? intent.status : "failed",
      failure: (looked._tag === "Failure"
        ? describe("could not read pull request", looked.failure)
        : looked.success.state === "merged"
          ? "pull-request-target-mismatch"
          : "pull request is not merged"
      ).slice(0, FAILURE_MAX_CHARS),
      updatedAt: yield* nowIso,
    });
    return Option.getOrElse(refreshed, () => intent);
  });
  const confirmArtifact = Effect.fn("FactoryDeliveryService.confirmArtifact")(function* (
    intent: FactoryArtifactDeliveryIntent,
    remote: FactoryArtifactDeliveryRemote,
  ) {
    const settled = yield* store.settle(intent.id, {
      status: "confirmed",
      remote,
      failure: null,
      updatedAt: yield* nowIso,
    });
    return Option.getOrElse(settled, () => intent);
  });

  const sendArtifact = Effect.fn("FactoryDeliveryService.sendArtifact")(function* (
    intent: FactoryArtifactDeliveryIntent,
  ) {
    const tracker = trackers.get(intent.repository.provider);
    if (!tracker?.capabilities.issueComment || tracker.commentOnIssue === undefined)
      return yield* settle(intent, "failed", "capability-unsupported");
    const project = yield* projects
      .getById(intent.projectId)
      .pipe(Effect.mapError(persistenceFailure));
    if (Option.isNone(project)) return yield* settle(intent, "failed", "project-unavailable");
    // The grant froze the bytes and destination. Neither a changed file nor a changed origin
    // may redirect an already-authorized send.
    const sent = yield* Effect.result(
      tracker.commentOnIssue({
        cwd: project.value.workspaceRoot,
        host: intent.repository.host,
        repository: intent.repository.repository,
        number: intent.payload.issueNumber,
        body: intent.body,
      }),
    );
    if (sent._tag === "Failure")
      return yield* settle(
        intent,
        isDefiniteRejection(sent.failure) ? "failed" : "unknown",
        describe("comment response", sent.failure),
      );
    yield* confirmArtifact(intent, { commentId: sent.success.id, url: sent.success.url });
  });

  const reconcileArtifact = Effect.fn("FactoryDeliveryService.reconcileArtifact")(function* (
    intent: FactoryArtifactDeliveryIntent,
  ) {
    const tracker = trackers.get(intent.repository.provider);
    if (!tracker?.capabilities.issueComment || tracker.listIssueComments === undefined)
      return intent;
    const project = yield* projects
      .getById(intent.projectId)
      .pipe(Effect.mapError(persistenceFailure));
    if (Option.isNone(project)) return intent;
    const settleReconciliation = Effect.fn("FactoryDeliveryService.settleArtifactReconciliation")(
      function* (status: FactoryArtifactDeliveryIntent["status"], failure: string) {
        const settled = yield* store.settle(intent.id, {
          status,
          failure: failure.slice(0, FAILURE_MAX_CHARS),
          updatedAt: yield* nowIso,
        });
        return Option.getOrElse(settled, () => intent);
      },
    );
    const firstPassIds: { page: number; ids: readonly number[] }[] = [];
    let lastCommentId = 0;
    let page = 1;
    while (true) {
      const listed = yield* Effect.result(
        tracker.listIssueComments({
          cwd: project.value.workspaceRoot,
          host: intent.repository.host,
          repository: intent.repository.repository,
          number: intent.payload.issueNumber,
          page,
        }),
      );
      if (listed._tag === "Failure")
        return yield* settleReconciliation(intent.status, listed.failure.message);
      const match = listed.success.comments.find((comment) =>
        carriesDeliveryMarker(comment.body, intent.body),
      );
      if (match !== undefined)
        return yield* confirmArtifact(intent, { commentId: match.id, url: match.url });
      if (
        (listed.success.comments.length === 0 && (page > 1 || listed.success.nextPage !== null)) ||
        (listed.success.nextPage !== null && listed.success.nextPage !== page + 1)
      )
        return yield* settleReconciliation(
          intent.status,
          "Comment listing did not advance cleanly; reconcile again.",
        );
      const ids = listed.success.comments.map((comment) => comment.id);
      // The offset walk assumes ascending creation order, including across page boundaries.
      for (const id of ids) {
        if (id <= lastCommentId)
          return yield* settleReconciliation(
            intent.status,
            "Comment listing did not advance cleanly; reconcile again.",
          );
        lastCommentId = id;
      }
      firstPassIds.push({ page, ids });
      if (listed.success.nextPage === null) break;
      page = listed.success.nextPage;
    }
    // Deletions can shift a comment into a page already read. A single response needs no
    // verification; a multi-page absence is conclusive only while its prefix stays stable.
    for (const previous of firstPassIds.slice(0, -1)) {
      const reread = yield* Effect.result(
        tracker.listIssueComments({
          cwd: project.value.workspaceRoot,
          host: intent.repository.host,
          repository: intent.repository.repository,
          number: intent.payload.issueNumber,
          page: previous.page,
        }),
      );
      if (reread._tag === "Failure")
        return yield* settleReconciliation(intent.status, reread.failure.message);
      const match = reread.success.comments.find((comment) =>
        carriesDeliveryMarker(comment.body, intent.body),
      );
      if (match !== undefined)
        return yield* confirmArtifact(intent, { commentId: match.id, url: match.url });
      const ids = reread.success.comments.map((comment) => comment.id);
      if (
        reread.success.nextPage !== previous.page + 1 ||
        ids.length !== previous.ids.length ||
        ids.some((id, index) => id !== previous.ids[index])
      )
        return yield* settleReconciliation(
          intent.status,
          "Comment listing changed during reconciliation; reconcile again.",
        );
    }
    return yield* settleReconciliation("failed", "no matching artifact comment found");
  });

  const execute = Effect.fn("FactoryDeliveryService.execute")(function* (intentId: string) {
    const found = yield* store.get(intentId);
    if (Option.isNone(found)) return;
    const intent = found.value;
    if (intent.status === "sending") {
      yield* settle(intent, "unknown", "response lost");
      return;
    }
    if (intent.status !== "pending") return;
    if (!(yield* store.markSending(intent.id, yield* nowIso))) return;
    yield* intent.kind === "publish-artifact"
      ? sendArtifact(intent)
      : intent.kind === "merge-pr"
        ? sendMerge(intent)
        : send(intent);
  });

  const reconcile = Effect.fn("FactoryDeliveryService.reconcile")(function* (
    input: FactoryDeliveryReconcileInput,
  ) {
    const found = yield* store.getInProject(input.projectId, input.intentId);
    if (Option.isNone(found))
      return yield* new FactoryDeliveryError({ reason: "intent-not-found" });
    const intent = found.value;
    if (intent.kind === "publish-pr" && intent.status === "confirmed" && intent.remote !== null) {
      if (intent.remote.merged) return intent;
      const observed = yield* readPullRequest(
        pullRequestRef(intent.projectId, intent.repository, intent.remote.number),
        { fresh: true },
      ).pipe(Effect.result);
      // Commits pushed after Publish do not undo the host's merge; only Merge is pinned to the head.
      if (
        observed._tag === "Success" &&
        observed.success.state === "merged" &&
        intent.baseBranch &&
        observed.success.baseBranch === intent.baseBranch
      )
        return Option.getOrElse(
          yield* store.recordObservedMerge(intent.id, yield* nowIso),
          () => intent,
        );
      return intent;
    }
    if (intent.status !== "unknown" && intent.status !== "failed")
      return yield* new FactoryDeliveryError({ reason: "not-reconcilable" });
    if (intent.kind === "publish-artifact") return yield* reconcileArtifact(intent);
    if (intent.status === "failed") {
      const live = yield* store.getLive(intent.originKey, intent.kind);
      if (Option.isSome(live) && live.value.id !== intent.id)
        return yield* new FactoryDeliveryError({
          reason: "not-reconcilable",
          replacementDeliveryId: live.value.id,
        });
    }
    if (intent.kind === "merge-pr") return yield* reconcileMerge(intent);
    // A branch publish was pushed from the project's repository; a worktree publish from its own.
    const headBranch = isMergePayload(intent.payload) ? undefined : intent.payload.headBranch;
    const cwd =
      headBranch === undefined
        ? yield* Effect.gen(function* () {
            const shell = yield* threads
              .getThreadShell(intent.threadId)
              .pipe(Effect.mapError(persistenceFailure));
            const worktree = shell === null ? null : worktreeOf(shell);
            if (worktree === null)
              return yield* new FactoryDeliveryError({ reason: "worktree-unavailable" });
            return worktree;
          })
        : (yield* resolveRepository(intent.projectId).pipe(
            Effect.mapError(
              (cause) => new FactoryDeliveryError({ reason: "repository-changed", cause }),
            ),
          )).project.workspaceRoot;
    const looked = yield* Effect.result(
      Effect.gen(function* () {
        const context = providerContext(intent);
        const { provider } = yield* providers.resolveHandle({ cwd, context });
        if (provider.kind !== intent.repository.provider)
          return yield* new FactoryDeliveryError({ reason: "repository-changed" });
        const headSelector =
          headBranch ?? (yield* gitManager.findOpenPullRequestForHead(cwd)).headSelector;
        return yield* provider.listChangeRequests({
          cwd,
          context,
          headSelector,
          state: "all",
          limit: PUBLICATION_LOOKUP_LIMIT,
        });
      }),
    );
    const matches =
      looked._tag === "Failure"
        ? []
        : looked.success.filter((candidate) => matchesPublication(intent, candidate));
    const truncated =
      looked._tag === "Success" && looked.success.length >= PUBLICATION_LOOKUP_LIMIT;
    if (!truncated && matches.length === 1) return yield* confirm(intent, matches[0]!, "unknown");
    // A branch made for this one publish, listed in every state with nothing on it, proves absence.
    // Publishing again looks for an open pull request on it before creating one, so nothing is
    // duplicated. A pull request that fails the match (the head moved) is not absence.
    if (
      headBranch !== undefined &&
      looked._tag === "Success" &&
      !truncated &&
      looked.success.length === 0
    )
      return Option.getOrElse(
        yield* store.settle(intent.id, {
          status: "failed",
          failure: `no pull request was opened from ${headBranch}`.slice(0, FAILURE_MAX_CHARS),
          updatedAt: yield* nowIso,
        }),
        () => intent,
      );
    // Bounded head listings cannot prove absence: the PR may have merged, moved or aged out.
    const reason =
      looked._tag === "Failure"
        ? describe("could not read pull requests", looked.failure)
        : truncated
          ? "pull request listing may be truncated; publication remains unverified"
          : matches.length > 1
            ? "multiple pull requests match this publication; attribution is ambiguous"
            : headBranch !== undefined && looked.success.length > 0
              ? `a pull request on ${headBranch} is at a different commit or base than this publication; publication remains unconfirmed`
              : "no matching pull request found; publication remains unverified";
    const refreshed = yield* store.settle(intent.id, {
      status: intent.status,
      failure: reason.slice(0, FAILURE_MAX_CHARS),
      updatedAt: yield* nowIso,
    });
    return Option.getOrElse(refreshed, () => intent);
  });

  const recoverInterrupted = Effect.gen(function* () {
    const recovered = yield* store.recoverInterrupted(yield* nowIso);
    if (recovered > 0)
      yield* Effect.logWarning("settled interrupted Factory deliveries as unknown", {
        recovered,
      });
  });

  return {
    service: FactoryDeliveryService.of({ prepare, grant, grantCommit, read, reconcile, execute }),
    recoverInterrupted,
  };
});

export const layer = Layer.effect(
  FactoryDeliveryService,
  makeService.pipe(Effect.map(({ service }) => service)),
);

/**
 * The instance the effect executor runs on. Recovery runs before the service exists, so no
 * worker built on it can claim a delivery before an interrupted `sending` row is settled.
 */
export const layerWithStartupRecovery = Layer.effect(
  FactoryDeliveryService,
  Effect.gen(function* () {
    const { service, recoverInterrupted } = yield* makeService;
    yield* recoverInterrupted;
    return service;
  }),
);
