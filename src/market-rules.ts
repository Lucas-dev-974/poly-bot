import { prefixOfSlug } from "./utils/market.js";
import type { Repositories } from "./db/index.js";
import type { UpDownEvent } from "./types.js";

type MarketFlags = { recording: boolean; trading: boolean };

/** Famille absente de la table = comportement historique (tout enregistré + tradable). */
export const DEFAULT_MARKET_FLAGS: MarketFlags = { recording: true, trading: true };

/**
 * Règles par famille de slugs (préfixe), lues depuis la table market_rules.
 * Cache process : le dashboard écrit (DB + cache), le bot lit au tick —
 * les deux vivent dans le même process et partagent `repos`.
 */
export class MarketRuleStore {
  private readonly flags = new Map<string, MarketFlags>();

  loadFromDb(repos: Repositories): void {
    this.flags.clear();
    for (const row of repos.marketRules.list()) {
      this.flags.set(row.prefix, {
        recording: row.recordingEnabled === 1,
        trading: row.tradingEnabled === 1,
      });
    }
  }

  get(prefix: string): MarketFlags {
    return this.flags.get(prefix) ?? DEFAULT_MARKET_FLAGS;
  }

  /** Ecrit la DB puis rafraîchit le cache. */
  setFlags(
    prefix: string,
    patch: { recording?: boolean; trading?: boolean },
    repos: Repositories,
  ): void {
    const current = this.get(prefix);
    repos.marketRules.setFlags(prefix, {
      recordingEnabled: patch.recording,
      tradingEnabled: patch.trading,
    });
    this.flags.set(prefix, {
      recording: patch.recording ?? current.recording,
      trading: patch.trading ?? current.trading,
    });
  }

  /**
   * Ajoute une famille : règle par défaut (INSERT OR IGNORE) + cache.
   * Idempotent — ne réactive jamais une famille déjà connue. La mutation de
   * l'univers scanné (marketSlugPrefixes) reste du ressort de l'appelant
   * (route /add), qui la fait via applyRuntimeSettings.
   */
  addPrefix(prefix: string, repos: Repositories): void {
    repos.marketRules.ensureDefaults([prefix]);
    if (!this.flags.has(prefix)) {
      this.flags.set(prefix, { ...DEFAULT_MARKET_FLAGS });
    }
  }
}

/**
 * Familles avec au moins une exposition vivante : position open (tracker
 * mémoire, rechargée de la DB au boot) ou ordre GTC reposé.
 */
export function prefixesWithLiveExposure(
  openPositions: Array<{ eventSlug: string }>,
  postedOrders: Array<{ eventSlug: string }>,
): Set<string> {
  const out = new Set<string>();
  for (const p of openPositions) {
    out.add(prefixOfSlug(p.eventSlug));
  }
  for (const o of postedOrders) {
    out.add(prefixOfSlug(o.eventSlug));
  }
  return out;
}

interface FlaggedEvent {
  event: UpDownEvent;
  recording: boolean;
  trading: boolean;
}

/**
 * Logique pure : associe à chaque event scanné ses flags recording/trading.
 * Aucun effet de bord — testable sans DB ni tick loop.
 */
export function splitEventsByRules(
  events: UpDownEvent[],
  getFlags: (prefix: string) => MarketFlags,
): FlaggedEvent[] {
  return events.map((event) => {
    const flags = getFlags(prefixOfSlug(event.slug));
    return { event, recording: flags.recording, trading: flags.trading };
  });
}

/**
 * Garde de sécurité du toggle trading : refusé s'il existe une position ouverte
 * ou un ordre reposé sur la famille (l'ordre ne serait plus géré).
 * Retourne null si autorisé, sinon la raison du refus.
 */
export function toggleTradingBlockReason(
  prefix: string,
  liveExposurePrefixes: Set<string>,
): string | null {
  if (liveExposurePrefixes.has(prefix)) {
    return "Exposition ouverte sur cette famille (position ouverte ou ordre reposé). Fermez-la avant de désactiver le trading.";
  }
  return null;
}
/**
 * Garde hot-swap strategyId : refusé s'il existe une position ouverte
 * ou un ordre GTC resting (changement de moteur dangereux avec exposition).
 * Retourne null si autorisé, sinon la raison du refus.
 */
export function strategyHotSwapBlockReason(
  openPositionsCount: number,
  restingOrdersCount: number,
): string | null {
  if (openPositionsCount > 0 || restingOrdersCount > 0) {
    return (
      "Cannot change strategyId while open exposure exists " +
      `(${openPositionsCount} open position(s), ${restingOrdersCount} resting order(s)). ` +
      "Close or cancel them first."
    );
  }
  return null;
}
