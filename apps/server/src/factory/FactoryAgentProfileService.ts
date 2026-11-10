import type {
  FactoryAgentProfileDeleteInput,
  FactoryAgentProfileListResult,
  FactoryAgentProfileMutationResult,
  FactoryAgentProfileSaveInput,
  FactoryTaskError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";

export class FactoryAgentProfileService extends Context.Service<
  FactoryAgentProfileService,
  {
    readonly list: () => Effect.Effect<FactoryAgentProfileListResult, FactoryTaskError>;
    readonly save: (
      input: FactoryAgentProfileSaveInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryAgentProfileMutationResult, FactoryTaskError>;
    readonly delete: (
      input: FactoryAgentProfileDeleteInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryAgentProfileMutationResult, FactoryTaskError>;
  }
>()("t3/factory/FactoryAgentProfileService") {}
