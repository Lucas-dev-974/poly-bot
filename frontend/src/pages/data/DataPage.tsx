/**
 * Page Données (/donnees) — vue des tables SQLite du bot (refonte sim2).
 *
 * Données : GET /api/db/tables ({ tables, db }) — lecture seule, aucun
 * endpoint d'écriture. Auto-refresh 5 s silencieux (le bouton Actualiser
 * seul affiche un état en cours) + badge « maj il y a N s » (tick partagé
 * useClock). Déclarations (rôle/groupe de chaque table) : ./meta.ts.
 *
 * Dégradation : sur un backend démarré avant la màj `listDbStats`, `db` et
 * `bytes` sont absents de la réponse — le KPI taille et la colonne taille
 * et la part snapshots affichent « — » (jamais « 0 ») sans casser la page.
 */

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import type { DbTableStatRow, DbTablesResponse } from "../../api/client";
import { Sim2Card, Sim2Tabs } from "../../components/ui/Sim2Card";
import { navigate } from "../../router";
import { clockNow, useClock } from "../../stores/clockStore";
import "../../styles/data.css";
import { fmtBytes, fmtCount, fmtCountCompact } from "../../utils/format";
import { toMessage } from "../../utils/display";
import {
  GROUPS,
  definitionFor,
  labelFor,
  snapshotsNames,
  type TableGroup,
} from "./meta";

/** Seuil des valeurs « dominantes » ressorties en accent (> 0,1 Go). */
const BIG_BYTES = 100 * 1024 * 1024;

const REFRESH_MS = 5000;

interface GroupRow {
  name: string;
  label: string;
  def: string;
  count: number;
  bytes: number | null;
  /** Jours market enregistrés — market_snapshots uniquement, sinon undefined. */
  days?: number | null;
}

interface GroupView {
  id: string;
  label: string;
  desc: string;
  rows: GroupRow[];
  totalRows: number;
  totalBytes: number;
  empty: number;
  maxBytes: number;
}

