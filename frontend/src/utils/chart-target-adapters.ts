import type { SimTrade } from "../api/client";
import type {
  ChartTarget,
  MarketView,
  PolymarketPosition,
  SimulatedPosition,
} from "../types";
import { parseSlugWindow } from "./market";
import { markets } from "../stores/marketStore";
import { polyPositions } from "../stores/polyStore";
import { simJournal } from "../stores/simStore";

/** Constante miroir du backend (position-resolver.ts : VOID_SETTLEMENT_PRICE = 0.5). */
const VOID_SETTLEMENT = 0.5;

function positionTsSec(ts: number | undefined): number {
  if (ts == null || ts <= 0) return 0;
  return ts > 1e12 ? Math.floor(ts / 1000) : ts;
}

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

/**
 * Position bot (SimulatedPosition) → ChartTarget. Les tokens Up/Down et les
 * labels d'outcome sont résolus depuis le book live du store markets (même
 * eventSlug) ; à défaut, seule la jambe cliquée est connue. Le conditionId est
 * retrouvé via la liste des positions Polymarket (match par tokenId) pour
 * activer les trades Data API. Le prix actuel / P&L sont dérivés du bid live.
 */
export function simulatedPositionToChartTarget(p: SimulatedPosition): ChartTarget {
  const market = markets[p.eventSlug];
  const upBook = market?.books.find((b) => b.outcomeIndex === 0);
  const downBook = market?.books.find((b) => b.outcomeIndex === 1);
  const clickedIsUp = p.outcomeIndex === 0;
  const upTokenId = upBook?.tokenId ?? (clickedIsUp ? p.tokenId : undefined);
  const downTokenId = downBook?.tokenId ?? (clickedIsUp ? undefined : p.tokenId);
  const clickedBook = market?.books.find((b) => b.tokenId === p.tokenId);
  const cost = p.cost > 0 ? p.cost : p.fillPrice * p.size;
  const parsed = parseSlugWindow(p.eventSlug);
  const isSettled = p.status !== "open";

  const settleClicked =
    p.status === "won" ? 1 : p.status === "void" ? VOID_SETTLEMENT : p.status === "lost" ? 0 : null;

  const curPrice = isSettled
    ? p.status === "sold"
      ? p.sellPrice ?? null
      : settleClicked
    : clickedBook?.bestBid ?? clickedBook?.bestAsk ?? null;
  const cashPnl = p.pnl ?? (curPrice != null ? (curPrice - p.fillPrice) * p.size : undefined);

  let sellPrice: number | undefined;
  let sellTs: number | undefined;
  if (p.status === "sold" && p.sellPrice != null) {
    sellPrice = p.sellPrice;
    const exitRow = simJournal().find(
      (t) =>
        t.eventSlug === p.eventSlug &&
        t.outcome === p.outcome &&
        t.side === "SELL" &&
        t.filled === 1 &&
        Math.abs((t.fillPrice ?? -1) - p.sellPrice!) < 1e-6,
    );
    sellTs = exitRow
      ? positionTsSec(exitRow.ts)
      : Math.min((p.resolvedAt ?? p.windowEnd * 1000) / 1000, p.windowEnd);
  }

  const settlePrice =
    settleClicked != null ? (clickedIsUp ? settleClicked : 1 - settleClicked) : undefined;

  return {
    title: p.eventTitle,
    slug: p.eventSlug,
    conditionId: polyPositions.find((x) => x.asset === p.tokenId)?.conditionId ?? "",
    upTokenId: upTokenId ?? "",
    downTokenId,
    upOutcome: upBook?.outcome ?? (clickedIsUp ? p.outcome : "Up"),
    downOutcome: downBook?.outcome ?? (clickedIsUp ? "Down" : p.outcome),
    outcomeIndex: p.outcomeIndex,
    windowStart: parsed?.start,
    windowEnd: parsed?.end ?? p.windowEnd,
    avgPrice: p.fillPrice,
    curPrice: curPrice ?? undefined,
    size: p.size,
    cost,
    cashPnl,
    percentPnl: cashPnl != null && cost > 0 ? (cashPnl / cost) * 100 : undefined,
    currentValue: curPrice != null ? curPrice * p.size : undefined,
    closed: isSettled,
    settlePrice,
    sellPrice,
    sellTs,
  };
}

/**
 * Ligne du journal des ordres simulés (sim_trades) → ChartTarget. Le journal
 * ne porte ni tokenId ni fenêtre explicite : tokens/labels/outcomeIndex sont
 * résolus depuis le book live du store markets (même eventSlug), la fenêtre
 * depuis le slug.
 */
export function simTradeToChartTarget(t: SimTrade): ChartTarget {
  const market = markets[t.eventSlug];
  const upBook = market?.books.find((b) => b.outcomeIndex === 0);
  const downBook = market?.books.find((b) => b.outcomeIndex === 1);
  const parsed = parseSlugWindow(t.eventSlug);
  const label = t.outcome.toLowerCase();
  const upOutcome = upBook?.outcome ?? "Up";
  const downOutcome = downBook?.outcome ?? "Down";
  const outcomeIndex =
    label === upOutcome.toLowerCase() ? 0 : label === downOutcome.toLowerCase() ? 1 : t.outcome === "Up" ? 0 : 1;
  return {
    title: market?.title ?? t.eventSlug,
    slug: t.eventSlug,
    conditionId: "",
    upTokenId: upBook?.tokenId ?? "",
    downTokenId: downBook?.tokenId,
    upOutcome,
    downOutcome,
    outcomeIndex,
    windowStart: parsed?.start,
    windowEnd: parsed?.end ?? Math.floor(t.ts / 1000) + 1800,
    avgPrice: t.fillPrice ?? t.limitPrice,
    size: t.size,
    closed: false,
  };
}
