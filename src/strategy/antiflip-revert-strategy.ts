import type { BotConfig } from "../config.js";
import type { TradeOpportunity } from "../types.js";
import { tickSizeFromMarket, windowSecondsFromSlug } from "../utils/market.js";
import { computeSize, MIN_CLOB_SHARES } from "../utils/prices.js";
import { round2 } from "./predicates.js";
import type {
  CheapOrderAction,
  DefendContext,
  EdgeOrderAction,
  HedgePostContext,
  HedgePostDecision,
  RestingCheapContext,
  RestingEdgeContext,
  StrategyContext,
  TradingStrategy,
} from "./trading-strategy.js";

/**
 * Antiflip-revert — acheter l'ANCIEN favori après un retournement d'identité.
 *
 * Signal empirique (backtest calibré 2026-09-15, 393 fenêtres BTC 15m, sim
 * reproduite par le runner officiel à ±0.3 % fills) : quand le favori FLIPPE
 * (identité du leader inversée) après `antiflipMinElapsedSec`, le marché
 * SUR-réagit — l'ancien favori, replacé ~0.35-0.45, re-gagne ~52 % du temps
 * (EV +9¢/share vs prix moyen 0.43). Le flip doit être FRAIS (≤
 * `antiflipFlipLookbackMs`) et le nouveau favori incertain
 * [antiflipFavAskMin, antiflipFavAskMax] (0.45-0.65 par défaut, calibration
 * 15m) ; au-delà le marché a digéré le retournement et l'edge disparaît
 * (contrôle causal : flip ancien → +$3 ; flip récent → +$623).
 *
 * Calibration 5m (audits/5min-strategies, 836 fenêtres BTC 5m, WR 50-55 %,
 * EV +0.2 à +0.7 $/trade sur 5 shares) : trois variantes retenues, activées
 * par presets —
 *   - A "re-entry" : délai `antiflipEntryDelaySec` (5 s) après le flip avant
 *     la première entrée autorisée.
 *   - H "sharp"    : le déchu doit avoir décoté de ≥ `antiflipSharpDropMin`
 *     sous son niveau pré-flip (chute brutale = surréaction). Le niveau
 *     pré-flip = sommet des asks du leader observés sur les derniers ticks
 *     (équivalent live du `seriesAtOrBefore(depSeries, flipT-3s)` de la sim).
 *   - K "bounce"   : suivre le plancher post-flip du déchu ; entrer quand son
 *     ask a rebondi de ≥ `antiflipBounceMin` depuis ce plancher et reste ≥
 *     `antiflipBounceFloor` (marché ne le condamne pas) et ≤ bandMax.
 *
 * `antiflip5mOnly` (presets 5m) : refuse toute entrée sur un marché dont la
 * fenêtre n'est pas exactement 5 minutes — le backtest 5m n'est pas
 * transférable au 15m (dynamiques différentes) et réciproquement. Le gate vit
 * DANS le moteur pour couvrir à la fois le live et le paper trading (la sim
 * partage l'univers scanné du bot).
 *
 * Exécution : un seul FOK BUY du favori déchu, hold jusqu'à résolution.
 * Pas de hedge, pas de défense. Un seul déclenchement par paire
 * (getFilledCheapSizeForPair / countLegsByKind), retry après un FOK tué.
 */
interface LeaderAskSample {
  ts: number;
  ask: number;
}

interface FlipState {
  /** Timestamp du dernier changement d'identité du favori (ms), null si aucun. */
  lastFlipTs: number | null;
  /** Identité estimée du favori au tick précédent (null = pas encore connu). */
  prevFavIdx: 0 | 1 | null;
  /** Asks du LEADER (futur déchu) observés sur les derniers ticks pré-flip. */
  leaderAsks: LeaderAskSample[];
  /** Sommet pré-flip du déchu, figé au flip (filtre sharp-drop). */
  deposedPreFlipPeak: number | null;
  /** Plancher de l'ask du déchu depuis flip+delay (filtre bounce). */
  deposedPostFlipLow: number | null;
  /** Dernier tick vu pour la purge des états de fenêtres clôturées. */
  lastSeenTs: number;
}

/** Fenêtre glissante du sommet pré-flip (~5 ticks à 1 Hz, sim calibrée à 3 s). */
const LEADER_ASK_WINDOW = 6;
/** Staleness minimale d'un sample pour compter comme "niveau pré-flip". */
const LEADER_ASK_STALE_MS = 1_000;

