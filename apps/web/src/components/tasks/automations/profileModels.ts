import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  RuntimeMode,
} from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../../modelSelection";
import { getProviderModelCapabilities } from "../../../providerModels";
import {
  isProviderInstancePickerVisible,
  providerInstanceEntriesFor,
} from "../../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../../state/server";
import { resolveCompatibleRuntimeMode } from "../../chat/runtimeModeConfig";

interface ProfileEffort {
  readonly id: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly defaultId: string | null;
}
interface ProfileHarness {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly runtimeModes: readonly RuntimeMode[];
  readonly models: readonly {
    readonly slug: string;
    readonly label: string;
    readonly effort: ProfileEffort | null;
  }[];
}

// The option ids providers use for how hard a model thinks.
const EFFORT_OPTION_IDS: readonly string[] = ["effort", "reasoningEffort", "reasoning", "variant"];

/** The harnesses, models and efforts the stock model picker offers on one environment. */
export function useProfileHarnesses(
  environmentId: EnvironmentId,
  selection: ModelSelection | null,
): readonly ProfileHarness[] {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId ?? null,
    selection?.model ?? null,
  );
  return providerInstanceEntriesFor(providers, settings, null)
    .filter(isProviderInstancePickerVisible)
    .map((entry) => ({
      instanceId: entry.instanceId,
      label: entry.displayName,
      runtimeModes: resolveCompatibleRuntimeMode(
        "approval-required",
        entry.snapshot.supportedRuntimeModes,
      ).modes,
      models: (modelOptions.get(entry.instanceId) ?? []).map((model) => {
        const descriptor = getProviderModelCapabilities(
          entry.models,
          model.slug,
          entry.driverKind,
        ).optionDescriptors?.find(
          (candidate) => candidate.type === "select" && EFFORT_OPTION_IDS.includes(candidate.id),
        );
        return {
          slug: model.slug,
          label: model.name,
          effort:
            descriptor?.type === "select"
              ? {
                  id: descriptor.id,
                  options: descriptor.options.map(({ id, label }) => ({ id, label })),
                  defaultId:
                    descriptor.currentValue ??
                    descriptor.options.find((option) => option.isDefault)?.id ??
                    null,
                }
              : null,
        };
      }),
    }));
}
