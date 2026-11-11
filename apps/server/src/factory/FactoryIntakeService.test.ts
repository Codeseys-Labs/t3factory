import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  FactoryFeedSourceId,
  FactoryIssueError,
  FactoryTaskError,
  ProjectId,
  SourceControlProviderKind,
  type FactoryFeedCandidate,
  type FactoryFeedSource,
  type FactoryIntakeChange,
  type FactoryIntakeSourceConfig,
  type FactoryIssue,
  type FactoryTaskCreateInput,
  type FactoryTaskSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Store from "../persistence/FactoryIntakeStore.ts";
import * as FeedStore from "../persistence/FactoryFeedStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Feeds from "./FactoryFeedService.ts";
import * as Intake from "./FactoryIntakeService.ts";
import * as Issues from "./FactoryIssueService.ts";
import { issueOriginKey } from "./FactoryOriginKey.ts";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";
import * as Tasks from "./FactoryTaskService.ts";

const environmentId = EnvironmentId.make("intake-environment");
const projectId = ProjectId.make("intake-project");
const otherProjectId = ProjectId.make("intake-other");
const thirdProjectId = ProjectId.make("intake-third");
const human: FactoryPlanActor = { kind: "human", sessionId: AuthSessionId.make("session-1") };
const github = SourceControlProviderKind.make("github");
const repository = {
  provider: github,
  host: "github.com",
  repository: "owner/repo",
  canonicalKey: "github.com/owner/repo",
  url: "https://github.com/owner/repo",
};
const issue = (
  number: number,
  title: string,
  labels: ReadonlyArray<string> = [],
): FactoryIssue => ({
  number,
  title,
  body: `Body of ${number}`,
  state: "open",
  url: `https://github.com/owner/repo/issues/${number}`,
  labels,
  updatedAt: "2026-11-01T00:00:00.000Z",
  revision: `revision-${number}`,
  task: null,
});
const issuesConfig: FactoryIntakeSourceConfig = { kind: "issues" };
const DAY_MS = 24 * 60 * 60_000;

interface CreateCall {
  readonly input: FactoryTaskCreateInput;
  readonly actor: FactoryPlanActor;
  readonly origin: Tasks.FactoryTaskOrigin | undefined;
}

