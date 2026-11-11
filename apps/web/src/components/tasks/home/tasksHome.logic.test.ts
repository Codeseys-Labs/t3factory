import { FACTORY_TASK_FIXTURES } from "@t3tools/client-runtime/state/factory-task-fixtures";
import { describe, expect, it } from "vite-plus/test";

import { cardMeta, listResultText } from "./tasksHome.logic";

const fixture = (displayId: string) =>
  FACTORY_TASK_FIXTURES.tasks.find((task) => task.displayId === displayId)!;

describe("a task's result on the board and in the list", () => {
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
