import type {
  FactoryTaskBreakdownInput,
  FactoryTaskError,
  FactoryTaskMutationResult,
  FactoryTaskPlanProposalMutationResult,
  FactoryTaskPlanProposalReadInput,
  FactoryTaskPlanProposalReadResult,
  FactoryTaskPlanProposalResolveInput,
  FactoryTaskPlanProposalUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";

export class FactoryTaskPlanningService extends Context.Service<
  FactoryTaskPlanningService,
  {
    readonly requestBreakdown: (
      input: FactoryTaskBreakdownInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly readProposal: (
      input: FactoryTaskPlanProposalReadInput,
    ) => Effect.Effect<FactoryTaskPlanProposalReadResult, FactoryTaskError>;
    readonly updateProposal: (
      input: FactoryTaskPlanProposalUpdateInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskPlanProposalMutationResult, FactoryTaskError>;
    readonly resolveProposal: (
      input: FactoryTaskPlanProposalResolveInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskPlanProposalMutationResult, FactoryTaskError>;
  }
>()("t3/factory/FactoryTaskPlanningService") {}