const summaryOf = (
  number: number,
  input: FactoryTaskCreateInput,
  origin: Tasks.FactoryTaskOrigin | undefined,
): FactoryTaskSummary => ({
  ref: {
    environmentId,
    projectId: input.projectId,
    rootId: `root-${number}`,
    taskId: `root-${number}`,
  },
  displayId: `T-${number}`,
  parent: null,
  title: input.title,
  type: input.type ?? "task",
  status: input.lane ?? "backlog",
  lane: input.lane ?? "backlog",
  assignee: { assignment: input.assignment ?? { mode: "unassigned" }, key: "k", resolved: null },
  source: origin?.source ?? { kind: "local", label: "", url: null, key: null, workRef: null },
  blockedBy: [],
  progress: null,
  run: null,
  liveRuns: [],
  attention: [],
  result: null,
  version: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

interface FeedState {
  readonly sources: ReadonlyArray<FactoryFeedSource>;
  readonly candidates: ReadonlyArray<FactoryFeedCandidate>;
  readonly binds: number;
  readonly refreshes: number;
}

const feedCandidate = (itemKey: string, title: string): FactoryFeedCandidate => ({
  sourceId: FactoryFeedSourceId.make("feed-1"),
  itemKey,
  title,
  content: `<p>${title}</p>`,
  link: `https://news.example.org/${itemKey}`,
  publishedAt: null,
  revision: `revision-${itemKey}`,
  ordinal: 1,
  firstSeenAt: "2026-11-01T00:00:00.000Z",
  lastSeenAt: "2026-11-01T00:00:00.000Z",
  inWindow: true,
  disposition: "open",
  dismissalNote: null,
  forgeReference: null,
  task: null,
});

const harness = Effect.gen(function* () {
  const database = yield* Layer.build(Sqlite.layerMemory);
  const feedStore = yield* FeedStore.FactoryFeedStore.pipe(
    Effect.provide(FeedStore.layer),
    Effect.provideContext(database),
  );
  const issueLists = yield* Ref.make(new Map<ProjectId, ReadonlyArray<FactoryIssue>>());
  const issueFailure = yield* Ref.make<FactoryIssueError["reason"] | null>(null);
  const issueCalls = yield* Ref.make(new Map<ProjectId, number>());
  const feed = yield* Ref.make<FeedState>({ sources: [], candidates: [], binds: 0, refreshes: 0 });
  const created = yield* Queue.unbounded<CreateCall>();
  const createCalls = yield* Ref.make<ReadonlyArray<CreateCall>>([]);
  const profileExists = yield* Ref.make(true);
  const tasksByCommand = new Map<string, FactoryTaskSummary>();
  const inputsByCommand = new Map<string, FactoryTaskCreateInput>();
  const now = DateTime.formatIso(yield* DateTime.now);
  const fakes = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.mock(Projects.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId || id === otherProjectId || id === thirdProjectId
            ? Option.some({ id } as never)
            : Option.none(),
        ),
    }),
    Layer.mock(Issues.FactoryIssueService)({
      list: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(issueCalls, (calls) =>
            new Map(calls).set(input.projectId, (calls.get(input.projectId) ?? 0) + 1),
          );
          const failure = yield* Ref.get(issueFailure);
          if (failure !== null) return yield* new FactoryIssueError({ reason: failure });
          const listed = [
            ...((yield* Ref.get(issueLists)).get(input.projectId) ?? []),
          ].toReversed();
          const offset = ((input.page ?? 1) - 1) * 30;
          return {
            repository,
            capabilities: {
              provider: github,
              displayName: "GitHub",
              blockedBy: "none",
              subIssues: false,
              closeAcceptance: "none",
              publish: false,
              headPinnedMerge: false,
              issueComment: false,
            },
            // The tracker lists newest first.
            issues: listed.slice(offset, offset + 30),
            nextPage: offset + 30 < listed.length ? (input.page ?? 1) + 1 : null,
            fetchedAt: now,
          };
        }),
    }),
    Layer.mock(Feeds.FactoryFeedService)({
      listSources: () => Ref.get(feed).pipe(Effect.map(({ sources }) => ({ sources }))),
      bindSource: (input) =>
        Effect.gen(function* () {
          const bound = yield* feedStore.bind({
            id: FactoryFeedSourceId.make(`feed-${(yield* Ref.get(feed)).binds + 1}`),
            projectId: input.projectId,
            locator: input.url,
            commandId: input.commandId,
            at: now,
          });
          return yield* Ref.modify(feed, (state) => {
            const source: FactoryFeedSource = {
              id: bound.id,
              projectId: input.projectId,
              locator: input.url,
              title: "Release notes",
              status: "active",
              createdAt: now,
              lastCheckedAt: now,
              nextAllowedAt: "2030-01-01T00:00:00.000Z",
              lastError: null,
            };
            return [
              { source, observed: 0, notModified: false },
              {
                ...state,
                sources: [...state.sources.filter((item) => item.id !== source.id), source],
                binds: state.binds + 1,
              },
            ];
          });
        }),
      refreshSource: () =>
        Ref.modify(feed, (state) => [
          { source: state.sources[0]!, observed: 0, notModified: true },
          { ...state, refreshes: state.refreshes + 1 },
        ]),
      listCandidates: () =>
        Ref.get(feed).pipe(
          Effect.map(({ candidates }) => ({ repository: null, candidates, fetchedAt: now })),
        ),
    }),
    Layer.mock(Tasks.FactoryTaskService)({
      create: (input, actor, origin) =>
        Effect.gen(function* () {
          const call = { input, actor, origin };
          const calls = yield* Ref.updateAndGet(createCalls, (current) => [...current, call]);
          const existing = tasksByCommand.get(input.commandId);
          if (
            existing !== undefined &&
            JSON.stringify(inputsByCommand.get(input.commandId)) !== JSON.stringify(input)
          )
            return yield* new FactoryTaskError({ reason: "command-conflict" });
          if (
            existing === undefined &&
            input.assignment?.mode === "profile" &&
            !(yield* Ref.get(profileExists))
          )
            return yield* new FactoryTaskError({ reason: "missing-profile" });
          if (existing === undefined) yield* Queue.offer(created, call);
          const task = existing ?? summaryOf(calls.length, input, origin);
          tasksByCommand.set(input.commandId, task);
          inputsByCommand.set(input.commandId, input);
          return { task, replayed: existing !== undefined };
        }),
      resolveAssignee: ({ assignment }) =>
        Effect.succeed({
          assignment,
          key: assignment.mode === "profile" ? assignment.profileId : assignment.mode,
          resolved: null,
        }),
      read: ({ task }) =>
        "ref" in task && task.ref.taskId !== "missing"
          ? Effect.succeed({
              task: {
                ...summaryOf(
                  90,
                  { commandId: CommandId.make("x"), projectId, title: "Original" },
                  undefined,
                ),
                ref: task.ref,
              },
              description: "",
              ancestors: [],
              subtasks: [],
              blockedBy: [],
              blocks: [],
              runs: [],
              fetchedAt: now,
            })
          : Effect.fail(new FactoryTaskError({ reason: "missing-task" })),
    }),
  );
  const start = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      Intake.layer.pipe(Layer.provide(Store.layer), Layer.provide(fakes)),
      scope,
    ).pipe(Effect.provideContext(database));
    const intake = Context.get(context, Intake.FactoryIntakeService);
    const changes = yield* Queue.unbounded<FactoryIntakeChange>();
    yield* intake.changes.pipe(
      Stream.runForEach((change) => Queue.offer(changes, change)),
      Effect.forkIn(scope, { startImmediately: true }),
    );
    return { intake, changes, stop: Scope.close(scope, Exit.void) };
  });
  const setIssues = (project: ProjectId, issues: ReadonlyArray<FactoryIssue>) =>
    Ref.update(issueLists, (lists) => new Map(lists).set(project, issues));
  const callsFor = (project: ProjectId) =>
    Ref.get(issueCalls).pipe(Effect.map((calls) => calls.get(project) ?? 0));
  return {
    start,
    setIssues,
    callsFor,
    issueFailure,
    feed,
    created,
    createCalls,
    profileExists,
    sql: Context.get(database, SqlClient.SqlClient),
  };
});

type Service = Intake.FactoryIntakeService["Service"];

const connectIssues = (intake: Service, command: string, project = projectId) =>
  intake
    .saveSource(
      {
        commandId: CommandId.make(command),
        projectId: project,
        config: issuesConfig,
        enabled: true,
      },
      human,
    )
    .pipe(Effect.map(({ source }) => source!));

const setEnabled = (
  intake: Service,
  source: { readonly id: string; readonly projectId: ProjectId },
  enabled: boolean,
) =>
  Effect.gen(function* () {
    const listed = (yield* intake.listSources({})).sources.find((entry) => entry.id === source.id)!;
    return yield* intake.saveSource(
      {
        commandId: CommandId.make(`${source.id}-${enabled}-${listed.version}`),
        id: source.id,
        expectedVersion: listed.version,
        projectId: source.projectId,
        config: listed.config,
        enabled,
      },
      human,
    );
  });

