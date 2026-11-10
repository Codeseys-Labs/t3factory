import {
  EnvironmentAuthorizationError,
  FactoryTaskError,
  FactoryTaskListInput,
  EnvironmentId,
  type FactoryTaskCountResult,
  type FactoryTaskListResult,
  type FactoryTaskSummary,
  type FactoryTaskStatus,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { factoryTaskKey } from "./factoryTaskView.ts";

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isTaskError = Schema.is(FactoryTaskError);

export const FACTORY_TASK_PAGE_CAP = 10;
export type FactoryTaskOwnerStatus =
  | "current"
  | "loading"
  | "offline"
  | "unsupported"
  | "forbidden"
  | "failed";
export interface FactoryTaskOwner {
  readonly environmentId: EnvironmentId;
  readonly status: FactoryTaskOwnerStatus;
  readonly pages: readonly FactoryTaskListResult[];
  readonly counts: FactoryTaskCountResult | null;
  readonly countsStatus: FactoryTaskOwnerStatus;
  readonly nextCursor: string | null;
  readonly capped: boolean;
}
export function planFactoryTaskOwners(input: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly projects:
    | readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[]
    | null;
}) {
  return [...new Set(input.environmentIds)].sort().map((environmentId) => ({
    environmentId,
    projectIds:
      input.projects === null
        ? undefined
        : [
            ...new Set(
              input.projects
                .filter((project) => project.environmentId === environmentId)
                .map((project) => project.id),
            ),
          ].sort(),
  }));
}

export function aggregateFactoryTasks(owners: readonly FactoryTaskOwner[]) {
  const tasks = new Map<string, { readonly task: FactoryTaskSummary; readonly stale: boolean }>();
  const byStatus: Record<FactoryTaskStatus, number> = {
    backlog: 0,
    ready: 0,
    "in-progress": 0,
    "in-review": 0,
    done: 0,
    canceled: 0,
  };
  for (const owner of owners) {
    if (owner.status !== "forbidden" && owner.status !== "unsupported")
      for (const page of owner.pages) {
        if (page.environmentId !== owner.environmentId) continue;
        for (const task of page.items) {
          if (task.ref.environmentId !== owner.environmentId) continue;
          const key = factoryTaskKey(task.ref);
          const previous = tasks.get(key);
          if (
            !previous ||
            task.updatedAt > previous.task.updatedAt ||
            (task.updatedAt === previous.task.updatedAt && task.version > previous.task.version)
          )
            tasks.set(key, { task, stale: owner.status !== "current" });
        }
      }
    if (
      owner.countsStatus !== "forbidden" &&
      owner.countsStatus !== "unsupported" &&
      owner.counts?.environmentId === owner.environmentId
    )
      for (const count of owner.counts.byStatus) byStatus[count.status] += count.count;
  }
  return {
    owners,
    items: [...tasks.values()].sort(
      (a, b) =>
        b.task.updatedAt.localeCompare(a.task.updatedAt) ||
        factoryTaskKey(a.task.ref).localeCompare(factoryTaskKey(b.task.ref)),
    ),
    byStatus,
    countsComplete: owners.every(
      (owner) => owner.countsStatus === "current" && owner.counts !== null,
    ),
    incomplete: owners.some((owner) => owner.status !== "current" || owner.nextCursor !== null),
    more: owners
      .filter((owner) => owner.nextCursor !== null)
      .map((owner) => ({
        environmentId: owner.environmentId,
        cursor: owner.nextCursor,
        capped: owner.capped,
        available: owner.status === "current" && !owner.capped,
      })),
  };
}

export function factoryTaskQueryStatus(
  result: AsyncResult.AsyncResult<unknown, unknown>,
): FactoryTaskOwnerStatus {
  if (result._tag === "Failure") {
    const defect = Result.getOrNull(Cause.findDefect(result.cause));
    if (typeof defect === "string" && defect.startsWith("Unknown request tag: factory."))
      return "unsupported";
    const error = Option.getOrNull(Cause.findErrorOption(result.cause));
    if (isAuthorizationError(error) || (isTaskError(error) && error.reason === "forbidden"))
      return "forbidden";
    if (isTaskError(error) && error.reason === "unsupported-capability") return "unsupported";
    return "failed";
  }
  return result._tag === "Initial" || result.waiting ? "loading" : "current";
}

const Target = Schema.Struct({ environmentId: EnvironmentId, input: FactoryTaskListInput });
export type FactoryTaskListTarget = typeof Target.Type;
const decodeTarget = Schema.decodeSync(Schema.fromJsonString(Target));
const decodeTargets = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Target)));

