/**
 * Déclarations de la page Données (/donnees) — dicté par le schéma SQLite du
 * bot, pas de la logique (le composant vit dans ./DataPage.tsx).
 *
 * ⚠ MAINTENANCE : toute NOUVELLE table du schéma (src/db/database.ts init)
 * doit être ajoutée ici, sinon elle tombe dans le groupe attrape-tout
 * « Autres » avec un libellé brut. Vérifier à chaque migration de schéma.
 */

/** Nom SQL → libellé FR + rôle (affiché en muted sous le libellé). */
export interface TableMetaEntry {
  label: string;
  definition: string;
}

export const TABLE_META: Record<string, TableMetaEntry> = {
  positions: {
    label: "Positions",
    definition:
      "Positions ouvertes ou résolues du bot (dry/live) : fills, coût, PnL, paire liée et statut.",
  },
  arb_pairs: {
    label: "Paires d'arbitrage",
    definition:
      "Couple outsider/favori d'une fenêtre de marché : suit le cycle d'arbitrage jusqu'à résolution.",
  },
  ledger: {
    label: "Ledger",
    definition:
      "Solde cash simulé en dry run (une seule ligne). Sert de caisse virtuelle pour les fills.",
  },
  balance_snapshots: {
    label: "Snapshots de balance",
    definition:
      "Historique ponctuel du capital (cash + valeur des positions), pour suivi et courbes.",
  },
  events: {
    label: "Événements",
    definition:
      "Journal des événements dashboard (SSE) : permet de rejouer l'état UI après un refresh.",
  },
  trade_keys: {
    label: "Clés de trade",
    definition:
      "Clés d'idempotence : empêche de repasser deux fois le même trade / la même action.",
  },
  retry_counts: {
    label: "Compteurs de retry",
    definition:
      "Nombre de tentatives déjà faites pour une opération (placement, hedge, etc.).",
  },
  posted_orders: {
    label: "Ordres postés",
    definition:
      "Ordres GTC / resting encore suivis par le bot (en attente de fill ou d'annulation).",
  },
  window_claims: {
    label: "Claims de fenêtre",
    definition:
      "Réservation d'une fenêtre marché (qui est cheap / expensive) pour éviter les doubles entrées.",
  },
  bot_state: {
    label: "État du bot",
    definition:
      "Petit stockage clé/valeur runtime (flags, compteurs persistés entre redémarrages).",
  },
  orders: {
    label: "Ordres",
    definition:
      "Historique des ordres tentés ou remplis (prix, taille, raison, dry/live) affiché dans le dashboard.",
  },
  redeems: {
    label: "Redeems",
    definition:
      "Tentatives de redeem on-chain : succès, txHash, erreurs, pour audit et UI de clôture.",
  },
  strategy_graphs: {
    label: "Graphes de stratégie",
    definition: "Stratégies custom sauvegardées depuis l'éditeur (graphe JSON activable).",
  },
  stats_snapshots: {
    label: "Snapshots de stats",
    definition:
      "Instantanés de performance / stats agrégées, pour l'historique du panneau Performance.",
  },
  market_snapshots: {
    label: "Snapshots marché",
    definition:
      "Ticks marché (volume, liquidité, spread…) capturés pendant le scan, utiles au backtest.",
  },
  book_snapshots: {
    label: "Snapshots order book",
    definition:
      "Top of book (bid/ask et profondeurs) dans le temps — base des charts et du backtest.",
  },
  opportunity_snapshots: {
    label: "Snapshots d'opportunité",
    definition: "Opportunités détectées par la stratégie (prix, taille, exécutée ou non).",
  },
  market_resolutions: {
    label: "Résolutions marché",
    definition:
      "Résultat final d'un marché (outcome gagnant) une fois résolu, pour calculer le PnL.",
  },
  backtest_runs: {
    label: "Runs de backtest",
    definition: "Métadonnées d'un run de backtest : requête, statut, résultat JSON, erreurs.",
  },
  backtest_positions: {
    label: "Positions de backtest",
    definition: "Positions générées pendant un backtest (équivalent simulé de la table positions).",
  },
  backtest_trades: {
    label: "Trades de backtest",
    definition: "Journal des trades d'un backtest (achats/ventes, fills, raisons) lié à un run.",
  },
  withdrawals: {
    label: "Retraits",
    definition: "Retraits USDC vers le wallet : montant, txHash, statut — audit des sorties.",
  },
  market_rules: {
    label: "Règles de marché",
    definition: "Cache local des règles de résolution par marché (toggle du panneau Marchés).",
  },
  /* Tables du moteur de simulation (préfixe sim_ = isolation du live). */
  sim_positions: {
    label: "Positions (sim)",
    definition: "Miroir papier de la table positions : cycles d'arbitrage simulés par le moteur.",
  },
  sim_pairs: {
    label: "Paires (sim)",
    definition: "Cycles outsider/favori du moteur papier, isolés des données live.",
  },
  sim_trades: {
    label: "Trades (sim)",
    definition: "Journal des fills papier (achats/ventes) liés aux positions sim.",
  },
  sim_state: {
    label: "État (sim)",
    definition: "Config + état runtime du moteur papier (clé/valeur) — simConfigJson vit ici.",
  },
  sim_posted_orders: {
    label: "Ordres postés (sim)",
    definition: "Ordres GTC papier encore suivis (attente de fill ou d'annulation).",
  },
  sim_trade_keys: {
    label: "Clés de trade (sim)",
    definition: "Idempotence du moteur papier : bloque les doubles exécutions.",
  },
  sim_retry_counts: {
    label: "Compteurs de retry (sim)",
    definition: "Nombre de tentatives déjà faites par le moteur papier.",
  },
  sim_window_claims: {
    label: "Claims de fenêtre (sim)",
    definition: "Réservation de fenêtre (cheap/expensive) côté papier.",
  },
  sim_positions_archive: {
    label: "Archive positions (sim)",
    definition: "Positions papier résolues déplacées par « Archiver résolues ».",
  },
};

