import {
  CommandId,
  EnvironmentId,
  FactoryIssueError,
  GitCommandError,
  IssueTrackerKind,
  ProviderInstanceId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Settings from "../serverSettings.ts";
import * as Launches from "../persistence/FactoryIssueLaunches.ts";
import * as OrchestrationEvents from "../persistence/OrchestrationEventStore.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { OrchestratorCommandRejectedError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadIssues from "../orchestration-v2/ThreadIssueService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Issues from "./FactoryIssueService.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeRepositoryResolver, makeBaseResolver } from "./FactoryTaskLaunch.ts";
import {
  fakeIssueTracker,
  issueServiceLayer,
  issueTrackersLayer,
  trackerIssue,
} from "./FactoryIssueHosts.testkit.ts";

const projectId = ProjectId.make("origin-refinement");
const at = "2026-10-29T00:00:00.000Z";
const encodeIssueError = Schema.encodeSync(Schema.toCodecJson(FactoryIssueError));
const decodeIssueError = Schema.decodeUnknownSync(Schema.toCodecJson(FactoryIssueError));

it.effect.each([
  { revision: "main", symbolic: "refs/heads/main", remote: "origin", branch: "main" },
  {
    revision: "refs/heads/stable",
    symbolic: "refs/heads/stable",
    remote: "origin",
    branch: "stable",
  },
  { revision: undefined, symbolic: "refs/heads/main", remote: "origin", branch: "main" },
  { revision: "HEAD", symbolic: "refs/heads/main", remote: "origin", branch: "main" },
  {
    revision: "origin/stable",
    symbolic: "refs/remotes/origin/stable",
    remote: "origin",
    branch: "stable",
  },
  { revision: "origin/HEAD", symbolic: "refs/remotes/origin/HEAD", remote: "origin", branch: null },
  {
    revision: "upstream/main",
    symbolic: "refs/remotes/upstream/main",
    remote: "upstream",
    branch: null,
  },
  { revision: "local", symbolic: "refs/heads/local", remote: "upstream", branch: null },
  { revision: "v1", symbolic: "refs/tags/v1", remote: "origin", branch: null },
  { revision: "a".repeat(40), symbolic: "", remote: "origin", branch: null },
  { revision: "HEAD", symbolic: "HEAD", remote: "origin", branch: null },
  {
    revision: "local-only",
    symbolic: "refs/heads/local-only",
    remote: "origin",
    branch: null,
    missing: true,
  },
  ...[
    { state: "level", fetched: "a".repeat(40), ancestor: true, remote: "origin", branch: "main" },
    { state: "ahead", fetched: "c".repeat(40), ancestor: false, remote: "origin", branch: "main" },
    {
      state: "diverged",
      fetched: "b".repeat(40),
      ancestor: false,
      remote: "origin",
      branch: "main",
    },
    { state: "no remote", fetched: null, ancestor: true, remote: null, branch: null },
    {
      state: "setting off",
      fetched: "b".repeat(40),
      ancestor: true,
      remote: "origin",
      branch: "main",
      disabled: true,
    },
  ].map((row) => ({ ...row, revision: "main", symbolic: "refs/heads/main" })),
])(
  "freezes $revision independently of its origin branch destination ($symbolic, $remote, $state)",
  (row) => {
    let fetches = 0;
    const enabled = !("disabled" in row && row.disabled);
    const shouldFetch = enabled && row.symbolic.startsWith("refs/heads/") && row.remote !== null;
    const fetched = "missing" in row ? null : "fetched" in row ? row.fetched : "b".repeat(40);
    const ancestor = !("ancestor" in row) || row.ancestor;
    return Effect.gen(function* () {
      const pinned = yield* (yield* makeBaseResolver)("/repo", projectId, row.revision);
      assert.deepEqual(pinned, {
        baseRef: shouldFetch && fetched !== null && ancestor ? fetched : "a".repeat(40),
        baseBranch: row.branch,
      });
      assert.equal(fetches, shouldFetch ? 1 : 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Settings.layerTest({
            newWorktreesStartFromOrigin: !enabled,
            projectSettingsOverrides: { [projectId]: { newWorktreesStartFromOrigin: enabled } },
          }),
          Layer.mock(Git.GitVcsDriver)({
            resolveCommit: ({ revision }) => {
              assert.equal(
                revision,
                row.symbolic.startsWith("refs/") ? row.symbolic : (row.revision ?? "HEAD"),
              );
              return Effect.succeed({ commitSha: "a".repeat(40) });
            },
            execute: ({ args }) => {
              if (args[0] === "merge-base") {
                assert.deepEqual(args, ["merge-base", "--is-ancestor", "a".repeat(40), fetched!]);
              }
              return Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(
                  args[0] === "merge-base" && !ancestor ? 1 : 0,
                ),
                stdout: row.symbolic,
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            },
            resolveWorktreeBaseRemote: ({ refName }) =>
              Effect.succeed(
                row.remote === null ? null : { remoteName: row.remote, branchName: refName },
              ),
            fetchWorktreeBaseCommit: (input) =>
              Effect.sync(() => {
                fetches += 1;
                assert.deepEqual(input, {
                  cwd: "/repo",
                  refName: row.symbolic.slice("refs/heads/".length),
                  remote: {
                    remoteName: row.remote!,
                    branchName: row.symbolic.slice("refs/heads/".length),
                  },
                });
                return fetched === null
                  ? null
                  : { commitSha: fetched, remoteRefName: `${row.remote}/${input.refName}` };
              }),
            remoteBranchExists: () => Effect.succeed(!("missing" in row)),
          }),
        ),
      ),
    );
  },
);
const harness = (origin: string, upstream?: string) => {
  const remotes = `origin\t${origin} (fetch)\n${upstream ? `upstream\t${upstream} (fetch)\n` : ""}`;
  const identities = Layer.effect(
    Identities.RepositoryIdentityResolver,
    Identities.make({
      // Stand in for the CLI login probes, without inheriting the other remote's provider.
      refine: (identity) =>
        Effect.succeed(
          identity.canonicalKey.startsWith("forge.example/")
            ? { ...identity, provider: SourceControlProviderKind.make("gitlab") }
            : identity.canonicalKey.startsWith("code.example/")
              ? { ...identity, provider: SourceControlProviderKind.make("github") }
              : identity,
        ),
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () => Effect.succeed({ type: "Directory" } as FileSystem.File.Info),
        }),
        Path.layer,
      ),
    ),
    Layer.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: ({ args }) =>
          Effect.succeed({
            code: ChildProcessSpawner.ExitCode(0),
            stdout: args.includes("--show-toplevel") ? "/repo\n" : remotes,
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    ),
  );
  return Layer.mergeAll(
    identities,
    issueTrackersLayer(),
    Layer.mock(Projects.ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: projectId,
          title: "Factory",
          workspaceRoot: "/repo",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
        }),
      getShell: () =>
        Effect.succeedSome({
          id: projectId,
          title: "Factory",
          workspaceRoot: "/repo",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
        }),
    }),
    Layer.mock(Git.GitVcsDriver)({
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: origin,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
  );
};

