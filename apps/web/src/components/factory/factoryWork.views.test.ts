import { EnvironmentId, ProjectId, type FactoryWorkSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupFactoryWorkForBoard, moveFactoryWorkFocus } from "./factoryWork.views";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");

function entry(
  kind: FactoryWorkSummary["ref"]["kind"],
  id: string,
  environmentId: EnvironmentId,
  projectId: string,
  sourceState: string | null = null,
) {
  return {
    stale: false,
    item: {
      ref: { version: 1 as const, environmentId, kind, id },
      projectId: ProjectId.make(projectId),
      title: id,
      createdAt: "2026-11-01T00:00:00.000Z",
      sourceKey: null,
      sourceUrl: null,
      sourceState,
      revision: null,
      supersededBy: null,
      originConflict: false,
      planningStage: null,
    },
  };
}

const closedIssue = entry("issue", "closed-issue", laptop, "app", "closed");
const brief = entry("brief", "brief", server, "app");
const protocol = entry("protocol", "protocol", laptop, "docs");
const entries = [closedIssue, brief, protocol];
const projectOf = (item: FactoryWorkSummary) =>
  item.projectId === "app"
    ? { key: "logical-app", label: "App" }
    : {
        key: `${item.ref.environmentId}:${item.projectId}`,
        label: `${item.projectId} (unavailable)`,
      };

describe("groupFactoryWorkForBoard", () => {
  it("groups by origin without a completion column, keeping every loaded entry exactly once", () => {
    const columns = groupFactoryWorkForBoard(entries, "origin", { kind: undefined, projectOf });
    expect(
      columns.map((column) => [column.label, column.entries.map((e) => e.item.ref.id)]),
    ).toEqual([
      ["Issue admission", ["closed-issue"]],
      ["Feed admission", []],
      ["Authored brief", ["brief"]],
      ["Sealed protocol", ["protocol"]],
    ]);
    expect(
      groupFactoryWorkForBoard(entries, "origin", { kind: "brief", projectOf }).map((c) => c.key),
    ).toEqual(["brief"]);
  });

  it("groups by logical admission project across environments, keeping unavailable projects distinct", () => {
    const columns = groupFactoryWorkForBoard(entries, "project", { kind: undefined, projectOf });
    expect(columns.map((column) => [column.key, column.entries.map((e) => e.item.ref.id)])).toEqual(
      [
        ["logical-app", ["closed-issue", "brief"]],
        ["laptop:docs", ["protocol"]],
      ],
    );
  });
});

describe("moveFactoryWorkFocus", () => {
  it.each([
    [{ column: 0, row: 0 }, "ArrowDown", { column: 0, row: 1 }],
    [{ column: 0, row: 1 }, "ArrowDown", null],
    [{ column: 0, row: 1 }, "ArrowRight", { column: 2, row: 0 }],
    [{ column: 2, row: 0 }, "ArrowLeft", { column: 0, row: 0 }],
    [{ column: 0, row: 0 }, "ArrowLeft", null],
    [{ column: 0, row: 0 }, "End", { column: 0, row: 1 }],
    [{ column: 0, row: 0 }, "Enter", null],
  ])("from %o with %s", (current, key, expected) => {
    expect(moveFactoryWorkFocus([2, 0, 1], current, key)).toEqual(expected);
  });
});
