import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { createFactoryEnvironmentAtoms } from "@t3tools/client-runtime/state/factory";
import { createFactoryTaskEnvironmentAtoms } from "@t3tools/client-runtime/state/factory-tasks";
import { EnvironmentId, FactoryWorkListInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { use } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";

export const factoryEnvironment = createFactoryEnvironmentAtoms(connectionAtomRuntime);
export const factoryTaskEnvironment = createFactoryTaskEnvironmentAtoms(connectionAtomRuntime);

// Missing capability on an older server is unsupported, never an empty coordinator list.
export const factoryCoordinatorSupportedAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      environmentId !== null &&
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.projectCoordinators === true,
  ).pipe(Atom.withLabel(`mobile-factory-coordinators-supported:${environmentId}`)),
);

// An older server has no acceptance RPC; it must read as unsupported, not as "nothing accepted".
export const factoryAcceptanceSupportedAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      environmentId !== null &&
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryAcceptance === true,
  ).pipe(Atom.withLabel(`mobile-factory-acceptance-supported:${environmentId}`)),
);

// Publishing needs the delivery RPCs; an older server must hide the section, not show "no PRs".
export const factoryDeliverySupportedAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      environmentId !== null &&
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryDelivery === true,
  ).pipe(Atom.withLabel(`mobile-factory-delivery-supported:${environmentId}`)),
);

// Briefs need the knowledge RPCs; an older server must read as unsupported, not as "no briefs".
export const factoryKnowledgeSupportedAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      environmentId !== null &&
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryKnowledge === true,
  ).pipe(Atom.withLabel(`mobile-factory-knowledge-supported:${environmentId}`)),
);

const workPageTargets = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ environmentId: EnvironmentId, input: FactoryWorkListInput })),
);
// One subscription over every loaded page of every owner, so the list reads one consistent set.
const factoryWorkPagesAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    Schema.decodeSync(workPageTargets)(key).map((target) => ({
      environmentId: target.environmentId,
      result: get(factoryEnvironment.listWork(target)),
    })),
  ).pipe(Atom.setIdleTTL(0), Atom.withLabel("mobile-factory-work-pages")),
);

/** Reads exactly the given pages; nothing refreshes on a timer, only on an explicit refresh. */
export function useFactoryWorkPages(
  targets: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly input: FactoryWorkListInput;
  }>,
) {
  const registry = use(RegistryContext);
  const pages = useAtomValue(factoryWorkPagesAtom(JSON.stringify(targets)));
  return {
    pages,
    refresh: (target: (typeof targets)[number]) =>
      registry.refresh(factoryEnvironment.listWork(target)),
  };
}
