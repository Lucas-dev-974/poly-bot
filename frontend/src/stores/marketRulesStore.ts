import { createSignal, onCleanup } from "solid-js";
import { api } from "../api/client";
import type { MarketRuleRow, MarketRulesResponse } from "../types";

/**
 * Flags trading/recording par famille de slugs, partagés entre la modale
 * « Enregistrements — marchés » et le panneau « Marchés actifs ».
 * Famille absente de la map = comportement par défaut côté bot (tradable).
 */
const [rules, setRules] = createSignal<Record<string, MarketRuleRow>>({});
const [lastFetchedAt, setLastFetchedAt] = createSignal(0);

/** Intervalle de fraîcheur : au-delà, la prochaine lecture re-fetch. */
const STALE_MS = 30_000;
/** Verrou anti-concurrence (fetch en cours) — déduplique les appelants. */
let inflight: Promise<void> | null = null;

export { rules };

/** Remplace l'état local avec la réponse de l'API (appelé par les deux vues). */
export function applyMarketRules(res: MarketRulesResponse): void {
  const map: Record<string, MarketRuleRow> = {};
  for (const rule of res.rules) map[rule.prefix] = rule;
  setRules(map);
  setLastFetchedAt(Date.now());
}

/**
 * Garantit des règles fraîches : no-op si la dernière réponse date de moins
 * de STALE_MS, sinon déduplique les appelants concurrents sur un seul fetch.
 * Échec silencieux : l'état précédent est conservé.
 */
export function ensureFreshRules(): Promise<void> {
  if (Date.now() - lastFetchedAt() < STALE_MS) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      applyMarketRules(await api.marketRules());
    } catch {
      // silencieux — le panneau garde l'état précédent
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Règle brute d'une famille, ou undefined si non configurée (défaut = tradable). */
export function ruleFor(prefix: string): MarketRuleRow | undefined {
  return rules()[prefix];
}

/**
 * Horloge de fond du store : re-fetch toutes les 30 s tant qu'au moins un
 * composant l'utilise (refcount). Remplace le timer par-composant d'ActiveMarkets ;
 * la modale Enregistrements continue de pousser explicitement via applyMarketRules
 * après chaque toggle (réactivité immédiate).
 */
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshConsumers = 0;

export function useMarketRulesAutoRefresh(): void {
  refreshConsumers++;
  void ensureFreshRules();
  if (refreshTimer === null) {
    refreshTimer = setInterval(() => void ensureFreshRules(), STALE_MS);
  }
  onCleanup(() => {
    refreshConsumers--;
    if (refreshConsumers <= 0) {
      refreshConsumers = 0;
      if (refreshTimer !== null) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    }
  });
}