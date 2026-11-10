import type {
  FactoryIntakeArrivalListInput,
  FactoryIntakeArrivalListResult,
  FactoryIntakeArrivalResolveInput,
  FactoryIntakeArrivalResolveResult,
  FactoryIntakeChange,
  FactoryIntakeError,
  FactoryIntakeRuleDeleteInput,
  FactoryIntakeRuleListResult,
  FactoryIntakeRuleMutationResult,
  FactoryIntakeRulePreviewInput,
  FactoryIntakeRulePreviewResult,
  FactoryIntakeRuleSaveInput,
  FactoryIntakeSourceDeleteInput,
  FactoryIntakeSourceListInput,
  FactoryIntakeSourceListResult,
  FactoryIntakeSourceMutationResult,
  FactoryIntakeSourceSaveInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";

export class FactoryIntakeService extends Context.Service<
  FactoryIntakeService,
  {
    readonly listSources: (
      input: FactoryIntakeSourceListInput,
    ) => Effect.Effect<FactoryIntakeSourceListResult, FactoryIntakeError>;
    readonly saveSource: (
      input: FactoryIntakeSourceSaveInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryIntakeSourceMutationResult, FactoryIntakeError>;
    readonly deleteSource: (
      input: FactoryIntakeSourceDeleteInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryIntakeSourceMutationResult, FactoryIntakeError>;
    readonly listRules: () => Effect.Effect<FactoryIntakeRuleListResult, FactoryIntakeError>;
    readonly saveRule: (
      input: FactoryIntakeRuleSaveInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryIntakeRuleMutationResult, FactoryIntakeError>;
    readonly deleteRule: (
      input: FactoryIntakeRuleDeleteInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryIntakeRuleMutationResult, FactoryIntakeError>;
    readonly previewRule: (
      input: FactoryIntakeRulePreviewInput,
    ) => Effect.Effect<FactoryIntakeRulePreviewResult, FactoryIntakeError>;
    readonly listArrivals: (
      input: FactoryIntakeArrivalListInput,
    ) => Effect.Effect<FactoryIntakeArrivalListResult, FactoryIntakeError>;
    readonly resolveArrival: (
      input: FactoryIntakeArrivalResolveInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryIntakeArrivalResolveResult, FactoryIntakeError>;
    /** One element per committed change. Never replays the past. */
    readonly changes: Stream.Stream<FactoryIntakeChange>;
  }
>()("t3/factory/FactoryIntakeService") {}
