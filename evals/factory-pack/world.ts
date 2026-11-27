import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  FactoryArtifact,
  FactoryAttempt,
  FactoryNote,
  FactoryReceipt,
  FactoryReviewRound,
  FactoryTask,
  PullRequestDetail,
  type WorkflowRunsSnapshot,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { runMigrations } from "../../apps/server/src/persistence/Migrations.ts";
import { RunContext, type WorkflowDefinition } from "../../apps/server/src/workflows/workflow.ts";
import { KeyValues } from "../../apps/server/src/workflows/stepServices.ts";
import * as WorkflowAgents from "../../apps/server/src/workflows/WorkflowAgents.ts";
import * as WorkflowEngine from "../../apps/server/src/workflows/WorkflowEngine.ts";
import * as WorkflowForge from "../../apps/server/src/workflows/WorkflowForge.ts";
import {
  loadDefinitions,
  type WorkflowDefinitionsLoadError,
} from "../../apps/server/src/workflows/WorkflowRuntime.ts";
import * as Workflows from "../../apps/server/src/workflows/Workflows.ts";

export type AgentTurnInput = Parameters<WorkflowAgents.WorkflowAgents["Service"]["start"]>[0];
type InterruptTarget = Parameters<WorkflowAgents.WorkflowAgents["Service"]["interrupt"]>[0];
type Forge = WorkflowForge.WorkflowForge["Service"];
type Service = Workflows.Workflows["Service"];

