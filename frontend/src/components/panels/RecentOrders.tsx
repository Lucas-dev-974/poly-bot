/**
 * Onglet « Ordres récents » de la carte Historique du dashboard.
 * CORPS seul (la carte + les onglets sont portés par
 * pages/dashboard/HistoryCard) ; le bouton « Purge rejetés » vit dans une
 * barre d'outils au-dessus du tableau.
 */
import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { ConfirmModal } from "../modals/ConfirmModal";
import { EmptyState } from "../ui/EmptyState";
import { api } from "../../api/client";
import { orders, replaceOrders } from "../../stores/orderStore";
import { addLog } from "../../stores/logStore";
import { countdown, fmtPrice, formatReturnPct } from "../../utils/format";
import { reasonLabel } from "../../utils/helpers";

/** Statut « rejeté » du dashboard : non rempli, ni GTC en attente, ni annulé. */
function isRejected(o: { filled: boolean; reason?: string }): boolean {
  return !o.filled && o.reason !== "resting" && o.reason !== "cancelled";
}

export function RecentOrdersBody(props: { now: number }): JSX.Element {
  const rejectedRows = createMemo(() => orders.filter(isRejected));
  const [confirmClear, setConfirmClear] = createSignal(false);

  async function clearRejected(): Promise<void> {
    setConfirmClear(false);
    try {
      const res = await api.clearRejectedOrders();
      // Refresh immédiat du store (la purge DB n'émet pas d'event SSE).
      const fresh = await api.orders();
      replaceOrders(fresh.orders);
      addLog(`${res.deleted} ordre(s) rejeté(s) supprimé(s) du journal`);
    } catch (e) {
      addLog(
        "Purge des rejetés impossible : " +
          (e instanceof Error ? e.message : String(e)),
        undefined,
        true,
      );
    }
  }

  return (
    <>
      <Show when={rejectedRows().length > 0}>
        <div class="dash-hist-bar">
          <button
            type="button"
            class="btn btn-ghost"
            disabled={confirmClear()}
            title="Supprime du journal DB tous les ordres rejetés (pré-checks locaux, jamais passés à la venue)"
            onClick={() => setConfirmClear(true)}
          >
            Purge rejetés
            <span class="sim2-count num">{rejectedRows().length}</span>
          </button>
        </div>
      </Show>
      <Show
        when={orders.length > 0}
        fallback={<EmptyState text="Aucun ordre pour l'instant." />}
      >
        <div class="orders sim2-table-scroll">
          <table class="sim2-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Marché</th>
                <th>Outcome</th>
                <th class="num">Prix</th>
                <th class="num">Taille</th>
                <th class="num">Rendement</th>
                <th>Statut</th>
                <th>Fin dans</th>
              </tr>
            </thead>
            <tbody>
              <For each={orders}>
                {(o) => (
                  <tr>
                    <td>
                      <span
                        class={`sim2-tag2 ${o.side === "SELL" ? "sim2-side-sell" : ""}`}
                      >
                        {o.side === "SELL"
                          ? `${o.orderType ?? "FOK"} - SELL`
                          : o.orderType
                            ? `${o.orderType} - ${o.kind}`
                            : o.kind}
                      </span>
                    </td>
                    <td>
                      <a
                        class="market-link"
                        href={`https://polymarket.com/event/${encodeURIComponent(o.slug)}`}
                        target="_blank"
                        rel="noopener"
                      >
                        {o.market}
                      </a>
                    </td>
                    <td>{o.outcome}</td>
                    <td class="num">{fmtPrice(o.price)}</td>
                    <td class="num">{o.size}</td>
                    <td class="num">{formatReturnPct(o.price)}</td>
                    <td>
                      <span class="sim2-tag2">
                        {isRejected(o)
                          ? `rejeté · ${reasonLabel(o.reason)}`
                          : o.reason === "cancelled"
                            ? "annulé"
                            : o.reason === "resting" && o.fillPrice == null
                              ? "en attente"
                              : o.fillPrice != null
                                ? `rempli @ ${fmtPrice(o.fillPrice)}`
                                : "rempli"}
                      </span>
                    </td>
                    <td class="num">
                      <span class="sim2-cd">{countdown(o.windowEnd, props.now)}</span>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
      <ConfirmModal
        open={confirmClear()}
        title={`Purger les ordres rejetés (${rejectedRows().length}) ?`}
        message="Les lignes « rejeté » (pré-checks locaux — solde, plafonds, fenêtres) sont supprimées du journal DB. Les ordres remplis, GTC en attente et annulés restent intacts."
        confirmLabel="Purger"
        onConfirm={() => void clearRejected()}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}
