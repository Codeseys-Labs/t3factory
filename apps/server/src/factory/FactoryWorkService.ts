import {
  FactoryWorkError,
  type FactoryWorkListInput,
  type FactoryWorkListResult,
  type FactoryWorkReadInput,
  type FactoryWorkReadResult,
  type FactoryWorkHistoryInput,
  type FactoryWorkHistoryResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Projection from "../persistence/FactoryWorkProjection.ts";

export class FactoryWorkService extends Context.Service<
  FactoryWorkService,
  {
    readonly list: (
      input: FactoryWorkListInput,
    ) => Effect.Effect<FactoryWorkListResult, FactoryWorkError>;
    readonly read: (
      input: FactoryWorkReadInput,
    ) => Effect.Effect<FactoryWorkReadResult, FactoryWorkError>;
    readonly history: (
      input: FactoryWorkHistoryInput,
    ) => Effect.Effect<FactoryWorkHistoryResult, FactoryWorkError>;
  }
>()("t3/factory/FactoryWorkService") {}
const make = Effect.gen(function* () {
  const projection = yield* Projection.FactoryWorkProjection;
  const identity = yield* ServerEnvironmentIdentity;
  const list = Effect.fn("FactoryWorkService.list")(function* (input: FactoryWorkListInput) {
    const environmentId = yield* identity.getEnvironmentId;
    return {
      ...(yield* projection.list(environmentId, input)),
      environmentId,
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });
  const read = Effect.fn("FactoryWorkService.read")(function* (input: FactoryWorkReadInput) {
    const environmentId = yield* identity.getEnvironmentId;
    if (input.ref.environmentId !== environmentId)
      return yield* new FactoryWorkError({ reason: "wrong-environment" });
    return {
      ...(yield* projection.read(environmentId, input)),
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });
  const history = Effect.fn("FactoryWorkService.history")(function* (
    input: FactoryWorkHistoryInput,
  ) {
    const environmentId = yield* identity.getEnvironmentId;
    if (input.ref.environmentId !== environmentId)
      return yield* new FactoryWorkError({ reason: "wrong-environment" });
    return {
      ...(yield* projection.history(environmentId, input)),
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });
  return FactoryWorkService.of({ list, read, history });
});
export const layer = Layer.effect(FactoryWorkService, make).pipe(Layer.provide(Projection.layer));
