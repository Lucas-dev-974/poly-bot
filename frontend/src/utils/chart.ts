import type { PricePoint, TradePoint } from "../types";

export interface MetricPoint {
  t: number;
  volume: number | null;
  volume24hr: number | null;
  liquidity: number | null;
}

export interface DepthPoint {
  t: number;
  upSpread: number | null;
  downSpread: number | null;
  gammaSpread: number | null;
  upBidSize: number | null;
  upAskSize: number | null;
  downBidSize: number | null;
  downAskSize: number | null;
}

/**
 * Données du graphique. Convention stricte : `upHistory` est TOUJOURS la courbe
 * de l'outcome Up (index 0, vert) et `downHistory` celle de Down (index 1, rouge),
 * quelle que soit la jambe depuis laquelle le dialog a été ouvert.
 */
export interface ChartData {
  upHistory: PricePoint[];
  downHistory: PricePoint[];
  /** Fenêtre temporelle native en secondes Unix. */
  windowStart: number;
  windowEnd: number;
  /** Trades du bot sur ce marché (les 2 jambes). */
  trades: TradePoint[];
  /** Jambe à mettre en avant (0 = Up, 1 = Down). null = aucune (les 2 courbes au même poids). */
  highlightOutcomeIndex: number | null;
  /** Prix de règlement du token Up (≈0 ou 1) si le marché est résolu. */
  finalUpPrice: number | null;
  /** Labels des outcomes ([Up, Down]). */
  outcomeLabels: [string, string];
  /** Range temps affiché après zoom/pan. Défaut = windowStart/windowEnd. */
  viewport?: { start: number; end: number };
  /** Volume / liquidité / vol 24h Gamma persistés (secondes Unix). */
  metrics?: MetricPoint[];
  showMetrics?: boolean;
  /** Spread L1 et tailles au best (secondes Unix). */
  depth?: DepthPoint[];
  showSpread?: boolean;
}

export const CHART_COLORS = {
  up: "#3ee07a",
  down: "#ff5b5b",
  upFill: "rgba(62,224,122,0.08)",
  downFill: "rgba(255,91,91,0.08)",
  volume: "#5b9cff",
  volume24hr: "#f97316",
  liquidity: "#c084fc",
  spread: "#eab308",
  spreadWarn: "#fb7185",
  grid: "rgba(255,255,255,0.05)",
  text: "rgba(255,255,255,0.55)",
  resolve: "#f59e0b",
  resolveLine: "rgba(245,158,11,0.4)",
  crosshair: "rgba(255,255,255,0.3)",
};

export const PADDING = { top: 14, right: 56, bottom: 32, left: 56 };
const FONT_MONO = "11px ui-monospace, 'SF Mono', Menlo, monospace";
const MARKER_R = 7;

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Couleur d'un outcome : Up = vert, Down = rouge. */
export function outcomeColor(outcomeIndex: number): string {
  return outcomeIndex === 1 ? CHART_COLORS.down : CHART_COLORS.up;
}

/**
 * Dessine le graphique de marché sur un canvas 2D. Gère le devicePixelRatio
 * pour un rendu net, et redessine à chaque appel (le caller gère le resize).
 * @param crosshair Optionnel: info crosshair pour dessiner les lignes pointillées.
 */
