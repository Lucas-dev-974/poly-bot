export type TabId = "story" | "arch" | "hedge" | "ui" | "ship";
export type EngineId = "arb" | "barbell" | "edge-lead";
export type PhaseId = "mid" | "done";

export const TABS: { id: TabId; label: string }[] = [
  { id: "story", label: "Les 3 moteurs" },
  { id: "arch", label: "Architecture" },
  { id: "hedge", label: "Hedge au POST" },
  { id: "ui", label: "Moteur & presets" },
  { id: "ship", label: "Livrables" },
];

export const ENGINE_META: Record<
  EngineId,
  { label: string; subtitle: string; order: string; risk: string; tone: "info" | "warning" }
> = {
  arb: {
    label: "Arb — le filet",
    subtitle: "Un outsider pour un favori. Petit gain dans tous les cas.",
    order: "Outsider d'abord → favori 1:1",
    risk: "Faible — lock sous pairLockMax",
    tone: "info",
  },
  barbell: {
    label: "Barbell — filet + pari",
    subtitle: "Moitié couverte, moitié laissée en pari sur l'outsider.",
    order: "Outsider d'abord → favori au ratio (défaut 0,5)",
    risk: "Moyenne — upside si l'outsider gagne",
    tone: "warning",
  },
  "edge-lead": {
    label: "Edge-lead — favori d'abord",
    subtitle: "Confirmer le momentum du favori, puis hedger l'outsider si le prix le permet.",
    order: "Favori confirmé → fill edge → cheap si bande OK",
    risk: "Élevée — favori nu vendu si en perte soutenue",
    tone: "warning",
  },
};

export const CHEAP = 10;
export const HEDGE_MID = 3;
export const RATIO = 0.5;

export const FLOW_NODES = [
  { id: "tick", label: "ReverseBot.tick", sub: "scan + pause" },
  { id: "scan", label: "MarketScanner", sub: "Gamma / books" },
  { id: "strat", label: "TradingStrategy", sub: "politique" },
  { id: "exec", label: "execute / defend", sub: "gardes infra" },
  { id: "clob", label: "Trader CLOB", sub: "place / cancel" },
];

export const FLOW_EDGES = [
  { from: "tick", to: "scan" },
  { from: "scan", to: "strat" },
  { from: "strat", to: "exec" },
  { from: "exec", to: "clob" },
];

export const API_ROWS: [string, string][] = [
  ["findOpportunities", "Cheap / hedge à générer (claims, bandes, sizing)"],
  ["cheapOrderAction", "keep | take-ask | cancel-lock (lock gagne si les deux)"],
  ["shouldDefend", "Ask favori > max et paire non « couverte »"],
  ["defendShares", "Parts cheap à vendre — pas le même calcul arb / barbell"],
  ["hedgeAtPostTime", "Live seulement : skip / defend / post + prix"],
];

export const COMPARE_ROWS: [string, string, string][] = [
  ["Sizing cheap", "min(ask, cheapBuyMax, lock − hedge)", "min(ask, cheapBuyMax) — pas de lock"],
  ["Sizing hedge", "1:1 sur cheap non couvert", "écart à cheap × ratio (défaut 0,5)"],
  ["Lock pairLockMax", "fill + hedge ≤ lock sinon skip", "ignoré (pari, pas arb)"],
  ["Cancel cheap resting", "hors bande ou bid > lock − hedge", "hors bande seulement"],
  ["Défense (ask > max)", "vend cheap − expensive", "vend cheap × ratio − expensive"],
  ["Après défense", "cancel GTC hedge", "cancel GTC hedge (toujours)"],
];

export const STRATEGY_COMPARE_ROWS: [string, string, string, string][] = [
  ["Ordre d'achat", "Outsider → favori", "Outsider → favori (ratio)", "Favori → cheap (après fill edge)"],
  ["Signal d'entrée", "Bandes cheap + favori + lock", "Bandes cheap + favori", "Confirmation N ticks edge croissant"],
  ["Sizing", "1:1 en shares", "cheap × hedgeRatio (défaut 0,5)", "edgeSizingMode : shares / pUSD / dynamic (budgets indépendants)"],
  ["Lock profit", "pairLockMax obligatoire", "Ignoré — pari assumé", "Pas de lock — budgets séparés"],
  ["Défense", "Vend tout le trou cheap", "Vend seulement la tranche filet", "Vend l'edge nu si en perte soutenue (FOK SELL)"],
  ["Risque principal", "Lock cassé / ask hors bande", "Favori gagne → petit moins", "Cheap jamais fillé → favori nu (vendu si perte)"],
];

