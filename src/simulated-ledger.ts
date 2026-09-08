import { bus } from "./dashboard/events.js";
import type { LedgerRepository } from "./db/repositories.js";

export class SimulatedLedger {
  private balance: number;

  constructor(initial: number, private readonly ledgerRepo?: LedgerRepository) {
    const restored = ledgerRepo?.getBalance();
    this.balance = Math.round((restored ?? initial) * 100) / 100;
    bus.emit({ type: "simulatedBalance", balance: this.balance });
  }

  getBalance(): number {
    return this.balance;
  }

  canAfford(cost: number): boolean {
    return this.balance >= cost - 1e-9;
  }

  debit(cost: number): void {
    this.balance = Math.round((this.balance - cost) * 100) / 100;
    if (this.balance < 0) this.balance = 0;
    this.ledgerRepo?.setBalance(this.balance);
    bus.emit({ type: "simulatedBalance", balance: this.balance });
  }

  credit(amount: number): void {
    this.balance = Math.round((this.balance + amount) * 100) / 100;
    this.ledgerRepo?.setBalance(this.balance);
    bus.emit({ type: "simulatedBalance", balance: this.balance });
  }

  reset(initial: number): void {
    this.balance = Math.round(initial * 100) / 100;
    this.ledgerRepo?.setBalance(this.balance);
    bus.emit({ type: "simulatedBalance", balance: this.balance });
  }
}
