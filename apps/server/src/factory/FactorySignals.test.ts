// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  FACTORY_CLIENT_GUARDED_RPC_SCOPES,
  FACTORY_RPC_AGGREGATES,
  FACTORY_RPC_READ_SCOPES,
  FactoryRpcGroup,
  FactorySignalCandidate,
  type FactorySignalFeed,
  type FactorySignalFeedState,
  type FactoryTaskError,
  ProjectId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { KeyValues, layerKeyValues } from "../workflows/stepServices.ts";
import * as Workflows from "../workflows/Workflows.ts";
import { checkFeedUrl, signalCandidateId, signalDigest } from "./FactorySignals.ts";
import * as FactoryTasks from "./FactoryTasks.ts";

const at = "1970-01-01T00:00:00.000Z";
const later = "1970-01-02T00:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const feedKey = (id: string) => `factory/v1/signal-feed/${id}`;
const stateKey = (id: string) => `factory/v1/signal-state/${id}`;
const candidateKey = (feedId: string, id: string) => `factory/v1/signal-candidate/${feedId}/${id}`;
const taskKey = (id: string) => `factory/v1/task/${id}`;
const seqKey = "factory/v1/seq";
const wrongSha = "f".repeat(64);
const isCandidate = Schema.is(FactorySignalCandidate);

// S4 hashes the UTF-8 JSON encoding of the fixed identity or content tuple.
const hash = (tuple: ReadonlyArray<unknown>) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex");
const candidateId = (feedId: string, itemKey: string) => hash([1, "feed", feedId, itemKey]);
const digest = (
  item: Pick<FactorySignalCandidate, "feedId" | "itemKey" | "title" | "summary" | "link">,
) => hash([1, "feed", item.feedId, item.itemKey, item.title, item.summary, item.link]);

const feed = (id: string): FactorySignalFeed => ({
  v: 1,
  id,
  url: `https://example.com/${id}`,
  label: `Feed ${id}`,
  projectId: null,
  addedAt: at,
});
const state = (feedId: string): FactorySignalFeedState => ({
  v: 1,
  feedId,
  lastPullAt: at,
  lastOkAt: at,
  etag: null,
  lastModified: null,
  failures: 0,
  failure: null,
  httpStatus: 200,
  items: 1,
});
const candidate = (
  feedId: string,
  itemKey: string,
  changes: Partial<FactorySignalCandidate> = {},
): FactorySignalCandidate => {
  const content = {
    feedId,
    itemKey,
    title: `Title ${itemKey}`,
    summary: `Summary ${itemKey}`,
    link: `https://items.example/${itemKey}`,
  };
  return {
    v: 1,
    id: candidateId(feedId, itemKey),
    projectId: null,
    revision: 1,
    sha256: digest(content),
    ...content,
    state: "pending",
    firstSeenAt: at,
    changedAt: at,
    decidedAt: null,
    decidedRevision: null,
    decidedSha256: null,
    taskId: null,
    ...changes,
  };
};
const decision = (row: FactorySignalCandidate) => ({
  feedId: row.feedId,
  candidateId: row.id,
  revision: row.revision,
  sha256: row.sha256,
});
const put = (key: string, value: unknown) =>
  Effect.flatMap(KeyValues, (store) => store.set(key, JSON.stringify(value)));
const remove = (key: string) => Effect.flatMap(KeyValues, (store) => store.delete(key));
const record = (key: string) =>
  Effect.map(
    Effect.flatMap(KeyValues, (store) => store.get(key)),
    (raw): unknown => (raw === undefined ? undefined : JSON.parse(raw)),
  );
const rows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{
      readonly key: string;
      readonly value_json: string;
      readonly updated_at: string;
    }>`SELECT key, value_json, updated_at FROM workflow_store ORDER BY key`,
);
const failure = <A>(effect: Effect.Effect<A, FactoryTaskError>) => Effect.flip(effect);
const seed = (row: FactorySignalCandidate) => put(candidateKey(row.feedId, row.id), row);

