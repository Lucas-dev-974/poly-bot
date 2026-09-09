export class BacktestLedger {
  private balance: number;

  constructor(initial: number) {
    this.balance = round2(initial);
  }

  getBalance(): number {
    return this.balance;
  }

  canAfford(cost: number): boolean {
    return this.balance >= cost - 1e-9;
  }

  debit(cost: number): void {
    this.balance = round2(this.balance - cost);
    if (this.balance < 0) this.balance = 0;
  }

  credit(amount: number): void {
    this.balance = round2(this.balance + amount);
  }
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
