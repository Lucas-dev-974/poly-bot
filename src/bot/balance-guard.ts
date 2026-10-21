import type { BotConfig } from "../config.js";
import { log } from "../logger.js";
import type { Trader } from "../trader.js";

type BalanceGuardDeps = {
  config: BotConfig; // shared mutable reference — do not copy
  trader: Trader;
};

export class BalanceGuard {
  private consecutiveBalanceRejections = 0;
  private balanceBackoffUntil = 0;
  private shortageBackoffUntil = 0;
  private cachedBalance: number | null = null;
  private cachedBalanceAt = 0;
  private static readonly BALANCE_CACHE_MS = 30_000;

  constructor(private readonly deps: BalanceGuardDeps) {}

  isInBackoff(now = Date.now()): boolean {
    return now < this.balanceBackoffUntil || now < this.shortageBackoffUntil;
  }

  async getCachedAvailableCollateral(): Promise<number | null> {
    const now = Date.now();
    if (now - this.cachedBalanceAt < BalanceGuard.BALANCE_CACHE_MS) {
      return this.cachedBalance;
    }
    try {
      this.cachedBalance = await this.deps.trader.getAvailableCollateral();
    } catch (error) {
      // Erreur réseau CLOB : garder le cache précédent (ou null si jamais fetché).
      const message = error instanceof Error ? error.message : String(error);
      log("Collateral balance fetch failed, keeping cached value", {
        cached: this.cachedBalance,
        error: message,
      });
    }
    // Stamp on failure too: otherwise every opportunity in the next 30 s
    // re-hits a CLOB that is already timing out (10 s each, inside the tick).
    this.cachedBalanceAt = now;
    return this.cachedBalance;
  }

  /**
   * Rejet LOCAL pré-check (solde caché < coût estimé) : pause 60s.
   * Une seule opportunité produit une trace (row "rejeté"), les suivantes
   * pendant la fenêtre sont silenciées par la gate isInBackoff — aucun
   * ordre n'est préparé tant que le solde ne couvre pas le coût estimé.
   * Auto-réprise : le cache balance (30s < 60s) se recharge pendant la
   * pause ; au premier tick post-pause, si le solde couvre, noteBalanceOk
   * (post réussi) lève la pause immédiatement.
   */
  noteBalanceShortage(now = Date.now()): void {
    if (now >= this.shortageBackoffUntil) {
      log("Live buying paused 60s - insufficient balance (local pre-check)", {
        resumeAt: new Date(now + 60_000).toISOString(),
      });
    }
    this.shortageBackoffUntil = now + 60_000;
  }

  /** Incrémente ; active backoff 60s après 3 rejects. */
  noteBalanceRejection(now = Date.now()): void {
    this.consecutiveBalanceRejections++;
    if (this.consecutiveBalanceRejections >= 3) {
      this.balanceBackoffUntil = now + 60_000;
      this.consecutiveBalanceRejections = 0;
      log("Live trading paused 60s - repeated balance rejections");
    }
  }

  noteBalanceOk(): void {
    this.consecutiveBalanceRejections = 0;
    // Un post réussi prouve que le solde couvrait : lève aussitôt la pause
    // "shortage" pour reprendre le trading sans attendre la fin des 60s.
    this.shortageBackoffUntil = 0;
  }

  /** Optional; ReverseBot.reset must NOT call this (move-only). */
  reset(): void {
    this.consecutiveBalanceRejections = 0;
    this.balanceBackoffUntil = 0;
    this.shortageBackoffUntil = 0;
    this.cachedBalance = null;
    this.cachedBalanceAt = 0;
  }
}