it.effect.each(["Could not resolve host: unreachable.example", "Git fetch timed out"])(
  "refuses the launch before recording anything and exposes the fetch diagnosis: %s",
  (diagnosis) => {
    const recorded: string[] = [];
    const dependencies = Layer.mergeAll(
      harness("git@github.com:owner/repo.git"),
      Settings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
      }),
      Layer.mock(Folders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(Threads.ThreadManagementService)({
        assertProviderInstanceEnabled: () => Effect.void,
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: () =>
          Effect.sync(() => {
            recorded.push("thread");
            throw new Error("Unexpected launch");
          }),
      }),
      Layer.mock(Receipts.CommandReceiptStoreV2)({}),
      Layer.mock(Launches.FactoryIssueLaunches)({
        get: () => Effect.succeedNone,
        reserve: () =>
          Effect.sync(() => {
            recorded.push("reservation");
            throw new Error("Unexpected reservation");
          }),
      }),
      Layer.mock(ThreadIssues.ThreadIssueService)({}),
      Layer.mock(OrchestrationEvents.OrchestrationEventStore)({}),
      issueTrackersLayer([
        fakeIssueTracker("github", {
          getIssue: () =>
            Effect.succeed(
              trackerIssue({
                number: 1,
                title: "Remote base",
                body: "Use the merged change",
                state: "open",
                url: "https://github.com/owner/repo/issues/1",
                labels: [],
                updatedAt: at,
              }),
            ),
        }),
      ]),
      Layer.mock(Git.GitVcsDriver)({
        execute: ({ args }) =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: args[0] === "rev-parse" ? "refs/heads/main" : "git@github.com:owner/repo.git",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        resolveCommit: () => Effect.succeed({ commitSha: "a".repeat(40) }),
        resolveWorktreeBaseRemote: () =>
          Effect.succeed({ remoteName: "origin", branchName: "main" }),
        remoteBranchExists: () => Effect.succeed(true),
        fetchWorktreeBaseCommit: () =>
          Effect.fail(
            new GitCommandError({
              operation: "GitVcsDriver.fetchRemote",
              command: "git fetch",
              cwd: "/repo",
              detail: diagnosis,
            }),
          ),
      }),
    );
    return Effect.gen(function* () {
      const issues = yield* Issues.FactoryIssueService;
      const reviewed = yield* issues.read({ projectId, issueNumber: 1 });
      const result = yield* issues
        .start({
          projectId,
          commandId: CommandId.make("refused"),
          issueNumber: 1,
          expectedRepositoryKey: reviewed.repository.canonicalKey,
          expectedIssueRevision: reviewed.issue.revision,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          runtimeMode: "approval-required",
          interactionMode: "default",
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure.reason, "invalid-base-ref");
        assert.include(result.failure.message, diagnosis);
        const wire = encodeIssueError(result.failure);
        const decoded = decodeIssueError(wire);
        assert.include(decoded.message, diagnosis);
      }
      assert.deepEqual(recorded, []);
    }).pipe(
      Effect.provide(
        Issues.layer.pipe(Layer.provide(issueServiceLayer), Layer.provide(dependencies)),
      ),
    );
  },
);

