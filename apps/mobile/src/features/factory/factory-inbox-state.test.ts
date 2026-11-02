import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  consumeFactoryWorkflowTarget,
  factoryInboxSelectionAtom,
  factoryWorkHistoryFor,
  factoryWorkPagesKey,
  factoryWorkViewAtom,
  loadedFactoryWorkCursors,
  loadMoreFactoryWork,
  moveFactoryWorkHistoryPage,
  openFactoryIssues,
  openFactoryWorkReview,
  resetFactoryWorkPages,
  returnToFactoryWork,
  selectFactoryScope,
  selectFactorySection,
  selectFactoryWorkHistory,
  updateFactoryInboxSelection,
  type FactoryInboxSelection,
} from "./factory-inbox-state";
import { FACTORY_WORK_MAX_PAGES } from "./factoryWorkList";

const environmentId = EnvironmentId.make("selected-environment");
const projectId = ProjectId.make("selected-project");
const taskId = ScheduledTaskId.make("previous-workflow");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
  options: [{ id: "effort", value: "high" }],
};

function setup(patch: Partial<FactoryInboxSelection> = {}): void {
  const previous = appAtomRegistry.get(factoryInboxSelectionAtom);
  const previousWork = appAtomRegistry.get(factoryWorkViewAtom);
  onTestFinished(() => {
    appAtomRegistry.set(factoryInboxSelectionAtom, previous);
    appAtomRegistry.set(factoryWorkViewAtom, previousWork);
  });
  appAtomRegistry.set(factoryWorkViewAtom, {
    kind: null,
    pagesKey: null,
    cursors: {},
    selected: null,
    history: null,
  });
  appAtomRegistry.set(factoryInboxSelectionAtom, {
    environmentId: null,
    projectId: null,
    filter: "open",
    section: "overview",
    taskId: null,
    modelSelection: null,
    baseRef: null,
    runtimeMode: "approval-required",
    workReturn: null,
    ...patch,
  });
}

describe("openFactoryIssues", () => {
  it("opens the selected project's issues from the initial overview", () => {
    setup();

    openFactoryIssues(environmentId, projectId);

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toEqual({
      environmentId,
      projectId,
      filter: "open",
      section: "issues",
      taskId: null,
      modelSelection: null,
      baseRef: null,
      runtimeMode: "approval-required",
      workReturn: null,
    });
  });

  it("opens another project's issues from orchestrator without reusing its model or base", () => {
    setup({
      environmentId,
      projectId: ProjectId.make("previous-project"),
      section: "orchestrator",
      filter: "closed",
      modelSelection,
      baseRef: "release/previous-project",
      runtimeMode: "full-access",
      workReturn: null,
    });

    openFactoryIssues(environmentId, projectId);

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toEqual({
      environmentId,
      projectId,
      filter: "closed",
      section: "issues",
      taskId: null,
      modelSelection: null,
      baseRef: null,
      runtimeMode: "full-access",
      workReturn: null,
    });
  });

  it("opens the same project's issues and clears the workflow target while retaining its model and base", () => {
    setup({
      environmentId,
      projectId,
      section: "workflows",
      taskId,
      filter: "all",
      modelSelection,
      baseRef: "release/selected-project",
      runtimeMode: "full-access",
      workReturn: null,
    });

    openFactoryIssues(environmentId, projectId);

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toEqual({
      environmentId,
      projectId,
      filter: "all",
      section: "issues",
      taskId: null,
      modelSelection,
      baseRef: "release/selected-project",
      runtimeMode: "full-access",
      workReturn: null,
    });
  });

  it("opens issues on another environment and clears workflow, model and base even when project IDs match", () => {
    setup({
      environmentId: EnvironmentId.make("previous-environment"),
      projectId,
      section: "workflows",
      taskId,
      filter: "closed",
      modelSelection,
      baseRef: "release/previous-environment",
    });

    openFactoryIssues(environmentId, projectId);

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toEqual({
      environmentId,
      projectId,
      filter: "closed",
      section: "issues",
      taskId: null,
      modelSelection: null,
      baseRef: null,
      runtimeMode: "approval-required",
      workReturn: null,
    });
  });
});

