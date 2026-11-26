import { now } from "./lib/records.ts";
import {
  SIGNAL_FETCH_TIMEOUT_MS,
  SIGNAL_RESPONSE_BYTES_MAX,
  fetchFeed,
  isDue,
  parseFeed,
  planPull,
  signalFailures,
  transportFor,
} from "./lib/signals.ts";

const { workflow, step, skip, every, store, Tick } = T3;

const feedPrefix = "factory/v1/signal-feed/";
const statePrefix = "factory/v1/signal-state/";
const candidatePrefix = "factory/v1/signal-candidate/";
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const nonEmpty = Schema.Trim.check(Schema.isMinLength(1));
const sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const projectId = Schema.NullOr(nonEmpty);
const failure = Schema.NullOr(Schema.Literals(signalFailures));
const httpStatus = Schema.NullOr(Schema.Int);
const Feed = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  url: bounded(2048),
  label: nonEmpty.check(Schema.isMaxLength(100)),
  projectId,
  addedAt: Schema.String,
});
type Feed = typeof Feed.Type;
const State = Schema.Struct({
  v: Schema.Literal(1),
  feedId: Schema.String,
  lastPullAt: Schema.String,
  lastOkAt: Schema.NullOr(Schema.String),
  etag: Schema.NullOr(bounded(200)),
  lastModified: Schema.NullOr(bounded(200)),
  failures: count,
  failure,
  httpStatus,
  items: count,
});
type State = typeof State.Type;
const Candidate = Schema.Struct({
  v: Schema.Literal(1),
  id: sha256,
  feedId: Schema.String,
  projectId,
  itemKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  revision: positive,
  sha256,
  title: nonEmpty.check(Schema.isMaxLength(200)),
  summary: bounded(2000),
  link: Schema.NullOr(bounded(2000)),
  state: Schema.Literals(["pending", "admitted", "dismissed"]),
  firstSeenAt: Schema.String,
  changedAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  decidedRevision: Schema.NullOr(positive),
  decidedSha256: Schema.NullOr(sha256),
  taskId: Schema.NullOr(Schema.String),
});
const FeedPull = Schema.Struct({
  feedId: Schema.String,
  outcome: Schema.Literals(["ok", "not-modified", "failed", "removed", "not-due"]),
  failure,
  httpStatus,
  created: count,
  revised: count,
  reopened: count,
  unchanged: count,
  capped: count,
  skipped: count,
  overflow: count,
  pruned: count,
});
type FeedPull = typeof FeedPull.Type;
const Selection = Schema.Struct({
  due: Schema.Array(Feed),
  blocked: Schema.Array(Schema.String),
  damaged: count,
});
const returns = Schema.Struct({ feeds: Schema.Array(FeedPull), damaged: count });

function result(
  feedId: string,
  outcome: FeedPull["outcome"],
  failure: FeedPull["failure"] = null,
  httpStatus: number | null = null,
): FeedPull {
  return {
    feedId,
    outcome,
    failure,
    httpStatus,
    created: 0,
    revised: 0,
    reopened: 0,
    unchanged: 0,
    capped: 0,
    skipped: 0,
    overflow: 0,
    pruned: 0,
  };
}

const decodeFeed = Schema.decodeUnknownOption(Feed);
const decodeState = Schema.decodeUnknownOption(State);
const decodeCandidate = Schema.decodeUnknownOption(Candidate);
function feedAt(id: string, raw: unknown) {
  const feed = decodeFeed(raw);
  return Option.isSome(feed) && feed.value.id === id && id.length > 0 && !id.includes("/")
    ? feed.value
    : null;
}
function stateAt(id: string, raw: unknown) {
  const state = decodeState(raw);
  return Option.isSome(state) && state.value.feedId === id && id.length > 0 && !id.includes("/")
    ? state.value
    : null;
}

