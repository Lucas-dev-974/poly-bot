import type { PricePoint, TradePoint } from "../types";

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
}

export const CHART_COLORS = {
  up: "#3ee07a",
  down: "#ff5b5b",
  upFill: "rgba(62,224,122,0.08)",
  downFill: "rgba(255,91,91,0.08)",
  grid: "rgba(255,255,255,0.05)",
  text: "rgba(255,255,255,0.55)",
  resolve: "#f59e0b",
  resolveLine: "rgba(245,158,11,0.4)",
  crosshair: "rgba(255,255,255,0.3)",
};

export const PADDING = { top: 14, right: 56, bottom: 32, left: 12 };
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
  }
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

  return {
    x: mouseX,
    y: cy,
    t,
    upPrice: upPoint ? upPoint.p : null,
    downPrice: downPoint ? downPoint.p : null,
  };
}

function nearestInSeries(series: PricePoint[], t: number): PricePoint | null {
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