// Turning a source off and on looks at it again at once.
const recheck = (intake: Service, source: { readonly id: string; readonly projectId: ProjectId }) =>
  setEnabled(intake, source, false).pipe(Effect.andThen(setEnabled(intake, source, true)));

const saveRule = (
  intake: Service,
  command: string,
  input: {
    readonly name: string;
    readonly sourceId: string;
    readonly labels?: ReadonlyArray<string>;
    readonly titleContains?: string;
    readonly autonomy?: "manual" | "suggest" | "auto-start";
    readonly state?: "off" | "trial" | "on";
    readonly type?: "task" | "bug" | "feature" | "docs" | "research";
    readonly profileId?: string;
  },
) =>
  intake.saveRule(
    {
      commandId: CommandId.make(command),
      name: input.name,
      match: {
        sourceId: input.sourceId,
        labels: input.labels ?? [],
        titleContains: input.titleContains ?? "",
      },
      action: {
        type: input.type ?? "task",
        assignment:
          input.profileId === undefined
            ? { mode: "auto" }
            : { mode: "profile", profileId: input.profileId },
      },
      autonomy: input.autonomy ?? "suggest",
      state: input.state ?? "on",
    },
    human,
  );

const triage = (intake: Service, projectIds?: ReadonlyArray<ProjectId>) =>
  intake.listArrivals(projectIds === undefined ? {} : { projectIds });

const awaitChange = (
  changes: Queue.Queue<FactoryIntakeChange>,
  predicate: (change: FactoryIntakeChange) => boolean,
) => Queue.take(changes).pipe(Effect.repeat({ until: predicate }));

it.effect("a new issue arrives once, however often the tracker shows it", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake, changes } = yield* h.start;
    yield* h.setIssues(projectId, [issue(1, "Board cards overflow at 1280")]);
    const source = yield* connectIssues(intake, "connect");
    assert.strictEqual(source.label, "GitHub issues");
    assert.strictEqual(source.detail, "owner/repo");
    assert.strictEqual(source.status, "ok");
    const first = yield* triage(intake);
    assert.deepStrictEqual(
      first.items.map((arrival) => [arrival.label, arrival.title, arrival.sourceKind]),
      [["GitHub #1", "Board cards overflow at 1280", "issues"]],
    );

    yield* Queue.clear(changes);
    yield* TestClock.adjust("5 minutes");
    yield* awaitChange(changes, (change) => change.sources);
    assert.strictEqual(yield* h.callsFor(projectId), 2);
    assert.strictEqual((yield* triage(intake)).items.length, 1);

    yield* h.setIssues(projectId, [
      issue(1, "Board cards overflow at 1280"),
      issue(2, "Add CSV export"),
    ]);
    yield* TestClock.adjust("5 minutes");
    yield* awaitChange(changes, (change) => change.arrivals);
    assert.deepStrictEqual(
      (yield* triage(intake)).items.map((arrival) => arrival.title),
      ["Add CSV export", "Board cards overflow at 1280"],
    );
  }),
);

it.effect("issue intake follows every page and deduplicates later checks", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake, changes } = yield* h.start;
    yield* h.setIssues(
      projectId,
      Array.from({ length: 65 }, (_, index) => issue(index + 1, `Issue ${index + 1}`)),
    );
    yield* connectIssues(intake, "connect");
    const first = yield* intake.listArrivals({ limit: 50 });
    const second =
      first.nextCursor === null
        ? []
        : (yield* intake.listArrivals({ limit: 50, cursor: first.nextCursor })).items;
    const arrivals = [...first.items, ...second];
    assert.strictEqual(arrivals.length, 65);
    assert.deepStrictEqual(
      arrivals.map((arrival) => arrival.title),
      Array.from({ length: 65 }, (_, index) => `Issue ${65 - index}`),
    );
    assert.strictEqual(yield* h.callsFor(projectId), 3);
    yield* Queue.clear(changes);
    yield* TestClock.adjust("5 minutes");
    yield* awaitChange(changes, (change) => change.sources);
    assert.strictEqual((yield* intake.listArrivals({})).waiting, 65);
    assert.strictEqual(yield* h.callsFor(projectId), 6);
  }),
);

it.effect("a project without a readable tracker shows its source as unavailable", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake } = yield* h.start;
    yield* Ref.set(h.issueFailure, "missing-repository");
    const source = yield* connectIssues(intake, "connect");
    assert.strictEqual(source.status, "unavailable");
    yield* Ref.set(h.issueFailure, "rate-limited");
    assert.strictEqual((yield* recheck(intake, source)).source?.status, "failed");
    yield* Ref.set(h.issueFailure, null);
    assert.strictEqual((yield* recheck(intake, source)).source?.status, "ok");
  }),
);

