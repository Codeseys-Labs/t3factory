// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type * as NodeDns from "node:dns";
import type * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";
import * as NodeTimersPromises from "node:timers/promises";

import {
  FactorySignalCandidate,
  FactorySignalFailure,
  FactorySignalFeed,
  FactorySignalFeedState,
  FactoryTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import {
  addressRefusal,
  checkFeedUrl,
  cutText,
  type FeedTransport,
  fetchFeed,
  htmlText,
  isDue,
  makeNodeTransport,
  normalizeText,
  parseFeed,
  pinnedLookup,
  planPull,
  signalCandidateId,
  signalDigest,
} from "../../factory/workflows/lib/signals.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Service = Workflows.Workflows["Service"];
type Candidate = typeof FactorySignalCandidate.Encoded;
type FeedState = typeof FactorySignalFeedState.Encoded;
type RequestInput = Parameters<FeedTransport["request"]>[0];
type TransportReply = Awaited<ReturnType<FeedTransport["request"]>>;
interface Item {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  readonly link: string | null;
}

const FEED_1 = "00000000-0000-4000-8000-000000000001";
const FEED_2 = "00000000-0000-4000-8000-000000000002";
const FEED_3 = "00000000-0000-4000-8000-000000000003";
const FEED_4 = "00000000-0000-4000-8000-000000000004";
const FEED_5 = "00000000-0000-4000-8000-000000000005";
const FEED_6 = "00000000-0000-4000-8000-000000000006";
const FEED_7 = "00000000-0000-4000-8000-000000000007";
const TASK_ID = "90000000-0000-4000-8000-000000000001";
const PROJECT = "project-1";
const AT = "2026-01-01T00:00:00.000Z";
const ATOM_KEY = "urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a";
const ATOM_ID = "84f7cf3a930664bba8cd13146d587d8e1cee95a9f3fe93b9e90a204ba1197694";
const ATOM_SHA = "4371b82b1bbfd64591425404a45b6a3e2efa8f1c6ebc10d00507fb74bf4b3a07";
const CAFE_SHA = "7d1dd24149dc3c82d144eee9e34f41f99ec48714ccf7d6b5e62f56c85ad17925";
const PUBLIC_V4 = "93.184.215.14";
const PUBLIC_V6 = "2606:4700:4700::1111";
const LAST_MODIFIED = "Wed, 21 Oct 2015 07:28:00 GMT";
const FEED_HOST = "feeds.example";
const FEED_URL = "https://feeds.example/feed.xml";
const LIMITS = { timeoutMs: 5000, maxBytes: 262144 };
const NO_VALIDATORS = { etag: null, lastModified: null };
const HEADERS = {
  accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
  "accept-encoding": "identity",
  "user-agent": "T3Factory-Signals/1",
};
const TRANSPORT_KEY = Symbol.for("t3factory.signals.transport");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RSS_DOC =
  '<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet href="s.xsl"?><rss version="2.0"><channel><title>C</title><item><title>Caf&#xE9; &amp; more</title><link>https://example.com/a</link><guid isPermaLink="false">a-1</guid><description><![CDATA[<p>Hello&nbsp;<b>world</b></p>]]></description></item><item><title></title><description>Only &lt;i&gt;text&lt;/i&gt;</description><link>https://example.com/b</link></item><item><title>No key</title></item></channel></rss>';
const RSS_KEYED: Item = {
  key: "a-1",
  title: "Caf\u00e9 & more",
  summary: "Hello world",
  link: "https://example.com/a",
};
const RSS_LINKED: Item = {
  key: "https://example.com/b",
  title: "Only text",
  summary: "Only text",
  link: "https://example.com/b",
};
const RSS_ITEMS: ReadonlyArray<Item> = [RSS_KEYED, RSS_LINKED];
const ATOM_DOC =
  '<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><entry><id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a</id><title type="html">Atom-Powered &lt;b&gt;Robots&lt;/b&gt; Run Amok</title><link rel="edit" href="https://example.org/e/1"/><link href="http://example.org/2003/12/13/atom03"/><summary>Some text.</summary></entry></feed>';
const ATOM_ITEM: Item = {
  key: ATOM_KEY,
  title: "Atom-Powered Robots Run Amok",
  summary: "Some text.",
  link: "http://example.org/2003/12/13/atom03",
};
const EMPTY_RSS = { ok: true, format: "rss", items: [], skipped: 0, overflow: 0 };

const sha256Of = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const candidateIdOf = (feedId: string, itemKey: string) => sha256Of([1, "feed", feedId, itemKey]);
const digestOf = (feedId: string, item: Item) =>
  sha256Of([1, "feed", feedId, item.key, item.title, item.summary, item.link]);

const feedKey = (feedId: string) => `factory/v1/signal-feed/${feedId}`;
const stateKey = (feedId: string) => `factory/v1/signal-state/${feedId}`;
const candidateKey = (feedId: string, candidateId: string) =>
  `factory/v1/signal-candidate/${feedId}/${candidateId}`;

const pendingOf = (
  feedId: string,
  item: Item,
  at: string,
  projectId: string | null = null,
): Candidate => ({
  v: 1,
  id: candidateIdOf(feedId, item.key),
  feedId,
  projectId,
  itemKey: item.key,
  revision: 1,
  sha256: digestOf(feedId, item),
  title: item.title,
  summary: item.summary,
  link: item.link,
  state: "pending",
  firstSeenAt: at,
  changedAt: at,
  decidedAt: null,
  decidedRevision: null,
  decidedSha256: null,
  taskId: null,
});
const decidedOf = (
  record: Candidate,
  state: "admitted" | "dismissed",
  decidedAt: string,
  taskId: string | null = null,
): Candidate => ({
  ...record,
  state,
  decidedAt,
  decidedRevision: record.revision,
  decidedSha256: record.sha256,
  taskId,
});
const stateOf = (feedId: string, fields: Partial<FeedState> = {}): FeedState => ({
  v: 1,
  feedId,
  lastPullAt: AT,
  lastOkAt: null,
  etag: null,
  lastModified: null,
  failures: 0,
  failure: null,
  httpStatus: null,
  items: 0,
  ...fields,
});
const feedOf = (id: string, url: string, projectId: string | null = null) => ({
  v: 1,
  id,
  url,
  label: `Feed ${id.slice(-2)}`,
  projectId,
  addedAt: AT,
});
const minuteAt = (base: string, minutes: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(base), { minutes }));
const rssItems = (
  items: ReadonlyArray<Item>,
  counts: { readonly skipped?: number; readonly overflow?: number } = {},
) => ({ ok: true, format: "rss", items, skipped: 0, overflow: 0, ...counts });
const rssOf = (items: string) => `<rss version="2.0"><channel>${items}</channel></rss>`;
const entry = (guid: string, title: string) =>
  `<item><guid>${guid}</guid><title>${title}</title></item>`;

const decodeCandidate = Schema.decodeUnknownSync(FactorySignalCandidate);
const decodeCandidateEffect = Schema.decodeUnknownEffect(FactorySignalCandidate);
const decodeStateEffect = Schema.decodeUnknownEffect(FactorySignalFeedState);
const decodeFeedEffect = Schema.decodeUnknownEffect(FactorySignalFeed);
const decodeTaskEffect = Schema.decodeUnknownEffect(FactoryTask);

it("pack 1: normalizeText, cutText, signalCandidateId and signalDigest give the S4 vectors", () => {
  expect(normalizeText("  Cafe\u0301\t\u2713\u202E\r\n")).toBe("Caf\u00e9 \u2713");
  expect(normalizeText("a\u0000b\u200Ec\u2066")).toBe("abc");
  expect(cutText("ab\uD83D\uDE00c", 3)).toBe("ab");
  expect(cutText("a b c", 2)).toBe("a");
  expect(cutText("abc", 3)).toBe("abc");

  expect(signalCandidateId(FEED_1, ATOM_KEY)).toBe(ATOM_ID);
  expect(signalCandidateId(FEED_1, ATOM_KEY)).toBe(candidateIdOf(FEED_1, ATOM_KEY));
  const robots = {
    feedId: FEED_1,
    itemKey: ATOM_KEY,
    title: ATOM_ITEM.title,
    summary: ATOM_ITEM.summary,
    link: ATOM_ITEM.link,
  };
  expect(signalDigest(robots)).toBe(ATOM_SHA);
  expect(signalDigest(robots)).toBe(digestOf(FEED_1, ATOM_ITEM));
  const cafe = {
    feedId: FEED_1,
    itemKey: ATOM_KEY,
    title: "Caf\u00e9 \u2713",
    summary: "",
    link: null,
  };
  expect(signalDigest(cafe)).toBe(CAFE_SHA);
  expect(signalDigest(cafe)).toBe(
    sha256Of([1, "feed", FEED_1, ATOM_KEY, "Caf\u00e9 \u2713", "", null]),
  );
});

const LONG_URL = `https://example.com/${"a".repeat(2029)}`;
const WIDE_URL = `https://example.com/${"\u00e9".repeat(700)}`;

it("pack 1: the long-URL fixtures have the lengths S5 names", () => {
  expect(LONG_URL).toHaveLength(2049);
  expect(WIDE_URL).toHaveLength(720);
  expect(new URL(WIDE_URL).href).toHaveLength(4220);
});

