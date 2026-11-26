// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - a workflow file runs in the loader, which provides no platform services.
import * as NodeCrypto from "node:crypto";
import * as NodeDns from "node:dns";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";

export const SIGNAL_MIN_INTERVAL_MINUTES = 60;
export const SIGNAL_FETCH_TIMEOUT_MS = 5000;
export const SIGNAL_RESPONSE_BYTES_MAX = 262144;
export const SIGNAL_ITEMS_PER_PULL_MAX = 50;
export const SIGNAL_XML_DEPTH_MAX = 32;
export const SIGNAL_PENDING_PER_FEED_MAX = 100;
export const SIGNAL_DISMISSED_PER_FEED_MAX = 200;
export const SIGNAL_NAME_MAX = 256;
export const SIGNAL_ATTRIBUTES_MAX = 32;
export const SIGNAL_ATTRIBUTE_VALUE_MAX = 4096;
export const SIGNAL_REFERENCE_MAX = 10;
export const SIGNAL_FIELD_TEXT_MAX = 16384;
export const SIGNAL_PORTS = [443] as const;
export const SIGNAL_USER_AGENT = "T3Factory-Signals/1";
export const SIGNAL_TRANSPORT_KEY = Symbol.for("t3factory.signals.transport");

export const signalFailures = [
  "not-a-url",
  "scheme",
  "credentials",
  "port",
  "hostname",
  "address",
  "dns",
  "network",
  "timeout",
  "redirect",
  "status",
  "too-large",
  "encoding",
  "dtd",
  "entity",
  "malformed",
  "too-deep",
  "format",
  "store",
] as const;
export type FactorySignalFailure = (typeof signalFailures)[number];

const CONTROL =
  /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Variation_Selector}\u115F\u1160\u3164\uFFA0]/gu;
const LONG_MARK_RUN = /(\p{M}{30})\p{M}+/gu;
export const normalizeText = (raw: string) =>
  raw
    .replace(/[^\S\uFEFF]/g, " ")
    .replace(CONTROL, "")
    .replace(/([\u200C\u200D])[\u200C\u200D]+/g, "$1")
    .replace(LONG_MARK_RUN, "$1")
    .normalize("NFC")
    .replace(LONG_MARK_RUN, "$1")
    .replace(/ +/g, " ")
    .trim();
export function cutText(text: string, max: number) {
  if (text.length <= max) return text;
  const unit = text.charCodeAt(max - 1);
  return text.slice(0, unit >= 0xd800 && unit <= 0xdbff ? max - 1 : max).trimEnd();
}

type DigestFields = {
  readonly feedId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly summary: string;
  readonly link: string | null;
};
const digest = (tuple: ReadonlyArray<string | number | null>) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex");
export const signalCandidateId = (feedId: string, itemKey: string) =>
  digest([1, "feed", feedId, itemKey]);
export const signalDigest = ({ feedId, itemKey, title, summary, link }: DigestFields) =>
  digest([1, "feed", feedId, itemKey, title, summary, link]);

type UrlCheck =
  | { ok: true; url: string; hostname: string }
  | { ok: false; reason: FactorySignalFailure };
export function checkFeedUrl(text: string): UrlCheck {
  const t = text.trim();
  if (t.length > 2048 || t.includes("#")) return { ok: false, reason: "not-a-url" };
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return { ok: false, reason: "not-a-url" };
  }
  if (url.href.length > 2048) return { ok: false, reason: "not-a-url" };
  if (url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.port) return { ok: false, reason: "port" };
  const hostname = url.hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith("["))
    return { ok: false, reason: "address" };
  const h = hostname.replace(/\.$/, "");
  if (
    !h.includes(".") ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa")
  ) {
    return { ok: false, reason: "hostname" };
  }
  return { ok: true, url: url.href, hostname };
}

const ipv4Number = (address: string) =>
  address.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