const withFactory = <A, E>(
  use: (
    starts: ReadonlyArray<unknown>,
  ) => Effect.Effect<
    A,
    E,
    FactoryTasks.FactoryTasks | KeyValues | SqlClient.SqlClient | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-signals-" });
    const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
    const starts: Array<unknown> = [];
    const workflows = Workflows.Workflows.of({
      ...Workflows.disabled,
      start: (workflow, input, options) =>
        Effect.sync(() => {
          starts.push({ workflow, input, options });
          return { runId: "unexpected-run" };
        }),
    });
    return yield* Effect.provide(
      Effect.scoped(use(starts)),
      Layer.merge(FactoryTasks.layer, layerKeyValues).pipe(
        Layer.provide(Layer.succeed(Workflows.Workflows, workflows)),
        Layer.provideMerge(Layer.effectDiscard(runMigrations())),
        Layer.provideMerge(database),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("S14 server", () => {
  it("1: identity, content digest and URL vectors", () => {
    const feedId = uuid(1);
    const itemKey = "urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a";
    const first = {
      feedId,
      itemKey,
      title: "Atom-Powered Robots Run Amok",
      summary: "Some text.",
      link: "http://example.org/2003/12/13/atom03",
    };
    const second = { feedId, itemKey, title: "Café ✓", summary: "", link: null };
    assert.strictEqual(
      candidateId(feedId, itemKey),
      "84f7cf3a930664bba8cd13146d587d8e1cee95a9f3fe93b9e90a204ba1197694",
    );
    assert.strictEqual(
      digest(first),
      "4371b82b1bbfd64591425404a45b6a3e2efa8f1c6ebc10d00507fb74bf4b3a07",
    );
    assert.strictEqual(
      digest(second),
      "7d1dd24149dc3c82d144eee9e34f41f99ec48714ccf7d6b5e62f56c85ad17925",
    );
    assert.strictEqual(signalCandidateId(feedId, itemKey), candidateId(feedId, itemKey));
    assert.strictEqual(signalDigest(first), digest(first));
    assert.strictEqual(signalDigest(second), digest(second));
    assert.deepStrictEqual(checkFeedUrl("https://Example.COM/a b"), {
      ok: true,
      url: "https://example.com/a%20b",
      hostname: "example.com",
    });
    assert.deepStrictEqual(checkFeedUrl("https://example.com:443/x"), {
      ok: true,
      url: "https://example.com/x",
      hostname: "example.com",
    });
    const refused = [
      ["scheme", ["http://example.com/", "ftp://example.com/", "http://u@127.0.0.1:80/"]],
      ["credentials", ["https://u:p@example.com/"]],
      ["port", ["https://example.com:8443/"]],
      [
        "address",
        [
          "https://127.0.0.1/",
          "https://2130706433/",
          "https://127.1/",
          "https://[::1]/",
          "https://[::ffff:7f00:1]/",
          "https://0x7f.1/",
          "https://017700000001/",
        ],
      ],
      [
        "hostname",
        [
          "https://localhost/",
          "https://intranet/",
          "https://printer.local/",
          "https://metadata.google.internal/",
        ],
      ],
      [
        "not-a-url",
        [
          "https://example.com/#top",
          "https://example.com/?q=1#",
          "example.com/feed",
          "https://1.2.3.999/",
          `https://example.com/${"a".repeat(2029)}`,
          `https://example.com/${"é".repeat(700)}`,
        ],
      ],
    ] as const;
    assert.strictEqual(new URL(`https://example.com/${"é".repeat(700)}`).href.length, 4220);
    for (const [reason, urls] of refused)
      for (const url of urls) assert.deepStrictEqual(checkFeedUrl(url), { ok: false, reason });
  });

  it.effect("2: follow validates and canonicalizes without creating state", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
        const added = yield* tasks.addSignalFeed({
          url: " https://Example.COM:443/a b ",
          label: "  News  ",
          projectId: null,
        });
        assert.match(
          added.id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        assert.deepStrictEqual(added, {
          v: 1,
          id: added.id,
          url: "https://example.com/a%20b",
          label: "News",
          projectId: null,
          addedAt: now,
        });
        assert.deepStrictEqual(yield* record(feedKey(added.id)), added);
        assert.strictEqual(yield* record(stateKey(added.id)), undefined);
        const examples = [
          ["bad", "Enter a full web address, such as https://example.com/feed.xml."],
          ["http://example.com/", "Only https feed addresses can be followed."],
          ["https://u:p@example.com/", "A feed address cannot contain a user name or password."],
          ["https://example.com:8443/", "Only feeds on port 443 can be followed."],
          ["https://127.0.0.1/", "Feeds on local or private hosts cannot be followed."],
          ["https://printer.local/", "Feeds on local or private hosts cannot be followed."],
        ] as const;
        for (const [url, message] of examples) {
          const error = yield* failure(
            tasks.addSignalFeed({ url, label: "Name", projectId: null }),
          );
          assert.strictEqual(error.reason, "invalid");
          assert.strictEqual(error.message, message);
        }
        for (const label of ["   ", "x".repeat(101)]) {
          const error = yield* failure(
            tasks.addSignalFeed({ url: "https://example.org/", label, projectId: null }),
          );
          assert.strictEqual(error.reason, "invalid");
          assert.strictEqual(error.message, "A feed's name is 1 to 100 characters.");
        }
        const duplicate = yield* failure(
          tasks.addSignalFeed({
            url: "https://EXAMPLE.com/a%20b",
            label: "Other",
            projectId: null,
          }),
        );
        assert.strictEqual(duplicate.reason, "invalid");
        assert.strictEqual(duplicate.message, "This feed is already followed.");
        for (let i = 2; i <= 19; i++) yield* put(feedKey(uuid(i)), feed(uuid(i)));
        yield* put(feedKey(uuid(20)), { broken: true });
        const full = yield* failure(
          tasks.addSignalFeed({ url: "https://example.org/", label: "Other", projectId: null }),
        );
        assert.strictEqual(full.reason, "invalid");
        assert.strictEqual(full.message, "This server follows at most 20 feeds.");
      }),
    ),
  );

  it.effect("3: unfollow removes only that feed's signal rows", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const one = feed(uuid(1));
        const two = feed(uuid(2));
        const savedTask = yield* tasks.create({ projectId: null, title: "Keep this task" });
        const pending = candidate(one.id, "pending");
        const admitted = candidate(one.id, "admitted", {
          state: "admitted",
          decidedAt: at,
          decidedRevision: 1,
          taskId: savedTask.id,
        });
        const other = candidate(two.id, "other");
        yield* put(feedKey(one.id), one);
        yield* put(stateKey(one.id), state(one.id));
        yield* put(feedKey(two.id), two);
        yield* put(stateKey(two.id), state(two.id));
        yield* seed(pending);
        yield* seed({ ...admitted, decidedSha256: admitted.sha256 });
        yield* seed(other);
        const before = yield* rows;
        yield* tasks.removeSignalFeed({ feedId: one.id });
        const after = yield* rows;
        assert.deepStrictEqual(
          after,
          before.filter(
            (row) =>
              row.key !== feedKey(one.id) &&
              row.key !== stateKey(one.id) &&
              !row.key.startsWith(`factory/v1/signal-candidate/${one.id}/`),
          ),
        );
        assert.deepStrictEqual(yield* record(taskKey(savedTask.id)), savedTask);
        const missing = yield* failure(tasks.removeSignalFeed({ feedId: uuid(99) }));
        assert.strictEqual(missing.reason, "not-found");
        assert.strictEqual(missing.message, "This feed is no longer followed.");
      }),
    ),
  );

  it.effect("4: list orders, counts, caps and excludes damaged rows", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const one = feed(uuid(1));
        const two = feed(uuid(2));
        yield* put(feedKey(two.id), two);
        yield* put(feedKey(one.id), one);
        yield* put(stateKey(one.id), state(one.id));
        const pending = Array.from({ length: 201 }, (_, i) =>
          candidate(one.id, `item-${i}`, { changedAt: i < 2 ? later : at }),
        );
        for (const row of pending) yield* seed(row);
        const dismissed = candidate(two.id, "dismissed", {
          state: "dismissed",
          decidedAt: later,
          decidedRevision: 1,
        });
        const admitted = candidate(two.id, "admitted", {
          state: "admitted",
          decidedAt: later,
          decidedRevision: 1,
          taskId: uuid(40),
        });
        const older = candidate(two.id, "old", {
          state: "dismissed",
          decidedAt: at,
          decidedRevision: 1,
        });
        const decided = [dismissed, admitted, older].map((row) => ({
          ...row,
          decidedSha256: row.sha256,
        }));
        for (const row of decided) yield* seed(row);
        yield* put(feedKey(uuid(3)), { bad: true });
        yield* put(stateKey(two.id), { ...state(uuid(3)) });
        yield* put(candidateKey(one.id, "0".repeat(64)), { bad: true });
        yield* put(candidateKey(one.id, "1".repeat(64)), pending[0]);
        const before = yield* rows;
        const waiting = yield* tasks.listSignals({ view: "pending" });
        const expectedPending = [...pending].sort(
          (a, b) => b.changedAt.localeCompare(a.changedAt) || a.id.localeCompare(b.id),
        );
        assert.deepStrictEqual(waiting.feeds, [
          { feed: one, state: state(one.id), pending: 201 },
          { feed: two, state: null, pending: 0 },
        ]);
        assert.deepStrictEqual(waiting.candidates, expectedPending.slice(0, 200));
        assert.strictEqual(waiting.truncated, true);
        assert.strictEqual(waiting.damaged, 4);
        const done = yield* tasks.listSignals({ view: "decided" });
        assert.deepStrictEqual(
          done.candidates,
          [...decided].sort(
            (a, b) =>
              (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "") || a.id.localeCompare(b.id),
          ),
        );
        assert.deepStrictEqual(done.feeds, waiting.feeds);
        assert.strictEqual(done.damaged, 4);
        assert.strictEqual(done.truncated, false);
        assert.deepStrictEqual(yield* rows, before);
      }),
    ),
  );

  it.effect("5: admission creates exactly the fixed unstarted task and receipt", () =>
    withFactory((starts) =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const sourceFeed = {
          ...feed(uuid(1)),
          label: "Typed label",
          projectId: ProjectId.make("project-1"),
        };
        const item = candidate(sourceFeed.id, "secret-item-key", {
          projectId: sourceFeed.projectId,
        });
        yield* put(feedKey(sourceFeed.id), sourceFeed);
        yield* seed(item);
        const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
        const result = yield* tasks.admitSignal(decision(item));
        const description = [
          `A person admitted this task from a followed feed: ${sourceFeed.label}.`,
          `Candidate ${item.id}, revision ${item.revision}, sha256 ${item.sha256}.`,
          "Write what you want done here before you start it.",
        ].join("\n");
        assert.deepStrictEqual(result.task, {
          v: 1,
          id: result.task.id,
          number: 1,
          rev: 1,
          projectId: item.projectId,
          title: item.title,
          description,
          lane: "backlog",
          laneSetAt: now,
          parentId: null,
          blockedBy: [],
          assignee: null,
          model: null,
          source: {
            _tag: "signal",
            feedId: item.feedId,
            candidateId: item.id,
            revision: item.revision,
            sha256: item.sha256,
          },
          createdAt: now,
          updatedAt: now,
        });
        assert.match(
          result.task.id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        for (const text of [item.summary, item.link, item.itemKey])
          if (text !== null) assert.strictEqual(description.includes(text), false);
        assert.deepStrictEqual(result.candidate, {
          ...item,
          state: "admitted",
          decidedAt: now,
          decidedRevision: item.revision,
          decidedSha256: item.sha256,
          taskId: result.task.id,
        });
        assert.deepStrictEqual(yield* record(candidateKey(item.feedId, item.id)), result.candidate);
        assert.deepStrictEqual(yield* record(taskKey(result.task.id)), result.task);
        assert.deepStrictEqual((yield* tasks.get(result.task.id)).attempts, []);
        assert.deepStrictEqual(starts, []);
        assert.strictEqual(
          (yield* rows).filter((row) => row.key.startsWith("factory/v1/task/")).length,
          1,
        );
        assert.strictEqual(
          (yield* rows).filter((row) => row.key.startsWith("factory/v1/attempt/")).length,
          0,
        );
      }),
    ),
  );

  it.effect("6: stale revision or digest conflicts without allocating", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const item = candidate(uuid(1), "revision", { revision: 2 });
        yield* put(feedKey(item.feedId), feed(item.feedId));
        yield* seed(item);
        yield* put(seqKey, 9);
        const before = yield* rows;
        for (const input of [
          { ...decision(item), revision: 1 },
          { ...decision(item), sha256: wrongSha },
        ]) {
          const error = yield* failure(tasks.admitSignal(input));
          assert.strictEqual(error.reason, "conflict");
          assert.strictEqual(error.rev, 2);
          assert.strictEqual(
            error.message,
            "This item changed since it was shown. Read it again before you decide.",
          );
          assert.strictEqual(yield* record(seqKey), 9);
          assert.deepStrictEqual(yield* rows, before);
        }
      }),
    ),
  );

  it.effect("7: sequential and concurrent admits allocate once per candidate", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const first = candidate(uuid(1), "sequential");
        const second = candidate(uuid(1), "concurrent");
        yield* put(feedKey(first.feedId), feed(first.feedId));
        yield* seed(first);
        yield* seed(second);
        yield* put(seqKey, 10);
        const a = yield* tasks.admitSignal(decision(first));
        const b = yield* tasks.admitSignal(decision(first));
        assert.strictEqual(a.task.id, b.task.id);
        assert.strictEqual(yield* record(seqKey), 11);
        const [c, d] = yield* Effect.all(
          [tasks.admitSignal(decision(second)), tasks.admitSignal(decision(second))],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(c.task.id, d.task.id);
        assert.notStrictEqual(c.task.id, a.task.id);
        assert.strictEqual(yield* record(seqKey), 12);
        assert.strictEqual(
          (yield* rows).filter((row) => row.key.startsWith("factory/v1/task/")).length,
          2,
        );
      }),
    ),
  );

  it.effect("8: admitted receipt binds both digest and revision even after the row changes", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const item = candidate(uuid(1), "receipt");
        yield* put(feedKey(item.feedId), feed(item.feedId));
        yield* seed(item);
        const first = yield* tasks.admitSignal(decision(item));
        const before = yield* rows;
        assert.deepStrictEqual(yield* tasks.admitSignal(decision(item)), first);
        const bad = yield* failure(tasks.admitSignal({ ...decision(item), sha256: wrongSha }));
        assert.strictEqual(bad.reason, "conflict");
        assert.strictEqual(bad.rev, 1);
        assert.strictEqual(bad.message, "This item was already admitted.");
        assert.deepStrictEqual(yield* rows, before);
        const changedContent = {
          ...first.candidate,
          title: "Updated title",
          revision: 2,
          changedAt: later,
        };
        const changed = { ...changedContent, sha256: digest(changedContent) };
        yield* seed(changed);
        const revisionError = yield* failure(tasks.admitSignal(decision(changed)));
        assert.strictEqual(revisionError.reason, "conflict");
        assert.strictEqual(revisionError.rev, 2);
        assert.strictEqual(revisionError.message, "This item was already admitted.");
        const retry = yield* tasks.admitSignal(decision(item));
        assert.deepStrictEqual(retry, { candidate: changed, task: first.task });
        assert.strictEqual(yield* record(seqKey), 1);
        assert.strictEqual(
          (yield* rows).filter((row) => row.key.startsWith("factory/v1/task/")).length,
          1,
        );
      }),
    ),
  );

  it.effect("9: an inconsistent stored digest is invalid and allocates nothing", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const item = candidate(uuid(1), "damaged", { sha256: wrongSha });
        yield* put(feedKey(item.feedId), feed(item.feedId));
        yield* seed(item);
        const before = yield* rows;
        const error = yield* failure(tasks.admitSignal(decision(item)));
        assert.strictEqual(error.reason, "invalid");
        assert.strictEqual(error.message, "This item's record is damaged.");
        assert.deepStrictEqual(yield* rows, before);
        assert.strictEqual(yield* record(seqKey), undefined);
        const wrongId = { ...candidate(item.feedId, "wrong-id"), id: "e".repeat(64) };
        yield* seed(wrongId);
        const beforeWrongId = yield* rows;
        const idError = yield* failure(tasks.admitSignal(decision(wrongId)));
        assert.strictEqual(idError.reason, "invalid");
        assert.strictEqual(idError.message, "This item's record is damaged.");
        assert.deepStrictEqual(yield* rows, beforeWrongId);
      }),
    ),
  );

  it.effect("9: absent or unreadable records fail before admission", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const item = candidate(uuid(1), "missing");
        const missing = yield* failure(tasks.admitSignal(decision(item)));
        assert.strictEqual(missing.reason, "not-found");
        assert.strictEqual(missing.message, "This item is no longer listed.");
        yield* put(candidateKey(item.feedId, item.id), { invalid: true });
        const damaged = yield* failure(tasks.admitSignal(decision(item)));
        assert.strictEqual(damaged.reason, "not-found");
        assert.strictEqual(damaged.message, "This item is no longer listed.");
        yield* seed(item);
        const missingFeed = yield* failure(tasks.admitSignal(decision(item)));
        assert.strictEqual(missingFeed.reason, "not-found");
        assert.strictEqual(missingFeed.message, "This feed is no longer followed.");
        yield* put(feedKey(item.feedId), { invalid: true });
        const damagedFeed = yield* failure(tasks.admitSignal(decision(item)));
        assert.strictEqual(damagedFeed.reason, "not-found");
        assert.strictEqual(damagedFeed.message, "This feed is no longer followed.");
        yield* put(feedKey(item.feedId), feed(item.feedId));
        const admitted = yield* tasks.admitSignal(decision(item));
        yield* remove(taskKey(admitted.task.id));
        const missingTask = yield* failure(tasks.admitSignal(decision(item)));
        assert.strictEqual(missingTask.reason, "not-found");
        assert.strictEqual(missingTask.message, "The admitted task could not be read.");
        assert.strictEqual(yield* record(seqKey), 1);
      }),
    ),
  );

  it.effect(
    "10: dismissal is digest-bound, reversible by admission, and rediscovery starts anew",
    () =>
      withFactory(() =>
        Effect.gen(function* () {
          const tasks = yield* FactoryTasks.FactoryTasks;
          const item = candidate(uuid(1), "dismissed");
          yield* put(feedKey(item.feedId), feed(item.feedId));
          yield* seed(item);
          const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
          const dismissed = yield* tasks.dismissSignal(decision(item));
          assert.deepStrictEqual(dismissed, {
            ...item,
            state: "dismissed",
            decidedAt: now,
            decidedRevision: 1,
            decidedSha256: item.sha256,
            taskId: null,
          });
          const before = yield* rows;
          assert.deepStrictEqual(yield* tasks.dismissSignal(decision(item)), dismissed);
          const wrong = yield* failure(
            tasks.dismissSignal({ ...decision(item), sha256: wrongSha }),
          );
          assert.strictEqual(wrong.reason, "conflict");
          assert.strictEqual(wrong.rev, 1);
          assert.strictEqual(
            wrong.message,
            "This item changed since it was shown. Read it again before you decide.",
          );
          assert.deepStrictEqual(yield* rows, before);
          const admitted = yield* tasks.admitSignal(decision(item));
          const already = yield* failure(tasks.dismissSignal(decision(item)));
          assert.strictEqual(already.reason, "conflict");
          assert.strictEqual(already.message, "This item was already admitted.");
          assert.strictEqual(admitted.candidate.taskId, admitted.task.id);
          const pruned = candidate(item.feedId, "pruned");
          yield* seed(pruned);
          yield* tasks.dismissSignal(decision(pruned));
          yield* remove(candidateKey(pruned.feedId, pruned.id));
          const rediscovered = candidate(item.feedId, "pruned", {
            firstSeenAt: later,
            changedAt: later,
          });
          yield* seed(rediscovered);
          const fromRediscovery = yield* tasks.admitSignal(decision(rediscovered));
          assert.strictEqual(fromRediscovery.candidate.decidedRevision, 1);
          assert.notStrictEqual(fromRediscovery.task.id, admitted.task.id);
        }),
      ),
  );

  it.effect("11: create cannot forge a signal source and disabled methods refuse", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const item = candidate(uuid(1), "forged");
        const before = yield* rows;
        const error = yield* failure(
          tasks.create({
            projectId: null,
            title: "Forged",
            source: {
              _tag: "signal",
              feedId: item.feedId,
              candidateId: item.id,
              revision: item.revision,
              sha256: item.sha256,
            },
          }),
        );
        assert.strictEqual(error.reason, "invalid");
        assert.strictEqual(error.message, "Only Admit can add a task from a feed item.");
        assert.deepStrictEqual(yield* rows, before);
      }),
    ),
  );

  it.effect("11: the disabled stand-in refuses each signals method like create", () =>
    Effect.gen(function* () {
      const disabled = yield* FactoryTasks.orDisabled;
      const item = candidate(uuid(1), "disabled");
      const createError = yield* failure(disabled.create({ projectId: null, title: "Task" }));
      const listError = yield* failure(disabled.listSignals({ view: "pending" }));
      const addError = yield* failure(
        disabled.addSignalFeed({ url: "https://example.com/", label: "Feed", projectId: null }),
      );
      const removeError = yield* failure(disabled.removeSignalFeed({ feedId: item.feedId }));
      const admitError = yield* failure(disabled.admitSignal(decision(item)));
      const dismissError = yield* failure(disabled.dismissSignal(decision(item)));
      for (const error of [listError, addError, removeError, admitError, dismissError]) {
        assert.strictEqual(error.reason, createError.reason);
        assert.strictEqual(error.message, createError.message);
      }
    }),
  );

  it("12: all five RPCs have their aggregate and required scopes", () => {
    const read = "factory.signals.list";
    const guarded = [
      "factory.signals.feeds.add",
      "factory.signals.feeds.remove",
      "factory.signals.admit",
      "factory.signals.dismiss",
    ] as const;
    const methods: ReadonlyArray<keyof typeof FACTORY_RPC_AGGREGATES> = [read, ...guarded];
    for (const method of methods) {
      assert.strictEqual(FactoryRpcGroup.requests.has(method), true);
      assert.strictEqual(FACTORY_RPC_AGGREGATES[method], "factory");
    }
    assert.strictEqual(FACTORY_RPC_READ_SCOPES[read], AuthOrchestrationReadScope);
    for (const method of guarded)
      assert.strictEqual(FACTORY_CLIENT_GUARDED_RPC_SCOPES[method], AuthOrchestrationOperateScope);
  });

  it.effect("r10b S12 admit retries reject unrelated or mismatched tasks", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const item = candidate(uuid(1), "receipt-owner");
        yield* put(feedKey(item.feedId), feed(item.feedId));
        yield* seed(item);
        const admitted = yield* tasks.admitSignal(decision(item));
        const local = yield* tasks.create({ projectId: null, title: "Unrelated local task" });

        yield* put(taskKey(admitted.task.id), { ...admitted.task, id: uuid(99) });
        const mismatched = yield* failure(tasks.admitSignal(decision(item)));
        assert.strictEqual(mismatched.reason, "not-found");
        assert.strictEqual(mismatched.message, "The admitted task could not be read.");
        yield* put(taskKey(admitted.task.id), admitted.task);

        yield* seed({ ...admitted.candidate, taskId: local.id });
        const unrelated = yield* failure(tasks.admitSignal(decision(item)));
        assert.strictEqual(unrelated.reason, "not-found");
        assert.strictEqual(unrelated.message, "The admitted task could not be read.");
        yield* seed(admitted.candidate);
        assert.deepStrictEqual(yield* tasks.admitSignal(decision(item)), admitted);
        assert.strictEqual(yield* record(seqKey), 2);
      }),
    ),
  );

  it.effect("r10b S12 prefix scans include the highest Unicode key", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        for (let n = 1; n <= 19; n++) yield* put(feedKey(uuid(n)), feed(uuid(n)));
        const high = "\u{10FFFF}";
        yield* put(feedKey(high), { damaged: true });
        const refused = yield* failure(
          tasks.addSignalFeed({
            url: "https://new.example/feed",
            label: "New feed",
            projectId: null,
          }),
        );
        assert.strictEqual(refused.reason, "invalid");
        assert.strictEqual(refused.message, "This server follows at most 20 feeds.");
        const listed = yield* tasks.listSignals({ view: "pending" });
        assert.strictEqual(listed.feeds.length, 19);
        assert.strictEqual(listed.damaged, 1);

        const removedId = uuid(1);
        const otherId = uuid(2);
        const highCandidateKey = candidateKey(removedId, high);
        const other = candidate(otherId, "retained");
        yield* put(stateKey(removedId), state(removedId));
        yield* put(highCandidateKey, { damaged: true });
        yield* put(stateKey(otherId), state(otherId));
        yield* seed(other);
        const otherRows = (yield* rows).filter(
          (row) =>
            row.key === feedKey(otherId) ||
            row.key === stateKey(otherId) ||
            row.key.startsWith(`factory/v1/signal-candidate/${otherId}/`),
        );
        yield* tasks.removeSignalFeed({ feedId: removedId });
        assert.strictEqual(yield* record(feedKey(removedId)), undefined);
        assert.strictEqual(yield* record(stateKey(removedId)), undefined);
        assert.strictEqual(yield* record(highCandidateKey), undefined);
        assert.deepStrictEqual(
          (yield* rows).filter((row) => otherRows.some((before) => before.key === row.key)),
          otherRows,
        );
        assert.deepStrictEqual(yield* record(feedKey(high)), { damaged: true });
      }),
    ),
  );

  it.effect("r10b S12 both views order timestamp instants rather than strings", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const feedId = uuid(1);
        yield* put(feedKey(feedId), feed(feedId));
        const utc = "1970-01-02T00:30:00.000Z";
        const offset = "1970-01-02T01:30:00.000+02:00";
        const newerPending = candidate(feedId, "newer-pending", { changedAt: utc });
        const olderPending = candidate(feedId, "older-pending", { changedAt: offset });
        const newerDecidedBase = candidate(feedId, "newer-decided");
        const olderDecidedBase = candidate(feedId, "older-decided");
        const newerDecided = {
          ...newerDecidedBase,
          state: "dismissed" as const,
          decidedAt: utc,
          decidedRevision: 1,
          decidedSha256: newerDecidedBase.sha256,
        };
        const olderDecided = {
          ...olderDecidedBase,
          state: "dismissed" as const,
          decidedAt: offset,
          decidedRevision: 1,
          decidedSha256: olderDecidedBase.sha256,
        };
        for (const row of [newerPending, olderPending, newerDecided, olderDecided])
          yield* seed(row);

        // If IsoDateTime rejects offsets, those rows are damaged rather than sortable;
        // if it accepts them, ordering is by instant, not their lexical representation.
        const pendingDecodes = isCandidate(olderPending);
        const decidedDecodes = isCandidate(olderDecided);
        const damaged = Number(!pendingDecodes) + Number(!decidedDecodes);
        const waiting = yield* tasks.listSignals({ view: "pending" });
        const decided = yield* tasks.listSignals({ view: "decided" });
        assert.deepStrictEqual(
          waiting.candidates,
          pendingDecodes ? [newerPending, olderPending] : [newerPending],
        );
        assert.deepStrictEqual(
          decided.candidates,
          decidedDecodes ? [newerDecided, olderDecided] : [newerDecided],
        );
        assert.strictEqual(waiting.damaged, damaged);
        assert.strictEqual(decided.damaged, damaged);
      }),
    ),
  );

  it.effect("r10b S12 a multiline stored title cannot be admitted", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const content = candidate(uuid(1), "multiline", { title: "First line\nSecond line" });
        const item = { ...content, sha256: digest(content) };
        yield* put(feedKey(item.feedId), feed(item.feedId));
        yield* seed(item);
        yield* put(seqKey, 7);
        const before = yield* rows;
        const error = yield* failure(tasks.admitSignal(decision(item)));
        assert.strictEqual(error.reason, "invalid");
        assert.strictEqual(error.message, "This item's record is damaged.");
        assert.strictEqual(yield* record(seqKey), 7);
        assert.deepStrictEqual(yield* rows, before);
        assert.strictEqual(
          (yield* rows).filter((row) => row.key.startsWith("factory/v1/task/")).length,
          0,
        );
      }),
    ),
  );

  it.effect(
    "r10c S4 stored titles with invisible characters or excess combining marks are refused",
    () =>
      withFactory(() =>
        Effect.gen(function* () {
          const tasks = yield* FactoryTasks.FactoryTasks;
          const feedId = uuid(1);
          yield* put(feedKey(feedId), feed(feedId));
          yield* put(seqKey, 7);
          const titles = [
            "Update docs\u{E0069}\u{E0067}\u{E006E}",
            "Up\u200Bdate",
            "Up\u00ADdate",
            "Update\uFE0F",
            `a${"\u0301".repeat(31)}`,
          ];
          for (const [index, title] of titles.entries()) {
            const content = candidate(feedId, `invisible-${index}`, { title });
            const item = { ...content, sha256: digest(content) };
            yield* seed(item);
            const before = yield* rows;
            const error = yield* failure(tasks.admitSignal(decision(item)));
            assert.strictEqual(error.reason, "invalid");
            assert.strictEqual(error.message, "This item's record is damaged.");
            assert.strictEqual(yield* record(seqKey), 7);
            assert.deepStrictEqual(yield* rows, before);
            assert.strictEqual(
              (yield* rows).filter((row) => row.key.startsWith("factory/v1/task/")).length,
              0,
            );
          }
          const content = candidate(feedId, "visible", { title: "Update docs" });
          const visible = { ...content, sha256: digest(content) };
          yield* seed(visible);
          const admitted = yield* tasks.admitSignal(decision(visible));
          assert.strictEqual(admitted.task.title, "Update docs");
          assert.strictEqual(admitted.candidate.taskId, admitted.task.id);
          assert.strictEqual(yield* record(seqKey), 8);
        }),
      ),
  );

  it.effect("r10c S4 feed names discard invisible characters before validation", () =>
    withFactory(() =>
      Effect.gen(function* () {
        const tasks = yield* FactoryTasks.FactoryTasks;
        const added = yield* tasks.addSignalFeed({
          url: "https://example.com/releases",
          label: "Rel\u200Beases\u{E0041}",
          projectId: null,
        });
        assert.strictEqual(added.label, "Releases");
        assert.deepStrictEqual(yield* record(feedKey(added.id)), added);
        const before = yield* rows;
        const error = yield* failure(
          tasks.addSignalFeed({
            url: "https://example.com/empty",
            label: "\u200B\u00AD\uFE0F\u{E0041}",
            projectId: null,
          }),
        );
        assert.strictEqual(error.reason, "invalid");
        assert.strictEqual(error.message, "A feed's name is 1 to 100 characters.");
        assert.deepStrictEqual(yield* rows, before);
      }),
    ),
  );
});
