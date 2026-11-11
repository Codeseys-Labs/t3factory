import { useAtomValue } from "@effect/atom-react";
import type { FactoryTaskCatalog } from "@t3tools/client-runtime/state/factory-task-view";
import type { EnvironmentId } from "@t3tools/contracts";

import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../../state/server";

/** One environment's providers and models, for turning a setup into `Codex · Sol`. */
export function useTaskCatalog(environmentId: EnvironmentId): FactoryTaskCatalog {
  return (
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS
  );
}