const ipv4Ranges = (
  [
    ["169.254.169.254", 32, "metadata"],
    ["168.63.129.16", 32, "metadata"],
    ["0.0.0.0", 8, "unspecified"],
    ["127.0.0.0", 8, "loopback"],
    ["10.0.0.0", 8, "private"],
    ["100.64.0.0", 10, "private"],
    ["172.16.0.0", 12, "private"],
    ["192.168.0.0", 16, "private"],
    ["169.254.0.0", 16, "link-local"],
    ["224.0.0.0", 4, "multicast"],
    ["192.0.0.0", 24, "reserved"],
    ["192.0.2.0", 24, "reserved"],
    ["192.88.99.0", 24, "reserved"],
    ["198.18.0.0", 15, "reserved"],
    ["198.51.100.0", 24, "reserved"],
    ["203.0.113.0", 24, "reserved"],
    ["240.0.0.0", 4, "reserved"],
  ] as const
).map(([base, bits, reason]) => ({
  shift: 32 - bits,
  prefix: ipv4Number(base) >>> (32 - bits),
  reason,
}));
function ipv4Refusal(ip: number) {
  for (const { shift, prefix, reason } of ipv4Ranges) {
    if (ip >>> shift === prefix) return reason;
  }
  return null;
}

function ipv6Number(address: string) {
  // NodeNet.isIP has validated the syntax; expand a dotted tail into its two hextets first.
  const hex = address.replace(/[\d.]+\.[\d.]+$/, (tail) => {
    const ip = ipv4Number(tail);
    return `${(ip >>> 16).toString(16)}:${(ip & 0xffff).toString(16)}`;
  });
  const [left, right] = hex.split("::");
  const words = left ? left.split(":") : [];
  if (right !== undefined) {
    const end = right ? right.split(":") : [];
    while (words.length + end.length < 8) words.push("0");
    words.push(...end);
  }
  return BigInt(`0x${words.map((word) => word.padStart(4, "0")).join("")}`);
}

export function addressRefusal(address: string) {
  if (address.includes("%")) return "invalid";
  const family = NodeNet.isIP(address);
  if (family === 0) return "invalid";
  if (family === 4) return ipv4Refusal(ipv4Number(address));
  const ip = ipv6Number(address);
  if (ip === 0xfd000ec2000000000000000000000254n) return "metadata";
  if (ip === 0n) return "unspecified";
  if (ip === 1n) return "loopback";
  if (ip >> 32n === 0xffffn) return ipv4Refusal(Number(ip & 0xffffffffn)) ?? "reserved";
  if (ip >> 118n === 0x3fan) return "link-local";
  if (ip >> 121n === 0x7en) return "private";
  if (ip >> 120n === 0xffn) return "multicast";
  if (
    ip >> 125n !== 1n ||
    ip >> 105n === 0x100080n ||
    ip >> 96n === 0x20010db8n ||
    ip >> 112n === 0x2002n ||
    ip >> 108n === 0x3fff0n
  )
    return "reserved";
  return null;
}

type Headers = Readonly<Record<string, string>>;
type TransportResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly truncated: boolean;
};
export interface FeedTransport {
  readonly resolve: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly request: (input: {
    readonly url: string;
    readonly hostname: string;
    readonly address: string;
    readonly headers: Headers;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }) => Promise<TransportResponse>;
}
type Validators = { readonly etag: string | null; readonly lastModified: string | null };
export type FetchResult =
  | ({ readonly kind: "ok"; readonly text: string } & Validators)
  | ({ readonly kind: "not-modified" } & Validators)
  | {
      readonly kind: "failed";
      readonly failure: FactorySignalFailure;
      readonly httpStatus: number | null;
    };
const failed = (failure: FactorySignalFailure, httpStatus: number | null = null): FetchResult => ({
  kind: "failed",
  failure,
  httpStatus,
});
const validator = (value: string | undefined) =>
  value &&
  value.length <= 200 &&
  !/[^\x20-\x7e]/.test(value) &&
  !value.startsWith(" ") &&
  !value.endsWith(" ")
    ? value
    : null;

