/**
 * Carte « Historique » de la page Simulation — onglets positions résolues |
 * journal des ordres, recherche texte (marché/outcome/kind/côté), chips
 * Tous/Wins/Pertes, ordre d'affichage, pagination serveur (/api/sim/resolved
 * — DB complète, total via COUNT SQL) et virtualisation des longues listes
 * (useTableWindow).
 *
 * Données : stores sim (hydratation + SSE). `ctrl` fournit `sending` (disable
 * pendant les requêtes) et `resolvedCount` (total paginé ou vivant).
 */
import type { JSX } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";
import { EmptyState } from "../../components/ui/EmptyState";
import { Sim2Card, Sim2Tabs } from "../../components/ui/Sim2Card";
import type { ChartTarget } from "../../types";
import { simTradeToChartTarget, simulatedPositionToChartTarget } from "../../utils/chart-target-adapters";
import { useClock, clockNow } from "../../stores/clockStore";
import { useTableWindow } from "../../hooks/useTableWindow";
import {
  SIM_RESOLVED_PAGE_SIZES,
  fetchSimResolvedPage,
  setSimResolvedPageSize,
  simJournal,
  simResolvedPagedActive,
  simResolvedPaging,
  simResolvedPositions,
} from "../../stores/simStore";
import { pushError } from "../../stores/toastStore";
import { pnlClass } from "../../utils/display";
import { GraphButton, OutcomeChip } from "../../components/ui/sim2Widgets";
import { fmtPrice, fmtShares, fmtUsd, timeStr } from "../../utils/format";
import type { SimControl } from "./useSimControl";

type HistoryTab = "resolved" | "journal";
type PnlFilter = "all" | "wins" | "losses";

