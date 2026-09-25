import type { NativeStrategyId, StrategyId } from "../types";
import type { ConfigFormState } from "../utils/configForm";

/**
 * Registre des sections de paramètres par moteur — miroir frontend de
 * `keysForStrategy` (runtime-settings.ts) : le panneau Paramètres de la page
 * Simulation n'affiche que les champs réellement utilisés par la stratégie
 * sélectionnée (communs + spécifiques). Les clés des autres moteurs restent
 * présentes dans le patch envoyé (formToSettings envoie le form complet) mais
 * ne sont ni affichées ni validées par le moteur pour cette stratégie.
 */

export type ParamFieldType = "number" | "text" | "checkbox" | "select";

export interface ParamFieldDef {
  /** Clé du ConfigFormState (string pour inputs, boolean pour checkboxes). */
  key: keyof ConfigFormState;
  label: string;
  /** Type d'input — défaut "number". */
  type?: ParamFieldType;
  step?: string;
  min?: string;
  max?: string;
  placeholder?: string;
  hint?: string;
  /** Options pour type "select". */
  options?: Array<{ value: string; label: string }>;
}

export interface ParamSectionDef {
  title: string;
  fields: ParamFieldDef[];
}

/* ── Sections communes à tous les moteurs (SHARED_KEYS) ── */

export const COMMON_PARAM_SECTIONS: ParamSectionDef[] = [
  {
    title: "Marchés & cadence",
    fields: [
      {
        key: "marketSlugPrefixes",
        label: "Marchés surveillés (slugs, virgules)",
        type: "text",
        hint: "ex: btc-updown-15m, btc-updown-5m",
      },
      { key: "pollIntervalMs", label: "Cadence de scan (ms)", step: "500", min: "100" },
    ],
  },
  {
    title: "Garde-fous",
    fields: [
      { key: "maxSharesPerOrder", label: "Max shares / ordre", step: "5", min: "5" },
      { key: "maxOpenPositionsPerSide", label: "Max positions / côté", step: "1", min: "1" },
      { key: "maxExposureUsdc", label: "Max exposition (USDC)", step: "10", min: "10" },
    ],
  },
  {
    title: "Fenêtre de trading",
    fields: [
      { key: "minutesBeforeCloseMin", label: "Minutes min avant clôture", step: "1", min: "0" },
      { key: "minutesBeforeCloseMax", label: "Minutes max avant clôture", step: "1", min: "0" },
      {
        key: "minMinutesBeforeCloseToBuy",
        label: "Min minutes avant achat",
        placeholder: "vide = aucun",
        step: "1",
        min: "0",
      },
    ],
  },
  {
    title: "Moteur de simulation",
    fields: [
      {
        key: "simFillProbabilityNonMarketable",
        label: "Fill prob. non-marketable",
        step: "0.05",
        min: "0",
        max: "1",
      },
    ],
  },
];

/* ── ARB : arbitrage 1:1 + lock ── */

