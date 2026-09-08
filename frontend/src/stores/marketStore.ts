import { createStore, reconcile } from "solid-js/store";
import type { MarketView, TokenBook, UpDownEvent } from "../types";

// IMPORTANT: Solid stores do NOT track Map mutations (set/delete).
// Use a Record indexed by slug + path-based updates.
export const [markets, setMarkets] = createStore<Record<string, MarketView>>({});

export function upsertMarket(event: UpDownEvent, books: TokenBook[]): void {
  setMarkets(event.slug, {
    ...event,
    books,
    reverseTokenId: markets[event.slug]?.reverseTokenId,
  });
}

export function setReverseToken(slug: string, tokenId: string): void {
  setMarkets(slug, "reverseTokenId", tokenId);
}

export function clearMarkets(): void {
  setMarkets(reconcile({}));
}

export function retainMarkets(slugs: string[]): void {
  const keep = new Set(slugs);
  const next: Record<string, MarketView> = {};
  for (const [slug, market] of Object.entries(markets)) {
    if (keep.has(slug)) next[slug] = market;
  }
  setMarkets(reconcile(next));
}

export function marketList(now = Date.now()): MarketView[] {
  const nowSec = now / 1000;
  return Object.values(markets)
    .filter((market) => market.windowEnd >= nowSec)
    .sort((a, b) => b.windowEnd - a.windowEnd);
}
