import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  FactoryWorkError,
  type FactoryWorkRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Work from "./FactoryWorkService.ts";

const environmentId = EnvironmentId.make("owner-environment");
const owner = ProjectId.make("owner-project");
const observer = ProjectId.make("observer-checkout");
const at = "2026-10-25T00:00:00.000Z";
const layer = Work.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Sqlite.layerMemory,
      Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    ),
  ),
);
const ref = (kind: FactoryWorkRef["kind"], id: string): FactoryWorkRef => ({
  version: 1,
  environmentId,
  kind,
  id,
});
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issue = {
    projectId: owner,
    createdAt: at,
    previousThreadId: null,
    issue: {
      number: 1,
      title: "Admitted issue",
      body: "Frozen issue body",
      state: "open",
      url: "https://github.com/test/repo/issues/1",
    },
  };
  yield* sql`INSERT INTO factory_issue_launches (thread_id, canonical_key, issue_number, request_command_id, intent_json, origin_key, superseded, accepted)
    VALUES ('issue-root', 'github.com/test/repo', 1, 'issue-root', ${JSON.stringify(issue)}, 'github:github.com/test/repo#1', 1, 1),
    ('issue-retry', 'github.com/test/repo', 1, 'issue-retry', ${JSON.stringify({ ...issue, previousThreadId: "issue-root" })}, 'github:github.com/test/repo#1', 0, 1)`;
  for (const id of ["feed-one", "feed-conflict"]) {
    yield* sql`INSERT INTO factory_feed_launches (thread_id, source_id, item_key, request_command_id, intent_json, origin_key, origin_conflict)
      VALUES (${id}, ${id}, 'item', ${id}, ${JSON.stringify({ projectId: owner, createdAt: at, previousThreadId: null, title: id, snapshot: { content: "Frozen feed content", link: null } })}, 'feed:same-source', ${id === "feed-conflict" ? 1 : 0})`;
  }
  for (const id of ["brief-one", "brief-two"]) {
    yield* sql`INSERT INTO factory_knowledge_briefs (id, project_id, revision, brief_json, request_command_id, created_at, created_by, superseded_by)
      VALUES (${id}, ${owner}, ${id}, ${JSON.stringify({ title: "Identical intentional brief", question: "A question" })}, ${id}, ${at}, 'author', ${id === "brief-one" ? "brief-two" : null})`;
  }
  yield* sql`INSERT INTO factory_research_protocols (protocol_id, canonical_key, project_id, request_command_id, protocol_json, revision, sealed_at)
    VALUES ('protocol', 'github.com/test/repo', ${owner}, 'protocol', ${JSON.stringify({ hypothesis: "Improve metric", repository: { url: "https://github.com/test/repo" } })}, 'sealed', ${at})`;
  for (const id of ["explore-one", "explore-two"])
    yield* sql`INSERT INTO factory_research_launches (thread_id, protocol_id, role, request_command_id, intent_json, created_at)
    VALUES (${id}, 'protocol', 'explore', ${id}, ${JSON.stringify({ role: "explore" })}, ${at})`;
});