const ARB_SECTIONS: ParamSectionDef[] = [
  {
    title: "Jambe cheap (underdog)",
    fields: [
      { key: "cheapBuyMin", label: "Ask cheap min", step: "0.01", min: "0", max: "1" },
      { key: "cheapBuyMax", label: "Ask cheap max", step: "0.01", min: "0", max: "1" },
      { key: "cheapOrderUsdc", label: "Budget cheap (USDC)", step: "1", min: "1" },
    ],
  },
  {
    title: "Jambe hedge (favori) & lock",
    fields: [
      { key: "expensiveBuyMin", label: "Ask hedge min", step: "0.01", min: "0", max: "1" },
      { key: "expensiveBuyMax", label: "Ask hedge max", step: "0.01", min: "0", max: "1" },
      { key: "expensiveOrderUsdc", label: "Plafond hedge (USDC)", step: "1", min: "1" },
      {
        key: "expensiveOrderType",
        label: "Type d'ordre hedge",
        type: "select",
        options: [
          { value: "FOK", label: "FOK (immédiat)" },
          { value: "GTC", label: "GTC (reposé)" },
        ],
      },
      { key: "pairLockMax", label: "Lock de paire max (somme asks)", step: "0.01", min: "0.5", max: "1" },
    ],
  },
  {
    title: "Ask-lock (optionnel)",
    fields: [
      { key: "arbAskLockOnly", label: "Entrer uniquement en ask-lock", type: "checkbox" },
      {
        key: "arbAskSumMax",
        label: "Somme asks max",
        placeholder: "vide = off",
        step: "0.01",
        min: "0.5",
        max: "1",
      },
      {
        key: "arbAskLockMinElapsedSec",
        label: "Min elapsed ask-lock (s)",
        placeholder: "vide = off",
        step: "10",
        min: "0",
      },
      {
        key: "arbAskLockMaxImbalance",
        label: "Max imbalance carnet",
        placeholder: "vide = off",
        step: "0.05",
        min: "0",
      },
    ],
  },
];

/* ── BARBELL : ratio cheap/hedge sans lock ── */

const BARBELL_SECTIONS: ParamSectionDef[] = [
  {
    title: "Jambe cheap (underdog)",
    fields: [
      { key: "cheapBuyMin", label: "Ask cheap min", step: "0.01", min: "0", max: "1" },
      { key: "cheapBuyMax", label: "Ask cheap max", step: "0.01", min: "0", max: "1" },
      { key: "barbellCheapOrderUsdc", label: "Budget cheap (USDC)", step: "1", min: "1" },
    ],
  },
  {
    title: "Jambe hedge (favori)",
    fields: [
      { key: "expensiveBuyMin", label: "Ask hedge min", step: "0.01", min: "0", max: "1" },
      { key: "expensiveBuyMax", label: "Ask hedge max", step: "0.01", min: "0", max: "1" },
      { key: "expensiveOrderUsdc", label: "Plafond hedge (USDC)", step: "1", min: "1" },
      {
        key: "expensiveOrderType",
        label: "Type d'ordre hedge",
        type: "select",
        options: [
          { value: "FOK", label: "FOK (immédiat)" },
          { value: "GTC", label: "GTC (reposé)" },
        ],
      },
      { key: "barbellHedgeRatio", label: "Ratio hedge / cheap", step: "0.05", min: "0", max: "10" },
      { key: "enableExpensiveHedge", label: "Hedge activé", type: "checkbox" },
    ],
  },
];

/* ── EDGE-LEAD : edge d'abord, puis cheap ── */

const EDGE_LEAD_SECTIONS: ParamSectionDef[] = [
  {
    title: "Jambe edge (favori)",
    fields: [
      { key: "edgeBandMin", label: "Bande edge min", step: "0.01", min: "0", max: "1" },
      { key: "edgeBandMax", label: "Bande edge max", step: "0.01", min: "0", max: "1" },
      { key: "edgeConfirmSamples", label: "Échantillons de confirmation", step: "1", min: "1" },
      { key: "edgeMaxDownTick", label: "Max down-tick pendant confirm", step: "0.01", min: "0" },
      { key: "edgeOrderUsdc", label: "Budget edge (USDC)", step: "1", min: "1" },
      { key: "maxShareEdge", label: "Max shares edge", step: "1", min: "1" },
      {
        key: "edgeSizingMode",
        label: "Mode de sizing",
        type: "select",
        options: [
          { value: "shares", label: "Shares fixes" },
          { value: "pusd", label: "pUSD fixes" },
          { value: "dynamic", label: "Dynamique" },
        ],
      },
      { key: "edgeSharesEdge", label: "Shares edge (mode shares)", step: "1", min: "1" },
      { key: "edgeRequireCheapReady", label: "Cheap déjà dans la bande (hedgeable au fill)", type: "checkbox" },
      {
        key: "edgeAskSumMax",
        label: "Somme asks max (edge + cheap)",
        placeholder: "vide = off",
        step: "0.01",
        min: "0.5",
        max: "2",
      },
    ],
  },
  {
    title: "Jambe cheap (suivi)",
    fields: [
      { key: "edgeCheapOrderUsdc", label: "Budget cheap (USDC)", step: "1", min: "1" },
      { key: "edgeCheapBandMin", label: "Bande cheap min", step: "0.01", min: "0", max: "1" },
      { key: "edgeCheapBandMax", label: "Bande cheap max", step: "0.01", min: "0", max: "1" },
      { key: "edgeSharesCheap", label: "Shares cheap (mode shares)", step: "1", min: "1" },
    ],
  },
  {
    title: "Vente edge (perte)",
    fields: [
      { key: "edgeSellExpensiveEnabled", label: "Vendre edge en perte", type: "checkbox" },
      { key: "edgeSellExpensiveAfterMin", label: "Après (min)", step: "1", min: "0" },
      { key: "edgeSellExpensiveLossPct", label: "Perte déclencheuse (%)", step: "1", min: "0" },
      {
        key: "edgeSellExpensiveLossWindowMs",
        label: "Fenêtre de perte (ms)",
        step: "1000",
        min: "0",
      },
    ],
  },
];

