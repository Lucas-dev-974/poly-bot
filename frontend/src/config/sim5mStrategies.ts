/**
 * Stratégies 5m recommandées (audits/5min-strategies) pour la page Simulation.
 *
 * Tous ces presets partagent le moteur `antiflip-revert` avec `antiflip5mOnly: true`
 * : le moteur refuse toute entrée sur un marché dont la fenêtre n'est pas
 * exactement 5 minutes — le gate vit dans le moteur, donc il s'applique aussi
 * bien en paper trading qu'en live.
 *
 * Rangs 1-3 : hold-to-resolution (EV max). Rangs 4-5 : intra-market TP
 * (antiflipTakeProfitPct) — WR soldés 80-86%, trades ~4× plus courts, EV
 * inférieure au hold (audit 13 : results/13-intrabar-tp.md).
 */
export interface Sim5mStrategyDef {
  /** Preset id (config/presets/*.json + STRATEGY_PRESETS). */
  presetId: string;
  /** Moteur porteur des règles (const du registry). */
  strategyId: "antiflip-revert";
  /** Rang dans la recommandation (#1 … #5). */
  rank: 1 | 2 | 3 | 4 | 5;
  name: string;
  tag: string;
  description: string;
  stats: Array<{ label: string; value: string; ok?: boolean }>;
  /** Avertissement optionnel (budget, fréquence...). */
  warn?: string;
  /**
   * Champs du panneau de configuration spécifiquement ACTIFS pour cette
   * stratégie (filtres d'entrée en plus de la bande commune). Les autres
   * champs « filtres » du formulaire sont affichés en section avancée
   * repliable — ils existent toujours dans le patch envoyé au moteur.
   */
  activeFields: Array<keyof typeof SIM_5M_FILTER_FIELDS>;
}

/**
 * Champs « filtres » du panneau 5m pouvant être actifs ou inactifs selon la
 * stratégie. Les champs communs (bande, budget, timing, lookback, spread,
 * garde-fous) sont toujours affichés.
 */
export const SIM_5M_FILTER_FIELDS = {
  antiflipTakeProfitPct: "Take-profit intra-market (0 = hold)",
  antiflipSharpDropMin: "Sharp drop min (chute pré-flip)",
  antiflipBounceMin: "Bounce min (rebond du plancher)",
  antiflipBounceFloor: "Bounce floor (plancher non condamné)",
  antiflipDeposedAskMin: "Floor déchu (min ask du déposé)",
} as const;

export const SIM_5M_STRATEGIES: Sim5mStrategyDef[] = [
  {
    presetId: "antiflip-5m-reentry",
    strategyId: "antiflip-revert",
    rank: 1,
    name: "Antiflip re-entry",
    tag: "A",
    description:
      "Quand le favori FLIPPE, attendre 5s puis acheter l'ancien favori déposé si son ask ∈ [0.30, 0.40]. Hold jusqu'à la résolution. 1 trade max / fenêtre.",
    stats: [
      { label: "WR", value: "50.7%", ok: true },
      { label: "EV/trade", value: "+0.71 $", ok: true },
      { label: "Ratio", value: "1.73" },
      { label: "Trades/70h", value: "75" },
    ],
    activeFields: [],
  },
  {
    presetId: "antiflip-5m-sharp",
    strategyId: "antiflip-revert",
    rank: 2,
    name: "Antiflip sharp",
    tag: "H",
    description:
      "Comme re-entry, mais n'entre que si le déposé a décoté d'au moins 12¢ de son sommet pré-flip (chute brutale = surréaction). Ask ∈ [0.30, 0.40]. Hold.",
    stats: [
      { label: "WR", value: "49.3%", ok: true },
      { label: "EV/trade", value: "+0.65 $", ok: true },
      { label: "Ratio", value: "1.70" },
      { label: "Trades/70h", value: "71" },
    ],
    activeFields: ["antiflipSharpDropMin"],
  },
  {
    presetId: "antiflip-5m-bounce",
    strategyId: "antiflip-revert",
    rank: 3,
    name: "Antiflip bounce",
    tag: "K",
    description:
      "Après le flip, suivre le plancher de l'ancien favori ; acheter quand son ask a rebondi de ≥ 8¢ et reste ≥ 0.40 (non condamné) et ≤ 0.60. Hold.",
    stats: [
      { label: "WR", value: "50.2%", ok: true },
      { label: "EV/trade", value: "+0.27 $", ok: true },
      { label: "Ratio", value: "1.22" },
      { label: "Trades/70h", value: "237" },
    ],
    warn: "Budget ~3 $/trade (5 shares × ask ≤ 0.60) — au-delà de la contrainte stricte 2 $. La plus stable IS/OOS (55%/55 %) à budget élargi.",
    activeFields: ["antiflipBounceMin", "antiflipBounceFloor"],
  },
  {
    presetId: "antiflip-5m-tp10",
    strategyId: "antiflip-revert",
    rank: 4,
    name: "Antiflip TP10%",
    tag: "A-TP10",
    description:
      "Intra-market : même entrée que re-entry, mais VENTE au bid dès que la position vaut +10% de la mise (bid ≥ entrée × 1.10). Sans TP atteint → hold → résolution. Trades ~1 min.",
    stats: [
      { label: "WR soldés", value: "85.3%", ok: true },
      { label: "EV/trade", value: "+0.11 $", ok: true },
      { label: "Hold moyen", value: "66s" },
      { label: "Trades/70h", value: "75" },
    ],
    activeFields: ["antiflipTakeProfitPct"],
  },
  {
    presetId: "antiflip-5m-tp20",
    strategyId: "antiflip-revert",
    rank: 5,
    name: "Antiflip TP20%",
    tag: "A-TP20",
    description:
      "Intra-market : vente au bid dès +20% de la mise (bid ≥ entrée × 1.20). Meilleur EV des TP testés (+0.13 $). Sans TP atteint → hold → résolution.",
    stats: [
      { label: "WR soldés", value: "80.0%", ok: true },
      { label: "EV/trade", value: "+0.13 $", ok: true },
      { label: "Hold moyen", value: "86s" },
      { label: "Trades/70h", value: "75" },
    ],
    activeFields: ["antiflipTakeProfitPct"],
  },
];