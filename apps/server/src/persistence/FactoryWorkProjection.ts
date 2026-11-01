import {
  FactoryWorkError,
  FactoryWorkSummary,
  FactoryWorkHistoryEntry,
  FactoryWorkReviewTarget,
  ThreadId,
  ProjectId,
  type FactoryWorkRef,
  type EnvironmentId,
  type FactoryWorkListInput,
  type FactoryWorkReadInput,
  type FactoryWorkHistoryInput,
  type FactoryWorkListResult,
  type FactoryWorkReadResult,
  type FactoryWorkHistoryResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

const Row = Schema.Struct({
  kind: FactoryWorkSummary.fields.ref.fields.kind,
  id: Schema.String,
  ...FactoryWorkSummary.mapFields(({ ref: _ref, originConflict: _conflict, ...fields }) => fields)
    .fields,
  conflict: Schema.Number,
  snapshot: Schema.String,
  snapshotTruncated: Schema.Number,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const decodeKeys = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      kind: FactoryWorkSummary.fields.ref.fields.kind,
      id: Schema.String,
      createdAt: Schema.String,
    }),
  ),
);
const decodeReviewTarget = Schema.decodeUnknownEffect(FactoryWorkReviewTarget);
const decodeHistory = Schema.decodeUnknownEffect(
  Schema.Array(
    FactoryWorkHistoryEntry.mapFields(({ superseded: _superseded, ...fields }) => ({
      ...fields,
      superseded: Schema.Number,
      orderKey: Schema.String,
    })),
  ),
);
const isWorkError = Schema.is(FactoryWorkError);
const decodeExecutionOwner = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      projectId: ProjectId,
    }),
  ),
);
const Cursor = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    scope: Schema.String,
    order: Schema.String,
    id: Schema.String,
  }),
);
const decodeCursor = Schema.decodeUnknownEffect(Cursor);
const encodeCursor = Schema.encodeSync(Cursor);
const encodeListScope = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.String,
      Schema.NullOr(Schema.Array(Schema.String)),
      Schema.NullOr(Schema.String),
    ]),
  ),
);
const encodeHistoryScope = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.String,
      Schema.String,
      Schema.String,
      Schema.String,
      Schema.NullOr(Schema.String),
      Schema.NullOr(Schema.String),
    ]),
  ),
);
const pageCursor = Effect.fn("FactoryWorkProjection.cursor")(function* (
  cursor: string | undefined,
  scope: string,
) {
  if (cursor === undefined) return null;
  const value = yield* decodeCursor(cursor).pipe(
    Effect.mapError(() => new FactoryWorkError({ reason: "invalid-cursor" })),
  );
  if (value.scope !== scope) return yield* new FactoryWorkError({ reason: "invalid-cursor" });
  return value;
});
const failure = (cause: unknown) =>
  isWorkError(cause) ? cause : new FactoryWorkError({ reason: "persistence-failure", cause });
// JSON extraction stays in the indexed read boundary; no launch prompts or full thread payloads cross it.
const json = (column: string, path: string) =>
  `json_extract(CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END, '$.${path}')`;