/* ── REVERSE : underdog + hedge favori ── */

const REVERSE_SECTIONS: ParamSectionDef[] = [
  {
    title: "Grille underdog",
    fields: [
      { key: "cheapBuyMin", label: "Ask cheap min", step: "0.01", min: "0", max: "1" },
      { key: "cheapBuyMax", label: "Ask cheap max", step: "0.01", min: "0", max: "1" },
      { key: "reverseCheapOrderUsdc", label: "Budget cheap (USDC)", step: "1", min: "1" },
      {
        key: "requireCheapFillBeforeExpensive",
        label: "Hedge seulement après fill cheap",
        type: "checkbox",
      },
      {
        key: "reverseCancelCheapOffBand",
        label: "Annuler cheap hors bande",
        type: "checkbox",
      },
    ],
  },
  {
    title: "Défense / hedge favori",
    fields: [
      { key: "expensiveBuyMin", label: "Ask hedge min", step: "0.01", min: "0", max: "1" },
      { key: "expensiveBuyMax", label: "Ask hedge max", step: "0.01", min: "0", max: "1" },
      { key: "expensiveOrderUsdc", label: "Plafond hedge (USDC)", step: "1", min: "1" },
      {
        key: "expensiveOrderType",
        label: "Type d'ordre hedge",
        type: "select",
        options: [
          { value: "FOK", label: "FOK (immédiat)" },
          { value: "GTC", label: "GTC (reposé)" },
        ],
      },
      { key: "enableExpensiveHedge", label: "Hedge activé", type: "checkbox" },
      { key: "reverseDefendEnabled", label: "Grille de défense", type: "checkbox" },
      {
        key: "reverseMaxGridLevels",
        label: "Max niveaux de grille",
        placeholder: "vide = illimité",
        step: "1",
        min: "1",
      },
      {
        key: "reverseHedgeCapToFilledCheap",
        label: "Hedge plafonné au fill cheap",
        type: "checkbox",
      },
    ],
  },
];

/* ── FAV-BAND : FOK favori mid-band, hold résolution ── */

