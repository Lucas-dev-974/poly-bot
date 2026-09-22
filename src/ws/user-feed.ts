import { log } from "../logger.js";
import { normalizeOrderStatus } from "../utils/order-status.js";
import { ClobSocket, type ClobSocketMessage } from "./clob-socket.js";

/** Statut normalisé d'un ordre vu par le user channel. */
export interface WsOrderStatus {
  orderId: string;
  assetId?: string;
  filled: boolean;
  cancelled: boolean;
  sizeMatched: number;
}

export interface UserFeedOptions {
  wsUserHost: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  onOrderStatus: (status: WsOrderStatus) => void;
  /** Changement d'état connecté/déconnecté (optionnel, dashboard). */
  onStatus?: (connected: boolean, reconnects: number) => void;
  /** Déclenché après chaque reconnexion (rattrapage des messages perdus). */
  onReconnected?: () => void;
}

/**
 * User channel CLOB : fills/ordres du compte en temps réel.
 * Subscribe authentifié à l'ouverture ; les messages `order`/`trade` sont
 * normalisés vers WsOrderStatus et routés au callback. Sans creds API, ne
 * pas instancier — le comportement reste celui d'avant (réconciliation REST).
 */
export class UserFeed {
  private socket: ClobSocket | null = null;
  private connected = false;
  private reconnects = 0;

  constructor(private readonly opts: UserFeedOptions) {}

  /** Démarre la connexion. Le subscribe part à l'ouverture du socket. */
  start(): void {
    if (this.socket) return;
    if (!this.opts.apiKey || !this.opts.apiSecret || !this.opts.apiPassphrase) {
      log("User channel skipped — missing CLOB API creds");
      return;
    }
    this.socket = new ClobSocket({
      url: this.opts.wsUserHost,
      onMessage: (msg) => this.handleMessage(msg),
      onStatus: (up) => {
        const was = this.connected;
        this.connected = up;
        if (!up && was) this.reconnects++;
        if (up && was === false && this.reconnects > 0) {
          // Reconnexion (pas l'ouverture initiale) : rattrapage.
          this.opts.onReconnected?.();
        }
        if (up) {
          // Subscribe authentifié à chaque ouverture (initiale + reconnexions).
          this.socket?.send({
            auth: {
              apiKey: this.opts.apiKey,
              secret: this.opts.apiSecret,
              passphrase: this.opts.apiPassphrase,
            },
            type: "user",
          });
        }
        this.opts.onStatus?.(up, this.reconnects);
      },
    });
    this.socket.connect();
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getReconnects(): number {
    return this.reconnects;
  }

  /** Test : injecter un socket (défaut : construit dans start()). */
  /* istanbul ignore next */
  attachSocketForTest(socket: ClobSocket): void {
    this.socket = socket;
  }

  /** Normalise un message user channel. Public pour les tests. */
  handleMessage(msg: ClobSocketMessage): void {
    const type = msg.event_type;
    if (type !== "order" && type !== "trade") return;
    const orderId = typeof msg.order_id === "string" ? msg.order_id : "";
    if (!orderId) return;
    const status = normalizeOrderStatus(msg.status);
    const sizeMatchedRaw = Number(msg.size_matched);
    const sizeMatched =
      Number.isFinite(sizeMatchedRaw) && sizeMatchedRaw > 0 ? sizeMatchedRaw : 0;
    this.opts.onOrderStatus({
      orderId,
      assetId: typeof msg.asset_id === "string" ? msg.asset_id : undefined,
      filled: status === "matched" && sizeMatched > 0,
      cancelled: status === "cancelled" || status === "invalid",
      sizeMatched,
    });
  }
}