it.each([
  {
    label: "a mixed-case host and a space",
    text: "https://Example.COM/a b",
    expected: { ok: true, url: "https://example.com/a%20b", hostname: "example.com" },
  },
  {
    label: "port 443",
    text: "https://example.com:443/x",
    expected: { ok: true, url: "https://example.com/x", hostname: "example.com" },
  },
  {
    label: "surrounding spaces",
    text: "  https://example.com/feed  ",
    expected: { ok: true, url: "https://example.com/feed", hostname: "example.com" },
  },
  { label: "http", text: "http://example.com/", expected: { ok: false, reason: "scheme" } },
  { label: "ftp", text: "ftp://example.com/", expected: { ok: false, reason: "scheme" } },
  {
    label: "http with a user and an address",
    text: "http://u@127.0.0.1:80/",
    expected: { ok: false, reason: "scheme" },
  },
  {
    label: "a user and password",
    text: "https://u:p@example.com/",
    expected: { ok: false, reason: "credentials" },
  },
  {
    label: "port 8443",
    text: "https://example.com:8443/",
    expected: { ok: false, reason: "port" },
  },
  { label: "127.0.0.1", text: "https://127.0.0.1/", expected: { ok: false, reason: "address" } },
  { label: "2130706433", text: "https://2130706433/", expected: { ok: false, reason: "address" } },
  { label: "127.1", text: "https://127.1/", expected: { ok: false, reason: "address" } },
  { label: "0x7f.1", text: "https://0x7f.1/", expected: { ok: false, reason: "address" } },
  {
    label: "017700000001",
    text: "https://017700000001/",
    expected: { ok: false, reason: "address" },
  },
  { label: "[::1]", text: "https://[::1]/", expected: { ok: false, reason: "address" } },
  {
    label: "[::ffff:7f00:1]",
    text: "https://[::ffff:7f00:1]/",
    expected: { ok: false, reason: "address" },
  },
  { label: "localhost", text: "https://localhost/", expected: { ok: false, reason: "hostname" } },
  {
    label: "a dotless host",
    text: "https://intranet/",
    expected: { ok: false, reason: "hostname" },
  },
  { label: ".local", text: "https://printer.local/", expected: { ok: false, reason: "hostname" } },
  {
    label: ".internal",
    text: "https://metadata.google.internal/",
    expected: { ok: false, reason: "hostname" },
  },
  {
    label: "a fragment",
    text: "https://example.com/#top",
    expected: { ok: false, reason: "not-a-url" },
  },
  {
    label: "an empty fragment",
    text: "https://example.com/?q=1#",
    expected: { ok: false, reason: "not-a-url" },
  },
  { label: "no scheme", text: "example.com/feed", expected: { ok: false, reason: "not-a-url" } },
  {
    label: "an invalid address",
    text: "https://1.2.3.999/",
    expected: { ok: false, reason: "not-a-url" },
  },
  { label: "2049 characters", text: LONG_URL, expected: { ok: false, reason: "not-a-url" } },
  {
    label: "720 characters that are 4220 canonical",
    text: WIDE_URL,
    expected: { ok: false, reason: "not-a-url" },
  },
])("pack 1: checkFeedUrl of $label", ({ text, expected }) => {
  expect(checkFeedUrl(text)).toEqual(expected);
});

it.each([
  { address: "93.184.215.14", reason: null },
  { address: "172.32.0.1", reason: null },
  { address: "2606:4700:4700::1111", reason: null },
  { address: "10.1.2.3", reason: "private" },
  { address: "100.64.0.1", reason: "private" },
  { address: "172.31.255.255", reason: "private" },
  { address: "192.168.1.1", reason: "private" },
  { address: "fd12:3456::1", reason: "private" },
  { address: "127.0.0.1", reason: "loopback" },
  { address: "::1", reason: "loopback" },
  { address: "::ffff:127.0.0.1", reason: "loopback" },
  { address: "169.254.169.254", reason: "metadata" },
  { address: "168.63.129.16", reason: "metadata" },
  { address: "fd00:ec2::254", reason: "metadata" },
  { address: "169.254.1.1", reason: "link-local" },
  { address: "fe80::1", reason: "link-local" },
  { address: "0.0.0.0", reason: "unspecified" },
  { address: "::", reason: "unspecified" },
  { address: "224.0.0.1", reason: "multicast" },
  { address: "ff02::1", reason: "multicast" },
  { address: "192.0.2.1", reason: "reserved" },
  { address: "198.18.0.1", reason: "reserved" },
  { address: "255.255.255.255", reason: "reserved" },
  { address: "::ffff:8.8.8.8", reason: "reserved" },
  { address: "64:ff9b::a00:1", reason: "reserved" },
  { address: "2001:db8::1", reason: "reserved" },
  { address: "2002:7f00:1::", reason: "reserved" },
  { address: "fe80::1%eth0", reason: "invalid" },
  { address: "not-an-ip", reason: "invalid" },
  { address: "1.2.3", reason: "invalid" },
])("pack 1: addressRefusal($address) is $reason", ({ address, reason }) => {
  expect(addressRefusal(address)).toBe(reason);
});

// Edges of the S6 rows, read from the CIDR blocks themselves rather than printed vectors.
it.each([
  { address: "100.63.255.255", reason: null },
  { address: "100.127.255.255", reason: "private" },
  { address: "100.128.0.0", reason: null },
  { address: "172.15.255.255", reason: null },
  { address: "172.16.0.0", reason: "private" },
  { address: "198.19.255.255", reason: "reserved" },
  { address: "198.20.0.0", reason: null },
  { address: "239.255.255.255", reason: "multicast" },
  { address: "240.0.0.1", reason: "reserved" },
  { address: "::ffff:10.0.0.1", reason: "private" },
  { address: "::ffff:a00:1", reason: "private" },
  { address: "::ffff:169.254.169.254", reason: "metadata" },
  { address: "fd00:ec2::253", reason: "private" },
  { address: "febf::1", reason: "link-local" },
  { address: "fec0::1", reason: "reserved" },
  { address: "2001:1ff::1", reason: "reserved" },
  { address: "2001:200::1", reason: null },
  { address: "3fff::1", reason: "reserved" },
  { address: "4000::1", reason: "reserved" },
])("pack 1: addressRefusal($address) at a row's edge is $reason", ({ address, reason }) => {
  expect(addressRefusal(address)).toBe(reason);
});

it("pack 2: parseFeed gives the S8 RSS and Atom vectors, and htmlText the unclosed tag one", () => {
  expect(parseFeed(RSS_DOC)).toEqual(rssItems(RSS_ITEMS, { skipped: 1 }));
  expect(parseFeed(ATOM_DOC)).toEqual({
    ok: true,
    format: "atom",
    items: [ATOM_ITEM],
    skipped: 0,
    overflow: 0,
  });
  expect(parseFeed('<rss version="2.0"/>')).toEqual(EMPTY_RSS);
  expect(htmlText("a<b")).toBe("a");
});

