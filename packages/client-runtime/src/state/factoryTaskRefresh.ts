import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  FactoryTaskError,
  FactoryIntakeError,
  sessionGrantsScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isTaskError = Schema.is(FactoryTaskError);
const isIntakeError = Schema.is(FactoryIntakeError);

export function createFactoryTaskReadGuard<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const sessions = createEnvironmentSessionAtoms(runtime);
  return <Input, A, Error>(
    query: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: Input;
    }) => Atom.Atom<AsyncResult.AsyncResult<A, Error>>,
  ) => {
    const cache = new WeakMap<
      Atom.Atom<AsyncResult.AsyncResult<A, Error>>,
      Atom.Atom<AsyncResult.AsyncResult<A, Error>>
    >();
    return (target: { readonly environmentId: EnvironmentId; readonly input: Input }) => {
      const raw = query(target);
      const existing = cache.get(raw);
      if (existing) return existing;
      const guarded = Atom.readable(
        (get) => {
          const session = get(sessions.sessionStateAtom(target.environmentId));
          if (
            session._tag !== "Success" ||
            !sessionGrantsScope(session.value, AuthOrchestrationReadScope)
          )
            return AsyncResult.initial<A, Error>(false);
          const result = get(raw);
          if (
            result._tag === "Failure" &&
            Option.exists(
              Cause.findErrorOption(result.cause),
              (error) =>
                isAuthorizationError(error) ||
                (isTaskError(error) && error.reason === "forbidden") ||
                (isIntakeError(error) && error.reason === "forbidden"),
            )
          )
            return AsyncResult.failure<A, Error>(result.cause);
          return result;
        },
        (refresh) => refresh(raw),
      ).pipe(Atom.setIdleTTL(0));
      cache.set(raw, guarded);
      return guarded;
    };
  };
}

export interface FactoryTaskRefreshState {
  readonly revision: number;
  readonly all: number;
  readonly roots: ReadonlyMap<string, number>;
  readonly profiles: number;
}
export const EMPTY_FACTORY_TASK_REFRESH: FactoryTaskRefreshState = {
  revision: 0,
  all: 0,
  roots: new Map(),
  profiles: 0,
};

export function reduceFactoryTaskRefresh(
  state: FactoryTaskRefreshState,
  change: { readonly rootIds: readonly string[]; readonly profiles: boolean },
): FactoryTaskRefreshState {
  const revision = state.revision + 1;
  const roots = new Map(state.roots);
  for (const root of change.rootIds) roots.set(root, revision);
  return {
    revision,
    roots,
    all: change.rootIds.length === 0 ? revision : state.all,
    profiles: change.profiles ? revision : state.profiles,
  };
}

export function factoryTaskRefreshVersion(
  state: FactoryTaskRefreshState,
  scope: "list" | "profiles" | { readonly rootId: string },
): number {
  if (scope === "list") return state.revision;
  if (scope === "profiles") return state.profiles;
  return Math.max(state.all, state.profiles, state.roots.get(scope.rootId) ?? 0);
}