export interface World {
  readonly definitions: ReadonlyArray<WorkflowDefinition>;
  readonly turns: ReadonlyArray<AgentTurnInput>;
  readonly startAttempts: ReadonlyArray<AgentTurnInput>;
  readonly interrupts: ReadonlyArray<InterruptTarget>;
  readonly acts: ReadonlyArray<Parameters<Forge["pullRequests"]["act"]>>;
  readonly readCalls: ReadonlyArray<WorkflowForge.PullRequestAddress>;
  readonly reads: ReadonlyArray<{
    readonly pullRequest: WorkflowForge.PullRequestAddress;
    readonly standing: WorkflowForge.PullRequestStanding;
  }>;
  readonly prComments: ReadonlyArray<{
    readonly pullRequest: WorkflowForge.PullRequestAddress;
    readonly body: string;
  }>;
  readonly issueQueries: ReadonlyArray<WorkflowForge.IssueQuery>;
  readonly pullRequestQueries: ReadonlyArray<WorkflowForge.PullRequestQuery>;
  readonly activeCounts: ReadonlyArray<number>;
  readonly nextTurn: Effect.Effect<AgentTurnInput>;
  readonly releaseTurn: (turn: AgentTurnInput) => Effect.Effect<void>;
  readonly finishExecutions: ReadonlyArray<string>;
  readonly startExecutions: ReadonlyArray<string>;
  readonly validateRecords: (
    workflows: Service,
  ) => Effect.Effect<void, Workflows.WorkflowInputError>;
  readonly expireQuestion: (workflows: Service, runId: string, name: string) => Effect.Effect<void>;
  readonly questions: ReadonlyArray<Workflows.WorkflowQuestion>;
  readonly tagHistory: ReadonlyArray<{
    readonly runId: string;
    readonly tags: ReadonlyArray<string>;
  }>;
  readonly server: <A, E>(
    use: (workflows: Service) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | WorkflowDefinitionsLoadError>;
  readonly question: (
    workflows: Service,
    runId: string,
  ) => Effect.Effect<Workflows.WorkflowQuestion>;
  readonly child: (
    workflows: Service,
    parentRunId: string,
    part: number,
  ) => Effect.Effect<WorkflowRunsSnapshot["runs"][number]>;
  readonly ended: (
    workflows: Service,
    runId: string,
    noQuestions?: boolean,
  ) => Effect.Effect<WorkflowRunsSnapshot["runs"][number]>;
}

interface Script {
  readonly agent: (turn: AgentTurnInput) => Partial<WorkflowAgents.AgentResult>;
  readonly standing: (
    pullRequest: WorkflowForge.PullRequestAddress,
    read: number,
  ) => WorkflowForge.PullRequestStanding;
  readonly issues?: ReadonlyArray<WorkflowForge.Issue>;
  readonly listIssues?: Forge["issues"]["list"];
  readonly readIssue?: Forge["issues"]["read"];
  readonly commentIssue?: Forge["issues"]["comment"];
  readonly pullRequests?: ReadonlyArray<WorkflowForge.PullRequest>;
  readonly listPullRequests?: Forge["pullRequests"]["list"];
  readonly readPullRequest?: (
    address: WorkflowForge.PullRequestAddress,
    detail: PullRequestDetail,
  ) => ReturnType<Forge["pullRequests"]["read"]>;
  readonly holdAgent?: (turn: AgentTurnInput) => boolean;
  readonly startError?: (turn: AgentTurnInput) => string | undefined;
  readonly startedIn?: (turn: AgentTurnInput) => string | null;
  readonly resultError?: (turn: AgentTurnInput, read: number) => string | undefined;
  readonly interrupt?: (target: InterruptTarget) => "stopped" | "ended" | { error: string };
  readonly failFinishAfterCommit?: boolean;
  readonly failStartAfterCommit?: boolean;
  readonly failIssueCapture?: { readonly projectId: string; readonly issueKey: string };
}

const decodePullRequestDetail = Schema.decodeSync(PullRequestDetail);
const decodeTaskRecord = Schema.decodeUnknownEffect(FactoryTask);
const decodeAttemptRecord = Schema.decodeUnknownEffect(FactoryAttempt);
const decodeAttemptJson = Schema.decodeUnknownOption(Schema.fromJsonString(FactoryAttempt));
const decodeNoteRecord = Schema.decodeUnknownEffect(FactoryNote);
const decodeArtifactRecord = Schema.decodeUnknownEffect(FactoryArtifact);
const decodeReceiptRecord = Schema.decodeUnknownEffect(FactoryReceipt);
const decodeReviewRound = Schema.decodeUnknownEffect(FactoryReviewRound);

const validateRecords = Effect.fn("factoryPack.validateRecords")(function* (workflows: Service) {
  for (const row of yield* workflows.stored("factory/v1/task/")) {
    yield* decodeTaskRecord(row.value).pipe(Effect.orDie);
  }
  for (const row of yield* workflows.stored("factory/v1/attempt/")) {
    yield* decodeAttemptRecord(row.value).pipe(Effect.orDie);
  }
  for (const row of yield* workflows.stored("factory/v1/note/")) {
    yield* decodeNoteRecord(row.value).pipe(Effect.orDie);
  }
  for (const row of yield* workflows.stored("factory/v1/artifact/")) {
    yield* decodeArtifactRecord(row.value).pipe(Effect.orDie);
  }
  for (const row of yield* workflows.stored("factory/v1/receipt/")) {
    yield* decodeReceiptRecord(row.value).pipe(Effect.orDie);
  }
  for (const row of yield* workflows.stored("factory/v1/ledger/")) {
    yield* decodeReviewRound(row.value).pipe(Effect.orDie);
  }
  // Pack modules use the globals installed by loadDefinitions, not a second Effect runtime.
  const { Outcome, Metrics } = yield* Effect.promise(
    () => import("../../factory/workflows/lib/metrics.ts"),
  );
  for (const [prefix, schema] of [
    ["outcome", Outcome],
    ["metrics", Metrics],
  ] as const) {
    const decode = Schema.decodeUnknownEffect(schema);
    for (const row of yield* workflows.stored(`factory/v1/${prefix}/`)) {
      yield* decode(row.value).pipe(Effect.orDie);
    }
  }
});

const detailOf = (standing: WorkflowForge.PullRequestStanding) =>
  decodePullRequestDetail({
    provider: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge"],
      mergeMethods: ["squash"],
      search: true,
      review: { inlineComment: true, reply: true, resolve: true, verdicts: ["approve"] },
      reviewers: { request: true, listCandidates: true },
    },
    viewerPermissions: {
      actions: ["merge"],
      comment: true,
      resolve: true,
      verdicts: ["approve"],
      requestReviewers: true,
    },
    projectId: "project-1",
    projectTitle: "Factory pack test",
    workspaceRoot: "/factory-pack-test",
    repository: "factory/pack",
    number: 1,
    title: "Implement the part",
    body: "",
    url: standing.url,
    author: null,
    state: standing.state,
    isDraft: false,
    mergeability: standing.mergeability,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    headSha: "sha-default",
    headBranch: "factory-part",
    baseBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    mergedAt: standing.state === "merged" ? "2026-01-01T00:00:00.000Z" : null,
    closedAt: standing.state === "closed" ? "2026-01-01T00:00:00.000Z" : null,
    reviewers: [],
    labels: [],
    checks:
      standing.checks === "none"
        ? []
        : [
            {
              name: "test",
              status:
                standing.checks === "passing"
                  ? "success"
                  : standing.checks === "failing"
                    ? "failure"
                    : "pending",
              description: null,
              url: null,
              required: true,
            },
          ],
    mergeCapabilities: { merge: false, squash: true, rebase: false },
  });

