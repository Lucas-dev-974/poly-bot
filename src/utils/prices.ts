export function priceLevels(min: number, max: number, step = 0.01): number[] {
  const prices: number[] = [];
  for (let price = min; price <= max + step / 2; price += step) {
    prices.push(Math.round(price * 100) / 100);
  }
  return prices;
}

// Minimum CLOB observé sur les marchés 15m Up/Down : 5 shares.
// Pas de plancher notionnel $1 ici : les GTC resting n'en ont pas besoin
// (seul min_order_size en shares). Les FOK/FAK marketables peuvent encore
// être rejetés par le venue sous ~$1 — géré à l'exécution, pas au sizing.
export const MIN_CLOB_SHARES = 5;

/**
 * Size in shares for a USDC budget at `price`. Returns null when below
 * MIN_CLOB_SHARES. No USD notional floor — resting GTC can be sub-$1.
 */
export function computeSize(
  usdcBudget: number,
  price: number,
  maxShares: number,
): number | null {
  const px = Math.max(price, 0.01);
  const size = Math.floor(Math.min(usdcBudget / px, maxShares) * 100) / 100;
  if (size < MIN_CLOB_SHARES) return null;
  return size;
}

export function formatReturnPct(price: number): string {
  return `${Math.round((1 / price - 1) * 100)}% if wins`;
}

/**
 * Garde-fou de viabilité : le budget doit pouvoir passer computeSize au PIRE
 * prix de la bande (MIN_CLOB_SHARES + cap maxShares). Sinon le moteur est
 * muet silencieusement (incident 2026-09-14 : shares).
 * Appelé par validateTradingConfig pour chaque moteur, au boot et à chaque
 * PATCH runtime settings.
 */
export function validateEngineBudget(
  usdcBudget: number,
  bandMax: number,
  label: string,
  maxShares: number = Number.MAX_SAFE_INTEGER,
): void {
  if (computeSize(usdcBudget, bandMax, maxShares) !== null) return;

  const px = Math.max(bandMax, 0.01);
  const neededShares = MIN_CLOB_SHARES;
  const neededUsdc = Math.ceil(neededShares * px * 100) / 100;
  throw new Error(
    `${label}: budget ${usdcBudget} USDC at band max ${bandMax} with maxShares=${maxShares} ` +
      `cannot reach MIN_CLOB_SHARES (${MIN_CLOB_SHARES}). Need budget >= ${neededUsdc} USDC ` +
      `(or raise maxShares / lower band max). Refusing a silently-muted engine.`,
  );
}
