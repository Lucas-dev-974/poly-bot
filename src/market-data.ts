import type { BotConfig } from "./config.js";
import { log } from "./logger.js";
import { MarketScanner } from "./market-scanner.js";
import type { TokenBook, UpDownEvent } from "./types.js";
import { parseGammaList } from "./utils/market.js";
import { ClobSocket } from "./ws/clob-socket.js";
import { MarketFeed } from "./ws/market-feed.js";
import { UserFeed, type WsOrderStatus } from "./ws/user-feed.js";

/**
 * Surface book/scan requise par le bot et ses sous-composants. MarketScanner
 * la satisfait structurellement ; le provider la satisfait aussi.
 */
export interface BookSource {
  scan(): Promise<UpDownEvent[]>;
  inTradingWindow(event: UpDownEvent, nowSec?: number): boolean;
  getTokenBooks(event: UpDownEvent): Promise<TokenBook[]>;
  getTokenBook(tokenId: string): Promise<TokenBook | null>;
}

export interface WsStatusPayload {
  channel: "market" | "user";
  connected: boolean;
  reconnects: number;
}

const ASSET_SET_DEBOUNCE_MS = 2_000;

/**
 * Provider de données de marché : WS primaire (market channel), REST fallback.
 * Drop-in du scanner — expose la même surface (scan, inTradingWindow,
 * getTokenBooks, getTokenBook). Les appelants ne changent pas de logique.
 */
export class MarketDataProvider implements BookSource {
  private readonly scanner: MarketScanner;
  private readonly feed: MarketFeed | null;
  private socket: ClobSocket | null = null;
  private wsConnected = false;
  private reconnects = 0;
  private assetTimer: ReturnType<typeof setTimeout> | null = null;
  /** User channel (fills temps réel) — null sans creds API. */
  private userFeed: UserFeed | null = null;
  /** Callback du bot pour finaliser un ordre fillé vu par le user channel. */
  onFill: ((status: WsOrderStatus) => void) | null = null;
  /** Callback du bot après reconnexion user channel (rattrapage). */
  onUserReconnected: (() => void) | null = null;

  constructor(
    private readonly config: BotConfig,
    private readonly onWsStatus?: (payload: WsStatusPayload) => void,
  ) {
    this.scanner = new MarketScanner(config);
    this.feed = config.wsEnabled
      ? new MarketFeed(config.wsBookMaxAgeMs)
      : null;
  }

  /** Connecte le socket market (si activé). Sans effet si WS désactivé. */
  start(initialAssets: string[] = []): void {
    if (!this.config.wsEnabled || !this.feed) {
      log("WS disabled — REST polling only");
      return;
    }
    this.feed.setAssets(initialAssets);
    const feed = this.feed;
    this.socket = new ClobSocket({
      url: this.config.wsMarketHost,
      onMessage: (msg) => feed.handleMessage(msg),
      onStatus: (up) => {
        const was = this.wsConnected;
        this.wsConnected = up;
        feed.setConnected(up);
        if (!up && was) this.reconnects++;
        this.onWsStatus?.({
          channel: "market",
          connected: up,
          reconnects: this.reconnects,
        });
      },
    });
    this.socket.connect();

    // User channel (fills temps réel) — uniquement avec creds API complets.
    if (this.config.clobApiKey && this.config.clobSecret && this.config.clobPassphrase) {
      this.userFeed = new UserFeed({
        wsUserHost: this.config.wsUserHost,
        apiKey: this.config.clobApiKey,
        apiSecret: this.config.clobSecret,
        apiPassphrase: this.config.clobPassphrase,
        onOrderStatus: (status) => this.onFill?.(status),
        onStatus: (up, reconnects) => {
          this.onWsStatus?.({ channel: "user", connected: up, reconnects });
        },
        onReconnected: () => this.onUserReconnected?.(),
      });
      this.userFeed.start();
    }
  }

  async stop(): Promise<void> {
    if (this.assetTimer) {
      clearTimeout(this.assetTimer);
      this.assetTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.userFeed?.stop();
    this.userFeed = null;
  }

  // ---- BookSource : délégation scanner --------------------------------

  scan(): Promise<UpDownEvent[]> {
    return this.scanner.scan();
  }

  inTradingWindow(event: UpDownEvent, nowSec?: number): boolean {
    return this.scanner.inTradingWindow(event, nowSec);
  }

  // ---- Books : WS si frais, sinon REST + heal -------------------------

  getTokenBook(tokenId: string): Promise<TokenBook | null> {
    return this.getTokenBookResolved(tokenId);
  }

  async getTokenBooks(event: UpDownEvent): Promise<TokenBook[]> {
    const tokenIds = parseTokenIds(event);
    const books = await Promise.all(
      tokenIds.map((tokenId) => this.getTokenBookResolved(tokenId)),
    );
    return books.filter((book): book is TokenBook => book !== null);
  }

  private async getTokenBookResolved(
    tokenId: string,
  ): Promise<TokenBook | null> {
    if (this.feed?.isLive()) {
      const cached = this.feed.getBook(tokenId);
      if (cached) return cached;
    }
    // Fallback REST (ou heal si le cache miss alors que le WS est live).
    const book = await this.scanner.getTokenBook(tokenId);
    if (book) this.feed?.heal(tokenId, book);
    return book;
  }

  /**
   * Recalcule le set d'assets à partir des events scannés et reprogramme la
   * reconnexion si le set change (debounce 2 s).
   */
  syncAssets(events: UpDownEvent[]): void {
    if (!this.feed) return;
    const ids: string[] = [];
    for (const event of events) {
      for (const id of parseTokenIds(event)) ids.push(id);
    }
    const next = [...new Set(ids)].sort();
    const current = [...this.feed.getAssets()].sort();
    const changed =
      next.length !== current.length ||
      next.some((v, i) => v !== current[i]);
    if (!changed) return;
    this.feed.setAssets(next);
    this.assetTimer = setTimeout(() => {
      this.assetTimer = null;
      this.socket?.close();
      this.socket?.connect();
    }, ASSET_SET_DEBOUNCE_MS);
  }

  isWsLive(): boolean {
    return this.feed?.isLive() ?? false;
  }
}

function parseTokenIds(event: UpDownEvent): string[] {
  return parseGammaList(event.market.clobTokenIds).filter(Boolean);
}