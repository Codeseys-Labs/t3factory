// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  FACTORY_SIGNAL_LIST_LIMIT,
  FactorySignalCandidate,
  FactorySignalFeed,
  FactorySignalFeedState,
  type FactorySignalFeedView,
  type FactorySignalsList,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KeyValues, layerKeyValues } from "../workflows/stepServices.ts";

const PREFIX = "factory/v1/";
const FEED_PREFIX = `${PREFIX}signal-feed/`;
const STATE_PREFIX = `${PREFIX}signal-state/`;
const CANDIDATE_PREFIX = `${PREFIX}signal-candidate/`;
const PAGE = 200;
const URL_MAX = 2_048;
const DOTTED_DECIMAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

type FeedUrlCheck =
  | { readonly ok: true; readonly url: string; readonly hostname: string }
  | {
      readonly ok: false;
      readonly reason: "not-a-url" | "scheme" | "credentials" | "port" | "address" | "hostname";
    };

/** The first failing rule of the feed address check wins; an address that passes is canonical. */
export function checkFeedUrl(text: string): FeedUrlCheck {
  const trimmed = text.trim();
  const parsed = trimmed.length > URL_MAX || trimmed.includes("#") ? null : URL.parse(trimmed);
  if (parsed === null || parsed.href.length > URL_MAX) return { ok: false, reason: "not-a-url" };
  if (parsed.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "credentials" };
  }
  if (parsed.port !== "") return { ok: false, reason: "port" };
  const { hostname } = parsed;
  if (DOTTED_DECIMAL.test(hostname) || hostname.startsWith("[")) {
    return { ok: false, reason: "address" };
  }
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!host.includes(".") || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: "hostname" };
  }
  return { ok: true, url: parsed.href, hostname };
}

export const signalCandidateId = (feedId: string, itemKey: string) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([1, "feed", feedId, itemKey]), "utf8")
    .digest("hex");

export const signalDigest = ({
  feedId,
  itemKey,
  title,
  summary,
  link,
}: {
  readonly feedId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly summary: string;
  readonly link: string | null;
}) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([1, "feed", feedId, itemKey, title, summary, link]), "utf8")
    .digest("hex");

const CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** The contract's text rule: NFC, control and bidirectional characters removed, white space collapsed, trimmed. */
export const normalizeText = (raw: string) =>
  raw.normalize("NFC").replace(CONTROL, "").replace(/\s+/g, " ").trim();

/** One normalized line of 1 to 200 characters; the digest binds the title, so it is never rewritten. */
export const isNormalizedLine = (title: string) =>
  title.length >= 1 && title.length <= 200 && normalizeText(title) === title;

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
// The exclusive successor of a prefix that ends in "/": no key under the prefix is missed.
const prefixEnd = (prefix: string) => `${prefix.slice(0, -1)}0`;
const isSegment = (value: string) => value.length > 0 && !value.includes("/");
const candidateKey = (candidate: FactorySignalCandidate) => `${candidate.feedId}/${candidate.id}`;

const jsonRow = <A, I>(schema: Schema.Codec<A, I>) => {
  const codec = Schema.fromJsonString(Schema.toCodecJson(schema));
  return { decode: Schema.decodeOption(codec), encode: Schema.encodeEffect(codec) };
};
const feedRow = jsonRow(FactorySignalFeed);
const stateRow = jsonRow(FactorySignalFeedState);
const candidateRow = jsonRow(FactorySignalCandidate);

