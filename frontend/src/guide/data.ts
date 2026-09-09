export type TabId = "story" | "arch" | "hedge" | "ui" | "ship";
export type EngineId = "arb" | "barbell";
export type PhaseId = "mid" | "done";

export const TABS: { id: TabId; label: string }[] = [
  { id: "story", label: "Arb vs barbell" },
  { id: "arch", label: "Architecture" },
  { id: "hedge", label: "Hedge au POST" },
  { id: "ui", label: "Moteur & presets" },
  { id: "ship", label: "Livrables" },
];

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

export const HEDGE_TREE: [string, string, string][] = [
  ["1", "freshAsk === null", "skip — pas de défense sur book manquant"],
  ["2", "freshAsk > expensiveBuyMax", "defend si shouldDefend, sinon skip couvert"],
  ["3", "freshAsk < expensiveBuyMin", "skip outside-band"],
  ["4", "arb : fill + min(ask, max) > lock", "skip pair-lock-unreachable (pas defend)"],
  ["5", "sinon", "post à min(ask, expensiveBuyMax)"],
];

export const NEW_FILES: [string, string][] = [
  ["src/strategy/ids.ts", "STRATEGY_IDS, parseStrategyId"],
  ["src/strategy/trading-strategy.ts", "Interface TradingStrategy"],
  ["src/strategy/predicates.ts", "Picks / bandes — hors barrel"],
  ["src/strategy/orchestrate.ts", "Claims + append, paramétré par SizingStrategy"],
  ["src/strategy/arb-strategy.ts", "Politique B1 + ArbSizing"],
  ["src/strategy/barbell-strategy.ts", "Politique ratio"],
  ["src/strategy/barbell-sizing.ts", "pairLockOk toujours true"],
  ["src/strategy/registry.ts", "createStrategy(id)"],
];

export const TODOS = [
  { id: "interface-registry", content: "TradingStrategy, StrategyId, registry", done: true },
  { id: "arb-class", content: "predicates + orchestrate + ArbStrategy + barrel mince", done: true },
  { id: "barbell-class", content: "BarbellStrategy / BarbellSizing (uncovered, defendShares)", done: true },
  { id: "bot-wire", content: "ReverseBot.this.strategy + hot-swap strategyId", done: true },
  { id: "config-ui", content: "JSON, parseField, dashboard Moteur / ratio", done: true },
  { id: "presets-bind", content: "strategyId obligatoire sur les presets (les 2 = arb)", done: true },
  { id: "tests-docs", content: "Tests + README / STRATEGY.md", done: true },
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

export type SlotKind = "covered" | "needHedge" | "keepBet";

export function slotKind(index: number, hedgeFilled: number, engine: EngineId): SlotKind {
  if (index < hedgeFilled) return "covered";
  if (engine === "arb") return "needHedge";
  const target = CHEAP * RATIO;
  if (index < target) return "needHedge";
  return "keepBet";
}

export function hedgeTarget(engine: EngineId): number {
  return engine === "arb" ? CHEAP : CHEAP * RATIO;
}
