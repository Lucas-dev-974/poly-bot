type DagLayoutConfig = {
  nodes: { id: string }[];
  edges: { from: string; to: string }[];
  direction: "horizontal" | "vertical";
  nodeWidth: number;
  nodeHeight: number;
  rankGap: number;
  nodeGap: number;
  padding: number;
};

type LayoutNode = { id: string; x: number; y: number };
type LayoutEdge = {
  from: string;
  to: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
};

type DagLayout = {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
};

/** Layered DAG layout for small strategy diagrams. */
export function computeDAGLayout(config: DagLayoutConfig): DagLayout {
  const { nodes, edges, direction, nodeWidth, nodeHeight, rankGap, nodeGap, padding } = config;
  const ids = nodes.map((n) => n.id);

  const out = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const id of ids) {
    out.set(id, []);
    inDeg.set(id, 0);
  }
  for (const e of edges) {
    if (!out.has(e.from) || !inDeg.has(e.to)) continue;
    out.get(e.from)!.push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }

  const rank = new Map<string, number>();
  const inCopy = new Map(inDeg);
  let queue = ids.filter((id) => inCopy.get(id)! === 0);
  for (const id of queue) rank.set(id, 0);

  while (queue.length) {
    const id = queue.shift()!;
    for (const to of out.get(id) ?? []) {
      rank.set(to, Math.max(rank.get(to) ?? 0, (rank.get(id) ?? 0) + 1));
      inCopy.set(to, inCopy.get(to)! - 1);
      if (inCopy.get(to)! === 0) queue.push(to);
    }
  }
  for (const id of ids) {
    if (!rank.has(id)) rank.set(id, 0);
  }

  const ranks = new Map<number, string[]>();
  let maxRank = 0;
  for (const id of ids) {
    const r = rank.get(id)!;
    maxRank = Math.max(maxRank, r);
    if (!ranks.has(r)) ranks.set(r, []);
    ranks.get(r)!.push(id);
  }

  const positions = new Map<string, { x: number; y: number }>();
  let maxW = 0;
  let maxH = 0;

  for (let r = 0; r <= maxRank; r++) {
    const group = ranks.get(r) ?? [];
    group.forEach((id, i) => {
      if (direction === "horizontal") {
        const x = padding + r * (nodeWidth + rankGap);
        const y = padding + i * (nodeHeight + nodeGap);
        positions.set(id, { x, y });
        maxW = Math.max(maxW, x + nodeWidth + padding);
        maxH = Math.max(maxH, y + nodeHeight + padding);
      } else {
        const x = padding + i * (nodeWidth + nodeGap);
        const y = padding + r * (nodeHeight + rankGap);
        positions.set(id, { x, y });
        maxW = Math.max(maxW, x + nodeWidth + padding);
        maxH = Math.max(maxH, y + nodeHeight + padding);
      }
    });
  }

  const layoutNodes: LayoutNode[] = ids.map((id) => {
    const p = positions.get(id)!;
    return { id, x: p.x, y: p.y };
  });

  const layoutEdges: LayoutEdge[] = edges
    .filter((e) => positions.has(e.from) && positions.has(e.to))
    .map((e) => {
      const from = positions.get(e.from)!;
      const to = positions.get(e.to)!;
      if (direction === "horizontal") {
        return {
          from: e.from,
          to: e.to,
          sourceX: from.x + nodeWidth,
          sourceY: from.y + nodeHeight / 2,
          targetX: to.x,
          targetY: to.y + nodeHeight / 2,
        };
      }
      return {
        from: e.from,
        to: e.to,
        sourceX: from.x + nodeWidth / 2,
        sourceY: from.y + nodeHeight,
        targetX: to.x + nodeWidth / 2,
        targetY: to.y,
      };
    });

  return { width: maxW, height: maxH, nodes: layoutNodes, edges: layoutEdges };
}