it.effect(
  "projects retained admissions once, concrete revisions and legitimate research children without consulting observer repositories",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const work = yield* Work.FactoryWorkService;
      const page = yield* work.list({ projectIds: [owner, observer] });
      assert.deepEqual(
        page.items.map((item) => [item.ref.kind, item.ref.id, item.projectId]),
        [
          ["brief", "brief-one", owner],
          ["brief", "brief-two", owner],
          ["feed", "feed-conflict", owner],
          ["feed", "feed-one", owner],
          ["issue", "issue-root", owner],
          ["protocol", "protocol", owner],
        ],
      );
      assert.deepEqual((yield* work.list({ projectIds: [observer] })).items, []);
      assert.equal(
        page.items.find((item) => item.ref.id === "feed-conflict")?.originConflict,
        true,
      );
      assert.equal(page.items.find((item) => item.ref.id === "issue-root")?.revision, null);
      const oldBrief = yield* work.read({ ref: ref("brief", "brief-one") });
      assert.equal(oldBrief.item.supersededBy, "brief-two");
      assert.equal((yield* work.read({ ref: ref("brief", "brief-two") })).supersedes, "brief-one");
      assert.equal(oldBrief.projectAvailable, false);
      const executions = yield* work.history({
        ref: ref("issue", "issue-root"),
        section: "executions",
      });
      assert.deepEqual(
        executions.entries.map((entry) => [entry.threadId, entry.superseded, entry.state]),
        [
          ["issue-retry", false, "missing"],
          ["issue-root", true, "missing"],
        ],
      );
      assert.deepEqual(
        (yield* work.history({
          ref: ref("protocol", "protocol"),
          section: "executions",
        })).entries.map((entry) => entry.threadId),
        ["explore-one", "explore-two"],
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE factory_issue_launches SET intent_json = json_set(intent_json, '$.projectId', ${observer}) WHERE thread_id = 'issue-retry'`;
      const restarted = yield* work.read({ ref: ref("issue", "issue-root") });
      assert.equal(restarted.item.projectId, owner);
      assert.equal(restarted.reviewProjectId, observer);
      assert.deepEqual(restarted.reviewTarget, { kind: "issue", issueNumber: 1 });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "binds immutable keyset cursors to owner, version and filters while insertions do not duplicate prior pages",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const work = yield* Work.FactoryWorkService;
      const first = yield* work.list({ projectIds: [owner], limit: 2 });
      assert.isNotNull(first.nextCursor);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO factory_knowledge_briefs (id, project_id, revision, brief_json, request_command_id, created_at, created_by)
    VALUES ('a-new-older', ${owner}, 'new', '{"title":"new","question":"new"}', 'new', '2026-10-24T00:00:00.000Z', 'author')`;
      const cursor = first.nextCursor ?? "";
      const second = yield* work.list({ projectIds: [owner], limit: 2, cursor });
      assert.deepEqual(
        second.items.map((item) => item.ref.id),
        ["feed-conflict", "feed-one"],
      );
      const filtered = yield* Effect.flip(
        work.list({ projectIds: [owner], kind: "issue", cursor }),
      );
      assert.equal(filtered.reason, "invalid-cursor");
      const changedVersion = yield* Effect.flip(
        work.list({ cursor: cursor.replace('"version":1', '"version":2') }),
      );
      assert.equal(changedVersion.reason, "invalid-cursor");
      assert.deepEqual((yield* work.list({ projectIds: [], kind: "issue" })).items, []);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps answering-environment identity authoritative and refuses foreign detail and unrelated history",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const work = yield* Work.FactoryWorkService;
      const item = (yield* work.list({ kind: "issue" })).items[0];
      assert.equal(item?.ref.environmentId, environmentId);
      const foreign = {
        ...ref("issue", "issue-root"),
        environmentId: EnvironmentId.make("copied-database"),
      };
      assert.equal((yield* Effect.flip(work.read({ ref: foreign }))).reason, "wrong-environment");
      assert.equal(
        (yield* Effect.flip(
          work.history({
            ref: ref("brief", "brief-one"),
            section: "runs",
            threadId: (yield* work.history({
              ref: ref("issue", "issue-root"),
              section: "executions",
            })).entries[0]!.threadId,
          }),
        )).reason,
        "invalid-history",
      );
      assert.equal(
        (yield* Effect.flip(work.read({ ref: ref("brief", "missing") }))).reason,
        "missing-work",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "pages V2 runs, distinct retry attempts and output pins without reading payloads or granting unknown delivery retry",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      for (const id of ["run-one", "run-two"])
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
    VALUES (${id}, 'issue-retry', ${id === "run-one" ? 1 : 2}, 'test', 'failed', ${at}, 'not decoded')`;
      for (const id of ["attempt-one", "attempt-two"])
        yield* sql`INSERT INTO orchestration_v2_projection_run_attempts (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
    VALUES (${id}, 'issue-retry', 'run-one', ${id === "attempt-one" ? 1 : 2}, ${id}, 'test', ${id}, 'failed', 'not decoded')`;
      const work = yield* Work.FactoryWorkService;
      const input = {
        ref: ref("issue", "issue-root"),
        section: "runs" as const,
        threadId: (yield* work.history({ ref: ref("issue", "issue-root"), section: "executions" }))
          .entries[0]!.threadId,
        limit: 1,
      };
      const first = yield* work.history(input);
      assert.deepEqual(
        first.entries.map((entry) => [entry.id, entry.state]),
        [["run-one", "failed"]],
      );
      assert.deepEqual(
        (yield* work.history({ ...input, cursor: first.nextCursor ?? "" })).entries.map(
          (entry) => entry.id,
        ),
        ["run-two"],
      );
      const attempts = yield* work.history({
        ...input,
        section: "attempts",
        runId: "run-one",
        limit: 50,
      });
      assert.deepEqual(
        attempts.entries.map((entry) => entry.id),
        ["attempt-one", "attempt-two"],
      );
      yield* sql`INSERT INTO factory_acceptances (id, origin_key, thread_id, project_id, head_sha, base_ref, base_sha, accepted_at, accepted_by, evidence_json)
    VALUES ('pin', 'issue-pin', 'issue-retry', ${owner}, 'accepted-head', 'main', 'base', ${at}, 'reviewer', 'not decoded')`;
      yield* sql`INSERT INTO factory_delivery_intents (id, origin_key, thread_id, project_id, kind, acceptance_id, repository_json, base_ref, base_sha, head_sha, payload_json, payload_digest, granted_by, granted_at, request_command_id, status, updated_at)
    VALUES ('unknown-send', 'issue-pin', 'issue-retry', ${owner}, 'create-pull-request', 'pin', 'not decoded', 'main', 'base', 'accepted-head', 'not decoded', 'digest', 'reviewer', ${at}, 'grant', 'unknown', ${at})`;
      const outputs = yield* work.history({ ...input, section: "outputs", limit: 50 });
      assert.deepEqual(
        outputs.entries.map((entry) => [entry.id, entry.state, entry.pin]),
        [
          ["commit:pin", "currentness not inspected", "accepted-head"],
          ["delivery:unknown-send", "unknown", "digest"],
        ],
      );
      const counts = yield* sql<{
        readonly count: number;
      }>`SELECT count(*) AS count FROM orchestration_v2_effect_outbox`;
      assert.equal(counts[0]?.count, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("bounds summaries and detail before decoding unrelated rows", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE factory_knowledge_briefs SET brief_json = ${JSON.stringify({ title: "large", question: "x".repeat(12000) })} WHERE id = 'brief-one'`;
    yield* sql`INSERT INTO factory_knowledge_briefs (id, project_id, revision, brief_json, request_command_id, created_at, created_by)
    VALUES ('unrelated', 'other-project', 'broken', 'not json', 'broken', ${at}, 'author')`;
    const work = yield* Work.FactoryWorkService;
    const page = yield* work.list({ projectIds: [owner], limit: 1 });
    assert.equal(page.items[0]?.title, "large");
    assert.equal("snapshot" in (page.items[0] ?? {}), false);
    const detail = yield* work.read({ ref: ref("brief", "brief-one") });
    assert.equal(detail.snapshot.length, 8000);
    assert.equal(detail.snapshotTruncated, true);
    assert.instanceOf(yield* Effect.flip(work.list({ cursor: "bad" })), FactoryWorkError);
  }).pipe(Effect.provide(layer)),
);
