export const YES_COLOR = "#3ee07a";
export const NO_COLOR = "#ff5b5b";
export const VOLUME_COLOR = "#5b9cff";
export const LIQUIDITY_COLOR = "#c084fc";
export const CHART_WORLD_W = 1200;
export const CHART_LABEL_W = 108;
export const CHART_ROW_H = 34;
export const CHART_PLOT_PAD = { top: 4, right: 40, bottom: 4, left: 6 };
/** Trous plus larges que le poll live (3–5 s) : une coupure à 2 s effaçait toute la courbe. */
export const CHART_GAP_CUT_SEC = 8;
/** Bande gauche/droite du canvas : molette = pan vertical, pas zoom. */
export const CHART_EDGE_SCROLL_MIN_PX = 64;
export const CHART_EDGE_SCROLL_MAX_PX = 150;
export const CHART_EDGE_SCROLL_FRAC = 0.13;

export interface SparkPoint {
  t: number;
  upMid: number | null;
  downMid: number | null;
  volume?: number | null;
  liquidity?: number | null;
  upSpread?: number | null;
  downSpread?: number | null;
  upBidSize?: number | null;
  upAskSize?: number | null;
  downBidSize?: number | null;
  downAskSize?: number | null;
}

export type SeriesKey = "upMid" | "downMid" | "volume" | "liquidity";

export interface ChartViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function chartContentHeight(rowCount: number): number {
  return Math.max(rowCount, 1) * CHART_ROW_H;
}

export function seriesPath(
  points: SparkPoint[],
  key: SeriesKey,
  x: (t: number) => number,
  y: (p: number) => number,
  cutGaps: boolean,
): string {
  const parts: string[] = [];
  let drawing = false;
  let prevT: number | null = null;
  for (const pt of points) {
    const p = pt[key];
    if (p == null) {
      drawing = false;
      prevT = pt.t;
      continue;
    }
    if (cutGaps && prevT !== null && pt.t - prevT > CHART_GAP_CUT_SEC) drawing = false;
    const px = round1(x(pt.t));
    const py = round1(y(p));
    if (!drawing) {
      parts.push(`M${px} ${py}`);
      drawing = true;
    } else {
      parts.push(`L${px} ${py}`);
    }
    prevT = pt.t;
  }
  return parts.join(" ");
}

export function rowTimeX(windowStart: number, windowEnd: number): (t: number) => number {
  const plotX = CHART_LABEL_W + CHART_PLOT_PAD.left;
  const plotW = CHART_WORLD_W - CHART_LABEL_W - CHART_PLOT_PAD.left - CHART_PLOT_PAD.right;
  const span = Math.max(windowEnd - windowStart, 1);
  return (t: number) => plotX + ((t - windowStart) / span) * plotW;
}

export function rowPriceY(rowTop: number): (p: number) => number {
  const top = rowTop + CHART_PLOT_PAD.top;
  const h = CHART_ROW_H - CHART_PLOT_PAD.top - CHART_PLOT_PAD.bottom;
  return (p: number) => top + (1 - Math.min(Math.max(p, 0), 1)) * h;
}

export function metricScaleMax(points: SparkPoint[]): number {
  let max = 0;
  for (const pt of points) {
    if (pt.volume != null && pt.volume > max) max = pt.volume;
    if (pt.liquidity != null && pt.liquidity > max) max = pt.liquidity;
  }
  return max;
}

export function rowMetricY(rowTop: number, max: number): (v: number) => number {
  const top = rowTop + CHART_PLOT_PAD.top;
  const h = CHART_ROW_H - CHART_PLOT_PAD.top - CHART_PLOT_PAD.bottom;
  const span = Math.max(max, 1);
  return (v: number) => top + (1 - Math.min(Math.max(v, 0), span) / span) * h;
}

export function clampViewBox(
  vb: ChartViewBox,
  contentH: number,
  containerW: number,
  containerH: number,
): ChartViewBox {
  const aspect = Math.max(containerW, 1) / Math.max(containerH, 1);
  const fittedW = CHART_WORLD_W;
  const w = clamp(vb.w, 220, fittedW);
  const h = w / aspect;
  const x = clamp(vb.x, 0, Math.max(0, CHART_WORLD_W - w));
  const y = clamp(vb.y, 0, Math.max(0, contentH - h));
  return { x, y, w, h };
}