it.effect.each(["accepted", "refused"] as const)(
  "a launch links its issue to the thread, and a replay retries only a missing link (link %s)",
  (outcome) => {
    const launched: string[] = [];
    const attempts: ThreadIssues.LinkThreadIssueInput[] = [];
    const links: ThreadIssues.LinkThreadIssueInput[] = [];
    let saved: Launches.FactoryIssueBinding | null = null;
    const dependencies = Layer.mergeAll(
      harness("git@github.com:owner/repo.git"),
      Settings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
      }),
      Layer.mock(Folders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(Threads.ThreadManagementService)({
        assertProviderInstanceEnabled: () => Effect.void,
        getThreadShell: (threadId) =>
          Effect.succeed(
            launched.includes(threadId)
              ? {
                  ...liveThreadShell(threadId),
                  issues: links.map((link) => ({
                    ...link.ref,
                    url: link.url,
                    source: link.source,
                    linkedAt: at,
                    displayKey: link.displayKey,
                    title: link.title,
                  })),
                }
              : null,
          ),
      }),
      // No link was ever made and then taken back.
      Layer.mock(OrchestrationEvents.OrchestrationEventStore)({
        readAgentEvents: () => Stream.empty,
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: ({ threadId }) =>
          threadId === undefined
            ? Effect.die("A Factory launch names its thread")
            : Effect.sync(() => {
                launched.push(threadId);
                return {
                  threadId,
                  resumed: false,
                  projection: {} as ThreadLaunch.ThreadLaunchResult["projection"],
                };
              }),
      }),
      Layer.mock(Receipts.CommandReceiptStoreV2)({ getByCommandId: () => Effect.succeedNone }),
      Layer.mock(Launches.FactoryIssueLaunches)({
        get: () => Effect.sync(() => Option.fromNullishOr(saved)),
        reserve: (intent) => Effect.sync(() => (saved ??= { intent, accepted: 0 })),
        accept: () =>
          Effect.sync(() => {
            if (saved !== null) saved = { ...saved, accepted: 1 };
          }),
      }),
      Layer.mock(ThreadIssues.ThreadIssueService)({
        link: (input) => {
          attempts.push(input);
          return outcome === "refused"
            ? Effect.fail(
                new OrchestratorCommandRejectedError({
                  commandId: CommandId.make("link"),
                  commandType: "thread.issue.link",
                }),
              )
            : Effect.sync(() => {
                links.push(input);
                return { alreadyLinked: false };
              });
        },
      }),
      issueTrackersLayer([
        fakeIssueTracker("github", {
          getIssue: () =>
            Effect.succeed(
              trackerIssue({
                number: 1,
                title: "Link the task",
                body: "Body",
                state: "open",
                url: "https://github.com/owner/repo/issues/1",
                labels: [],
                updatedAt: at,
              }),
            ),
        }),
      ]),
      Layer.mock(Git.GitVcsDriver)({
        execute: ({ args }) =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: args[0] === "rev-parse" ? "refs/heads/main" : "git@github.com:owner/repo.git",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        resolveCommit: () => Effect.succeed({ commitSha: "a".repeat(40) }),
        resolveWorktreeBaseRemote: () => Effect.succeed(null),
        remoteBranchExists: () => Effect.succeed(true),
      }),
    );
    return Effect.gen(function* () {
      const issues = yield* Issues.FactoryIssueService;
      const reviewed = yield* issues.read({ projectId, issueNumber: 1 });
      const input = {
        projectId,
        commandId: CommandId.make("linked-start"),
        issueNumber: 1,
        expectedRepositoryKey: reviewed.repository.canonicalKey,
        expectedIssueRevision: reviewed.issue.revision,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        runtimeMode: "approval-required",
        interactionMode: "default",
      } as const;
      const started = yield* issues.start(input);
      assert.isFalse(started.resumed);
      assert.isTrue((yield* issues.start(input)).resumed);
      assert.deepEqual(launched, [started.threadId]);
      // A launch whose record was lost relaunches the same thread.
      if (saved !== null) saved = { ...saved, accepted: 0 };
      assert.equal((yield* issues.start(input)).threadId, started.threadId);
      assert.deepEqual(launched, [started.threadId, started.threadId]);
      // Every run retries a link that never landed; one that did is not made again.
      assert.lengthOf(attempts, outcome === "refused" ? 3 : 1);
      assert.deepEqual(links, outcome === "refused" ? [] : attempts);
      assert.deepEqual(attempts[0], {
        threadId: started.threadId,
        ref: {
          projectId,
          tracker: IssueTrackerKind.make("github"),
          host: "github.com",
          scope: "owner/repo",
          key: "1",
        },
        url: "https://github.com/owner/repo/issues/1",
        displayKey: "#1",
        title: "Link the task",
        source: "agent",
      });
    }).pipe(
      Effect.provide(
        Issues.layer.pipe(Layer.provide(issueServiceLayer), Layer.provide(dependencies)),
      ),
    );
  },
);