export function DataPage(): JSX.Element {
  useClock();
  const [data, setData] = createSignal<DbTablesResponse | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [refreshing, setRefreshing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [loadedAt, setLoadedAt] = createSignal<number | null>(null);
  const [group, setGroup] = createSignal("all");
  const [query, setQuery] = createSignal("");

  /**
   * `manual` (bouton Actualiser) : état « Actualisation… » visible.
   * Sans argument (première charge + cycle auto) : muet — un toggle
   * toutes les 5 s ferait clignoter le bouton.
   */
  async function load(manual = false): Promise<void> {
    if (manual) setRefreshing(true);
    else if (data() == null) setLoading(true);
    setError(null);
    try {
      setData(await api.dbTables());
      setLoadedAt(Date.now());
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  onMount(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  /* ── Dérivés ─────────────────────────────────────────────────────── */

  /** Ajoute le groupe attrape-tout « Autres » si une table est hors GROUPS. */
  const groupsWithNames = createMemo(() => {
    const rows = data()?.tables ?? [];
    const unmatched = rows
      .map((t) => t.name)
      .filter((n) => !GROUPS.some((g) => g.names.includes(n)));
    if (unmatched.length === 0) return GROUPS;
    const extra: TableGroup = {
      id: "autres",
      label: "Autres",
      desc: "Tables hors groupes connus — à classer dans pages/data/meta.ts.",
      names: unmatched,
    };
    return [...GROUPS, extra];
  });

  const tabs = createMemo(() => {
    const names = (data()?.tables ?? []).map((t) => t.name);
    const out: Array<{ id: string; label: string; count?: number }> = [
      { id: "all", label: "Tout", count: names.length },
    ];
    for (const g of groupsWithNames()) {
      const n = g.names.filter((x) => names.includes(x)).length;
      if (n > 0) out.push({ id: g.id, label: g.label, count: n });
    }
    return out;
  });

  const totals = createMemo(() => {
    const tables = data()?.tables ?? [];
    return {
      count: tables.length,
      rows: tables.reduce((s, t) => s + t.count, 0),
      empty: tables.filter((t) => t.count === 0).length,
    };
  });

  /**
   * Réutilisation par identité : un GroupRow/GroupView inchangé garde sa
   * référence, donc <For> NE remonte pas les 32 lignes à chaque cycle de
   * 5 s (micro-flicker au survol, transition de largeur des barres perdue).
   */
  const prevRows = new Map<string, GroupRow>();
  const prevGroups = new Map<string, GroupView>();

  /** Groupes filtrés (onglet + recherche), lignes triées par poids (octets). */
  const visibleGroups = createMemo(() => {
    const rows = data()?.tables ?? [];
    if (rows.length === 0) return [];
    const idx = new Map<string, DbTableStatRow>();
    for (const t of rows) idx.set(t.name, t);
    const q = query().trim().toLowerCase();
    const view: GroupView[] = [];
    for (const g of groupsWithNames()) {
      if (group() !== "all" && group() !== g.id) continue;
      const built: GroupRow[] = [];
      for (const name of g.names) {
        const t = idx.get(name);
        if (!t) continue;
        const label = labelFor(name);
        const def = definitionFor(name);
        if (q && !`${label} ${name} ${def}`.toLowerCase().includes(q)) continue;
        const bytes = t.bytes ?? null;
        const days = t.days ?? null;
        const prev = prevRows.get(name);
        if (prev && prev.count === t.count && prev.bytes === bytes && prev.days === days && prev.label === label && prev.def === def) {
          built.push(prev);
        } else {
          const fresh: GroupRow = { name, label, def, count: t.count, bytes, days };
          prevRows.set(name, fresh);
          built.push(fresh);
        }
      }
      if (built.length === 0) continue;
      built.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.count - a.count);
      const prevG = prevGroups.get(g.id);
      if (
        prevG &&
        prevG.rows.length === built.length &&
        prevG.rows.every((r, i) => r === built[i])
      ) {
        // Mêmes objets dans le même ordre : rien à faire, la vue est stable.
        view.push(prevG);
        continue;
      }
      const gv: GroupView = {
        id: g.id,
        label: g.label,
        desc: g.desc,
        rows: built,
        totalRows: built.reduce((s, r) => s + r.count, 0),
        totalBytes: built.reduce((s, r) => s + (r.bytes ?? 0), 0),
        empty: built.filter((r) => r.count === 0).length,
        maxBytes: Math.max(...built.map((r) => r.bytes ?? 0), 1),
      };
      prevGroups.set(g.id, gv);
      view.push(gv);
    }
    return view;
  });

  const sizeBytes = () => {
    const d = data();
    return d?.db ? d.db.fileBytes + d.db.walBytes : null;
  };

  /** Part des snapshots dans la DB (en octets) — null sans méta ni tailles. */
  const snapShare = () => {
    const d = data();
    if (!d?.db) return null;
    const total = d.db.fileBytes + d.db.walBytes;
    if (total <= 0) return null;
    let snap = 0;
    for (const n of snapshotsNames()) {
      const b = d.tables.find((t) => t.name === n)?.bytes;
      // Une seule table sans taille → part non mesurable : « — », jamais 0.
      if (b == null) return null;
      snap += b;
    }
    return snap / total;
  };

  /** Secondes écoulées depuis la dernière donnée reçue (tick 1 s partagé). */
  const refreshedAgo = () => {
    const at = loadedAt();
    if (at == null) return null;
    return Math.max(0, Math.round((clockNow() - at) / 1000));
  };

  /* ── Rendu ───────────────────────────────────────────────────────── */

  return (
    <div class="data-page">
      <header class="sim2-topbar">
        <div class="sim2-topbar-left">
          <button type="button" class="btn sim2-back" onClick={() => navigate("/")}>
            ← Dashboard
          </button>
          <h1 class="sim2-title">Données</h1>
          <span class="sim2-topbar-muted">Vue des tables SQLite — lecture seule</span>
        </div>
        <div class="sim2-topbar-actions">
          <Show when={refreshedAgo() != null}>
            <span class="data-updated">
              <span class="data-live-dot" />
              maj il y a {refreshedAgo()} s
            </span>
          </Show>
          <button
            type="button"
            class="btn"
            disabled={loading() || refreshing()}
            onClick={() => void load(true)}
          >
            {refreshing() ? "Actualisation…" : "⟳ Actualiser"}
          </button>
        </div>
      </header>

      <div class="data-body">
        <Show when={error()}>
          <div class="data-error">{error()}</div>
        </Show>

        <Show when={loading()}>
          <p class="data-muted">Chargement des tables…</p>
        </Show>

        <Show
          when={!loading() && !error() && data() != null && totals().count > 0}
          fallback={
            <Show when={!loading() && !error()}>
              <p class="data-muted">Aucune table — persistance désactivée ou base vide.</p>
            </Show>
          }
        >
          <section class="sim2-kpis">
            <div class="sim2-kpi">
              <span class="sim2-kpi-label">Tables</span>
              <span class="sim2-kpi-value">{totals().count}</span>
              <span class="sim2-kpi-sub">{tabs().length - 1} groupes</span>
            </div>
            <div class="sim2-kpi">
              <span class="sim2-kpi-label">Lignes totales</span>
              <span class="sim2-kpi-value">{fmtCountCompact(totals().rows)}</span>
              <span class="sim2-kpi-sub">
                <b>{fmtCount(totals().rows)}</b>
              </span>
            </div>
            <div class="sim2-kpi">
              <span class="sim2-kpi-label">Taille DB</span>
              <span class="sim2-kpi-value">{fmtBytes(sizeBytes())}</span>
              <span class="sim2-kpi-sub">
                {sizeBytes() != null
                  ? (data()?.db?.walBytes ?? 0) > 0
                    ? `fichier + WAL (${fmtBytes(data()?.db?.walBytes)})`
                    : "fichier seul — aucun WAL"
                  : "métadonnée absente du backend"}
              </span>
            </div>
            <div class="sim2-kpi data-kpi-warn">
              <span class="sim2-kpi-label">Part snapshots</span>
              <span class="sim2-kpi-value">
                {snapShare() != null
                  ? `${((snapShare() ?? 0) * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`
                  : "—"}
              </span>
              <span class="sim2-kpi-sub">5 tables de scan — grandissent à chaque tour</span>
            </div>
            <div class="sim2-kpi">
              <span class="sim2-kpi-label">Tables vides</span>
              <span class="sim2-kpi-value">{totals().empty}</span>
              <span class="sim2-kpi-sub">réservées au runtime, 0 = normal</span>
            </div>
          </section>

          <div class="data-controls">
            <Sim2Tabs
              tabs={tabs}
              active={group()}
              onSelect={setGroup}
              ariaLabel="Filtrer les tables par groupe"
            />
            <input
              class="data-search"
              type="text"
              placeholder="Rechercher une table…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>

          <For each={visibleGroups()}>
            {(g) => (
              <Sim2Card
                title={g.label}
                note={g.desc}
                count={`${fmtCount(g.totalRows)} lignes · ${g.rows.length} tables${
                  g.totalBytes > 0 ? ` · ${fmtBytes(g.totalBytes)}` : ""
                }${g.empty > 0 ? ` · ${g.empty} vides` : ""}`}
                flush
              >
                <div class="data-rows">
                  <For each={g.rows}>
                    {(r) => (
                      <div class="data-row" classList={{ "data-row--empty": r.count === 0 }}>
                        <div class="data-r-cell">
                          <div class="data-r-head">
                            <span class="data-r-label">{r.label}</span>
                            <Show when={r.days != null}>
                              <span
                                class="data-r-days"
                                title={`${fmtCount(r.days ?? 0)} jours civils de captures marché enregistrés (UTC)`}
                              >
                                {fmtCount(r.days ?? 0)} j
                              </span>
                            </Show>
                          </div>
                          <span class="data-r-def">{r.def}</span>
                        </div>
                        <div class="data-r-name sim2-mono">{r.name}</div>
                        <div class="data-r-barcell">
                          <Show when={r.count > 0 && r.bytes != null}>
                            <div class="data-r-bar">
                              <div
                                class="data-r-fill"
                                classList={{ max: r.bytes != null && r.bytes === g.maxBytes }}
                                style={{
                                  width: `${Math.max(
                                    2,
                                    Math.round(((r.bytes ?? 0) / g.maxBytes) * 100),
                                  )}%`,
                                }}
                              />
                            </div>
                          </Show>
                        </div>
                        <div
                          class="data-r-count"
                          classList={{ big: (r.bytes ?? 0) > BIG_BYTES }}
                          title={r.count > 0 ? `${fmtCount(r.count)} lignes` : undefined}
                        >
                          {r.count > 0 ? fmtCountCompact(r.count) : ""}
                        </div>
                        <div class="data-r-size" classList={{ big: (r.bytes ?? 0) > BIG_BYTES }}>
                          <Show when={r.count === 0}>
                            <span class="data-pill-ghost">vide</span>
                          </Show>
                          <Show when={r.count > 0}>
                            <span title={`table + indexes — ${fmtCount(r.bytes ?? 0)} octets`}>
                              {fmtBytes(r.bytes)}
                            </span>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Sim2Card>
            )}
          </For>

          <p class="data-foot">
            Taille par table = btree + indexes (dbstat SQLite). La somme des tables est inférieure
            à la taille du fichier : pages internes du schéma. Barre : part de la table la plus
            lourde du groupe. Source GET /api/db/tables — écriture impossible.
          </p>
        </Show>
      </div>
    </div>
  );
}