const FAV_BAND_SECTIONS: ParamSectionDef[] = [
  {
    title: "Entrée",
    fields: [
      { key: "favBandOrderUsdc", label: "Budget / position (USDC)", step: "1", min: "1" },
      { key: "favBandAskMin", label: "Ask min", step: "0.01", min: "0", max: "1" },
      { key: "favBandAskMax", label: "Ask max", step: "0.01", min: "0", max: "1" },
      { key: "favBandMinElapsedSec", label: "Min elapsed (s)", step: "10", min: "0", max: "900" },
      {
        key: "favBandMaxElapsedSec",
        label: "Max elapsed (s)",
        placeholder: "vide = aucun",
        step: "10",
        min: "0",
        max: "900",
      },
    ],
  },
  {
    title: "Hedge inverse (optionnel)",
    fields: [
      { key: "favBandInverseEnabled", label: "Hedge inverse activé", type: "checkbox" },
      { key: "favBandInverseAskMax", label: "Ask inverse max", step: "0.01", min: "0", max: "1" },
      {
        key: "favBandInverseShareRatio",
        label: "Ratio shares inverse",
        step: "0.5",
        min: "0.1",
      },
      { key: "favBandInverseOrderUsdc", label: "Budget inverse (USDC)", step: "1", min: "1" },
    ],
  },
  {
    title: "Filtre whipsaw",
    fields: [
      { key: "favBandWhipsawEnabled", label: "Filtre whipsaw activé", type: "checkbox" },
      {
        key: "favBandWhipsawPauseAfterLosses",
        label: "Pause après N pertes",
        placeholder: "vide = off",
        step: "1",
        min: "0",
      },
      { key: "favBandWhipsawPauseWindows", label: "Durée pause (fenêtres)", step: "1", min: "0" },
      {
        key: "favBandWhipsawMaxScore",
        label: "Score whipsaw max",
        placeholder: "vide = off",
        step: "1",
        min: "0",
      },
      {
        key: "favBandWhipsawMaxIntraFlips",
        label: "Max flips intra-fenêtre",
        placeholder: "vide = off",
        step: "1",
        min: "0",
      },
    ],
  },
  {
    title: "Filtre imbalance carnet",
    fields: [
      { key: "favBandImbalanceEnabled", label: "Filtre imbalance activé", type: "checkbox" },
      {
        key: "favBandImbalanceCrossMin",
        label: "Seuil de croisement",
        placeholder: "vide = off",
        step: "0.05",
        min: "0",
      },
      {
        key: "favBandImbalanceTicks",
        label: "Ticks de confirmation",
        placeholder: "vide = off",
        step: "1",
        min: "0",
      },
      {
        key: "favBandImbalanceMaxSpread",
        label: "Max spread",
        placeholder: "vide = off",
        step: "0.01",
        min: "0",
      },
    ],
  },
  {
    title: "Sortie dégradation (optionnelle)",
    fields: [
      { key: "favBandExitEnabled", label: "Sortie activée", type: "checkbox" },
      {
        key: "favBandExitMinLowerHighDrop",
        label: "Chute min plus-bas consécutifs",
        step: "0.01",
        min: "0",
      },
      { key: "favBandExitRetraceRatio", label: "Ratio de retrace", step: "0.05", min: "0" },
      { key: "favBandExitConsecutive", label: "Plus-bas consécutifs", step: "1", min: "1" },
      { key: "favBandExitLookbackMs", label: "Lookback (ms)", step: "10000", min: "1000" },
      { key: "favBandExitMinElapsedSec", label: "Min elapsed sortie (s)", step: "10", min: "0", max: "900" },
      { key: "favBandExitLossOnly", label: "Uniquement en perte", type: "checkbox" },
      { key: "favBandExitSwitchEnabled", label: "Switch de côté après sortie", type: "checkbox" },
      {
        key: "favBandExitSwitchOrderUsdc",
        label: "Budget switch (USDC)",
        step: "1",
        min: "1",
      },
    ],
  },
];

/* ── DIP-REVERT : favori dip + rebond ── */