it.effect("the first matching rule that is on fires, in creation order", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake } = yield* h.start;
    const source = yield* connectIssues(intake, "connect");
    yield* saveRule(intake, "r-off", {
      name: "Off",
      sourceId: source.id,
      labels: ["bug"],
      state: "off",
    });
    yield* saveRule(intake, "r-docs", {
      name: "Docs",
      sourceId: source.id,
      labels: ["docs"],
      autonomy: "manual",
    });
    yield* saveRule(intake, "r-bugs", {
      name: "Bugs from GitHub",
      sourceId: source.id,
      labels: ["bug"],
      type: "bug",
      profileId: "implementer",
    });
    yield* saveRule(intake, "r-crash", {
      name: "Crashes",
      sourceId: source.id,
      titleContains: "crash",
      type: "feature",
    });
    yield* h.setIssues(projectId, [
      issue(1, "Crash on start", ["Bug"]),
      issue(2, "Write the guide", ["docs", "bug"]),
      issue(3, "App CRASH loop"),
      issue(4, "Unrelated", ["other"]),
    ]);
    yield* recheck(intake, source);

    const byTitle = new Map(
      (yield* triage(intake)).items.map((arrival) => [arrival.title, arrival]),
    );
    assert.deepStrictEqual(byTitle.get("Crash on start")?.suggestion, {
      ruleId: byTitle.get("Crash on start")?.suggestion?.ruleId ?? "",
      ruleName: "Bugs from GitHub",
      type: "bug",
      assignee: {
        assignment: { mode: "profile", profileId: "implementer" },
        key: "implementer",
        resolved: null,
      },
    });
    assert.strictEqual(byTitle.get("Write the guide")?.suggestion, null);
    assert.strictEqual(byTitle.get("App CRASH loop")?.suggestion?.ruleName, "Crashes");
    assert.strictEqual(byTitle.get("Unrelated")?.suggestion, null);

    const now = DateTime.formatIso(yield* DateTime.now);
    const rules = new Map((yield* intake.listRules()).rules.map((rule) => [rule.name, rule]));
    assert.deepStrictEqual(
      [...rules.values()].map((rule) => [rule.name, rule.firedCount, rule.lastFiredAt]),
      [
        ["Off", 0, null],
        ["Docs", 1, now],
        ["Bugs from GitHub", 1, now],
        ["Crashes", 1, now],
      ],
    );
  }),
);

it.effect("a trial rule fires on its first match and then turns itself off", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake } = yield* h.start;
    const source = yield* connectIssues(intake, "connect");
    const saved = yield* saveRule(intake, "r-trial", {
      name: "Feed items",
      sourceId: source.id,
      labels: ["bug"],
      state: "trial",
    });
    yield* TestClock.adjust("1 minute");
    yield* h.setIssues(projectId, [issue(1, "First", ["bug"]), issue(2, "Second", ["bug"])]);
    yield* recheck(intake, source);

    const byTitle = new Map(
      (yield* triage(intake)).items.map((arrival) => [arrival.title, arrival]),
    );
    assert.strictEqual(byTitle.get("First")?.suggestion?.ruleName, "Feed items");
    assert.strictEqual(byTitle.get("Second")?.suggestion, null);
    const [rule] = (yield* intake.listRules()).rules;
    assert.strictEqual(rule?.state, "off");
    assert.strictEqual(rule?.firedCount, 1);
    assert.strictEqual(rule?.lastFiredAt, DateTime.formatIso(yield* DateTime.now));
    assert.strictEqual(rule?.version, (saved.rule?.version ?? 0) + 1);
  }),
);

it.effect("an auto-start rule can only be saved switched off", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake } = yield* h.start;
    const source = yield* connectIssues(intake, "connect");
    for (const state of ["on", "trial"] as const) {
      const error = yield* Effect.flip(
        saveRule(intake, `r-${state}`, {
          name: "Docs label",
          sourceId: source.id,
          autonomy: "auto-start",
          state,
        }),
      );
      assert.strictEqual(error.reason, "autonomy-not-allowed");
    }
    const off = yield* saveRule(intake, "r-off", {
      name: "Docs label",
      sourceId: source.id,
      autonomy: "auto-start",
      state: "off",
    });
    assert.strictEqual(off.rule?.autonomy, "auto-start");
    const turnOn = yield* Effect.flip(
      intake.saveRule(
        {
          commandId: CommandId.make("r-turn-on"),
          id: off.rule!.id,
          expectedVersion: off.rule!.version,
          name: "Docs label",
          match: off.rule!.match,
          action: off.rule!.action,
          autonomy: "auto-start",
          state: "on",
        },
        human,
      ),
    );
    assert.strictEqual(turnOn.reason, "autonomy-not-allowed");

    const taken = yield* Effect.flip(
      saveRule(intake, "r-same-name", { name: "DOCS LABEL", sourceId: source.id }),
    );
    assert.strictEqual(taken.reason, "name-taken");
    const stale = yield* Effect.flip(
      intake.saveRule(
        {
          commandId: CommandId.make("r-stale"),
          id: off.rule!.id,
          expectedVersion: off.rule!.version + 5,
          name: "Docs label",
          match: off.rule!.match,
          action: off.rule!.action,
          autonomy: "manual",
          state: "on",
        },
        human,
      ),
    );
    assert.strictEqual(stale.reason, "version-conflict");
    assert.strictEqual(stale.currentVersion, off.rule!.version);
  }),
);

