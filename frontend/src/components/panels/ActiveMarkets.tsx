import { For, Index, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { marketList } from "../../stores/marketStore";
import { ruleFor, refreshMarketRules } from "../../stores/marketRulesStore";
import { countdown, fmtPrice, fmtShares, pct, fmtSpread } from "../../utils/format";
import { MarketHistoryModal, marketToChartTarget } from "../modals/MarketHistoryModal";
import { api } from "../../api/client";
import { pushInfo } from "../../stores/toastStore";
import type { MarketView, TokenBook } from "../../types";

/** Minimum CLOB : un ordre sous 5 shares est refusé par le venue. */
const MIN_SHARES = 5;

/** Seuils d'urgence du compte à rebours (ms). */
const HOT_MS = 5 * 60 * 1000;
const WARM_MS = 15 * 60 * 1000;

/**
 * Famille (préfixe) d'un slug : miroir de `prefixOfSlug` (src/utils/market.ts).
 * Le slug se termine toujours par -<epoch-sec à 10 chiffres>.
 */
function prefixOfSlug(slug: string): string {
  return slug.replace(/-\d{10}$/, "");
}

function countdownClass(windowEnd: number, now: number): string {
  const left = windowEnd * 1000 - now;
  if (left <= HOT_MS) return "am-countdown am-countdown--hot";
  if (left <= WARM_MS) return "am-countdown am-countdown--warm";
  return "am-countdown";
}

/** underdog = celui dont l'ask est le moins cher (jambe achetée par le bot). */
function roleFor(book: TokenBook, books: TokenBook[]): "underdog" | "favorite" {
  const cheapestAsk = Math.min(
    ...books.map((b) => b.bestAsk ?? Number.POSITIVE_INFINITY),
  );
  return book.bestAsk !== null && book.bestAsk === cheapestAsk
    ? "underdog"
    : "favorite";
}

function OutcomeTile(props: {
  book: TokenBook;
  books: TokenBook[];
}): JSX.Element {
  const role = () => roleFor(props.book, props.books);
  const mid = () => {
    const { bestBid, bestAsk } = props.book;
    if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
    return bestAsk ?? bestBid ?? null;
  };
  const spread = () => {
    const { bestBid, bestAsk } = props.book;
    return bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  };

  // Achat inline : champ shares (défaut 5, min 5) + mode d'exécution
  // (FOK immédiat à l'ask / GTC au carnet), dans la tuile elle-même.
  const [sharesInput, setSharesInput] = createSignal("5");
  const [mode, setMode] = createSignal<"fok" | "resting">("fok");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [done, setDone] = createSignal(false);

  const shares = createMemo(() => {
    const n = Number(sharesInput());
    if (!Number.isFinite(n) || n < MIN_SHARES) return null;
    return Math.floor(n);
  });
  const cost = () => {
    const p = props.book.bestAsk;
    const s = shares() ?? 0;
    if (p == null || p <= 0 || s <= 0) return null;
    return s * p;
  };
  const valid = () => shares() !== null && props.book.bestAsk != null;

  // Mode FOK sub-1$ : les shares seront arrondies au-dessus côté bot vers
  // max(5, ceil(1$/ask)) — affiché pour éviter la surprise du coût réel.
  const roundedShares = () => {
    const p = props.book.bestAsk;
    const s = shares() ?? 0;
    if (p == null || p <= 0 || s <= 0) return null;
    if (s * p >= 1) return null;
    return Math.max(MIN_SHARES, Math.ceil(1 / p));
  };
  const roundedCost = () => {
    const p = props.book.bestAsk;
    const r = roundedShares();
    if (p == null || p <= 0 || r === null) return null;
    return r * p;
  };

  const buy = async (): Promise<void> => {
    if (!valid() || busy()) return;
    setError("");
    setBusy(true);
    try {
      const res = await api.manualBuy({
        tokenId: props.book.tokenId,
        shares: shares()!,
        mode: mode(),
      });
      if (res.ok) {
        if (res.pending) {
          pushInfo(
            `Ordre au carnet posté (budget ${fmtPrice(res.requestedUsd ?? 0)} pUSD sous l'ask) — position trackée dès le remplissage`,
          );
        } else {
          pushInfo(
            `Achat exécuté : ${fmtShares(res.size)} shares de ${res.outcome} @ ${fmtPrice(res.fillPrice)} (${fmtPrice(res.cost)} pUSD)`,
          );
        }
        setDone(true);
        setSharesInput("5");
        setTimeout(() => setDone(false), 2500);
      } else {
        setError(res.error ?? "Achat refusé");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={`am-outcome${role() === "underdog" ? " am-outcome--best" : ""}`}>
      <div class="am-outcome__head">
        <span class="am-outcome__name">{props.book.outcome}</span>
        <div class="am-outcome__head-right">
          <Badge variant={role()}>{role()}</Badge>
        </div>
      </div>
      <div class="am-prices">
        <div class="am-price">
          <span class="am-price__label">Ask</span>
          <span class="am-price__value am-price__value--ask">
            {fmtPrice(props.book.bestAsk)}
          </span>
          <span class="am-price__size">{fmtShares(props.book.bestAskSize)} sh</span>
        </div>
        <div class="am-price">
          <span class="am-price__label">Bid</span>
          <span class="am-price__value">{fmtPrice(props.book.bestBid)}</span>
          <span class="am-price__size">{fmtShares(props.book.bestBidSize)} sh</span>
        </div>
      </div>
      <div class="am-prob">
        <div class="am-prob__bar">
          <Show when={mid() != null}>
            <div
              class="am-prob__fill"
              style={{ width: `${Math.min(100, Math.max(0, mid()! * 100))}%` }}
            />
          </Show>
        </div>
        <span class="am-prob__label">{mid() != null ? pct(mid()!) : "—"}</span>
        <Show when={spread() != null}>
          <span class="am-prob__spread" title="Spread ask − bid">
            spread {fmtSpread(spread())}
          </span>
        </Show>
      </div>
      <div class="am-buy-inline">
        <div class="am-buy-mode" role="radiogroup" aria-label="Mode d'exécution">
          <button
            type="button"
            class="am-buy-mode__btn"
            classList={{ "am-buy-mode__btn--active": mode() === "fok" }}
            title="FOK immédiat à l'ask (taker). Sous 1 $, arrondi des shares au-dessus pour atteindre le plancher venue."
            onClick={() => setMode("fok")}
          >
            FOK
          </button>
          <button
            type="button"
            class="am-buy-mode__btn"
            classList={{ "am-buy-mode__btn--active": mode() === "resting" }}
            title="Ordre limite au carnet 1 tick sous l'ask (maker). Shares exactes, fill non garanti, annulé en fin de fenêtre."
            onClick={() => setMode("resting")}
          >
            Carnet
          </button>
        </div>
        <input
          class="am-buy-shares-input"
          type="number"
          inputmode="numeric"
          aria-label={`Nombre de shares à acheter (${props.book.outcome})`}
          min={MIN_SHARES}
          step="1"
          placeholder="5"
          value={sharesInput()}
          onInput={(e) => setSharesInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void buy();
          }}
          disabled={busy()}
        />
        <button
          class="am-buy-btn"
          type="button"
          title={
            mode() === "fok"
              ? `Acheter immédiatement du ${props.book.outcome} au ask (FOK)`
              : `Poster un ordre au carnet pour du ${props.book.outcome} (GTC maker)`
          }
          disabled={!valid() || busy()}
          onClick={() => void buy()}
        >
          {done() ? "✓" : busy() ? "…" : mode() === "fok" ? "Acheter" : "Carnet"}
        </button>
        <span class="am-buy-cost">
          {cost() != null ? `≈ ${fmtPrice(cost()!)} pUSD` : "—"}
        </span>
      </div>
      <Show when={mode() === "fok" && roundedShares() !== null}>
        <p class="am-buy-note">
          Sous 1 $ en FOK : arrondi à <strong>{roundedShares()}</strong> shares
          (≈ {fmtPrice(roundedCost()!)} pUSD) au ask courant.
        </p>
      </Show>
      <Show when={error()}>
        <p class="am-buy-error">{error()}</p>
      </Show>
    </div>
  );
}

type TradeFilter = "all" | "on" | "off";

export function ActiveMarkets(props: { now: number }): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [tradeFilter, setTradeFilter] = createSignal<TradeFilter>("all");
  const [chartMarket, setChartMarket] = createSignal<MarketView | null>(null);

  // Flags trading/recording partagés (miroir de MarketRuleStore côté bot).
  // Famille absente de la table = tradable par défaut. Chargement initial +
  // rafraîchi toutes les 30s ; la modale « Enregistrements » pousse aussi les
  // toggles dans le store partagé → effet immédiat ici.
  void refreshMarketRules();
  const rulesTimer = setInterval(() => void refreshMarketRules(), 30_000);
  onCleanup(() => clearInterval(rulesTimer));

  const isTradable = (slug: string): boolean => {
    const row = ruleFor(prefixOfSlug(slug));
    return row ? row.tradingEnabled === 1 : true;
  };

  const list = createMemo(() => {
    const q = query().trim().toLowerCase();
    const tf = tradeFilter();
    // Tri par fin de fenêtre croissante : les marchés qui se terminent bientôt en premier.
    const all = marketList(props.now)
      .slice()
      .sort((a, b) => a.windowEnd - b.windowEnd)
      .filter((m) => {
        if (tf === "on") return isTradable(m.slug);
        if (tf === "off") return !isTradable(m.slug);
        return true;
      });
    if (!q) return all;
    return all.filter(
      (m) => m.title.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q),
    );
  });

  return (
    <>
      <Panel title="Marchés actifs">
        <div class="am-toolbar">
          <input
            class="am-search"
            type="search"
            placeholder="Filtrer un marché…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <div class="am-filter-group">
            <button
              class="am-filter-btn"
              classList={{ "am-filter-btn--active": tradeFilter() === "all" }}
              type="button"
              title="Afficher tous les marchés"
              onClick={() => setTradeFilter("all")}
            >
              Tous
            </button>
            <button
              class="am-filter-btn am-filter-btn--on"
              classList={{ "am-filter-btn--active": tradeFilter() === "on" }}
              type="button"
              title="Afficher uniquement les marchés activés pour le trading"
              onClick={() => setTradeFilter("on")}
            >
              ● Trading
            </button>
            <button
              class="am-filter-btn am-filter-btn--off"
              classList={{ "am-filter-btn--active": tradeFilter() === "off" }}
              type="button"
              title="Afficher uniquement les marchés désactivés pour le trading"
              onClick={() => setTradeFilter("off")}
            >
              ○ Hors trade
            </button>
          </div>
          <span class="am-count">
            {list().length} {list().length > 1 ? "marchés" : "marché"}
          </span>
        </div>
        <Show
          when={list().length > 0}
          fallback={
            <EmptyState
              text={
                query().trim() || tradeFilter() !== "all"
                  ? "Aucun marché ne correspond au filtre"
                  : "En attente de données…"
              }
            />
          }
        >
          <div class="am-scroll">
            <For each={list()}>
              {(m) => (
                <article
                  class="am-card"
                  classList={{ "am-card--muted": !isTradable(m.slug) }}
                >
                  <header class="am-card__head">
                    <a
                      class="am-title"
                      href={`https://polymarket.com/event/${encodeURIComponent(m.slug)}`}
                      target="_blank"
                      rel="noopener"
                      title="Ouvrir sur Polymarket"
                    >
                      {m.title}
                    </a>
                    <div class="am-card__meta">
                      <span
                        class={countdownClass(m.windowEnd, props.now)}
                        title="Temps restant avant la fin de la fenêtre"
                      >
                        ⏱ {countdown(m.windowEnd, props.now)}
                      </span>
                      <span
                        class={`am-trade-flag ${isTradable(m.slug) ? "am-trade-flag--on" : "am-trade-flag--off"}`}
                        title={
                          isTradable(m.slug)
                            ? "Trading activé pour cette famille"
                            : "Trading désactivé pour cette famille"
                        }
                      >
                        {isTradable(m.slug) ? "trade" : "no-trade"}
                      </span>
                      <button
                        class="chart-btn"
                        type="button"
                        title={m.books.length > 0 ? "Voir le graphique" : "Données indisponibles"}
                        disabled={m.books.length === 0}
                        onClick={() => setChartMarket(m)}
                      >
                        📊
                      </button>
                    </div>
                  </header>
                  <Show
                    when={m.books.length > 0}
                    fallback={<div class="am-outcome am-outcome--empty">Données indisponibles</div>}
                  >
                    <div class="am-card__outcomes">
                      <Index each={m.books}>
                        {(book) => <OutcomeTile book={book()} books={m.books} />}
                      </Index>
                    </div>
                  </Show>
                </article>
              )}
            </For>
          </div>
        </Show>
      </Panel>
      <Show when={chartMarket()}>
        {(m) => (
          <MarketHistoryModal
            target={marketToChartTarget(m())}
            onClose={() => setChartMarket(null)}
          />
        )}
      </Show>
    </>
  );
}