export class AntiflipRevertStrategy implements TradingStrategy {
  readonly id = "antiflip-revert" as const;
  readonly label =
    "Antiflip-revert: FOK buy the deposed favorite right after an identity flip; hold to resolve (no hedge)";
  readonly leadsWithEdge = false;

  private readonly states = new Map<string, FlipState>();

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];

    if (books.filter((b) => b.bestAsk !== null).length < 2) {
      return opportunities;
    }

    const nowMs = ctx.nowMs ?? Date.now();
    const pairId = `${event.slug}:${event.windowEnd}`;
    const elapsedSec = nowMs / 1000 - event.windowStart;

    // Identité du favori instantanée (tie -> Up, comme dans la sim calibrée).
    const up = books.find((b) => b.outcomeIndex === 0) ?? null;
    const down = books.find((b) => b.outcomeIndex === 1) ?? null;
    if (!up || !down) return opportunities;
    const favIdx: 0 | 1 | null =
      up.bestAsk != null && down.bestAsk == null
        ? 0
        : down.bestAsk != null && up.bestAsk == null
          ? 1
          : up.bestAsk != null && down.bestAsk != null
            ? up.bestAsk >= down.bestAsk
              ? 0
              : 1
            : null;
    if (favIdx == null) return opportunities;
    const favAsk = favIdx === 0 ? up.bestAsk : down.bestAsk;
    if (favAsk == null) return opportunities;
    const deposed = favIdx === 0 ? down : up;
    const deposedAsk = favIdx === 0 ? down.bestAsk : up.bestAsk;

    const state = this.stateFor(pairId, nowMs);
    // Flip détecté : changement d'identité du favori entre deux ticks. Au flip,
    // le sommet pré-flip du déchu (= ancien leader) est figé depuis l'historique
    // glissant, et le suivi du plancher post-flip repart de zéro.
    if (state.prevFavIdx !== null && state.prevFavIdx !== favIdx) {
      state.lastFlipTs = nowMs;
      state.deposedPreFlipPeak = preFlipPeak(state.leaderAsks, nowMs);
      state.deposedPostFlipLow = null;
    }
    state.prevFavIdx = favIdx;
    state.lastSeenTs = nowMs;

    // Tracking continu (aucun ordre émis) : l'historique du leader pour le
    // prochain flip, et le plancher du déchu pour le mode bounce.
    state.leaderAsks.push({ ts: nowMs, ask: favAsk });
    if (state.leaderAsks.length > LEADER_ASK_WINDOW) state.leaderAsks.shift();
    if (
      deposedAsk != null &&
      state.lastFlipTs != null &&
      config.antiflipEntryDelaySec > 0 &&
      nowMs - state.lastFlipTs >= config.antiflipEntryDelaySec * 1000
    ) {
      // Fidèle à la sim K : le plancher n'est suivi qu'à partir de flip+delay.
      state.deposedPostFlipLow =
        state.deposedPostFlipLow == null
          ? deposedAsk
          : Math.min(state.deposedPostFlipLow, deposedAsk);
    }

    // Un seul déclenchement par paire ; un FOK tué (profondeur) reste retirable.
    if (tracker.getFilledCheapSizeForPair(pairId) > 0) {
      return opportunities;
    }
    if (tracker.countLegsByKind(pairId, "cheap") > 0) {
      return opportunities;
    }

    // Contrainte marché : presets 5m uniquement (backtest non transférable).
    if (config.antiflip5mOnly && windowSecondsFromSlug(event.slug) !== 300) {
      return opportunities;
    }

    if (elapsedSec < config.antiflipMinElapsedSec) {
      return opportunities;
    }
    if (
      config.antiflipMaxElapsedSec != null &&
      elapsedSec > config.antiflipMaxElapsedSec
    ) {
      return opportunities;
    }

    // Gate 1 : flip frais.
    if (state.lastFlipTs == null) return opportunities;
    if (nowMs - state.lastFlipTs > config.antiflipFlipLookbackMs) {
      return opportunities;
    }
    // Gate 2 : le NOUVEAU favori doit être incertain [favMin, favMax].
    if (favAsk < config.antiflipFavAskMin || favAsk > config.antiflipFavAskMax) {
      return opportunities;
    }
    // Gate 3 : le favori déchu doit coter dans la bande et passer le floor.
    if (deposed.bestAsk == null) return opportunities;
    if (
      deposed.bestAsk < config.antiflipBandMin ||
      deposed.bestAsk > config.antiflipBandMax
    ) {
      return opportunities;
    }
    if (
      config.antiflipDeposedAskMin != null &&
      deposed.bestAsk < config.antiflipDeposedAskMin
    ) {
      return opportunities;
    }
    // Gate 4 : délai post-flip (preset A : attendre l'amorce du retracement).
    if (
      config.antiflipEntryDelaySec > 0 &&
      nowMs - state.lastFlipTs < config.antiflipEntryDelaySec * 1000
    ) {
      return opportunities;
    }
    // Gate 5 (mode H sharp) : chute du déchu depuis son sommet pré-flip.
    if (
      config.antiflipSharpDropMin > 0 &&
      (state.deposedPreFlipPeak == null ||
        state.deposedPreFlipPeak - deposed.bestAsk < config.antiflipSharpDropMin)
    ) {
      return opportunities;
    }
    // Gate 6 (mode K bounce) : rebond depuis le plancher post-flip + floor.
    if (config.antiflipBounceMin > 0) {
      if (
        state.deposedPostFlipLow == null ||
        deposed.bestAsk - state.deposedPostFlipLow < config.antiflipBounceMin
      ) {
        return opportunities;
      }
      if (
        config.antiflipBounceFloor != null &&
        deposed.bestAsk < config.antiflipBounceFloor
      ) {
        return opportunities;
      }
    }
    // Gate spread sur le token ciblé (le déchu).
    if (deposed.bestBid != null && deposed.bestAsk - deposed.bestBid > config.antiflipMaxSpread) {
      return opportunities;
    }

    const size = computeSize(
      config.antiflipOrderUsdc,
      deposed.bestAsk,
      config.maxSharesPerOrder,
    );
    if (size === null || size < MIN_CLOB_SHARES) return opportunities;

    // Profondeur : le FOK exige la size complète au best ask du déchu.
    if (deposed.bestAskSize != null && deposed.bestAskSize < size) {
      return opportunities;
    }

    const tradeKey = tracker.makeKey(event.slug, deposed.outcome, "cheap", round2(deposed.bestAsk));
    if (tracker.has(tradeKey)) return opportunities;

    opportunities.push({
      kind: "cheap",
      event,
      token: deposed,
      price: round2(deposed.bestAsk),
      size,
      tickSize: tickSizeFromMarket(event.market),
      negRisk: event.market.negRisk,
      tradeKey,
      pairId,
      orderType: "FOK",
    });
    return opportunities;
  }

  /**
   * État par paire : dernier flip + favori précédent + historique du leader +
   * sommet/plancher du déchu. Les fenêtres passées sont purgées (le bot
   * tourne des jours, le Map doit rester borné).
   */
  private stateFor(pairId: string, nowMs: number): FlipState {
    for (const [key, st] of this.states) {
      if (nowMs - st.lastSeenTs > 2_700_000) {
        // ~9 fenêtres 5m / ~3 fenêtres 15m : la paire ne repassera jamais.
        this.states.delete(key);
      }
    }
    let state = this.states.get(pairId);
    if (!state) {
      state = {
        lastFlipTs: null,
        prevFavIdx: null,
        leaderAsks: [],
        deposedPreFlipPeak: null,
        deposedPostFlipLow: null,
        lastSeenTs: nowMs,
      };
      this.states.set(pairId, state);
    }
    return state;
  }

  cheapOrderAction(_ctx: RestingCheapContext): CheapOrderAction {
    return "keep";
  }

  edgeOrderAction(_ctx: RestingEdgeContext): EdgeOrderAction {
    return "keep";
  }

  shouldDefend(_ctx: DefendContext): boolean {
    return false;
  }

  defendShares(_ctx: DefendContext): number {
    return 0;
  }

  hedgeAtPostTime(_ctx: HedgePostContext): HedgePostDecision {
    return { action: "skip", reason: "antiflip-revert-no-hedge" };
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}

/**
 * Sommet pré-flip du déchu : max des asks du leader observés il y a au moins
 * ~1 s au moment du flip (les samples trop frais reflètent déjà la décote
 * post-flip). Fallback : max de tous les samples disponibles.
 */
function preFlipPeak(samples: LeaderAskSample[], flipTs: number): number | null {
  if (samples.length === 0) return null;
  let peak: number | null = null;
  for (const sample of samples) {
    if (flipTs - sample.ts < LEADER_ASK_STALE_MS) continue;
    if (peak == null || sample.ask > peak) peak = sample.ask;
  }
  if (peak != null) return peak;
  for (const sample of samples) {
    if (peak == null || sample.ask > peak) peak = sample.ask;
  }
  return peak;
}