export const make = Effect.gen(function* () {
  const keyValues = yield* KeyValues;
  const sql = yield* SqlClient.SqlClient;

  const getFeed = Effect.fn("FactorySignals.getFeed")(function* (feedId: string) {
    if (!isSegment(feedId)) return undefined;
    const text = yield* keyValues.get(`${FEED_PREFIX}${feedId}`);
    const feed = text === undefined ? undefined : Option.getOrUndefined(feedRow.decode(text));
    return feed?.id === feedId ? feed : undefined;
  });

  const setFeed = Effect.fn("FactorySignals.setFeed")(function* (feed: FactorySignalFeed) {
    const text = yield* feedRow.encode(feed).pipe(Effect.orDie);
    yield* keyValues.set(`${FEED_PREFIX}${feed.id}`, text);
  });

  const scan = Effect.fn("FactorySignals.scan")(function* (
    prefix: string,
    visit: (id: string, valueJson: string) => void,
  ) {
    const end = prefixEnd(prefix);
    for (let offset = 0; ; offset += PAGE) {
      const rows = yield* sql<{ readonly key: string; readonly value_json: string }>`
        SELECT key, value_json FROM workflow_store
        WHERE key >= ${prefix} AND key < ${end}
        ORDER BY key LIMIT ${PAGE} OFFSET ${offset}
      `.pipe(Effect.orDie);
      for (const row of rows) visit(row.key.slice(prefix.length), row.value_json);
      if (rows.length < PAGE) break;
    }
  });

  const countFeeds = Effect.fn("FactorySignals.countFeeds")(function* () {
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM workflow_store
      WHERE key >= ${FEED_PREFIX} AND key < ${prefixEnd(FEED_PREFIX)}
    `.pipe(Effect.orDie);
    return rows[0]?.count ?? 0;
  });

  // The caller has bounded the row count; this reads them whole.
  const listFeeds = Effect.fn("FactorySignals.listFeeds")(function* () {
    const feeds: Array<FactorySignalFeed> = [];
    yield* scan(FEED_PREFIX, (id, valueJson) => {
      const feed = Option.getOrUndefined(feedRow.decode(valueJson));
      if (feed !== undefined && isSegment(id) && feed.id === id) feeds.push(feed);
    });
    return feeds;
  });

  const removeFeed = Effect.fn("FactorySignals.removeFeed")(function* (feedId: string) {
    const prefix = `${CANDIDATE_PREFIX}${feedId}/`;
    yield* keyValues.delete(`${FEED_PREFIX}${feedId}`);
    yield* keyValues.delete(`${STATE_PREFIX}${feedId}`);
    yield* sql`
      DELETE FROM workflow_store WHERE key >= ${prefix} AND key < ${prefixEnd(prefix)}
    `.pipe(Effect.orDie);
  });

  const getCandidate = Effect.fn("FactorySignals.getCandidate")(function* (
    feedId: string,
    candidateId: string,
  ) {
    if (!isSegment(feedId) || !isSegment(candidateId)) return undefined;
    const text = yield* keyValues.get(`${CANDIDATE_PREFIX}${feedId}/${candidateId}`);
    const candidate =
      text === undefined ? undefined : Option.getOrUndefined(candidateRow.decode(text));
    return candidate?.feedId === feedId && candidate.id === candidateId ? candidate : undefined;
  });

  const setCandidate = Effect.fn("FactorySignals.setCandidate")(function* (
    candidate: FactorySignalCandidate,
  ) {
    const text = yield* candidateRow.encode(candidate).pipe(Effect.orDie);
    yield* keyValues.set(`${CANDIDATE_PREFIX}${candidateKey(candidate)}`, text);
  });

  const list = Effect.fn("FactorySignals.list")(function* (view: "pending" | "decided") {
    let damaged = 0;
    const feeds = new Map<string, FactorySignalFeed>();
    yield* scan(FEED_PREFIX, (id, valueJson) => {
      const feed = Option.getOrUndefined(feedRow.decode(valueJson));
      if (feed === undefined || !isSegment(id) || feed.id !== id) damaged++;
      else feeds.set(id, feed);
    });
    const states = new Map<string, FactorySignalFeedState>();
    yield* scan(STATE_PREFIX, (id, valueJson) => {
      const state = Option.getOrUndefined(stateRow.decode(valueJson));
      if (state === undefined || !isSegment(id) || state.feedId !== id) damaged++;
      else states.set(id, state);
    });

    const pending = new Map<string, number>();
    // A timestamp is read as an instant; an unset decision time sorts last.
    const newest = (
      left: { readonly candidate: FactorySignalCandidate; readonly at: number },
      right: { readonly candidate: FactorySignalCandidate; readonly at: number },
    ) =>
      left.at === right.at
        ? compareText(candidateKey(left.candidate), candidateKey(right.candidate))
        : left.at > right.at
          ? -1
          : 1;
    let eligible = 0;
    let kept: Array<{ readonly candidate: FactorySignalCandidate; readonly at: number }> = [];
    yield* scan(CANDIDATE_PREFIX, (id, valueJson) => {
      const candidate = Option.getOrUndefined(candidateRow.decode(valueJson));
      const [feedId, candidateId, ...rest] = id.split("/");
      const changed = candidate === undefined ? NaN : Date.parse(candidate.changedAt);
      const decidedAt = candidate?.decidedAt ?? null;
      const decided = decidedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(decidedAt);
      if (
        candidate === undefined ||
        rest.length > 0 ||
        candidate.feedId !== feedId ||
        candidate.id !== candidateId ||
        Number.isNaN(changed) ||
        Number.isNaN(decided)
      ) {
        damaged++;
        return;
      }
      if (candidate.state === "pending") {
        pending.set(candidate.feedId, (pending.get(candidate.feedId) ?? 0) + 1);
      }
      if ((view === "pending") !== (candidate.state === "pending")) return;
      eligible++;
      kept.push({ candidate, at: view === "pending" ? changed : decided });
      // Only the newest rows can still be listed, so the buffer stays small however many exist.
      if (kept.length > FACTORY_SIGNAL_LIST_LIMIT * 2) {
        kept = kept.sort(newest).slice(0, FACTORY_SIGNAL_LIST_LIMIT);
      }
    });

    const views: Array<FactorySignalFeedView> = [...feeds.values()]
      .sort((left, right) => compareText(left.id, right.id))
      .map((feed) => ({
        feed,
        state: states.get(feed.id) ?? null,
        pending: pending.get(feed.id) ?? 0,
      }));
    return {
      feeds: views,
      candidates: kept
        .sort(newest)
        .slice(0, FACTORY_SIGNAL_LIST_LIMIT)
        .map(({ candidate }) => candidate),
      damaged,
      truncated: eligible > FACTORY_SIGNAL_LIST_LIMIT,
    } satisfies FactorySignalsList;
  });

  return {
    getFeed,
    setFeed,
    countFeeds,
    listFeeds,
    removeFeed,
    getCandidate,
    setCandidate,
    list,
  };
}).pipe(Effect.provide(layerKeyValues));