it("pack 2: an Atom entry falls back to content, empties content with src, takes the alternate link", () => {
  const atom = (entries: string) => `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
  expect(
    parseFeed(
      atom(
        '<entry><id>e-1</id><title>One</title><link rel="alternate" href="https://example.com/1"/><content type="html">&lt;p&gt;Body&lt;/p&gt;</content></entry>' +
          '<entry><id>e-2</id><title>Two</title><link rel="related" href="https://example.com/r"/><content src="https://example.com/2.txt"/></entry>',
      ),
    ),
  ).toEqual({
    ok: true,
    format: "atom",
    items: [
      { key: "e-1", title: "One", summary: "Body", link: "https://example.com/1" },
      { key: "e-2", title: "Two", summary: "", link: null },
    ],
    skipped: 0,
    overflow: 0,
  });
});

it.each([
  { label: "a DOCTYPE", text: '<!DOCTYPE rss [<!ENTITY x "y">]><rss/>', reason: "dtd" },
  { label: "a doctype in a comment", text: "<rss><!-- <!doctype html> --></rss>", reason: "dtd" },
  {
    label: "an ENTITY in CDATA",
    text: '<rss><channel><title><![CDATA[<!ENTITY x "y">]]></title></channel></rss>',
    reason: "dtd",
  },
  {
    label: "&nbsp;",
    text: "<rss><channel><title>&nbsp;</title></channel></rss>",
    reason: "entity",
  },
  { label: "&#0;", text: "<rss><channel><title>&#0;</title></channel></rss>", reason: "entity" },
  {
    label: "a 12-character reference",
    text: "<rss><channel><title>&#x00000041;</title></channel></rss>",
    reason: "entity",
  },
  {
    label: "a bare &",
    text: "<rss><channel><title>a & b</title></channel></rss>",
    reason: "entity",
  },
  {
    label: "a mismatched close",
    text: "<rss><channel></item></channel></rss>",
    reason: "malformed",
  },
  { label: "a second root", text: "<rss/><rss/>", reason: "malformed" },
  { label: "a U+FEFF before the root", text: "\uFEFF<rss/>", reason: "malformed" },
  { label: "rdf:RDF", text: "<rdf:RDF></rdf:RDF>", reason: "format" },
  { label: "a feed with no xmlns", text: "<feed><entry/></feed>", reason: "format" },
  {
    label: "32 nested elements below the root",
    text: `<rss>${"<a>".repeat(32)}${"</a>".repeat(32)}</rss>`,
    reason: "too-deep",
  },
  {
    label: "an ISO-8859-1 declaration",
    text: '<?xml version="1.0" encoding="ISO-8859-1"?><rss/>',
    reason: "encoding",
  },
])("pack 2: parseFeed refuses $label with $reason", ({ text, reason }) => {
  expect(parseFeed(text)).toEqual({ ok: false, reason });
});

it("pack 2: parseFeed returns the first 50 of 60 usable items and skips a repeated key", () => {
  const sixty = Array.from({ length: 60 }, (_, index) => entry(`g-${index}`, `Item ${index}`));
  expect(parseFeed(rssOf(sixty.join("")))).toEqual(
    rssItems(
      Array.from({ length: 50 }, (_, index) => ({
        key: `g-${index}`,
        title: `Item ${index}`,
        summary: "",
        link: null,
      })),
      { overflow: 10 },
    ),
  );
  expect(
    parseFeed(rssOf(entry("same", "First") + entry("same", "Second") + entry("other", "Third"))),
  ).toEqual(
    rssItems(
      [
        { key: "same", title: "First", summary: "", link: null },
        { key: "other", title: "Third", summary: "", link: null },
      ],
      { skipped: 1 },
    ),
  );
});

const attributes = (count: number) =>
  Array.from({ length: count }, (_, index) => ` a${index}="x"`).join("");

it.each([
  { label: "an element name of 256", text: `<rss><${"n".repeat(256)}/></rss>`, reason: null },
  {
    label: "an element name of 257",
    text: `<rss><${"n".repeat(257)}/></rss>`,
    reason: "malformed",
  },
  { label: "an attribute name of 256", text: `<rss ${"n".repeat(256)}="x"/>`, reason: null },
  {
    label: "an attribute name of 257",
    text: `<rss ${"n".repeat(257)}="x"/>`,
    reason: "malformed",
  },
  { label: "32 attributes", text: `<rss${attributes(32)}/>`, reason: null },
  { label: "33 attributes", text: `<rss${attributes(33)}/>`, reason: "malformed" },
  {
    label: "an attribute value of 4096",
    text: `<rss version="${"v".repeat(4096)}"/>`,
    reason: null,
  },
  {
    label: "an attribute value of 4097",
    text: `<rss version="${"v".repeat(4097)}"/>`,
    reason: "malformed",
  },
  {
    label: "4096 characters decoded from references",
    text: `<rss version="${"&amp;".repeat(4096)}"/>`,
    reason: null,
  },
  {
    label: "4097 characters decoded from references",
    text: `<rss version="${"&amp;".repeat(4097)}"/>`,
    reason: "malformed",
  },
  {
    label: "a reference of 11",
    text: "<rss><channel><title>&#00000065;</title></channel></rss>",
    reason: "entity",
  },
  {
    label: "31 nested elements below the root",
    text: `<rss>${"<a>".repeat(31)}${"</a>".repeat(31)}</rss>`,
    reason: null,
  },
])("pack 3: parseFeed of $label characters or elements answers $reason", ({ text, reason }) => {
  expect(parseFeed(text)).toEqual(reason === null ? EMPTY_RSS : { ok: false, reason });
});

it("pack 3: a reference of 10 characters is read", () => {
  expect(parseFeed(rssOf(entry("k", "&#0000065;")))).toEqual(
    rssItems([{ key: "k", title: "A", summary: "", link: null }]),
  );
});

const describedItem = (cdata: string) =>
  rssOf(
    `<item><guid>k</guid><title>T</title><description><![CDATA[${cdata}]]></description></item>`,
  );

it("pack 4: a description is cut at 16384 characters before htmlText reads it", () => {
  // 2429 whole tags (17003 characters): cut at exactly 17000, a split `<` would hide TAIL
  // whether or not the field is capped, so the test would not fail without the cap.
  expect(parseFeed(describedItem(`${"<i></i>".repeat(2429)}TAIL`))).toEqual(
    rssItems([{ key: "k", title: "T", summary: "", link: null }]),
  );
  expect(parseFeed(describedItem(`${"<i></i>".repeat(100)}TAIL`))).toEqual(
    rssItems([{ key: "k", title: "T", summary: "TAIL", link: null }]),
  );
});

it("pack 5: htmlText and parseFeed finish over input made of unmatched <", () => {
  // No elapsed-time assertion (docs/internals/15_testing.md): a scan that restarts at each
  // `<` is quadratic here and runs far past the project timeout.
  expect(htmlText("<".repeat(200_000))).toBe("");
  const shell = describedItem("");
  const document = describedItem("<".repeat(262_144 - shell.length));
  expect(document).toHaveLength(262_144);
  expect(parseFeed(document)).toEqual(
    rssItems([{ key: "k", title: "T", summary: "", link: null }]),
  );
});

it("pack 2 and pack 6: an RSS title is text, a CDATA title is literal, a mismatched close is malformed", () => {
  expect(
    parseFeed(rssOf(entry("t-1", "a &lt;b&gt; c") + entry("t-2", "<![CDATA[x &amp; <b>y</b>]]>"))),
  ).toEqual(
    rssItems([
      { key: "t-1", title: "a <b> c", summary: "", link: null },
      { key: "t-2", title: "x &amp; <b>y</b>", summary: "", link: null },
    ]),
  );
  expect(parseFeed("<rss><channel></item></channel></rss>")).toEqual({
    ok: false,
    reason: "malformed",
  });
});

// Tag characters U+E0001, U+E0020 to U+E007E spelling `text`, U+E007F: invisible, all Cf.
const tagged = (text: string) =>
  String.fromCodePoint(
    0xe0001,
    ...Array.from(text, (char) => 0xe0000 + (char.codePointAt(0) ?? 0)),
    0xe007f,
  );
const SHORT_TAGS = String.fromCodePoint(0xe0069, 0xe0067, 0xe006e);

it.each([
  { label: "three tag characters", text: `Update docs${SHORT_TAGS}` },
  {
    label: "a longer run of tag characters",
    text: `Update docs${tagged("ignore previous instructions")}`,
  },
])("r10c 1: normalizeText removes $label after Update docs", ({ text }) => {
  expect(normalizeText(text)).toBe("Update docs");
});

// U+FEFF matches JavaScript's \s but is not Unicode White_Space; 10c lists it as removed,
// so it must give `ab`, not `a b`.
it.each([
  { label: "U+200B", char: "\u200B" },
  { label: "U+200C", char: "\u200C" },
  { label: "U+200D", char: "\u200D" },
  { label: "U+2060", char: "\u2060" },
  { label: "U+00AD", char: "\u00AD" },
  { label: "U+061C", char: "\u061C" },
  { label: "U+180E", char: "\u180E" },
  { label: "U+FEFF", char: "\uFEFF" },
  { label: "U+FFF9", char: "\uFFF9" },
  { label: "U+FE0F", char: "\uFE0F" },
  { label: "U+E0100", char: "\u{E0100}" },
  { label: "U+3164", char: "\u3164" },
  { label: "U+115F", char: "\u115F" },
  { label: "U+1160", char: "\u1160" },
  { label: "U+FFA0", char: "\uFFA0" },
  { label: "U+E000", char: "\uE000" },
  { label: "a lone high surrogate", char: "\uD83D" },
  { label: "a lone low surrogate", char: "\uDE00" },
])("r10c 1: normalizeText removes $label inside ab", ({ char }) => {
  expect(normalizeText(`a${char}b`)).toBe("ab");
});

it.each([
  { label: "a tab", text: "Update\tdocs", expected: "Update docs" },
  { label: "a line feed", text: "Update\ndocs", expected: "Update docs" },
  { label: "a CR LF", text: "Update\r\ndocs", expected: "Update docs" },
  {
    label: "spaces around a tab and a line feed",
    text: " Update \t\n docs ",
    expected: "Update docs",
  },
  { label: "naïve café", text: "na\u00efve caf\u00e9", expected: "na\u00efve caf\u00e9" },
  { label: "日本語", text: "\u65e5\u672c\u8a9e", expected: "\u65e5\u672c\u8a9e" },
  { label: "an emoji with no selector", text: "Ship it \u{1F600}", expected: "Ship it \u{1F600}" },
])("r10c 1: normalizeText gives one visible line for $label", ({ text, expected }) => {
  expect(normalizeText(text)).toBe(expected);
});

it("r10c 1: parseFeed drops tag characters, raw or referenced, from an RSS title", () => {
  const references = "&#xE0069;&#xE0067;&#xE006E;";
  expect(
    parseFeed(
      rssOf(
        entry("raw", `Update docs${SHORT_TAGS}`) +
          entry("long", `Update docs${tagged("ignore previous instructions")}`) +
          entry("referenced", `Update docs${references}`),
      ),
    ),
  ).toEqual(
    rssItems([
      { key: "raw", title: "Update docs", summary: "", link: null },
      { key: "long", title: "Update docs", summary: "", link: null },
      { key: "referenced", title: "Update docs", summary: "", link: null },
    ]),
  );
});

it.each([
  { label: "a space-wrapped U+200B", text: "a \u200B b", expected: "a b" },
  { label: "three decomposed á", text: "a\u0301".repeat(3), expected: "\u00e1".repeat(3) },
  {
    // Removing U+200D joins two runs of 20 into 40 marks, which the cap cuts to 30.
    label: "two runs of 20 marks joined by U+200D",
    text: `x${"\u0301".repeat(20)}\u200D${"\u0301".repeat(20)}`,
    expected: `x${"\u0301".repeat(30)}`,
  },
  {
    label: "tag characters around a word",
    text: `${tagged("hi")}word${tagged("bye")}`,
    expected: "word",
  },
  {
    label: "the S4 vector",
    text: "  Cafe\u0301\t\u2713\u202E\r\n",
    expected: "Caf\u00e9 \u2713",
  },
])("r10c 1: normalizeText of $label is stable once normalized", ({ text, expected }) => {
  const once = normalizeText(text);
  expect(once).toBe(expected);
  expect(normalizeText(once)).toBe(once);
});

it("r10c 2: normalizeText caps a run of combining marks at 30 before NFC", () => {
  const thirty = ("a" + "\u0301".repeat(30)).normalize("NFC");
  // NFC composes a and the first U+0301 into U+00E1, so 29 marks remain after it.
  expect(thirty).toBe(`\u00e1${"\u0301".repeat(29)}`);
  expect(normalizeText("a" + "\u0301".repeat(8192))).toBe(thirty);
  expect(normalizeText("a" + "\u0301".repeat(31))).toBe(thirty);
  expect(normalizeText("a" + "\u0301".repeat(30))).toBe(thirty);
  expect(normalizeText(thirty)).toBe(thirty);
});

it("r10c 2: the cap applies after NFC too, so 30 U+0344 keep exactly 30 marks", () => {
  // NFC turns each U+0344 into U+0308 U+0301, which would make a run of 60.
  const once = normalizeText("a" + "\u0344".repeat(30));
  const marks = once.match(/\p{M}/gu) ?? [];
  expect(marks).toHaveLength(30);
  expect(Array.from(once)).toHaveLength(31);
  expect(once.replace(/\p{M}/gu, "").normalize("NFD").charAt(0)).toBe("a");
  expect(normalizeText(once)).toBe(once);
});

const linked = (key: string, link: string) =>
  `<item><guid>${key}</guid><title>T ${key}</title><link>${link}</link></item>`;

it("r10c 3: linkValue gives null for a raw link over 2000 characters or a host over 253", () => {
  // The dot segments parse to the short href https://example.com/, so only a check of the
  // raw length refuses it.
  const dotted = `https://example.com/${"x/../".repeat(400)}`;
  const wideHost = `https://${"\u65e5".repeat(300)}.com/`;
  const longest = `https://example.com/${"a".repeat(1980)}`;
  expect(dotted).toHaveLength(2020);
  expect(new URL(dotted).href).toBe("https://example.com/");
  expect(longest).toHaveLength(2000);
  expect(
    parseFeed(
      rssOf(linked("dotted", dotted) + linked("host", wideHost) + linked("longest", longest)),
    ),
  ).toEqual(
    rssItems([
      { key: "dotted", title: "T dotted", summary: "", link: null },
      { key: "host", title: "T host", summary: "", link: null },
      { key: "longest", title: "T longest", summary: "", link: longest },
    ]),
  );
});

it("r10c 4: the 16384-character field cap never keeps half of a surrogate pair", () => {
  const title = `x${" ".repeat(16382)}\u{1F600}tail`;
  // The emoji's high surrogate is unit 16383, the last one the cap keeps.
  expect(title.codePointAt(16383)).toBe(0x1f600);
  const parsed = parseFeed(rssOf(entry("k", title)));
  expect(parsed).toEqual(rssItems([{ key: "k", title: "x", summary: "", link: null }]));
  const texts = (parsed.ok ? parsed.items : []).flatMap((item) => [
    item.key,
    item.title,
    item.summary,
    item.link ?? "",
  ]);
  expect(texts).toHaveLength(4);
  expect(texts.every((text) => text.isWellFormed())).toBe(true);
});