export function drawMarketChart(
  canvas: HTMLCanvasElement,
  data: ChartData,
  crosshair?: CrosshairInfo | null,
): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(rect.width, 1);
  const height = Math.max(rect.height, 1);

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;
  if (plotW <= 0 || plotH <= 0) return;

  const plotRight = width - PADDING.right;
  const plotBottom = height - PADDING.bottom;

  // Viewport: utilise data.viewport si présent (zoom/pan), sinon la fenêtre native.
  const vp = data.viewport ?? { start: data.windowStart, end: data.windowEnd };
  const { windowEnd } = data;
  const span = Math.max(vp.end - vp.start, 1);

  const x = (t: number): number => PADDING.left + ((t - vp.start) / span) * plotW;
  const y = (p: number): number => PADDING.top + (1 - Math.min(Math.max(p, 0), 1)) * plotH;
  const metrics = data.showMetrics === false ? [] : (data.metrics ?? []);
  const metricMax = maxMetric(metrics);
  const vol24Max = maxVolume24hr(metrics);
  const yMetric = (v: number): number =>
    PADDING.top + (1 - Math.min(Math.max(v, 0), metricMax) / Math.max(metricMax, 1)) * plotH;
  const yVol24 = (v: number): number =>
    PADDING.top + (1 - Math.min(Math.max(v, 0), vol24Max) / Math.max(vol24Max, 1)) * plotH;
  const leftMax = vol24Max > 0 ? vol24Max : metricMax;
  const leftColor = vol24Max > 0 ? CHART_COLORS.volume24hr : "rgba(255,255,255,0.4)";

  // Grille horizontale (prix) — labels à droite
  ctx.strokeStyle = CHART_COLORS.grid;
  ctx.fillStyle = CHART_COLORS.text;
  ctx.font = FONT_MONO;
  ctx.lineWidth = 1;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= 4; i++) {
    const price = i / 4;
    const py = y(price);
    ctx.beginPath();
    ctx.moveTo(PADDING.left, py);
    ctx.lineTo(plotRight, py);
    ctx.stroke();
    ctx.fillText(price.toFixed(2), plotRight + 6, py);
    if (leftMax > 0) {
      ctx.textAlign = "right";
      ctx.fillStyle = leftColor;
      ctx.fillText(fmtMetricTick((leftMax * i) / 4), PADDING.left - 6, py);
      ctx.fillStyle = CHART_COLORS.text;
      ctx.textAlign = "left";
    }
  }

  // Grille verticale (temps). Premier label aligné à gauche, dernier à droite
  // pour ne pas être coupés par les bords du canvas.
  const tickCount = 6;
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i <= tickCount; i++) {
    const t = vp.start + (span * i) / tickCount;
    const tx = x(t);
    ctx.beginPath();
    ctx.moveTo(tx, PADDING.top);
    ctx.lineTo(tx, plotBottom);
    ctx.stroke();
    ctx.textAlign = i === 0 ? "left" : i === tickCount ? "right" : "center";
    ctx.fillText(fmtTime(t), tx, plotBottom + 16);
  }
  ctx.textAlign = "left";

  // Ligne de résolution (fin de fenêtre native, pas du viewport)
  const resolveVisible = windowEnd >= vp.start && windowEnd <= vp.end;
  if (resolveVisible) {
    ctx.strokeStyle = CHART_COLORS.resolveLine;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x(windowEnd), PADDING.top);
    ctx.lineTo(x(windowEnd), plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Tout ce qui suit est clippé à la zone de tracé (indispensable en zoom/pan,
  // sinon les segments hors viewport débordent sur les axes).
  ctx.save();
  ctx.beginPath();
  // Marge = MARKER_R pour ne pas tronquer les markers situés sur les bords (ex: losange à windowEnd).
  ctx.rect(PADDING.left - MARKER_R, PADDING.top - MARKER_R, plotW + MARKER_R * 2, plotH + MARKER_R * 2);
  ctx.clip();

  // Aires dégradées (toujours sous les courbes)
  drawArea(ctx, data.downHistory, x, y, plotBottom, CHART_COLORS.downFill);
  drawArea(ctx, data.upHistory, x, y, plotBottom, CHART_COLORS.upFill);

  if (metricMax > 0) {
    drawMetricLine(ctx, metrics, "volume", x, yMetric, CHART_COLORS.volume, false);
    drawMetricLine(ctx, metrics, "liquidity", x, yMetric, CHART_COLORS.liquidity, true);
  }
  if (vol24Max > 0) {
    drawMetricLine(ctx, metrics, "volume24hr", x, yVol24, CHART_COLORS.volume24hr, "dotted");
  }

  const depth = data.depth ?? [];
  if (data.showSpread !== false && depth.length > 0) {
    drawSpreadLine(ctx, depth, (pt) => pt.upSpread, x, y, CHART_COLORS.up);
    drawSpreadLine(ctx, depth, (pt) => pt.downSpread, x, y, CHART_COLORS.down);
    drawSpreadLine(
      ctx,
      depth,
      (pt) => (pt.upSpread == null && pt.downSpread == null ? pt.gammaSpread : null),
      x,
      y,
      CHART_COLORS.spread,
    );
  }

  // Courbes : la jambe mise en avant est plus épaisse et dessinée au-dessus.
  const hl = data.highlightOutcomeIndex;
  const upStyle = hl == null ? { w: 2, a: 0.95 } : hl === 0 ? { w: 2.5, a: 1 } : { w: 1.5, a: 0.6 };
  const downStyle = hl == null ? { w: 2, a: 0.95 } : hl === 1 ? { w: 2.5, a: 1 } : { w: 1.5, a: 0.6 };
  if (hl === 1) {
    drawLine(ctx, data.upHistory, x, y, CHART_COLORS.up, upStyle.w, upStyle.a);
    drawLine(ctx, data.downHistory, x, y, CHART_COLORS.down, downStyle.w, downStyle.a);
  } else {
    drawLine(ctx, data.downHistory, x, y, CHART_COLORS.down, downStyle.w, downStyle.a);
    drawLine(ctx, data.upHistory, x, y, CHART_COLORS.up, upStyle.w, upStyle.a);
  }

  // Markers de trades : couleur = outcome (Up vert / Down rouge), forme = side (BUY ▲ / SELL ▼).
  // Le prix du trade est celui de son token, donc le marker tombe sur sa propre courbe.
  for (const trade of data.trades) {
    const tx = x(trade.timestamp);
    if (tx < PADDING.left || tx > plotRight) continue;
    const ty = y(trade.price);
    drawTriangle(ctx, tx, ty, MARKER_R, outcomeColor(trade.outcomeIndex), trade.side === "BUY");
  }

  // Markers de résolution : Up à finalUpPrice, Down à 1 - finalUpPrice.
  if (data.finalUpPrice != null && resolveVisible) {
    const rx = x(windowEnd);
    drawDiamond(ctx, rx, y(data.finalUpPrice), 6, CHART_COLORS.up);
    drawDiamond(ctx, rx, y(1 - data.finalUpPrice), 6, CHART_COLORS.down);
  }

  ctx.restore();

  // Crosshair (si fourni)
  if (crosshair) {
    ctx.strokeStyle = CHART_COLORS.crosshair;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(crosshair.x, PADDING.top);
    ctx.lineTo(crosshair.x, plotBottom);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(PADDING.left, crosshair.y);
    ctx.lineTo(plotRight, crosshair.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (crosshair.upPrice != null) drawDot(ctx, crosshair.x, y(crosshair.upPrice), CHART_COLORS.up);
    if (crosshair.downPrice != null) drawDot(ctx, crosshair.x, y(crosshair.downPrice), CHART_COLORS.down);
    if (metricMax > 0 && crosshair.volume != null) {
      drawDot(ctx, crosshair.x, yMetric(crosshair.volume), CHART_COLORS.volume);
    }
    if (metricMax > 0 && crosshair.liquidity != null) {
      drawDot(ctx, crosshair.x, yMetric(crosshair.liquidity), CHART_COLORS.liquidity);
    }
    if (vol24Max > 0 && crosshair.volume24hr != null) {
      drawDot(ctx, crosshair.x, yVol24(crosshair.volume24hr), CHART_COLORS.volume24hr);
    }
    if (data.showSpread !== false) {
      if (crosshair.upSpread != null) {
        drawDot(
          ctx,
          crosshair.x,
          y(Math.max(crosshair.upSpread, 0)),
          crosshair.upSpread < 0 ? CHART_COLORS.spreadWarn : CHART_COLORS.up,
        );
      } else if (crosshair.gammaSpread != null) {
        drawDot(
          ctx,
          crosshair.x,
          y(Math.max(crosshair.gammaSpread, 0)),
          crosshair.gammaSpread < 0 ? CHART_COLORS.spreadWarn : CHART_COLORS.spread,
        );
      }
      if (crosshair.downSpread != null) {
        drawDot(
          ctx,
          crosshair.x,
          y(Math.max(crosshair.downSpread, 0)),
          crosshair.downSpread < 0 ? CHART_COLORS.spreadWarn : CHART_COLORS.down,
        );
      }
    }
  }
}

function drawMetricLine(
  ctx: CanvasRenderingContext2D,
  points: MetricPoint[],
  key: "volume" | "liquidity" | "volume24hr",
  x: (t: number) => number,
  y: (v: number) => number,
  color: string,
  dash: boolean | "dotted",
): void {
  drawBreakLine(
    ctx,
    points,
    (pt) => pt[key],
    x,
    y,
    color,
    1.4,
    dash === "dotted" ? [2, 3] : dash ? [5, 4] : [],
    0.9,
  );
}

function drawSpreadLine(
  ctx: CanvasRenderingContext2D,
  points: DepthPoint[],
  valueOf: (pt: DepthPoint) => number | null,
  x: (t: number) => number,
  y: (v: number) => number,
  color: string,
): void {
  drawBreakLine(
    ctx,
    points,
    (pt) => {
      const value = valueOf(pt);
      return value == null || value < 0 ? null : value;
    },
    x,
    y,
    color,
    1.15,
    [4, 3],
    0.75,
  );
  drawBreakLine(
    ctx,
    points,
    (pt) => {
      const value = valueOf(pt);
      return value == null || value >= 0 ? null : 0;
    },
    x,
    y,
    CHART_COLORS.spreadWarn,
    1.15,
    [4, 3],
    0.9,
  );
  for (const pt of points) {
    const value = valueOf(pt);
    if (value == null || value >= 0) continue;
    drawDot(ctx, x(pt.t), y(0), CHART_COLORS.spreadWarn);
  }
}

function drawBreakLine<T extends { t: number }>(
  ctx: CanvasRenderingContext2D,
  points: T[],
  valueOf: (pt: T) => number | null,
  x: (t: number) => number,
  y: (v: number) => number,
  color: string,
  width: number,
  dash: number[],
  alpha: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.lineJoin = "round";
  ctx.setLineDash(dash);
  ctx.beginPath();
  let drawing = false;
  for (const pt of points) {
    const value = valueOf(pt);
    if (value == null) {
      drawing = false;
      continue;
    }
    const px = x(pt.t);
    const py = y(value);
    if (!drawing) {
      ctx.moveTo(px, py);
      drawing = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

export function maxMetric(points: MetricPoint[]): number {
  let max = 0;
  for (const pt of points) {
    if (pt.volume != null && pt.volume > max) max = pt.volume;
    if (pt.liquidity != null && pt.liquidity > max) max = pt.liquidity;
  }
  return max;
}

export function maxVolume24hr(points: MetricPoint[]): number {
  let max = 0;
  for (const pt of points) {
    if (pt.volume24hr != null && pt.volume24hr > max) max = pt.volume24hr;
  }
  return max;
}

function fmtMetricTick(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function nearestMetric(series: MetricPoint[], t: number): MetricPoint | null {
  return nearestByTime(series, t);
}

function nearestDepth(series: DepthPoint[], t: number): DepthPoint | null {
  return nearestByTime(series, t);
}

function nearestByTime<T extends { t: number }>(series: T[], t: number): T | null {
  if (series.length === 0) return null;
  let best = series[0];
  let bestDist = Math.abs(series[0].t - t);
  for (const pt of series) {
    const dist = Math.abs(pt.t - t);
    if (dist < bestDist) {
      bestDist = dist;
      best = pt;
    }
  }
  return best;
}

function drawDot(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawArea(
  ctx: CanvasRenderingContext2D,
  points: PricePoint[],
  x: (t: number) => number,
  y: (p: number) => number,
  baselineY: number,
  fillStyle: string,
): void {
  if (points.length === 0) return;
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  ctx.moveTo(x(points[0].t), baselineY);
  points.forEach((pt) => {
    ctx.lineTo(x(pt.t), y(pt.p));
  });
  ctx.lineTo(x(points[points.length - 1].t), baselineY);
  ctx.closePath();
  ctx.fill();
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  points: PricePoint[],
  x: (t: number) => number,
  y: (p: number) => number,
  color: string,
  width: number,
  alpha: number,
): void {
  if (points.length === 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  points.forEach((pt, i) => {
    const px = x(pt.t);
    const py = y(pt.p);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawTriangle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  up: boolean,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (up) {
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx - r, cy + r);
    ctx.lineTo(cx + r, cy + r);
  } else {
    ctx.moveTo(cx, cy + r);
    ctx.lineTo(cx - r, cy - r);
    ctx.lineTo(cx + r, cy - r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function drawDiamond(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = CHART_COLORS.resolve;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

export interface CrosshairInfo {
  x: number;
  y: number;
  t: number;
  upPrice: number | null;
  downPrice: number | null;
  volume: number | null;
  volume24hr: number | null;
  liquidity: number | null;
  upSpread: number | null;
  downSpread: number | null;
  gammaSpread: number | null;
  upBidSize: number | null;
  upAskSize: number | null;
  downBidSize: number | null;
  downAskSize: number | null;
}

/**
 * Calcule le crosshair: position canvas + prix Up/Down au point le plus proche.
 * Utilise le viewport (zoom/pan) pour mapper mouseX → temps. Le Y du crosshair
 * suit la courbe mise en avant (Up par défaut).
 */
export function crosshairPoint(
  data: ChartData,
  mouseX: number,
  canvasWidth: number,
  canvasHeight: number,
): CrosshairInfo | null {
  const plotW = canvasWidth - PADDING.left - PADDING.right;
  const plotH = canvasHeight - PADDING.top - PADDING.bottom;
  if (plotW <= 0 || plotH <= 0) return null;
  if (mouseX < PADDING.left || mouseX > canvasWidth - PADDING.right) return null;

  const vp = data.viewport ?? { start: data.windowStart, end: data.windowEnd };
  const span = Math.max(vp.end - vp.start, 1);
  const t = vp.start + ((mouseX - PADDING.left) / plotW) * span;

  const upPoint = nearestInSeries(data.upHistory, t);
  const downPoint = nearestInSeries(data.downHistory, t);

  const anchor = data.highlightOutcomeIndex === 1 ? (downPoint ?? upPoint) : (upPoint ?? downPoint);
  const cy = anchor
    ? PADDING.top + (1 - Math.min(Math.max(anchor.p, 0), 1)) * plotH
    : PADDING.top + plotH / 2;

  const metric = data.showMetrics === false ? null : nearestMetric(data.metrics ?? [], t);
  const depth = nearestDepth(data.depth ?? [], t);

  return {
    x: mouseX,
    y: cy,
    t,
    upPrice: upPoint ? upPoint.p : null,
    downPrice: downPoint ? downPoint.p : null,
    volume: metric?.volume ?? null,
    volume24hr: metric?.volume24hr ?? null,
    liquidity: metric?.liquidity ?? null,
    upSpread: depth?.upSpread ?? null,
    downSpread: depth?.downSpread ?? null,
    gammaSpread: depth?.gammaSpread ?? null,
    upBidSize: depth?.upBidSize ?? null,
    upAskSize: depth?.upAskSize ?? null,
    downBidSize: depth?.downBidSize ?? null,
    downAskSize: depth?.downAskSize ?? null,
  };
}

function nearestInSeries(series: PricePoint[], t: number): PricePoint | null {
  return nearestByTime(series, t);
}
