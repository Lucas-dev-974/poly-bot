import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import {
  polyPositions,
  redeemedConditions,
  redeemingConditions,
} from "../../stores/polyStore";
import { orders } from "../../stores/orderStore";
import { openPositionList, resolvedPositions } from "../../stores/positionStore";
import { dateTimeStr, fmtPrice, fmtUsd } from "../../utils/format";
import { marketRecencyMs } from "../../utils/market";
import { MarketHistoryModal, positionToChartTarget } from "../modals/MarketHistoryModal";
import type { PolymarketPosition } from "../../types";

/** Identifie un marché par son créneau visible (titre = date + heure), pas par token. */
function marketKey(position: PolymarketPosition): string {
  const title = position.title.trim().toLowerCase();
  if (title) return title;
  const slugTs = position.slug.match(/(\d{10})$/);
  if (slugTs) return slugTs[1];
  if (position.slug) return position.slug;
  return position.conditionId;
}

/** Marché soldé : le prix CLOB est collé à 0 ou 1. */
function isSettled(position: PolymarketPosition): boolean {
  return position.curPrice <= 0.01 || position.curPrice >= 0.99;
}

function isOpenHeld(position: PolymarketPosition): boolean {
  return !position.closed && position.size > 0;
}

/** Position encore en cours — on n'utilise pas le flag API `redeemable`. */
function isActivePosition(position: PolymarketPosition): boolean {
  return isOpenHeld(position) && !isSettled(position);
}

/** Position résolue, encore en portefeuille (à clôturer). */
function isRedeemablePosition(position: PolymarketPosition): boolean {
  return isOpenHeld(position) && isSettled(position);
}

type StatusFilter = "all" | "open" | "closed" | "redeemable" | "active";
type KindFilter = "all" | "cheap" | "expensive";

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "Toutes" },
  { id: "open", label: "Ouvertes" },
  { id: "closed", label: "Clôturées" },
  { id: "redeemable", label: "Redeemable" },
  { id: "active", label: "Actives" },
];

const KIND_FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: "all", label: "Tous types" },
  { id: "cheap", label: "cheap" },
  { id: "expensive", label: "expensive" },
];

function positionMeta(
  position: PolymarketPosition,
): {
  kind: "cheap" | "expensive" | null;
  orderType: "GTC" | "FOK" | "FAK" | "SIM" | null;
  strategyId: "arb" | "barbell" | "edge-lead" | null;
} {
  const botPositions = [...openPositionList(), ...resolvedPositions];
  let kind: "cheap" | "expensive" | null = null;
  let orderType: "GTC" | "FOK" | "FAK" | "SIM" | null = null;
  let strategyId: "arb" | "barbell" | "edge-lead" | null = null;

  // 1. Match autoritatif par tokenId (asset). Les slugs Data API et bot
  //    diffèrent souvent (btc-updown-15m-TS vs slug événement lisible).
  if (position.asset) {
    const byToken = botPositions.find((sp) => sp.tokenId === position.asset);
    if (byToken?.kind) {
      kind = byToken.kind;
      orderType = byToken.orderType ?? null;
      strategyId = byToken.strategyId ?? null;
    }
    // Fallback orderType depuis le store orders si la position n'en a pas
    // (positions anciennes créées avant l'ajout du champ orderType).
    if (!orderType) {
      const byOrder = orders.find((o) => o.tokenId === position.asset);
      if (byOrder?.orderType) {
        orderType = byOrder.orderType;
        if (!kind) kind = byOrder.kind;
      }
    }
  }

  if (kind) return { kind, orderType, strategyId };

  // 2. Match par titre de marché + outcome (même fenêtre horaire).
  const byTitle = botPositions.find(
    (sp) =>
      sp.outcome === position.outcome &&
      (sp.eventTitle === position.title || sp.eventSlug === position.slug),
  );
  if (byTitle?.kind) {
    // Fallback orderType depuis le store orders via le tokenId de la position bot.
    const ot = byTitle.orderType
      ?? orders.find((o) => o.tokenId === byTitle.tokenId)?.orderType
      ?? null;
    return { kind: byTitle.kind, orderType: ot, strategyId: byTitle.strategyId ?? null };
  }

  // 3. Les deux jambes du même marché : le fill le plus bas est cheap.
  const siblings = polyPositions.filter(
    (p) => marketKey(p) === marketKey(position) && p.asset !== position.asset,
  );
  if (
    siblings.length > 0 &&
    Number.isFinite(position.avgPrice) &&
    Number.isFinite(siblings[0].avgPrice)
  ) {
    if (position.avgPrice < siblings[0].avgPrice) {
      return { kind: "cheap", orderType: null, strategyId: null };
    }
    if (position.avgPrice > siblings[0].avgPrice) {
      return { kind: "expensive", orderType: null, strategyId: null };
    }
  }

  // 4. Marché binaire : sous 0.50 = underdog (cheap), sinon favorite.
  //    Les seuils de config laissent un trou (ex. 0.25–0.85) où un fill
  //    à 0.82 était classé nulle part, ou au mauvais type.
  if (Number.isFinite(position.avgPrice) && position.avgPrice > 0) {
    return {
      kind: position.avgPrice < 0.5 ? "cheap" : "expensive",
      orderType: null,
      strategyId: null,
    };
  }
  return { kind: null, orderType: null, strategyId: null };
}