export async function fetchFeed(
  url: string,
  validators: Validators,
  transport: FeedTransport,
  limits: { readonly timeoutMs: number; readonly maxBytes: number },
): Promise<FetchResult> {
  const checked = checkFeedUrl(url);
  if (!checked.ok) return failed(checked.reason);
  const until = performance.now() + limits.timeoutMs;
  const controller = new AbortController();
  const timeout = Symbol("timeout");
  const { promise: deadline, resolve: expire } = Promise.withResolvers<typeof timeout>();
  const timer = setTimeout(() => {
    expire(timeout);
    controller.abort();
  }, limits.timeoutMs);
  let stage: "dns" | "network" = "dns";
  try {
    const addresses = await Promise.race([transport.resolve(checked.hostname), deadline]);
    if (addresses === timeout || performance.now() >= until) return failed("timeout");
    const address = addresses[0];
    if (address === undefined) return failed("dns");
    if (addresses.some((ip) => addressRefusal(ip) !== null)) return failed("address");
    const headers: Record<string, string> = {
      accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
      "accept-encoding": "identity",
      "user-agent": SIGNAL_USER_AGENT,
    };
    if (validators.etag !== null) headers["if-none-match"] = validators.etag;
    if (validators.lastModified !== null) headers["if-modified-since"] = validators.lastModified;
    if (performance.now() >= until) return failed("timeout");
    stage = "network";
    const response = await Promise.race([
      transport.request({
        url: checked.url,
        hostname: checked.hostname,
        address,
        headers,
        maxBytes: limits.maxBytes,
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (response === timeout || performance.now() >= until) return failed("timeout");
    const { status, headers: received, body, truncated } = response;
    const etag = validator(received.etag);
    const lastModified = validator(received["last-modified"]);
    if (status === 304) return { kind: "not-modified", etag, lastModified };
    if (status >= 300 && status < 400) return failed("redirect");
    if (status !== 200) return failed("status", status);
    const encoding = received["content-encoding"];
    if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity")
      return failed("encoding");
    if (
      Number(received["content-length"]) > limits.maxBytes ||
      truncated ||
      body.byteLength > limits.maxBytes
    )
      return failed("too-large");
    try {
      // TextDecoder consumes exactly one UTF-8 BOM by default.
      return {
        kind: "ok",
        text: new TextDecoder("utf-8", { fatal: true }).decode(body),
        etag,
        lastModified,
      };
    } catch {
      return failed("encoding");
    }
  } catch {
    return failed(performance.now() >= until || controller.signal.aborted ? "timeout" : stage);
  } finally {
    clearTimeout(timer);
  }
}

export function pinnedLookup(address: string): NodeNet.LookupFunction {
  const family = NodeNet.isIP(address);
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function responseHeaders(headers: Readonly<Record<string, string | string[] | undefined>>) {
  const received: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") received[key] = value;
  }
  return received;
}

export function makeNodeTransport(deps: {
  readonly lookup: typeof NodeDns.promises.lookup;
  readonly request: typeof NodeHttps.request;
}): FeedTransport {
  return {
    resolve: async (hostname) =>
      (await deps.lookup(hostname, { all: true, order: "verbatim" })).map((entry) => entry.address),
    request: ({ url, hostname, address, headers, maxBytes, signal }) => {
      const { promise, resolve, reject } = Promise.withResolvers<TransportResponse>();
      let settled = false;
      let statusOnly: TransportResponse | undefined;
      const finish = (result: TransportResponse) => {
        settled = true;
        resolve(result);
      };
      const fail = (error: Error) => {
        if (settled) return;
        if (statusOnly) finish(statusOnly);
        else {
          settled = true;
          reject(error);
        }
      };
      const { pathname, search } = new URL(url);
      const req = deps.request(
        {
          hostname,
          servername: hostname,
          rejectUnauthorized: true,
          port: SIGNAL_PORTS[0],
          path: pathname + search,
          method: "GET",
          headers,
          agent: false,
          lookup: pinnedLookup(address),
          signal,
        },
        (response) => {
          const received = responseHeaders(response.headers);
          const status = response.statusCode ?? 0;
          if (status !== 200 && response.statusCode !== undefined) {
            statusOnly = { status, headers: received, body: new Uint8Array(0), truncated: false };
          }
          response.on("error", fail);
          const tooLarge = () => {
            finish({ status, headers: received, body: new Uint8Array(0), truncated: true });
            const socket = response.socket;
            response.destroy();
            if (socket && !socket.destroyed) socket.destroy();
          };
          if (Number(received["content-length"]) > maxBytes) {
            tooLarge();
            return;
          }
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer | string) => {
            const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            bytes += data.byteLength;
            if (bytes > maxBytes) tooLarge();
            else chunks.push(data);
          });
          response.on("end", () => {
            if (bytes <= maxBytes)
              finish({
                status,
                headers: received,
                body: Buffer.concat(chunks, bytes),
                truncated: false,
              });
          });
        },
      );
      req.on("error", fail);
      req.on("close", () => {
        if (!settled) fail(new Error("Feed connection closed before the response ended"));
      });
      req.on("upgrade", (response, socket) => {
        finish({
          status: response.statusCode ?? 101,
          headers: responseHeaders(response.headers),
          body: new Uint8Array(0),
          truncated: false,
        });
        socket.destroy();
      });
      req.end();
      return promise;
    },
  };
}
function isTransport(value: unknown): value is FeedTransport {
  return (
    value !== null &&
    typeof value === "object" &&
    "resolve" in value &&
    typeof value.resolve === "function" &&
    "request" in value &&
    typeof value.request === "function"
  );
}
export const nodeTransport = makeNodeTransport({
  lookup: NodeDns.promises.lookup,
  request: NodeHttps.request,
});
export function transportFor(): FeedTransport {
  const candidate: unknown = Reflect.get(globalThis, SIGNAL_TRANSPORT_KEY);
  return isTransport(candidate) ? candidate : nodeTransport;
}

type ParseReason = "dtd" | "entity" | "malformed" | "too-deep" | "format" | "encoding";
type FeedItem = {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  readonly link: string | null;
};
type ParseResult =
  | {
      ok: true;
      format: "rss" | "atom";
      items: ReadonlyArray<FeedItem>;
      skipped: number;
      overflow: number;
    }
  | { ok: false; reason: ParseReason };

// Consume only reference characters: in HTML a failed reference must not swallow the next '&' or '<'.
function referenceAt(s: string, amp: number, html: boolean) {
  let end = amp + 1;
  const limit = Math.min(s.length, amp + SIGNAL_REFERENCE_MAX);
  while (end < limit && /[A-Za-z0-9#]/.test(s.charAt(end))) end++;
  if (end === limit || s.charAt(end) !== ";") return { next: end, value: null };
  const name = s.slice(amp + 1, end);
  const next = end + 1;
  switch (name) {
    case "lt":
      return { next, value: "<" };
    case "gt":
      return { next, value: ">" };
    case "amp":
      return { next, value: "&" };
    case "quot":
      return { next, value: '"' };
    case "apos":
      return { next, value: "'" };
    case "nbsp":
      return { next, value: html ? " " : null };
  }
  const n = /^#[0-9]+$/.test(name)
    ? Number(name.slice(1))
    : /^#x[0-9a-fA-F]+$/.test(name)
      ? Number.parseInt(name.slice(2), 16)
      : -1;
  const valid =
    n === 9 ||
    n === 10 ||
    n === 13 ||
    (n >= 0x20 && n <= 0xd7ff) ||
    (n >= 0xe000 && n <= 0xfffd) ||
    (n >= 0x10000 && n <= 0x10ffff);
  return { next, value: valid ? String.fromCodePoint(n) : null };
}

export function htmlText(s: string) {
  let out = "",
    literal = 0,
    i = 0;
  while (i < s.length) {
    if (s[i] === "<") {
      out += s.slice(literal, i);
      const end = s.indexOf(">", i + 1);
      if (end < 0) return out;
      out += " ";
      literal = i = end + 1;
    } else if (s[i] === "&") {
      const ref = referenceAt(s, i, true);
      if (ref.value !== null) {
        out += s.slice(literal, i) + ref.value;
        literal = ref.next;
      }
      i = ref.next;
    } else i++;
  }
  return out + s.slice(literal);
}

// Special-scheme URLs also accept missing slashes and backslashes before the authority.
const linkAuthority = /^https?:[\\/]*([^/\\?#]*)/i;
function hostTooLong(authority: string) {
  const start = authority.lastIndexOf("@") + 1;
  const port = authority.indexOf(
    ":",
    authority[start] === "[" ? authority.indexOf("]", start) + 1 : start,
  );
  return (port < 0 ? authority.length : port) - start > 253;
}

export function linkValue(raw: string) {
  if (raw.length > 2000) return null;
  const text = normalizeText(raw);
  const authority = linkAuthority.exec(text)?.[1];
  if (authority === undefined || hostTooLong(authority)) return null;
  if (text !== raw && hostTooLong(linkAuthority.exec(raw.trim())?.[1] ?? "")) return null;
  try {
    const url = new URL(text);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      url.href.length <= 2000
    )
      return url.href;
  } catch {
    /* Not an absolute URL. */
  }
  return null;
}

type Field = { text: string; html: boolean };
const xmlSpace = (c: number) => c === 32 || c === 9 || c === 13 || c === 10;
const nameStart = (c: number) => c === 95 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

export function parseFeed(text: string): ParseResult {
  let refusal: ParseReason | undefined;
  function refuse(reason: ParseReason): never {
    refusal = reason;
    throw new Error(reason);
  }
  const stack: string[] = [],
    items: FeedItem[] = [];
  const seen = new Set<string>();
  const commentEnd = /-->|<!(?:DOCTYPE|ENTITY)/gi;
  const cdataEnd = /\]\]>|<!(?:DOCTYPE|ENTITY)/gi;
  const piEnd = /\?>|<!(?:DOCTYPE|ENTITY)/gi;
  let i = 0,
    skipped = 0,
    overflow = 0,
    rootSeen = false;
  let format: "rss" | "atom" | undefined;
  let item: { depth: number; fields: Map<string, Field>; link?: string | null } | undefined;
  let active: Field | undefined;

  function space() {
    while (xmlSpace(text.charCodeAt(i))) i++;
  }
  function name() {
    const start = i;
    if (!nameStart(text.charCodeAt(i))) refuse("malformed");
    i++;
    let qualified = false;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 58 && !qualified) {
        qualified = true;
        if (!nameStart(text.charCodeAt(++i))) refuse("malformed");
      } else if (!nameStart(c) && c !== 45 && c !== 46 && !(c >= 48 && c <= 57)) break;
      if (++i - start > SIGNAL_NAME_MAX) refuse("malformed");
    }
    return text.slice(start, i);
  }
  function append(source: string, start: number, end: number) {
    if (!active) return;
    const limit = start + SIGNAL_FIELD_TEXT_MAX - active.text.length;
    if (end < limit) {
      active.text += source.slice(start, end);
      return;
    }
    const last = source.charCodeAt(limit - 1);
    active.text += source.slice(start, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
    active = undefined;
  }
  function characters(quote: string | null) {
    let attribute = "";
    function keep(source: string, start: number, end: number) {
      if (quote === null) append(source, start, end);
      else {
        if (attribute.length + end - start > SIGNAL_ATTRIBUTE_VALUE_MAX) refuse("malformed");
        attribute += source.slice(start, end);
      }
    }
    let literal = i;
    while (i < text.length) {
      const c = text[i];
      if (c === quote || c === "<") break;
      if (quote === null && !stack.length && !xmlSpace(text.charCodeAt(i))) refuse("malformed");
      if (c === "&") {
        keep(text, literal, i);
        const ref = referenceAt(text, i, false);
        if (ref.value === null) refuse("entity");
        keep(ref.value, 0, ref.value.length);
        literal = i = ref.next;
      } else i++;
    }
    keep(text, literal, i);
    if (quote !== null) {
      if (text[i] !== quote) refuse("malformed");
      i++;
    }
    return attribute;
  }
  function open(tag: string, attrs: ReadonlyMap<string, string>) {
    const depth = stack.length + 1;
    if (depth > SIGNAL_XML_DEPTH_MAX) refuse("too-deep");
    if (depth === 1) {
      if (rootSeen) refuse("malformed");
      rootSeen = true;
      if (tag === "rss") format = "rss";
      else if (tag === "feed" && attrs.get("xmlns") === "http://www.w3.org/2005/Atom")
        format = "atom";
    } else if (
      (format === "rss" && depth === 3 && stack[1] === "channel" && tag === "item") ||
      (format === "atom" && depth === 2 && tag === "entry")
    ) {
      item = { depth, fields: new Map() };
    } else if (item && depth === item.depth + 1) {
      if (format === "atom" && tag === "link") {
        if (item.link === undefined && (!attrs.has("rel") || attrs.get("rel") === "alternate"))
          item.link = linkValue(attrs.get("href") ?? "");
      } else if (
        !item.fields.has(tag) &&
        (format === "rss"
          ? ["guid", "link", "title", "description"]
          : ["id", "title", "summary", "content"]
        ).includes(tag)
      ) {
        const field = {
          text: "",
          html:
            format === "rss" ? tag === "description" : tag !== "id" && attrs.get("type") === "html",
        };
        item.fields.set(tag, field);
        if (!(tag === "content" && attrs.has("src"))) active = field;
      }
    }
    stack.push(tag);
  }
  function close() {
    if (item && stack.length === item.depth + 1) active = undefined;
    if (item && stack.length === item.depth) {
      const fields = item.fields;
      const value = (name: string) => {
        const f = fields.get(name);
        return f ? normalizeText(f.html ? htmlText(f.text) : f.text) : "";
      };
      const key = format === "rss" ? value("guid") || value("link") : value("id");
      if (!key || key.length > 512 || seen.has(key)) skipped++;
      else {
        seen.add(key);
        const summary = value(
          format === "rss" ? "description" : fields.has("summary") ? "summary" : "content",
        );
        const title = cutText(value("title"), 200) || cutText(summary, 200);
        if (!title) skipped++;
        else if (items.length >= SIGNAL_ITEMS_PER_PULL_MAX) overflow++;
        else
          items.push({
            key,
            title,
            summary: cutText(summary, 2000),
            link:
              format === "rss" ? linkValue(fields.get("link")?.text ?? "") : (item.link ?? null),
          });
      }
      item = undefined;
    }
    stack.pop();
  }
  function declaration() {
    i = 5;
    let quote = "",
      encodingAt = -1,
      wrongEncoding = false;
    const dtd = /<!(?:DOCTYPE|ENTITY)/iy;
    while (i < text.length) {
      if (text.startsWith("?>", i)) {
        i += 2;
        if (wrongEncoding) refuse("encoding");
        return;
      }
      const c = text.charAt(i);
      if (c === "<") {
        dtd.lastIndex = i;
        if (dtd.test(text)) refuse("dtd");
      }
      if (quote) {
        if (c === quote) {
          if (
            encodingAt >= 0 &&
            (i - encodingAt !== 5 || text.slice(encodingAt, i).toLowerCase() !== "utf-8")
          )
            wrongEncoding = true;
          quote = "";
          encodingAt = -1;
        }
      } else if (
        text.startsWith("encoding", i) &&
        (i === 5 || /[ \t\r\n'"]/.test(text.charAt(i - 1)))
      ) {
        i += 8;
        space();
        if (text[i] === "=") {
          i++;
          space();
          if (text[i] === '"' || text[i] === "'") {
            quote = text.charAt(i++);
            encodingAt = i;
          }
        }
        continue;
      } else if (c === '"' || c === "'") quote = c;
      i++;
    }
    refuse("malformed");
  }
  try {
    while (i < text.length) {
      if (text[i] !== "<") {
        characters(null);
        continue;
      }
      if (i === 0 && text.startsWith("<?xml")) {
        declaration();
        continue;
      }
      if (
        text.startsWith("<!--", i) ||
        text.startsWith("<?", i) ||
        text.startsWith("<![CDATA[", i)
      ) {
        const pi = text[i + 1] === "?",
          cdata = !pi && text[i + 2] === "[";
        const start = i + (pi ? 2 : cdata ? 9 : 4);
        const terminator = pi ? piEnd : cdata ? cdataEnd : commentEnd;
        terminator.lastIndex = start;
        const found = terminator.exec(text);
        if (!found) {
          i = text.length;
          refuse("malformed");
        }
        if (found[0].startsWith("<")) refuse("dtd");
        if (cdata) {
          if (!stack.length) refuse("malformed");
          append(text, start, found.index);
        }
        i = terminator.lastIndex;
        continue;
      }
      i++;
      if (text[i] === "/") {
        i++;
        const tag = name();
        space();
        if (text[i++] !== ">" || stack.at(-1) !== tag) refuse("malformed");
        close();
        continue;
      }
      const tag = name(),
        attrs = new Map<string, string>();
      let count = 0;
      for (;;) {
        const beforeSpace = i;
        space();
        if (text[i] === ">" || text.startsWith("/>", i)) break;
        if (beforeSpace === i || ++count > SIGNAL_ATTRIBUTES_MAX) refuse("malformed");
        const attr = name();
        if (text[i++] !== "=") refuse("malformed");
        const quote = text[i++];
        if (quote !== '"' && quote !== "'") refuse("malformed");
        const value = characters(quote);
        if (!attrs.has(attr)) attrs.set(attr, value);
      }
      open(tag, attrs);
      if (text[i] === "/") {
        i++;
        close();
      }
      i++;
    }
    if (!rootSeen || stack.length) refuse("malformed");
    if (!format) refuse("format");
    return { ok: true, format, items, skipped, overflow };
  } catch (error) {
    if (refusal !== undefined) {
      // A forbidden declaration anywhere outranks an earlier syntax error, even in unparsed input.
      const remainingDtd = /<!(?:DOCTYPE|ENTITY)/gi;
      remainingDtd.lastIndex = Math.max(0, i - 1);
      const reason = refusal !== "dtd" && remainingDtd.test(text) ? "dtd" : refusal;
      return { ok: false, reason };
    }
    throw error;
  }
}

type Candidate = DigestFields & {
  readonly v: 1;
  readonly id: string;
  readonly projectId: string | null;
  readonly revision: number;
  readonly sha256: string;
  readonly state: "pending" | "dismissed" | "admitted";
  readonly firstSeenAt: string;
  readonly changedAt: string;
  readonly decidedAt: string | null;
  readonly decidedRevision: number | null;
  readonly decidedSha256: string | null;
  readonly taskId: string | null;
};
export function planPull(input: {
  readonly feedId: string;
  readonly projectId: string | null;
  readonly at: string;
  readonly items: ReadonlyArray<FeedItem>;
  readonly heads: ReadonlyArray<Candidate>;
  readonly damagedIds: Iterable<string>;
}) {
  const { feedId, projectId, at } = input;
  const heads = new Map(input.heads.map((head) => [head.id, head]));
  const damaged = new Set(input.damagedIds),
    met = new Set<string>();
  const writes: Candidate[] = [],
    deletes: string[] = [];
  const counts = {
    created: 0,
    revised: 0,
    reopened: 0,
    unchanged: 0,
    capped: 0,
    skipped: 0,
    pruned: 0,
  };
  let pending = input.heads.reduce((n, head) => n + Number(head.state === "pending"), 0);
  const undecided = {
    state: "pending",
    decidedAt: null,
    decidedRevision: null,
    decidedSha256: null,
    taskId: null,
  } as const;
  for (const { key: itemKey, title, summary, link } of input.items) {
    const id = signalCandidateId(feedId, itemKey);
    met.add(id);
    if (damaged.has(id)) {
      counts.skipped++;
      continue;
    }
    const fields = { feedId, itemKey, title, summary, link };
    const sha256 = signalDigest(fields);
    const head = heads.get(id);
    let next: Candidate;
    if (!head) {
      if (pending >= SIGNAL_PENDING_PER_FEED_MAX) {
        counts.capped++;
        continue;
      }
      next = {
        ...fields,
        v: 1,
        id,
        projectId,
        revision: 1,
        sha256,
        firstSeenAt: at,
        changedAt: at,
        ...undecided,
      };
      pending++;
      counts.created++;
    } else {
      if (head.sha256 === sha256) {
        counts.unchanged++;
        continue;
      }
      next = {
        ...head,
        projectId,
        title,
        summary,
        link,
        sha256,
        revision: head.revision + 1,
        changedAt: at,
      };
      if (head.state === "dismissed") {
        next = { ...next, ...undecided };
        pending++;
        counts.reopened++;
      } else counts.revised++;
    }
    writes.push(next);
    heads.set(id, next);
  }
  let dismissed = 0;
  const prunable: Candidate[] = [];
  for (const head of heads.values()) {
    if (head.state !== "dismissed") continue;
    dismissed++;
    if (!met.has(head.id)) prunable.push(head);
  }
  if (dismissed > SIGNAL_DISMISSED_PER_FEED_MAX) {
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    prunable.sort((a, b) => cmp(a.decidedAt ?? "", b.decidedAt ?? "") || cmp(a.id, b.id));
    const excess = dismissed - SIGNAL_DISMISSED_PER_FEED_MAX;
    for (const head of prunable) {
      if (deletes.length === excess) break;
      deletes.push(head.id);
    }
    counts.pruned = deletes.length;
  }
  return { writes, deletes, counts };
}

export function isDue(state: { readonly lastPullAt: string } | null, nowIso: string) {
  if (state === null) return true;
  const elapsed = Date.parse(nowIso) - Date.parse(state.lastPullAt);
  return Number.isNaN(elapsed) || elapsed < 0 || elapsed >= SIGNAL_MIN_INTERVAL_MINUTES * 60_000;
}