const intent = (path: string) => json("intent_json", path);
const launchBranch = (kind: "issue" | "feed", table: string) => {
  const title = kind === "issue" ? intent("issue.title") : intent("title");
  const body = kind === "issue" ? intent("issue.body") : intent("snapshot.content");
  return `SELECT '${kind}' AS kind, thread_id AS id, ${intent("projectId")} AS projectId,
    substr(COALESCE(${title}, '(untitled)'), 1, 512) AS title, ${intent("createdAt")} AS createdAt,
    origin_key AS sourceKey, ${kind === "issue" ? intent("issue.url") : intent("snapshot.link")} AS sourceUrl,
    ${kind === "issue" ? intent("issue.state") : "NULL"} AS sourceState,
    ${kind === "feed" ? intent("revision") : "NULL"} AS revision, NULL AS supersededBy, ${
      kind === "feed"
        ? `CASE WHEN origin_conflict = 1 OR EXISTS (
      SELECT 1 FROM factory_feed_launches conflicts WHERE conflicts.origin_key = factory_feed_launches.origin_key
        AND conflicts.origin_conflict = 1) THEN 1 ELSE 0 END`
        : "0"
    } AS conflict,
    substr(COALESCE(${body}, ''), 1, 8000) AS snapshot,
    length(COALESCE(${body}, '')) > 8000 AS snapshotTruncated
    FROM ${table} WHERE ${intent("previousThreadId")} IS NULL`;
};
const collection = `work AS (
  ${launchBranch("issue", "factory_issue_launches")}
  UNION ALL ${launchBranch("feed", "factory_feed_launches")}
  UNION ALL SELECT 'brief', id, project_id, substr(${json("brief_json", "title")}, 1, 512), created_at,
    NULL, NULL, NULL, revision, superseded_by, 0,
    substr(${json("brief_json", "question")}, 1, 8000), length(${json("brief_json", "question")}) > 8000
    FROM factory_knowledge_briefs
  UNION ALL SELECT 'protocol', protocol_id, project_id, substr(${json("protocol_json", "hypothesis")}, 1, 512), sealed_at,
    NULL, ${json("protocol_json", "repository.url")}, NULL, revision, NULL, 0,
    substr(${json("protocol_json", "hypothesis")}, 1, 8000), length(${json("protocol_json", "hypothesis")}) > 8000
    FROM factory_research_protocols
)`;
// A retired root is the stable admission reference; its successor threads remain execution children.
const keyBranches = [
  {
    kind: "issue",
    query: `SELECT 'issue' AS kind, thread_id AS id, ${intent("projectId")} AS projectId, ${intent("createdAt")} AS createdAt
      FROM factory_issue_launches WHERE ${intent("previousThreadId")} IS NULL`,
  },
  {
    kind: "feed",
    query: `SELECT 'feed' AS kind, thread_id AS id, ${intent("projectId")} AS projectId, ${intent("createdAt")} AS createdAt
      FROM factory_feed_launches WHERE ${intent("previousThreadId")} IS NULL`,
  },
  {
    kind: "brief",
    query:
      "SELECT 'brief' AS kind, id, project_id AS projectId, created_at AS createdAt FROM factory_knowledge_briefs WHERE 1",
  },
  {
    kind: "protocol",
    query:
      "SELECT 'protocol' AS kind, protocol_id AS id, project_id AS projectId, sealed_at AS createdAt FROM factory_research_protocols WHERE 1",
  },
];
const rowColumns = `kind, id, projectId, title, createdAt, sourceKey, sourceUrl, sourceState, revision,
  supersededBy, conflict, NULL AS planningStage, snapshot, snapshotTruncated`;
const summary = (row: typeof Row.Type, environmentId: EnvironmentId): FactoryWorkSummary => ({
  ref: { version: 1, environmentId, kind: row.kind, id: row.id },
  projectId: row.projectId,
  title: row.title,
  createdAt: row.createdAt,
  sourceKey: row.sourceKey,
  sourceUrl: row.sourceUrl,
  sourceState: row.sourceState,
  revision: row.revision,
  supersededBy: row.supersededBy,
  originConflict: row.conflict !== 0,
  planningStage: null,
});
export class FactoryWorkProjection extends Context.Service<
  FactoryWorkProjection,
  {
    readonly list: (
      environmentId: EnvironmentId,
      input: FactoryWorkListInput,
    ) => Effect.Effect<
      Omit<FactoryWorkListResult, "environmentId" | "fetchedAt">,
      FactoryWorkError
    >;
    readonly read: (
      environmentId: EnvironmentId,
      input: FactoryWorkReadInput,
    ) => Effect.Effect<Omit<FactoryWorkReadResult, "fetchedAt">, FactoryWorkError>;
    readonly history: (
      environmentId: EnvironmentId,
      input: FactoryWorkHistoryInput,
    ) => Effect.Effect<Omit<FactoryWorkHistoryResult, "fetchedAt">, FactoryWorkError>;
  }
