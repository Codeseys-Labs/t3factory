import {
  CommandId,
  FactoryIntakeArrivalResolveInput,
  FactoryIntakeError,
  FactoryIntakeRuleDeleteInput,
  FactoryIntakeRuleSaveInput,
  FactoryIntakeSourceConfig,
  FactoryIntakeSourceDeleteInput,
  FactoryIntakeSourceSaveInput,
  FactoryTaskSummary,
  type FactoryIntakeArrival,
  type FactoryIntakeArrivalListInput,
  type FactoryIntakeArrivalListResult,
  type FactoryIntakeArrivalResolveResult,
  type FactoryIntakeChange,
  type FactoryIntakeRuleListResult,
  type FactoryIntakeRuleMatch,
  type FactoryIntakeRuleMutationResult,
  type FactoryIntakeRulePreviewInput,
  type FactoryIntakeRulePreviewResult,
  type FactoryIntakeSource,
  type FactoryIntakeSourceListInput,
  type FactoryIntakeSourceListResult,
  type FactoryIntakeSourceMutationResult,
  type FactoryTaskAssignee,
  FactoryTaskAssignment,
  type FactoryTaskError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Store from "../persistence/FactoryIntakeStore.ts";
import * as Projects from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Feeds from "./FactoryFeedService.ts";
import { latestSlotAtOrBefore, nextSlotAfter } from "./FactoryIntakeSchedule.ts";
import * as Issues from "./FactoryIssueService.ts";
import { feedItemOriginKey, issueOriginKey } from "./FactoryOriginKey.ts";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";
import * as Tasks from "./FactoryTaskService.ts";
import * as FeedFetch from "./FeedFetch.ts";

const ISSUE_CHECK_INTERVAL_MS = 5 * 60_000;
const FEED_CHECK_INTERVAL_MS = 15 * 60_000;
const FAILED_CHECK_RETRY_MS = 15 * 60_000;
const SCHEDULE_RETRY_MS = 5 * 60_000;
const LOOP_FAILURE_PAUSE = Duration.minutes(1);
const PREVIEW_WINDOW_MS = 30 * 24 * 60 * 60_000;
const MAX_SOURCES = 128;
const MAX_RULES = 128;
const DEFAULT_ARRIVAL_LIMIT = 50;
const TITLE_MAX = 512;
const BODY_MAX = 8000;
const LABEL_MAX = 128;
const LABELS_MAX = 32;
const URL_MAX = 2048;

export class FactoryIntakeService extends Context.Service<
  FactoryIntakeService,
  {
    readonly listSources: (
      input: FactoryIntakeSourceListInput,
    ) => Effect.Effect<FactoryIntakeSourceListResult, FactoryIntakeError>;
    readonly saveSource: (
      input: FactoryIntakeSourceSaveInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryIntakeSourceMutationResult, FactoryIntakeError>;
    readonly deleteSource: (
      input: FactoryIntakeSourceDeleteInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryIntakeSourceMutationResult, FactoryIntakeError>;
    readonly listRules: () => Effect.Effect<FactoryIntakeRuleListResult, FactoryIntakeError>;
    readonly saveRule: (
      input: FactoryIntakeRuleSaveInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryIntakeRuleMutationResult, FactoryIntakeError>;
    readonly deleteRule: (
      input: FactoryIntakeRuleDeleteInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryIntakeRuleMutationResult, FactoryIntakeError>;
    readonly previewRule: (
      input: FactoryIntakeRulePreviewInput,
    ) => Effect.Effect<FactoryIntakeRulePreviewResult, FactoryIntakeError>;
    readonly listArrivals: (
      input: FactoryIntakeArrivalListInput,
    ) => Effect.Effect<FactoryIntakeArrivalListResult, FactoryIntakeError>;
    readonly resolveArrival: (
      input: FactoryIntakeArrivalResolveInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryIntakeArrivalResolveResult, FactoryIntakeError>;
    /** One element per committed change. Never replays the past. */
    readonly changes: Stream.Stream<FactoryIntakeChange>;
  }
>()("t3/factory/FactoryIntakeService") {}

const IdReceipt = Schema.fromJsonString(Schema.Struct({ id: Schema.NullOr(Schema.String) }));
const ArrivalReceipt = Schema.fromJsonString(
  Schema.Struct({ arrivalId: Schema.String, task: Schema.NullOr(FactoryTaskSummary) }),
);
const ArrivalCursor = Schema.fromJsonString(
  Schema.Struct({ arrivedAt: Schema.String, seq: Schema.Number, filter: Schema.String }),
);
const CursorFilter = Schema.fromJsonString(
  Schema.Struct({
    projectIds: Schema.NullOr(Schema.Array(Schema.String)),
    states: Schema.NullOr(Schema.Array(Schema.String)),
  }),
);
const encodeIdReceipt = Schema.encodeSync(IdReceipt);
const decodeIdReceipt = Schema.decodeUnknownEffect(IdReceipt);
const encodeArrivalReceipt = Schema.encodeSync(ArrivalReceipt);
const decodeArrivalReceipt = Schema.decodeUnknownEffect(ArrivalReceipt);
const encodeCursor = Schema.encodeSync(ArrivalCursor);
const decodeCursor = Schema.decodeUnknownEffect(ArrivalCursor);
const encodeCursorFilter = Schema.encodeSync(CursorFilter);
const encodeAssignment = Schema.encodeSync(Schema.fromJsonString(FactoryTaskAssignment));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(FactoryIntakeSourceConfig));
const commandPayloads = {
  saveSource: Schema.encodeSync(Schema.fromJsonString(FactoryIntakeSourceSaveInput)),
  deleteSource: Schema.encodeSync(Schema.fromJsonString(FactoryIntakeSourceDeleteInput)),
  saveRule: Schema.encodeSync(Schema.fromJsonString(FactoryIntakeRuleSaveInput)),
  deleteRule: Schema.encodeSync(Schema.fromJsonString(FactoryIntakeRuleDeleteInput)),
  resolveArrival: Schema.encodeSync(Schema.fromJsonString(FactoryIntakeArrivalResolveInput)),
};
type CommandOperation = keyof typeof commandPayloads;

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const millisOf = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
const intakeError = (reason: FactoryIntakeError["reason"], currentVersion?: number) =>
  new FactoryIntakeError(currentVersion === undefined ? { reason } : { reason, currentVersion });

// Cuts on a UTF-16 boundary so a surrogate pair is never split.
const bounded = (text: string, max: number) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/** Labels match any-of and case-insensitively; empty criteria match every item. */
const ruleMatches = (
  match: Pick<FactoryIntakeRuleMatch, "labels" | "titleContains">,
  item: { readonly title: string; readonly labels: ReadonlyArray<string> },
) => {
  const labels = new Set(item.labels.map((label) => label.toLowerCase()));
  return (
    (match.labels.length === 0 || match.labels.some((label) => labels.has(label.toLowerCase()))) &&
    item.title.toLowerCase().includes(match.titleContains.toLowerCase())
  );
};

const initialDescription = (config: FactoryIntakeSourceConfig) => {
  switch (config.kind) {
    case "issues":
      return { label: "Issues", detail: "" };
    case "feed":
      return {
        label: "Feed",
        detail: URL.canParse(config.url) ? new URL(config.url).hostname : "",
      };
    case "schedule":
      return { label: "Schedule", detail: "" };
  }
};

const intakeReasonForTask = (reason: FactoryTaskError["reason"]): FactoryIntakeError["reason"] => {
  switch (reason) {
    case "wrong-environment":
    case "missing-project":
    case "missing-task":
    case "forbidden":
    case "command-conflict":
    case "persistence-failure":
      return reason;
    default:
      return "invalid-input";
  }
};
const taskFailure = (cause: FactoryTaskError) =>
  new FactoryIntakeError({ reason: intakeReasonForTask(cause.reason), cause });

// Only used when the task service cannot resolve a suggestion, so Triage still lists the item.
const unresolvedAssignee = (assignment: FactoryTaskAssignment): FactoryTaskAssignee => ({
  assignment,
  key:
    assignment.mode === "profile"
      ? assignment.profileId
      : assignment.mode === "pinned"
        ? `${assignment.setup.modelSelection.instanceId}/${assignment.setup.modelSelection.model}`
        : assignment.mode,
  resolved: null,
});

interface ObservedItem {
  readonly itemKey: string;
  readonly originKey: string;
  readonly label: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly labels: ReadonlyArray<string>;
}

type CheckOutcome =
  | {
      readonly kind: "observed";
      readonly label: string;
      readonly detail: string;
      readonly feedSourceId: string | null;
      // Oldest first, so arrival order follows the source.
      readonly items: ReadonlyArray<ObservedItem>;
      readonly nextCheckAt: number;
    }
  | {
      readonly kind: "failed";
      readonly status: "failed" | "unavailable";
      readonly nextCheckAt: number;
    };

interface ChangeFlags {
  readonly arrivals: boolean;
  readonly rules: boolean;
  readonly sources: boolean;
}
const noChange: ChangeFlags = { arrivals: false, rules: false, sources: false };
const mergeFlags = (a: ChangeFlags, b: ChangeFlags): ChangeFlags => ({
  arrivals: a.arrivals || b.arrivals,
  rules: a.rules || b.rules,
  sources: a.sources || b.sources,
});

const presentSource = (source: Store.StoredSource): FactoryIntakeSource => ({
  id: source.id,
  projectId: source.projectId,
  config: source.config,
  label: source.label,
  detail: source.detail,
  enabled: source.enabled,
  status: source.status,
  lastCheckedAt: source.lastCheckedAt,
  version: source.version,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
});

const make = Effect.gen(function* () {
  const store = yield* Store.FactoryIntakeStore;
  const tasks = yield* Tasks.FactoryTaskService;
  const issues = yield* Issues.FactoryIssueService;
  const feeds = yield* Feeds.FactoryFeedService;
  const projects = yield* Projects.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const changesPubSub = yield* PubSub.unbounded<FactoryIntakeChange>();
  // One writer at a time keeps read-check-write sequences (versions, receipts, rule firing) atomic.
  const writes = yield* Semaphore.make(1);
  const serialized = writes.withPermits(1);
  const wake = yield* Queue.sliding<void>(1);
  const wakeChecks = Queue.offer(wake, undefined).pipe(Effect.asVoid);

  const publish = (flags: ChangeFlags) =>
    flags.arrivals || flags.rules || flags.sources
      ? PubSub.publish(changesPubSub, { environmentId, ...flags }).pipe(Effect.asVoid)
      : Effect.void;
  const newId = (prefix: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => `${prefix}:${uuid}`),
      Effect.orDie,
    );
  const digestOf = (operation: CommandOperation, payload: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(`${operation}\n${payload}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
  const replayOf = Effect.fn("FactoryIntakeService.replayOf")(function* (
    commandId: CommandId,
    operation: CommandOperation,
    digest: string,
  ) {
    const receipt = yield* store.getCommand(commandId);
    if (Option.isNone(receipt)) return Option.none<string>();
    if (receipt.value.operation !== operation || receipt.value.digest !== digest)
      return yield* intakeError("command-conflict");
    return Option.some(receipt.value.result);
  });
  const readIdReceipt = (result: string) =>
    decodeIdReceipt(result).pipe(
      Effect.mapError((cause) => new FactoryIntakeError({ reason: "persistence-failure", cause })),
    );
  const requireProject = Effect.fn("FactoryIntakeService.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError(
          (cause) => new FactoryIntakeError({ reason: "persistence-failure", cause }),
        ),
      );
    if (Option.isNone(project)) return yield* intakeError("missing-project");
  });

  const observeIssues = Effect.fn("FactoryIntakeService.observeIssues")(function* (
    source: Store.StoredSource,
    nowMs: number,
  ) {
    return yield* Effect.gen(function* () {
      const first = yield* issues.list({ projectId: source.projectId, state: "open" });
      const { repository, capabilities } = first;
      const listed = [...first.issues];
      let nextPage = first.nextPage;
      while (nextPage !== null) {
        const page = yield* issues.list({
          projectId: source.projectId,
          state: "open",
          page: nextPage,
        });
        listed.push(...page.issues);
        nextPage = page.nextPage;
      }
      const name = capabilities.displayName;
      return {
        kind: "observed",
        label: `${name} issues`,
        detail: repository.repository,
        feedSourceId: null,
        items: listed
          .filter((issue) => issue.state === "open")
          .toReversed()
          .map((issue) => {
            const key = issueOriginKey(repository.provider, repository.canonicalKey, issue.number);
            return {
              itemKey: key,
              originKey: key,
              label: `${name} #${issue.number}`,
              title: issue.title,
              body: issue.body ?? "",
              url: issue.url,
              labels: issue.labels,
            };
          }),
        nextCheckAt: nowMs + ISSUE_CHECK_INTERVAL_MS,
      } satisfies CheckOutcome;
    }).pipe(
      Effect.catchTags({
        FactoryIssueError: (error) => {
          const failed: CheckOutcome = {
            kind: "failed",
            status:
              error.reason === "missing-project" ||
              error.reason === "missing-repository" ||
              error.reason === "unsupported-provider"
                ? "unavailable"
                : "failed",
            nextCheckAt: nowMs + FAILED_CHECK_RETRY_MS,
          };
          return Effect.logWarning("Intake issue check failed").pipe(
            Effect.annotateLogs({ sourceId: source.id, reason: error.reason }),
            Effect.as(failed),
          );
        },
      }),
    );
  });

  const observeFeed = Effect.fn("FactoryIntakeService.observeFeed")(function* (
    source: Store.StoredSource,
    url: string,
    options: { readonly rebind: boolean },
    nowMs: number,
  ) {
    const failed: CheckOutcome = {
      kind: "failed",
      status: "failed",
      nextCheckAt: nowMs + FAILED_CHECK_RETRY_MS,
    };
    return yield* Effect.gen(function* () {
      const { projectId } = source;
      const host = (yield* FeedFetch.validateLocator(url)).hostname;
      const listed = (yield* feeds.listSources({ projectId })).sources;
      let feed =
        listed.find((candidate) => candidate.id === source.feedSourceId) ??
        listed.find((candidate) => candidate.locator === url);
      // A periodic check never revives a feed the host told us to stop reading.
      if (feed !== undefined && feed.status === "suspended" && !options.rebind) return failed;
      if (feed === undefined || feed.status === "suspended") {
        const bindingKey = yield* crypto
          .digest("SHA-256", new TextEncoder().encode(url))
          .pipe(Effect.map(Hex.encode), Effect.orDie);
        feed = (yield* feeds.bindSource({
          commandId: CommandId.make(`factory-intake:${source.id}:${bindingKey}`),
          projectId,
          url,
        })).source;
      } else if (feed.nextAllowedAt === null || millisOf(feed.nextAllowedAt) <= nowMs) {
        const current = feed;
        feed = yield* feeds.refreshSource({ projectId, sourceId: current.id }).pipe(
          Effect.map((refreshed) => refreshed.source),
          Effect.catchTags({
            FactoryFeedError: (error) =>
              error.reason === "refresh-throttled" ? Effect.succeed(current) : Effect.fail(error),
          }),
        );
      }
      const { repository, candidates } = yield* feeds.listCandidates({
        projectId,
        sourceId: feed.id,
        disposition: "open",
      });
      const locator = feed.locator;
      return {
        kind: "observed",
        label: feed.title ?? "Feed",
        detail: host,
        feedSourceId: feed.id,
        items: candidates
          .filter((candidate) => candidate.disposition === "open")
          .toReversed()
          .map((candidate) => ({
            itemKey: candidate.itemKey,
            originKey: feedItemOriginKey(
              repository?.canonicalKey ?? "",
              locator,
              candidate.itemKey,
            ),
            label: "Feed",
            title: candidate.title ?? candidate.link ?? candidate.itemKey,
            body: candidate.content ?? "",
            url: candidate.link,
            labels: [],
          })),
        nextCheckAt: Math.max(
          nowMs + FEED_CHECK_INTERVAL_MS,
          feed.nextAllowedAt === null ? 0 : millisOf(feed.nextAllowedAt),
        ),
      } satisfies CheckOutcome;
    }).pipe(
      Effect.catchTags({
        FactoryFeedError: (error) =>
          Effect.logWarning("Intake feed check failed").pipe(
            Effect.annotateLogs({ sourceId: source.id, reason: error.reason }),
            Effect.as(failed),
          ),
      }),
    );
  });

  const arrivalOf = (
    source: Store.StoredSource,
    sourceKind: FactoryIntakeArrival["sourceKind"],
    item: ObservedItem,
  ) => {
    const body = bounded(item.body, BODY_MAX);
    const url = item.url === null || item.url === "" || item.url.length > URL_MAX ? null : item.url;
    return {
      sourceId: source.id,
      sourceKind,
      projectId: source.projectId,
      itemKey: item.itemKey,
      originKey: item.originKey,
      label: bounded(item.label, 512),
      title: bounded(item.title.trim() === "" ? (url ?? item.label) : item.title.trim(), TITLE_MAX),
      body,
      bodyTruncated: body.length < item.body.length,
      url,
      labels: item.labels.slice(0, LABELS_MAX).map((label) => bounded(label, LABEL_MAX)),
    };
  };

  // Rules see arrivals in source order; a trial rule that fires is off for the rest of the batch.
  const record = Effect.fn("FactoryIntakeService.record")(function* (
    checked: Store.StoredSource,
    outcome: CheckOutcome,
    nowMs: number,
  ) {
    return yield* store
      .transact(
        Effect.gen(function* () {
          const current = yield* store.getSource(checked.id);
          if (
            Option.isNone(current) ||
            current.value.version !== checked.version ||
            !current.value.enabled
          )
            return noChange;
          const source = current.value;
          const now = isoOf(nowMs);
          if (outcome.kind === "failed") {
            yield* store.putSource({
              ...source,
              status: outcome.status,
              lastCheckedAt: now,
              nextCheckAt: isoOf(outcome.nextCheckAt),
            });
            return { ...noChange, sources: true };
          }
          const sourceKind = source.config.kind === "feed" ? "feed" : "issues";
          const items = [...new Map(outcome.items.map((item) => [item.itemKey, item])).values()];
          const seen = yield* store.existingItemKeys(
            source.id,
            items.map((item) => item.itemKey),
          );
          const fresh = items.filter((item) => !seen.has(item.itemKey));
          const rules = fresh.length === 0 ? [] : [...(yield* store.listRules(source.id))];
          const fired = new Set<number>();
          let arrivals = false;
          for (const item of fresh) {
            const arrival = arrivalOf(source, sourceKind, item);
            const index = rules.findIndex(
              (rule) => rule.state !== "off" && ruleMatches(rule.match, arrival),
            );
            const rule = rules[index];
            if (rule !== undefined) {
              rules[index] = {
                ...rule,
                lastFiredAt: now,
                firedCount: rule.firedCount + 1,
                ...(rule.state === "trial"
                  ? { state: "off", version: rule.version + 1, updatedAt: now }
                  : {}),
              };
              fired.add(index);
            }
            yield* store.insertArrival({
              ...arrival,
              id: yield* newId("arrival"),
              arrivedAt: now,
              state: "new",
              snoozedUntil: null,
              suggestion:
                rule?.autonomy === "suggest"
                  ? {
                      ruleId: rule.id,
                      ruleName: rule.name,
                      type: rule.action.type,
                      assignment: rule.action.assignment,
                    }
                  : null,
              task: null,
              version: 1,
            });
            arrivals = true;
          }
          for (const index of fired) {
            const rule = rules[index];
            if (rule !== undefined) yield* store.putRule(rule);
          }
          yield* store.putSource({
            ...source,
            label: outcome.label,
            detail: outcome.detail,
            status: "ok",
            feedSourceId: outcome.feedSourceId,
            lastCheckedAt: now,
            nextCheckAt: isoOf(outcome.nextCheckAt),
          });
          return { arrivals, rules: fired.size > 0, sources: true };
        }),
      )
      .pipe(serialized);
  });

  const checkSource = Effect.fn("FactoryIntakeService.checkSource")(function* (
    source: Store.StoredSource,
    options: { readonly rebind: boolean },
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const { config } = source;
    if (config.kind === "schedule") return noChange;
    const outcome =
      config.kind === "issues"
        ? yield* observeIssues(source, nowMs)
        : yield* observeFeed(source, config.url, options, nowMs);
    return yield* record(source, outcome, nowMs);
  });

  const fireSchedule = Effect.fn("FactoryIntakeService.fireSchedule")(function* (
    source: Store.StoredSource,
  ) {
    const { config } = source;
    if (config.kind !== "schedule") return noChange;
    const nowMs = yield* Clock.currentTimeMillis;
    const slot = latestSlotAtOrBefore(config.schedule, nowMs);
    const next = nextSlotAfter(config.schedule, nowMs);
    const due = source.lastSlotAt === null || slot > millisOf(source.lastSlotAt);
    // The command id names the slot, so a retry after a crash replays the same task.
    const created = due
      ? yield* tasks
          .create(
            {
              commandId: CommandId.make(`factory-intake:${source.id}:${isoOf(slot)}`),
              projectId: source.projectId,
              title: config.task.title,
              description: config.task.description,
              type: config.task.type,
              lane: config.task.lane,
              assignment: config.task.assignment,
            },
            source.actor,
            {
              source: { kind: "schedule", label: "Schedule", url: null, key: null, workRef: null },
              ruleName: null,
            },
          )
          .pipe(
            Effect.as(true),
            Effect.catchTags({
              FactoryTaskError: (error) =>
                Effect.logWarning("Scheduled task could not be made").pipe(
                  Effect.annotateLogs({ sourceId: source.id, reason: error.reason }),
                  Effect.as(false),
                ),
            }),
          )
      : true;
    return yield* store
      .transact(
        Effect.gen(function* () {
          const current = yield* store.getSource(source.id);
          if (
            Option.isNone(current) ||
            current.value.version !== source.version ||
            !current.value.enabled
          )
            return noChange;
          const now = isoOf(nowMs);
          yield* store.putSource({
            ...current.value,
            status: created ? "ok" : "failed",
            lastCheckedAt: now,
            lastSlotAt: due && created ? isoOf(slot) : current.value.lastSlotAt,
            nextCheckAt: isoOf(created ? next : Math.min(nowMs + SCHEDULE_RETRY_MS, next)),
          });
          return { ...noChange, sources: true };
        }),
      )
      .pipe(serialized);
  });

  const runDueSources = Effect.fn("FactoryIntakeService.runDueSources")(function* () {
    const now = isoOf(yield* Clock.currentTimeMillis);
    const expired = yield* store.expireSnoozedArrivals(now).pipe(serialized);
    if (expired) yield* publish({ ...noChange, arrivals: true });
    const due = yield* store.listDueSources(now);
    let flags = noChange;
    for (const source of due) {
      flags = mergeFlags(
        flags,
        source.config.kind === "schedule"
          ? yield* fireSchedule(source)
          : yield* checkSource(source, { rebind: false }),
      );
    }
    yield* publish(flags);
  });

  // Source checks and snooze expiry share one deadline; mutations wake it to recalculate.
  const checkLoopStep = Effect.gen(function* () {
    const next = yield* store.nextCheckAt;
    if (next === null) {
      yield* Queue.take(wake);
    } else {
      const delay = millisOf(next) - (yield* Clock.currentTimeMillis);
      if (delay > 0)
        yield* Effect.raceFirst(Effect.sleep(Duration.millis(delay)), Queue.take(wake));
    }
    yield* runDueSources();
  });
  yield* forkParked(
    checkLoopStep.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("Intake checks failed", { cause }).pipe(
            Effect.andThen(Effect.sleep(LOOP_FAILURE_PAUSE)),
          ),
      ),
      Effect.forever,
    ),
  );

  const listSources = Effect.fn("FactoryIntakeService.listSources")(function* (
    input: FactoryIntakeSourceListInput,
  ) {
    return {
      environmentId,
      sources: (yield* store.listSources(input.projectIds)).map(presentSource),
      fetchedAt: isoOf(yield* Clock.currentTimeMillis),
    };
  });

  const saveSource = Effect.fn("FactoryIntakeService.saveSource")(function* (
    input: FactoryIntakeSourceSaveInput,
    actor: FactoryPlanActor,
  ): Effect.fn.Return<FactoryIntakeSourceMutationResult, FactoryIntakeError> {
    const digest = yield* digestOf("saveSource", commandPayloads.saveSource(input));
    const newSourceId = yield* newId("source");
    const outcome = yield* store
      .transact(
        Effect.gen(function* () {
          const replay = yield* replayOf(input.commandId, "saveSource", digest);
          if (Option.isSome(replay)) {
            const { id } = yield* readIdReceipt(replay.value);
            const current = id === null ? Option.none() : yield* store.getSource(id);
            return { source: Option.getOrNull(current), replayed: true, check: false };
          }
          const { config } = input;
          if (config.kind === "feed")
            yield* FeedFetch.validateLocator(config.url).pipe(
              Effect.mapError(
                (cause) => new FactoryIntakeError({ reason: "invalid-input", cause }),
              ),
            );
          yield* requireProject(input.projectId);
          let existing: Store.StoredSource | undefined;
          if (input.id !== undefined) {
            if (input.expectedVersion === undefined) return yield* intakeError("invalid-input");
            const found = yield* store.getSource(input.id);
            if (Option.isNone(found)) return yield* intakeError("missing-source");
            existing = found.value;
            if (existing.version !== input.expectedVersion)
              return yield* intakeError("version-conflict", existing.version);
            if (existing.projectId !== input.projectId || existing.config.kind !== config.kind)
              return yield* intakeError("invalid-input");
          } else if ((yield* store.countSources) >= MAX_SOURCES) {
            return yield* intakeError("invalid-input");
          }
          const id = existing?.id ?? newSourceId;
          if (yield* store.findSameSource({ id, projectId: input.projectId, config }))
            return yield* intakeError("invalid-input");
          const nowMs = yield* Clock.currentTimeMillis;
          const now = isoOf(nowMs);
          const configChanged =
            existing === undefined || encodeConfig(existing.config) !== encodeConfig(config);
          const restarted = input.enabled && (configChanged || existing?.enabled !== true);
          const description =
            existing === undefined || configChanged ? initialDescription(config) : existing;
          const keep = existing !== undefined && !configChanged ? existing : undefined;
          let nextCheckAt: string | null = null;
          if (input.enabled && config.kind === "schedule")
            nextCheckAt =
              restarted || keep === undefined || keep.nextCheckAt === null
                ? isoOf(nextSlotAfter(config.schedule, nowMs))
                : keep.nextCheckAt;
          // The save looks at a restarted source itself; this only covers a save that dies first.
          else if (input.enabled)
            nextCheckAt = restarted
              ? isoOf(nowMs + FAILED_CHECK_RETRY_MS)
              : (keep?.nextCheckAt ?? now);
          const source: Store.StoredSource = {
            id,
            projectId: input.projectId,
            config,
            label: description.label,
            detail: description.detail,
            enabled: input.enabled,
            status: keep?.status ?? "ok",
            feedSourceId: keep?.feedSourceId ?? null,
            actor,
            lastCheckedAt: keep?.lastCheckedAt ?? null,
            nextCheckAt,
            // A schedule fires only for slots after it was saved or turned back on.
            lastSlotAt:
              config.kind !== "schedule" ? null : restarted ? now : (keep?.lastSlotAt ?? now),
            version: existing === undefined ? 1 : existing.version + 1,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          yield* store.putSource(source);
          yield* store.putCommand({
            commandId: input.commandId,
            operation: "saveSource",
            digest,
            result: encodeIdReceipt({ id }),
          });
          return { source, replayed: false, check: restarted && config.kind !== "schedule" };
        }),
      )
      .pipe(serialized);
    const saved = outcome.source;
    if (outcome.replayed || saved === null)
      return { source: saved === null ? null : presentSource(saved), replayed: outcome.replayed };
    yield* publish({ ...noChange, sources: true });
    if (outcome.check) {
      // The save is committed; a failed first look shows on the source, never on the save.
      const flags = yield* checkSource(saved, { rebind: true }).pipe(
        Effect.catchTags({
          FactoryIntakeError: (error) =>
            Effect.logWarning("Intake source check failed").pipe(
              Effect.annotateLogs({ sourceId: saved.id, reason: error.reason }),
              Effect.as(noChange),
            ),
        }),
      );
      yield* publish(flags);
    }
    yield* wakeChecks;
    const current = yield* store.getSource(saved.id);
    return { source: presentSource(Option.getOrElse(current, () => saved)), replayed: false };
  });

  const deleteSource = Effect.fn("FactoryIntakeService.deleteSource")(function* (
    input: FactoryIntakeSourceDeleteInput,
  ): Effect.fn.Return<FactoryIntakeSourceMutationResult, FactoryIntakeError> {
    const digest = yield* digestOf("deleteSource", commandPayloads.deleteSource(input));
    const replayed = yield* store
      .transact(
        Effect.gen(function* () {
          if (Option.isSome(yield* replayOf(input.commandId, "deleteSource", digest))) return true;
          const found = yield* store.getSource(input.id);
          if (Option.isNone(found)) return yield* intakeError("missing-source");
          if (found.value.version !== input.expectedVersion)
            return yield* intakeError("version-conflict", found.value.version);
          yield* store.deleteSource(input.id);
          yield* store.putCommand({
            commandId: input.commandId,
            operation: "deleteSource",
            digest,
            result: encodeIdReceipt({ id: null }),
          });
          return false;
        }),
      )
      .pipe(serialized);
    if (!replayed) {
      yield* publish({ arrivals: false, rules: true, sources: true });
      yield* wakeChecks;
    }
    return { source: null, replayed };
  });

  const listRules = Effect.fn("FactoryIntakeService.listRules")(function* () {
    return {
      environmentId,
      rules: yield* store.listRules(undefined),
      fetchedAt: isoOf(yield* Clock.currentTimeMillis),
    };
  });

  const saveRule = Effect.fn("FactoryIntakeService.saveRule")(function* (
    input: FactoryIntakeRuleSaveInput,
  ): Effect.fn.Return<FactoryIntakeRuleMutationResult, FactoryIntakeError> {
    const digest = yield* digestOf("saveRule", commandPayloads.saveRule(input));
    const newRuleId = yield* newId("rule");
    const outcome = yield* store
      .transact(
        Effect.gen(function* () {
          const replay = yield* replayOf(input.commandId, "saveRule", digest);
          if (Option.isSome(replay)) {
            const { id } = yield* readIdReceipt(replay.value);
            const current = id === null ? Option.none() : yield* store.getRule(id);
            return { rule: Option.getOrNull(current), replayed: true };
          }
          if (input.autonomy === "auto-start" && input.state !== "off")
            return yield* intakeError("autonomy-not-allowed");
          const source = yield* store.getSource(input.match.sourceId);
          if (Option.isNone(source)) return yield* intakeError("missing-source");
          if (source.value.config.kind === "schedule") return yield* intakeError("invalid-input");
          let existing: Store.StoredRule | undefined;
          if (input.id !== undefined) {
            if (input.expectedVersion === undefined) return yield* intakeError("invalid-input");
            const found = yield* store.getRule(input.id);
            if (Option.isNone(found)) return yield* intakeError("missing-rule");
            existing = found.value;
            if (existing.version !== input.expectedVersion)
              return yield* intakeError("version-conflict", existing.version);
          } else if ((yield* store.countRules) >= MAX_RULES) {
            return yield* intakeError("invalid-input");
          }
          if (yield* store.isRuleNameTaken({ name: input.name, exceptId: existing?.id }))
            return yield* intakeError("name-taken");
          const now = isoOf(yield* Clock.currentTimeMillis);
          const rule: Store.StoredRule = {
            id: existing?.id ?? newRuleId,
            name: input.name,
            match: input.match,
            action: input.action,
            autonomy: input.autonomy,
            state: input.state,
            lastFiredAt: existing?.lastFiredAt ?? null,
            firedCount: existing?.firedCount ?? 0,
            version: existing === undefined ? 1 : existing.version + 1,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          yield* store.putRule(rule);
          yield* store.putCommand({
            commandId: input.commandId,
            operation: "saveRule",
            digest,
            result: encodeIdReceipt({ id: rule.id }),
          });
          return { rule, replayed: false };
        }),
      )
      .pipe(serialized);
    if (!outcome.replayed) yield* publish({ ...noChange, rules: true });
    return outcome;
  });

  const deleteRule = Effect.fn("FactoryIntakeService.deleteRule")(function* (
    input: FactoryIntakeRuleDeleteInput,
  ): Effect.fn.Return<FactoryIntakeRuleMutationResult, FactoryIntakeError> {
    const digest = yield* digestOf("deleteRule", commandPayloads.deleteRule(input));
    const replayed = yield* store
      .transact(
        Effect.gen(function* () {
          if (Option.isSome(yield* replayOf(input.commandId, "deleteRule", digest))) return true;
          const found = yield* store.getRule(input.id);
          if (Option.isNone(found)) return yield* intakeError("missing-rule");
          if (found.value.version !== input.expectedVersion)
            return yield* intakeError("version-conflict", found.value.version);
          yield* store.deleteRule(input.id);
          yield* store.putCommand({
            commandId: input.commandId,
            operation: "deleteRule",
            digest,
            result: encodeIdReceipt({ id: null }),
          });
          return false;
        }),
      )
      .pipe(serialized);
    if (!replayed) yield* publish({ ...noChange, rules: true });
    return { rule: null, replayed };
  });

  const previewRule = Effect.fn("FactoryIntakeService.previewRule")(function* (
    input: FactoryIntakeRulePreviewInput,
  ) {
    const since = isoOf((yield* Clock.currentTimeMillis) - PREVIEW_WINDOW_MS);
    const recorded = yield* store.listArrivalsSince({ sourceId: input.match.sourceId, since });
    return {
      matchedLast30Days: recorded.filter((arrival) => ruleMatches(input.match, arrival)).length,
    };
  });

  const presentArrivals = Effect.fn("FactoryIntakeService.presentArrivals")(function* (
    arrivals: ReadonlyArray<Store.StoredArrival>,
  ) {
    const assignees = new Map<string, FactoryTaskAssignee>();
    const presented: Array<FactoryIntakeArrival> = [];
    for (const arrival of arrivals) {
      const stored = arrival.suggestion;
      let suggestion: FactoryIntakeArrival["suggestion"] = null;
      if (stored !== null) {
        const query = {
          projectId: arrival.projectId,
          type: stored.type,
          assignment: stored.assignment,
        };
        const key = `${arrival.projectId}\n${stored.type}\n${encodeAssignment(stored.assignment)}`;
        const assignee =
          assignees.get(key) ??
          (yield* tasks.resolveAssignee(query).pipe(
            Effect.catchTags({
              FactoryTaskError: () => Effect.succeed(unresolvedAssignee(stored.assignment)),
            }),
          ));
        assignees.set(key, assignee);
        suggestion = {
          ruleId: stored.ruleId,
          ruleName: stored.ruleName,
          type: stored.type,
          assignee,
        };
      }
      presented.push({
        id: arrival.id,
        sourceId: arrival.sourceId,
        sourceKind: arrival.sourceKind,
        projectId: arrival.projectId,
        label: arrival.label,
        title: arrival.title,
        body: arrival.body,
        bodyTruncated: arrival.bodyTruncated,
        url: arrival.url,
        labels: arrival.labels,
        arrivedAt: arrival.arrivedAt,
        state: arrival.state,
        snoozedUntil: arrival.snoozedUntil,
        suggestion,
        task: arrival.task,
        version: arrival.version,
      });
    }
    return presented;
  });

  const listArrivals = Effect.fn("FactoryIntakeService.listArrivals")(function* (
    input: FactoryIntakeArrivalListInput,
  ): Effect.fn.Return<FactoryIntakeArrivalListResult, FactoryIntakeError> {
    const now = isoOf(yield* Clock.currentTimeMillis);
    const limit = input.limit ?? DEFAULT_ARRIVAL_LIMIT;
    const filterKey = encodeCursorFilter({
      projectIds: input.projectIds === undefined ? null : [...new Set(input.projectIds)].toSorted(),
      states: input.states === undefined ? null : [...new Set(input.states)].toSorted(),
    });
    let after: Store.ArrivalPosition | undefined;
    if (input.cursor !== undefined) {
      const text = Result.getOrUndefined(Base64Url.decodeString(input.cursor));
      const cursor = text === undefined ? undefined : yield* decodeCursor(text).pipe(Effect.option);
      if (cursor === undefined || Option.isNone(cursor) || cursor.value.filter !== filterKey)
        return yield* intakeError("invalid-cursor");
      after = cursor.value;
    }
    const rows = yield* store.listArrivals({
      projectIds: input.projectIds,
      states: input.states,
      now,
      after,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      environmentId,
      items: yield* presentArrivals(page),
      nextCursor:
        rows.length > limit && last !== undefined
          ? Base64Url.encode(
              encodeCursor({ arrivedAt: last.arrivedAt, seq: last.seq, filter: filterKey }),
            )
          : null,
      waiting: yield* store.countArrivals({ projectIds: input.projectIds, states: undefined, now }),
      fetchedAt: now,
    };
  });

  const acceptArrival = Effect.fn("FactoryIntakeService.acceptArrival")(function* (
    input: FactoryIntakeArrivalResolveInput,
    action: Extract<FactoryIntakeArrivalResolveInput["action"], { readonly type: "accept" }>,
    arrival: Store.StoredArrival,
    actor: FactoryPlanActor,
  ) {
    const suggestion = arrival.suggestion;
    const usedSuggestion =
      suggestion !== null && (action.taskType === undefined || action.assignment === undefined);
    const created = yield* tasks
      .create(
        {
          commandId: CommandId.make(`factory-intake:${input.commandId}`),
          projectId: arrival.projectId,
          title: arrival.title,
          description: arrival.body,
          type: action.taskType ?? suggestion?.type ?? "task",
          lane: "backlog",
          assignment: action.assignment ?? suggestion?.assignment ?? { mode: "unassigned" },
        },
        actor,
        {
          source: {
            kind: arrival.sourceKind === "issues" ? "issue" : "feed",
            label: arrival.label,
            url: arrival.url,
            key: arrival.originKey,
            workRef: null,
          },
          ruleName: usedSuggestion ? suggestion.ruleName : null,
        },
      )
      .pipe(Effect.mapError(taskFailure));
    return created.task;
  });

  const resolveArrival = Effect.fn("FactoryIntakeService.resolveArrival")(function* (
    input: FactoryIntakeArrivalResolveInput,
    actor: FactoryPlanActor,
  ): Effect.fn.Return<FactoryIntakeArrivalResolveResult, FactoryIntakeError> {
    const digest = yield* digestOf("resolveArrival", commandPayloads.resolveArrival(input));
    const outcome = yield* Effect.gen(function* () {
      const replay = yield* replayOf(input.commandId, "resolveArrival", digest);
      if (Option.isSome(replay)) {
        const receipt = yield* decodeArrivalReceipt(replay.value).pipe(
          Effect.mapError(
            (cause) => new FactoryIntakeError({ reason: "persistence-failure", cause }),
          ),
        );
        const arrival = yield* store.getArrival(receipt.arrivalId);
        if (Option.isNone(arrival)) return yield* intakeError("missing-arrival");
        return { arrival: arrival.value, task: receipt.task, replayed: true };
      }
      const found = yield* store.getArrival(input.id);
      if (Option.isNone(found)) return yield* intakeError("missing-arrival");
      const arrival = found.value;
      if (arrival.state !== "new" && arrival.state !== "snoozed")
        return yield* intakeError("already-resolved");
      if (arrival.version !== input.expectedVersion)
        return yield* intakeError("version-conflict", arrival.version);
      const { action } = input;
      const nowMs = yield* Clock.currentTimeMillis;
      let next: Pick<Store.StoredArrival, "state" | "snoozedUntil" | "task">;
      let task: FactoryTaskSummary | null = null;
      switch (action.type) {
        case "accept": {
          task = yield* acceptArrival(input, action, arrival, actor);
          next = {
            state: "accepted",
            snoozedUntil: null,
            task: { ref: task.ref, displayId: task.displayId },
          };
          break;
        }
        case "snooze": {
          const until = DateTime.make(action.until);
          if (Option.isNone(until) || DateTime.toEpochMillis(until.value) <= nowMs)
            return yield* intakeError("invalid-input");
          next = { state: "snoozed", snoozedUntil: DateTime.formatIso(until.value), task: null };
          break;
        }
        case "unsnooze": {
          if (arrival.state !== "snoozed") return yield* intakeError("invalid-input");
          next = { state: "new", snoozedUntil: null, task: null };
          break;
        }
        case "decline": {
          next = { state: "declined", snoozedUntil: null, task: null };
          break;
        }
        case "duplicate": {
          let original: Store.StoredArrival["task"] = null;
          if (action.of !== null) {
            if (action.of.environmentId !== environmentId)
              return yield* intakeError("wrong-environment");
            const detail = yield* tasks
              .read({ task: { ref: action.of } })
              .pipe(Effect.mapError(taskFailure));
            original = { ref: detail.task.ref, displayId: detail.task.displayId };
          }
          next = { state: "duplicate", snoozedUntil: null, task: original };
          break;
        }
      }
      const updated = { ...arrival, ...next, version: arrival.version + 1 };
      yield* store.transact(
        Effect.gen(function* () {
          yield* store.updateArrival(updated);
          yield* store.putCommand({
            commandId: input.commandId,
            operation: "resolveArrival",
            digest,
            result: encodeArrivalReceipt({ arrivalId: arrival.id, task }),
          });
        }),
      );
      return { arrival: updated, task, replayed: false };
    }).pipe(serialized);
    if (!outcome.replayed) {
      yield* publish({ ...noChange, arrivals: true });
      yield* wakeChecks;
    }
    const [arrival] = yield* presentArrivals([outcome.arrival]);
    if (arrival === undefined) return yield* intakeError("missing-arrival");
    return { arrival, task: outcome.task, replayed: outcome.replayed };
  });

  return FactoryIntakeService.of({
    listSources,
    saveSource,
    deleteSource,
    listRules,
    saveRule,
    deleteRule,
    previewRule,
    listArrivals,
    resolveArrival,
    changes: Stream.fromPubSub(changesPubSub),
  });
});

export const layer = Layer.effect(FactoryIntakeService, make);
