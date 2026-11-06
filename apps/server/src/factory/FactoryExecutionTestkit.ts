import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FactoryExecutionLifecycle from "./FactoryExecutionLifecycle.ts";
import * as FactoryExecutionService from "./FactoryExecutionService.ts";
import * as FactoryPreparationAcceptanceService from "./FactoryPreparationAcceptanceService.ts";

type LifecycleService = FactoryExecutionLifecycle.FactoryExecutionLifecycle["Service"];

const unmanagedRunPhase = Effect.fn("FactoryExecutionTestkit.runPhase")(function <A, E, R>(
  _input: Parameters<LifecycleService["runPhase"]>[0],
  work: Effect.Effect<A, E, R>,
) {
  return work;
});

/**
 * No thread is factory-managed in these tests: every native path keeps its
 * original behavior and a managed admission never exists.
 */
export const layerUnmanagedExecutionLifecycle = Layer.succeed(
  FactoryExecutionLifecycle.FactoryExecutionLifecycle,
  FactoryExecutionLifecycle.FactoryExecutionLifecycle.of({
    binding: Effect.fn("FactoryExecutionTestkit.binding")(() => Effect.succeed(null)),
    guardCommand: Effect.fn("FactoryExecutionTestkit.guardCommand")(
      (): Effect.Effect<void, never> => Effect.void,
    ),
    runPhase: unmanagedRunPhase as LifecycleService["runPhase"],
    respond: Effect.fn("FactoryExecutionTestkit.respond")((_input, work) => work),
    recover: Effect.fn("FactoryExecutionTestkit.recover")(() => Effect.void),
    stop: Effect.fn("FactoryExecutionTestkit.stop")(() => Effect.succeed(true)),
    quiesce: Effect.fn("FactoryExecutionTestkit.quiesce")(() => Effect.succeed(true)),
    complete: Effect.fn("FactoryExecutionTestkit.complete")(() => Effect.succeed(true)),
  }),
);

export const layerExecutionServiceMock = Layer.mock(
  FactoryExecutionService.FactoryExecutionService,
)({});

export const layerPreparationAcceptanceMock = Layer.mock(
  FactoryPreparationAcceptanceService.FactoryPreparationAcceptanceService,
  {},
);
