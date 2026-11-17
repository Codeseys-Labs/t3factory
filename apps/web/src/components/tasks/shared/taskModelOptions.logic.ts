import type { FactoryAgentSetup, ProviderOptionSelection } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../../providerInstances";
import { resolveComposerTraitsInput } from "../../chat/composerProviderState";

/** The setup with these options on its model, or on the provider's defaults when there are none. */
export function withModelOptions(
  setup: FactoryAgentSetup,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): FactoryAgentSetup {
  const { options: _chosen, ...selection } = setup.modelSelection;
  return {
    ...setup,
    modelSelection: options && options.length > 0 ? { ...selection, options } : selection,
  };
}

export const hasChosenOptions = (setup: FactoryAgentSetup | null): boolean =>
  (setup?.modelSelection.options?.length ?? 0) > 0;

/**
 * What the composer's option controls need to offer a pinned model's options: the same rules as a
 * thread, with a pick handed to `onChange` instead of a draft. Null when the model's harness is
 * not in the catalog.
 */
export function taskTraitsInput(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  setup: FactoryAgentSetup,
  onChange: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void,
) {
  const { instanceId, model, options } = setup.modelSelection;
  const entry = entries.find((candidate) => candidate.instanceId === instanceId);
  if (!entry) return null;
  return resolveComposerTraitsInput({
    provider: entry.driverKind,
    instanceId,
    model,
    models: entry.models,
    modelOptions: options,
    promptUltrathink: "none",
    onPromptEdit: () => {},
    onModelOptionsChange: onChange,
  });
}
