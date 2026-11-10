import {
  CommandId,
  FactoryTaskBreakdownInput,
  FactoryTaskError,
  FactoryTaskMutationResult,
  FactoryTaskPlanProposal,
  FactoryTaskPlanProposalMutationResult,
  MessageId,
  ThreadId,
  type FactoryTaskRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const BreakdownRequest = Schema.Struct({
  input: FactoryTaskBreakdownInput,
  threadId: ThreadId,
  messageId: MessageId,
  title: Schema.String,
  prompt: Schema.String,
  recorded: Schema.Boolean,
  open: Schema.Boolean,
});
export type BreakdownRequest = typeof BreakdownRequest.Type;
const Outcome = Schema.Union([FactoryTaskPlanProposalMutationResult, FactoryTaskMutationResult]);
type Outcome = typeof Outcome.Type;
const Receipt = Schema.Struct({
  digest: Schema.String,
  request: Schema.NullOr(BreakdownRequest),
  result: Schema.NullOr(Outcome),
});
type Receipt = typeof Receipt.Type;
const taskKey = (ref: FactoryTaskRef) =>
  JSON.stringify([ref.environmentId, ref.projectId, ref.rootId, ref.taskId]);

export class FactoryTaskProposalStore extends Context.Service<
  FactoryTaskProposalStore,
  {
    readonly request: (
      ref: FactoryTaskRef,
    ) => Effect.Effect<BreakdownRequest | null, FactoryTaskError>;
    readonly saveRequest: (request: BreakdownRequest) => Effect.Effect<void, FactoryTaskError>;
    readonly proposal: (
      ref: FactoryTaskRef,
      id?: string,
    ) => Effect.Effect<FactoryTaskPlanProposal | null, FactoryTaskError>;
    readonly saveProposal: (
      proposal: FactoryTaskPlanProposal,
    ) => Effect.Effect<void, FactoryTaskError>;
    readonly receipt: (id: CommandId) => Effect.Effect<Receipt | null, FactoryTaskError>;
    readonly saveReceipt: (
      id: CommandId,
      receipt: Receipt,
    ) => Effect.Effect<void, FactoryTaskError>;
  }
>()("t3/persistence/FactoryTaskProposalStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const failure = (cause: unknown) =>
    new FactoryTaskError({ reason: "persistence-failure", cause });
  const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(BreakdownRequest));
  const decodeProposal = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryTaskPlanProposal));
  const decodeOutcome = Schema.decodeUnknownEffect(Schema.fromJsonString(Outcome));
  const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(BreakdownRequest));
  const encodeProposal = Schema.encodeEffect(Schema.fromJsonString(FactoryTaskPlanProposal));
  const encodeOutcome = Schema.encodeEffect(Schema.fromJsonString(Outcome));
  return FactoryTaskProposalStore.of({
    request: Effect.fn("FactoryTaskProposalStore.request")(function* (ref) {
      const rows = yield* sql<{
        json: string;
      }>`SELECT request_json AS json FROM factory_task_breakdowns WHERE task_key = ${taskKey(ref)}`;
      return rows[0] === undefined ? null : yield* decodeRequest(rows[0].json);
    }, Effect.mapError(failure)),
    saveRequest: Effect.fn("FactoryTaskProposalStore.saveRequest")(function* (request) {
      const json = yield* encodeRequest(request);
      yield* sql`INSERT INTO factory_task_breakdowns(task_key, request_json) VALUES (${taskKey(request.input.ref)}, ${json}) ON CONFLICT(task_key) DO UPDATE SET request_json = excluded.request_json`;
    }, Effect.mapError(failure)),
    proposal: Effect.fn("FactoryTaskProposalStore.proposal")(function* (ref, id) {
      const rows =
        id === undefined
          ? yield* sql<{
              json: string;
            }>`SELECT proposal_json AS json FROM factory_task_proposals WHERE task_key = ${taskKey(ref)} AND status = 'proposed'`
          : yield* sql<{
              json: string;
            }>`SELECT proposal_json AS json FROM factory_task_proposals WHERE task_key = ${taskKey(ref)} AND proposal_id = ${id}`;
      return rows[0] === undefined ? null : yield* decodeProposal(rows[0].json);
    }, Effect.mapError(failure)),
    saveProposal: Effect.fn("FactoryTaskProposalStore.saveProposal")(function* (proposal) {
      const json = yield* encodeProposal(proposal);
      yield* sql`INSERT INTO factory_task_proposals(proposal_id, task_key, status, proposal_json) VALUES (${proposal.id}, ${taskKey(proposal.ref)}, ${proposal.status}, ${json}) ON CONFLICT(proposal_id) DO UPDATE SET status = excluded.status, proposal_json = excluded.proposal_json`;
    }, Effect.mapError(failure)),
    receipt: Effect.fn("FactoryTaskProposalStore.receipt")(function* (id) {
      const rows = yield* sql<{
        digest: string;
        request: string | null;
        result: string | null;
      }>`SELECT digest, request_json AS request, result_json AS result FROM factory_task_proposal_commands WHERE command_id = ${id}`;
      const row = rows[0];
      return row === undefined
        ? null
        : {
            digest: row.digest,
            request: row.request === null ? null : yield* decodeRequest(row.request),
            result: row.result === null ? null : yield* decodeOutcome(row.result),
          };
    }, Effect.mapError(failure)),
    saveReceipt: Effect.fn("FactoryTaskProposalStore.saveReceipt")(function* (id, receipt) {
      const request = receipt.request === null ? null : yield* encodeRequest(receipt.request);
      const result = receipt.result === null ? null : yield* encodeOutcome(receipt.result);
      yield* sql`INSERT INTO factory_task_proposal_commands(command_id, digest, request_json, result_json) VALUES (${id}, ${receipt.digest}, ${request}, ${result}) ON CONFLICT(command_id) DO UPDATE SET result_json = excluded.result_json`;
    }, Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(FactoryTaskProposalStore, make);