const DIP_REVERT_SECTIONS: ParamSectionDef[] = [
  {
    title: "Entrée",
    fields: [
      { key: "dipRevertBandMin", label: "Ask min", step: "0.01", min: "0", max: "1" },
      { key: "dipRevertBandMax", label: "Ask max", step: "0.01", min: "0", max: "1" },
      { key: "dipRevertMinDrop", label: "Chute min", step: "0.01", min: "0" },
      { key: "dipRevertDropLookbackMs", label: "Lookback chute (ms)", step: "1000", min: "1000" },
      { key: "dipRevertMinElapsedSec", label: "Min elapsed (s)", step: "10", min: "0", max: "900" },
      {
        key: "dipRevertMaxElapsedSec",
        label: "Max elapsed (s)",
        placeholder: "vide = aucun",
        step: "10",
        min: "0",
        max: "900",
      },
      { key: "dipRevertMaxSpread", label: "Max spread", step: "0.01", min: "0" },
      { key: "dipRevertOrderUsdc", label: "Budget / position (USDC)", step: "1", min: "1" },
    ],
  },
  {
    title: "Sortie take-profit (optionnelle)",
    fields: [
      {
        key: "dipRevertExitTakeProfitEnabled",
        label: "TP intra-market activé",
        type: "checkbox",
      },
      { key: "dipRevertExitWinAsk", label: "Ask de vente TP", step: "0.01", min: "0", max: "1" },
    ],
  },
];

/* ── ANTIFLIP-REVERT : favori déchu post-flip ──
   Les filtres de pattern 5m (sharp drop, bounce, TP, floor déchu) sont gérés
   à part (SIM_5M_FILTER_FIELDS) avec la distinction actif/inactif selon le
   preset 5m sélectionné. */

const ANTIFLIP_SECTIONS: ParamSectionDef[] = [
  {
    title: "Bande & budget",
    fields: [
      { key: "antiflipBandMin", label: "Ask min (bande du déchu)", step: "0.01", min: "0", max: "1" },
      { key: "antiflipBandMax", label: "Ask max (bande du déchu)", step: "0.01", min: "0", max: "1" },
      { key: "antiflipOrderUsdc", label: "Budget / position (USDC)", step: "1", min: "1" },
      {
        key: "antiflipFavAskMin",
        label: "Nouveau favori incertain min",
        step: "0.01",
        min: "0",
        max: "1",
      },
      {
        key: "antiflipFavAskMax",
        label: "Nouveau favori incertain max",
        step: "0.01",
        min: "0",
        max: "1",
      },
    ],
  },
  {
    title: "Timing & fenêtre",
    fields: [
      { key: "antiflipEntryDelaySec", label: "Délai d'entrée après flip (s)", step: "1", min: "0", max: "900" },
      { key: "antiflipFlipLookbackMs", label: "Lookback flip (ms)", step: "1000", min: "1000" },
      { key: "antiflipMinElapsedSec", label: "Min elapsed (s)", step: "10", min: "0", max: "900" },
      {
        key: "antiflipMaxElapsedSec",
        label: "Max elapsed (s)",
        placeholder: "vide = aucun",
        step: "10",
        min: "0",
        max: "900",
      },
      { key: "antiflipMaxSpread", label: "Max spread", step: "0.01", min: "0" },
      { key: "antiflip5mOnly", label: "5m uniquement (gate marchés 5 min)", type: "checkbox" },
    ],
  },
];

/* ── FLIP-CONFIRM : nouveau favori post-flip précoce ── */

const FLIP_CONFIRM_SECTIONS: ParamSectionDef[] = [
  {
    title: "Entrée",
    fields: [
      { key: "flipConfirmBandMin", label: "Ask min", step: "0.01", min: "0", max: "1" },
      { key: "flipConfirmBandMax", label: "Ask max", step: "0.01", min: "0", max: "1" },
      { key: "flipConfirmFlipLookbackMs", label: "Lookback flip (ms)", step: "1000", min: "1000" },
      {
        key: "flipConfirmMinElapsedSec",
        label: "Min elapsed (s)",
        step: "10",
        min: "0",
        max: "900",
      },
      {
        key: "flipConfirmMaxElapsedSec",
        label: "Max elapsed (s)",
        placeholder: "vide = aucun",
        step: "10",
        min: "0",
        max: "900",
      },
      { key: "flipConfirmMaxSpread", label: "Max spread", step: "0.01", min: "0" },
      { key: "flipConfirmOrderUsdc", label: "Budget / position (USDC)", step: "1", min: "1" },
    ],
  },
];

