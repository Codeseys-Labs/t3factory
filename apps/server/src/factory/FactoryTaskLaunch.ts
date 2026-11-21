import {
  CommandId,
  EnvironmentId,
  FactoryIssueError,
  FactoryRepository,
  IssueTrackerKind,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type FactoryIssueCapabilities,
  type FactoryIssueTask,
  type IssueScopeRef,
  type Project,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import type { IssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as IssueTrackerRegistry from "../issue/IssueTrackerRegistry.ts";
import * as IssueService from "../issue/IssueService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Settings from "../serverSettings.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as FactoryIssueHosts from "./FactoryIssueHosts.ts";
import { makeWorktreeBaseResolver } from "./FactoryWorktreeBase.ts";
import { issueNumberOf } from "./FactoryOriginKey.ts";

export const FactoryLaunchCore = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  requestCommandId: CommandId,
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  baseRef: Schema.String,
  baseBranch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  prompt: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  admittedBy: Schema.optionalKey(EnvironmentId),
  previousThreadId: Schema.NullOr(ThreadId),
});
type Core = typeof FactoryLaunchCore.Type;
// The launch fields status derivation reads. Knowledge tasks have no `baseRef`, so the inspector
// is built on this smaller shape and the issue-shaped `makeInspector` adds the task fields.
type Launched = Pick<Core, "projectId" | "threadId" | "commandId">;

type Binding<I extends Launched> = { readonly intent: I; readonly accepted: 0 | 1 };
type LaunchReason =
  | "persistence-failure"
  | "deleted-task"
  | "launch-authority"
  | "provider-unavailable"
  | "launch-failure";

/** The base resolved to a commit, but choosing between it and its remote branch failed. */
export class WorktreeBaseError extends Schema.TaggedError<WorktreeBaseError>()(
  "WorktreeBaseError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export const makeBaseResolver = Effect.gen(function* () {
  const git = yield* Git.GitVcsDriver;
  const settings = yield* Settings.ServerSettingsService;
  const resolveWorktreeBase = yield* makeWorktreeBaseResolver;
  return Effect.fn("FactoryTaskLaunch.resolveBase")(function* (
    cwd: string,
    projectId: ProjectId,
    revision = "HEAD",
  ) {
    const symbolic = yield* git.execute({
      operation: "FactoryTaskLaunch.resolveBase",
      cwd,
      args: ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", revision],
      allowNonZeroExit: true,
      maxOutputBytes: 4096,
    });
    const ref =
      symbolic.exitCode === 0 && !symbolic.stdoutTruncated && !symbolic.stderrTruncated
        ? symbolic.stdout.trim()
        : "";
    const { commitSha } = yield* git.resolveCommit({
      cwd,
      revision: ref.startsWith("refs/") ? ref : revision,
    });
    const target = ref.startsWith("refs/heads/")
      ? yield* git.resolveWorktreeBaseRemote({ cwd, refName: ref.slice("refs/heads/".length) })
      : ref.startsWith("refs/remotes/origin/")
        ? { remoteName: "origin", branchName: ref.slice("refs/remotes/origin/".length) }
        : null;
    // Only origin owns the admitted repository. Tags, SHAs, detached HEAD and other remotes do not
    // authorize a host destination, even when their commits happen to match an origin branch.
    const baseBranch =
      target?.remoteName === "origin" &&
      target.branchName !== "HEAD" &&
      (yield* git.remoteBranchExists({ cwd, remoteName: "origin", refName: target.branchName }))
        ? target.branchName
        : null;
    if (!ref.startsWith("refs/heads/")) return { baseRef: commitSha, baseBranch };
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new WorktreeBaseError({ detail: "Could not read the project's settings.", cause }),
      ),
    );
    const baseRef = resolveProjectSettings(current, projectId).settings.newWorktreesStartFromOrigin
      ? yield* resolveWorktreeBase({
          cwd,
          refName: ref.slice("refs/heads/".length),
          commitSha,
          remote: target,
        }).pipe(Effect.mapError((cause) => new WorktreeBaseError({ detail: cause.detail, cause })))
      : commitSha;
    return { baseRef, baseBranch };
  });
});

