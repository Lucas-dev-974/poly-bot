import { createStore, reconcile } from "solid-js/store";
import type { MarketView, TokenBook, UpDownEvent } from "../types";

// IMPORTANT: Solid stores do NOT track Map mutations (set/delete).
// Use a Record indexed by slug + path-based updates.
export const [markets, setMarkets] = createStore<Record<string, MarketView>>({});

/**
 * Index tokenId → slug maintenu à chaque upsert/retain/clear.
 * Les books/bids sont lus live depuis markets (évite copies stale via reconcile).
 * Record + createStore pour tracking Solid (pas de Map).
 */
type TokenMarketRef = { slug: string };
export const [tokenIndex, setTokenIndex] = createStore<Record<string, TokenMarketRef>>({});


/** Rebuild complet : peu de marchés actifs → O(markets×books) négligeable vs rows UI. */
function syncTokenIndex(): void {
  const idx: Record<string, TokenMarketRef> = {};
  for (const [slug, market] of Object.entries(markets)) {
    for (const book of market.books) {
      // Index slug only — book fields are read live from markets so bids/titles
      // cannot go stale between upserts (reconcile copies would diverge).
      idx[book.tokenId] = { slug };
    }
  }
  setTokenIndex(reconcile(idx));
}

/**
 * Comparaison champ-à-champ d'un TokenBook : identité par VALEUR, pas par
 * référence. Les books arrivent du SSE comme objets neufs à chaque tick ;
 * comparer par valeur permet de réutiliser les objets existants et donc
 * de garder l'identité référentielle utilisée par <For>/<Index> de Solid
 * (sinon les tuiles sont détruites/recréées → perte de focus des inputs).
 */
function booksEqual(a: TokenBook, b: TokenBook): boolean {
  return (
    a.tokenId === b.tokenId &&
    a.outcome === b.outcome &&
    a.outcomeIndex === b.outcomeIndex &&
    a.bestBid === b.bestBid &&
    a.bestAsk === b.bestAsk &&
    a.bestAskSize === b.bestAskSize &&
    a.bestBidSize === b.bestBidSize &&
    a.ask2 === b.ask2 &&
    a.ask2Size === b.ask2Size &&
    a.ask3 === b.ask3 &&
    a.ask3Size === b.ask3Size &&
    a.bid2 === b.bid2 &&
    a.bid2Size === b.bid2Size &&
    a.bid3 === b.bid3 &&
    a.bid3Size === b.bid3Size
  );
}

export function upsertMarket(event: UpDownEvent, books: TokenBook[]): void {
  const prev = markets[event.slug];
  if (prev) {
    // Champs affichés par les cartes : titre + fenêtre + books. Le reste
    // (market.*, volumes…) n'est pas rendu → pas besoin d'écrire le store.
    const sameEvent =
      prev.title === event.title &&
      prev.windowStart === event.windowStart &&
      prev.windowEnd === event.windowEnd;
    const sameBooks =
      prev.books.length === books.length &&
      prev.books.every((b, i) => booksEqual(b, books[i]));
    // Rien de neuf → aucun write store → aucun re-render, le focus des
    // inputs d'achat inline est préservé.
    if (sameEvent && sameBooks) return;
    // Données changées : merge fin dans le nœud existant (identité du
    // proxy préservée) en réutilisant les objets book inchangés.
    const nextBooks =
      prev.books.length === books.length
        ? books.map((b, i) => (booksEqual(prev.books[i], b) ? prev.books[i] : b))
        : books;
    setMarkets(event.slug, {
      ...event,
      books: nextBooks,
      reverseTokenId: prev.reverseTokenId,
    });
    syncTokenIndex();
    return;
  }
  setMarkets(event.slug, {
    ...event,
    books,
    reverseTokenId: markets[event.slug]?.reverseTokenId,
  });
  syncTokenIndex();
}

export function setReverseToken(slug: string, tokenId: string): void {
  setMarkets(slug, "reverseTokenId", tokenId);
}

export function clearMarkets(): void {
  setMarkets(reconcile({}));
  setTokenIndex(reconcile({}));
}

export function retainMarkets(slugs: string[]): void {
  const keep = new Set(slugs);
  const next: Record<string, MarketView> = {};
  for (const [slug, market] of Object.entries(markets)) {
    if (keep.has(slug)) next[slug] = market;
  }
  setMarkets(reconcile(next));
  syncTokenIndex();
}

export function marketList(now = Date.now()): MarketView[] {
  const nowSec = now / 1000;
  return Object.values(markets)
    .filter((market) => market.windowEnd >= nowSec)
    .sort((a, b) => b.windowEnd - a.windowEnd);
}

/** Lookup O(1) index + lecture live du book dans markets (anti-stale). */
function bookForToken(tokenId: string): TokenBook | undefined {
  const slug = tokenIndex[tokenId]?.slug;
  if (!slug) return undefined;
  return markets[slug]?.books.find((b) => b.tokenId === tokenId);
}

/** Bid live O(1) — utilisé par SimulationPage (unrealized PnL / resting). */
export function liveBidForToken(tokenId: string): number | null {
  const bid = bookForToken(tokenId)?.bestBid;
  return bid != null ? bid : null;
}

/** Titre marché O(1) pour un tokenId ; fallback tronqué si inconnu. */
export function marketTitleForToken(tokenId: string): string {
  const ref = tokenIndex[tokenId];
  if (ref) {
    const m = markets[ref.slug];
    if (m?.title) return m.title;
  }
  return tokenId.length > 14 ? `${tokenId.slice(0, 14)}…` : tokenId;
}