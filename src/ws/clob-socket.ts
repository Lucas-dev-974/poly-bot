import { log } from "../logger.js";

/** Types des messages JSON du CLOB WS (market + user channels). */
export interface ClobSocketMessage {
  event_type?: string;
  [key: string]: unknown;
}

type MessageHandler = (data: ClobSocketMessage) => void;
type StatusHandler = (connected: boolean) => void;

interface ClobSocketOptions {
  url: string;
  onMessage: MessageHandler;
  /** Changement d'état connecté/déconnecté (appelé aussi à chaque reconnexion). */
  onStatus?: StatusHandler;
  /** Constructeur injectable pour les tests (défaut : globalThis.WebSocket). */
  WebSocketImpl?: (typeof WebSocket) | undefined;
  pingIntervalMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_PING_MS = 10_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Au-delà de ce silence (aucun message/PONG), on force la reconnexion. */
const SILENCE_RECONNECT_MS = 30_000;

/**
 * Connexion WSS reconnectante vers le CLOB de Polymarket.
 * - Backoff exponentiel 1 s → max 30 s, reset à l'ouverture.
 * - Ping applicatif "PING" toutes les 10 s ; reconnect si silence > 30 s
 *   (le serveur répond "PONG" en texte brut, filtré ici).
 * - Une instance par canal : market et user sont deux endpoints distincts.
 */
export class ClobSocket {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private manuallyClosed = false;
  private lastActivityMs = 0;

  constructor(private readonly opts: ClobSocketOptions) {}

  connect(): void {
    if (this.ws) return;
    this.manuallyClosed = false;
    this.lastActivityMs = Date.now();
    const Impl = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    if (!Impl) {
      log("CLOB WS unavailable — no WebSocket implementation", { url: this.opts.url });
      return;
    }
    this.ws = new Impl(this.opts.url);
    this.ws.onopen = () => {
      this.backoffMs = 1_000;
      this.lastActivityMs = Date.now();
      this.startPingLoop();
      this.opts.onStatus?.(true);
    };
    this.ws.onmessage = (event: MessageEvent) => {
      this.lastActivityMs = Date.now();
      const raw = typeof event.data === "string" ? event.data : "";
      if (raw === "PONG") return;
      try {
        const parsed = JSON.parse(raw) as ClobSocketMessage;
        this.opts.onMessage(parsed);
      } catch {
        /* ignore malformed */
      }
    };
    this.ws.onerror = () => {
      /* onclose suivra ; le backoff gère la reconnexion */
    };
    this.ws.onclose = () => {
      this.stopPingLoop();
      this.opts.onStatus?.(false);
      this.ws = null;
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    };
  }

  /** Fermeture propre (shutdown) — pas de reconnexion. */
  close(): void {
    this.manuallyClosed = true;
    this.stopPingLoop();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /** Émission d'un payload JSON (subscribe...). */
  send(payload: unknown): void {
    if (this.isOpen()) {
      this.ws?.send(JSON.stringify(payload));
    }
  }

  /** Ping texte brut (protocole CLOB : "PING" hors JSON). */
  ping(): void {
    if (this.isOpen()) {
      this.ws?.send("PING");
    }
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.manuallyClosed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    const pingMs = this.opts.pingIntervalMs ?? DEFAULT_PING_MS;
    this.pingTimer = setInterval(() => {
      this.ping();
      if (Date.now() - this.lastActivityMs > SILENCE_RECONNECT_MS) {
        log("CLOB WS silent — force reconnect", { url: this.opts.url });
        this.ws?.close(); // onclose déclenche scheduleReconnect
      }
    }, pingMs);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}