export function fittedViewBox(
  _rowCount: number,
  containerW: number,
  containerH: number,
): ChartViewBox {
  return clampViewBox(
    { x: 0, y: 0, w: CHART_WORLD_W, h: 1 },
    chartContentHeight(_rowCount),
    containerW,
    containerH,
  );
}

export function isHorizontalEdge(clientX: number, rect: DOMRect): boolean {
  const band = Math.min(
    CHART_EDGE_SCROLL_MAX_PX,
    Math.max(CHART_EDGE_SCROLL_MIN_PX, rect.width * CHART_EDGE_SCROLL_FRAC),
  );
  const x = clientX - rect.left;
  return x <= band || x >= rect.width - band;
}

export function isLabelOrPriceGutter(worldX: number): boolean {
  return worldX < CHART_LABEL_W || worldX > CHART_WORLD_W - CHART_PLOT_PAD.right;
}

export function clientToWorld(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  vb: ChartViewBox,
): { x: number; y: number } {
  const x = vb.x + ((clientX - rect.left) / Math.max(rect.width, 1)) * vb.w;
  const y = vb.y + ((clientY - rect.top) / Math.max(rect.height, 1)) * vb.h;
  return { x, y };
}

export function visibleRowRange(vb: ChartViewBox, rowCount: number, overscan = 2): {
  start: number;
  end: number;
} {
  const start = Math.max(0, Math.floor(vb.y / CHART_ROW_H) - overscan);
  const end = Math.min(rowCount, Math.ceil((vb.y + vb.h) / CHART_ROW_H) + overscan);
  return { start, end };
}

export function fmtClock(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function rowAsset(slug: string): string {
  return slug.split("-")[0]?.toUpperCase() ?? "MKT";
}

export function worldXToTime(worldX: number, windowStart: number, windowEnd: number): number {
  const plotX = CHART_LABEL_W + CHART_PLOT_PAD.left;
  const plotW = CHART_WORLD_W - CHART_LABEL_W - CHART_PLOT_PAD.left - CHART_PLOT_PAD.right;
  const span = Math.max(windowEnd - windowStart, 1);
  return windowStart + ((worldX - plotX) / plotW) * span;
}

export function nearestPoint(points: SparkPoint[], t: number): SparkPoint | null {
  if (points.length === 0) return null;
  let best = points[0];
  let bestDist = Math.abs(points[0].t - t);
  for (const pt of points) {
    const dist = Math.abs(pt.t - t);
    if (dist < bestDist) {
      bestDist = dist;
      best = pt;
    }
  }
  return best;
}

export function rowIndexAtY(worldY: number, rowCount: number): number | null {
  const index = Math.floor(worldY / CHART_ROW_H);
  if (index < 0 || index >= rowCount) return null;
  return index;
}

export function fmtClockSec(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function lastMid(points: SparkPoint[], key: "upMid" | "downMid"): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i]?.[key];
    if (v != null) return v;
  }
  return null;
}

export function fmtPx(value: number): string {
  return value.toFixed(2);
}

/** Backtest `ts` is epoch ms when taken from the position id, otherwise seconds. */
export function toChartTimeSec(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts > 1_000_000_000_000 ? ts / 1000 : ts;
}

export function isOverlayPosition(row: { id: string; ts: number; fillPrice: number }): boolean {
  if (!Number.isFinite(row.ts) || row.ts <= 0) return false;
  return Number.isFinite(row.fillPrice);
}

/**
 * Vente mid-marché (défense / edge-sell).
 * Ne pas utiliser status==="sold" : la ligne BUY clonée garde ce status
 * et doit rester un marqueur d'entrée (cercle), pas une croix.
 */
export function isSellMark(row: { id: string; side?: string; status?: string }): boolean {
  return row.side === "SELL" || row.id.includes(":sold-");
}

/** Sum of realized leg PnL on a market. Null if no legs, or none have a PnL yet. */
export function marketRealizedPnl(rows: { pnl: number | null }[]): number | null {
  if (rows.length === 0) return null;
  let saw = false;
  let sum = 0;
  for (const row of rows) {
    if (row.pnl == null || !Number.isFinite(row.pnl)) continue;
    saw = true;
    sum += row.pnl;
  }
  if (!saw) return null;
  return Math.round(sum * 100) / 100;
}

