import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  FactoryWorkHistoryInput,
  FactoryWorkKind,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ScheduledTaskId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { FACTORY_DEFAULT_RUNTIME_MODE, type FactoryIssueFilter } from "./factoryIssues";
import { FACTORY_WORK_HISTORY_MAX_PAGES, FACTORY_WORK_MAX_PAGES } from "./factoryWorkList";

export type FactorySection =
  | "work"
  | "overview"
  | "issues"
  | "briefs"
  | "workflows"
  | "orchestrator";

export interface FactoryWorkDetailParams {
  readonly work: string;
  readonly returnTo?: FactoryWorkDetailParams;
}

/** The Work scope and item a native review was opened from; the review inbox offers the way back. */
export interface FactoryWorkReturn extends FactoryWorkDetailParams {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly filter: FactoryIssueFilter;
}

/**
 * Factory-owned scope and section, independent from Settings filters. Model and branch picker
 * routes edit the same selection so returning to Factory retains the reviewed checkout.
 */
export interface FactoryInboxSelection {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly filter: FactoryIssueFilter;
  readonly section: FactorySection;
  readonly taskId: ScheduledTaskId | null;
  /** Null until the user picks one; the project's default applies until then. */
  readonly modelSelection: ModelSelection | null;
  /** Null starts from the project's current local HEAD. */
  readonly baseRef: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly workReturn: FactoryWorkReturn | null;
}

const INITIAL_SELECTION: FactoryInboxSelection = {
  environmentId: null,
  projectId: null,
  filter: "open",
  section: "overview",
  taskId: null,
  modelSelection: null,
  baseRef: null,
  runtimeMode: FACTORY_DEFAULT_RUNTIME_MODE,
  workReturn: null,
};

export const factoryInboxSelectionAtom = Atom.make<FactoryInboxSelection>(INITIAL_SELECTION).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-factory-inbox-selection"),
);

export function useFactoryInboxSelection(): FactoryInboxSelection {
  return useAtomValue(factoryInboxSelectionAtom);
}

export function updateFactoryInboxSelection(patch: Partial<FactoryInboxSelection>): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) => ({ ...current, ...patch }));
}

export function openFactoryIssues(environmentId: EnvironmentId, projectId: ProjectId): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) => ({
    ...current,
    environmentId,
    projectId,
    section: "issues" as const,
    taskId: null,
    workReturn: null,
    ...(current.environmentId === environmentId && current.projectId === projectId
      ? {}
      : { modelSelection: null, baseRef: null }),
  }));
}

/**
 * A completion belongs to its captured selection, not just its task id: a later request may
 * open the same workflow again. Loading and failed opens must retain the pending target.
 */
export function consumeFactoryWorkflowTarget(
  requested: FactoryInboxSelection,
  openedTaskId: ScheduledTaskId,
): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) =>
    current === requested && current.section === "workflows" && current.taskId === openedTaskId
      ? { ...current, taskId: null }
      : current,
  );
}

/** Null ids are the Factory's all/environment scope, independent from Settings filters. */
export function selectFactoryScope(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) =>
    current.environmentId === environmentId && current.projectId === projectId
      ? current
      : {
          ...current,
          environmentId,
          projectId,
          taskId: null,
          modelSelection: null,
          baseRef: null,
          workReturn: null,
        },
  );
}

/** Choosing a section by hand abandons a pending return to Work. */
export function selectFactorySection(section: FactorySection): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) => ({
    ...current,
    section,
    taskId: null,
    workReturn: null,
  }));
}

/**
 * Opens the review project's existing inbox and remembers the Work scope and item to return to.
 * Issues show every state so the reviewed issue is reachable whatever its source state.
 */
export function openFactoryWorkReview(target: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly section: "issues" | "briefs";
  readonly work: string;
  readonly returnTo?: FactoryWorkDetailParams;
}): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) => ({
    ...current,
    environmentId: target.environmentId,
    projectId: target.projectId,
    section: target.section,
    taskId: null,
    filter: target.section === "issues" ? "all" : current.filter,
    workReturn: {
      environmentId: current.environmentId,
      projectId: current.projectId,
      filter: current.filter,
      work: target.work,
      ...(target.returnTo ? { returnTo: target.returnTo } : {}),
    },
    ...(current.environmentId === target.environmentId && current.projectId === target.projectId
      ? {}
      : { modelSelection: null, baseRef: null }),
  }));
}

/** Restores the Work scope a review was opened from; returns the work to reopen, if any. */
export function returnToFactoryWork(): FactoryWorkDetailParams | null {
  const pending = appAtomRegistry.get(factoryInboxSelectionAtom).workReturn;
  if (pending === null) return null;
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) => ({
    ...current,
    environmentId: pending.environmentId,
    projectId: pending.projectId,
    filter: pending.filter,
    section: "work" as const,
    taskId: null,
    workReturn: null,
    ...(current.environmentId === pending.environmentId && current.projectId === pending.projectId
      ? {}
      : { modelSelection: null, baseRef: null }),
  }));
  return { work: pending.work, ...(pending.returnTo ? { returnTo: pending.returnTo } : {}) };
}