const EMPTY_CHANNEL = '<rss version="2.0"><channel/></rss>';

it.each([
  {
    label: "ISO-8859-1 with no space before encoding",
    text: `<?xml version="1.0"encoding="ISO-8859-1"?>${EMPTY_CHANNEL}`,
    expected: { ok: false, reason: "encoding" },
  },
  {
    label: "ISO-8859-1 after a space",
    text: `<?xml version="1.0" encoding="ISO-8859-1"?>${EMPTY_CHANNEL}`,
    expected: { ok: false, reason: "encoding" },
  },
  {
    label: "utf-8",
    text: `<?xml version="1.0" encoding="utf-8"?>${EMPTY_CHANNEL}`,
    expected: EMPTY_RSS,
  },
  {
    label: "UTF-8",
    text: `<?xml version="1.0" encoding="UTF-8"?>${EMPTY_CHANNEL}`,
    expected: EMPTY_RSS,
  },
])("r10c 5: parseFeed reads a declared $label", ({ text, expected }) => {
  expect(parseFeed(text)).toEqual(expected);
});

const reply = (
  status: number,
  headers: Readonly<Record<string, string>> = {},
  body: string | Uint8Array = "",
  truncated = false,
): TransportReply => ({
  status,
  headers,
  body: typeof body === "string" ? new TextEncoder().encode(body) : body,
  truncated,
});

const scripted = (
  addresses: () => Promise<ReadonlyArray<string>>,
  answer: (input: RequestInput) => Promise<TransportReply>,
) => {
  const resolved: Array<string> = [];
  const requested: Array<RequestInput> = [];
  const transport: FeedTransport = {
    resolve: (hostname) => {
      resolved.push(hostname);
      return addresses();
    },
    request: (input) => {
      requested.push(input);
      return answer(input);
    },
  };
  return { transport, resolved, requested };
};

const answering = (
  addresses: ReadonlyArray<string>,
  response: TransportReply = reply(200, {}, "<rss/>"),
) =>
  scripted(
    () => Promise.resolve(addresses),
    () => Promise.resolve(response),
  );

it("pack 6: fetchFeed drops one leading U+FEFF, so one parses, two are malformed, and bad UTF-8 is encoding", async () => {
  const one = answering([PUBLIC_V4], reply(200, {}, '\uFEFF<rss version="2.0"/>'));
  const first = await fetchFeed(FEED_URL, NO_VALIDATORS, one.transport, LIMITS);
  expect(first).toEqual({
    kind: "ok",
    text: '<rss version="2.0"/>',
    etag: null,
    lastModified: null,
  });
  expect(parseFeed(first.kind === "ok" ? first.text : "")).toEqual(EMPTY_RSS);

  const two = answering([PUBLIC_V4], reply(200, {}, '\uFEFF\uFEFF<rss version="2.0"/>'));
  const second = await fetchFeed(FEED_URL, NO_VALIDATORS, two.transport, LIMITS);
  expect(second).toEqual({
    kind: "ok",
    text: '\uFEFF<rss version="2.0"/>',
    etag: null,
    lastModified: null,
  });
  expect(parseFeed(second.kind === "ok" ? second.text : "")).toEqual({
    ok: false,
    reason: "malformed",
  });

  for (const bytes of [
    [0x3c, 0x72, 0x73, 0x73, 0x2f, 0xff, 0x3e],
    [0x3c, 0xc0, 0xaf, 0x3e],
    [0x3c, 0xed, 0xa0, 0x80, 0x3e],
  ]) {
    const invalid = answering([PUBLIC_V4], reply(200, {}, new Uint8Array(bytes)));
    expect(await fetchFeed(FEED_URL, NO_VALIDATORS, invalid.transport, LIMITS)).toMatchObject({
      kind: "failed",
      failure: "encoding",
    });
  }
});

it.each([
  { url: "https://127.0.0.1/feed", reason: "address" },
  { url: "https://[::1]/feed", reason: "address" },
  { url: "http://feeds.example/feed.xml", reason: "scheme" },
  { url: "https://localhost/feed.xml", reason: "hostname" },
  { url: "https://feeds.example:8443/feed.xml", reason: "port" },
  { url: "https://u:p@feeds.example/feed.xml", reason: "credentials" },
])("pack 7: fetchFeed refuses $url with $reason and resolves nothing", async ({ url, reason }) => {
  const stand = answering([PUBLIC_V4]);
  expect(await fetchFeed(url, NO_VALIDATORS, stand.transport, LIMITS)).toEqual({
    kind: "failed",
    failure: reason,
    httpStatus: null,
  });
  expect(stand.resolved).toEqual([]);
  expect(stand.requested).toEqual([]);
});

it.each([
  { label: "a public then a private address", addresses: [PUBLIC_V4, "10.0.0.1"] },
  { label: "a private then a public address", addresses: ["10.0.0.1", PUBLIC_V4] },
  { label: "an answer that is not an address", addresses: [PUBLIC_V4, "not-an-ip"] },
  { label: "a mapped loopback address", addresses: [PUBLIC_V6, "::ffff:127.0.0.1"] },
])("pack 7: fetchFeed requests nothing when the lookup answers $label", async ({ addresses }) => {
  const stand = answering(addresses);
  expect(await fetchFeed(FEED_URL, NO_VALIDATORS, stand.transport, LIMITS)).toEqual({
    kind: "failed",
    failure: "address",
    httpStatus: null,
  });
  expect(stand.resolved).toEqual([FEED_HOST]);
  expect(stand.requested).toEqual([]);
});

it("pack 7: fetchFeed requests the first address with exactly the S7 headers and validators", async () => {
  const request = (address: string, headers: Readonly<Record<string, string>>) => ({
    url: FEED_URL,
    hostname: FEED_HOST,
    address,
    headers,
    maxBytes: LIMITS.maxBytes,
    signal: expect.any(AbortSignal),
  });
  const plain = answering([PUBLIC_V4, PUBLIC_V6]);
  expect(await fetchFeed(FEED_URL, NO_VALIDATORS, plain.transport, LIMITS)).toEqual({
    kind: "ok",
    text: "<rss/>",
    etag: null,
    lastModified: null,
  });
  expect(plain.resolved).toEqual([FEED_HOST]);
  expect(plain.requested).toEqual([request(PUBLIC_V4, HEADERS)]);

  const both = answering([PUBLIC_V6, PUBLIC_V4]);
  await fetchFeed(FEED_URL, { etag: '"abc"', lastModified: LAST_MODIFIED }, both.transport, LIMITS);
  expect(both.requested).toEqual([
    request(PUBLIC_V6, {
      ...HEADERS,
      "if-none-match": '"abc"',
      "if-modified-since": LAST_MODIFIED,
    }),
  ]);

  const etagOnly = answering([PUBLIC_V4]);
  await fetchFeed(FEED_URL, { etag: '"abc"', lastModified: null }, etagOnly.transport, LIMITS);
  expect(etagOnly.requested).toEqual([
    request(PUBLIC_V4, { ...HEADERS, "if-none-match": '"abc"' }),
  ]);

  const dateOnly = answering([PUBLIC_V4]);
  await fetchFeed(
    FEED_URL,
    { etag: null, lastModified: LAST_MODIFIED },
    dateOnly.transport,
    LIMITS,
  );
  expect(dateOnly.requested).toEqual([
    request(PUBLIC_V4, { ...HEADERS, "if-modified-since": LAST_MODIFIED }),
  ]);
});

// Whether httpStatus is the response's code or null after redirect, too-large or encoding is
// unstated (S7 names a code only for `status`), so those rows leave it out.
it.each([
  {
    label: "301",
    response: reply(301, { location: "https://other.example/" }),
    expected: { kind: "failed", failure: "redirect" },
  },
  { label: "302", response: reply(302), expected: { kind: "failed", failure: "redirect" } },
  { label: "308", response: reply(308), expected: { kind: "failed", failure: "redirect" } },
  {
    label: "500",
    response: reply(500, {}, "oops"),
    expected: { kind: "failed", failure: "status", httpStatus: 500 },
  },
  {
    label: "404",
    response: reply(404),
    expected: { kind: "failed", failure: "status", httpStatus: 404 },
  },
  {
    label: "201",
    response: reply(201, {}, "<rss/>"),
    expected: { kind: "failed", failure: "status", httpStatus: 201 },
  },
  {
    label: "content-encoding gzip",
    response: reply(200, { "content-encoding": "gzip" }, "<rss/>"),
    expected: { kind: "failed", failure: "encoding" },
  },
  {
    label: "a content-length above maxBytes",
    response: reply(200, { "content-length": "11" }, "<rss/>"),
    expected: { kind: "failed", failure: "too-large" },
  },
  {
    label: "a truncated body",
    response: reply(200, {}, "<rs", true),
    expected: { kind: "failed", failure: "too-large" },
  },
  {
    label: "a body past maxBytes",
    response: reply(200, {}, "0123456789A"),
    expected: { kind: "failed", failure: "too-large" },
  },
])("pack 8: fetchFeed maps $label", async ({ response, expected }) => {
  const stand = answering([PUBLIC_V4], response);
  expect(
    await fetchFeed(FEED_URL, NO_VALIDATORS, stand.transport, { timeoutMs: 5000, maxBytes: 10 }),
  ).toMatchObject(expected);
  expect(stand.requested).toHaveLength(1);
});

it("pack 8: fetchFeed reads 304 as not-modified, a body of maxBytes, identity, and bounded validators", async () => {
  const read = (response: TransportReply) =>
    fetchFeed(FEED_URL, NO_VALIDATORS, answering([PUBLIC_V4], response).transport, {
      timeoutMs: 5000,
      maxBytes: 10,
    });
  expect(await read(reply(304, { etag: '"v2"' }))).toEqual({
    kind: "not-modified",
    etag: '"v2"',
    lastModified: null,
  });
  expect(await read(reply(304))).toEqual({ kind: "not-modified", etag: null, lastModified: null });
  expect(await read(reply(200, { "content-length": "10" }, "0123456789"))).toEqual({
    kind: "ok",
    text: "0123456789",
    etag: null,
    lastModified: null,
  });
  expect(await read(reply(200, { "content-encoding": " Identity " }, "<rss/>"))).toMatchObject({
    kind: "ok",
    text: "<rss/>",
  });
  expect(
    await read(reply(200, { etag: '"abc"', "last-modified": LAST_MODIFIED }, "<rss/>")),
  ).toEqual({ kind: "ok", text: "<rss/>", etag: '"abc"', lastModified: LAST_MODIFIED });
  expect(await read(reply(200, { etag: "e".repeat(200) }, "<rss/>"))).toMatchObject({
    etag: "e".repeat(200),
  });
  for (const etag of [" abc", "abc ", "", "e".repeat(201), "caf\u00e9", "a\tb"]) {
    expect(
      await read(reply(200, { etag, "last-modified": `${LAST_MODIFIED} ` }, "<rss/>")),
    ).toEqual({
      kind: "ok",
      text: "<rss/>",
      etag: null,
      lastModified: null,
    });
  }
});