it.effect.each([
  {
    name: "self-managed origin only",
    origin: "git@forge.example:me/project.git",
    upstream: undefined,
    canonicalKey: "forge.example/me/project",
  },
  {
    name: "self-managed fork with upstream",
    origin: "git@forge.example:me/sub/project.git",
    upstream: "git@forge.example:team/project.git",
    canonicalKey: "forge.example/me/sub/project",
  },
  {
    name: "userless SCP origin",
    origin: "forge.example:me/project.git",
    upstream: "git@github.com:team/project.git",
    canonicalKey: "forge.example/me/project",
  },
  {
    name: "public nested GitLab fork",
    origin: "git@gitlab.com:me/sub/project.git",
    upstream: "git@gitlab.com:team/project.git",
    canonicalKey: "gitlab.com/me/sub/project",
  },
])("resolves $name as GitLab", ({ origin, upstream, canonicalKey }) =>
  Effect.gen(function* () {
    const resolve = yield* makeRepositoryResolver;
    const result = yield* resolve(projectId);
    assert.equal(result.repository.provider, "gitlab");
    assert.equal(result.repository.canonicalKey, canonicalKey);
    assert.equal(result.repository.url, `https://${canonicalKey}`);
  }).pipe(Effect.provide(harness(origin, upstream))),
);

it.effect.each([
  { host: "gitlab.example", provider: SourceControlProviderKind.make("gitlab") },
  { host: "code.example", provider: SourceControlProviderKind.make("github") },
])(
  "preserves the HTTPS authority for $provider without changing its canonical key",
  ({ host, provider }) =>
    Effect.gen(function* () {
      const resolve = yield* makeRepositoryResolver;
      const result = yield* resolve(projectId);
      assert.deepEqual(result.repository, {
        provider,
        host: `${host}:8443`,
        repository: "me/project",
        canonicalKey: `${host}/me/project`,
        url: `https://${host}:8443/me/project`,
      });
    }).pipe(Effect.provide(harness(`https://${host}:8443/me/project.git`))),
);

it.effect("does not inherit a recognized upstream provider for an unknown origin", () =>
  Effect.gen(function* () {
    const resolve = yield* makeRepositoryResolver;
    assert.equal((yield* resolve(projectId).pipe(Effect.flip)).reason, "unsupported-provider");
  }).pipe(
    Effect.provide(
      harness("git@unknown.example:me/project.git", "git@gitlab.com:team/project.git"),
    ),
  ),
);

it.effect("does not treat an SSH transport port as an HTTPS authority port", () =>
  Effect.gen(function* () {
    const resolve = yield* makeRepositoryResolver;
    const result = yield* resolve(projectId);
    assert.equal(result.repository.host, "gitlab.example");
    assert.equal(result.repository.url, "https://gitlab.example/me/project");
  }).pipe(Effect.provide(harness("ssh://git@gitlab.example:2222/me/project.git"))),
);
