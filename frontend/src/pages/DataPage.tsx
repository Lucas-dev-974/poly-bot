import { For, Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../api/client";
import { navigate } from "../router";
import "../styles/data.css";

interface DbTableStat {
  name: string;
  count: number;
}

const TABLE_META: Record<string, { label: string; definition: string }> = {
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
    definition:
      "Stratégies custom sauvegardées depuis l'éditeur (graphe JSON activable).",
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
    definition:
      "Opportunités détectées par la stratégie (prix, taille, exécutée ou non).",
  },
  market_resolutions: {
    label: "Résolutions marché",
    definition:
      "Résultat final d'un marché (outcome gagnant) une fois résolu, pour calculer le PnL.",
  },
  backtest_runs: {
    label: "Runs de backtest",
    definition:
      "Métadonnées d'un run de backtest : requête, statut, résultat JSON, erreurs.",
  },
  backtest_positions: {
    label: "Positions de backtest",
    definition:
      "Positions générées pendant un backtest (équivalent simulé de la table positions).",
  },
  backtest_trades: {
    label: "Trades de backtest",
    definition:
      "Journal des trades d'un backtest (achats/ventes, fills, raisons) lié à un run.",
  },
};

function labelFor(name: string): string {
  return TABLE_META[name]?.label ?? name;
}

function definitionFor(name: string): string {
  return (
    TABLE_META[name]?.definition ??
    "Table SQLite du bot — rôle non documenté côté UI pour l'instant."
  );
}

function formatCount(n: number): string {
  return new Intl.NumberFormat("fr-FR").format(n);
}

export function DataPage(): JSX.Element {
  const [tables, setTables] = createSignal<DbTableStat[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);

  async function load(isRefresh = false): Promise<void> {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await api.dbTables();
      setTables(data.tables);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  onMount(() => {
    void load();
  });

  const totalRows = () => tables().reduce((s, t) => s + t.count, 0);

  return (
    <div class="data-page">
      <header class="data-header">
        <div class="data-header__left">
          <button type="button" class="btn guide-back" onClick={() => navigate("/")}>
            ← Dashboard
          </button>
          <h1>Données</h1>
          <a href="/guide" class="btn guide-nav-link">
            Guide stratégie
          </a>
          <a href="/backtest" class="btn guide-nav-link">
            Backtest
          </a>
          <a href="/strategy-editor" class="btn guide-nav-link">
            Éditeur
          </a>
        </div>
        <button
          type="button"
          class="btn"
          disabled={loading() || refreshing()}
          onClick={() => void load(true)}
        >
          {refreshing() ? "Actualisation…" : "Actualiser"}
        </button>
      </header>

      <main class="data-main">
        <p class="data-lead">
          Vue d'ensemble des tables SQLite du bot : rôle concret de chacune et nombre d'entrées.
        </p>

        <Show when={error()}>
          <div class="data-error">{error()}</div>
        </Show>

        <Show when={loading()}>
          <p class="data-muted">Chargement des tables…</p>
        </Show>

        <Show when={!loading() && !error()}>
          <div class="data-summary">
            <span>
              <strong>{tables().length}</strong> tables
            </span>
            <span>
              <strong>{formatCount(totalRows())}</strong> lignes au total
            </span>
          </div>

          <div class="data-grid">
            <For each={tables()}>
              {(t) => (
                <article class="data-card">
                  <div class="data-card__name">{labelFor(t.name)}</div>
                  <div class="data-card__table">{t.name}</div>
                  <p class="data-card__def">{definitionFor(t.name)}</p>
                  <div class="data-card__count">{formatCount(t.count)}</div>
                  <div class="data-card__unit">
                    {t.count <= 1 ? "entrée" : "entrées"}
                  </div>
                </article>
              )}
            </For>
          </div>
        </Show>
      </main>
    </div>
  );
}