it("pack 8: fetchFeed maps a failed or empty lookup to dns and a failed request to network", async () => {
  const thrown = scripted(
    () => Promise.reject(new Error("ENOTFOUND")),
    () => Promise.resolve(reply(200, {}, "<rss/>")),
  );
  expect(await fetchFeed(FEED_URL, NO_VALIDATORS, thrown.transport, LIMITS)).toEqual({
    kind: "failed",
    failure: "dns",
    httpStatus: null,
  });
  expect(thrown.requested).toEqual([]);
  const empty = answering([]);
  expect(await fetchFeed(FEED_URL, NO_VALIDATORS, empty.transport, LIMITS)).toEqual({
    kind: "failed",
    failure: "dns",
    httpStatus: null,
  });
  expect(empty.requested).toEqual([]);
  const broken = scripted(
    () => Promise.resolve([PUBLIC_V4]),
    () => Promise.reject(new Error("ECONNRESET")),
  );
  expect(await fetchFeed(FEED_URL, NO_VALIDATORS, broken.transport, LIMITS)).toEqual({
    kind: "failed",
    failure: "network",
    httpStatus: null,
  });
});

// The project timeout bounds both deadline tests; no elapsed time is measured
// (docs/internals/15_testing.md), so "within one second" is not asserted.
it("pack 8: a request that never settles ends in timeout at the deadline and aborts its signal", async () => {
  const stuck = scripted(
    () => Promise.resolve([PUBLIC_V4]),
    () => Promise.withResolvers<TransportReply>().promise,
  );
  expect(
    await fetchFeed(FEED_URL, NO_VALIDATORS, stuck.transport, { timeoutMs: 50, maxBytes: 262144 }),
  ).toEqual({ kind: "failed", failure: "timeout", httpStatus: null });
  expect(stuck.requested).toHaveLength(1);
  expect(stuck.requested[0]?.signal.aborted).toBe(true);
});

it("pack 8: a lookup that settles after the deadline ends in timeout and is never followed by a request", async () => {
  const lookup = Promise.withResolvers<ReadonlyArray<string>>();
  const late = scripted(
    () => lookup.promise,
    () => Promise.resolve(reply(200, {}, "<rss/>")),
  );
  expect(
    await fetchFeed(FEED_URL, NO_VALIDATORS, late.transport, { timeoutMs: 50, maxBytes: 262144 }),
  ).toEqual({ kind: "failed", failure: "timeout", httpStatus: null });
  // Settled by hand once fetchFeed has answered, past the 50 ms deadline, in place of the
  // clause's 200 ms timer; a fetchFeed that awaited the lookup unraced would never answer.
  lookup.resolve([PUBLIC_V4]);
  await lookup.promise;
  // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
  await NodeTimersPromises.setImmediate();
  expect(late.resolved).toEqual([FEED_HOST]);
  expect(late.requested).toEqual([]);
});

const incoming = (
  statusCode: number,
  headers: Readonly<Record<string, string | ReadonlyArray<string>>>,
  chunks: ReadonlyArray<string>,
  ended: boolean,
) => {
  const stream = new NodeStream.Readable({ read: () => undefined });
  for (const chunk of chunks) stream.push(Buffer.from(chunk));
  if (ended) stream.push(null);
  return Object.assign(stream, { statusCode, headers });
};

// "close" stands for a socket that closes with neither a response nor an error.
const nodeStandIn = (response: NodeStream.Readable | "close") => {
  const lookups: Array<ReadonlyArray<unknown>> = [];
  const requests: Array<NodeHttps.RequestOptions> = [];
  const lookup = (hostname: string, options: unknown) => {
    lookups.push([hostname, options]);
    return Promise.resolve([
      { address: PUBLIC_V4, family: 4 },
      { address: PUBLIC_V6, family: 6 },
    ]);
  };
  // The response arrives once the caller ends the request, as https.request delivers it.
  const request = (
    options: NodeHttps.RequestOptions,
    callback: (message: NodeStream.Readable) => void,
  ) => {
    requests.push(options);
    const outgoing = new NodeStream.Writable({
      autoDestroy: false,
      write: (_chunk, _encoding, done) => done(),
    });
    outgoing.once("finish", () =>
      response === "close" ? outgoing.emit("close") : callback(response),
    );
    return outgoing;
  };
  const transport = makeNodeTransport({
    lookup: lookup as unknown as typeof NodeDns.promises.lookup,
    request: request as unknown as typeof NodeHttps.request,
  });
  return { transport, lookups, requests };
};

const answerOf = (
  lookup: NonNullable<NodeHttps.RequestOptions["lookup"]>,
  options: NodeDns.LookupOptions,
) => {
  const answered = Promise.withResolvers<ReadonlyArray<unknown>>();
  lookup(FEED_HOST, options, (...args: Array<unknown>) => answered.resolve(args));
  return answered.promise;
};

it("pack 9: makeNodeTransport resolves verbatim and requests with exactly the S7 options", async () => {
  const stand = nodeStandIn(
    incoming(
      200,
      { "content-type": "application/rss+xml", etag: '"x"', "set-cookie": ["a=1"] },
      ["hello ", "world"],
      true,
    ),
  );
  expect(await stand.transport.resolve(FEED_HOST)).toEqual([PUBLIC_V4, PUBLIC_V6]);
  expect(stand.lookups).toEqual([[FEED_HOST, { all: true, order: "verbatim" }]]);

  const signal = new AbortController().signal;
  const headers = { ...HEADERS, "if-none-match": '"x"' };
  const answer = await stand.transport.request({
    url: "https://feeds.example/a/feed.xml?x=1&y=2",
    hostname: FEED_HOST,
    address: PUBLIC_V4,
    headers,
    maxBytes: 100,
    signal,
  });
  expect({ ...answer, body: new TextDecoder().decode(answer.body) }).toEqual({
    status: 200,
    headers: { "content-type": "application/rss+xml", etag: '"x"' },
    body: "hello world",
    truncated: false,
  });

  expect(stand.requests).toHaveLength(1);
  const options = stand.requests[0];
  // Revision 10b adds `rejectUnauthorized: true` to the options S7 prints.
  expect(Object.keys(options ?? {}).toSorted()).toEqual([
    "agent",
    "headers",
    "hostname",
    "lookup",
    "method",
    "path",
    "port",
    "rejectUnauthorized",
    "servername",
    "signal",
  ]);
  expect(options).toMatchObject({
    hostname: FEED_HOST,
    servername: FEED_HOST,
    port: 443,
    path: "/a/feed.xml?x=1&y=2",
    method: "GET",
    headers,
    agent: false,
    rejectUnauthorized: true,
  });
  expect(options?.signal).toBe(signal);
  const pinned = options?.lookup;
  if (pinned === undefined) throw new Error("makeNodeTransport passed no lookup");
  expect(await answerOf(pinned, { all: true })).toEqual([
    null,
    [{ address: PUBLIC_V4, family: 4 }],
  ]);
  expect(await answerOf(pinned, {})).toEqual([null, PUBLIC_V4, 4]);
});

it("pack 9: pinnedLookup answers both callback forms with its address and family", async () => {
  expect(await answerOf(pinnedLookup(PUBLIC_V6), { all: true })).toEqual([
    null,
    [{ address: PUBLIC_V6, family: 6 }],
  ]);
  expect(await answerOf(pinnedLookup(PUBLIC_V6), { all: false })).toEqual([null, PUBLIC_V6, 6]);
});

it("pack 9: makeNodeTransport destroys a response past maxBytes and reports truncated", async () => {
  // The stream never ends, so only stopping past maxBytes lets the request answer.
  const response = incoming(200, {}, ["0123", "4567", "89ab", "cdef"], false);
  const stand = nodeStandIn(response);
  const answer = await stand.transport.request({
    url: FEED_URL,
    hostname: FEED_HOST,
    address: PUBLIC_V4,
    headers: HEADERS,
    maxBytes: 10,
    signal: new AbortController().signal,
  });
  expect(answer).toMatchObject({ status: 200, truncated: true });
  expect(response.destroyed).toBe(true);
});

it("pack 9 (r10b): a request whose socket only closes fails at once rather than at the deadline", async () => {
  const stand = nodeStandIn("close");
  const settled = await stand.transport
    .request({
      url: FEED_URL,
      hostname: FEED_HOST,
      address: PUBLIC_V4,
      headers: HEADERS,
      maxBytes: 10,
      signal: new AbortController().signal,
    })
    .then(
      () => "resolved",
      () => "rejected",
    );
  expect(settled).toBe("rejected");
  // 10b's "connect failure" is no FactorySignalFailure; a rejected request is S7's `network`.
  // A transport that waited would end as `timeout` at the 5000 ms deadline instead.
  const fetched = nodeStandIn("close");
  expect(await fetchFeed(FEED_URL, NO_VALIDATORS, fetched.transport, LIMITS)).toEqual({
    kind: "failed",
    failure: "network",
    httpStatus: null,
  });
});

it("pack 9 (r10b): a content-length above maxBytes is too-large with no body byte and the response is destroyed", async () => {
  // No body byte ever arrives, so waiting for one would end as `timeout` instead.
  const response = incoming(200, { "content-length": "11" }, [], false);
  const stand = nodeStandIn(response);
  expect(
    await fetchFeed(FEED_URL, NO_VALIDATORS, stand.transport, { timeoutMs: 5000, maxBytes: 10 }),
  ).toMatchObject({ kind: "failed", failure: "too-large" });
  expect(response.destroyed).toBe(true);
});

const PLAN_AT = "2026-02-01T00:00:00.000Z";
const DISMISSED_AT = "2026-01-10T00:00:00.000Z";
const ADMITTED_AT = "2025-06-01T00:00:00.000Z";
const itemOf = (key: string, title = `Title ${key}`): Item => ({
  key,
  title,
  summary: `Summary of ${key}`,
  link: `https://example.com/${key}`,
});
const changed = (item: Item): Item => ({ ...item, title: `${item.title}, revised` });
const headOf = (key: string) => pendingOf(FEED_1, itemOf(key), AT);
const revisionOf = (record: Candidate, item: Item) => ({
  ...record,
  revision: record.revision + 1,
  sha256: digestOf(FEED_1, item),
  title: item.title,
  summary: item.summary,
  link: item.link,
  changedAt: PLAN_AT,
});
const dismissedRows = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    decidedOf(headOf(`d-${index}`), "dismissed", minuteAt(DISMISSED_AT, index)),
  );