/** The scope of a Factory repository's issues, as the issue layer addresses it. */
export type FactoryIssueScope = IssueScopeRef & { readonly host: string };

/** A project's intake repository, as its live origin names it, and where its issues are read. */
export interface ResolvedFactoryRepository {
  readonly project: Project;
  readonly repository: FactoryRepository;
  readonly capabilities: FactoryIssueCapabilities;
  readonly issues: FactoryIssueScope;
  readonly tracker: IssueTrackerApi;
}

// A path segment the issue and relation readers can address: no traversal, no URL syntax.
const ADDRESSABLE_SEGMENT = /^[a-z0-9_.-]+$/i;

/**
 * Where the issue layer reads a Factory repository's issues, derived from the repository alone
 * so a frozen intent addresses the issues it was admitted from. Null where no tracker has a scope.
 */
export function factoryIssueScope(
  projectId: ProjectId,
  repository: FactoryRepository,
): FactoryIssueScope | null {
  if (repository.issueScope !== undefined) {
    const { tracker, host, scope } = repository.issueScope;
    return { projectId, tracker, host, scope };
  }
  const identity = {
    provider: repository.provider,
    canonicalKey: repository.canonicalKey,
    displayName: repository.repository,
    webUrl: repository.url,
  };
  const scope = sourceControlDefinitions.issueScope(identity);
  return scope === null
    ? null
    : {
        projectId,
        tracker: IssueTrackerKind.make(repository.provider),
        host: sourceControlDefinitions.changeRequestHost(identity, repository.provider),
        scope,
      };
}

function repositoryTarget(
  identity: RepositoryIdentity,
  hosts: FactoryIssueHosts.FactoryIssueHosts["Service"],
) {
  const { canonicalKey, provider } = identity;
  const capabilities = provider === undefined ? null : hosts.capabilities(provider);
  if (capabilities === null) return null;
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/(.+)$/.exec(canonicalKey);
  if (match === null) return null;
  const [, hostname, path] = match;
  if (!hostname || !path) return null;
  const segments = path.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) => !ADDRESSABLE_SEGMENT.test(segment) || segment === "." || segment === "..",
    )
  )
    return null;
  const remoteUrl = URL.parse(identity.locator.remoteUrl);
  // SSH transport ports do not identify the forge's HTTPS endpoint.
  const host =
    remoteUrl?.protocol === "https:" || remoteUrl?.protocol === "http:" ? remoteUrl.host : hostname;
  return {
    capabilities,
    repository: {
      provider: capabilities.provider,
      host,
      repository: path,
      canonicalKey,
      url: `https://${host}/${path}`,
    } satisfies FactoryRepository,
  };
}