/** Filtre actif de l'historique : recherche + chip WIN/LOSS (pnl signé). */
function matchHistory(
  q: string,
  filter: PnlFilter,
  item: { eventSlug: string; outcome: string; kind: string; side?: string; pnl?: number | null },
): boolean {
  if (q) {
    const hay = `${item.eventSlug} ${item.outcome} ${item.kind} ${item.side ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (filter === "wins" && !((item.pnl ?? 0) > 0)) return false;
  if (filter === "losses" && !((item.pnl ?? 0) < 0)) return false;
  return true;
}

export function HistoryCard(props: {
  ctrl: import("./useSimControl").SimControl;
  onChart: (t: ChartTarget) => void;
}): JSX.Element {
  useClock();
  const now = clockNow;
  const [historyTab, setHistoryTab] = createSignal<HistoryTab>("resolved");
  const [historyQuery, setHistoryQuery] = createSignal("");
  const [historyFilter, setHistoryFilter] = createSignal<PnlFilter>("all");
  // Ordre de tri des listes : plus récent d'abord par défaut.
  const [reverseOrder, setReverseOrder] = createSignal(true);

  // Listes triées : "Plus récent d'abord" trié explicitement (le store peut
  // contenir un mélange hydratation REST + events SSE insérés en queue).
  const sortedResolved = createMemo(() => {
    const list = [...simResolvedPositions()];
    list.sort((a, b) => (b.resolvedAt ?? b.windowEnd * 1000) - (a.resolvedAt ?? a.windowEnd * 1000));
    return reverseOrder() ? list : list.reverse();
  });

  const sortedJournal = createMemo(() => {
    const list = [...simJournal()];
    list.sort((a, b) => b.ts - a.ts);
    return reverseOrder() ? list : list.reverse();
  });

  const resolvedFiltered = createMemo(() =>
    sortedResolved().filter((p) =>
      matchHistory(historyQuery().trim().toLowerCase(), historyFilter(), p),
    ),
  );
  const journalFiltered = createMemo(() =>
    sortedJournal().filter((t) =>
      matchHistory(historyQuery().trim().toLowerCase(), historyFilter(), t),
    ),
  );

  // ── Pagination positions résolues (/api/sim/resolved — DB complète) ──────
  // PagedActive true : mode paginé (page demandée au serveur). False = mode
  // vivant (hydratation /api/sim/state + préfixe SSE), fallback si fetch KO.
  const pg = simResolvedPaging;
  const pgdActive = simResolvedPagedActive;

  async function gotoPage(page: number): Promise<void> {
    const p = pg();
    const target = Math.min(Math.max(1, page), p.totalPages);
    props.ctrl.setSending(true);
    const ok = (await fetchSimResolvedPage(target, p.pageSize)) !== null;
    if (!ok) {
      pushError("Pagination : chargement de la page impossible", { group: "sim-error", replaceGroup: true });
    }
    props.ctrl.setSending(false);
  }

  async function changePageSize(size: number): Promise<void> {
    setSimResolvedPageSize(size);
    props.ctrl.setSending(true);
    const ok = (await fetchSimResolvedPage(1, size)) !== null;
    if (!ok) {
      pushError("Pagination : rechargement impossible", { group: "sim-error", replaceGroup: true });
    }
    props.ctrl.setSending(false);
  }

  const journalWindow = useTableWindow(() => journalFiltered().length, { rowHeight: 34, maxHeightPx: 480 });
  const resolvedWindow = useTableWindow(() => resolvedFiltered().length, { rowHeight: 34, maxHeightPx: 480 });

  // Onglets : compteurs lus au rendu (jamais capturés).
  const tabs = (): Array<{ id: HistoryTab; label: string; count: number }> => [
    { id: "resolved", label: "Résolues", count: props.ctrl.resolvedCount() },
    { id: "journal", label: "Journal", count: simJournal().length },
  ];

  return (
    <Sim2Card
      title="Historique"
      raw
      tabs={
        <Sim2Tabs
          tabs={tabs}
          active={historyTab()}
          onSelect={setHistoryTab}
          ariaLabel="Historique de la simulation"
        />
      }
      tools={
        <>
          <div class="sim2-search">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              type="search"
              placeholder="Filtrer par marché, outcome…"
              value={historyQuery()}
              onInput={(e) => setHistoryQuery(e.currentTarget.value)}
            />
          </div>
          <div class="sim2-fchips" role="group" aria-label="Filtre P&L">
            <button
              type="button"
              class="sim2-fchip"
              classList={{ "sim2-fchip-on": historyFilter() === "all" }}
              onClick={() => setHistoryFilter("all")}
            >
              Tous
            </button>
            <button
              type="button"
              class="sim2-fchip sim2-fchip-win"
              classList={{ "sim2-fchip-on": historyFilter() === "wins" }}
              onClick={() => setHistoryFilter("wins")}
            >
              Wins
            </button>
            <button
              type="button"
              class="sim2-fchip sim2-fchip-loss"
              classList={{ "sim2-fchip-on": historyFilter() === "losses" }}
              onClick={() => setHistoryFilter("losses")}
            >
              Pertes
            </button>
          </div>
          <button
            type="button"
            class="sim2-sort"
            classList={{ "sim2-sort-on": reverseOrder() }}
            title="Inverser l'ordre d'affichage"
            onClick={() => setReverseOrder((v) => !v)}
          >
            {reverseOrder() ? "Récents d'abord" : "Anciens d'abord"}
          </button>
        </>
      }
    >
      {/* Barre de pagination (onglet résolues, mode paginé /api/sim/resolved) : la
          page est demandée au serveur (DB complète) ; total + totalPages viennent
          du COUNT SQL — sans le plafond slice(0, 200) de /api/sim/state.
          Masquée en mode vivant (fetch paginé KO) : pas de total fiable. */}
      <Show when={historyTab() === "resolved" && pgdActive()}>
        <div class="sim2-pager">
          <span class="sim2-pager-info" title="Total des positions résolues en DB (source complète)">
            {pg().total} résolue{pg().total === 1 ? "" : "s"} · page {pg().page} / {pg().totalPages}
          </span>
          <label class="sim2-pager-size">
            Par page
            <select
              disabled={props.ctrl.sending()}
              value={String(pg().pageSize)}
              onChange={(e) => void changePageSize(Number(e.currentTarget.value))}
            >
              <For each={SIM_RESOLVED_PAGE_SIZES}>
                {(s) => <option value={String(s)}>{s}</option>}
              </For>
            </select>
          </label>
          <div class="sim2-pbtns">
            <button
              type="button"
              disabled={props.ctrl.sending() || pg().page <= 1}
              onClick={() => void gotoPage(1)}
              title="Première page"
            >
              «
            </button>
            <button
              type="button"
              disabled={props.ctrl.sending() || pg().page <= 1}
              onClick={() => void gotoPage(pg().page - 1)}
              title="Page précédente"
            >
              ‹
            </button>
            <span class="sim2-pager-page num">
              {pg().page} / {pg().totalPages}
            </span>
            <button
              type="button"
              disabled={props.ctrl.sending() || pg().page >= pg().totalPages}
              onClick={() => void gotoPage(pg().page + 1)}
              title="Page suivante"
            >
              ›
            </button>
            <button
              type="button"
              disabled={props.ctrl.sending() || pg().page >= pg().totalPages}
              onClick={() => void gotoPage(pg().totalPages)}
              title="Dernière page"
            >
              »
            </button>
          </div>
        </div>
      </Show>

      <Show
        when={historyTab() === "resolved"}
        fallback={
          /* Onglet journal : chaque ordre simulé (rempli ou non) */
          <div class="sim2-card-b">
            <Show when={journalFiltered().length > 0} fallback={<EmptyState text="Aucun ordre simulé pour l'instant." />}>
              <div
                class="sim2-table-scroll"
                ref={journalWindow.setRef}
                onScroll={journalWindow.onScroll}
                style={journalWindow.scrollerStyle()}
              >
                <table class="sim2-table">
                  <thead>
                    <tr>
                      <th>Heure</th>
                      <th>Marché</th>
                      <th>Outcome</th>
                      <th>Kind</th>
                      <th>Côté</th>
                      <th class="num">Limite</th>
                      <th class="num">Fill</th>
                      <th class="num">Taille</th>
                      <th>Type</th>
                      <th class="num">P&amp;L</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <Show when={journalWindow.active() && journalWindow.padTop() > 0}>
                      <tr aria-hidden="true">
                        <td colspan="11" style={{ height: `${journalWindow.padTop()}px`, padding: "0", border: "none" }} />
                      </tr>
                    </Show>
                    <For each={journalWindow.slice(journalFiltered())}>
                      {(t) => (
                        <tr classList={{ "sim2-resting-row": !t.filled }} title={t.reason ?? undefined}>
                          <td class="num">{timeStr(t.ts)}</td>
                          <td>{t.eventSlug}</td>
                          <td>
                            <OutcomeChip label={t.outcome} />
                          </td>
                          <td>{t.kind}</td>
                          <td classList={{ "sim2-side-buy": t.side === "BUY", "sim2-side-sell": t.side === "SELL" }}>
                            {t.side}
                          </td>
                          <td class="num">{fmtPrice(t.limitPrice)}</td>
                          <td class="num">{t.fillPrice != null ? fmtPrice(t.fillPrice) : "—"}</td>
                          <td class="num">{fmtShares(t.size)}</td>
                          <td>{t.orderType ?? "—"}</td>
                          <td class={`num ${pnlClass(t.pnl ?? 0)}`}>
                            {t.pnl != null ? fmtUsd(t.pnl) : "—"}
                          </td>
                          <td>
                            <GraphButton
                              title="Voir le graphique du marché avec les points d'entrée/sortie"
                              onClick={() => props.onChart(simTradeToChartTarget(t))}
                            />
                          </td>
                        </tr>
                      )}
                    </For>
                    <Show when={journalWindow.active() && journalWindow.padBottom() > 0}>
                      <tr aria-hidden="true">
                        <td colspan="11" style={{ height: `${journalWindow.padBottom()}px`, padding: "0", border: "none" }} />
                      </tr>
                    </Show>
                  </tbody>
                </table>
              </div>
            </Show>
          </div>
        }
      >
        {/* Onglet positions résolues */}
        <div class="sim2-card-b">
          <Show
            when={resolvedFiltered().length > 0}
            fallback={
              <EmptyState
                text={
                  sortedResolved().length > 0
                    ? "Aucun résultat pour ces filtres."
                    : "Aucune position résolue pour l'instant."
                }
              />
            }
          >
            <div
              class="sim2-table-scroll"
              ref={resolvedWindow.setRef}
              onScroll={resolvedWindow.onScroll}
              style={resolvedWindow.scrollerStyle()}
            >
              <table class="sim2-table">
                <thead>
                  <tr>
                    <th>Marché</th>
                    <th>Outcome</th>
                    <th>Kind</th>
                    <th>Moteur</th>
                    <th class="num">Entrée</th>
                    <th class="num">Sortie</th>
                    <th class="num">Taille</th>
                    <th class="num">P&amp;L</th>
                    <th>Résolu</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <Show when={resolvedWindow.active() && resolvedWindow.padTop() > 0}>
                    <tr aria-hidden="true">
                      <td colspan="11" style={{ height: `${resolvedWindow.padTop()}px`, padding: "0", border: "none" }} />
                    </tr>
                  </Show>
                  <For each={resolvedWindow.slice(resolvedFiltered())}>
                    {(p) => (
                      <tr title={p.eventSlug}>
                        <td>
                          <div class="sim2-mkt">
                            <b>{p.eventTitle}</b>
                            <small class="num">{p.eventSlug}</small>
                          </div>
                        </td>
                        <td>
                          <OutcomeChip label={p.outcome} />
                        </td>
                        <td>{p.kind}</td>
                        <td>
                          <span class="sim2-tag2">{p.strategyId ?? "—"}</span>
                        </td>
                        <td class="num">{fmtPrice(p.fillPrice)}</td>
                        <td class="num">{p.sellPrice != null ? fmtPrice(p.sellPrice) : "—"}</td>
                        <td class="num">{fmtShares(p.size)}</td>
                        <td class={`num ${pnlClass(p.pnl ?? 0)}`}>{fmtUsd(p.pnl ?? 0)}</td>
                        <td class="num">{timeStr(p.resolvedAt ?? p.windowEnd * 1000)}</td>
                        <td>{p.status}</td>
                        <td>
                          <GraphButton
                            title="Voir le graphique du marché avec les points d'entrée/sortie"
                            onClick={() => props.onChart(simulatedPositionToChartTarget(p))}
                          />
                        </td>
                      </tr>
                    )}
                  </For>
                  <Show when={resolvedWindow.active() && resolvedWindow.padBottom() > 0}>
                    <tr aria-hidden="true">
                      <td colspan="11" style={{ height: `${resolvedWindow.padBottom()}px`, padding: "0", border: "none" }} />
                    </tr>
                  </Show>
                </tbody>
              </table>
            </div>
          </Show>
        </div>
      </Show>
    </Sim2Card>
  );
}