const admittedRows = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    decidedOf(headOf(`a-${index}`), "admitted", minuteAt(ADMITTED_AT, index), `task-${index}`),
  );
type PlanCounts = Record<
  "created" | "revised" | "reopened" | "unchanged" | "capped" | "skipped" | "pruned",
  number
>;
const countsOf = (counts: Partial<PlanCounts>): PlanCounts => ({
  created: 0,
  revised: 0,
  reopened: 0,
  unchanged: 0,
  capped: 0,
  skipped: 0,
  pruned: 0,
  ...counts,
});
const byId = (left: { readonly id: string }, right: { readonly id: string }) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
const only = <T>(rows: ReadonlyArray<T>): T => {
  const [row] = rows;
  if (row === undefined || rows.length !== 1)
    throw new Error(`Expected one row, got ${rows.length}`);
  return row;
};

// S9 leaves the element types of `writes` and `deletes` open: a write is decoded as a
// candidate record, and a delete is read as an id, a key ending in the id, or a record.
const deletedId = (entry: unknown) =>
  typeof entry === "string" ? entry.slice(entry.lastIndexOf("/") + 1) : decodeCandidate(entry).id;
const plan = (
  heads: ReadonlyArray<Candidate>,
  items: ReadonlyArray<Item>,
  options: { readonly projectId?: string | null; readonly damagedIds?: ReadonlyArray<string> } = {},
) => {
  const result = planPull({
    feedId: FEED_1,
    projectId: options.projectId ?? null,
    at: PLAN_AT,
    items,
    heads,
    damagedIds: options.damagedIds ?? [],
  });
  return {
    writes: result.writes.map((write) => decodeCandidate(write)).toSorted(byId),
    deletes: result.deletes.map((removal) => deletedId(removal)).toSorted(),
    counts: result.counts,
  };
};

it("pack 10: planPull creates revision 1 and writes nothing for an equal digest", () => {
  const item = itemOf("k");
  expect(plan([], [item], { projectId: PROJECT })).toEqual({
    writes: [pendingOf(FEED_1, item, PLAN_AT, PROJECT)],
    deletes: [],
    counts: countsOf({ created: 1 }),
  });
  // projectId is outside the digest, so a head with another one is still unchanged.
  expect(plan([pendingOf(FEED_1, item, AT)], [item], { projectId: PROJECT })).toEqual({
    writes: [],
    deletes: [],
    counts: countsOf({ unchanged: 1 }),
  });
});

it("pack 10: planPull revises a pending row and reopens a dismissed row with null decision fields", () => {
  const item = itemOf("k");
  const next = changed(item);
  const head = pendingOf(FEED_1, item, AT);
  expect(plan([head], [next], { projectId: PROJECT })).toEqual({
    writes: [{ ...revisionOf(head, next), projectId: PROJECT }],
    deletes: [],
    counts: countsOf({ revised: 1 }),
  });
  const dismissed = decidedOf(head, "dismissed", minuteAt(AT, 5));
  expect(plan([dismissed], [next])).toEqual({
    writes: [
      {
        ...revisionOf(dismissed, next),
        state: "pending",
        decidedAt: null,
        decidedRevision: null,
        decidedSha256: null,
        taskId: null,
      },
    ],
    deletes: [],
    counts: countsOf({ reopened: 1 }),
  });
});

it("pack 10: planPull keeps an admitted row admitted with its decision and taskId at the next revision", () => {
  const item = itemOf("k");
  const next = changed(item);
  const admitted = decidedOf(pendingOf(FEED_1, item, AT), "admitted", minuteAt(AT, 5), "task-1");
  expect(plan([admitted], [next])).toEqual({
    writes: [revisionOf(admitted, next)],
    deletes: [],
    counts: countsOf({ revised: 1 }),
  });
});

it("pack 10: planPull gives A then B then A a revision 3 whose sha256 is revision 1's", () => {
  const a = itemOf("k", "A");
  const b = itemOf("k", "B");
  const first = only(plan([], [a]).writes);
  const second = only(plan([first], [b]).writes);
  const third = only(plan([second], [a]).writes);
  expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 3]);
  expect(second.sha256).toBe(digestOf(FEED_1, b));
  expect(third.sha256).toBe(first.sha256);
  expect(third).toEqual({ ...first, revision: 3, changedAt: PLAN_AT });
});

it("pack 10: planPull skips an item whose candidate row is damaged and writes nothing for it", () => {
  const item = itemOf("k");
  expect(plan([], [item], { damagedIds: [candidateIdOf(FEED_1, item.key)] })).toEqual({
    writes: [],
    deletes: [],
    counts: countsOf({ skipped: 1 }),
  });
});

it("pack 11: planPull writes no new candidate at 100 pending while still revising and reopening", () => {
  const pending = Array.from({ length: 100 }, (_, index) => headOf(`p-${index}`));
  const fresh = itemOf("new");
  const revised = changed(itemOf("p-0"));
  expect(plan(pending, [fresh, revised, itemOf("p-1")])).toEqual({
    writes: [revisionOf(headOf("p-0"), revised)],
    deletes: [],
    counts: countsOf({ capped: 1, revised: 1, unchanged: 1 }),
  });
  expect(plan(pending.slice(1), [itemOf("n-0"), itemOf("n-1")])).toEqual({
    writes: [pendingOf(FEED_1, itemOf("n-0"), PLAN_AT)],
    deletes: [],
    counts: countsOf({ created: 1, capped: 1 }),
  });
  const dismissed = decidedOf(headOf("d"), "dismissed", DISMISSED_AT);
  const reopened = changed(itemOf("d"));
  expect(plan([...pending, dismissed], [reopened])).toEqual({
    writes: [
      {
        ...revisionOf(dismissed, reopened),
        state: "pending",
        decidedAt: null,
        decidedRevision: null,
        decidedSha256: null,
        taskId: null,
      },
    ],
    deletes: [],
    counts: countsOf({ reopened: 1 }),
  });
});

it("pack 11: planPull prunes 201 unlisted dismissed rows to 200, oldest first, and never 250 admitted rows", () => {
  const dismissed = dismissedRows(201);
  // Admitted rows are older than every dismissed one, so pruning by age alone would take them.
  const admitted = admittedRows(250);
  const oldest = candidateIdOf(FEED_1, "d-0");
  expect(plan(dismissed, [])).toEqual({
    writes: [],
    deletes: [oldest],
    counts: countsOf({ pruned: 1 }),
  });
  expect(plan(admitted, [])).toEqual({ writes: [], deletes: [], counts: countsOf({}) });
  expect(plan([...admitted, ...dismissed], [])).toEqual({
    writes: [],
    deletes: [oldest],
    counts: countsOf({ pruned: 1 }),
  });
});

it("pack 11: planPull breaks a decidedAt tie by id and never prunes a listed row", () => {
  const tied = dismissedRows(201).map((row, index) =>
    index === 1 ? { ...row, decidedAt: minuteAt(DISMISSED_AT, 0) } : row,
  );
  const [first] = [candidateIdOf(FEED_1, "d-0"), candidateIdOf(FEED_1, "d-1")].toSorted();
  expect(plan(tied, []).deletes).toEqual([first]);
  const dismissed = dismissedRows(201);
  expect(plan(dismissed, [itemOf("d-0")])).toEqual({
    writes: [],
    deletes: [candidateIdOf(FEED_1, "d-1")],
    counts: countsOf({ unchanged: 1, pruned: 1 }),
  });
  const everyItem = Array.from({ length: 201 }, (_, index) => itemOf(`d-${index}`));
  expect(plan(dismissed, everyItem)).toEqual({
    writes: [],
    deletes: [],
    counts: countsOf({ unchanged: 201 }),
  });
});

it("pack 11: listed again, a pruned dismissed item is pending revision 1 and an admitted one keeps its taskId", () => {
  const dismissed = dismissedRows(201);
  const admitted = admittedRows(250);
  const heads = [...admitted, ...dismissed];
  const pruned = plan(heads, []);
  const remaining = heads.filter((row) => !pruned.deletes.includes(row.id));
  expect(remaining).toHaveLength(450);
  const back = itemOf("d-0");
  const kept = changed(itemOf("a-0"));
  const admittedHead = only(admitted.filter((row) => row.itemKey === "a-0"));
  expect(plan(remaining, [back, kept, itemOf("a-1")])).toEqual({
    writes: [pendingOf(FEED_1, back, PLAN_AT), revisionOf(admittedHead, kept)].toSorted(byId),
    deletes: [],
    counts: countsOf({ created: 1, revised: 1, unchanged: 1 }),
  });
});

it("pack 13 (isDue): a feed is due with no state, an unreadable or later lastPullAt, or after 60 minutes", () => {
  const now = "2026-01-01T12:00:00.000Z";
  const pulledAt = (lastPullAt: string) => stateOf(FEED_1, { lastPullAt });
  expect(isDue(null, now)).toBe(true);
  expect(isDue(pulledAt("not a time"), now)).toBe(true);
  expect(isDue(pulledAt(minuteAt(now, 1)), now)).toBe(true);
  expect(isDue(pulledAt(minuteAt(now, -60)), now)).toBe(true);
  const justUnder = DateTime.subtract(DateTime.makeUnsafe(now), { milliseconds: 3_599_999 });
  expect(isDue(pulledAt(DateTime.formatIso(justUnder)), now)).toBe(false);
  expect(isDue(pulledAt(now), now)).toBe(false);
});