it.effect("accepting makes one Backlog task from the suggestion and resolves the arrival", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake } = yield* h.start;
    const source = yield* connectIssues(intake, "connect");
    yield* saveRule(intake, "r-bugs", {
      name: "Bugs from GitHub",
      sourceId: source.id,
      labels: ["bug"],
      type: "bug",
      profileId: "implementer",
    });
    yield* h.setIssues(projectId, [
      issue(7, "Board cards overflow", ["bug"]),
      issue(8, "Docs gap"),
    ]);
    yield* recheck(intake, source);
    const byTitle = new Map(
      (yield* triage(intake)).items.map((arrival) => [arrival.title, arrival]),
    );
    const arrival = byTitle.get("Board cards overflow")!;

    const accept = {
      commandId: CommandId.make("accept-7"),
      id: arrival.id,
      expectedVersion: arrival.version,
      action: { type: "accept" as const },
    };
    const accepted = yield* intake.resolveArrival(accept, human);
    const calls = yield* Ref.get(h.createCalls);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], {
      input: {
        commandId: calls[0]!.input.commandId,
        projectId,
        title: "Board cards overflow",
        description: "Body of 7",
        type: "bug",
        lane: "backlog",
        assignment: { mode: "profile", profileId: "implementer" },
      },
      actor: human,
      origin: {
        source: {
          kind: "issue",
          label: "GitHub #7",
          url: "https://github.com/owner/repo/issues/7",
          key: issueOriginKey(github, repository.canonicalKey, 7),
          workRef: null,
        },
        ruleName: "Bugs from GitHub",
      },
    });
    assert.strictEqual(accepted.replayed, false);
    assert.strictEqual(accepted.arrival.state, "accepted");
    assert.deepStrictEqual(accepted.arrival.task, {
      ref: accepted.task!.ref,
      displayId: accepted.task!.displayId,
    });

    const replay = yield* intake.resolveArrival(accept, human);
    assert.strictEqual(replay.replayed, true);
    assert.strictEqual(replay.task?.displayId, accepted.task?.displayId);
    assert.strictEqual((yield* Ref.get(h.createCalls)).length, 1);

    const conflict = yield* Effect.flip(
      intake.resolveArrival({ ...accept, action: { type: "decline" } }, human),
    );
    assert.strictEqual(conflict.reason, "command-conflict");
    const twice = yield* Effect.flip(
      intake.resolveArrival(
        {
          ...accept,
          commandId: CommandId.make("accept-7-again"),
          expectedVersion: accepted.arrival.version,
        },
        human,
      ),
    );
    assert.strictEqual(twice.reason, "already-resolved");

    const plain = byTitle.get("Docs gap")!;
    const stale = yield* Effect.flip(
      intake.resolveArrival(
        {
          commandId: CommandId.make("accept-8-stale"),
          id: plain.id,
          expectedVersion: plain.version + 1,
          action: { type: "accept" },
        },
        human,
      ),
    );
    assert.strictEqual(stale.reason, "version-conflict");
    assert.strictEqual(stale.currentVersion, plain.version);
    yield* intake.resolveArrival(
      {
        commandId: CommandId.make("accept-8"),
        id: plain.id,
        expectedVersion: plain.version,
        action: { type: "accept", taskType: "docs" },
      },
      human,
    );
    const second = (yield* Ref.get(h.createCalls))[1]!;
    assert.strictEqual(second.input.type, "docs");
    assert.deepStrictEqual(second.input.assignment, { mode: "unassigned" });
    assert.strictEqual(second.origin?.ruleName, null);
    assert.deepStrictEqual((yield* triage(intake)).items, []);
  }),
);

it.effect(
  "snoozed arrivals return to Triage when their time comes; declined and duplicates leave",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const { intake } = yield* h.start;
      yield* h.setIssues(projectId, [
        issue(1, "Snooze me"),
        issue(2, "Decline me"),
        issue(3, "Same as T-90"),
      ]);
      yield* connectIssues(intake, "connect");
      const byTitle = new Map(
        (yield* triage(intake)).items.map((arrival) => [arrival.title, arrival]),
      );
      const resolve = (
        title: string,
        command: string,
        action: Parameters<Service["resolveArrival"]>[0]["action"],
      ) =>
        intake.resolveArrival(
          {
            commandId: CommandId.make(command),
            id: byTitle.get(title)!.id,
            expectedVersion: byTitle.get(title)!.version,
            action,
          },
          human,
        );
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const past = yield* Effect.flip(
        resolve("Snooze me", "snooze-past", {
          type: "snooze",
          until: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        }),
      );
      assert.strictEqual(past.reason, "invalid-input");
      const until = DateTime.formatIso(DateTime.makeUnsafe(nowMs + 60 * 60_000));
      yield* resolve("Snooze me", "snooze", { type: "snooze", until });
      const hidden = yield* triage(intake);
      assert.deepStrictEqual(
        hidden.items.map((arrival) => arrival.title),
        ["Same as T-90", "Decline me"],
      );
      assert.strictEqual(hidden.waiting, 2);
      const snoozed = yield* intake.listArrivals({ states: ["snoozed"] });
      assert.deepStrictEqual(
        snoozed.items.map((arrival) => [arrival.title, arrival.snoozedUntil]),
        [["Snooze me", until]],
      );
      assert.strictEqual(snoozed.waiting, 2);

      yield* TestClock.adjust("1 hour");
      assert.deepStrictEqual(
        (yield* triage(intake)).items.map((arrival) => arrival.title),
        ["Same as T-90", "Decline me", "Snooze me"],
      );

      yield* resolve("Decline me", "decline", { type: "decline" });
      const original = {
        environmentId,
        projectId,
        rootId: "root-90",
        taskId: "root-90",
      };
      const missing = yield* Effect.flip(
        resolve("Same as T-90", "duplicate-missing", {
          type: "duplicate",
          of: { ...original, taskId: "missing" },
        }),
      );
      assert.strictEqual(missing.reason, "missing-task");
      const elsewhere = yield* Effect.flip(
        resolve("Same as T-90", "duplicate-elsewhere", {
          type: "duplicate",
          of: { ...original, environmentId: EnvironmentId.make("elsewhere") },
        }),
      );
      assert.strictEqual(elsewhere.reason, "wrong-environment");
      const duplicate = yield* resolve("Same as T-90", "duplicate", {
        type: "duplicate",
        of: original,
      });
      assert.deepStrictEqual(duplicate.arrival.task, { ref: original, displayId: "T-90" });
      assert.deepStrictEqual(
        (yield* triage(intake)).items.map((arrival) => arrival.title),
        ["Snooze me"],
      );
      assert.deepStrictEqual(
        (yield* intake.listArrivals({ states: ["declined", "duplicate"] })).items.map((arrival) => [
          arrival.title,
          arrival.state,
        ]),
        [
          ["Same as T-90", "duplicate"],
          ["Decline me", "declined"],
        ],
      );
      assert.deepStrictEqual(yield* Ref.get(h.createCalls), []);
    }),
);

