import { FactoryTaskCountInput, FactoryTaskRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const FactoryTaskViewState = Schema.Struct({
  layout: Schema.Literals(["board", "list"]),
  grouping: Schema.Literals(["status", "assignee", "project"]),
  filters: FactoryTaskCountInput,
  peek: Schema.NullOr(FactoryTaskRef),
});
export type FactoryTaskViewState = typeof FactoryTaskViewState.Type;
const decodeViewState = Schema.decodeSync(FactoryTaskViewState);
const decodeFilters = Schema.decodeUnknownOption(Schema.fromJsonString(FactoryTaskCountInput), {
  onExcessProperty: "error",
});
const decodePeek = Schema.decodeUnknownOption(Schema.fromJsonString(FactoryTaskRef), {
  onExcessProperty: "error",
});

export function decodeFactoryTaskViewState(input: unknown): FactoryTaskViewState {
  const defaults: FactoryTaskViewState = {
    layout: "board",
    grouping: "status",
    filters: {},
    peek: null,
  };
  if (typeof input !== "string" || input.length > 32768) return defaults;
  const params = new URLSearchParams(input);
  const single = (key: string) => (params.getAll(key).length === 1 ? params.get(key) : null);
  const grouping = single("group");
  return {
    layout: single("layout") === "list" ? "list" : "board",
    grouping: grouping === "assignee" || grouping === "project" ? grouping : "status",
    filters: Option.getOrElse(decodeFilters(single("filters")), () => ({})),
    peek: Option.getOrNull(decodePeek(single("peek"))),
  };
}

export function encodeFactoryTaskViewState(state: FactoryTaskViewState): string {
  const valid = decodeViewState(state);
  const filters = valid.filters;
  const sorted = <T extends string>(values: readonly T[] | undefined) =>
    values === undefined ? undefined : [...new Set(values)].sort();
  const canonical = {
    projectIds: sorted(filters.projectIds),
    statuses: sorted(filters.statuses),
    types: sorted(filters.types),
    sourceKinds: sorted(filters.sourceKinds),
    assigneeKeys: sorted(filters.assigneeKeys),
    text: filters.text || undefined,
    scope: filters.scope === "all" ? filters.scope : undefined,
  };
  const params = new URLSearchParams();
  if (valid.layout !== "board") params.set("layout", valid.layout);
  if (valid.grouping !== "status") params.set("group", valid.grouping);
  if (JSON.stringify(canonical) !== "{}") params.set("filters", JSON.stringify(canonical));
  if (valid.peek)
    params.set(
      "peek",
      JSON.stringify({
        environmentId: valid.peek.environmentId,
        projectId: valid.peek.projectId,
        rootId: valid.peek.rootId,
        taskId: valid.peek.taskId,
      }),
    );
  return params.toString();
}