const JsonKey = Schema.fromJsonString(Schema.Json);
const encodeKey = Schema.encodeEffect(JsonKey);

// Each lifetime must have a new import address, including lifetimes in other test cases.
let loads = 0;

const makeWorld = Effect.fn("factoryPack.world")(function* (script: Script) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-factory-pack-" });
  // The server's own journal settings (persistence/Sqlite.ts); the defaults fsync every commit.
  const database = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* sql`PRAGMA synchronous = NORMAL;`;
    }),
  ).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") })),
    Layer.orDie,
  );
  yield* runMigrations().pipe(Effect.provide(database));

  const definitions: Array<WorkflowDefinition> = [];
  const turns: Array<AgentTurnInput> = [];
  const startAttempts: Array<AgentTurnInput> = [];
  const interrupts: Array<InterruptTarget> = [];
  const resultReads = new Map<string, number>();
  const started = new Map<string, AgentTurnInput>();
  const acts: Array<Parameters<Forge["pullRequests"]["act"]>> = [];
  const readCalls: Array<WorkflowForge.PullRequestAddress> = [];
  const reads: Array<{
    readonly pullRequest: WorkflowForge.PullRequestAddress;
    readonly standing: WorkflowForge.PullRequestStanding;
  }> = [];
  const prComments: Array<{
    readonly pullRequest: WorkflowForge.PullRequestAddress;
    readonly body: string;
  }> = [];
  const issueQueries: Array<WorkflowForge.IssueQuery> = [];
  const pullRequestQueries: Array<WorkflowForge.PullRequestQuery> = [];
  const turnStarts = yield* Queue.unbounded<AgentTurnInput>();
  const gates = new Map<string, Deferred.Deferred<void>>();
  const active = new Set<string>();
  const activeCounts: Array<number> = [];
  const finishExecutions: Array<string> = [];
  let failFinish = script.failFinishAfterCommit === true;
  const startExecutions: Array<string> = [];
  let failStart = script.failStartAfterCommit === true;
  const questions: Array<Workflows.WorkflowQuestion> = [];
  const tagHistory: Array<{ readonly runId: string; readonly tags: ReadonlyArray<string> }> = [];
  const questionKeys = new Set<string>();
  const latestTags = new Map<string, string>();
  const readCounts = new Map<string, number>();
  let latestHeadSha: string | undefined;

  const rememberRun = (run: WorkflowRunsSnapshot["runs"][number]) => {
    if (run.tags === undefined || run.tags.length === 0) return;
    const key = JSON.stringify(run.tags);
    if (latestTags.get(run.runId) === key) return;
    latestTags.set(run.runId, key);
    tagHistory.push({ runId: run.runId, tags: run.tags });
  };

  const remember = (snapshot: WorkflowRunsSnapshot) => {
    for (const question of snapshot.questions) {
      const key = JSON.stringify([question.runId, question.name, question.askedAt]);
      if (!questionKeys.has(key)) {
        questionKeys.add(key);
        questions.push(question);
      }
    }
    for (const run of snapshot.runs) rememberRun(run);
  };

  const releaseTurn = Effect.fn("factoryPack.releaseTurn")(function* (turn: AgentTurnInput) {
    const gate = gates.get(turn.key);
    if (gate === undefined) return yield* Effect.die(new Error(`Turn is not held: ${turn.key}`));
    yield* Deferred.succeed(gate, undefined);
  });

  const expireQuestion = Effect.fn("factoryPack.expireQuestion")(function* (
    workflows: Service,
    runId: string,
    name: string,
  ) {
    // The real sweep delivers the timeout; only its persisted deadline is brought forward.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE workflow_waits SET deadline = '2000-01-01T00:00:00.000Z'
        WHERE run_id = ${runId} AND name = ${name}`;
    }).pipe(Effect.provide(database), Effect.orDie);
    yield* workflows.sweep;
  });

  const injectFinishFailure = (definition: WorkflowDefinition): WorkflowDefinition => ({
    ...definition,
    body: Effect.fn("factoryPack.injectFinishFailure")(function* (payload, run) {
      const context = yield* RunContext;
      return yield* definition.body(payload, run).pipe(
        Effect.provideService(RunContext, {
          ...context,
          forStep: (name) => {
            const services = context.forStep(name);
            if (name !== "finish") return services;
            finishExecutions.push(context.runId);
            const values = Context.get(services, KeyValues);
            return Context.add(services, KeyValues, {
              ...values,
              transaction: Effect.fn("factoryPack.finishTransaction")(function* <A, E, R>(
                effect: Effect.Effect<A, E, R>,
              ) {
                const result = yield* values.transaction(effect);
                if (failFinish) {
                  failFinish = false;
                  return yield* Effect.die(new Error("Injected failure after finish committed"));
                }
                return result;
              }),
            });
          },
        }),
      );
    }),
  });

  const injectStartFailure = (definition: WorkflowDefinition): WorkflowDefinition => ({
    ...definition,
    body: Effect.fn("factoryPack.injectStartFailure")(function* (payload, run) {
      const context = yield* RunContext;
      return yield* definition.body(payload, run).pipe(
        Effect.provideService(RunContext, {
          ...context,
          forStep: (name) => {
            const services = context.forStep(name);
            if (name !== "start") return services;
            startExecutions.push(context.runId);
            const values = Context.get(services, KeyValues);
            let depth = 0;
            let attemptCommitted = false;
            // Dies once, after the write that gives the attempt its run commits: the gap
            // between starting the task and the step recording its result.
            const failOnce = Effect.suspend(() => {
              if (!attemptCommitted || !failStart) return Effect.void;
              failStart = false;
              return Effect.die(new Error("Injected failure after start committed"));
            });
            return Context.add(services, KeyValues, {
              ...values,
              set: Effect.fn("factoryPack.startWrite")(function* (key, valueJson) {
                yield* values.set(key, valueJson);
                const attempt = decodeAttemptJson(valueJson);
                if (
                  key.startsWith("factory/v1/attempt/") &&
                  Option.isSome(attempt) &&
                  attempt.value.runId !== null
                ) {
                  attemptCommitted = true;
                }
                if (depth === 0) yield* failOnce;
              }),
              transaction: Effect.fn("factoryPack.startTransaction")(function* <A, E, R>(
                effect: Effect.Effect<A, E, R>,
              ) {
                depth++;
                const result = yield* values.transaction(effect).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      depth--;
                    }),
                  ),
                );
                if (depth === 0) yield* failOnce;
                return result;
              }),
            });
          },
        }),
      );
    }),
  });

  const injectIssueFailure = (definition: WorkflowDefinition): WorkflowDefinition => ({
    ...definition,
    body: Effect.fn("factoryPack.injectIssueFailure")(function* (payload, run) {
      const context = yield* RunContext;
      const failure = script.failIssueCapture;
      return yield* definition.body(payload, run).pipe(
        Effect.provideService(RunContext, {
          ...context,
          forStep: (name) => {
            const services = context.forStep(name);
            const values = Context.get(services, KeyValues);
            return Context.add(services, KeyValues, {
              ...values,
              set: Effect.fn("factoryPack.issueCaptureWrite")(function* (key, valueJson) {
                if (
                  failure !== undefined &&
                  key === `factory/v1/intake-seen/${failure.projectId}/${failure.issueKey}`
                ) {
                  return yield* Effect.die(new Error("Injected issue capture write failure"));
                }
                return yield* values.set(key, valueJson);
              }),
            });
          },
        }),
      );
    }),
  });

  const agents = WorkflowAgents.WorkflowAgents.of({
    start: Effect.fn("factoryPack.agents.start")(function* (input) {
      startAttempts.push(input);
      const reason = script.startError?.(input);
      if (reason !== undefined) return yield* new WorkflowAgents.WorkflowAgentError({ reason });
      turns.push(input);
      started.set(input.key, input);
      active.add(input.key);
      activeCounts.push(active.size);
      if (script.holdAgent?.(input)) gates.set(input.key, yield* Deferred.make<void>());
      yield* Queue.offer(turnStarts, input);
      const environment =
        script.startedIn === undefined ? input.environment : script.startedIn(input);
      return yield* Effect.succeed({
        threadId: input.thread ?? `thread-${input.key}`,
        turnId: input.key,
        ...(environment == null ? {} : { environment }),
      });
    }),
    result: Effect.fn("factoryPack.agents.result")(function* (turn) {
      const input = started.get(turn.turnId);
      if (input === undefined) return yield* Effect.die(new Error(`Unknown turn ${turn.turnId}`));
      if (script.resultError !== undefined) {
        const read = resultReads.get(turn.turnId) ?? 0;
        resultReads.set(turn.turnId, read + 1);
        const reason = script.resultError(input, read);
        if (reason !== undefined) return yield* new WorkflowAgents.WorkflowAgentError({ reason });
      }
      const gate = gates.get(input.key);
      if (gate !== undefined) yield* Deferred.await(gate);
      return yield* Effect.sync(() => {
        const result = script.agent(input);
        return {
          ending: "completed" as const,
          detail: "",
          reply: "Fixed checks and review feedback.",
          ...result,
          ...(input.origin.step.startsWith("scope/") && result.output === undefined
            ? {
                output: {
                  report: { headSha: latestHeadSha ?? "sha-default", files: ["src/part.ts"] },
                },
              }
            : {}),
        };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active.delete(input.key);
          }),
        ),
      );
    }),
    interrupt: Effect.fn("factoryPack.agents.interrupt")(function* (target) {
      interrupts.push(target);
      const result = script.interrupt?.(target) ?? "ended";
      if (typeof result === "object") {
        return yield* new WorkflowAgents.WorkflowAgentError({ reason: result.error });
      }
      if (target.turnId !== undefined) active.delete(target.turnId);
      return result;
    }),
  });
  const forge = WorkflowForge.WorkflowForge.of({
    ...WorkflowForge.unavailable,
    issues: {
      ...WorkflowForge.unavailable.issues,
      list: Effect.fn("factoryPack.issues.list")(function* (query) {
        issueQueries.push(query);
        return yield* script.listIssues === undefined
          ? Effect.succeed(script.issues ?? [])
          : script.listIssues(query);
      }),
      read: script.readIssue ?? WorkflowForge.unavailable.issues.read,
      comment: script.commentIssue ?? WorkflowForge.unavailable.issues.comment,
    },
    pullRequests: {
      ...WorkflowForge.unavailable.pullRequests,
      list: Effect.fn("factoryPack.pullRequests.list")(function* (query) {
        pullRequestQueries.push(query);
        return yield* script.listPullRequests === undefined
          ? Effect.succeed(script.pullRequests ?? [])
          : script.listPullRequests(query);
      }),
      read: Effect.fn("factoryPack.pullRequests.read")(function* (pullRequest) {
        readCalls.push(pullRequest);
        const key = yield* encodeKey(pullRequest).pipe(Effect.orDie);
        const index = readCounts.get(key) ?? 0;
        readCounts.set(key, index + 1);
        const standing = script.standing(pullRequest, index);
        const detail =
          script.readPullRequest === undefined
            ? detailOf(standing)
            : yield* script.readPullRequest(pullRequest, detailOf(standing));
        latestHeadSha = detail.headSha;
        reads.push({ pullRequest, standing: WorkflowForge.standingOf(detail) });
        return detail;
      }),
      comment: Effect.fn("factoryPack.pullRequests.comment")(function* (pullRequest, body) {
        prComments.push({ pullRequest, body });
        return yield* Effect.void;
      }),
      act: Effect.fn("factoryPack.pullRequests.act")(function* (...input) {
        acts.push(input);
        return yield* Effect.void;
      }),
    },
  });

  const server = Effect.fn("factoryPack.server")(function* <A, E>(
    use: (workflows: Service) => Effect.Effect<A, E>,
  ) {
    const loaded: Array<WorkflowDefinition> = [];
    // Every workflow file the pack ships, so a new one is loaded with no list to keep.
    const directory = path.resolve(import.meta.dirname, "../../factory/workflows");
    const names = (yield* fileSystem.readDirectory(directory).pipe(Effect.orDie))
      .filter((name) => name.endsWith(".ts"))
      .sort();
    for (const name of names) {
      loaded.push(
        ...(yield* loadDefinitions(path.resolve(directory, name), ++loads).pipe(
          Effect.provideService(Path.Path, path),
        )),
      );
    }
    if (script.failFinishAfterCommit) {
      const taskIndex = loaded.findIndex((definition) => definition.name === "factory-task");
      const definition = loaded[taskIndex];
      if (definition !== undefined) loaded[taskIndex] = injectFinishFailure(definition);
    }
    if (script.failStartAfterCommit) {
      for (const name of ["factory-start", "factory-capture"]) {
        const index = loaded.findIndex((definition) => definition.name === name);
        const definition = loaded[index];
        if (definition !== undefined) loaded[index] = injectStartFailure(definition);
      }
    }
    if (script.failIssueCapture !== undefined) {
      const intakeIndex = loaded.findIndex((definition) => definition.name === "factory-intake");
      const definition = loaded[intakeIndex];
      if (definition !== undefined) loaded[intakeIndex] = injectIssueFailure(definition);
    }
    definitions.splice(0, definitions.length, ...loaded);
    const engine = WorkflowEngine.layer(loaded).pipe(
      Layer.provide(Layer.succeed(WorkflowAgents.WorkflowAgents, agents)),
      Layer.provide(Layer.succeed(WorkflowForge.WorkflowForge, forge)),
      Layer.provide(database),
      Layer.provide(NodeCrypto.layer),
      Layer.orDie,
    );
    return yield* Effect.gen(function* () {
      const workflows = yield* Workflows.Workflows;
      const ready = yield* Deferred.make<void>();
      const swept = new Set<string>();
      yield* Workflows.wholeLists(workflows.watch).pipe(
        Stream.runForEach(
          Effect.fn("factoryPack.observe")(function* (snapshot) {
            remember(snapshot);
            yield* Deferred.succeed(ready, undefined);
            const waiting = snapshot.runs.filter(
              (run) =>
                run.status === "waiting" &&
                /^(?:checks\/x?\d+(?:\/again)?|merge-wait)$/.test(run.detail ?? ""),
            );
            for (const run of waiting) {
              const key = yield* encodeKey([run.runId, run.detail]).pipe(Effect.orDie);
              if (swept.has(key)) continue;
              swept.add(key);
              // A newly opened check wait drives one sweep, without clock advances or polling.
              yield* workflows.sweep;
            }
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      const result = yield* use(workflows);
      yield* validateRecords(workflows).pipe(Effect.orDie);
      remember(Option.getOrThrow(yield* Stream.runHead(Workflows.wholeLists(workflows.watch))));
      return result;
    }).pipe(Effect.provide(engine), Effect.scoped);
  });

  const question = Effect.fn("factoryPack.question")(function* (workflows: Service, runId: string) {
    return yield* Workflows.wholeLists(workflows.watch).pipe(
      Stream.filterMap((snapshot) => {
        remember(snapshot);
        const asked = snapshot.questions.find((entry) => entry.runId === runId);
        if (asked !== undefined) return Result.succeed(asked);
        const run = snapshot.runs.find((entry) => entry.runId === runId);
        if (run !== undefined && (run.status === "paused" || run.endedAt !== null)) {
          throw new Error(`Expected a question; ${run.workflow} is ${run.status}: ${run.detail}`);
        }
        return Result.failVoid;
      }),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  });

  const child = Effect.fn("factoryPack.child")(function* (
    workflows: Service,
    parentRunId: string,
    part: number,
  ) {
    return yield* Workflows.wholeLists(workflows.watch).pipe(
      Stream.filterMap((snapshot) => {
        remember(snapshot);
        const found = snapshot.runs.find(
          (run) => run.parentRunId === parentRunId && run.parentStep === `part-${part}`,
        );
        if (found !== undefined) return Result.succeed(found);
        const parent = snapshot.runs.find((run) => run.runId === parentRunId);
        if (parent !== undefined && (parent.status === "paused" || parent.endedAt !== null)) {
          throw new Error(`Expected part-${part}; parent is ${parent.status}: ${parent.detail}`);
        }
        return Result.failVoid;
      }),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  });

  const ended = Effect.fn("factoryPack.ended")(function* (
    workflows: Service,
    runId: string,
    noQuestions = false,
  ) {
    const guard = Workflows.wholeLists(workflows.watch).pipe(
      Stream.runForEach((snapshot) =>
        Effect.sync(() => {
          remember(snapshot);
          const paused = snapshot.runs.find((run) => run.status === "paused");
          if (paused !== undefined) {
            throw new Error(`${paused.workflow} paused: ${paused.detail}`);
          }
          if (noQuestions && snapshot.questions.length > 0) {
            throw new Error(`Unexpected question: ${snapshot.questions[0]?.name}`);
          }
        }),
      ),
      Effect.andThen(Effect.never),
    );
    return yield* workflows
      .waitFor(runId, (run) => run.endedAt !== null || run.status === "paused")
      .pipe(
        Effect.raceFirst(guard),
        Effect.tap((run) => Effect.sync(() => rememberRun(run))),
      );
  });

  return {
    definitions,
    turns,
    startAttempts,
    interrupts,
    acts,
    readCalls,
    reads,
    prComments,
    issueQueries,
    pullRequestQueries,
    activeCounts,
    nextTurn: Queue.take(turnStarts),
    releaseTurn,
    finishExecutions,
    startExecutions,
    validateRecords,
    expireQuestion,
    questions,
    tagHistory,
    server,
    question,
    child,
    ended,
  } satisfies World;
});

export const withWorld = <A, E>(script: Script, check: (world: World) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    makeWorld(script).pipe(
      Effect.flatMap(check),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
