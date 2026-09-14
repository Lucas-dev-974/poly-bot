export function priceLevels(min: number, max: number, step = 0.01): number[] {
  const prices: number[] = [];
  for (let price = min; price <= max + step / 2; price += step) {
    prices.push(Math.round(price * 100) / 100);
  }
  return prices;
}

// Minimum CLOB observé sur les marchés 15m Up/Down : 5 shares et 1$ de notionnel.
export const MIN_CLOB_SHARES = 5;
const MIN_CLOB_NOTIONAL_USD = 1;

const NOTIONAL_SLACK_USD = 0.02;

/**
 * Size in shares for a USDC budget at `price`. Returns null when CLOB
 * minimums (5 shares and $1 notional) cannot be met. Flooring to 2 decimals
 * can drop a $1 budget just under notional (5.26 × 0.19 = 0.9994); bump one
 * tick in that case if the overshoot stays within 2¢.
 */
export function computeSize(
  usdcBudget: number,
  price: number,
  maxShares: number,
): number | null {
  const px = Math.max(price, 0.01);
  let size = Math.floor(Math.min(usdcBudget / px, maxShares) * 100) / 100;
  if (size < MIN_CLOB_SHARES) return null;
  if (size * px < MIN_CLOB_NOTIONAL_USD) {
    const needed = Math.ceil((MIN_CLOB_NOTIONAL_USD / px) * 100) / 100;
    if (needed > maxShares || needed * px > usdcBudget + NOTIONAL_SLACK_USD) {
      return null;
    }
    size = needed;
  }
  if (size < MIN_CLOB_SHARES || size * px < MIN_CLOB_NOTIONAL_USD) return null;
  return size;
}

export function formatReturnPct(price: number): string {
  return `${Math.round((1 / price - 1) * 100)}% if wins`;
}

/**
 * Garde-fou de viabilité : un budget moteur doit pouvoir acheter au moins
 * MIN_CLOB_SHARES au PIRE prix de sa bande. Sinon computeSize renvoie null
 * à chaque tick de la bande et le moteur devient muet silencieusement
 * (incident 2026-09-14 : fav-band avec cheapOrderUsdc=1, 1/0.85 = 1.18 < 5).
 * Appelé par validateTradingConfig pour chaque moteur, au boot et à chaque
 * PATCH runtime settings.
 */
export function validateEngineBudget(
  usdcBudget: number,
  bandMax: number,
  label: string,
): void {
  const minShares = Math.floor((usdcBudget / bandMax) * 100) / 100;
  if (minShares < MIN_CLOB_SHARES) {
    const needed = Math.ceil(MIN_CLOB_SHARES * bandMax * 100) / 100;
    throw new Error(
      `${label}: budget ${usdcBudget} USDC can never reach MIN_CLOB_SHARES ` +
        `(${MIN_CLOB_SHARES}) at band max ${bandMax} — needs >= ${needed} USDC. ` +
        `Refusing a silently-muted engine.`,
    );
  }
}
