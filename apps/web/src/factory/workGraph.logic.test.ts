import type { FactoryTaskSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkCard } from "./workBoard.logic";
import { layoutWorkGraph } from "./workGraph.logic";

const card = (id: string): WorkCard => {
  const task: FactoryTaskSummary = {
    v: 1,
    id,
    number: 1,
    rev: 1,
    projectId: null,
    title: id,
    lane: "backlog",
    laneSetAt: "2026-11-01T00:00:00.000Z",
    parentId: null,
    blockedBy: [],
    assignee: null,
    model: null,
    source: { _tag: "local" },
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    hasDescription: false,
    attempt: null,
  };
  return { task, column: "backlog", badges: [], run: null, childCount: 0, openBlockers: [] };
};

describe("laying out the work graph", () => {
  it("puts each depth in a column, rows in input order, and joins right edges to left edges", () => {
    const [a, b, c] = [card("a"), card("b"), card("c")];
    const layout = layoutWorkGraph({
      nodes: [
        { id: "a", depth: 0, card: a },
        { id: "b", depth: 1, card: b },
        { id: "c", depth: 1, card: c },
      ],
      edges: [
        { from: "a", to: "b", kind: "parent" },
        { from: "a", to: "c", kind: "blocks" },
        { from: "gone", to: "c", kind: "blocks" },
      ],
    });
    expect(layout.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: "a", x: 16, y: 16 },
      { id: "b", x: 304, y: 16 },
      { id: "c", x: 304, y: 96 },
    ]);
    expect(layout.edges).toEqual([
      { from: "a", to: "b", kind: "parent", path: "M 240 48 C 272 48, 272 48, 304 48" },
      { from: "a", to: "c", kind: "blocks", path: "M 240 48 C 272 48, 272 128, 304 128" },
    ]);
    expect({ width: layout.width, height: layout.height }).toEqual({ width: 544, height: 176 });
  });

  it("is empty for no nodes", () => {
    expect(layoutWorkGraph({ nodes: [], edges: [] })).toEqual({
      width: 0,
      height: 0,
      nodes: [],
      edges: [],
    });
  });
});
