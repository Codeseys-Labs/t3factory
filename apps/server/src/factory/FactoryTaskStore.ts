import {
  FactoryArtifact,
  FactoryAttempt,
  FactoryNote,
  FactoryOrchestrator,
  FactoryReceipt,
  FactoryTask,
  IsoDateTime,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KeyValues, layerKeyValues } from "../workflows/stepServices.ts";

const PREFIX = "factory/v1/";
const StoredOrchestrator = Schema.Struct({
  v: Schema.Literal(1),
  threadId: FactoryOrchestrator.fields.threadId,
});
const FactoryTarget = Schema.Struct({
  v: Schema.Literal(1),
  projectId: Schema.NullOr(Schema.String),
  workspace: Schema.Literals(["worktree", "root", "scratch"]),
  workspaceRoot: Schema.NullOr(Schema.String),
  problem: Schema.NullOr(Schema.String),
  checkedAt: IsoDateTime,
});
const decodeArtifact = Schema.decodeOption(Schema.fromJsonString(FactoryArtifact));
const decodeReceipt = Schema.decodeOption(Schema.fromJsonString(FactoryReceipt));
const EVIDENCE_LIMIT = 200;

export const make = Effect.gen(function* () {
  const keyValues = yield* KeyValues;
  const sql = yield* SqlClient.SqlClient;

  const records = <A, I>(path: string, schema: Schema.Codec<A, I>) => {
    const prefix = `${PREFIX}${path}`;
    const codec = Schema.fromJsonString(Schema.toCodecJson(schema));
    const decode = Schema.decodeOption(codec);
    const encode = Schema.encodeEffect(codec);
    return {
      get: Effect.fn("FactoryTaskStore.get")(function* (id: string) {
        const text = yield* keyValues.get(`${prefix}${id}`);
        return text === undefined ? undefined : Option.getOrUndefined(decode(text));
      }),
      set: Effect.fn("FactoryTaskStore.set")(function* (id: string, value: A) {
        const text = yield* encode(value).pipe(Effect.orDie);
        yield* keyValues.set(`${prefix}${id}`, text);
      }),
      delete: Effect.fn("FactoryTaskStore.delete")(function* (id: string) {
        yield* keyValues.delete(`${prefix}${id}`);
      }),
      list: Effect.fn("FactoryTaskStore.list")(function* (suffix = "") {
        const rows = yield* keyValues.list(`${prefix}${suffix}`);
        const items: Array<{ readonly id: string; readonly value: A }> = [];
        let damaged = 0;
        for (const row of rows) {
          const decoded = decode(row.valueJson);
          if (Option.isNone(decoded)) {
            damaged++;
          } else {
            items.push({ id: row.key.slice(prefix.length), value: decoded.value });
          }
        }
        return { items, damaged };
      }),
    };
  };

  const tasks = records("task/", FactoryTask);
  const attempts = records("attempt/", FactoryAttempt);
  const notes = records("note/", FactoryNote);
  const orchestrators = records("orchestrator/", StoredOrchestrator);
  const targets = records("target/", FactoryTarget);
  const sequenceCodec = Schema.fromJsonString(NonNegativeInt);
  const decodeSequence = Schema.decodeOption(sequenceCodec);
  const encodeSequence = Schema.encodeEffect(sequenceCodec);
  const decodeOrchestrator = Schema.decodeUnknownOption(FactoryOrchestrator);

  const listEvidence = <A extends { readonly taskId: string }>(
    group: "artifact" | "receipt",
    decode: (text: string) => Option.Option<A>,
  ) =>
    Effect.fn("FactoryTaskStore.listEvidence")(function* (taskId: string) {
      const prefix = `${PREFIX}${group}/${taskId}/`;
      const values: Array<A> = [];
      for (let offset = 0; values.length < EVIDENCE_LIMIT; offset += EVIDENCE_LIMIT) {
        const rows = yield* sql<{ value_json: string }>`
          SELECT value_json FROM workflow_store
          WHERE key >= ${prefix} AND key < ${`${prefix}\u{10FFFF}`} AND json_valid(value_json)
          ORDER BY json_extract(value_json, '$.at') DESC, key DESC
          LIMIT ${EVIDENCE_LIMIT} OFFSET ${offset}
        `.pipe(Effect.orDie);
        for (const row of rows) {
          const value = decode(row.value_json);
          if (Option.isSome(value) && value.value.taskId === taskId) values.push(value.value);
          if (values.length === EVIDENCE_LIMIT) break;
        }
        if (rows.length < EVIDENCE_LIMIT) break;
      }
      return values.reverse();
    });

  return {
    tasks,
    attempts,
    notes,
    orchestrators,
    readTarget: (projectId: string | null) => targets.get(projectId ?? "scratch"),
    writeTarget: (projectId: string | null, target: typeof FactoryTarget.Type) =>
      targets.set(projectId ?? "scratch", target),
    listArtifacts: listEvidence("artifact", decodeArtifact),
    listReceipts: listEvidence("receipt", decodeReceipt),
    sequence: Effect.gen(function* () {
      const text = yield* keyValues.get(`${PREFIX}seq`);
      if (text === undefined) return 0;
      const decoded = decodeSequence(text);
      if (Option.isSome(decoded)) return decoded.value;
      let highest = 0;
      for (const { value } of (yield* tasks.list()).items) {
        highest = Math.max(highest, value.number);
      }
      return highest;
    }),
    setSequence: Effect.fn("FactoryTaskStore.setSequence")(function* (number: number) {
      const text = yield* encodeSequence(number).pipe(Effect.orDie);
      yield* keyValues.set(`${PREFIX}seq`, text);
    }),
    listOrchestrators: Effect.fn("FactoryTaskStore.listOrchestrators")(function* () {
      const rows = yield* orchestrators.list();
      const items: Array<FactoryOrchestrator> = [];
      let damaged = rows.damaged;
      for (const row of rows.items) {
        const decoded = decodeOrchestrator({ projectId: row.id, threadId: row.value.threadId });
        if (Option.isNone(decoded)) {
          damaged++;
        } else {
          items.push(decoded.value);
        }
      }
      return { items, damaged };
    }),
    watermark: Effect.gen(function* () {
      const rows = yield* sql<{
        readonly count: number;
        readonly updatedAt: string | null;
        readonly totalLength: number;
      }>`
        SELECT COUNT(*) AS count, MAX(updated_at) AS updatedAt,
          COALESCE(SUM(LENGTH(value_json)), 0) AS totalLength
        FROM workflow_store
        WHERE key >= ${PREFIX} AND key < ${`${PREFIX}\u{10FFFF}`}
      `;
      return rows[0] ?? { count: 0, updatedAt: null, totalLength: 0 };
    }),
    transaction: keyValues.transaction,
  };
}).pipe(Effect.provide(layerKeyValues));