/* ── EARLY-CONVICTION : favori établi < 45s ── */

const EARLY_CONVICTION_SECTIONS: ParamSectionDef[] = [
  {
    title: "Entrée",
    fields: [
      { key: "earlyConvictionAskMin", label: "Ask min", step: "0.01", min: "0.5", max: "1" },
      { key: "earlyConvictionAskMax", label: "Ask max", step: "0.01", min: "0.5", max: "1" },
      {
        key: "earlyConvictionMaxElapsedSec",
        label: "Max elapsed (s)",
        step: "5",
        min: "1",
        max: "900",
      },
      { key: "earlyConvictionMaxSpread", label: "Max spread", step: "0.01", min: "0" },
      { key: "earlyConvictionOrderUsdc", label: "Budget / position (USDC)", step: "1", min: "1" },
    ],
  },
];

/* ── OPEN-ENTRY : favori émergent < 300s, SL dual-scale ── */

const OPEN_ENTRY_SECTIONS: ParamSectionDef[] = [
  {
    title: "Entrée",
    fields: [
      { key: "openEntryLeanTrigger", label: "Seuil de lean", step: "0.01", min: "0", max: "0.5" },
      {
        key: "openEntryMaxElapsedSec",
        label: "Max elapsed (s)",
        step: "10",
        min: "1",
        max: "900",
      },
      {
        key: "openEntryFairAskSumMax",
        label: "Somme asks fair max",
        step: "0.01",
        min: "1",
        max: "1.2",
      },
      { key: "openEntryMaxSpread", label: "Max spread", step: "0.01", min: "0" },
      { key: "openEntryOrderUsdc", label: "Budget / position (USDC)", step: "1", min: "1" },
    ],
  },
  {
    title: "Stop-loss dual-scale",
    fields: [
      { key: "openEntrySlEnabled", label: "SL activé", type: "checkbox" },
      {
        key: "openEntrySlStructFlipDist",
        label: "Distance flip structurel",
        step: "0.01",
        min: "0",
        max: "1",
      },
      {
        key: "openEntrySlStructConfirmSec",
        label: "Confirmation structurelle (s)",
        step: "1",
        min: "0",
        max: "900",
      },
      {
        key: "openEntrySlStructDist",
        label: "Distance SL structurel",
        step: "0.01",
        min: "0",
        max: "1",
      },
      {
        key: "openEntrySlLateAfterSec",
        label: "SL tardif après (s)",
        step: "10",
        min: "0",
        max: "900",
      },
      { key: "openEntrySlLateDist", label: "Distance SL tardif", step: "0.01", min: "0", max: "1" },
    ],
  },
];

/* ── PROBABILITY-REPRICING : dislocation CLOB ── */