export function groupPositionsBySlug<T extends { eventSlug: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.eventSlug);
    if (list) list.push(row);
    else map.set(row.eventSlug, [row]);
  }
  return map;
}

export interface WalletTradeMatchInput {
  timestamp: number;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  outcome: string;
  outcomeIndex: number;
  conditionId: string;
  slug: string;
  eventSlug: string;
}

export interface WalletOverlayMark {
  id: string;
  eventSlug: string;
  ts: number;
  fillPrice: number;
  size: number;
  side: "BUY" | "SELL";
  outcome: string;
  outcomeIndex: number;
}

/** Bind Data API trades to chart windows via slug or conditionId. */
export function matchWalletTradesToWindows<W extends { eventSlug: string; conditionId: string | null }>(
  trades: WalletTradeMatchInput[],
  windows: W[],
): WalletOverlayMark[] {
  const bySlug = new Map<string, string>();
  const byCondition = new Map<string, string>();
  for (const window of windows) {
    bySlug.set(window.eventSlug, window.eventSlug);
    if (window.conditionId) byCondition.set(window.conditionId.toLowerCase(), window.eventSlug);
  }
  const marks: WalletOverlayMark[] = [];
  let index = 0;
  for (const trade of trades) {
    const slug =
      bySlug.get(trade.eventSlug) ??
      bySlug.get(trade.slug) ??
      (trade.conditionId ? byCondition.get(trade.conditionId.toLowerCase()) : undefined);
    if (!slug) continue;
    marks.push({
      id: `wallet:${trade.conditionId}:${trade.timestamp}:${trade.outcomeIndex}:${trade.side}:${index}`,
      eventSlug: slug,
      ts: trade.timestamp,
      fillPrice: trade.price,
      size: trade.size,
      side: trade.side,
      outcome: trade.outcome,
      outcomeIndex: trade.outcomeIndex,
    });
    index += 1;
  }
  return marks;
}

export function diamondPoints(cx: number, cy: number, r: number): string {
  const x = round1(cx);
  const y = round1(cy);
  const rr = round1(Math.max(r, 0.8));
  return `${x},${round1(y - rr)} ${round1(x + rr)},${y} ${x},${round1(y + rr)} ${round1(x - rr)},${y}`;
}

/** World radii that render as a ~px circle despite preserveAspectRatio="none". */
export function markerRadiiWorld(
  vbW: number,
  vbH: number,
  containerW: number,
  containerH: number,
  px = 5.5,
): { rx: number; ry: number } {
  let rx = (px / Math.max(containerW, 1)) * vbW;
  let ry = (px / Math.max(containerH, 1)) * vbH;
  const cap = CHART_ROW_H * 0.4;
  if (ry > cap && ry > 0) {
    const s = cap / ry;
    rx *= s;
    ry = cap;
  }
  return { rx: Math.max(rx, 0.8), ry: Math.max(ry, 0.8) };
}

export function markerRadiusWorld(vbH: number, containerH: number, px = 5.5): number {
  return markerRadiiWorld(vbH, vbH, containerH, containerH, px).ry;
}

export function overlayMarksForWindow<T extends { id: string; ts: number; fillPrice: number }>(
  rows: T[],
  windowStart: number,
  windowEnd: number,
): T[] {
  return rows.filter((row) => {
    if (!isOverlayPosition(row)) return false;
    const t = toChartTimeSec(row.ts);
    return t >= windowStart && t <= windowEnd;
  });
}

export function nearestOverlayHit<T extends { id: string; ts: number; fillPrice: number }>(
  rows: T[],
  worldX: number,
  windowStart: number,
  windowEnd: number,
  maxDx: number,
): { row: T; dist: number } | null {
  const xOf = rowTimeX(windowStart, windowEnd);
  let best: T | null = null;
  let bestDist = maxDx;
  for (const row of rows) {
    if (!isOverlayPosition(row)) continue;
    const t = toChartTimeSec(row.ts);
    if (t < windowStart || t > windowEnd) continue;
    const dist = Math.abs(xOf(t) - worldX);
    if (dist < bestDist) {
      bestDist = dist;
      best = row;
    }
  }
  return best ? { row: best, dist: bestDist } : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
