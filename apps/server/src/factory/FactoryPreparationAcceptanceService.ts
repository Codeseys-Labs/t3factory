import {
  FactoryExecutionError,
  FactoryPreparationAcceptInput,
  FactoryPreparationReopenInput,
  FactoryExecutionReadInput,
  type FactoryExecutionMutationResult,
  type FactoryPreparationHistoryResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "../persistence/FactoryExecutionStore.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";
import { executionDigest } from "./FactoryExecutionDigest.ts";
import * as Processes from "../processRunner.ts";

const decodeAccept = Schema.decodeEffect(FactoryPreparationAcceptInput);
const decodeReopen = Schema.decodeEffect(FactoryPreparationReopenInput);
const decodeRead = Schema.decodeEffect(FactoryExecutionReadInput);
export class FactoryPreparationAcceptanceService extends Context.Service<
  FactoryPreparationAcceptanceService,
  {
    readonly accept: (
      input: FactoryPreparationAcceptInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryExecutionMutationResult, FactoryExecutionError>;
    readonly reopen: (
      input: FactoryPreparationReopenInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryExecutionMutationResult, FactoryExecutionError>;
    readonly read: (
      input: FactoryExecutionReadInput,
    ) => Effect.Effect<FactoryPreparationHistoryResult, FactoryExecutionError>;
  }
>()("t3/factory/FactoryPreparationAcceptanceService") {}

const make = Effect.gen(function* () {
  const store = yield* Store.FactoryExecutionStore;
  const sink = yield* Sink.EventSinkV2;
  const identity = yield* ServerEnvironmentIdentity;
  const sql = yield* SqlClient.SqlClient;
  const processes = yield* Processes.ProcessRunner;
  const mutate = Effect.fn("FactoryPreparationAcceptanceService.mutate")(function* (
    operation: Extract<Store.ExecutionOperation, { type: "accept" | "reopen" }>,
    actor: FactoryPlanActor,
  ) {
    if (actor.kind !== "human") return yield* new FactoryExecutionError({ reason: "forbidden" });
    const input = operation.input;
    if (input.selection.ref.environmentId !== (yield* identity.getEnvironmentId))
      return yield* new FactoryExecutionError({ reason: "wrong-environment" });
    if (operation.type === "accept") {
      const state = yield* store.readExecution({
        ref: input.selection.ref,
        revision: input.selection.revision,
      });
      if (state.assembly?.digest !== input.expectedDigest)
        return yield* new FactoryExecutionError({ reason: "task-conflict" });
      for (const output of state.assembly.outputs) {
        if (output.checkpoint === null) continue;
        const checkpoint = output.checkpoint;
        const rows = yield* sql<{
          cwd: string;
        }>`SELECT repository_path AS cwd FROM factory_execution_verifications WHERE digest = ${checkpoint.verificationDigest} AND attempt_id = ${output.runAttemptId}`.pipe(
          Effect.mapError(
            (cause) => new FactoryExecutionError({ reason: "persistence-failure", cause }),
          ),
        );
        if (!rows[0]) return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
        for (const [object, expected] of [
          [`${checkpoint.retainedRef}^{commit}`, checkpoint.commit],
          [`${checkpoint.commit}^{tree}`, checkpoint.tree],
        ]) {
          const observed = yield* processes
            .run({
              command: "git",
              args: ["rev-parse", "--verify", object!],
              cwd: rows[0].cwd,
              maxOutputBytes: 512,
              outputMode: "error",
            })
            .pipe(
              Effect.mapError(
                (cause) => new FactoryExecutionError({ reason: "prerequisite-held", cause }),
              ),
            );
          if (
            observed.code !== 0 ||
            observed.timedOut ||
            observed.stdoutInvalidUtf8 ||
            observed.stdout.trim() !== expected
          )
            return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
        }
      }
    }
    return yield* sink.commitFactoryExecutionCommand({
      command: {
        commandId: input.commandId,
        ref: input.selection.ref,
        revision: input.selection.revision,
        actor,
        digest: executionDigest([operation.type, actor, input]),
        now: DateTime.formatIso(yield* DateTime.now),
        operation,
      },
      events: [],
      effects: [],
    });
  });
  const invalid = (cause: unknown) => new FactoryExecutionError({ reason: "invalid-input", cause });
  return FactoryPreparationAcceptanceService.of({
    accept: Effect.fn("FactoryPreparationAcceptanceService.accept")(function* (raw, actor) {
      return yield* mutate(
        { type: "accept", input: yield* decodeAccept(raw).pipe(Effect.mapError(invalid)) },
        actor,
      );
    }),
    reopen: Effect.fn("FactoryPreparationAcceptanceService.reopen")(function* (raw, actor) {
      return yield* mutate(
        { type: "reopen", input: yield* decodeReopen(raw).pipe(Effect.mapError(invalid)) },
        actor,
      );
    }),
    read: Effect.fn("FactoryPreparationAcceptanceService.read")(function* (raw) {
      const input = yield* decodeRead(raw).pipe(Effect.mapError(invalid));
      if (input.ref.environmentId !== (yield* identity.getEnvironmentId))
        return yield* new FactoryExecutionError({ reason: "wrong-environment" });
      return yield* store.preparationHistory(input);
    }),
  });
});
export const layer = Layer.effect(FactoryPreparationAcceptanceService, make).pipe(
  Layer.provide(Store.layer),
);
