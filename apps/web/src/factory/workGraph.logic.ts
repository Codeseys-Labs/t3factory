import type { WorkCard, WorkGraph } from "./workBoard.logic";

const GRAPH_NODE_WIDTH = 224;
const GRAPH_NODE_HEIGHT = 64;
const GRAPH_COLUMN_GAP = 64;
const GRAPH_ROW_GAP = 16;
const GRAPH_PADDING = 16;

export interface WorkGraphLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly card: WorkCard;
  }>;
  readonly edges: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly kind: "parent" | "blocks";
    /** From the source's right edge to the target's left edge, both at mid height. */
    readonly path: string;
  }>;
}

/** A column per depth and a row per node in input order, all nodes of one size. */
export function layoutWorkGraph(graph: WorkGraph): WorkGraphLayout {
  const rowsByDepth = new Map<number, number>();
  const nodes = graph.nodes.map(({ id, depth, card }) => {
    const row = rowsByDepth.get(depth) ?? 0;
    rowsByDepth.set(depth, row + 1);
    return {
      id,
      x: GRAPH_PADDING + depth * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP),
      y: GRAPH_PADDING + row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP),
      width: GRAPH_NODE_WIDTH,
      height: GRAPH_NODE_HEIGHT,
      card,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const edges = graph.edges.flatMap(({ from, to, kind }) => {
    const source = byId.get(from);
    const target = byId.get(to);
    if (source === undefined || target === undefined) return [];
    const startX = source.x + source.width;
    const startY = source.y + source.height / 2;
    const endX = target.x;
    const endY = target.y + target.height / 2;
    const bend = Math.max(GRAPH_COLUMN_GAP / 2, Math.abs(endX - startX) / 2);
    return [
      {
        from,
        to,
        kind,
        path: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
      },
    ];
  });
  const columns = Math.max(0, ...rowsByDepth.keys()) + (nodes.length === 0 ? 0 : 1);
  const rows = Math.max(0, ...rowsByDepth.values());
  return {
    width:
      columns === 0
        ? 0
        : 2 * GRAPH_PADDING + columns * GRAPH_NODE_WIDTH + (columns - 1) * GRAPH_COLUMN_GAP,
    height:
      rows === 0 ? 0 : 2 * GRAPH_PADDING + rows * GRAPH_NODE_HEIGHT + (rows - 1) * GRAPH_ROW_GAP,
    nodes,
    edges,
  };
}
