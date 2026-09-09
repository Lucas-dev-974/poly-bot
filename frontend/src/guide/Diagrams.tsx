import { For, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { computeDAGLayout } from "./dagLayout";
import {
  CHEAP,
  FLOW_EDGES,
  FLOW_NODES,
  type EngineId,
  type LifeEdge,
  type LifeNode,
  type LifeTone,
  slotKind,
} from "./data";

const TONE_STROKE: Record<LifeTone, string> = {
  neutral: "var(--border)",
  accent: "var(--accent)",
  success: "var(--green)",
  danger: "var(--red)",
  warning: "var(--amber)",
};

export function LifecycleDiagram(props: {
  nodes: LifeNode[];
  edges: LifeEdge[];
  markerId: string;
  ariaLabel: string;
}): JSX.Element {
  const NODE_W = 188;
  const NODE_H = 48;

  const layout = createMemo(() =>
    computeDAGLayout({
      nodes: props.nodes.map((n) => ({ id: n.id })),
      edges: props.edges.map(({ from, to }) => ({ from, to })),
      direction: "vertical",
      nodeWidth: NODE_W,
      nodeHeight: NODE_H,
      rankGap: 68,
      nodeGap: 28,
      padding: 16,
    }),
  );

  const byId = createMemo(() => new Map(props.nodes.map((n) => [n.id, n])));

  return (
    <svg
      viewBox={`0 0 ${layout().width} ${layout().height}`}
      width="100%"
      class="guide-svg"
      role="img"
      aria-label={props.ariaLabel}
    >
      <defs>
        <marker
          id={props.markerId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
        </marker>
      </defs>
      <For each={layout().edges}>
        {(e) => {
          const midY = (e.sourceY + e.targetY) / 2;
          const d = `M ${e.sourceX} ${e.sourceY} C ${e.sourceX} ${midY}, ${e.targetX} ${midY}, ${e.targetX} ${e.targetY}`;
          const label =
            props.edges.find((x) => x.from === e.from && x.to === e.to)?.label ?? "";
          const lx = (e.sourceX + e.targetX) / 2;
          return (
            <g>
              <path
                d={d}
                fill="none"
                stroke="var(--muted)"
                stroke-width="1.2"
                marker-end={`url(#${props.markerId})`}
              />
              {label ? (
                <text x={lx} y={midY - 4} text-anchor="middle" font-size="10" fill="var(--muted)">
                  {label}
                </text>
              ) : null}
            </g>
          );
        }}
      </For>
      <For each={layout().nodes}>
        {(n) => {
          const meta = byId().get(n.id)!;
          const stroke = TONE_STROKE[meta.tone];
          return (
            <g>
              <rect
                x={n.x}
                y={n.y}
                width={NODE_W}
                height={NODE_H}
                rx="6"
                fill="var(--panel)"
                stroke={stroke}
                stroke-width={meta.tone === "neutral" ? 1 : 1.5}
              />
              <text
                x={n.x + NODE_W / 2}
                y={n.y + 19}
                text-anchor="middle"
                font-size="12"
                font-weight="600"
                fill="var(--text)"
              >
                {meta.label}
              </text>
              <text
                x={n.x + NODE_W / 2}
                y={n.y + 35}
                text-anchor="middle"
                font-size="10"
                fill="var(--muted)"
              >
                {meta.sub}
              </text>
            </g>
          );
        }}
      </For>
    </svg>
  );
}

export function FlowDag(): JSX.Element {
  const nodeW = 168;
  const nodeH = 52;

  const layout = createMemo(() =>
    computeDAGLayout({
      nodes: FLOW_NODES.map((n) => ({ id: n.id })),
      edges: FLOW_EDGES,
      direction: "horizontal",
      nodeWidth: nodeW,
      nodeHeight: nodeH,
      rankGap: 56,
      nodeGap: 28,
      padding: 8,
    }),
  );

  const byId = new Map(FLOW_NODES.map((n) => [n.id, n]));

  return (
    <svg
      viewBox={`0 0 ${layout().width} ${layout().height}`}
      width="100%"
      class="guide-svg"
      role="img"
      aria-label="Flux tick vers CLOB"
    >
      <defs>
        <marker
          id="flow-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
        </marker>
      </defs>
      <For each={layout().edges}>
        {(e) => (
          <path
            d={`M ${e.sourceX} ${e.sourceY} L ${e.targetX} ${e.targetY}`}
            fill="none"
            stroke="var(--border)"
            stroke-width="1.2"
            marker-end="url(#flow-arrow)"
          />
        )}
      </For>
      <For each={layout().nodes}>
        {(n) => {
          const meta = byId.get(n.id)!;
          const isStrat = n.id === "strat";
          return (
            <g>
              <rect
                x={n.x}
                y={n.y}
                width={nodeW}
                height={nodeH}
                rx="6"
                fill={isStrat ? "rgba(79, 140, 255, 0.12)" : "var(--panel)"}
                stroke={isStrat ? "var(--accent)" : "var(--border)"}
                stroke-width={isStrat ? 1.5 : 1}
              />
              <text
                x={n.x + nodeW / 2}
                y={n.y + 22}
                text-anchor="middle"
                font-size="12"
                font-weight="600"
                fill="var(--text)"
              >
                {meta.label}
              </text>
              <text
                x={n.x + nodeW / 2}
                y={n.y + 38}
                text-anchor="middle"
                font-size="10"
                fill="var(--muted)"
              >
                {meta.sub}
              </text>
            </g>
          );
        }}
      </For>
    </svg>
  );
}

export function TicketStrip(props: { engine: EngineId; hedgeFilled: number }): JSX.Element {
  const col = 44;
  const top = 28;
  const box = 34;
  const width = CHEAP * col + 8;
  const height = 118;

  const kinds = () =>
    Array.from({ length: CHEAP }, (_, i) => slotKind(i, props.hedgeFilled, props.engine));

  const stats = () => {
    const k = kinds();
    return {
      covered: k.filter((x) => x === "covered").length,
      need: k.filter((x) => x === "needHedge").length,
      keep: k.filter((x) => x === "keepBet").length,
    };
  };

  return (
    <div class="guide-stack" style={{ gap: "8px" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        class="guide-svg"
        role="img"
        aria-label="Dix billets outsider et leurs couvertures"
      >
        <text x="4" y="14" font-size="11" fill="var(--muted)">
          Outsider (cheap)
        </text>
        <text x="4" y={height - 6} font-size="11" fill="var(--muted)">
          Favori (hedge)
        </text>
        <For each={kinds()}>
          {(kind, i) => {
            const x = 4 + i() * col;
            const hedgeFill = kind === "covered" ? "rgba(230, 232, 238, 0.15)" : "none";
            const hedgeStroke =
              kind === "covered"
                ? "var(--text)"
                : kind === "needHedge"
                  ? "var(--accent)"
                  : "var(--border)";
            const hedgeDash = kind === "needHedge" ? "4 3" : undefined;
            return (
              <g>
                <rect x={x} y={top} width={box} height={box} rx="5" fill="var(--accent)" />
                <text
                  x={x + box / 2}
                  y={top + 22}
                  text-anchor="middle"
                  font-size="11"
                  font-weight="600"
                  fill="#fff"
                >
                  {i() + 1}
                </text>
                <rect
                  x={x}
                  y={top + box + 10}
                  width={box}
                  height={box}
                  rx="5"
                  fill={hedgeFill}
                  stroke={hedgeStroke}
                  stroke-width={kind === "keepBet" ? 1 : 1.4}
                  stroke-dasharray={hedgeDash}
                />
                {kind === "keepBet" && (
                  <text
                    x={x + box / 2}
                    y={top + box + 10 + 22}
                    text-anchor="middle"
                    font-size="9"
                    fill="var(--muted)"
                  >
                    pari
                  </text>
                )}
                {kind === "needHedge" && (
                  <text
                    x={x + box / 2}
                    y={top + box + 10 + 22}
                    text-anchor="middle"
                    font-size="9"
                    fill="var(--accent)"
                  >
                    ?
                  </text>
                )}
              </g>
            );
          }}
        </For>
      </svg>
      <div class="guide-row" style={{ gap: "16px" }}>
        <span class="guide-muted">Duo : {stats().covered}</span>
        <span class="guide-muted">Encore à protéger : {stats().need}</span>
        {stats().keep > 0 && (
          <span class="guide-muted">Pari outsider gardé : {stats().keep}</span>
        )}
      </div>
    </div>
  );
}
