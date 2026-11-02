import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  FactoryIssueError,
  FactoryWorkError,
  SourceControlProviderKind,
  type FactoryIssueReadinessReadResult,
  type FactoryReadinessEdge,
  type FactoryWorkRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Relations from "./FactoryIssueRelations.ts";
import * as Work from "./FactoryWorkService.ts";

const environmentId = EnvironmentId.make("owner-environment");
const owner = ProjectId.make("owner-project");
const observer = ProjectId.make("observer-checkout");
const at = "2026-10-25T00:00:00.000Z";
const layerWith = (relations: Partial<Relations.FactoryIssueRelations["Service"]>) =>
  Work.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Sqlite.layerMemory,
        Layer.succeed(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        Layer.mock(Relations.FactoryIssueRelations)(relations),
      ),
    ),
  );
const layer = layerWith({});
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
      VALUES (${id}, ${id}, 'item', ${id}, ${JSON.stringify({ projectId: owner, createdAt: at, previousThreadId: null, title: id, revision: "admitted-feed-revision", snapshot: { content: "Frozen feed content", link: null } })}, 'feed:same-source', ${id === "feed-conflict" ? 1 : 0})`;
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
      assert.equal(
        page.items.find((item) => item.ref.id === "feed-one")?.revision,
        "admitted-feed-revision",
      );
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

const edge = (
  repository: string,
  number: number,
  fields: Partial<FactoryReadinessEdge> = {},
): FactoryReadinessEdge => ({
  targetId: number,
  targetHost: "github.com",
  targetRepository: repository,
  targetNumber: number,
  targetUrl: `https://github.com/${repository}/issues/${number}`,
  title: `Blocker ${number}`,
  state: "open",
  stateReason: null,
  closedAt: null,
  resolution: "open",
  status: "present",
  firstObservedAt: at,
  lastObservedAt: at,
  fingerprint: `edge-${number}`,
  override: null,
  ...fields,
});
const observed = (edges: readonly FactoryReadinessEdge[]): FactoryIssueReadinessReadResult => ({
  repository: {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    repository: "test/repo",
    canonicalKey: "github.com/test/repo",
    url: "https://github.com/test/repo",
  },
  issueNumber: 1,
  readiness: {
    status: "blocked",
    reasons: ["open-blocker", "cycle"],
    basis: null,
    edges,
    overrides: [],
    complete: true,
    listedCount: edges.length,
    summaryTotal: edges.length,
    observedAt: at,
  },
});
const launch = (
  threadId: string,
  canonicalKey: string,
  issueNumber: number,
  options: { readonly previous?: string; readonly project?: string; readonly current?: boolean },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const intent = {
      projectId: options.project ?? owner,
      createdAt: at,
      previousThreadId: options.previous ?? null,
      issue: { number: issueNumber, title: threadId, body: "", state: "open", url: "" },
    };
    yield* sql`INSERT INTO factory_issue_launches (thread_id, canonical_key, issue_number, request_command_id, intent_json, origin_key, superseded, accepted)
      VALUES (${threadId}, ${canonicalKey}, ${issueNumber}, ${threadId}, ${JSON.stringify(intent)}, ${threadId}, ${options.current ? 0 : 1}, 1)`;
  });