describe("consumeFactoryWorkflowTarget", () => {
  it("clears only the opened target and keeps the workflow section and reviewed checkout", () => {
    setup({
      environmentId,
      projectId,
      section: "workflows",
      taskId,
      filter: "closed",
      modelSelection,
      baseRef: "release/selected-project",
      runtimeMode: "full-access",
      workReturn: null,
    });
    const requested = appAtomRegistry.get(factoryInboxSelectionAtom);

    consumeFactoryWorkflowTarget(requested, taskId);

    const consumed = appAtomRegistry.get(factoryInboxSelectionAtom);
    expect(consumed).toEqual({ ...requested, taskId: null });
    consumeFactoryWorkflowTarget(requested, taskId);
    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toBe(consumed);
  });

  it("retains the intent when a different workflow opens", () => {
    setup({ environmentId, projectId, section: "workflows", taskId });
    const requested = appAtomRegistry.get(factoryInboxSelectionAtom);

    consumeFactoryWorkflowTarget(requested, ScheduledTaskId.make("another-workflow"));

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toBe(requested);
  });

  it.each([taskId, ScheduledTaskId.make("newer-workflow")])(
    "does not let a stale callback consume a subsequent request for %s",
    (nextTaskId) => {
      setup({ environmentId, projectId, section: "workflows", taskId });
      const previousRequest = appAtomRegistry.get(factoryInboxSelectionAtom);
      updateFactoryInboxSelection({ section: "workflows", taskId: nextTaskId });
      const nextRequest = appAtomRegistry.get(factoryInboxSelectionAtom);

      consumeFactoryWorkflowTarget(previousRequest, taskId);
      expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toBe(nextRequest);

      consumeFactoryWorkflowTarget(nextRequest, nextTaskId);
      expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toEqual({
        ...nextRequest,
        taskId: null,
      });
    },
  );

  it("does not restore a target or old checkout after the scope changes", () => {
    setup({ environmentId, projectId, section: "workflows", taskId });
    const requested = appAtomRegistry.get(factoryInboxSelectionAtom);
    selectFactoryScope(null, null);
    const allProjects = appAtomRegistry.get(factoryInboxSelectionAtom);

    consumeFactoryWorkflowTarget(requested, taskId);

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toBe(allProjects);
    expect(allProjects).toMatchObject({
      environmentId: null,
      projectId: null,
      section: "workflows",
      taskId: null,
    });
  });
});

describe("Factory Work review return", () => {
  const work = JSON.stringify({ version: 1, environmentId, kind: "issue", id: "admission" });
  const reviewProject = ProjectId.make("review-project");

  it("opens the review project's issues and returns to the exact Work scope and item", () => {
    setup({ section: "work", filter: "closed", modelSelection, baseRef: "release/other" });

    openFactoryWorkReview({ environmentId, projectId: reviewProject, section: "issues", work });

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toMatchObject({
      environmentId,
      projectId: reviewProject,
      section: "issues",
      filter: "all",
      modelSelection: null,
      baseRef: null,
      workReturn: { environmentId: null, projectId: null, filter: "closed", work },
    });
    expect(returnToFactoryWork()).toBe(work);
    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toMatchObject({
      environmentId: null,
      projectId: null,
      section: "work",
      filter: "closed",
      workReturn: null,
    });
    expect(returnToFactoryWork()).toBeNull();
  });

  it.each([
    ["changing scope", () => selectFactoryScope(null, null)],
    ["choosing a section", () => selectFactorySection("overview")],
    ["opening issues elsewhere", () => openFactoryIssues(environmentId, projectId)],
  ])("abandons the pending return when %s", (_name, leave) => {
    setup({ section: "work" });
    openFactoryWorkReview({ environmentId, projectId: reviewProject, section: "briefs", work });

    leave();

    expect(appAtomRegistry.get(factoryInboxSelectionAtom).workReturn).toBeNull();
    expect(returnToFactoryWork()).toBeNull();
  });
});

describe("Factory Work view", () => {
  const pagesKey = factoryWorkPagesKey({ environmentId, projectId: null, kind: null });
  const otherKey = factoryWorkPagesKey({ environmentId, projectId: null, kind: "brief" });

  it("keeps loaded cursors per scope and kind, without duplicates and within the page bound", () => {
    setup();
    for (let index = 0; index < FACTORY_WORK_MAX_PAGES + 2; index += 1) {
      loadMoreFactoryWork(pagesKey, environmentId, `cursor-${index}`);
      loadMoreFactoryWork(pagesKey, environmentId, `cursor-${index}`);
    }
    const view = appAtomRegistry.get(factoryWorkViewAtom);

    expect(loadedFactoryWorkCursors(view, pagesKey, environmentId)).toHaveLength(
      FACTORY_WORK_MAX_PAGES - 1,
    );
    expect(loadedFactoryWorkCursors(view, otherKey, environmentId)).toEqual([]);

    loadMoreFactoryWork(otherKey, environmentId, "brief-cursor");
    expect(
      loadedFactoryWorkCursors(appAtomRegistry.get(factoryWorkViewAtom), pagesKey, environmentId),
    ).toEqual([]);
    resetFactoryWorkPages(otherKey);
    expect(
      loadedFactoryWorkCursors(appAtomRegistry.get(factoryWorkViewAtom), otherKey, environmentId),
    ).toEqual([]);
  });

  it("returns to the same history page for the same item and starts another at executions", () => {
    setup();
    selectFactoryWorkHistory("work-a", { section: "runs", threadId: ThreadId.make("thread") });
    moveFactoryWorkHistoryPage("work-a", "history-cursor");
    const view = appAtomRegistry.get(factoryWorkViewAtom);

    expect(factoryWorkHistoryFor(view, "work-a")).toMatchObject({
      selection: { section: "runs" },
      cursors: ["history-cursor"],
    });
    expect(factoryWorkHistoryFor(view, "work-b")).toEqual({
      work: "work-b",
      selection: { section: "executions" },
      cursors: [],
    });
    moveFactoryWorkHistoryPage("work-a", null);
    expect(
      factoryWorkHistoryFor(appAtomRegistry.get(factoryWorkViewAtom), "work-a").cursors,
    ).toEqual([]);
  });
});