export function labelFor(name: string): string {
  return TABLE_META[name]?.label ?? name;
}

export function definitionFor(name: string): string {
  return TABLE_META[name]?.definition ?? `Table ${name} — compléter TABLE_META dans pages/data/meta.ts.`;
}

/** Un groupe = un titre de carte + son ordre de tables (le tri à l'écran est par poids). */
export interface TableGroup {
  id: string;
  label: string;
  desc: string;
  names: string[];
}

export const GROUPS: TableGroup[] = [
  {
    id: "live",
    label: "Trading live",
    desc: "Ce que le moteur lit et écrit en dry/live.",
    names: [
      "positions",
      "arb_pairs",
      "orders",
      "market_resolutions",
      "redeems",
      "withdrawals",
      "market_rules",
    ],
  },
  {
    id: "snapshots",
    label: "Snapshots & analyse",
    desc: "Le scanner écrit ici à chaque tour — à surveiller, cela grandit vite.",
    names: [
      "book_snapshots",
      "market_snapshots",
      "opportunity_snapshots",
      "balance_snapshots",
      "stats_snapshots",
    ],
  },
  {
    id: "backtest",
    label: "Backtest",
    desc: "Équivalent simulé du moteur, isolé du live.",
    names: ["backtest_runs", "backtest_positions", "backtest_trades"],
  },
  {
    id: "sim",
    label: "Simulation (paper)",
    desc: "Miroir des tables live, préfixé sim_ — moteur papier.",
    names: [
      "sim_positions",
      "sim_pairs",
      "sim_trades",
      "sim_posted_orders",
      "sim_trade_keys",
      "sim_retry_counts",
      "sim_window_claims",
      "sim_positions_archive",
      "sim_state",
    ],
  },
  {
    id: "runtime",
    label: "Runtime & état moteur",
    desc: "Petites tables d'état — utiles au diagnostic, rarement au pilotage.",
    names: [
      "events",
      "bot_state",
      "trade_keys",
      "retry_counts",
      "posted_orders",
      "window_claims",
      "ledger",
      "strategy_graphs",
    ],
  },
];

/** Groupe des tables de scan (pour la part snapshots dans les KPI). */
export function snapshotsNames(): string[] {
  return GROUPS.find((g) => g.id === "snapshots")?.names ?? [];
}