const PROBABILITY_REPRICING_SECTIONS: ParamSectionDef[] = [
  {
    title: "Signal d'entrée",
    fields: [
      { key: "repricingFeedMaxAgeMs", label: "Âge max du feed (ms)", step: "50", min: "50" },
      { key: "repricingTauMinSec", label: "Tau min (s)", step: "5", min: "1" },
      { key: "repricingSpreadMax", label: "Max spread entrée", step: "0.01", min: "0" },
      { key: "repricingPEntryMax", label: "P entrée max", step: "0.01", min: "0", max: "1" },
      { key: "repricingEdgeMin", label: "Edge min", step: "0.005", min: "0" },
      { key: "repricingDislocationMin", label: "Dislocation min", step: "0.05", min: "0" },
      { key: "repricingHistoryWindowMs", label: "Fenêtre d'historique (ms)", step: "1000", min: "1000" },
      { key: "repricingOrderUsdc", label: "Budget / position (USDC)", step: "1", min: "1" },
    ],
  },
  {
    title: "Sorties (TP / stop / temps)",
    fields: [
      { key: "repricingTargetAbs", label: "TP absolu", step: "0.01", min: "0" },
      { key: "repricingTargetRel", label: "TP relatif", step: "0.01", min: "0" },
      { key: "repricingStopAbs", label: "Stop absolu", step: "0.01", min: "0" },
      { key: "repricingHoldMaxSec", label: "Hold max (s)", step: "10", min: "1" },
      { key: "repricingTauForceExitSec", label: "Force-exit tau (s)", step: "5", min: "1" },
      { key: "repricingSpreadMaxExit", label: "Max spread sortie", step: "0.01", min: "0" },
      { key: "repricingLateWindowSec", label: "Fenêtre tardive (s)", step: "5", min: "0" },
      { key: "repricingSignalTtlMs", label: "TTL du signal (ms)", step: "500", min: "100" },
    ],
  },
  {
    title: "Frais & glissement",
    fields: [
      { key: "repricingModeAEnabled", label: "Mode A activé", type: "checkbox" },
      {
        key: "repricingFeesRoundtrip",
        label: "Fees aller-retour",
        step: "0.001",
        min: "0",
        max: "0.1",
      },
      {
        key: "repricingSlipEntryBuffer",
        label: "Buffer slip entrée",
        step: "0.001",
        min: "0",
        max: "0.2",
      },
      {
        key: "repricingSlipExitBuffer",
        label: "Buffer slip sortie",
        step: "0.001",
        min: "0",
        max: "0.2",
      },
      {
        key: "repricingNotionalMaxPerMarket",
        label: "Notional max / marché (USDC)",
        step: "5",
        min: "1",
      },
    ],
  },
];

/* ── CUSTOM (graph) ── */

const CUSTOM_SECTIONS: ParamSectionDef[] = [
  {
    title: "Budget des ordres custom",
    fields: [
      { key: "customOrderUsdc", label: "Budget / ordre computeSize (USDC)", step: "1", min: "1" },
    ],
  },
];

const SECTIONS_BY_ENGINE: Record<NativeStrategyId, ParamSectionDef[]> = {
  arb: ARB_SECTIONS,
  barbell: BARBELL_SECTIONS,
  "edge-lead": EDGE_LEAD_SECTIONS,
  reverse: REVERSE_SECTIONS,
  "fav-band": FAV_BAND_SECTIONS,
  "dip-revert": DIP_REVERT_SECTIONS,
  "antiflip-revert": ANTIFLIP_SECTIONS,
  "flip-confirm": FLIP_CONFIRM_SECTIONS,
  "early-conviction": EARLY_CONVICTION_SECTIONS,
  "open-entry": OPEN_ENTRY_SECTIONS,
  "probability-repricing": PROBABILITY_REPRICING_SECTIONS,
};

/** Sections de paramètres spécifiques au moteur (hors sections communes). */
export function paramSectionsFor(strategyId: StrategyId): ParamSectionDef[] {
  if (strategyId.startsWith("custom:")) return CUSTOM_SECTIONS;
  const native = strategyId as NativeStrategyId;
  return SECTIONS_BY_ENGINE[native] ?? [];
}

/** Libellés courts pour le titre du panneau (les labels complets sont verbeux). */
export const STRATEGY_SHORT_LABELS: Record<NativeStrategyId, string> = {
  arb: "Arbitrage 1:1 + lock",
  barbell: "Barbell (ratio cheap/hedge)",
  "edge-lead": "Edge-lead",
  reverse: "Reverse bet",
  "fav-band": "Fav-band",
  "dip-revert": "Dip-revert",
  "antiflip-revert": "Antiflip-revert",
  "flip-confirm": "Flip-confirm",
  "early-conviction": "Early-conviction",
  "open-entry": "Open-entry",
  "probability-repricing": "Probability-repricing",
};

export function strategyShortLabel(id: StrategyId): string {
  if (id.startsWith("custom:")) return id;
  return STRATEGY_SHORT_LABELS[id as NativeStrategyId] ?? id;
}