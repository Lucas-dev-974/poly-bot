import { createSignal } from "solid-js";
import { api } from "../api/client";
import type { MarketRuleRow, MarketRulesResponse } from "../types";

/**
 * Flags trading/recording par famille de slugs, partagés entre la modale
 * « Enregistrements — marchés » et le panneau « Marchés actifs ».
 * Famille absente de la map = comportement par défaut côté bot (tradable).
 */
const [rules, setRules] = createSignal<Record<string, MarketRuleRow>>({});

/** Remplace l'état local avec la réponse de l'API (appelé par les deux vues). */
export function applyMarketRules(res: MarketRulesResponse): void {
  const map: Record<string, MarketRuleRow> = {};
  for (const rule of res.rules) map[rule.prefix] = rule;
  setRules(map);
}

/** Recharge depuis l'API. Échec silencieux : l'état précédent est conservé. */
export async function refreshMarketRules(): Promise<void> {
  try {
    applyMarketRules(await api.marketRules());
  } catch {
    // silencieux — le panneau garde l'état précédent
  }
}

/** Règle brute d'une famille, ou undefined si non configurée (défaut = tradable). */
export function ruleFor(prefix: string): MarketRuleRow | undefined {
  return rules()[prefix];
}