export const makeRepositoryResolver = Effect.gen(function* () {
  const projects = yield* Projects.ProjectService;
  const identities = yield* Identities.RepositoryIdentityResolver;
  const git = yield* Git.GitVcsDriver;
  const hosts = yield* FactoryIssueHosts.FactoryIssueHosts;
  const trackers = yield* IssueTrackerRegistry.IssueTrackerRegistry;
  return Effect.fn("FactoryIssueService.resolve")(function* (
    projectId: ProjectId,
    workspaceRoot?: string,
  ): Effect.fn.Return<ResolvedFactoryRepository, FactoryIssueError> {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError((cause) => new FactoryIssueError({ reason: "persistence-failure", cause })),
      );
    if (Option.isNone(project)) return yield* new FactoryIssueError({ reason: "missing-project" });
    const cwd = workspaceRoot ?? project.value.workspaceRoot;
    const identity = yield* identities.resolve(cwd, { refresh: true });
    if (identity === null) return yield* new FactoryIssueError({ reason: "missing-repository" });
    // `remote get-url` distinguishes a missing origin and applies Git's insteadOf rewrites.
    const origin = yield* git
      .execute({
        operation: "FactoryIssueService.resolveOrigin",
        cwd,
        args: ["remote", "get-url", "--", "origin"],
        allowNonZeroExit: true,
        maxOutputBytes: 64 * 1024,
      })
      .pipe(
        Effect.mapError((cause) => new FactoryIssueError({ reason: "missing-repository", cause })),
      );
    if (
      origin.exitCode !== 0 ||
      origin.stdoutTruncated ||
      origin.stderrTruncated ||
      origin.stdout.trim().length === 0
    )
      return yield* new FactoryIssueError({ reason: "missing-repository" });
    const originIdentity = yield* identities.resolveRemote({
      rootPath: identity.rootPath ?? cwd,
      remoteName: "origin",
      remoteUrl: origin.stdout.trim(),
    });
    const target = originIdentity === null ? null : repositoryTarget(originIdentity, hosts);
    const issues = target === null ? null : factoryIssueScope(projectId, target.repository);
    const tracker = issues === null ? null : trackers.get(issues.tracker);
    if (target === null || issues === null || tracker === null)
      return yield* new FactoryIssueError({ reason: "unsupported-provider" });
    return { project: project.value, ...target, issues, tracker };
  });
});

const encodeScopeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
);

export const makeIssueRepositoryResolver = Effect.gen(function* () {
  const resolveRepository = yield* makeRepositoryResolver;
  const issues = yield* IssueService.IssueService;
  const trackers = yield* IssueTrackerRegistry.IssueTrackerRegistry;
  return Effect.fn("FactoryIssueService.resolveIssue")(function* (
    projectId: ProjectId,
    key?: string,
  ): Effect.fn.Return<ResolvedFactoryRepository, FactoryIssueError> {
    const resolved = yield* resolveRepository(projectId);
    if (key !== undefined && issueNumberOf(key) !== null) return resolved;
    const scope = yield* issues
      .projectScope(projectId, key)
      .pipe(
        Effect.mapError(
          (cause) => new FactoryIssueError({ reason: "unsupported-provider", cause }),
        ),
      );
    const tracker = trackers.get(scope.tracker);
    if (tracker === null) return yield* new FactoryIssueError({ reason: "unsupported-provider" });
    const standalone = trackers.standalone.find((entry) => entry.kind === scope.tracker);
    if (standalone === undefined) {
      if (key === undefined) return resolved;
      return yield* new FactoryIssueError({ reason: "unsupported-provider" });
    }
    return {
      ...resolved,
      repository: {
        ...resolved.repository,
        issueScope: {
          tracker: scope.tracker,
          host: scope.host,
          scope: scope.scope,
          canonicalKey: `issue:${encodeScopeKey([scope.tracker, scope.host.toLowerCase(), scope.scope.toLowerCase()])}`,
        },
      },
      issues: scope,
      tracker,
      capabilities: {
        ...resolved.capabilities,
        tracker: scope.tracker,
        displayName: standalone.standalone.displayName,
        blockedBy: "none",
        subIssues: false,
        closeAcceptance: "none",
        issueComment: tracker.capabilities.comment && tracker.comment !== undefined,
      },
    };
  });
});

// Untraced: each caller names the span of the inspection it wraps.
export const makeStatusInspector = Effect.fnUntraced(function* <E>(options: {
  readonly error: (reason: LaunchReason, cause?: unknown) => E;
}) {
  const projects = yield* Projects.ProjectService;
  const threads = yield* Threads.ThreadManagementService;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  return Effect.fnUntraced(
    function* (binding: Binding<Launched>) {
      const { intent } = binding;
      const shell = yield* threads.getThreadShell(intent.threadId);
      let status: FactoryIssueTask["status"];
      if (shell === null) {
        // Receipt and tombstone distinguish an interrupted reservation from a deletion even
        // when the process died before recording the launch response in this table.
        const receipt = yield* receipts.getByCommandId(intent.commandId);
        status =
          binding.accepted === 1 || (Option.isSome(receipt) && receipt.value.status === "accepted")
            ? "missing"
            : "launching";
        if (status === "launching") {
          const owner = yield* projects.getById(intent.projectId);
          if (Option.isNone(owner)) status = "missing";
        }
      } else if (shell.deletedAt !== null) status = "missing";
      else if (shell.archivedAt !== null) status = "archived";
      else if (shell.status === "preparing") status = "preparing";
      else if (shell.status === "failed") status = "failed";
      else if (["running", "starting", "waiting", "queued"].includes(shell.status))
        status = "running";
      else status = binding.accepted === 0 && shell.latestRunId === null ? "launching" : "idle";
      return { shell, status };
    },
    Effect.mapError((cause) => options.error("persistence-failure", cause)),
  );
});

