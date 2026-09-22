import type { ClobSocketMessage } from "./clob-socket.js";
import type { TokenBook } from "../types.js";
import { rankedLevels } from "../utils/market.js";

interface WsBookPayload {
  asset_id: string;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}

interface WsPriceChangePayload {
  asset_id: string;
  changes?: Array<{ price: string; side: string; size: string }>;
}

interface CacheEntry {
  bids: Map<number, number>;
  asks: Map<number, number>;
  lastUpdateMs: number;
}

/**
 * Cache de carnets alimenté par le market channel du CLOB WS.
 * - Au connect, le serveur envoie un snapshot `book` complet par asset.
 * - Deltas `price_change` appliqués incrémentalement (size 0 = retrait de niveau).
 * - `isLive()` = connecté ET activité récente — staleness au niveau socket,
 *   PAS par asset : un marché calme n'émet rien mais son carnet inchangé
 *   reste valide.
 * - `heal()` : un snapshot REST réussi (fallback) répare le cache top-3.
 * - Pur (pas de socket) : le provider route les messages et les statuts.
 */
export class MarketFeed {
  private readonly books = new Map<string, CacheEntry>();
  private assets: string[] = [];
  private connected = false;
  private lastActivityMs = 0;

  constructor(private readonly maxAgeMs: number) {}

  /** Statut socket (provider) — à l'ouverture on rafraîchit l'horodatage d'activité. */
  setConnected(up: boolean): void {
    this.connected = up;
    if (up) this.lastActivityMs = Date.now();
  }

  handleMessage(msg: ClobSocketMessage): void {
    this.lastActivityMs = Date.now();
    switch (msg.event_type) {
      case "book":
        this.applySnapshot(msg as unknown as WsBookPayload);
        return;
      case "price_change":
        this.applyPriceChange(msg as unknown as WsPriceChangePayload);
        return;
      default:
        return; // tick_size_change etc. ignorés — le tick size vient de Gamma
    }
  }

  getAssets(): string[] {
    return [...this.assets];
  }

  /** Remplace le set d'assets suivi et purge les carnets hors set. */
  setAssets(ids: string[]): void {
    this.assets = [...new Set(ids)];
    for (const key of [...this.books.keys()]) {
      if (!this.assets.includes(key)) this.books.delete(key);
    }
  }

  isLive(): boolean {
    if (!this.connected) return false;
    return Date.now() - this.lastActivityMs <= this.maxAgeMs;
  }

  getBook(tokenId: string): TokenBook | null {
    const entry = this.books.get(tokenId);
    if (!entry) return null;
    return tokenBookFromMaps(tokenId, entry);
  }

  /** Heal : le fallback REST réussi répare le cache top-3 (dérive post-reconnexion). */
  heal(tokenId: string, book: TokenBook): void {
    const entry: CacheEntry = this.books.get(tokenId) ?? {
      bids: new Map<number, number>(),
      asks: new Map<number, number>(),
      lastUpdateMs: Date.now(),
    };
    entry.bids.clear();
    entry.asks.clear();
    // TokenBook ne porte que le top-3 : le heal restaure exactement ce top-3.
    if (book.bestBid != null) entry.bids.set(book.bestBid, book.bestBidSize ?? 0);
    if (book.bid2 != null) entry.bids.set(book.bid2, book.bid2Size ?? 0);
    if (book.bid3 != null) entry.bids.set(book.bid3, book.bid3Size ?? 0);
    if (book.bestAsk != null) entry.asks.set(book.bestAsk, book.bestAskSize ?? 0);
    if (book.ask2 != null) entry.asks.set(book.ask2, book.ask2Size ?? 0);
    if (book.ask3 != null) entry.asks.set(book.ask3, book.ask3Size ?? 0);
    entry.lastUpdateMs = Date.now();
    this.books.set(tokenId, entry);
  }

  private applySnapshot(payload: WsBookPayload): void {
    const entry: CacheEntry = {
      bids: new Map<number, number>(),
      asks: new Map<number, number>(),
      lastUpdateMs: Date.now(),
    };
    for (const level of payload.bids ?? []) {
      const price = Number(level.price);
      const size = Number(level.size);
      if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
        entry.bids.set(price, size);
      }
    }
    for (const level of payload.asks ?? []) {
      const price = Number(level.price);
      const size = Number(level.size);
      if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
        entry.asks.set(price, size);
      }
    }
    this.books.set(payload.asset_id, entry);
  }

  private applyPriceChange(payload: WsPriceChangePayload): void {
    const entry = this.books.get(payload.asset_id);
    if (!entry) return; // pas encore de snapshot — ignoré, heal REST possible
    for (const change of payload.changes ?? []) {
      const price = Number(change.price);
      const size = Number(change.size);
      if (!Number.isFinite(price)) continue;
      const side = change.side === "BUY" ? entry.bids : entry.asks;
      if (!Number.isFinite(size) || size <= 0) {
        side.delete(price);
      } else {
        side.set(price, size);
      }
    }
    entry.lastUpdateMs = Date.now();
  }
}

function tokenBookFromMaps(tokenId: string, entry: CacheEntry): TokenBook {
  const bids = mapToLevels(entry.bids);
  const asks = mapToLevels(entry.asks);
  const bidRanks = rankedLevels(bids, "bid", 3);
  const askRanks = rankedLevels(asks, "ask", 3);
  return {
    tokenId,
    outcome: "",
    outcomeIndex: 0,
    bestBid: bidRanks[0]?.price ?? null,
    bestBidSize: bidRanks[0]?.size ?? null,
    bestAsk: askRanks[0]?.price ?? null,
    bestAskSize: askRanks[0]?.size ?? null,
    bid2: bidRanks[1]?.price ?? null,
    bid2Size: bidRanks[1]?.size ?? null,
    bid3: bidRanks[2]?.price ?? null,
    bid3Size: bidRanks[2]?.size ?? null,
    ask2: askRanks[1]?.price ?? null,
    ask2Size: askRanks[1]?.size ?? null,
    ask3: askRanks[2]?.price ?? null,
    ask3Size: askRanks[2]?.size ?? null,
  };
}

function mapToLevels(map: Map<number, number>): Array<{ price: string; size: string }> {
  return [...map.entries()].map(([price, size]) => ({
    price: String(price),
    size: String(size),
  }));
}