it.effect("waiting counts the Triage view of the same projects, across pages", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake } = yield* h.start;
    yield* h.setIssues(projectId, [issue(1, "One"), issue(2, "Two"), issue(3, "Three")]);
    yield* h.setIssues(otherProjectId, [issue(4, "Four")]);
    yield* connectIssues(intake, "connect-1");
    yield* connectIssues(intake, "connect-2", otherProjectId);

    for (const projectIds of [undefined, [projectId], [otherProjectId]]) {
      const listed = yield* triage(intake, projectIds);
      assert.strictEqual(listed.waiting, listed.items.length);
    }
    assert.strictEqual((yield* triage(intake)).waiting, 4);

    const first = yield* intake.listArrivals({ projectIds: [projectId], limit: 2 });
    assert.deepStrictEqual(
      first.items.map((arrival) => arrival.title),
      ["Three", "Two"],
    );
    assert.strictEqual(first.waiting, 3);
    const second = yield* intake.listArrivals({
      projectIds: [projectId],
      limit: 2,
      cursor: first.nextCursor!,
    });
    assert.deepStrictEqual(
      second.items.map((arrival) => arrival.title),
      ["One"],
    );
    assert.strictEqual(second.nextCursor, null);
    const misused = yield* Effect.flip(
      intake.listArrivals({ projectIds: [otherProjectId], cursor: first.nextCursor! }),
    );
    assert.strictEqual(misused.reason, "invalid-cursor");
  }),
);

it.effect(
  "a schedule makes its task once per scheduled time, on its weekdays, across restarts",
  () =>
    Effect.gen(function* () {
      const local = (day: number, hour: number, minute = 0) =>
        DateTime.toEpochMillis(
          DateTime.makeZonedUnsafe(
            { year: 2026, month: 11, day, hour, minute },
            { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
          ),
        );
      // 9 November 2026 is a Monday.
      yield* TestClock.setTime(local(9, 8));
      const h = yield* harness;
      const first = yield* h.start;
      const saved = yield* first.intake.saveSource(
        {
          commandId: CommandId.make("schedule"),
          projectId,
          config: {
            kind: "schedule",
            schedule: { timeOfDay: "09:00", weekdays: [1, 3] },
            task: {
              title: "Weekly dependency review",
              description: "Check outdated packages.",
              type: "research",
              assignment: { mode: "profile", profileId: "implementer" },
              lane: "ready",
            },
          },
          enabled: true,
        },
        human,
      );
      assert.deepStrictEqual(
        [saved.source?.label, saved.source?.detail, saved.source?.status],
        ["Schedule", "", "ok"],
      );

      yield* TestClock.adjust("1 hour");
      const monday = yield* Queue.take(h.created);
      assert.deepStrictEqual(monday.input, {
        commandId: monday.input.commandId,
        projectId,
        title: "Weekly dependency review",
        description: "Check outdated packages.",
        type: "research",
        lane: "ready",
        assignment: { mode: "profile", profileId: "implementer" },
      });
      assert.deepStrictEqual(monday.actor, human);
      assert.deepStrictEqual(monday.origin, {
        source: { kind: "schedule", label: "Schedule", url: null, key: null, workRef: null },
        ruleName: null,
      });
      yield* awaitChange(first.changes, (change) => change.sources);

      yield* first.stop;
      yield* Ref.set(h.profileExists, false);
      // Recover a task committed before the source's slot checkpoint was saved.
      yield* h.sql`UPDATE factory_intake_sources SET last_slot_at = ${DateTime.formatIso(DateTime.makeUnsafe(local(9, 8)))}, next_check_at = ${DateTime.formatIso(DateTime.makeUnsafe(local(9, 9, 1)))} WHERE source_id = ${saved.source!.id}`;
      const second = yield* h.start;
      yield* TestClock.adjust("1 minute");
      yield* awaitChange(second.changes, (change) => change.sources);
      assert.strictEqual((yield* second.intake.listSources({})).sources[0]?.status, "ok");
      assert.deepStrictEqual((yield* Ref.get(h.createCalls)).at(-1)?.input, monday.input);
      assert.strictEqual(yield* Queue.size(h.created), 0);
      // Wednesday is the next scheduled day; Tuesday is skipped.
      yield* TestClock.setTime(local(11, 9));
      yield* awaitChange(second.changes, (change) => change.sources);
      assert.deepStrictEqual((yield* Ref.get(h.createCalls)).at(-1)?.input.assignment, {
        mode: "unassigned",
      });
      const wednesday = yield* Queue.take(h.created);
      assert.deepStrictEqual(wednesday.input.assignment, { mode: "unassigned" });
      assert.notStrictEqual(wednesday.input.commandId, monday.input.commandId);
      const normalized = (yield* second.intake.listSources({})).sources[0]!;
      assert.strictEqual(normalized.config.kind, "schedule");
      if (normalized.config.kind === "schedule")
        assert.deepStrictEqual(normalized.config.task.assignment, { mode: "unassigned" });
      assert.strictEqual(normalized.version, saved.source!.version + 1);
      assert.strictEqual((yield* Ref.get(h.createCalls)).length, 4);
      assert.strictEqual(yield* Queue.size(h.created), 0);
    }),
);

it.effect("previewRule counts recorded arrivals of the last 30 days and fetches nothing", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake } = yield* h.start;
    yield* h.setIssues(projectId, [issue(1, "Old crash", ["bug"])]);
    const source = yield* connectIssues(intake, "connect");
    yield* setEnabled(intake, source, false);
    yield* TestClock.adjust(31 * DAY_MS);
    yield* h.setIssues(projectId, [issue(1, "Old crash", ["bug"]), issue(2, "New crash", ["bug"])]);
    yield* setEnabled(intake, source, true);
    const calls = yield* h.callsFor(projectId);
    const preview = (titleContains: string, labels: ReadonlyArray<string> = []) =>
      intake
        .previewRule({ match: { sourceId: source.id, labels, titleContains } })
        .pipe(Effect.map((result) => result.matchedLast30Days));
    assert.strictEqual(yield* preview("crash"), 1);
    assert.strictEqual(yield* preview("old"), 0);
    assert.strictEqual(yield* preview("new"), 1);
    assert.strictEqual(yield* preview("", ["BUG"]), 1);
    assert.strictEqual(yield* preview("", ["docs"]), 0);
    assert.strictEqual(yield* h.callsFor(projectId), calls);
  }),
);