export const EDGE_LEAD_PARAM_ROWS: [string, string][] = [
  ["edgeBandMin / edgeBandMax", "Bande ask favori pour confirmer et poster l'edge"],
  ["edgeConfirmSamples", "Ticks consécutifs valides avant achat edge (série croissante)"],
  ["edgeMaxDownTick", "Drop tick-à-tick max toléré dans la série"],
  ["edgeCheapBandMin / edgeCheapBandMax", "Bande ask cheap pour poster (après fill edge)"],
  ["edgeOrderUsdc", "Budget USDC du favori (size = budget / ask edge) — mode pUSD / dynamic"],
  ["maxShareEdge", "Plafond de shares de l'ordre edge (le cheap reste sur maxSharesPerOrder)"],
  ["edgeCheapOrderUsdc", "Budget USDC de l'outsider (size = budget / ask cheap) — mode pUSD / dynamic"],
  ["edgeSizingMode", "Mode de sizing : shares (fixe) / pUSD (budget USDC) / dynamic (comportement actuel)"],
  ["edgeSharesEdge / edgeSharesCheap", "Shares fixes de l'edge et du cheap en mode shares (≥ 5)"],
  ["edgeSellExpensiveEnabled", "Vendre l'edge nu (favori) si aucun cheap fillé et en perte soutenue"],
  ["edgeSellExpensiveAfterMin", "Âge du marché (min depuis l'ouverture) avant déclenchement de la vente"],
  ["edgeSellExpensiveLossPct", "Perte % sous le fill price pour déclencher (ex. 10 = -10%)"],
  ["edgeSellExpensiveLossWindowMs", "Durée de perte continue requise avant la vente"],
];

export const RESOLUTION_ROWS: Record<EngineId, [string, string][]> = {
  arb: [
    ["Le favori gagne", "10 favoris × 1 $ − coût lock ≈ petit gain verrouillé."],
    ["L'outsider gagne", "10 outsiders × 1 $ − coût lock ≈ même petit gain verrouillé."],
  ],
  barbell: [
    ["Le favori gagne", "5 favoris × 1 $. Les 5 outsiders pari = 0 → petit moins."],
    ["L'outsider gagne", "10 outsiders × 1 $ + 5 favoris = 0 → gros plus (c'est le pari)."],
  ],
  "edge-lead": [
    ["Le favori gagne, cheap fillé", "Edge + cheap remplis — P&L selon prix d'entrée (pas de lock 1:1)."],
    ["Le favori gagne, cheap absent", "Favori nu — gros gain si tu avais raison sur le momentum."],
    ["L'outsider gagne, cheap fillé", "Cheap paie 1 $, edge perd — résultat selon tailles et prix."],
    ["L'outsider gagne, cheap absent", "Edge perd tout — pari directionnel raté."],
  ],
};

export const BOT_STEPS: Record<EngineId, string[]> = {
  arb: [
    "Attendre outsider pas cher + favori dans la bande, avec lock atteignable.",
    "Poser un GTC sur l'outsider (min de ask, cheapBuyMax, lock − hedge).",
    "Quand l'outsider est fillé : acheter le favori 1:1 (FOK/GTC).",
    "Si le favori sort de la zone : revendre tout le trou cheap restant.",
  ],
  barbell: [
    "Attendre outsider pas cher + favori dans la bande (pas de lock requis).",
    "Poser un GTC sur l'outsider.",
    "Quand l'outsider est fillé : acheter le favori au ratio (ex. 5 pour 10 cheap).",
    "Si le favori devient trop cher : vendre seulement la tranche filet manquante, garder le pari.",
  ],
  "edge-lead": [
    "Surveiller l'ask favori : N ticks consécutifs dans la bande, série croissante.",
    "Poster l'edge en GTC au best ask — attendre le fill (pas de cheap pendant ce temps).",
    "Après fill edge : poster le cheap en GTC si ask ∈ [edgeCheapBandMin, edgeCheapBandMax].",
    "Cancel edge GTC si favori sort de bande avant fill ; cancel cheap GTC si ask cheap sort de bande cheap.",
    "Si le cheap ne remplit jamais et que l'edge est en perte soutenue après un délai : vendre l'edge (FOK SELL).",
  ],
};

export const HEDGE_TREE: [string, string, string][] = [
  ["1", "freshAsk === null", "skip — pas de défense sur book manquant"],
  ["2", "freshAsk > expensiveBuyMax", "defend si shouldDefend, sinon skip couvert"],
  ["3", "freshAsk < expensiveBuyMin", "skip outside-band"],
  ["4", "arb : fill + min(ask, max) > lock", "skip pair-lock-unreachable (pas defend)"],
  ["5", "sinon", "post à min(ask, expensiveBuyMax)"],
];


