export type TabId = "story" | "arch" | "hedge" | "ui" | "ship";
export type EngineId = "arb" | "barbell" | "edge-lead" | "reverse" | "dip-revert" | "antiflip-revert" | "flip-confirm" | "early-conviction" | "open-entry";
export type PhaseId = "mid" | "done";

export const TABS: { id: TabId; label: string }[] = [
  { id: "story", label: "Les 5 moteurs" },
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
  reverse: {
    label: "Reverse — pari contre la foule",
    subtitle: "Grilles maker sur l'underdog (7-10¢) et sur le favori (90-95¢). Espérance positive par l'asymétrie.",
    order: "Sous-cotée d'abord → hedge favori (grilles restantes simultanées)",
    risk: "Élevée — la plupart des underdogs expirent ; les limites peuvent ne pas se remplir",
    tone: "warning",
  },
  "dip-revert": {
    label: "Dip-revert — achat du favori en contrepied",
    subtitle: "Le favori chute dans la fenêtre puis se stabilise : le marché sur-pénalise, la résolution revient à la tendance.",
    order: "Chute → rebond → FOK favori → hold jusqu'à la résolution",
    risk: "Élevée — un seul pari directionnel, pas de hedge, pas de défense",
    tone: "warning",
  },
  "antiflip-revert": {
    label: "Antiflip-revert — le favori déchu",
    subtitle: "Le favori FLIPPE et le marché sur-réagit : l'ancien favori, replacé 0.35-0.45, re-gagne ~52% du temps.",
    order: "Flip d'identité → FOK favori déchu (≤90s après) → hold jusqu'à la résolution",
    risk: "Élevée — variance par trade la plus élevée du panel, sizing prudent",
    tone: "warning",
  },
  "flip-confirm": {
    label: "Flip-confirm — le nouveau favori",
    subtitle: "Un flip PRÉCOCE est informationnel : le marché sous-ajuste d'abord, on achète le nouveau favori 0.55-0.65.",
    order: "Flip précoce → FOK nouveau favori en [120,180]s → hold jusqu'à la résolution",
    risk: "Élevée — les entrées après 180s s'effondrent : la fenêtre ne s'élargit pas",
    tone: "warning",
  },
  "early-conviction": {
    label: "Early-conviction — la conviction immédiate",
    subtitle: "Un marché qui se fixe instantanément (favori ≥ 0.60 dès les 45 premières secondes) est un trend unilatéral.",
    order: "Favori ≥ 0.60 dans les 45 premières s → FOK immédiat → hold jusqu'à la résolution",
    risk: "Élevée — le plus simple mécaniquement ; t-stat 1.93, sous le seuil 2.0",
    tone: "warning",
  },
  "open-entry": {
    label: "Open-entry — le favori qui émerge",
    subtitle: "À l'ouverture le marché est FAIR (somme des asks ≈ 1.01) et sans inclinaison : l'edge vit dans le favori qui émerge (écart 0.10 à p50 6 s).",
    order: "Favori mène de 0.15 dans les 300 premières s, marché ouvert fair → FOK → SL dual-scale ou hold",
    risk: "Moyenne — t 2.88 sur 724 fenêtres (un régime) ; les SL coupent les rebonds à sizing L1",
    tone: "info",
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

export const STRATEGY_COMPARE_ROWS: [string, string, string, string, string, string, string, string, string, string][] = [
  ["Ordre d'achat", "Outsider → favori", "Outsider → favori (ratio)", "Favori → cheap (après fill edge)", "Grilles simultanées underdog + favori", "Favori seul (après chute + rebond)", "Favori déchu seul (après flip récent)", "Nouveau favori seul (après flip précoce)", "Favori seul (conviction immédiate)", "Favori seul (émergent, ouverture fair)"],
  ["Signal d'entrée", "Bandes cheap/favori + lock", "Bandes cheap + favori", "Confirmation N ticks edge croissant", "Min (sous-coté) et l'autre token, niveaux grille", "Ask favori chuté ≥ minDrop puis rebond", "Flip d'identité ≥ 240s, frais ≤ 90s, déchu 0.35-0.45", "Flip précoce, entrée en [120,180]s, favori 0.55-0.65", "Favori ≥ 0.60 dès les 45 premières s", "Favori mène de 0.15 ≤ 300s, ouverture fair (askSum ≤ 1.02)"],
  ["Sizing", "1:1 en shares", "cheap × hedgeRatio (défaut 0,5)", "edgeSizingMode : shares / pUSD / dynamic", "Budget USDC par niveau de grille", "Budget USDC unique (dipRevertOrderUsdc)", "Budget USDC unique (antiflipOrderUsdc)", "Budget USDC unique (flipConfirmOrderUsdc)", "Budget USDC unique (earlyConvictionOrderUsdc)", "Budget USDC unique (openEntryOrderUsdc)"],
  ["Lock profit", "pairLockMax obligatoire", "Ignoré — pari assumé", "Pas de lock — budgets séparés", "Pas de lock — asymétrie + amortissement", "Pas de lock — mean-reversion", "Pas de lock — sur-réaction", "Pas de lock — momentum", "Pas de lock — trend précoce", "Pas de lock — momentum d'ouverture"],
  ["Défense", "Vend tout le trou cheap", "Vend seulement la tranche filet", "Vend l'edge nu si en perte soutenue (FOK SELL)", "Aucune — grilles tenues jusqu'à la clôture", "Aucune — hold jusqu'à résolution (ou take-profit optionnel)", "Aucune — hold jusqu'à résolution", "Aucune — hold jusqu'à résolution", "Aucune — hold jusqu'à résolution", "SL dual-scale (flip confirmé + dégât / tardif) sinon hold"],
  ["Risque principal", "Lock cassé / ask hors bande", "Favori gagne → petit moins", "Cheap jamais fillé → favori nu (vendu si perte)", "La plupart des underdogs expirent à 0 ¢", "Le favori chuté perd vraiment (variance)", "Le flip était un vrai changement (variance haute)", "Le flip précoce était du bruit (fenêtre étroite)", "t-stat 1.93 < 2.0 — le moins établi des trois", "SL coûtent −$35 vs hold à sizing L1 — volatilité vs espérance"],
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
  reverse: [
    ["L'underdog se retourne et gagne", "Grille cheap paie ~10× (7-10¢) — gros plus qui absorbe les pertes."],
    ["Le favori tient et gagne", "Grille cheap = 0, grille hedge encaisse +5% — amortisseur fréquent et léger."],
  ],
  "dip-revert": [
    ["Le favori chuté gagne", "Favori × 1 $ − coût d'entrée (~0.60) ≈ +0.40/share. Le scénario cible (~64%)."],
    ["L'outsider gagne", "Le favori expire à 0 — perte = coût d'entrée. La chute était un signal de faiblesse réel."],
    ["Take-profit activé, ask ≥ seuil", "Vente au bid (~seuil − 1¢) : gain verrouillé avant la clôture. Désactivé par défaut — en backtest le hold intégral reste meilleur."],
  ],
  "antiflip-revert": [
    ["Le favori déchu re-gagne", "Déchu × 1 $ − coût (~0.43) ≈ +0.57/share. Le scénario cible (~52%) — le marché avait sur-réagi au flip."],
    ["Le nouveau favori s'installe", "Le déchu expire à 0 — perte = coût (~0.43). Le flip était un vrai changement de régime."],
  ],
  "flip-confirm": [
    ["Le nouveau favori gagne", "Nouveau favori × 1 $ − coût (~0.58) ≈ +0.42/share. Le scénario cible (~66%) — le flip précoce était informationnel."],
    ["L'ancien favori reprend", "Le nouveau favori expire à 0 — perte = coût. Le flip précoce était du bruit (moins fréquent)."],
  ],
  "early-conviction": [
    ["Le favori précoce gagne", "Favori × 1 $ − coût (~0.615) ≈ +0.385/share. Le scénario cible (~67.6%) — la conviction instantanée était fondée."],
    ["L'outsider gagne", "Le favori expire à 0 — perte = coût. Le trend instantané s'est retourné (rare)."],
  ],
  "open-entry": [
    ["Le favori émergent gagne", "Favori × 1 $ − coût (~0.605) ≈ +0.395/share. Le scénario cible (~63 % hold) — l'inclinaison d'ouverture était informationnelle."],
    ["SL déclenché puis l'autre gagne", "Vendu au bid (perte ≈ dégât) — le SL a coupé avant un effondrement plus profond (cas visé par la double échelle)."],
    ["SL déclenché puis rebond", "Vendu bas puis le marché revient — le coût des SL (−$35 vs hold en backtest runner)."],
    ["L'outsider gagne (hold)", "Le favori expire à 0 — perte = coût. La thèse d'ouverture était du bruit (~37 % hold)."],
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
  reverse: [
    "Repérer l'underdog (min ask) et le favori (l'autre token) sur les 2 carnets.",
    "Si l'ask underdog est ≥ cheapBuyMin : poser une grille de limit BUY maker, niveaux [cheapBuyMin, cheapBuyMax] (7-10¢), tronquée par maxOpenPositionsPerSide (y compris le même tick).",
    "Poser une grille de limit BUY maker sur le favori, niveaux [expensiveBuyMin, expensiveBuyMax] (90-95¢), si hedge actif — sans attendre un fill cheap (C2 contourné).",
    "Garder les GTC au carnet (pas de cancel bande) ; chaque niveau est dédupliqué par slug:outcome:kind-prix.",
    "À la clôture : une jambe paie 1 $ — l'underdog remplit ~10× ; sinon le favori amortit +5%.",
  ],
  "dip-revert": [
    "Après dipRevertMinElapsedSec : suivre l'ask du favori (token au best ask le plus haut).",
    "Si l'ask est dans [dipRevertBandMin, dipRevertBandMax] et a chuté ≥ dipRevertMinDrop sur dipRevertDropLookbackMs (~60 s)…",
    "…et que l'ask est repassé au-dessus de son minimum local (rebond confirmé) et que le spread ≤ dipRevertMaxSpread : FOK buy du favori (budget dipRevertOrderUsdc).",
    "Une seule entrée par fenêtre (les FOK ratés par profondeur sont retentés au tick suivant).",
    "Hold jusqu'à la résolution ; pas de hedge, pas de défense.",
    "Optionnel (dipRevertExitTakeProfitEnabled) : si l'ask du favori détenu atteint dipRevertExitWinAsk, FOK SELL au bid (take-profit) ; un FOK tué par la profondeur garde la position pour la résolution.",
  ],
  "antiflip-revert": [
    "Suivre l'identité du favori à chaque tick (Up mène / Down mène) ; un changement = FLIP horodaté.",
    "Si le flip survient après antiflipMinElapsedSec (240 s) et date de ≤ antiflipFlipLookbackMs (90 s)…",
    "…et que le NOUVEAU favori cote 0.45-0.65 (incertitude) : cibler le token DÉCHU.",
    "FOK buy du déchu si son ask ∈ [antiflipBandMin, antiflipBandMax] et ≥ antiflipDeposedAskMin (floor 0.40), spread ≤ antiflipMaxSpread.",
    "Une seule entrée par fenêtre ; hold jusqu'à la résolution ; pas de hedge, pas de défense.",
  ],
  "flip-confirm": [
    "Suivre l'identité du favori à chaque tick ; un flip PRÉCOCE est horodaté.",
    "Entrer seulement dans la fenêtre [flipConfirmMinElapsedSec, flipConfirmMaxElapsedSec] (120-180 s), flip frais de ≤ flipConfirmFlipLookbackMs (90 s).",
    "FOK buy du NOUVEAU favori si son ask ∈ [flipConfirmBandMin, flipConfirmBandMax] (0.55-0.65), spread ≤ flipConfirmMaxSpread.",
    "Une seule entrée par fenêtre ; hold jusqu'à la résolution ; pas de hedge.",
    "Les entrées après 180s sont en perte en backtest : ne pas élargir la fenêtre sans re-backtester.",
  ],
  "early-conviction": [
    "Dans les earlyConvictionMaxElapsedSec (45) premières secondes : lire le favori (token au best ask le plus haut).",
    "Si son ask ∈ [earlyConvictionAskMin, earlyConvictionAskMax] (0.60-0.80) : FOK buy immédiat (budget earlyConvictionOrderUsdc).",
    "Une seule entrée par fenêtre ; aucun état de flip à tracker ; hold jusqu'à la résolution.",
    "Pas de hedge. Ne pas baisser le seuil à 0.55 : le même achat à 0.55 est en perte en backtest.",
  ],
  "open-entry": [
    "Au 1er tick deux-côtés : mémoriser fair = (askUp + askDown ≤ openEntryFairAskSumMax, 1.02). Si unfair : pas de trade cette fenêtre.",
    "Dans les openEntryMaxElapsedSec (300) premières secondes : 1er tick où le favori (max ask) mène de ≥ openEntryLeanTrigger (0.15) → FOK buy full-depth (openEntryOrderUsdc), retry au tick suivant si la profondeur manque.",
    "Hold tant que rien ne casse : SL structurel si l'autre jambe mène de ≥ 0.20 depuis ≥ 20 s ET l'ask tenu a perdu ≥ 0.10 ; SL tardif passé 300 s si petit dégât (≥ 0.06). Sinon hold jusqu'à la résolution.",
    "Pas de hedge. TP re-confirmé mort (4e audit). Les SL dégradent early-conviction — ne pas copier ce bloc sur un autre moteur.",
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
  ["src/strategy/reverse-strategy.ts", "Politique reverse bet — grilles maker underdog / hedge favori"],
  ["src/strategy/dip-revert-strategy.ts", "Politique dip-revert — favori chuté + rebond, FOK, hold"],
  ["src/strategy/antiflip-revert-strategy.ts", "Politique antiflip-revert — favori déchu post-flip, FOK, hold"],
  ["src/strategy/flip-confirm-strategy.ts", "Politique flip-confirm — nouveau favori post-flip précoce, FOK, hold"],
  ["src/strategy/early-conviction-strategy.ts", "Politique early-conviction — favori précoce établi, FOK, hold"],
  ["src/strategy/open-entry-strategy.ts", "Politique open-entry — favori émergent, FOK, SL dual-scale + hold"],
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

export const REVERSE_LIFE_NODES: LifeNode[] = [
  { id: "scan", label: "Fenêtre 15m scannée", sub: "Gamma + 2 order books", tone: "neutral" },
  { id: "cheapGrid", label: "Grille cheap GTC resting", sub: "l'underdog aux niveaux 7-10¢", tone: "accent" },
  { id: "hedgeGrid", label: "Grille hedge GTC resting", sub: "le favori aux niveaux 90-95¢", tone: "accent" },
  { id: "cancelled", label: "Grilles retirées", sub: "fin de fenêtre / stale", tone: "neutral" },
  { id: "cheapFilled", label: "Underdog fillé", sub: "paris 7-10¢ payés ~10×", tone: "warning" },
  { id: "hedgeFilled", label: "Favori fillé", sub: "amortisseur +5%", tone: "warning" },
  { id: "resolved", label: "Résolue", sub: "redeem 1 $ / 0 $", tone: "neutral" },
];

export const REVERSE_LIFE_EDGES: LifeEdge[] = [
  { from: "scan", to: "cheapGrid", label: "underdog min ask" },
  { from: "scan", to: "hedgeGrid", label: "favori (si hedge actif)" },
  { from: "cheapGrid", to: "cheapFilled", label: "ask ≤ 10¢ + matched" },
  { from: "hedgeGrid", to: "hedgeFilled", label: "ask ≤ 95¢ + matched" },
  { from: "cheapFilled", to: "resolved", label: "underdog gagne (10×)" },
  { from: "hedgeFilled", to: "resolved", label: "favori tient (+5%)" },
  { from: "cancelled", to: "resolved", label: "" },
];

export const DIP_LIFE_NODES: LifeNode[] = [
  { id: "scan", label: "Fenêtre 15m scannée", sub: "Gamma + 2 order books", tone: "neutral" },
  { id: "dip", label: "Favori chuté", sub: "drop ≥ minDrop sur lookback", tone: "warning" },
  { id: "rebound", label: "Rebond confirmé", sub: "ask > min local, spread ≤ max", tone: "accent" },
  { id: "filled", label: "FOK fillé", sub: "favori long, budget USDC", tone: "warning" },
  { id: "won", label: "Favori gagne", sub: "redeem 1 $", tone: "success" },
  { id: "lost", label: "L'outsider gagne", sub: "expire à 0", tone: "danger" },
];

export const DIP_LIFE_EDGES: LifeEdge[] = [
  { from: "scan", to: "dip", label: "elapsed ≥ min + bande" },
  { from: "dip", to: "rebound", label: "ask remonte" },
  { from: "rebound", to: "filled", label: "FOK profondeur OK" },
  { from: "filled", to: "won", label: "résolution" },
  { from: "filled", to: "lost", label: "résolution" },
];

export const ANTIFLIP_LIFE_NODES: LifeNode[] = [
  { id: "scan", label: "Fenêtre 15m scannée", sub: "Gamma + 2 order books", tone: "neutral" },
  { id: "flip", label: "Flip d'identité", sub: "≥ 240s, frais ≤ 90s", tone: "warning" },
  { id: "uncertain", label: "Nouveau favori incertain", sub: "0.45-0.65", tone: "accent" },
  { id: "filled", label: "FOK favori déchu fillé", sub: "ask 0.35-0.45, floor 0.40", tone: "warning" },
  { id: "won", label: "Le déchu re-gagne", sub: "redeem 1 $ (~52%)", tone: "success" },
  { id: "lost", label: "Le nouveau s'installe", sub: "expire à 0", tone: "danger" },
];

export const ANTIFLIP_LIFE_EDGES: LifeEdge[] = [
  { from: "scan", to: "flip", label: "identité du leader inversée" },
  { from: "flip", to: "uncertain", label: "marché pas tranché" },
  { from: "uncertain", to: "filled", label: "FOK déchu, profondeur OK" },
  { from: "filled", to: "won", label: "résolution" },
  { from: "filled", to: "lost", label: "résolution" },
];

export const FLIPCONF_LIFE_NODES: LifeNode[] = [
  { id: "scan", label: "Fenêtre 15m scannée", sub: "Gamma + 2 order books", tone: "neutral" },
  { id: "flip", label: "Flip précoce", sub: "frais ≤ 90s", tone: "warning" },
  { id: "entry", label: "Fenêtre d'entrée", sub: "[120, 180]s", tone: "accent" },
  { id: "filled", label: "FOK nouveau favori fillé", sub: "ask 0.55-0.65", tone: "warning" },
  { id: "won", label: "Le nouveau gagne", sub: "redeem 1 $ (~66%)", tone: "success" },
  { id: "lost", label: "L'ancien reprend", sub: "expire à 0", tone: "danger" },
];

export const FLIPCONF_LIFE_EDGES: LifeEdge[] = [
  { from: "scan", to: "flip", label: "identité inversée tôt" },
  { from: "flip", to: "entry", label: "elapsed dans [120,180]" },
  { from: "entry", to: "filled", label: "FOK profondeur OK" },
  { from: "filled", to: "won", label: "résolution" },
  { from: "filled", to: "lost", label: "résolution" },
];

export const EARLYCONV_LIFE_NODES: LifeNode[] = [
  { id: "scan", label: "Fenêtre 15m scannée", sub: "Gamma + 2 order books", tone: "neutral" },
  { id: "early", label: "Conviction précoce", sub: "favori ≥ 0.60 dans les 45 premières s", tone: "accent" },
  { id: "filled", label: "FOK favori fillé", sub: "budget USDC", tone: "warning" },
  { id: "won", label: "Le favori gagne", sub: "redeem 1 $ (~67.6%)", tone: "success" },
  { id: "lost", label: "L'outsider gagne", sub: "expire à 0", tone: "danger" },
];

export const EARLYCONV_LIFE_EDGES: LifeEdge[] = [
  { from: "scan", to: "early", label: "se fixe instantanément" },
  { from: "early", to: "filled", label: "FOK profondeur OK" },
  { from: "filled", to: "won", label: "résolution" },
  { from: "filled", to: "lost", label: "résolution" },
];

export const OPENENTRY_LIFE_NODES: LifeNode[] = [
  { id: "scan", label: "Fenêtre 15m scannée", sub: "Gamma + 2 order books", tone: "neutral" },
  { id: "fair", label: "Ouverture fair", sub: "askSum ≤ 1.02 au 1er tick", tone: "neutral" },
  { id: "lean", label: "Favori émergent", sub: "mène de ≥ 0.15 dans [0, 300]s", tone: "accent" },
  { id: "filled", label: "FOK favori fillé", sub: "full-depth L1, budget USDC", tone: "warning" },
  { id: "sl", label: "SL dual-scale", sub: "flip confirmé + dégât / tardif", tone: "danger" },
  { id: "won", label: "Le favori gagne", sub: "redeem 1 $ (~63 % hold)", tone: "success" },
  { id: "lost", label: "L'outsider gagne", sub: "expire à 0", tone: "danger" },
];

export const OPENENTRY_LIFE_EDGES: LifeEdge[] = [
  { from: "scan", to: "fair", label: "premier tick deux-côtés" },
  { from: "fair", to: "lean", label: "marché pas déséquilibré" },
  { from: "lean", to: "filled", label: "FOK profondeur OK (retry sinon)" },
  { from: "filled", to: "sl", label: "flip ≥ 0.20 × 20s + dégât / > 300s dégât 0.06" },
  { from: "filled", to: "won", label: "hold → résolution" },
  { from: "filled", to: "lost", label: "hold → résolution" },
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