export const makeInspector = Effect.fn("FactoryTaskLaunch.makeInspector")(function* <E>(options: {
  readonly span: string;
  readonly error: (reason: LaunchReason, cause?: unknown) => E;
}) {
  const inspectStatus = yield* makeStatusInspector(options);
  return Effect.fn(`${options.span}.inspect`)(function* (binding: Binding<Core>) {
    const { intent } = binding;
    const { shell, status } = yield* inspectStatus(binding);
    return {
      shell,
      task: {
        projectId: intent.projectId,
        threadId: intent.threadId,
        baseRef: intent.baseRef,
        baseBranch: intent.baseBranch ?? null,
        createdAt: intent.createdAt,
        status,
        modelSelection: intent.modelSelection,
        runtimeMode: intent.runtimeMode,
        interactionMode: intent.interactionMode,
      } satisfies FactoryIssueTask,
    };
  });
});

export const make = Effect.fn("FactoryTaskLaunch.make")(function* <I extends Core, E>(options: {
  readonly span: string;
  readonly error: (reason: LaunchReason, cause?: unknown) => E;
  readonly accept: (threadId: ThreadId) => Effect.Effect<void, E>;
  readonly title: (intent: I) => string;
  readonly precondition: (intent: I) => Effect.Effect<void, E>;
  /** Runs once the thread exists, before the launch is recorded, and again on every resume. */
  readonly launched?: (intent: I) => Effect.Effect<void>;
}) {
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const inspect = yield* makeInspector(options);
  const resume = Effect.fn(`${options.span}.launch`)(function* (binding: Binding<I>) {
    const { intent } = binding;
    let inspected = yield* inspect(binding);
    if (inspected.task.status === "missing")
      return yield* Effect.fail(options.error("deleted-task"));
    if (binding.accepted === 0 && inspected.task.status !== "archived") {
      const limit = yield* DispatchModeLimit;
      if (limit !== undefined && exceededDispatchModeLimit(limit, intent) !== undefined)
        return yield* Effect.fail(options.error("launch-authority"));
      yield* options.precondition(intent);
      yield* launcher
        .launch({
          commandId: intent.commandId,
          threadId: intent.threadId,
          projectId: intent.projectId,
          title: options.title(intent),
          modelSelection: intent.modelSelection,
          runtimeMode: intent.runtimeMode,
          interactionMode: intent.interactionMode,
          workspaceStrategy: {
            type: "worktree",
            baseRef: intent.baseRef,
            startFromOrigin: false,
          },
          initialMessage: { messageId: intent.messageId, text: intent.prompt, attachments: [] },
          createdBy: intent.createdBy,
          creationSource: intent.creationSource,
        })
        .pipe(
          Effect.mapError((cause) =>
            options.error(
              cause._tag === "ThreadManagementProviderInstanceDisabledError"
                ? "provider-unavailable"
                : "launch-failure",
              cause,
            ),
          ),
        );
      if (options.launched !== undefined) yield* options.launched(intent);
      yield* options.accept(intent.threadId);
      inspected = yield* inspect({ ...binding, accepted: 1 });
    } else if (options.launched !== undefined) yield* options.launched(intent);
    return inspected.task;
  });
  return { inspect, resume };
});