/** Sémantique des zones chart (éditeur /strategy-editor). */
export const CHART_ZONE_SEMANTICS: [string, string][] = [
  [
    "once",
    "Se verrouille dès qu’un POST buy/sell est accepté. Un POST raté se retente. Un GTC ensuite cancel-locké reste verrouillé.",
  ],
  [
    "dependsOn",
    "La zone enfant n’est prête qu’après le fill du parent buy (pas seulement le POST). Plusieurs enfants possibles.",
  ],
  [
    "ask vs bid",
    "Les tendances buy utilisent le best ask ; les sells favorite trendent sur le best bid (séries séparées).",
  ],
  [
    "sell",
    "Uniquement si une position fillée existe. Liquidation complète (pas de vente partielle).",
  ],
];

export const NEW_FILES: [string, string][] = [
  ["src/strategy/ids.ts", "STRATEGY_IDS, parseStrategyId"],
  ["src/strategy/trading-strategy.ts", "Interface TradingStrategy"],
  ["src/strategy/predicates.ts", "Picks / bandes — hors barrel"],
  ["src/strategy/orchestrate.ts", "Claims + append, paramétré par SizingStrategy"],
  ["src/strategy/arb-strategy.ts", "Politique B1 + ArbSizing"],
  ["src/strategy/barbell-strategy.ts", "Politique ratio"],
  ["src/strategy/edge-lead-strategy.ts", "Politique favori d'abord + budgets USDC"],
  ["src/strategy/barbell-sizing.ts", "pairLockOk toujours true"],
  ["src/strategy/registry.ts", "createStrategy(id, repos) natif + custom"],
  ["src/strategy/graph/", "DSL + interpréteur GraphStrategy"],
  ["frontend/src/strategy-editor/", "Éditeur chart + zones /strategy-editor"],
  ["src/backtest/", "Replayer book_snapshots + page /backtest"],
];

export const TODOS = [
  { id: "interface-registry", content: "TradingStrategy, StrategyId, registry", done: true },
  { id: "arb-class", content: "predicates + orchestrate + ArbStrategy + barrel mince", done: true },
  { id: "barbell-class", content: "BarbellStrategy / BarbellSizing (uncovered, defendShares)", done: true },
  { id: "bot-wire", content: "ReverseBot.this.strategy + hot-swap strategyId", done: true },
  { id: "config-ui", content: "JSON, parseField, dashboard Moteur / ratio", done: true },
  { id: "presets-bind", content: "strategyId obligatoire sur les presets (les 2 = arb)", done: true },
  { id: "position-strategy", content: "positions.strategyId persisté + colonne Moteur", done: true },
  { id: "tests-docs", content: "Tests + README / STRATEGY.md", done: true },
  { id: "backtest", content: "Page /backtest + replayer TOB déterministe", done: true },
  { id: "graph-editor", content: "Éditeur chart /strategy-editor + chartRules persistés", done: true },
];

export type LifeTone = "neutral" | "accent" | "success" | "danger" | "warning";
export type LifeNode = { id: string; label: string; sub: string; tone: LifeTone };
export type LifeEdge = { from: string; to: string; label: string };

export const ARB_LIFE_NODES: LifeNode[] = [
  { id: "scan", label: "Fenêtre 15m scannée", sub: "Gamma + 2 order books", tone: "neutral" },
  { id: "resting", label: "Cheap GTC resting", sub: "min(ask, max, lock − hedge)", tone: "accent" },
  { id: "cancelled", label: "Cheap annulé", sub: "lock cassé / reprice", tone: "neutral" },
  { id: "filled", label: "Cheap fillé (nu)", sub: "confirmé par solde wallet", tone: "warning" },
  { id: "covered", label: "Paire couverte 1:1", sub: "fill + hedge ≤ lock", tone: "success" },
  { id: "directional", label: "Directionnel", sub: "lock raté / ask < min", tone: "warning" },
  { id: "sold", label: "Vendu (défense)", sub: "tout le trou, FOK SELL", tone: "danger" },
  { id: "resolved", label: "Résolue", sub: "redeem 1 $ / 0 $", tone: "neutral" },
];

export const ARB_LIFE_EDGES: LifeEdge[] = [
  { from: "scan", to: "resting", label: "favori dans la bande" },
  { from: "resting", to: "cancelled", label: "favori sort / bid > cap" },
  { from: "resting", to: "filled", label: "matched + tokens" },
  { from: "filled", to: "covered", label: "hedge FOK/GTC" },
  { from: "filled", to: "directional", label: "lock raté / ask < min" },
  { from: "filled", to: "sold", label: "ask favori > max" },
  { from: "covered", to: "resolved", label: "" },
  { from: "directional", to: "resolved", label: "" },
  { from: "sold", to: "resolved", label: "" },
];