it.effect("a disabled or deleted source is no longer checked", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake, changes } = yield* h.start;
    yield* h.setIssues(otherProjectId, [issue(1, "Kept after delete")]);
    const disabled = yield* connectIssues(intake, "connect-1");
    const deleted = yield* connectIssues(intake, "connect-2", otherProjectId);
    const control = yield* connectIssues(intake, "connect-3", thirdProjectId);
    const off = yield* intake.saveSource(
      {
        commandId: CommandId.make("disable"),
        id: disabled.id,
        expectedVersion: disabled.version,
        projectId,
        config: issuesConfig,
        enabled: false,
      },
      human,
    );
    assert.strictEqual(off.source?.enabled, false);
    yield* intake.deleteSource(
      { commandId: CommandId.make("delete"), id: deleted.id, expectedVersion: deleted.version },
      human,
    );
    yield* Queue.clear(changes);

    yield* TestClock.adjust("5 minutes");
    yield* awaitChange(changes, (change) => change.sources);
    assert.deepStrictEqual(
      [
        yield* h.callsFor(projectId),
        yield* h.callsFor(otherProjectId),
        yield* h.callsFor(thirdProjectId),
      ],
      [1, 1, 2],
    );
    assert.deepStrictEqual(
      (yield* intake.listSources({})).sources.map((source) => source.id),
      [disabled.id, control.id],
    );
    assert.deepStrictEqual(
      (yield* triage(intake)).items.map((arrival) => arrival.title),
      ["Kept after delete"],
    );

    const latest = (yield* intake.listSources({})).sources.find(
      (source) => source.id === control.id,
    )!;
    yield* intake.saveSource(
      {
        commandId: CommandId.make("disable-control"),
        id: control.id,
        expectedVersion: latest.version,
        projectId: thirdProjectId,
        config: issuesConfig,
        enabled: false,
      },
      human,
    );
    const scheduled = yield* h.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM factory_intake_sources WHERE next_check_at IS NOT NULL`;
    assert.strictEqual(scheduled[0]?.count, 0);
  }),
);

it.effect("a feed source reads through the feed service and waits for its refresh floor", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake } = yield* h.start;
    yield* Ref.update(h.feed, (state) => ({
      ...state,
      candidates: [feedCandidate("atom:1", "Vite 9 released")],
    }));
    const saved = yield* intake.saveSource(
      {
        commandId: CommandId.make("feed"),
        projectId,
        config: { kind: "feed", url: "https://news.example.org/feed.xml" },
        enabled: true,
      },
      human,
    );
    assert.deepStrictEqual(
      [saved.source?.label, saved.source?.detail, saved.source?.status],
      ["Release notes", "news.example.org", "ok"],
    );
    assert.deepStrictEqual(
      (yield* triage(intake)).items.map((arrival) => [
        arrival.label,
        arrival.title,
        arrival.sourceKind,
        arrival.body,
      ]),
      [["Feed", "Vite 9 released", "feed", "<p>Vite 9 released</p>"]],
    );
    const state = yield* Ref.get(h.feed);
    assert.deepStrictEqual([state.binds, state.refreshes], [1, 0]);
    const next = yield* h.sql<{ readonly next: string }>`
      SELECT next_check_at AS next FROM factory_intake_sources`;
    assert.strictEqual(next[0]?.next, "2030-01-01T00:00:00.000Z");

    const invalid = yield* Effect.flip(
      intake.saveSource(
        {
          commandId: CommandId.make("feed-http"),
          projectId,
          config: { kind: "feed", url: "http://news.example.org/other.xml" },
          enabled: true,
        },
        human,
      ),
    );
    assert.strictEqual(invalid.reason, "invalid-input");
  }),
);

it.effect("editing a feed URL binds the new URL and can return to the original binding", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const { intake } = yield* h.start;
    yield* Ref.update(h.feed, (state) => ({
      ...state,
      candidates: [feedCandidate("guid:1", "Feed A item")],
    }));
    const saved = yield* intake.saveSource(
      {
        commandId: CommandId.make("feed-a"),
        projectId,
        config: { kind: "feed", url: "https://news.example.org/a.xml" },
        enabled: true,
      },
      human,
    );
    let source = saved.source!;
    yield* h.sql`UPDATE factory_intake_arrivals SET item_key = ${"guid:1"} WHERE source_id = ${source.id}`;
    for (const [index, url] of [
      "https://news.example.org/b.xml",
      "https://news.example.org/a.xml",
    ].entries()) {
      yield* Ref.update(h.feed, (state) => ({
        ...state,
        candidates: [feedCandidate("guid:1", index === 0 ? "Feed B item" : "Feed A item")],
      }));
      const input = {
        commandId: CommandId.make(`edit-feed-${index}`),
        id: source.id,
        expectedVersion: source.version,
        projectId,
        config: { kind: "feed" as const, url },
        enabled: true,
      };
      source = (yield* intake.saveSource(input, human)).source!;
      assert.strictEqual(source.status, "ok");
      assert.strictEqual((yield* intake.saveSource(input, human)).replayed, true);
    }
    assert.strictEqual((yield* Ref.get(h.feed)).binds, 2);
    assert.deepStrictEqual(
      (yield* triage(intake)).items.map((arrival) => arrival.title),
      ["Feed B item", "Feed A item"],
    );
    assert.strictEqual((yield* recheck(intake, source)).source?.status, "ok");
  }),
);

it.effect("snooze expiry notifies open Inboxes after restart with no source checks", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const first = yield* h.start;
    yield* h.setIssues(projectId, [issue(1, "Return first"), issue(2, "Return later")]);
    const source = yield* connectIssues(first.intake, "connect");
    const arrivals = (yield* triage(first.intake)).items.toReversed();
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const [index, arrival] of arrivals.entries()) {
      yield* first.intake.resolveArrival(
        {
          commandId: CommandId.make(`snooze-${index}`),
          id: arrival.id,
          expectedVersion: arrival.version,
          action: {
            type: "snooze",
            until: DateTime.formatIso(DateTime.makeUnsafe(now + (index + 1) * 60_000)),
          },
        },
        human,
      );
    }
    const latest = (yield* first.intake.listSources({})).sources[0]!;
    yield* first.intake.deleteSource(
      { commandId: CommandId.make("delete"), id: source.id, expectedVersion: latest.version },
      human,
    );
    yield* first.stop;
    const second = yield* h.start;
    assert.strictEqual((yield* triage(second.intake)).waiting, 0);
    for (const expected of [1, 2]) {
      yield* TestClock.adjust("1 minute");
      const change = yield* Queue.take(second.changes);
      assert.deepStrictEqual(change, {
        environmentId,
        arrivals: true,
        rules: false,
        sources: false,
      });
      assert.strictEqual((yield* triage(second.intake)).waiting, expected);
      assert.strictEqual((yield* triage(second.intake)).items.length, expected);
    }
    const returned = (yield* triage(second.intake)).items[0]!;
    yield* second.intake.resolveArrival(
      {
        commandId: CommandId.make("snooze-again"),
        id: returned.id,
        expectedVersion: returned.version,
        action: {
          type: "snooze",
          until: DateTime.formatIso(DateTime.makeUnsafe(now + 3 * 60_000)),
        },
      },
      human,
    );
    yield* Queue.take(second.changes);
    yield* TestClock.adjust("1 minute");
    assert.strictEqual((yield* Queue.take(second.changes)).arrivals, true);
    assert.strictEqual((yield* triage(second.intake)).waiting, 2);
    assert.strictEqual(yield* h.callsFor(projectId), 1);
  }),
);

it.effect("unsnooze restores a persisted arrival with version checks and command replay", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const first = yield* h.start;
    yield* h.setIssues(projectId, [issue(1, "Bring me back")]);
    const source = yield* connectIssues(first.intake, "connect");
    yield* setEnabled(first.intake, source, false);
    const arrival = (yield* triage(first.intake)).items[0]!;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const snoozed = yield* first.intake.resolveArrival(
      {
        commandId: CommandId.make("snooze"),
        id: arrival.id,
        expectedVersion: arrival.version,
        action: { type: "snooze", until: DateTime.formatIso(DateTime.makeUnsafe(now + DAY_MS)) },
      },
      human,
    );
    yield* first.stop;
    const { intake, changes } = yield* h.start;
    const [persisted] = (yield* intake.listArrivals({ states: ["snoozed"] })).items;
    assert.strictEqual(persisted?.id, arrival.id);
    const input = {
      commandId: CommandId.make("unsnooze"),
      id: arrival.id,
      expectedVersion: snoozed.arrival.version,
      action: { type: "unsnooze" as const },
    };
    const stale = yield* Effect.flip(
      intake.resolveArrival({ ...input, expectedVersion: arrival.version }, human),
    );
    assert.strictEqual(stale.reason, "version-conflict");
    const restored = yield* intake.resolveArrival(input, human);
    assert.strictEqual(restored.arrival.state, "new");
    assert.strictEqual(restored.arrival.snoozedUntil, null);
    assert.strictEqual(restored.arrival.version, snoozed.arrival.version + 1);
    assert.strictEqual(restored.task, null);
    assert.deepStrictEqual(yield* Queue.take(changes), {
      environmentId,
      arrivals: true,
      rules: false,
      sources: false,
    });
    assert.strictEqual((yield* triage(intake)).waiting, 1);
    assert.strictEqual((yield* intake.listArrivals({ states: ["snoozed"] })).items.length, 0);
    assert.strictEqual((yield* intake.resolveArrival(input, human)).replayed, true);
    const conflict = yield* Effect.flip(
      intake.resolveArrival({ ...input, action: { type: "decline" } }, human),
    );
    assert.strictEqual(conflict.reason, "command-conflict");
    const invalid = yield* Effect.flip(
      intake.resolveArrival(
        {
          ...input,
          commandId: CommandId.make("unsnooze-new"),
          expectedVersion: restored.arrival.version,
        },
        human,
      ),
    );
    assert.strictEqual(invalid.reason, "invalid-input");
    assert.strictEqual((yield* Ref.get(h.createCalls)).length, 0);
  }),
);