const FeedPull = Schema.Struct({
  feedId: Schema.String,
  outcome: Schema.Literals(["ok", "not-modified", "failed", "removed", "not-due"]),
  failure: Schema.NullOr(FactorySignalFailure),
  httpStatus: Schema.NullOr(Schema.Number),
  created: Schema.Number,
  revised: Schema.Number,
  reopened: Schema.Number,
  unchanged: Schema.Number,
  capped: Schema.Number,
  skipped: Schema.Number,
  overflow: Schema.Number,
  pruned: Schema.Number,
});
type FeedPull = typeof FeedPull.Type;
const decodeReturn = Schema.decodeUnknownEffect(
  Schema.Struct({ feeds: Schema.Array(FeedPull), damaged: Schema.Number }),
);
const pullOf = (
  feedId: string,
  outcome: FeedPull["outcome"],
  fields: Partial<FeedPull> = {},
): FeedPull => ({
  feedId,
  outcome,
  failure: null,
  httpStatus: null,
  created: 0,
  revised: 0,
  reopened: 0,
  unchanged: 0,
  capped: 0,
  skipped: 0,
  overflow: 0,
  pruned: 0,
  ...fields,
});
// S10 leaves FeedPull's httpStatus after "ok" or "not-modified" open: the code (as the state
// keeps it) or null. Every other field is compared exactly.
const expectPulls = (actual: ReadonlyArray<FeedPull>, expected: ReadonlyArray<FeedPull>) => {
  const fetched = (pull: FeedPull) => pull.outcome === "ok" || pull.outcome === "not-modified";
  const open = (pull: FeedPull) => (fetched(pull) ? { ...pull, httpStatus: "open" } : pull);
  expect(actual.map(open)).toEqual(expected.map(open));
  for (const pull of actual.filter(fetched)) {
    expect([pull.outcome === "ok" ? 200 : 304, null]).toContain(pull.httpStatus);
  }
};

const script = {
  agent: (turn: AgentTurnInput): never => {
    throw new Error(`No agent turn is expected: ${turn.origin.step}`);
  },
  standing: (): never => {
    throw new Error("No pull request is read");
  },
};

const feedStandIn = (replies: Readonly<Record<string, TransportReply>>) => {
  const resolved: Array<string> = [];
  const requested: Array<RequestInput> = [];
  const hooks: { during?: (input: RequestInput) => Promise<void> } = {};
  const transport: FeedTransport = {
    resolve: (hostname) => {
      resolved.push(hostname);
      return Promise.resolve([PUBLIC_V4]);
    },
    request: async (input) => {
      requested.push(input);
      await hooks.during?.(input);
      const answer = replies[input.url];
      if (answer === undefined) throw new Error(`No reply is scripted for ${input.url}`);
      return answer;
    },
  };
  return { transport, resolved, requested, hooks };
};

const signalWorld = async <A, E>(
  transport: FeedTransport,
  use: (world: World, workflows: Service) => Effect.Effect<A, E>,
) => {
  Reflect.set(globalThis, TRANSPORT_KEY, transport);
  try {
    return await withWorld(script, (world) => world.server((workflows) => use(world, workflows)));
  } finally {
    Reflect.deleteProperty(globalThis, TRANSPORT_KEY);
  }
};

const tick = Effect.fn("factoryPack.test.signalTick")(function* (
  world: World,
  workflows: Service,
  key: string,
  scheduledAt?: string,
) {
  const { runId } = yield* workflows.start(
    "factory-signals",
    { scheduledAt: scheduledAt ?? DateTime.formatIso(yield* DateTime.now) },
    { idempotencyKey: key },
  );
  return yield* world.ended(workflows, runId, true);
});

const pulled = Effect.fn("factoryPack.test.signalPulled")(function* (
  world: World,
  workflows: Service,
  key: string,
) {
  const run = yield* tick(world, workflows, key);
  expect(run.status).toBe("completed");
  return yield* decodeReturn(run.result);
});

const storedState = Effect.fn("factoryPack.test.signalState")(function* (
  workflows: Service,
  feedId: string,
) {
  const rows = yield* workflows.stored(stateKey(feedId));
  return yield* decodeStateEffect(only(rows).value);
});