it.effect(
  "maps source blockers to stable retained roots across projects without guessing through malformed ancestry",
  () => {
    const calls: unknown[] = [];
    let edges: readonly FactoryReadinessEdge[] = [];
    return Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE factory_issue_launches SET intent_json = json_set(intent_json, '$.projectId', ${observer}) WHERE thread_id = 'issue-retry'`;
      yield* launch("other-root", "github.com/acme/other", 5, { project: "other-project" });
      yield* launch("other-retry", "github.com/acme/other", 5, {
        previous: "other-root",
        project: observer,
        current: true,
      });
      yield* launch("ported-root", "ghe.example.com/acme/ported", 6, { current: true });
      yield* launch("cycle-a", "github.com/acme/cycle", 7, { previous: "cycle-b", current: true });
      yield* launch("cycle-b", "github.com/acme/cycle", 7, { previous: "cycle-a" });
      yield* launch("orphan", "github.com/acme/orphan", 8, { previous: "gone", current: true });
      for (let index = 0; index < 40; index++)
        yield* launch(`deep-${index}`, "github.com/acme/deep", 9, {
          ...(index === 0 ? {} : { previous: `deep-${index - 1}` }),
          current: index === 39,
        });
      edges = [
        edge("acme/other", 50, { status: "inaccessible", resolution: "inaccessible", title: null }),
        edge("acme/gone", 51, { status: "removed-at-source", resolution: "unverified" }),
        edge("Acme/Other", 5),
        edge("Acme/Ported", 6, { targetHost: "GHE.example.com:8443" }),
        edge("acme/unadmitted", 4),
        edge("acme/cycle", 7),
        edge("acme/orphan", 8),
        edge("acme/deep", 9),
      ];
      const work = yield* Work.FactoryWorkService;
      const result = yield* work.readPrerequisites({ ref: ref("issue", "issue-root") });
      assert.deepEqual(calls, [
        { projectId: observer, issueNumber: 1, canonicalKey: "github.com/test/repo" },
      ]);
      assert.equal(result.status, "observed");
      if (result.status !== "observed") return;
      assert.equal(result.reviewProjectId, observer);
      assert.deepEqual(result.readiness.reasons, ["open-blocker", "cycle"]);
      assert.equal("edges" in result.readiness, false);
      assert.deepEqual(
        result.prerequisites.map(({ edge, link }) => [edge.targetNumber, link]),
        [
          [
            5,
            {
              kind: "retained",
              ref: ref("issue", "other-root"),
              projectId: ProjectId.make("other-project"),
            },
          ],
          [6, { kind: "retained", ref: ref("issue", "ported-root"), projectId: owner }],
          [4, { kind: "none" }],
          [7, { kind: "unresolved", reason: "cycle" }],
          [8, { kind: "unresolved", reason: "missing-ancestry" }],
          [9, { kind: "unresolved", reason: "bound-exhausted" }],
          [50, { kind: "not-current" }],
          [51, { kind: "not-current" }],
        ],
      );
      assert.equal(result.omittedCount, 0);

      edges = [edge("Acme/Other", 5, { resolution: "unverified", title: null })];
      const unverified = yield* work.readPrerequisites({ ref: ref("issue", "issue-root") });
      assert.equal(unverified.status, "observed");
      if (unverified.status !== "observed") return;
      assert.deepEqual(unverified.prerequisites[0]?.link, { kind: "not-current" });

      edges = Array.from({ length: 520 }, (_, index) => edge("acme/bulk", index + 1));
      const capped = yield* work.readPrerequisites({ ref: ref("issue", "issue-root") });
      assert.equal(capped.status === "observed" && capped.prerequisites.length, 500);
      assert.equal(capped.status === "observed" && capped.omittedCount, 20);
    }).pipe(
      Effect.provide(
        layerWith({
          readAdmitted: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return observed(edges);
            }),
        }),
      ),
    );
  },
);

it.effect("reports not-modeled, unavailable owners and foreign refs without a tracker read", () => {
  let calls = 0;
  return Effect.gen(function* () {
    yield* seed;
    yield* launch("amb-root", "github.com/acme/amb", 3, {});
    yield* launch("amb-x", "github.com/acme/amb-x", 3, { previous: "amb-root", current: true });
    yield* launch("amb-y", "github.com/acme/amb-y", 3, { previous: "amb-root", current: true });
    yield* launch("deleted-root", "github.com/test/repo", 2, {
      project: "deleted-project",
      current: true,
    });
    const work = yield* Work.FactoryWorkService;
    for (const [kind, id] of [
      ["feed", "feed-one"],
      ["brief", "brief-one"],
      ["protocol", "protocol"],
    ] as const)
      assert.deepInclude(yield* work.readPrerequisites({ ref: ref(kind, id) }), {
        status: "not-modeled",
        kind,
      });
    assert.deepInclude(yield* work.readPrerequisites({ ref: ref("issue", "amb-root") }), {
      status: "owner-unavailable",
      reason: "ambiguous-owner",
    });
    const foreign = { ...ref("issue", "issue-root"), environmentId: EnvironmentId.make("other") };
    assert.equal(
      (yield* Effect.flip(work.readPrerequisites({ ref: foreign }))).reason,
      "wrong-environment",
    );
    assert.equal(
      (yield* Effect.flip(work.readPrerequisites({ ref: ref("brief", "missing") }))).reason,
      "missing-work",
    );
    assert.equal(calls, 0);
    assert.deepInclude(yield* work.readPrerequisites({ ref: ref("issue", "deleted-root") }), {
      status: "owner-unavailable",
      reason: "missing-project",
    });
  }).pipe(
    Effect.provide(
      layerWith({
        // The real read resolves the project first and fails here before any tracker request.
        readAdmitted: () =>
          Effect.sync(() => {
            calls++;
          }).pipe(
            Effect.andThen(Effect.fail(new FactoryIssueError({ reason: "missing-project" }))),
          ),
      }),
    ),
  );
});