export function createFactoryTaskListAtoms<LE, CE>(input: {
  readonly listTasks: (
    target: FactoryTaskListTarget,
  ) => Atom.Atom<AsyncResult.AsyncResult<FactoryTaskListResult, LE>>;
  readonly countTasks: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Omit<FactoryTaskListInput, "cursor" | "limit">;
  }) => Atom.Atom<AsyncResult.AsyncResult<FactoryTaskCountResult, CE>>;
  readonly accessAtom: (environmentId: EnvironmentId) => Atom.Atom<FactoryTaskOwnerStatus>;
  readonly changesAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<unknown, Error>>;
}) {
  const budgets = Atom.family((_key: string) => Atom.make(1));
  const owner = Atom.family((key: string) => {
    const target = decodeTarget(key);
    const { cursor: _cursor, limit: _limit, ...filters } = target.input;
    return Atom.make((get): FactoryTaskOwner => {
      const access = get(input.accessAtom(target.environmentId));
      const previous = Option.getOrNull(get.self<FactoryTaskOwner>());
      if (access !== "current")
        return {
          environmentId: target.environmentId,
          status: access,
          pages: access === "forbidden" || access === "unsupported" ? [] : (previous?.pages ?? []),
          counts:
            access === "forbidden" || access === "unsupported" ? null : (previous?.counts ?? null),
          countsStatus: access,
          nextCursor: previous?.nextCursor ?? null,
          capped: false,
        };
      const pages: FactoryTaskListResult[] = [];
      const streamStatus = input.changesAtom
        ? factoryTaskQueryStatus(get(input.changesAtom(target.environmentId)))
        : "current";
      if (streamStatus === "forbidden" || streamStatus === "unsupported")
        return {
          environmentId: target.environmentId,
          status: streamStatus,
          pages: [],
          counts: null,
          countsStatus: streamStatus,
          nextCursor: null,
          capped: false,
        };
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let status: FactoryTaskOwnerStatus = "current";
      let nextCursor: string | null = null;
      const budget = Math.min(FACTORY_TASK_PAGE_CAP, get(budgets(key)));
      for (let index = 0; index < budget; index++) {
        const result = get(
          input.listTasks({
            environmentId: target.environmentId,
            input: {
              ...filters,
              limit: target.input.limit ?? 50,
              ...(cursor === undefined ? {} : { cursor }),
            },
          }),
        );
        status = factoryTaskQueryStatus(result);
        const page = Option.getOrNull(AsyncResult.value(result));
        if (status === "forbidden" || status === "unsupported") {
          pages.length = 0;
          break;
        }
        if (page) {
          pages.push(page);
          nextCursor = page.nextCursor;
        }
        if (status !== "current") {
          if (previous && pages.length === 0) {
            pages.push(...previous.pages);
            nextCursor = previous.nextCursor;
          }
          break;
        }
        if (!nextCursor) break;
        if (seenCursors.has(nextCursor)) {
          status = "failed";
          break;
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (status === "forbidden" || status === "unsupported")
        return {
          environmentId: target.environmentId,
          status,
          pages: [],
          counts: null,
          countsStatus: status,
          nextCursor: null,
          capped: false,
        };
      const counts = get(input.countTasks({ environmentId: target.environmentId, input: filters }));
      const readCountsStatus = factoryTaskQueryStatus(counts);
      const countsStatus = readCountsStatus === "current" ? streamStatus : readCountsStatus;
      if (countsStatus === "forbidden")
        return {
          environmentId: target.environmentId,
          status: "forbidden",
          pages: [],
          counts: null,
          countsStatus,
          nextCursor: null,
          capped: false,
        };
      return {
        environmentId: target.environmentId,
        status: status === "current" ? streamStatus : status,
        pages,
        countsStatus,
        counts: countsStatus === "unsupported" ? null : Option.getOrNull(AsyncResult.value(counts)),
        nextCursor,
        capped: nextCursor !== null && pages.length >= FACTORY_TASK_PAGE_CAP,
      };
    }).pipe(Atom.setIdleTTL(0));
  });
  const lists = Atom.family((key: string) =>
    Atom.make((get) =>
      aggregateFactoryTasks(decodeTargets(key).map((target) => get(owner(JSON.stringify(target))))),
    ).pipe(Atom.setIdleTTL(0)),
  );
  return {
    listAtom: (targets: readonly FactoryTaskListTarget[]) => lists(JSON.stringify(targets)),
    loadMore: (registry: AtomRegistry.AtomRegistry, target: FactoryTaskListTarget) => {
      const key = JSON.stringify(target);
      const current = registry.get(owner(key));
      if (current.status === "current" && current.nextCursor !== null && !current.capped)
        registry.set(budgets(key), Math.min(FACTORY_TASK_PAGE_CAP, registry.get(budgets(key)) + 1));
    },
    refresh: (registry: AtomRegistry.AtomRegistry, target: FactoryTaskListTarget) => {
      const key = JSON.stringify(target);
      registry.set(budgets(key), 1);
      const { cursor: _cursor, limit: _limit, ...filters } = target.input;
      registry.refresh(
        input.listTasks({
          environmentId: target.environmentId,
          input: { ...filters, limit: target.input.limit ?? 50 },
        }),
      );
      registry.refresh(input.countTasks({ environmentId: target.environmentId, input: filters }));
    },
  };
}