const selectFeeds = Effect.fn("factorySignals.selectFeeds")(function* () {
  const at = yield* now;
  const feeds = yield* store.entries(feedPrefix, Schema.Json);
  const rows = yield* store.entries(statePrefix, Schema.Json);
  const states = new Map<string, State | null>();
  for (const row of rows) {
    const id = row.key.slice(statePrefix.length);
    states.set(id, stateAt(id, row.value));
  }
  const due: Feed[] = [],
    blocked: string[] = [];
  let damaged = 0;
  for (const row of feeds) {
    const id = row.key.slice(feedPrefix.length);
    const feed = feedAt(id, row.value);
    if (!feed) {
      damaged++;
      continue;
    }
    const state = states.get(id);
    if (state === null) blocked.push(id);
    else if (isDue(state ?? null, at)) due.push(feed);
  }
  due.sort((a, b) => {
    const left = states.get(a.id)?.lastPullAt,
      right = states.get(b.id)?.lastPullAt;
    if (left !== right) return left === undefined || (right !== undefined && left < right) ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { due, blocked, damaged };
});

const currentFeed = Effect.fn("factorySignals.currentFeed")(function* (selected: Feed) {
  const row = yield* store.entry(feedPrefix + selected.id, Schema.Json).get;
  if (Option.isNone(row)) return null;
  const current = feedAt(selected.id, row.value);
  return current?.url === selected.url ? current : null;
});

const reserve = Effect.fn("factorySignals.reserve")(function* (feed: Feed, at: string) {
  if (!(yield* currentFeed(feed))) return { outcome: "removed" } as const;
  const key = statePrefix + feed.id;
  const row = yield* store.entry(key, Schema.Json).get;
  let previous: State | null = null;
  if (Option.isSome(row)) {
    previous = stateAt(feed.id, row.value);
    if (!previous) return { outcome: "damaged" } as const;
  }
  if (!isDue(previous, at)) return { outcome: "not-due" } as const;
  const state: State = previous
    ? { ...previous, lastPullAt: at }
    : {
        v: 1,
        feedId: feed.id,
        lastPullAt: at,
        lastOkAt: null,
        etag: null,
        lastModified: null,
        failures: 0,
        failure: null,
        httpStatus: null,
        items: 0,
      };
  yield* store.entry(key, State).set(state);
  return { outcome: "reserved", state } as const;
});

const pull = Effect.fn("factorySignals.pull")(function* (feed: Feed) {
  const at = yield* now;
  const reservation = yield* store.transaction(reserve(feed, at));
  if (reservation.outcome === "damaged") return result(feed.id, "failed", "store");
  if (reservation.outcome !== "reserved") return result(feed.id, reservation.outcome);
  const previous = reservation.state;
  const fetched = yield* Effect.promise(async () => {
    const response = await fetchFeed(feed.url, previous, transportFor(), {
      timeoutMs: SIGNAL_FETCH_TIMEOUT_MS,
      maxBytes: SIGNAL_RESPONSE_BYTES_MAX,
    });
    if (response.kind !== "ok") return response;
    const parsed = parseFeed(response.text);
    return parsed.ok
      ? ({ kind: "ok", parsed, etag: response.etag, lastModified: response.lastModified } as const)
      : ({ kind: "failed", failure: parsed.reason, httpStatus: null } as const);
  });
  return yield* store.transaction(
    Effect.gen(function* () {
      const current = yield* currentFeed(feed);
      if (!current) return result(feed.id, "removed");
      const key = statePrefix + feed.id;
      // A manual store edit during the fetch must not be repaired by overwriting a damaged row.
      const rawState = yield* store.entry(key, Schema.Json).get;
      if (Option.isSome(rawState) && !stateAt(feed.id, rawState.value))
        return result(feed.id, "failed", "store");
      const state = store.entry(key, State);
      if (fetched.kind === "failed") {
        yield* state.set({
          ...previous,
          failures: previous.failures + 1,
          failure: fetched.failure,
          httpStatus: fetched.httpStatus,
        });
        return result(feed.id, "failed", fetched.failure, fetched.httpStatus);
      }
      if (fetched.kind === "not-modified") {
        yield* state.set({
          ...previous,
          lastOkAt: at,
          failures: 0,
          failure: null,
          httpStatus: 304,
          etag: fetched.etag ?? previous.etag,
          lastModified: fetched.lastModified ?? previous.lastModified,
        });
        return result(feed.id, "not-modified", null, 304);
      }
      const { parsed } = fetched;
      const prefix = `${candidatePrefix}${feed.id}/`;
      const rows = yield* store.entries(prefix, Schema.Json);
      const heads: Array<typeof Candidate.Type> = [],
        damagedIds: string[] = [];
      for (const row of rows) {
        const id = row.key.slice(prefix.length);
        const candidate = decodeCandidate(row.value);
        if (
          Option.isSome(candidate) &&
          candidate.value.feedId === feed.id &&
          candidate.value.id === id
        )
          heads.push(candidate.value);
        else damagedIds.push(id);
      }
      const { writes, deletes, counts } = planPull({
        feedId: feed.id,
        projectId: current.projectId,
        at,
        items: parsed.items,
        heads,
        damagedIds,
      });
      for (const candidate of writes)
        yield* store.entry(prefix + candidate.id, Candidate).set(candidate);
      for (const id of deletes) yield* store.entry(prefix + id, Candidate).delete;
      yield* state.set({
        ...previous,
        lastOkAt: at,
        failures: 0,
        failure: null,
        httpStatus: 200,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        items: parsed.items.length,
      });
      return {
        ...result(feed.id, "ok", null, 200),
        ...counts,
        skipped: counts.skipped + parsed.skipped,
        overflow: parsed.overflow,
      };
    }),
  );
});

export default workflow(
  "factory-signals",
  { version: 1, payload: Tick, concurrency: 1, triggers: [every("15 minutes")], returns },
  Effect.fn(function* () {
    const { due, blocked, damaged } = yield* step("feeds", { returns: Selection }, selectFeeds());
    if (!due.length && !blocked.length) return yield* skip("no feeds due");
    const feeds = blocked.map((id) => result(id, "failed", "store"));
    for (const feed of due) {
      const pulled = yield* step.try(`pull/${feed.id}`, { returns: FeedPull }, pull(feed));
      feeds.push(pulled.outcome === "done" ? pulled.value : result(feed.id, "failed", "store"));
    }
    return { feeds, damaged };
  }),
);
