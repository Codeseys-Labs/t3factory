import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { FactoryTaskListTarget } from "@t3tools/client-runtime/state/factory-task-list";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FactoryIntakeArrival,
  type FactoryIntakeRule,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import { useContext, useState } from "react";

import { factoryIntake, factoryTasks } from "../../../state/factoryTasks";
import { environmentPresentations } from "../../../state/presentation";
import { environmentSession, sessionHasScope } from "../../../state/session";
import { taskErrorMessage } from "../shared";
import { useNeedsYou, useTaskScope } from "../shared/taskScope";

export type ArrivalEntry = { environmentId: EnvironmentId; arrival: FactoryIntakeArrival };
type InboxMachineState = {
  environmentId: EnvironmentId;
  label: string;
  state: "current" | "loading" | "offline" | "forbidden" | "failed" | "unsupported";
  message?: string;
};
export const arrivalKey = (entry: ArrivalEntry) =>
  JSON.stringify([entry.environmentId, entry.arrival.id]);

export function useInboxData() {
  const scope = useTaskScope();
  const attention = useNeedsYou();
  const registry = useContext(RegistryContext);
  const [pages, setPages] = useState<Record<string, readonly string[]>>({});
  const data = useAtomValue(
    Atom.make((get) => {
      const arrivals = new Map<string, ArrivalEntry>();
      const machines: InboxMachineState[] = [];
      const rules: FactoryIntakeRule[] = [];
      const more: { environmentId: EnvironmentId; cursor: string; key: string }[] = [];
      let waiting = 0;
      for (const target of scope.targets) {
        const { environmentId } = target;
        const presentation = get(environmentPresentations.presentationAtom(environmentId));
        const label = presentation?.entry.target.label ?? environmentId;
        const session = get(environmentSession.sessionStateAtom(environmentId));
        const phase = presentation?.connection.phase;
        const machine: InboxMachineState = {
          environmentId,
          label,
          state:
            phase === "unsupported"
              ? "unsupported"
              : phase === "error" || session._tag === "Failure"
                ? "failed"
                : phase === undefined || phase === "connecting" || phase === "reconnecting"
                  ? "loading"
                  : phase !== "connected"
                    ? "offline"
                    : !presentation?.serverConfig || session._tag === "Initial"
                      ? "loading"
                      : !sessionHasScope(session, AuthOrchestrationReadScope)
                        ? "forbidden"
                        : "current",
        };
        if (machine.state !== "current") {
          machines.push(machine);
          continue;
        }
        const asks = get(
          factoryTasks.listTasks({
            environmentId,
            input: { ...target.input, scope: "all", attention: true },
          }),
        );
        if (asks._tag === "Initial") machine.state = "loading";
        if (asks._tag === "Failure") recordFailure(machine, Cause.squash(asks.cause));
        const key = JSON.stringify(target);
        const cursors = [undefined, ...(pages[key] ?? [])];
        for (const [index, cursor] of cursors.entries()) {
          const result = get(
            factoryIntake.listIntakeArrivals({
              environmentId,
              input: { ...arrivalInput(target), ...(cursor ? { cursor } : {}) },
            }),
          );
          if (result._tag === "Initial" && machine.state === "current") machine.state = "loading";
          if (result._tag === "Failure") {
            recordFailure(machine, Cause.squash(result.cause));
          }
          if (result._tag !== "Success") continue;
          if (index === 0) waiting += result.value.waiting;
          for (const arrival of result.value.items) {
            const entry = { environmentId, arrival };
            arrivals.set(arrivalKey(entry), entry);
          }
          if (index === cursors.length - 1 && result.value.nextCursor)
            more.push({ environmentId, key, cursor: result.value.nextCursor });
        }
        const ruleResult = get(factoryIntake.listIntakeRules({ environmentId, input: {} }));
        const sources = target.input.projectIds
          ? get(
              factoryIntake.listIntakeSources({
                environmentId,
                input: { projectIds: target.input.projectIds },
              }),
            )
          : null;
        if (ruleResult._tag === "Success" && (!sources || sources._tag === "Success"))
          rules.push(
            ...ruleResult.value.rules.filter(
              (rule) =>
                !sources ||
                (sources._tag === "Success" &&
                  sources.value.sources.some((source) => source.id === rule.match.sourceId)),
            ),
          );
        else if (machine.state === "current") {
          const failure =
            ruleResult._tag === "Failure"
              ? ruleResult
              : sources?._tag === "Failure"
                ? sources
                : null;
          if (failure) recordFailure(machine, Cause.squash(failure.cause));
          else machine.state = "loading";
        }
        machines.push(machine);
      }
      return {
        arrivals: [...arrivals.values()].sort((a, b) =>
          b.arrival.arrivedAt.localeCompare(a.arrival.arrivedAt),
        ),
        machines,
        rules,
        waiting,
        more,
      };
    }),
  );
  return {
    ...data,
    ...attention,
    scope,
    loadMore: (environmentId: EnvironmentId) => {
      const next = data.more.find((owner) => owner.environmentId === environmentId);
      if (next)
        setPages((current) => ({
          ...current,
          [next.key]: [...(current[next.key] ?? []), next.cursor],
        }));
    },
    reload: () => {
      setPages({});
      for (const target of scope.targets) {
        registry.refresh(
          factoryTasks.listTasks({
            environmentId: target.environmentId,
            input: { ...target.input, scope: "all", attention: true },
          }),
        );
        registry.refresh(
          factoryIntake.listIntakeArrivals({
            environmentId: target.environmentId,
            input: arrivalInput(target),
          }),
        );
        registry.refresh(
          factoryIntake.listIntakeRules({ environmentId: target.environmentId, input: {} }),
        );
        if (target.input.projectIds)
          registry.refresh(
            factoryIntake.listIntakeSources({
              environmentId: target.environmentId,
              input: { projectIds: target.input.projectIds },
            }),
          );
      }
    },
  };
}

function recordFailure(machine: InboxMachineState, error: unknown) {
  const reason = error && typeof error === "object" && "reason" in error ? error.reason : null;
  const authorization =
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "EnvironmentAuthorizationError";
  machine.state =
    reason === "forbidden" || authorization
      ? "forbidden"
      : reason === "unsupported-capability"
        ? "unsupported"
        : "failed";
  machine.message = taskErrorMessage(error);
}

function arrivalInput(target: FactoryTaskListTarget) {
  return target.input.projectIds ? { projectIds: target.input.projectIds } : {};
}