const byKey = <T extends { readonly key: string }>(rows: ReadonlyArray<T>) =>
  rows.toSorted((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

const candidateRows = Effect.fn("factoryPack.test.signalCandidates")(function* (
  workflows: Service,
  prefix: string,
) {
  const rows = yield* workflows.stored(prefix);
  const decoded = yield* Effect.forEach(rows, ({ key, value }) =>
    Effect.map(decodeCandidateEffect(value), (record) => ({ key, value: record })),
  );
  return byKey(decoded);
});

const minutesBefore = (now: DateTime.Utc, minutes: number) =>
  DateTime.formatIso(DateTime.subtract(now, { minutes }));

const ATOM_URL = "https://a.feeds.example/atom.xml";
const RSS_URL = "https://b.feeds.example/rss.xml";
const ATOM_ETAG = '"atom-1"';
const twoFeeds = () =>
  feedStandIn({
    [ATOM_URL]: reply(
      200,
      { "content-type": "application/atom+xml", etag: ATOM_ETAG, "last-modified": LAST_MODIFIED },
      ATOM_DOC,
    ),
    [RSS_URL]: reply(200, { "content-type": "application/rss+xml" }, RSS_DOC),
  });
const seedTwoFeeds = Effect.fn("factoryPack.test.seedSignalFeeds")(function* (workflows: Service) {
  yield* workflows.storeSet(feedKey(FEED_1), feedOf(FEED_1, ATOM_URL));
  yield* workflows.storeSet(feedKey(FEED_2), feedOf(FEED_2, RSS_URL, PROJECT));
});

it("pack 12: a first tick over two feeds writes rows that decode, and nothing else runs", () => {
  const feeds = twoFeeds();
  return signalWorld(
    feeds.transport,
    Effect.fn("factoryPack.test.signalFirstTick")(function* (world, workflows) {
      yield* seedTwoFeeds(workflows);
      const result = yield* pulled(world, workflows, "signals/first");
      expect(result.damaged).toBe(0);
      expectPulls(result.feeds, [
        pullOf(FEED_1, "ok", { created: 1 }),
        pullOf(FEED_2, "ok", { created: 2, skipped: 1 }),
      ]);
      expect(feeds.requested.map((input) => input.url)).toEqual([ATOM_URL, RSS_URL]);

      const atom = yield* storedState(workflows, FEED_1);
      const rss = yield* storedState(workflows, FEED_2);
      expect(atom.lastPullAt).toMatch(ISO);
      expect(atom).toEqual(
        stateOf(FEED_1, {
          lastPullAt: atom.lastPullAt,
          lastOkAt: atom.lastPullAt,
          etag: ATOM_ETAG,
          lastModified: LAST_MODIFIED,
          httpStatus: 200,
          items: 1,
        }),
      );
      expect(rss).toEqual(
        stateOf(FEED_2, {
          lastPullAt: rss.lastPullAt,
          lastOkAt: rss.lastPullAt,
          httpStatus: 200,
          items: 2,
        }),
      );
      const expected = [
        pendingOf(FEED_1, ATOM_ITEM, atom.lastPullAt),
        ...RSS_ITEMS.map((item) => pendingOf(FEED_2, item, rss.lastPullAt, PROJECT)),
      ];
      expect(yield* candidateRows(workflows, "factory/v1/signal-candidate/")).toEqual(
        byKey(
          expected.map((record) => ({
            key: candidateKey(record.feedId, record.id),
            value: record,
          })),
        ),
      );
      for (const row of yield* workflows.stored("factory/v1/signal-feed/")) {
        yield* decodeFeedEffect(row.value);
      }

      expect(world.turns).toEqual([]);
      for (const prefix of ["task/", "attempt/", "note/", "captured/"]) {
        expect(yield* workflows.stored(`factory/v1/${prefix}`)).toEqual([]);
      }
      expect((yield* workflows.list()).map((run) => run.workflow)).toEqual(["factory-signals"]);
    }),
  );
});

it("pack 13: a hand-started tick pulls nothing early; a backdated state is pulled and only its times change", () => {
  const feeds = twoFeeds();
  return signalWorld(
    feeds.transport,
    Effect.fn("factoryPack.test.signalCooldown")(function* (world, workflows) {
      yield* seedTwoFeeds(workflows);
      yield* pulled(world, workflows, "signals/first");
      const calls = { resolved: feeds.resolved.length, requested: feeds.requested.length };
      const candidates = yield* workflows.stored("factory/v1/signal-candidate/");
      const now = yield* DateTime.now;
      for (const [key, scheduledAt] of [
        ["signals/later", DateTime.formatIso(DateTime.add(now, { hours: 2 }))],
        ["signals/earlier", DateTime.formatIso(DateTime.subtract(now, { hours: 2 }))],
      ] as const) {
        expect(yield* tick(world, workflows, key, scheduledAt)).toMatchObject({
          status: "skipped",
          detail: "no feeds due",
        });
      }
      expect({ resolved: feeds.resolved.length, requested: feeds.requested.length }).toEqual(calls);

      // FEED_2 goes further back than FEED_1, so the pull order follows lastPullAt, not the id.
      const atom = {
        ...(yield* storedState(workflows, FEED_1)),
        lastPullAt: minutesBefore(now, 61),
      };
      const rss = {
        ...(yield* storedState(workflows, FEED_2)),
        lastPullAt: minutesBefore(now, 62),
      };
      yield* workflows.storeSet(stateKey(FEED_1), atom);
      yield* workflows.storeSet(stateKey(FEED_2), rss);
      const again = yield* pulled(world, workflows, "signals/again");
      expectPulls(again.feeds, [
        pullOf(FEED_2, "ok", { unchanged: 2, skipped: 1 }),
        pullOf(FEED_1, "ok", { unchanged: 1 }),
      ]);
      expect(
        feeds.requested.slice(calls.requested).map((input) => [input.url, input.headers]),
      ).toEqual([
        [RSS_URL, HEADERS],
        [ATOM_URL, { ...HEADERS, "if-none-match": ATOM_ETAG, "if-modified-since": LAST_MODIFIED }],
      ]);
      expect(yield* workflows.stored("factory/v1/signal-candidate/")).toEqual(candidates);
      for (const before of [atom, rss]) {
        const after = yield* storedState(workflows, before.feedId);
        expect(after).toEqual({
          ...before,
          lastPullAt: after.lastPullAt,
          lastOkAt: after.lastPullAt,
        });
        expect(after.lastPullAt > before.lastPullAt).toBe(true);
      }
    }),
  );
});

it("pack 14: a state written while another feed is fetched makes that feed not-due with no request", () => {
  const feeds = twoFeeds();
  return signalWorld(
    feeds.transport,
    Effect.fn("factoryPack.test.signalReserved")(function* (world, workflows) {
      yield* seedTwoFeeds(workflows);
      // The fetch of the first feed is held open while the test writes the second feed's
      // state through workflows.storeSet, then let go.
      const fetching = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      feeds.hooks.during = (input) => {
        if (input.url !== ATOM_URL) return Promise.resolve();
        fetching.resolve();
        return release.promise;
      };
      const running = yield* Effect.forkChild(pulled(world, workflows, "signals/first"));
      yield* Effect.promise(() => fetching.promise);
      const written = stateOf(FEED_2, { lastPullAt: DateTime.formatIso(yield* DateTime.now) });
      yield* workflows.storeSet(stateKey(FEED_2), written);
      release.resolve();
      const result = yield* Fiber.join(running);
      expectPulls(result.feeds, [pullOf(FEED_1, "ok", { created: 1 }), pullOf(FEED_2, "not-due")]);
      expect(feeds.requested.map((input) => input.url)).toEqual([ATOM_URL]);
      expect(feeds.resolved).toEqual(["a.feeds.example"]);
      expect(yield* workflows.stored(stateKey(FEED_2))).toEqual([
        { key: stateKey(FEED_2), value: written },
      ]);
      expect(yield* workflows.stored(`factory/v1/signal-candidate/${FEED_2}/`)).toEqual([]);
    }),
  );
});

it("pack 15: a feed answering 500 fails alone while the other feed gets its candidates", () => {
  const feeds = feedStandIn({
    [ATOM_URL]: reply(500, {}, "Internal error"),
    [RSS_URL]: reply(200, {}, RSS_DOC),
  });
  return signalWorld(
    feeds.transport,
    Effect.fn("factoryPack.test.signalOneFails")(function* (world, workflows) {
      yield* seedTwoFeeds(workflows);
      const now = yield* DateTime.now;
      const earlier = stateOf(FEED_1, {
        lastPullAt: minutesBefore(now, 120),
        lastOkAt: minutesBefore(now, 120),
        etag: '"old"',
        httpStatus: 200,
        items: 3,
      });
      yield* workflows.storeSet(stateKey(FEED_1), earlier);
      const result = yield* pulled(world, workflows, "signals/first");
      // FEED_2 has no state, so it is pulled first despite its larger id.
      expectPulls(result.feeds, [
        pullOf(FEED_2, "ok", { created: 2, skipped: 1 }),
        pullOf(FEED_1, "failed", { failure: "status", httpStatus: 500 }),
      ]);
      expect(feeds.requested.map((input) => input.url)).toEqual([RSS_URL, ATOM_URL]);
      const failed = yield* storedState(workflows, FEED_1);
      expect(failed).toEqual({
        ...earlier,
        lastPullAt: failed.lastPullAt,
        failures: 1,
        failure: "status",
        httpStatus: 500,
      });
      expect(failed.lastPullAt > earlier.lastPullAt).toBe(true);
      const rss = yield* storedState(workflows, FEED_2);
      const expected = RSS_ITEMS.map((item) => pendingOf(FEED_2, item, rss.lastPullAt, PROJECT));
      expect(yield* candidateRows(workflows, `factory/v1/signal-candidate/${FEED_2}/`)).toEqual(
        byKey(expected.map((record) => ({ key: candidateKey(FEED_2, record.id), value: record }))),
      );
      expect(yield* workflows.stored(`factory/v1/signal-candidate/${FEED_1}/`)).toEqual([]);
    }),
  );
});

it("pack 16: a private feed is never resolved, damaged rows are counted and kept, and a 304 changes only the state", () => {
  const privateUrl = "https://127.0.0.1/feed";
  const unchangedUrl = "https://n.feeds.example/feed.xml";
  const laterUrl = "https://q.feeds.example/feed.xml";
  const blockedUrl = "https://s.feeds.example/feed.xml";
  const feeds = feedStandIn({
    [unchangedUrl]: reply(304, { etag: '"v2"' }),
    [laterUrl]: reply(200, {}, RSS_DOC),
    [blockedUrl]: reply(200, {}, RSS_DOC),
  });
  return signalWorld(
    feeds.transport,
    Effect.fn("factoryPack.test.signalDamaged")(function* (world, workflows) {
      const now = yield* DateTime.now;
      yield* workflows.storeSet(feedKey(FEED_1), feedOf(FEED_1, privateUrl));
      yield* workflows.storeSet(feedKey(FEED_2), feedOf(FEED_2, unchangedUrl));
      const earlier = stateOf(FEED_2, {
        lastPullAt: minutesBefore(now, 120),
        lastOkAt: minutesBefore(now, 180),
        etag: '"v1"',
        lastModified: LAST_MODIFIED,
        failures: 1,
        failure: "timeout",
        items: 1,
      });
      yield* workflows.storeSet(stateKey(FEED_2), earlier);
      const seen = pendingOf(FEED_2, RSS_KEYED, minutesBefore(now, 180));
      yield* workflows.storeSet(candidateKey(FEED_2, seen.id), seen);
      // One row that does not decode, one whose record names another id than its key.
      yield* workflows.storeSet(feedKey(FEED_3), { v: 1, id: FEED_3, url: 42 });
      yield* workflows.storeSet(
        feedKey(FEED_4),
        feedOf(FEED_5, "https://d.feeds.example/feed.xml"),
      );
      const candidates = yield* workflows.stored("factory/v1/signal-candidate/");

      const first = yield* pulled(world, workflows, "signals/first");
      expect(first.damaged).toBe(2);
      expectPulls(first.feeds, [
        pullOf(FEED_1, "failed", { failure: "address" }),
        pullOf(FEED_2, "not-modified"),
      ]);
      expect(feeds.resolved).toEqual(["n.feeds.example"]);
      expect(feeds.requested.map((input) => [input.url, input.headers])).toEqual([
        [unchangedUrl, { ...HEADERS, "if-none-match": '"v1"', "if-modified-since": LAST_MODIFIED }],
      ]);
      const refused = yield* storedState(workflows, FEED_1);
      expect(refused).toEqual(
        stateOf(FEED_1, { lastPullAt: refused.lastPullAt, failures: 1, failure: "address" }),
      );
      const unchanged = yield* storedState(workflows, FEED_2);
      expect(unchanged).toEqual({
        ...earlier,
        lastPullAt: unchanged.lastPullAt,
        lastOkAt: unchanged.lastPullAt,
        etag: '"v2"',
        failures: 0,
        failure: null,
        httpStatus: 304,
      });
      expect(yield* workflows.stored("factory/v1/signal-candidate/")).toEqual(candidates);
      for (const feedId of [FEED_3, FEED_4, FEED_5]) {
        expect(yield* workflows.stored(stateKey(feedId))).toEqual([]);
      }

      yield* workflows.storeSet(feedKey(FEED_6), feedOf(FEED_6, laterUrl));
      yield* workflows.storeSet(feedKey(FEED_7), feedOf(FEED_7, blockedUrl));
      const broken = { v: 1, feedId: FEED_7, lastPullAt: 7 };
      yield* workflows.storeSet(stateKey(FEED_7), broken);
      const damagedId = candidateIdOf(FEED_6, "a-1");
      const damagedRow = { v: 1, id: damagedId, broken: true };
      yield* workflows.storeSet(candidateKey(FEED_6, damagedId), damagedRow);
      const second = yield* pulled(world, workflows, "signals/second");
      // S10 step 1 counts damaged feed rows; whether the damaged state and candidate rows
      // also count in `damaged` is unstated, so only the feed rows' 2 is certain.
      expect(second.damaged).toBeGreaterThanOrEqual(2);
      expect(second.damaged).toBeLessThanOrEqual(4);
      // FEED_7 is blocked, so it comes first though FEED_6 has the smaller id.
      expectPulls(second.feeds, [
        pullOf(FEED_7, "failed", { failure: "store" }),
        pullOf(FEED_6, "ok", { created: 1, skipped: 2 }),
      ]);
      expect(feeds.resolved).toEqual(["n.feeds.example", "q.feeds.example"]);
      const blocked = yield* workflows.stored(stateKey(FEED_7));
      expect(blocked).toEqual([{ key: stateKey(FEED_7), value: broken }]);
      expect(JSON.stringify(only(blocked).value)).toBe(JSON.stringify(broken));
      expect(yield* workflows.stored(`factory/v1/signal-candidate/${FEED_7}/`)).toEqual([]);
      const later = yield* storedState(workflows, FEED_6);
      expect(later).toEqual(
        stateOf(FEED_6, {
          lastPullAt: later.lastPullAt,
          lastOkAt: later.lastPullAt,
          httpStatus: 200,
          items: 2,
        }),
      );
      const kept = pendingOf(FEED_6, RSS_LINKED, later.lastPullAt);
      expect(byKey(yield* workflows.stored(`factory/v1/signal-candidate/${FEED_6}/`))).toEqual(
        byKey([
          { key: candidateKey(FEED_6, damagedId), value: damagedRow },
          { key: candidateKey(FEED_6, kept.id), value: kept },
        ]),
      );
    }),
  );
});

it("pack 17: factory-capture accepts a parent task whose source is signal", () => {
  const feeds = feedStandIn({});
  const parent = {
    v: 1,
    id: TASK_ID,
    number: 1,
    rev: 1,
    projectId: null,
    title: ATOM_ITEM.title,
    description: [
      "A person admitted this task from a followed feed: Robots.",
      `Candidate ${ATOM_ID}, revision 1, sha256 ${ATOM_SHA}.`,
      "Write what you want done here before you start it.",
    ].join("\n"),
    lane: "backlog",
    laneSetAt: AT,
    parentId: null,
    blockedBy: [],
    assignee: null,
    model: null,
    source: { _tag: "signal", feedId: FEED_1, candidateId: ATOM_ID, revision: 1, sha256: ATOM_SHA },
    createdAt: AT,
    updatedAt: AT,
  };
  return signalWorld(
    feeds.transport,
    Effect.fn("factoryPack.test.signalParent")(function* (world, workflows) {
      yield* workflows.storeSet("factory/v1/seq", 1);
      yield* workflows.storeSet(`factory/v1/task/${TASK_ID}`, parent);
      const { runId } = yield* workflows.start(
        "factory-capture",
        { title: "Follow up on the robots", parentId: TASK_ID },
        { idempotencyKey: "capture/signal-parent" },
      );
      const done = yield* world.ended(workflows, runId, true);
      expect(done.status).toBe("completed");
      expect(done.result).toEqual({ taskId: expect.stringMatching(UUID), number: 2, runId: null });
      const tasks = yield* Effect.forEach(yield* workflows.stored("factory/v1/task/"), (row) =>
        decodeTaskEffect(row.value),
      );
      expect(tasks.filter((task) => task.id === TASK_ID)).toEqual([parent]);
      expect(only(tasks.filter((task) => task.id !== TASK_ID))).toMatchObject({
        number: 2,
        title: "Follow up on the robots",
        parentId: TASK_ID,
        lane: "backlog",
        source: { _tag: "local" },
      });
      expect(world.turns).toEqual([]);
      expect(feeds.requested).toEqual([]);
    }),
  );
});
