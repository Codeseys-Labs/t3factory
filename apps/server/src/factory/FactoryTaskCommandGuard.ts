import { CommandId, FactoryTaskError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tasks from "../persistence/FactoryTaskStore.ts";
import { executionDigest } from "./FactoryExecutionDigest.ts";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";

interface Execution {
  readonly permit: Semaphore.Semaphore;
  holders: number;
}

/** The executions this fiber runs inside; a nested command under one of their ids is already in. */
const Holding = Context.Reference<ReadonlySet<Execution>>(
  "t3/factory/FactoryTaskCommandGuard/Holding",
  { defaultValue: () => new Set() },
);

/** Where an unfinished run command pins its input, holding its id until its receipt. */
export const inputPin = (commandId: CommandId) => CommandId.make(`factory-task:input:${commandId}`);

/** Task and agent-profile commands share one receipt table, so they share this guard. */
export class FactoryTaskCommandGuard extends Context.Service<
  FactoryTaskCommandGuard,
  {
    /**
     * Runs `effect` as the only execution of `commandId`; another waits until it ends. The wait
     * happens outside any transaction and any other execution; a command nested under the same id
     * passes through.
     */
    readonly run: <A, E, R>(
      commandId: CommandId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** A command id answers once: the same input replays, a different one conflicts. */
    readonly begin: (
      kind: string,
      commandId: CommandId,
      actor: FactoryPlanActor,
      input: unknown,
    ) => Effect.Effect<
      {
        readonly digest: string;
        readonly replayed: boolean;
        readonly outcome: unknown;
        readonly record: (outcome: unknown) => Effect.Effect<void, FactoryTaskError>;
      },
      FactoryTaskError
    >;
    /** How many command ids are held or waited for now. */
    readonly pending: Effect.Effect<number>;
  }
>()("t3/factory/FactoryTaskCommandGuard") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Tasks.FactoryTaskStore;
  // An entry lives while anyone holds or waits for its permit.
  const executing = new Map<CommandId, Execution>();

  const run: FactoryTaskCommandGuard["Service"]["run"] = (commandId, effect) =>
    Effect.withFiber((fiber) => {
      const holding = fiber.getRef(Holding);
      const current = executing.get(commandId);
      if (current !== undefined && holding.has(current)) return effect;
      // The holder may need the database to finish; a waiter inside a transaction would keep it.
      if (Context.getOrUndefined(fiber.context, sql.transactionService) !== undefined)
        return Effect.die(new Error("A task command waited for its id inside a transaction."));
      // Two executions each waiting for the other's id would never end.
      if (holding.size > 0)
        return Effect.die(new Error("A task command waited for an id inside another's execution."));
      return Effect.acquireUseRelease(
        Effect.sync(() => {
          const execution = executing.get(commandId) ?? {
            permit: Semaphore.makeUnsafe(1),
            holders: 0,
          };
          execution.holders += 1;
          executing.set(commandId, execution);
          return execution;
        }),
        (execution) =>
          execution.permit.withPermit(
            Effect.provideService(effect, Holding, new Set([...holding, execution])),
          ),
        (execution) =>
          Effect.sync(() => {
            execution.holders -= 1;
            if (execution.holders === 0) executing.delete(commandId);
          }),
      );
    });

  const begin = Effect.fn("FactoryTaskCommandGuard.begin")(function* (
    kind: string,
    commandId: CommandId,
    actor: FactoryPlanActor,
    input: unknown,
  ) {
    const current = executing.get(commandId);
    if (current === undefined || !(yield* Holding).has(current))
      return yield* Effect.die(new Error("A task command began outside its execution."));
    const digest = executionDigest([kind, actor, input]);
    const existing = yield* store.receipt(commandId);
    if (existing !== null && (existing.kind !== kind || existing.digest !== digest))
      return yield* new FactoryTaskError({ reason: "command-conflict" });
    if (existing === null) {
      // An unfinished run command holds its id through its input pin, against every kind of command.
      const pin = yield* store.receipt(inputPin(commandId));
      if (pin !== null && (pin.kind !== kind || pin.digest !== digest))
        return yield* new FactoryTaskError({ reason: "command-conflict" });
    }
    return {
      digest,
      replayed: existing !== null,
      outcome: existing?.outcome,
      record: (outcome: unknown) => store.recordReceipt({ commandId, kind, digest, outcome }),
    };
  });

  return FactoryTaskCommandGuard.of({
    run,
    begin,
    pending: Effect.sync(() => executing.size),
  });
});

export const layer = Layer.effect(FactoryTaskCommandGuard, make).pipe(Layer.provide(Tasks.layer));