function positionCost(position: PolymarketPosition): number {
  if (Number.isFinite(position.cost) && position.cost > 0) return position.cost;
  return position.size * position.avgPrice;
}

/** Actives → redeemable → résolues ouvertes → clôturées. */
function statusRank(position: PolymarketPosition): number {
  if (isActivePosition(position)) return 0;
  if (isRedeemablePosition(position)) return 1;
  if (!position.closed) return 2;
  return 3;
}

function matchesStatus(
  position: PolymarketPosition,
  filter: StatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "open") return !position.closed;
  if (filter === "closed") return Boolean(position.closed);
  if (filter === "redeemable") return isRedeemablePosition(position);
  return isActivePosition(position);
}

export function PolymarketPositions(props: {
  onRedeem: (conditionId: string) => void;
}): JSX.Element {
  const [statusFilter, setStatusFilter] = createSignal<StatusFilter>("all");
  const [kindFilter, setKindFilter] = createSignal<KindFilter>("all");
  const [query, setQuery] = createSignal("");
  const [chartPosition, setChartPosition] = createSignal<PolymarketPosition | null>(null);

  const counts = createMemo(() => {
    const closed = polyPositions.filter((p) => p.closed).length;
    const open = polyPositions.length - closed;
    return { open, closed, total: polyPositions.length };
  });

  // Statistiques de P&L sur l'ensemble des positions (hors filtre).
  const pnlStats = createMemo(() => {
    let totalGain = 0;
    let totalLoss = 0;
    let redeemableGainCount = 0;
    for (const p of polyPositions) {
      const pnl = Number.isFinite(p.cashPnl) ? p.cashPnl : 0;
      if (pnl > 0) totalGain += pnl;
      else if (pnl < 0) totalLoss += pnl;
      // Position redeemable, non clôturée, en gain.
      if (!p.closed && isRedeemablePosition(p) && pnl > 0) redeemableGainCount++;
    }
    return { totalGain, totalLoss, netPnl: totalGain + totalLoss, redeemableGainCount };
  });

  const title = createMemo(() => {
    const { open, closed, total } = counts();
    if (total === 0) return "Positions Polymarket";
    const { totalGain, totalLoss, netPnl, redeemableGainCount } = pnlStats();
    return (
      `Positions Polymarket (${open} ouvertes · ${closed} clôturées · ${total} total) · ` +
      `Gain ${fmtUsd(totalGain)} · Perte ${fmtUsd(totalLoss)} · ` +
      `Net ${fmtUsd(netPnl)} · Redeemable en gain ${redeemableGainCount}`
    );
  });

  const visible = createMemo(() => {
    const status = statusFilter();
    const kind = kindFilter();
    const q = query().trim().toLowerCase();
    const rows = polyPositions.flatMap((p) => {
      if (!matchesStatus(p, status)) return [];
      const meta = positionMeta(p);
      if (kind !== "all" && meta.kind !== kind) return [];
      if (!q) return [{ position: p, meta }];
      return (
        p.title.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        p.outcome.toLowerCase().includes(q)
      ) ? [{ position: p, meta }] : [];
    });

    const groupRecency = new Map<string, number>();
    const groupStatus = new Map<string, number>();
    for (const r of rows) {
      const key = marketKey(r.position);
      groupRecency.set(
        key,
        Math.max(groupRecency.get(key) ?? 0, marketRecencyMs(r.position)),
      );
      groupStatus.set(
        key,
        Math.min(groupStatus.get(key) ?? Number.POSITIVE_INFINITY, statusRank(r.position)),
      );
    }
    const sorted = [...rows].sort((a, b) => {
      const ka = marketKey(a.position);
      const kb = marketKey(b.position);
      if (ka !== kb) {
        const status = (groupStatus.get(ka) ?? 9) - (groupStatus.get(kb) ?? 9);
        if (status !== 0) return status;
        const recency = (groupRecency.get(kb) ?? 0) - (groupRecency.get(ka) ?? 0);
        if (recency !== 0) return recency;
        return ka.localeCompare(kb);
      }
      return a.position.outcomeIndex - b.position.outcomeIndex;
    });

    // Flag collé sur chaque ligne : on alterne à chaque changement de
    // titre/créneau, pas via un Set de clés (mismatch Solid store).
    let prevKey = "";
    let groupIndex = -1;
    return sorted.map((r) => {
      const key = marketKey(r.position);
      if (key !== prevKey) {
        groupIndex += 1;
        prevKey = key;
      }
      return { position: r.position, meta: r.meta, striped: groupIndex % 2 === 0 };
    });
  });

  return (
    <>
      <Panel title={title()} full>
      <Show
        when={polyPositions.length > 0}
        fallback={<EmptyState text="En attente de données…" />}
      >
        <div class="poly-filter-bar">
          <div class="poly-filter-group">
            <For each={STATUS_FILTERS}>
              {(f) => (
                <button
                  class={`poly-filter-btn${statusFilter() === f.id ? " active" : ""}`}
                  onClick={() => setStatusFilter(f.id)}
                >
                  {f.label}
                </button>
              )}
            </For>
          </div>
          <div class="poly-filter-group">
            <For each={KIND_FILTERS}>
              {(f) => (
                <button
                  class={`poly-filter-btn${kindFilter() === f.id ? " active" : ""}`}
                  onClick={() => setKindFilter(f.id)}
                >
                  {f.label}
                </button>
              )}
            </For>
          </div>
          <input
            class="poly-filter-search"
            type="search"
            placeholder="Filtrer par marché ou outcome…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <span class="muted poly-filter-count">
            {visible().length}/{counts().total}
          </span>
        </div>
        <Show
          when={visible().length > 0}
          fallback={<EmptyState text="Aucune position pour ce filtre." />}
        >
          <div class="poly-positions-scroll">
            <table>
              <thead>
                <tr>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th>Type</th>
                  <th>Moteur</th>
                  <th>Fill</th>
                  <th>Taille</th>
                  <th>Coût</th>
                  <th>Prix actuel</th>
                  <th>Valeur</th>
                  <th>P&L</th>
                  <th>Statut</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                <For each={visible()}>
                  {(row) => {
                    const p = row.position;
                    const closed = Boolean(p.closed);
                    const meta = row.meta;
                    const kind = meta.kind;
                    const orderType = meta.orderType;
                    const strategyId = meta.strategyId;
                    const status = closed ? (
                      <Badge variant="cheap">clôturée</Badge>
                    ) : isRedeemablePosition(p) ? (
                      <Badge variant="dry">redeemable</Badge>
                    ) : isActivePosition(p) ? (
                      <Badge variant="live">active</Badge>
                    ) : (
                      <Badge variant="cheap">résolue</Badge>
                    );

                    const canRedeem =
                      isRedeemablePosition(p) && Boolean(p.redeemable);
                    const canChart = Boolean(p.conditionId) && Boolean(p.asset);
                    let action: JSX.Element;
                    if (closed || redeemedConditions[p.conditionId]) {
                      action = (
                        <span>
                          <Badge variant="live">clôturée ✓</Badge>
                          {p.timestamp ? (
                            <span class="muted"> {dateTimeStr(p.timestamp)}</span>
                          ) : null}
                        </span>
                      );
                    } else if (redeemingConditions[p.conditionId]) {
                      action = (
                        <button class="redeem-btn" disabled>
                          En cours…
                        </button>
                      );
                    } else if (canRedeem) {
                      action = (
                        <button
                          class="redeem-btn"
                          onClick={() => props.onRedeem(p.conditionId)}
                        >
                          Clôturer
                        </button>
                      );
                    } else {
                      action = <span class="muted">—</span>;
                    }

                    const actionCell = (
                      <span class="poly-action-cell">
                        <button
                          class="chart-btn"
                          type="button"
                          title={
                            canChart
                              ? "Voir le graphique du marché"
                              : "Données indisponibles"
                          }
                          disabled={!canChart}
                          onClick={() => setChartPosition(p)}
                        >
                          📊
                        </button>
                        {action}
                      </span>
                    );

                    const rowBg = row.striped ? "#323a48" : undefined;
                    const cellStyle = { background: rowBg };
                    return (
                      <tr
                        classList={{ "poly-row-market": row.striped }}
                      >
                        <td style={cellStyle}>
                          <a
                            class="market-link"
                            href={`https://polymarket.com/event/${encodeURIComponent(p.slug)}`}
                            target="_blank"
                            rel="noopener"
                          >
                            {p.title}
                          </a>
                        </td>
                        <td style={cellStyle}>{p.outcome}</td>
                        <td style={cellStyle}>
                          {kind ? (
                            <Badge variant={kind}>
                              {orderType ? `${orderType} - ${kind}` : kind}
                            </Badge>
                          ) : (
                            <span class="muted">—</span>
                          )}
                        </td>
                        <td style={cellStyle}>{strategyId ?? "—"}</td>
                        <td style={cellStyle}>{fmtPrice(p.avgPrice)}</td>
                        <td style={cellStyle}>{p.size}</td>
                        <td style={cellStyle}>{fmtUsd(positionCost(p))}</td>
                        <td style={cellStyle}>{fmtPrice(p.curPrice)}</td>
                        <td style={cellStyle}>{fmtUsd(p.currentValue)}</td>
                        <td class={p.cashPnl >= 0 ? "ok" : "err"} style={cellStyle}>
                          {fmtUsd(p.cashPnl)} ({p.percentPnl.toFixed(1)}%)
                        </td>
                        <td style={cellStyle}>{status}</td>
                        <td style={cellStyle}>{actionCell}</td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
    </Panel>
    <Show when={chartPosition()}>
      {(p) => (
        <MarketHistoryModal
          target={positionToChartTarget(p())}
          onClose={() => setChartPosition(null)}
        />
      )}
    </Show>
    </>
  );
}