export type FactoryWorkHistorySelection = Omit<FactoryWorkHistoryInput, "ref" | "cursor" | "limit">;

/**
 * Work list and detail position, kept alive so leaving and coming back returns to the same kind,
 * loaded pages, selected item and history page. Cursors belong to one scope and kind.
 */
export interface FactoryWorkView {
  readonly kind: FactoryWorkKind | null;
  readonly pagesKey: string | null;
  readonly cursors: Readonly<Record<string, readonly string[]>>;
  readonly selected: string | null;
  readonly history: {
    readonly work: string;
    readonly selection: FactoryWorkHistorySelection;
    readonly cursors: readonly string[];
  } | null;
  readonly histories: Readonly<Record<string, NonNullable<FactoryWorkView["history"]>>>;
}

const INITIAL_WORK_VIEW: FactoryWorkView = {
  kind: null,
  pagesKey: null,
  cursors: {},
  selected: null,
  history: null,
  histories: {},
};

export const factoryWorkViewAtom = Atom.make<FactoryWorkView>(INITIAL_WORK_VIEW).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-factory-work-view"),
);

export function useFactoryWorkView(): FactoryWorkView {
  return useAtomValue(factoryWorkViewAtom);
}

export function factoryWorkPagesKey(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly kind: FactoryWorkKind | null;
}): string {
  return JSON.stringify([input.environmentId, input.projectId, input.kind]);
}

/** Cursors recorded for another scope or kind are never reused. */
export function loadedFactoryWorkCursors(
  view: FactoryWorkView,
  pagesKey: string,
  environmentId: EnvironmentId,
): readonly string[] {
  return view.pagesKey === pagesKey ? (view.cursors[environmentId] ?? []) : [];
}

export function selectFactoryWorkKind(kind: FactoryWorkKind | null): void {
  appAtomRegistry.update(factoryWorkViewAtom, (current) =>
    current.kind === kind ? current : { ...current, kind },
  );
}

export function loadMoreFactoryWork(
  pagesKey: string,
  environmentId: EnvironmentId,
  cursor: string,
): void {
  appAtomRegistry.update(factoryWorkViewAtom, (current) => {
    const cursors = current.pagesKey === pagesKey ? current.cursors : {};
    const loaded = cursors[environmentId] ?? [];
    if (loaded.includes(cursor) || loaded.length + 1 >= FACTORY_WORK_MAX_PAGES) return current;
    return { ...current, pagesKey, cursors: { ...cursors, [environmentId]: [...loaded, cursor] } };
  });
}

/** A refresh observes every owner's first page again and drops later pages. */
export function resetFactoryWorkPages(pagesKey: string): void {
  appAtomRegistry.update(factoryWorkViewAtom, (current) => ({ ...current, pagesKey, cursors: {} }));
}

export function selectFactoryWorkItem(key: string | null): void {
  appAtomRegistry.update(factoryWorkViewAtom, (current) =>
    current.selected === key ? current : { ...current, selected: key },
  );
}

/** History position belongs to one work item; another item starts at its executions. */
export function factoryWorkHistoryFor(view: FactoryWorkView, work: string) {
  return view.history?.work === work
    ? view.history
    : (view.histories[work] ?? {
        work,
        selection: { section: "executions" as const },
        cursors: [],
      });
}

function rememberHistory(view: FactoryWorkView, history: NonNullable<FactoryWorkView["history"]>) {
  const entries = Object.entries(view.histories).filter(([key]) => key !== history.work);
  return Object.fromEntries([...entries, [history.work, history]].slice(-32));
}

export function selectFactoryWorkHistory(
  work: string,
  selection: FactoryWorkHistorySelection,
): void {
  appAtomRegistry.update(factoryWorkViewAtom, (current) => {
    const history = { work, selection, cursors: [] };
    return { ...current, history, histories: rememberHistory(current, history) };
  });
}

export function moveFactoryWorkHistoryPage(work: string, next: string | null): void {
  appAtomRegistry.update(factoryWorkViewAtom, (current) => {
    const history = factoryWorkHistoryFor(current, work);
    if (next !== null && history.cursors.length + 1 >= FACTORY_WORK_HISTORY_MAX_PAGES)
      return current;
    const updated = {
      ...history,
      cursors: next === null ? history.cursors.slice(0, -1) : [...history.cursors, next],
    };
    return { ...current, history: updated, histories: rememberHistory(current, updated) };
  });
}
