import {
  decodeFactoryTaskViewState,
  encodeFactoryTaskViewState,
  type FactoryTaskViewState,
} from "@t3tools/client-runtime/state/factory-task-url";
import type { FactoryTaskCountInput, FactoryTaskRef } from "@t3tools/contracts";

/** `/tasks`. Absent keys mean the default: board, grouped by status, no filter, nothing peeked. */
export type TasksSearch = {
  layout?: "list";
  group?: "assignee" | "project";
  filters?: FactoryTaskCountInput;
  peek?: FactoryTaskRef;
};

const jsonOrNull = (value: string | null): unknown => {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** The router hands over values it already parsed, so they are put back into a query first. */
export function tasksViewState(search: Record<string, unknown>): FactoryTaskViewState {
  const params = new URLSearchParams();
  for (const key of ["layout", "group", "filters", "peek"]) {
    const value = search[key];
    if (value === undefined || value === null) continue;
    params.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return decodeFactoryTaskViewState(params.toString());
}

export function tasksSearch(state: FactoryTaskViewState): TasksSearch {
  const params = new URLSearchParams(encodeFactoryTaskViewState(state));
  const filters = jsonOrNull(params.get("filters"));
  const peek = jsonOrNull(params.get("peek"));
  return {
    ...(params.get("layout") === "list" ? { layout: "list" } : {}),
    ...(state.grouping === "status" ? {} : { group: state.grouping }),
    ...(filters === null ? {} : { filters: filters as FactoryTaskCountInput }),
    ...(peek === null ? {} : { peek: peek as FactoryTaskRef }),
  };
}

export function validateTasksSearch(raw: Record<string, unknown>): TasksSearch {
  return tasksSearch(tasksViewState(raw));
}

/** `/tasks/$environmentId/$displayId`. The Activity tab is the default. */
export interface TaskDetailSearch {
  tab?: "thread" | "result";
}
export function validateTaskDetailSearch(raw: Record<string, unknown>): TaskDetailSearch {
  return raw.tab === "thread" || raw.tab === "result" ? { tab: raw.tab } : {};
}

/** `/inbox`. Needs you is the default tab. `selected` names the row whose detail is open. */
export interface InboxSearch {
  tab?: "triage";
  selected?: string;
}
export function validateInboxSearch(raw: Record<string, unknown>): InboxSearch {
  return {
    ...(raw.tab === "triage" ? { tab: "triage" } : {}),
    ...(typeof raw.selected === "string" && raw.selected.length > 0 && raw.selected.length <= 1024
      ? { selected: raw.selected }
      : {}),
  };
}

/** `/automations`. `sheet` opens an editor over the page; without `id` it makes a new one. */
export interface AutomationsSearch {
  sheet?: "source" | "rule" | "profile";
  id?: string;
}
export function validateAutomationsSearch(raw: Record<string, unknown>): AutomationsSearch {
  const sheet =
    raw.sheet === "source" || raw.sheet === "rule" || raw.sheet === "profile" ? raw.sheet : null;
  if (sheet === null) return {};
  return {
    sheet,
    ...(typeof raw.id === "string" && raw.id.length > 0 && raw.id.length <= 128
      ? { id: raw.id }
      : {}),
  };
}
