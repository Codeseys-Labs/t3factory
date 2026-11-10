import { WS_METHODS, type EnvironmentId, type FactoryIntakeChange } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { createFactoryTaskReadGuard } from "./factoryTaskRefresh.ts";

const empty = { arrivals: 0, rules: 0, sources: 0 };
const advance = (
  state: typeof empty,
  change: Pick<FactoryIntakeChange, "arrivals" | "rules" | "sources">,
) => ({
  arrivals: state.arrivals + Number(change.arrivals),
  rules: state.rules + Number(change.rules),
  sources: state.sources + Number(change.sources),
});

export function createFactoryIntakeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const guard = createFactoryTaskReadGuard(runtime);
  const local = Atom.family((_id: EnvironmentId) => Atom.make(empty));
  const subscribeIntakeChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    tag: WS_METHODS.factorySubscribeIntakeChanges,
    label: "factory-intake:changes",
    idleTtlMs: 0,
    transform: (stream) => stream.pipe(Stream.scan(() => empty, advance)),
  });
  const signals = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((kind: keyof typeof empty) =>
      Atom.make((get) => {
        const remote = AsyncResult.getOrElse(
          get(subscribeIntakeChanges({ environmentId, input: {} })),
          () => empty,
        );
        return `${remote[kind]}:${get(local(environmentId))[kind]}`;
      }),
    ),
  );
  const invalidate = (registry: AtomRegistry.AtomRegistry, change: FactoryIntakeChange) =>
    registry.set(
      local(change.environmentId),
      advance(registry.get(local(change.environmentId)), change),
    );
  const refresh =
    (kind: keyof typeof empty) =>
    (
      { environmentId }: { readonly environmentId: EnvironmentId },
      registry: AtomRegistry.AtomRegistry,
    ) =>
      Effect.sync(() =>
        invalidate(registry, {
          environmentId,
          arrivals: true,
          rules: kind === "rules",
          sources: kind === "sources",
        }),
      );
  const trigger =
    (kind: keyof typeof empty) =>
    ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      signals(environmentId)(kind);
  return {
    subscribeIntakeChanges,
    invalidate,
    listIntakeSources: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-intake:sources",
        tag: WS_METHODS.factoryListIntakeSources,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: trigger("sources"),
      }),
    ),
    listIntakeRules: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-intake:rules",
        tag: WS_METHODS.factoryListIntakeRules,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: trigger("rules"),
      }),
    ),
    listIntakeArrivals: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-intake:arrivals",
        tag: WS_METHODS.factoryListIntakeArrivals,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: trigger("arrivals"),
      }),
    ),
    previewIntakeRule: guard(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "factory-intake:preview",
        tag: WS_METHODS.factoryPreviewIntakeRule,
        staleTimeMs: Number.POSITIVE_INFINITY,
        idleTtlMs: 0,
        refreshTrigger: trigger("arrivals"),
      }),
    ),
    saveIntakeSource: createEnvironmentRpcCommand(runtime, {
      label: "factory-intake:save-source",
      tag: WS_METHODS.factorySaveIntakeSource,
      onSettled: refresh("sources"),
    }),
    deleteIntakeSource: createEnvironmentRpcCommand(runtime, {
      label: "factory-intake:delete-source",
      tag: WS_METHODS.factoryDeleteIntakeSource,
      onSettled: refresh("sources"),
    }),
    saveIntakeRule: createEnvironmentRpcCommand(runtime, {
      label: "factory-intake:save-rule",
      tag: WS_METHODS.factorySaveIntakeRule,
      onSettled: refresh("rules"),
    }),
    deleteIntakeRule: createEnvironmentRpcCommand(runtime, {
      label: "factory-intake:delete-rule",
      tag: WS_METHODS.factoryDeleteIntakeRule,
      onSettled: refresh("rules"),
    }),
    resolveIntakeArrival: createEnvironmentRpcCommand(runtime, {
      label: "factory-intake:resolve-arrival",
      tag: WS_METHODS.factoryResolveIntakeArrival,
      onSettled: refresh("arrivals"),
    }),
  };
}