export const BARBELL_LIFE_NODES: LifeNode[] = [
  { id: "scan", label: "Fenêtre 15m scannée", sub: "Gamma + 2 order books", tone: "neutral" },
  { id: "resting", label: "Cheap GTC resting", sub: "min(ask, cheapBuyMax) — pas de lock", tone: "accent" },
  { id: "cancelled", label: "Cheap annulé", sub: "hors bande / reprice", tone: "neutral" },
  { id: "filled", label: "Cheap fillé (nu)", sub: "confirmé par solde wallet", tone: "warning" },
  { id: "covered", label: "Ratio atteint", sub: "hedge = cheap × 0,5 + leftover", tone: "success" },
  { id: "directional", label: "Pari tenu", sub: "hedge < 5 parts / ask < min", tone: "warning" },
  { id: "sold", label: "Défense (tranche filet)", sub: "leftover pas vendu", tone: "danger" },
  { id: "leftover", label: "Pari leftover restant", sub: "jusqu'à la résolution", tone: "warning" },
  { id: "resolved", label: "Résolue", sub: "redeem 1 $ / 0 $", tone: "neutral" },
];

export const BARBELL_LIFE_EDGES: LifeEdge[] = [
  { from: "scan", to: "resting", label: "favori dans la bande" },
  { from: "resting", to: "cancelled", label: "favori sort / take-ask" },
  { from: "resting", to: "filled", label: "matched + tokens" },
  { from: "filled", to: "covered", label: "hedge ratio (même si > 1 $)" },
  { from: "filled", to: "directional", label: "hedge trop petit / ask < min" },
  { from: "filled", to: "sold", label: "ask > max et ratio pas OK" },
  { from: "sold", to: "leftover", label: "leftover gardé" },
  { from: "covered", to: "resolved", label: "" },
  { from: "directional", to: "resolved", label: "" },
  { from: "leftover", to: "resolved", label: "" },
];

export const EDGE_LEAD_LIFE_NODES: LifeNode[] = [
  { id: "scan", label: "Fenêtre 15m scannée", sub: "Gamma + 2 order books", tone: "neutral" },
  { id: "confirm", label: "Confirmation edge", sub: "N ticks dans la bande + série croissante", tone: "accent" },
  { id: "edgeResting", label: "Edge GTC resting", sub: "au best ask, dans la bande", tone: "accent" },
  { id: "cheapResting", label: "Cheap GTC resting", sub: "best ask si dans la bande cheap", tone: "accent" },
  { id: "cancelled", label: "Edge annulé", sub: "edge sort de la bande avant fill", tone: "neutral" },
  { id: "edgeFilled", label: "Edge fillé", sub: "favori long", tone: "warning" },
  { id: "covered", label: "Les deux jambes fillées", sub: "tailles indépendantes", tone: "success" },
  { id: "directional", label: "Favori nu", sub: "cheap jamais fillé", tone: "warning" },
  { id: "edgeSold", label: "Edge vendu", sub: "perte soutenue, FOK SELL", tone: "danger" },
  { id: "resolved", label: "Résolue", sub: "redeem 1 $ / 0 $", tone: "neutral" },
];

export const EDGE_LEAD_LIFE_EDGES: LifeEdge[] = [
  { from: "scan", to: "confirm", label: "ask favori dans la bande" },
  { from: "confirm", to: "edgeResting", label: "N ticks + série croissante" },
  { from: "edgeResting", to: "edgeFilled", label: "matched + tokens" },
  { from: "edgeResting", to: "cancelled", label: "edge sort de la bande" },
  { from: "edgeFilled", to: "cheapResting", label: "ask cheap dans la bande cheap" },
  { from: "cheapResting", to: "edgeFilled", label: "ask cheap hors bande (cancel)" },
  { from: "cheapResting", to: "covered", label: "cheap fillé" },
  { from: "edgeFilled", to: "directional", label: "cheap jamais fillé" },
  { from: "edgeFilled", to: "edgeSold", label: "perte continue + marché âgé" },
  { from: "covered", to: "resolved", label: "" },
  { from: "directional", to: "resolved", label: "" },
  { from: "edgeSold", to: "resolved", label: "" },
  { from: "cancelled", to: "resolved", label: "" },
];

export type SlotKind = "covered" | "needHedge" | "keepBet";

export function slotKind(index: number, hedgeFilled: number, engine: EngineId): SlotKind {
  if (index < hedgeFilled) return "covered";
  if (engine === "arb") return "needHedge";
  const target = CHEAP * RATIO;
  if (index < target) return "needHedge";
  return "keepBet";
}

export function hedgeTarget(engine: EngineId): number {
  if (engine === "arb") return CHEAP;
  return CHEAP * RATIO;
}