>()("t3/persistence/FactoryWorkProjection") {}

const launchMetadata = `l.thread_id, l.superseded, l.accepted,
  ${json("l.intent_json", "projectId")} AS projectId,
  ${json("l.intent_json", "createdAt")} AS createdAt,
  ${json("l.intent_json", "role")} AS role`;
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const launchesFor = (reference: FactoryWorkRef) => {
    const table = reference.kind === "issue" ? "factory_issue_launches" : "factory_feed_launches";
    return reference.kind === "issue" || reference.kind === "feed"
      ? sql`WITH RECURSIVE chain AS (
          SELECT thread_id FROM ${sql.literal(table)} WHERE thread_id = ${reference.id}
          UNION ALL SELECT l.thread_id FROM ${sql.literal(table)} l
          JOIN chain p ON ${sql.literal(json("l.intent_json", "previousThreadId"))} = p.thread_id
        ), launches AS (
          SELECT ${sql.literal(launchMetadata)} FROM ${sql.literal(table)} l JOIN chain c ON c.thread_id = l.thread_id
        )`
      : reference.kind === "brief"
        ? sql`WITH launches AS (SELECT ${sql.literal(launchMetadata)} FROM factory_knowledge_launches l WHERE l.brief_id = ${reference.id})`
        : sql`WITH launches AS (SELECT ${sql.literal(launchMetadata)} FROM factory_research_launches l WHERE l.protocol_id = ${reference.id})`;
  };
  const loadRow = Effect.fn("FactoryWorkProjection.loadRow")(function* (
    input: FactoryWorkReadInput,
    includeSnapshot: boolean,
  ) {
    const columns = includeSnapshot
      ? rowColumns
      : `kind, id, projectId, title, createdAt, sourceKey, sourceUrl, sourceState, revision,
      supersededBy, conflict, NULL AS planningStage, '' AS snapshot, 0 AS snapshotTruncated`;
    const rows = yield* decodeRows(
      yield* sql`WITH ${sql.literal(collection)}
      SELECT ${sql.literal(columns)} FROM work WHERE kind = ${input.ref.kind} AND id = ${input.ref.id} LIMIT 1`,
    );
    if (!rows[0]) return yield* new FactoryWorkError({ reason: "missing-work" });
    return rows[0];
  });
  const list = Effect.fn("FactoryWorkProjection.list")(function* (
    environmentId: EnvironmentId,
    input: FactoryWorkListInput,
  ) {
    const projects = input.projectIds === undefined ? null : [...new Set(input.projectIds)].sort();
    const scope = encodeListScope([environmentId, projects, input.kind ?? null]);
    const cursor = yield* pageCursor(input.cursor, scope);
    const limit = input.limit ?? 25;
    const pages = keyBranches
      .filter((branch) => input.kind === undefined || branch.kind === input.kind)
      .map(
        (branch) =>
          sql`SELECT * FROM (${sql.literal(branch.query)}
        AND ${projects === null ? sql.literal("1") : projects.length === 0 ? sql.literal("0") : sql.in("projectId", projects)}
        AND createdAt >= ${cursor?.order ?? ""}
        AND (createdAt > ${cursor?.order ?? ""} OR ${branch.kind + ":"} || id > ${cursor?.id ?? ""})
        ORDER BY createdAt, id LIMIT ${limit + 1})`,
      );
    const rows = yield* decodeKeys(
      yield* sql`SELECT kind, id, createdAt FROM (${Statement.join(" UNION ALL ")(pages)})
      ORDER BY createdAt, kind || ':' || id LIMIT ${limit + 1}`,
    );
    const retained = rows.slice(0, limit);
    const last = retained.at(-1);
    const items = yield* Effect.forEach(retained, (row) =>
      loadRow(
        {
          ref: { version: 1, environmentId, kind: row.kind, id: row.id },
        },
        false,
      ).pipe(Effect.map((value) => summary(value, environmentId))),
    );
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              version: 1,
              scope,
              order: last.createdAt,
              id: `${last.kind}:${last.id}`,
            })
          : null,
    };
  }, Effect.mapError(failure));
  const read = Effect.fn("FactoryWorkProjection.read")(function* (
    environmentId: EnvironmentId,
    input: FactoryWorkReadInput,
  ) {
    const row = yield* loadRow(input, true);
    const current =
      input.ref.kind === "issue" || input.ref.kind === "feed"
        ? yield* decodeExecutionOwner(
            yield* sql`${launchesFor(input.ref)}
          SELECT thread_id AS threadId, projectId FROM launches WHERE superseded = 0 LIMIT 2`,
          )
        : null;
    const reviewOwner = current?.length === 1 ? current[0] : null;
    const reviewProjectId = current === null ? row.projectId : (reviewOwner?.projectId ?? null);
    const reviewThreadId = reviewOwner?.threadId ?? row.id;
    const owners = yield* sql<{
      readonly available: number;
      readonly coordinator: string | null;
      readonly supersedes: string | null;
    }>`
      SELECT EXISTS(SELECT 1 FROM projection_projects WHERE project_id = ${row.projectId} AND deleted_at IS NULL) AS available,
        (SELECT thread_id FROM project_coordinators WHERE project_id = ${row.projectId} AND superseded = 0 LIMIT 1) AS coordinator,
        (SELECT id FROM factory_knowledge_briefs WHERE superseded_by = ${row.id} AND ${row.kind} = 'brief' LIMIT 1) AS supersedes`;
    const owner = owners[0];
    const nativeTarget =
      input.ref.kind === "issue"
        ? (yield* sql`SELECT 'issue' AS kind, issue_number AS issueNumber FROM factory_issue_launches WHERE thread_id = ${reviewThreadId}`)[0]
        : input.ref.kind === "feed"
          ? (yield* sql`SELECT 'feed' AS kind, source_id AS sourceId, item_key AS itemKey FROM factory_feed_launches WHERE thread_id = ${reviewThreadId}`)[0]
          : input.ref.kind === "brief"
            ? { kind: "brief", briefId: row.id }
            : { kind: "protocol", protocolId: row.id };
    const reviewTarget = yield* decodeReviewTarget(nativeTarget);
    return {
      item: summary(row, environmentId),
      snapshot: row.snapshot,
      snapshotTruncated: row.snapshotTruncated !== 0,
      projectAvailable: owner?.available === 1,
      reviewProjectId,
      projectCoordinatorThreadId:
        owner?.coordinator === null || owner?.coordinator === undefined
          ? null
          : ThreadId.make(owner.coordinator),
      supersedes: owner?.supersedes ?? null,
      reviewTarget,
    };
  }, Effect.mapError(failure));

  const history = Effect.fn("FactoryWorkProjection.history")(function* (
    environmentId: EnvironmentId,
    input: FactoryWorkHistoryInput,
  ) {
    yield* loadRow({ ref: input.ref }, false);
    const scope = encodeHistoryScope([
      environmentId,
      input.ref.kind,
      input.ref.id,
      input.section,
      input.threadId ?? null,
      input.runId ?? null,
    ]);
    const cursor = yield* pageCursor(input.cursor, scope);
    const limit = input.limit ?? 25;
    const launches = launchesFor(input.ref);
    if (input.section !== "executions") {
      if (!input.threadId) return yield* new FactoryWorkError({ reason: "invalid-history" });
      const member =
        yield* sql`${launches} SELECT thread_id FROM launches WHERE thread_id = ${input.threadId} LIMIT 1`;
      if (member.length === 0) return yield* new FactoryWorkError({ reason: "invalid-history" });
    }
    if (input.section === "attempts") {
      const run =
        yield* sql`SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ${input.threadId ?? null} AND run_id = ${input.runId ?? null} LIMIT 1`;
      if (run.length === 0) return yield* new FactoryWorkError({ reason: "invalid-history" });
    }
    const entries =
      input.section === "executions"
        ? sql`${launches} SELECT l.thread_id AS id, l.thread_id AS threadId, NULL AS runId,
          substr(COALESCE(l.role, 'execution'), 1, 512) AS label,
          CASE WHEN t.thread_id IS NULL OR t.deleted_at IS NOT NULL THEN CASE WHEN l.accepted = 0 THEN 'reserved or missing' ELSE 'missing' END
            ELSE COALESCE((SELECT status FROM orchestration_v2_projection_runs WHERE thread_id = l.thread_id ORDER BY ordinal DESC LIMIT 1), 'idle') END AS state,
          NULL AS pin, l.superseded, COALESCE(l.createdAt, '') AS orderKey FROM launches l LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = l.thread_id`
        : input.section === "runs"
          ? sql`SELECT run_id AS id, thread_id AS threadId, run_id AS runId, 'run ' || ordinal AS label, status AS state, NULL AS pin, 0 AS superseded, printf('%020d', ordinal) AS orderKey
            FROM orchestration_v2_projection_runs WHERE thread_id = ${input.threadId ?? null}`
          : input.section === "attempts"
            ? sql`SELECT attempt_id AS id, thread_id AS threadId, run_id AS runId, 'attempt ' || attempt_ordinal AS label, status AS state, NULL AS pin, 0 AS superseded, printf('%020d', attempt_ordinal) AS orderKey
              FROM orchestration_v2_projection_run_attempts WHERE run_id = ${input.runId ?? null} AND thread_id = ${input.threadId ?? null}`
            : sql`SELECT 'commit:' || id AS id, thread_id AS threadId, NULL AS runId, 'commit acceptance pin' AS label, 'currentness not inspected' AS state, head_sha AS pin, superseded, accepted_at AS orderKey FROM factory_acceptances WHERE thread_id = ${input.threadId ?? null}
            UNION ALL SELECT 'artifact:' || id, thread_id, NULL, substr(artifact_path, 1, 512), 'artifact acceptance pin; currentness not inspected', sha256, superseded, accepted_at FROM factory_knowledge_acceptances WHERE thread_id = ${input.threadId ?? null}
            UNION ALL SELECT 'delivery:' || id, thread_id, NULL, kind, status, payload_digest, 0, granted_at FROM factory_delivery_intents WHERE thread_id = ${input.threadId ?? null}
            UNION ALL SELECT 'research:' || path || ':' || line, thread_id, NULL, substr(path, 1, 512), retention, sha256, 0, '' FROM factory_research_artifacts WHERE thread_id = ${input.threadId ?? null}`;
    const raw =
      yield* sql`SELECT * FROM (${entries}) WHERE orderKey > ${cursor?.order ?? ""} OR (orderKey = ${cursor?.order ?? ""} AND id > ${cursor?.id ?? ""}) ORDER BY orderKey, id LIMIT ${limit + 1}`;
    const rows = yield* decodeHistory(raw);
    const retained = rows.slice(0, limit);
    const last = retained.at(-1);
    return {
      entries: retained.map(({ orderKey: _orderKey, ...row }) => ({
        ...row,
        superseded: row.superseded !== 0,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ version: 1, scope, order: last.orderKey, id: last.id })
          : null,
    };
  }, Effect.mapError(failure));
  return FactoryWorkProjection.of({ list, read, history });
});
export const layer = Layer.effect(FactoryWorkProjection, make);
