import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { useEnvironmentSettings } from "../../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
} from "../../../modelSelection";
import { providerInstanceEntriesFor } from "../../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../../state/server";

/** The harnesses and models a person can pin a task to, as the stock model picker lists them. */
export function useTaskModelChoices(environmentId: EnvironmentId, projectId: ProjectId) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, projectId);
  return {
    instanceEntries,
    modelOptionsByInstance: getCustomModelOptionsByInstance(settings, providers),
    normalize: (selection: ModelSelection) =>
      resolveEffectiveDefaultModelSelection(settings, providers, selection),
  };
}

/** The project's Default permissions setting: the mode of a run nobody chose one for. */
export function useTaskDefaultRuntimeMode(environmentId: EnvironmentId, projectId: ProjectId) {
  return resolveProjectSettings(useEnvironmentSettings(environmentId), projectId).settings
    .defaultRuntimeMode;
}
