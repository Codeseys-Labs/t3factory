import {
  FactoryPlanError,
  FactoryPlanSnapshot,
  type FactoryPlanOperation,
  type FactoryPlanWorkContext,
  type ThreadId,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type FactoryPlanActor =
  | { readonly kind: "human"; readonly sessionId: AuthSessionId }
  | { readonly kind: "agent"; readonly threadId: ThreadId };

const isSnapshot = Schema.is(FactoryPlanSnapshot);

export function canEditFactoryPlan(plan: FactoryPlanSnapshot, actor: FactoryPlanActor): boolean {
  return actor.kind === "human" || plan.editorThreadIds.includes(actor.threadId);
}

export function reduceFactoryPlan(
  plan: FactoryPlanSnapshot,
  operations: ReadonlyArray<FactoryPlanOperation>,
  actor: FactoryPlanActor,
  contexts: ReadonlyArray<FactoryPlanWorkContext>,
  now: string,
): Result.Result<FactoryPlanSnapshot, FactoryPlanError> {
  const tasks = plan.tasks.map((task) => ({ ...task }));
  const edges = plan.edges.map((edge) => ({ ...edge }));
  const workContexts = [...plan.workContexts];
  let editorThreadIds = [...plan.editorThreadIds];
  const invalid = () => Result.fail(new FactoryPlanError({ reason: "invalid-operation" }));
  for (const op of operations) {
    if (op.type === "editor.grant" || op.type === "editor.revoke") {
      if (actor.kind !== "human") return Result.fail(new FactoryPlanError({ reason: "forbidden" }));
      editorThreadIds = editorThreadIds.filter((id) => id !== op.threadId);
      if (op.type === "editor.grant") editorThreadIds.push(op.threadId);
      continue;
    }
    switch (op.type) {
      case "task.add":
        if (tasks.some((task) => task.id === op.id)) return invalid();
        tasks.push({
          id: op.id,
          parentId: op.parentId,
          title: op.title,
          context: op.context ?? "",
          order: op.order ?? tasks.length,
          retired: false,
        });
        break;
      case "task.update": {
        const task = tasks.find((entry) => entry.id === op.id);
        if (task === undefined || task.retired) return invalid();
        if (op.title !== undefined) task.title = op.title;
        if (op.context !== undefined) task.context = op.context;
        if (op.order !== undefined) task.order = op.order;
        break;
      }
      case "task.move": {
        const task = tasks.find((entry) => entry.id === op.id);
        if (task === undefined || task.retired || op.id === plan.ref.rootId) return invalid();
        task.parentId = op.parentId;
        break;
      }
      case "task.retire":
      case "task.restore": {
        const task = tasks.find((entry) => entry.id === op.id);
        if (task === undefined || task.retired === (op.type === "task.retire")) return invalid();
        task.retired = op.type === "task.retire";
        break;
      }
      case "edge.add":
        if (edges.some((edge) => edge.id === op.id)) return invalid();
        edges.push({
          id: op.id,
          kind: "requires",
          fromTaskId: op.fromTaskId,
          toTaskId: op.toTaskId,
          requirement: op.requirement,
          retired: false,
        });
        break;
      case "edge.retire":
      case "edge.restore": {
        const edge = edges.find((entry) => entry.id === op.id);
        if (edge === undefined || edge.retired === (op.type === "edge.retire")) return invalid();
        edge.retired = op.type === "edge.retire";
        break;
      }
      case "context.attachWork": {
        const context = contexts.find((entry) => entry.id === op.id);
        if (context === undefined || workContexts.some((entry) => entry.id === op.id))
          return invalid();
        const task = tasks.find((entry) => entry.id === op.taskId);
        if (task === undefined || task.retired) return invalid();
        workContexts.push(context);
        break;
      }
      case "context.retire":
      case "context.restore": {
        const index = workContexts.findIndex((entry) => entry.id === op.id);
        const context = workContexts[index];
        if (context === undefined || context.retired === (op.type === "context.retire"))
          return invalid();
        workContexts[index] = { ...context, retired: op.type === "context.retire" };
        break;
      }
    }
  }
  const next = {
    ...plan,
    revision: plan.revision + 1,
    tasks,
    edges,
    workContexts,
    editorThreadIds,
    updatedAt: now,
  };
  if (!isSnapshot(next)) return Result.fail(new FactoryPlanError({ reason: "invalid-plan" }));
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 256 * 1024)
    return Result.fail(new FactoryPlanError({ reason: "invalid-plan" }));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  if (
    taskById.size !== tasks.length ||
    new Set(edges.map((edge) => edge.id)).size !== edges.length ||
    new Set(workContexts.map((context) => context.id)).size !== workContexts.length
  )
    return Result.fail(new FactoryPlanError({ reason: "invalid-plan" }));
  const root = taskById.get(plan.ref.rootId);
  if (root === undefined || root.parentId !== null)
    return Result.fail(new FactoryPlanError({ reason: "invalid-plan" }));
  if (
    workContexts.some(
      (context) =>
        !taskById.has(context.taskId) ||
        (!context.retired && taskById.get(context.taskId)?.retired !== false),
    )
  )
    return Result.fail(new FactoryPlanError({ reason: "invalid-plan" }));
  for (const task of tasks) {
    const visited = new Set<string>();
    let current = task;
    while (current.parentId !== null) {
      if (visited.has(current.id))
        return Result.fail(new FactoryPlanError({ reason: "invalid-plan" }));
      visited.add(current.id);
      const parent = taskById.get(current.parentId);
      if (parent === undefined || (!current.retired && parent.retired))
        return Result.fail(new FactoryPlanError({ reason: "invalid-plan" }));
      current = parent;
    }
    if (current.id !== root.id)
      return Result.fail(new FactoryPlanError({ reason: "invalid-plan" }));
  }
  const adjacency = new Map<string, string[]>();
  const pairs = new Set<string>();
  for (const edge of edges) {
    const from = taskById.get(edge.fromTaskId);
    const to = taskById.get(edge.toTaskId);
    const pair = JSON.stringify([edge.fromTaskId, edge.toTaskId]);
    if (
      from === undefined ||
      to === undefined ||
      from.id === to.id ||
      (!edge.retired && (from.retired || to.retired || pairs.has(pair)))
    )
      return Result.fail(new FactoryPlanError({ reason: "invalid-plan" }));
    if (!edge.retired) pairs.add(pair);
    const targets = adjacency.get(from.id) ?? [];
    targets.push(to.id);
    adjacency.set(from.id, targets);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    if ((adjacency.get(id) ?? []).some(cyclic)) return true;
    visiting.delete(id);
    done.add(id);
    return false;
  };
  if (tasks.some((task) => cyclic(task.id)))
    return Result.fail(new FactoryPlanError({ reason: "invalid-plan" }));
  return Result.succeed(next);
}
