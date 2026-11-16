import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import { describe, expect, it } from "vite-plus/test";

import { taskAssigneeChipProps } from "../shared/taskAssigneeModel";
import {
  boardLanes,
  cardMeta,
  GROUP_ASSIGNEE_LABEL,
  laneAssignee,
  listResultText,
} from "./tasksHome.logic";

const fixture = (displayId: string) =>
  FACTORY_TASK_FIXTURES.tasks.find((task) => task.displayId === displayId)!;

describe("a task's result on the board and in the list", () => {
  it.each(["failed", "held"] as const)("describes a %s run despite later planning", (state) => {
    const task = fixture("T-36");
    const failedRun = { ...task.run!, ordinal: 2, state, note: "Needs a person" };
    const waiting = {
      ...task,
      failedRun,
      run: { ...failedRun, ordinal: 3, state: "completed" as const, purpose: "planning" as const },
    };
    const text = `Run 2${state === "failed" ? " failed" : ""}: Needs a person`;
    expect([cardMeta(waiting), listResultText(waiting)]).toEqual([{ kind: "text", text }, text]);
  });

  it.each([
    ["published, in review", "T-36", "#112 · +184 −20", "PR #112 · +184 −20 · 6 files"],
    ["accepted with its pull request open", "T-38.1", "#108 · +212 −48", "PR #108 open · accepted"],
    ["merged", "T-35", "#99 merged", "PR #99 merged"],
    ["a document", "T-33", "Doc · rev 2", "Document · rev 2"],
  ])("%s", (_state, displayId, card, list) => {
    const task = fixture(displayId);
    expect([cardMeta(task), listResultText(task)]).toEqual([{ kind: "text", text: card }, list]);
  });

  it("an accepted code result not published yet reads as accepted", () => {
    const task = fixture("T-38.1");
    const unpublished = { ...task, result: { ...task.result!, pullRequest: null } };
    expect([cardMeta(unpublished), listResultText(unpublished)]).toEqual([
      { kind: "text", text: "+212 −48 · 7 files" },
      "Accepted · rev 1",
    ]);
  });
});

describe("a group of tasks pinned to one model", () => {
  it("is named by the model, while each task keeps the effort it chose", () => {
    const effort = {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: [
        { id: "low", label: "Low", isDefault: true },
        { id: "high", label: "High" },
      ],
    };
    const catalog = FACTORY_TASK_FIXTURES.catalog.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        capabilities: { optionDescriptors: [effort] },
      })),
    }));
    const base = fixture("T-41");
    const { setup } = base.assignee.resolved!;
    const pinnedAt = (taskId: string, value: string) => ({
      ...base,
      ref: { ...base.ref, taskId },
      assignee: {
        key: base.assignee.key,
        resolved: null,
        assignment: {
          mode: "pinned" as const,
          setup: {
            ...setup,
            modelSelection: {
              ...setup.modelSelection,
              options: [{ id: "reasoningEffort", value }],
            },
          },
        },
      },
    });
    const tasks = [pinnedAt("high", "high"), pinnedAt("low", "low")];
    const lanes = boardLanes(tasks, "assignee");
    expect(lanes).toHaveLength(1);
    expect([
      taskAssigneeChipProps(laneAssignee(lanes[0]!.tasks)!, catalog, GROUP_ASSIGNEE_LABEL),
      taskAssigneeChipProps(tasks[0]!.assignee, catalog),
      taskAssigneeChipProps(tasks[1]!.assignee, catalog),
    ]).toMatchObject([
      { label: "Codex · Sol" },
      { label: "Codex · Sol · High" },
      { label: "Codex · Sol · Low" },
    ]);
  });
});
