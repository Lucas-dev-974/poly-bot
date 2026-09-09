import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import type {
  BookSnapshotPoint,
  ChartTarget,
  MarketView,
  PolymarketPosition,
  PricePoint,
  TokenBook,
  TradePoint,
} from "../../types";
import type { ChartData, CrosshairInfo, DepthPoint } from "../../utils/chart";
import { CHART_COLORS, PADDING, crosshairPoint, drawMarketChart, maxMetric, maxVolume24hr, outcomeColor } from "../../utils/chart";
import { l1Spread, parseSlugWindow } from "../../utils/market";
import { dateTimeStr, fmtPrice, fmtSizePair, fmtSpread, fmtUsd, fmtUsdCompact } from "../../utils/format";
import { markets } from "../../stores/marketStore";
import { polyPositions } from "../../stores/polyStore";
import { openPositionList, resolvedPositions } from "../../stores/positionStore";

interface ModalProps {
  target: ChartTarget;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Adaptateurs → ChartTarget (graphique toujours orienté Up / Down)
// ---------------------------------------------------------------------------

function pairLegs(p: PolymarketPosition): { up?: PolymarketPosition; down?: PolymarketPosition } {
  const siblings = polyPositions.filter((x) => x.conditionId && x.conditionId === p.conditionId);
  return {
    up: siblings.find((x) => x.outcomeIndex === 0) ?? (p.outcomeIndex === 0 ? p : undefined),
    down: siblings.find((x) => x.outcomeIndex === 1) ?? (p.outcomeIndex === 1 ? p : undefined),
  };
}

/**
 * Position Polymarket → ChartTarget. Les tokens Up/Down sont résolus à partir
 * des 2 jambes présentes dans la liste positions (ou de l'oppositeAsset), la
 * jambe cliquée est conservée dans `outcomeIndex` pour les cartes P&L et la
 * mise en avant de sa courbe.
 */
export function positionToChartTarget(p: PolymarketPosition): ChartTarget {
  const { up, down } = pairLegs(p);
  const clickedIsUp = p.outcomeIndex === 0;
  const upToken = up?.asset ?? (clickedIsUp ? p.asset : p.oppositeAsset) ?? "";
  const downToken = down?.asset ?? (clickedIsUp ? p.oppositeAsset : p.asset);
  const upOutcome = up?.outcome ?? (clickedIsUp ? p.outcome : p.oppositeOutcome) ?? "Up";
  const downOutcome = down?.outcome ?? (clickedIsUp ? p.oppositeOutcome : p.outcome) ?? "Down";
  const upSettled = up?.curPrice ?? (clickedIsUp ? p.curPrice : 1 - p.curPrice);
  return {
    title: p.title,
    slug: p.slug,
    conditionId: p.conditionId,
    upTokenId: upToken,
    downTokenId: downToken,
    upOutcome,
    downOutcome,
    outcomeIndex: p.outcomeIndex,
    avgPrice: p.avgPrice,
    curPrice: p.curPrice,
    size: p.size,
    cost: p.cost,
    cashPnl: p.cashPnl,
    percentPnl: p.percentPnl,
    currentValue: p.currentValue,
    closed: p.closed,
    timestamp: p.timestamp,
    settlePrice: upSettled,
  };
}

export function marketToChartTarget(m: MarketView): ChartTarget {
  const up = m.books.find((b) => b.outcomeIndex === 0) ?? m.books[0];
  const down = m.books.find((b) => b.outcomeIndex === 1) ?? m.books.find((b) => b !== up);
  return {
    title: m.title,
    slug: m.slug,
    conditionId: m.market.conditionId,
    upTokenId: up?.tokenId ?? "",
    downTokenId: down?.tokenId,
    upOutcome: up?.outcome ?? "Up",
    downOutcome: down?.outcome ?? "Down",
    outcomeIndex: null,
    windowStart: m.windowStart,
    windowEnd: m.windowEnd,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isResolved(target: ChartTarget): boolean {
  return Boolean(target.closed) || (target.curPrice != null && (target.curPrice <= 0.01 || target.curPrice >= 0.99));
}

function positionStatus(target: ChartTarget): string {
  if (target.closed) return "clôturée";
  if (target.curPrice != null && (target.curPrice <= 0.01 || target.curPrice >= 0.99)) return "résolue";
  return "active";
}

type DataSource = "api" | "local";
type PriceCurve = "bestBid" | "bestAsk" | "mid";

function priceFromBook(bid: number | null, ask: number | null, curve: PriceCurve): number | null {
  if (curve === "bestBid") return bid;
  if (curve === "bestAsk") return ask;
  return bid != null && ask != null ? (bid + ask) / 2 : null;
}

function snapshotsToPricePoints(snapshots: BookSnapshotPoint[], curve: PriceCurve): PricePoint[] {
  const out: PricePoint[] = [];
  for (const s of snapshots) {
    const p = priceFromBook(s.bestBid, s.bestAsk, curve);
    if (p != null) out.push({ t: Math.round(s.ts / 1000), p });
  }
  return out;
}

/** Point live capturé depuis le marketStore (valeurs copiées, pas de proxy). */
interface LiveBook {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
}

interface LivePoint {
  t: number;
  up: LiveBook | null;
  down: LiveBook | null;
  volume: number | null;
  volume24hr: number | null;
  liquidity: number | null;
  gammaSpread: number | null;
}

function parseMetric(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function bookValues(book: TokenBook | null | undefined): LiveBook | null {
  if (!book) return null;
  return {
    bid: book.bestBid ?? null,
    ask: book.bestAsk ?? null,
    bidSize: book.bestBidSize ?? null,
    askSize: book.bestAskSize ?? null,
  };
}

function emptyDepth(t: number): DepthPoint {
  return {
    t,
    upSpread: null,
    downSpread: null,
    gammaSpread: null,
    upBidSize: null,
    upAskSize: null,
    downBidSize: null,
    downAskSize: null,
  };
}

function mergeDepth(
  up: BookSnapshotPoint[],
  down: BookSnapshotPoint[],
  gamma: Array<{ t: number; spread: number | null }>,
  live: LivePoint[],
): DepthPoint[] {
  const byT = new Map<number, DepthPoint>();
  const ensure = (t: number): DepthPoint => {
    const existing = byT.get(t);
    if (existing) return existing;
    const created = emptyDepth(t);
    byT.set(t, created);
    return created;
  };
  for (const s of up) {
    const entry = ensure(Math.round(s.ts / 1000));
    entry.upSpread = l1Spread(s.bestBid, s.bestAsk);
    entry.upBidSize = s.bestBidSize ?? null;
    entry.upAskSize = s.bestAskSize ?? null;
  }
  for (const s of down) {
    const entry = ensure(Math.round(s.ts / 1000));
    entry.downSpread = l1Spread(s.bestBid, s.bestAsk);
    entry.downBidSize = s.bestBidSize ?? null;
    entry.downAskSize = s.bestAskSize ?? null;
  }
  for (const row of gamma) {
    ensure(row.t).gammaSpread = row.spread;
  }
  let lastT = 0;
  for (const t of byT.keys()) if (t > lastT) lastT = t;
  for (const lp of live) {
    if (lp.t <= lastT) continue;
    const entry = ensure(lp.t);
    if (lp.up) {
      entry.upSpread = l1Spread(lp.up.bid, lp.up.ask);
      entry.upBidSize = lp.up.bidSize;
      entry.upAskSize = lp.up.askSize;
    }
    if (lp.down) {
      entry.downSpread = l1Spread(lp.down.bid, lp.down.ask);
      entry.downBidSize = lp.down.bidSize;
      entry.downAskSize = lp.down.askSize;
    }
    if (lp.gammaSpread != null) entry.gammaSpread = lp.gammaSpread;
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

function fmtClock(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function positionTsSec(ts: number | undefined): number {
  if (ts == null || ts <= 0) return 0;
  return ts > 1e12 ? Math.floor(ts / 1000) : ts;
}

type TradeOrigin = "bot" | "api" | "position";
type DisplayTrade = TradePoint & {
  origin: TradeOrigin;
  dryRun?: boolean;
  strategyId?: "arb" | "barbell" | "edge-lead";
};

function strategyFromBotStore(tokenId: string | undefined): "arb" | "barbell" | "edge-lead" | undefined {
  if (!tokenId) return undefined;
  const bot = [...openPositionList(), ...resolvedPositions];
  return bot.find((p) => p.tokenId === tokenId)?.strategyId;
}

function tokenIdForOutcome(outcomeIndex: number, target: ChartTarget): string | undefined {
  if (outcomeIndex === 0) return target.upTokenId || undefined;
  if (outcomeIndex === 1) return target.downTokenId || undefined;
  return undefined;
}

/** Dernier recours : les 2 jambes de la liste positions (heure = heure de la position, imprécise). */
function pairTradesFromStore(conditionId: string): DisplayTrade[] {
  if (!conditionId) return [];
  return polyPositions
    .filter((p) => p.conditionId === conditionId && p.size > 0 && p.avgPrice > 0)
    .map((p) => ({
      timestamp: positionTsSec(p.timestamp),
      price: p.avgPrice,
      size: p.size,
      side: "BUY" as const,
      outcome: p.outcome,
      outcomeIndex: p.outcomeIndex,
      origin: "position" as const,
      strategyId: strategyFromBotStore(p.asset),
    }))
    .filter((t) => t.timestamp > 0);
}

/**
 * Fusion des sources par priorité, outcome par outcome :
 *  1. fills du bot (table orders) → heure et prix exacts,
 *  2. trades de l'API Data (souvent une seule jambe),
 *  3. positions de la liste (heure approximative).
 */
function buildTrades(bot: DisplayTrade[], apiTrades: DisplayTrade[], legs: DisplayTrade[]): DisplayTrade[] {
  const out: DisplayTrade[] = [...bot];
  const covered = new Set(bot.map((t) => t.outcomeIndex));
  const apiMissing = apiTrades.filter((t) => !covered.has(t.outcomeIndex));
  out.push(...apiMissing);
  for (const t of apiMissing) covered.add(t.outcomeIndex);
  out.push(...legs.filter((t) => !covered.has(t.outcomeIndex)));
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

// ---------------------------------------------------------------------------
// Composant
// ---------------------------------------------------------------------------

export function MarketHistoryModal(props: ModalProps): JSX.Element {
  const target = props.target;

  const [viewport, setViewport] = createSignal<{ start: number; end: number } | null>(null);
  const [hover, setHover] = createSignal<CrosshairInfo | null>(null);
  const [canvasEl, setCanvasEl] = createSignal<HTMLCanvasElement | undefined>(undefined);
  const [dataSource, setDataSource] = createSignal<DataSource>("local");
  const [curve, setCurve] = createSignal<PriceCurve>("mid");
  const [showMetrics, setShowMetrics] = createSignal(true);
  const [showSpread, setShowSpread] = createSignal(true);

  let dragging = false;
  let dragStartX = 0;
  let dragStartVp: { start: number; end: number } | null = null;

  // Fenêtre temporelle : windowStart/windowEnd explicites (MarketView), puis slug, puis ±30min.
  const window = createMemo(() => {
    if (target.windowStart != null && target.windowEnd != null) {
      return { start: target.windowStart, end: target.windowEnd };
    }
    const parsed = parseSlugWindow(target.slug);
    if (parsed) return parsed;
    const ts = Math.floor((target.timestamp ?? Date.now()) / 1000);
    return { start: ts - 1800, end: ts + 1800 };
  });

  const outcomeLabels = (): [string, string] => [target.upOutcome, target.downOutcome];

  // --- Sources de prix ---------------------------------------------------

  // Si le token Up est inconnu (oppositeAsset absent côté API), on interroge Down
  // et on dérive Up = 1 - Down.
  const primaryIsUp = Boolean(target.upTokenId);

  const [historyResource] = createResource(
    () => (dataSource() === "api" ? { w: window() } : null),
    async ({ w }) => {
      const hist = await api.marketHistory({
        tokenId: primaryIsUp ? target.upTokenId : (target.downTokenId ?? ""),
        oppositeTokenId: (primaryIsUp ? target.downTokenId : undefined) || undefined,
        startTs: w.start,
        endTs: w.end,
      });
      const derived = hist.history.map((pt) => ({ t: pt.t, p: 1 - pt.p }));
      return primaryIsUp
        ? { up: hist.history, down: hist.oppositeHistory ?? derived }
        : { up: derived, down: hist.history };
    },
  );

  const [localSnapshotsResource] = createResource(
    () => ({ w: window() }),
    async ({ w }) => {
      const fetchSnaps = async (tokenId: string | undefined): Promise<BookSnapshotPoint[]> =>
        tokenId ? (await api.localBookSnapshots({ tokenId, startTs: w.start, endTs: w.end })).snapshots : [];
      const [up, down] = await Promise.all([fetchSnaps(target.upTokenId), fetchSnaps(target.downTokenId)]);
      return { up, down };
    },
  );

  const [metricsResource] = createResource(
    () => (target.slug ? { slug: target.slug, w: window() } : null),
    async ({ slug, w }) =>
      (await api.localMarketSnapshots({ eventSlug: slug, startTs: w.start, endTs: w.end })).snapshots,
  );

  // --- Trades ---------------------------------------------------------------

  const [botFillsResource] = createResource(
    () => [target.upTokenId, target.downTokenId].filter((id): id is string => Boolean(id)),
    async (ids) => (ids.length > 0 ? api.botFills(ids) : { fills: [] }),
  );

  const [tradesResource] = createResource(
    () => target.conditionId || null,
    async (conditionId) => api.marketTrades(conditionId),
  );

  const displayTrades = createMemo<DisplayTrade[]>(() => {
    const bot: DisplayTrade[] = (botFillsResource()?.fills ?? []).map((f) => ({
      ...f,
      origin: "bot",
      strategyId: f.strategyId ?? strategyFromBotStore(f.tokenId),
    }));
    const apiTrades: DisplayTrade[] = (tradesResource()?.trades ?? []).map((t) => ({
      ...t,
      origin: "api",
      strategyId: strategyFromBotStore(tokenIdForOutcome(t.outcomeIndex, target)),
    }));
    return buildTrades(bot, apiTrades, pairTradesFromStore(target.conditionId));
  });

  // --- Live (SSE → marketStore) --------------------------------------------

  const liveMarket = createMemo(() => {
    const ids = [target.upTokenId, target.downTokenId].filter(Boolean);
    for (const market of Object.values(markets)) {
      if (market.books.some((b) => ids.includes(b.tokenId))) return market;
    }
    return null;
  });

  const liveBooks = createMemo<LivePoint | null>(() => {
    const market = liveMarket();
    if (!market) return null;
    return {
      t: Math.floor(Date.now() / 1000),
      up: bookValues(market.books.find((b) => b.tokenId === target.upTokenId)),
      down: target.downTokenId
        ? bookValues(market.books.find((b) => b.tokenId === target.downTokenId))
        : null,
      volume: parseMetric(market.market.volumeNum) ?? parseMetric(market.market.volume),
      volume24hr: parseMetric(market.market.volume24hr),
      liquidity: parseMetric(market.market.liquidityNum) ?? parseMetric(market.market.liquidity),
      gammaSpread: parseMetric(market.market.spread),
    };
  });

  // Accumule les points live pendant que le dialog est ouvert (sinon la courbe
  // sauterait du dernier snapshot DB directement au point courant).
  const [livePoints, setLivePoints] = createSignal<LivePoint[]>([]);
  createEffect(() => {
    const lp = liveBooks();
    if (!lp) return;
    setLivePoints((prev) => {
      const last = prev[prev.length - 1];
      if (last && lp.t <= last.t) return prev;
      return [...prev, lp];
    });
  });

  // --- Données du graphique -----------------------------------------------

  const chartData = createMemo<ChartData | null>(() => {
    const w = window();
    const finalUpPrice = isResolved(target) ? (target.settlePrice ?? null) : null;
    const base = {
      windowStart: w.start,
      windowEnd: w.end,
      trades: displayTrades(),
      highlightOutcomeIndex: target.outcomeIndex,
      finalUpPrice,
      outcomeLabels: outcomeLabels(),
      viewport: viewport() ?? undefined,
    };

    const metrics = (): NonNullable<ChartData["metrics"]> => {
      const snaps = metricsResource() ?? [];
      const out = snaps.map((s) => ({
        t: Math.round(s.ts / 1000),
        volume: s.volume ?? null,
        volume24hr: s.volume24hr ?? null,
        liquidity: s.liquidity ?? null,
      }));
      const lastT = out[out.length - 1]?.t ?? 0;
      for (const lp of livePoints()) {
        if (lp.t > lastT && (lp.volume != null || lp.liquidity != null || lp.volume24hr != null)) {
          out.push({
            t: lp.t,
            volume: lp.volume,
            volume24hr: lp.volume24hr,
            liquidity: lp.liquidity,
          });
        }
      }
      return out;
    };

    const depth = (): DepthPoint[] => {
      const local = localSnapshotsResource();
      const gamma = (metricsResource() ?? []).map((s) => ({
        t: Math.round(s.ts / 1000),
        spread: s.spread ?? null,
      }));
      return mergeDepth(local?.up ?? [], local?.down ?? [], gamma, livePoints());
    };

    const withMetrics = (data: ChartData): ChartData => ({
      ...data,
      metrics: metrics(),
      showMetrics: showMetrics(),
      depth: depth(),
      showSpread: showSpread(),
    });

    if (dataSource() === "api") {
      const hist = historyResource();
      if (!hist) return null;
      return withMetrics({ ...base, upHistory: hist.up, downHistory: hist.down });
    }

    const local = localSnapshotsResource();
    if (!local) return null;
    const c = curve();
    const invert = (pt: PricePoint): PricePoint => ({ t: pt.t, p: 1 - pt.p });
    let upHistory = snapshotsToPricePoints(local.up, c);
    let downHistory = snapshotsToPricePoints(local.down, c);
    if (downHistory.length === 0) downHistory = upHistory.map(invert);
    else if (upHistory.length === 0) upHistory = downHistory.map(invert);

    // Points live postérieurs au dernier snapshot DB.
    const lastUpT = upHistory[upHistory.length - 1]?.t ?? 0;
    const lastDownT = downHistory[downHistory.length - 1]?.t ?? 0;
    for (const lp of livePoints()) {
      const liveUp = lp.up ? priceFromBook(lp.up.bid, lp.up.ask, c) : null;
      const liveDown = lp.down ? priceFromBook(lp.down.bid, lp.down.ask, c) : null;
      const up = liveUp ?? (liveDown != null ? 1 - liveDown : null);
      const down = liveDown ?? (liveUp != null ? 1 - liveUp : null);
      if (lp.t > lastUpT && up != null) upHistory.push({ t: lp.t, p: up });
      if (lp.t > lastDownT && down != null) downHistory.push({ t: lp.t, p: down });
    }

    return withMetrics({ ...base, upHistory, downHistory });
  });

  const unlabeledVolLiqMax = createMemo(() => {
    if (!showMetrics()) return 0;
    const metrics = chartData()?.metrics ?? [];
    if (maxVolume24hr(metrics) <= 0) return 0;
    return maxMetric(metrics);
  });

  // Dessin : redraw quand data, hover ou canvas changent.
  createEffect(() => {
    const data = chartData();
    const canvas = canvasEl();
    if (data && canvas) drawMarketChart(canvas, data, hover());
  });

  // Redessine au resize.
  createEffect(() => {
    const canvas = canvasEl();
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const data = chartData();
      if (data) drawMarketChart(canvas, data, hover());
    });
    ro.observe(canvas);
    onCleanup(() => ro.disconnect());
  });

  // --- Interactions ---------------------------------------------------------

  function clampVp(start: number, end: number, data: ChartData): { start: number; end: number } {
    let s = start;
    let e = end;
    if (s < data.windowStart) { e += data.windowStart - s; s = data.windowStart; }
    if (e > data.windowEnd) { s -= e - data.windowEnd; e = data.windowEnd; }
    return { start: Math.max(s, data.windowStart), end: Math.min(e, data.windowEnd) };
  }

  function handleWheel(e: WheelEvent): void {
    const canvas = canvasEl();
    const data = chartData();
    if (!canvas || !data) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const plotW = rect.width - PADDING.left - PADDING.right;
    if (plotW <= 0) return;
    const vp = viewport() ?? { start: data.windowStart, end: data.windowEnd };
    const span = vp.end - vp.start;
    const ratio = Math.min(Math.max((e.clientX - rect.left - PADDING.left) / plotW, 0), 1);
    const tAtCursor = vp.start + ratio * span;
    const factor = e.deltaY < 0 ? 1 / 1.15 : 1.15;
    const newSpan = Math.min(Math.max(span * factor, 30), data.windowEnd - data.windowStart);
    const newStart = tAtCursor - ratio * newSpan;
    setViewport(clampVp(newStart, newStart + newSpan, data));
  }

  function handleMouseDown(e: MouseEvent): void {
    const data = chartData();
    if (!data) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartVp = viewport() ?? { start: data.windowStart, end: data.windowEnd };
  }

  function handleMouseMove(e: MouseEvent): void {
    const canvas = canvasEl();
    const data = chartData();
    if (!canvas || !data) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    if (dragging && dragStartVp) {
      const plotW = rect.width - PADDING.left - PADDING.right;
      if (plotW <= 0) return;
      const shiftSec = ((e.clientX - dragStartX) * (dragStartVp.end - dragStartVp.start)) / plotW;
      setViewport(clampVp(dragStartVp.start - shiftSec, dragStartVp.end - shiftSec, data));
    } else {
      setHover(crosshairPoint(data, mouseX, rect.width, rect.height));
    }
  }

  function handleMouseLeave(): void {
    setHover(null);
    dragging = false;
  }

  function zoomBy(factor: number): void {
    const data = chartData();
    if (!data) return;
    const vp = viewport() ?? { start: data.windowStart, end: data.windowEnd };
    const span = vp.end - vp.start;
    const center = (vp.start + vp.end) / 2;
    const newSpan = Math.min(Math.max(span * factor, 30), data.windowEnd - data.windowStart);
    setViewport(clampVp(center - newSpan / 2, center + newSpan / 2, data));
  }

  onMount(() => {
    const onUp = () => { dragging = false; };
    globalThis.addEventListener("mouseup", onUp);
    onCleanup(() => globalThis.removeEventListener("mouseup", onUp));
  });

  // --- État de chargement ---------------------------------------------------

  const loading = createMemo(() =>
    dataSource() === "api" ? historyResource.loading : localSnapshotsResource.loading,
  );
  const error = createMemo(() =>
    (dataSource() === "api" ? historyResource.error : localSnapshotsResource.error) ||
    metricsResource.error ||
    botFillsResource.error ||
    tradesResource.error,
  );

  const cost = target.cost != null && target.cost > 0
    ? target.cost
    : target.size != null && target.avgPrice != null
      ? target.size * target.avgPrice
      : 0;

  const clickedLabel = () =>
    target.outcomeIndex === 1 ? target.downOutcome : target.outcomeIndex === 0 ? target.upOutcome : null;

  return (
    <div
      class="modal-overlay"
      onClick={props.onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div class="modal market-history-modal" onClick={(e) => e.stopPropagation()}>
        <div class="mh-header">
          <div>
            <h3>{target.title}</h3>
            <span class="muted">
              {dateTimeStr(window().start * 1000)} → {dateTimeStr(window().end * 1000)}
            </span>
          </div>
          <button class="btn" type="button" onClick={props.onClose}>
            Fermer
          </button>
          <div class="mh-source-toggle">
            <select
              class="mh-source-select"
              value={dataSource()}
              onChange={(e) => setDataSource(e.currentTarget.value as DataSource)}
            >
              <option value="api">API Polymarket</option>
              <option value="local">Données locales</option>
            </select>
            <Show when={dataSource() === "local"}>
              <select
                class="mh-curve-select"
                value={curve()}
                onChange={(e) => setCurve(e.currentTarget.value as PriceCurve)}
              >
                <option value="mid">Prix Mid</option>
                <option value="bestBid">Best Bid</option>
                <option value="bestAsk">Best Ask</option>
              </select>
            </Show>
            <Show when={dataSource() === "local" && liveBooks()}>
              <span class="mh-live-badge">LIVE</span>
            </Show>
          </div>
        </div>

        {/* Cartes détails de position (masquées pour une MarketView sans champs position) */}
        <Show when={target.avgPrice != null && target.curPrice != null}>
          <div class="mh-cards">
            <div class="mh-card">
              <span class="mh-card-label">Entrée</span>
              <span class="mh-card-value">
                <Show when={clickedLabel()}>
                  {(label) => (
                    <span style={{ color: outcomeColor(target.outcomeIndex ?? 0), "margin-right": "6px" }}>
                      {label()}
                    </span>
                  )}
                </Show>
                {fmtPrice(target.avgPrice!)}
              </span>
              <span class="muted">taille {target.size} · coût {fmtUsd(cost)}</span>
            </div>
            <div class="mh-card">
              <span class="mh-card-label">Actuel</span>
              <span class="mh-card-value">{fmtPrice(target.curPrice!)}</span>
              <span class="muted">valeur {fmtUsd(target.currentValue ?? 0)}</span>
            </div>
            <div class="mh-card">
              <span class="mh-card-label">P&L</span>
              <span class={`mh-card-value ${(target.cashPnl ?? 0) >= 0 ? "ok" : "err"}`}>
                {fmtUsd(target.cashPnl ?? 0)} ({(target.percentPnl ?? 0).toFixed(1)}%)
              </span>
              <span class="muted">statut {positionStatus(target)}</span>
            </div>
          </div>
        </Show>

        {/* Légende + toolbar (hors du canvas pour ne pas masquer l'axe des prix) */}
        <div class="mh-chart-bar">
          <div class="mh-legend">
            <span class="mh-legend-item">
              <span class="mh-dot" style={{ background: CHART_COLORS.up }} />
              {target.upOutcome}
            </span>
            <span class="mh-legend-item">
              <span class="mh-dot" style={{ background: CHART_COLORS.down }} />
              {target.downOutcome}
            </span>
            <span class="mh-legend-item">
              <span class="mh-triangle" style={{ color: CHART_COLORS.up }}>▲</span>
              entrée {target.upOutcome}
            </span>
            <span class="mh-legend-item">
              <span class="mh-triangle" style={{ color: CHART_COLORS.down }}>▲</span>
              entrée {target.downOutcome}
            </span>
            <span class="mh-legend-item">
              <span class="mh-triangle" style={{ color: CHART_COLORS.resolve }}>◆</span>
              résolution
            </span>
            <button
              class={`mh-legend-toggle${showMetrics() ? " is-on" : ""}`}
              type="button"
              title="Volume 15m, liquidité et volume 24h"
              onClick={() => setShowMetrics((v) => !v)}
            >
              <span class="mh-legend-item">
                <span class="mh-dot" style={{ background: CHART_COLORS.volume }} />
                volume
              </span>
              <span class="mh-legend-item">
                <span class="mh-dash" style={{ "border-color": CHART_COLORS.liquidity }} />
                liquidité
              </span>
              <span class="mh-legend-item">
                <span class="mh-dot" style={{ background: CHART_COLORS.volume24hr }} />
                vol 24h
              </span>
              <Show when={unlabeledVolLiqMax() > 0}>
                <span class="mh-scale-hint">vol/liq ≤ {fmtUsdCompact(unlabeledVolLiqMax())}</span>
              </Show>
            </button>
            <button
              class={`mh-legend-toggle${showSpread() ? " is-on" : ""}`}
              type="button"
              title="Spread L1 (ask − bid)"
              onClick={() => setShowSpread((v) => !v)}
            >
              <span class="mh-legend-item">
                <span class="mh-dash" style={{ "border-color": CHART_COLORS.up }} />
                spread
              </span>
            </button>
          </div>
          <div class="mh-chart-toolbar">
            <button class="mh-tool-btn" type="button" title="Zoom +" onClick={() => zoomBy(1 / 1.3)}>+</button>
            <button class="mh-tool-btn" type="button" title="Zoom -" onClick={() => zoomBy(1.3)}>&minus;</button>
            <button class="mh-tool-btn" type="button" title="Réinitialiser le zoom" onClick={() => setViewport(null)}>&#x27F2;</button>
          </div>
        </div>

        {/* Graphique */}
        <div class="mh-canvas-wrap">
          <Show when={loading()} fallback={
            <canvas
              ref={(el) => {
                setCanvasEl(el);
                // Wheel non-passif pour pouvoir bloquer le scroll de la page.
                el.addEventListener("wheel", handleWheel, { passive: false });
                onCleanup(() => {
                  el.removeEventListener("wheel", handleWheel);
                  setCanvasEl(undefined);
                });
              }}
              class="mh-canvas"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              onDblClick={() => setViewport(null)}
            />
          }>
            <div class="mh-loader">Chargement…</div>
          </Show>
          <Show when={!loading() && error()}>
            <div class="mh-error">Erreur : {String(error())}</div>
          </Show>
          <Show when={!loading() && !error() && chartData() && chartData()!.upHistory.length === 0}>
            <div class="mh-error">Aucune donnée de prix disponible pour ce marché.</div>
          </Show>
          <Show when={hover()}>
            {(h) => (
              <div
                class="mh-tooltip"
                style={{
                  left: `${h().x + 12}px`,
                  top: `${h().y - 10}px`,
                }}
              >
                <div>{new Date(h().t * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
                <div style={{ color: CHART_COLORS.up }}>{target.upOutcome} : {h().upPrice != null ? (h().upPrice as number).toFixed(3) : "—"}</div>
                <div style={{ color: CHART_COLORS.down }}>{target.downOutcome} : {h().downPrice != null ? (h().downPrice as number).toFixed(3) : "—"}</div>
                <Show when={showMetrics()}>
                  <div style={{ color: CHART_COLORS.volume }}>Vol : {fmtUsdCompact(h().volume)}</div>
                  <div style={{ color: CHART_COLORS.liquidity }}>Liq : {fmtUsdCompact(h().liquidity)}</div>
                  <div style={{ color: CHART_COLORS.volume24hr }}>Vol 24h : {fmtUsdCompact(h().volume24hr)}</div>
                </Show>
                <Show when={showSpread()}>
                  <Show
                    when={h().upSpread != null || h().downSpread != null}
                    fallback={
                      <div style={{ color: (h().gammaSpread ?? 0) < 0 ? CHART_COLORS.spreadWarn : CHART_COLORS.spread }}>
                        Spread : {fmtSpread(h().gammaSpread)}
                      </div>
                    }
                  >
                    <div style={{ color: (h().upSpread ?? 0) < 0 ? CHART_COLORS.spreadWarn : CHART_COLORS.up }}>
                      Spread {target.upOutcome} : {fmtSpread(h().upSpread)}
                    </div>
                    <div style={{ color: (h().downSpread ?? 0) < 0 ? CHART_COLORS.spreadWarn : CHART_COLORS.down }}>
                      Spread {target.downOutcome} : {fmtSpread(h().downSpread)}
                    </div>
                  </Show>
                </Show>
                <Show
                  when={
                    h().upBidSize != null ||
                    h().upAskSize != null ||
                    h().downBidSize != null ||
                    h().downAskSize != null
                  }
                >
                  <div style={{ color: CHART_COLORS.up }}>Sz {target.upOutcome} : {fmtSizePair(h().upBidSize, h().upAskSize)}</div>
                  <div style={{ color: CHART_COLORS.down }}>Sz {target.downOutcome} : {fmtSizePair(h().downBidSize, h().downAskSize)}</div>
                </Show>
              </div>
            )}
          </Show>
        </div>

        {/* Trades */}
        <div class="mh-trades">
          <h4>Trades ({displayTrades().length})</h4>
          <Show
            when={displayTrades().length > 0}
            fallback={<p class="muted">Aucun trade enregistré pour ce marché.</p>}
          >
            <div class="mh-trades-list">
              <table>
                <thead>
                  <tr>
                    <th>Heure</th>
                    <th>Côté</th>
                    <th>Outcome</th>
                    <th>Prix</th>
                    <th>Taille</th>
                    <th>Moteur</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={displayTrades()}>
                    {(trade) => (
                      <tr>
                        <td>{fmtClock(trade.timestamp)}</td>
                        <td class={trade.side === "BUY" ? "ok" : "err"}>{trade.side}</td>
                        <td style={{ color: outcomeColor(trade.outcomeIndex) }}>{trade.outcome}</td>
                        <td>{fmtPrice(trade.price)}</td>
                        <td>{trade.size}</td>
                        <td>{trade.strategyId ?? "—"}</td>
                        <td class="muted">
                          {trade.origin === "bot" ? (trade.dryRun ? "bot (sim)" : "bot") : trade.origin === "api" ? "API" : "position"}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
