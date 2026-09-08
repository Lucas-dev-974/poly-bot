/**
 * One-shot script to redeem all redeemable positions on the Polymarket wallet.
 *
 * Fetches active positions from the data-api, filters those flagged
 * `redeemable` (market resolved, tokens can be burned), and submits a
 * relayer batch for each via Trader.redeemPosition().
 *
 * Both winners (curPrice >= 0.99, credits pUSD) and losers (curPrice <= 0.01,
 * credits 0 but clears tokens) are redeemed.
 *
 * Usage: npx tsx scripts/redeem-all.ts [--dry-run]
 */
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { Trader } from "../src/trader.js";
import { DatabaseSync } from "node:sqlite";

const FETCH_TIMEOUT_MS = 10_000;
const ACTIVE_PAGE_SIZE = 500;
const ACTIVE_MAX_OFFSET = 10_000;

interface ApiPosition {
  conditionId: string;
  outcomeIndex: number;
  outcome: string;
  slug: string;
  title: string;
  size: number;
  curPrice: number;
  redeemable: boolean;
  negRisk: boolean;
  closed: boolean;
}

async function fetchActivePositions(
  funder: string,
  host: string,
): Promise<ApiPosition[]> {
  const positions: ApiPosition[] = [];
  for (let offset = 0; offset <= ACTIVE_MAX_OFFSET; offset += ACTIVE_PAGE_SIZE) {
    const url = new URL("/positions", host);
    url.searchParams.set("user", funder);
    url.searchParams.set("limit", String(ACTIVE_PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sizeThreshold", "0");
    url.searchParams.set("includeArchived", "true");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        console.error(`HTTP ${response.status} — impossible de récupérer les positions`);
        process.exit(1);
      }
      const payload = await response.json();
      if (!Array.isArray(payload)) return positions;
      positions.push(
        ...payload.map((p: Record<string, unknown>) => ({
          conditionId: String(p.conditionId ?? ""),
          outcomeIndex: Number(p.outcomeIndex ?? 0),
          outcome: String(p.outcome ?? ""),
          slug: String(p.slug ?? p.eventSlug ?? ""),
          title: String(p.title ?? ""),
          size: Number(p.size ?? 0),
          curPrice: Number(p.curPrice ?? 0),
          redeemable: Boolean(p.redeemable ?? false),
          negRisk: Boolean(p.negativeRisk ?? false),
          closed: false,
        })),
      );
      if (payload.length < ACTIVE_PAGE_SIZE) break;
    } finally {
      clearTimeout(timeout);
    }
  }
  return positions;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig();
  const funder = config.funderAddress;

  if (!funder) {
    console.error("FUNDER_ADDRESS manquant dans .env");
    process.exit(1);
  }
  if (config.dryRun) {
    console.error("DRY_RUN=true dans .env — passez en mode live pour racheter");
    process.exit(1);
  }

  console.log("=== Récupération des positions redeemable ===");
  console.log(`Funder: ${funder}`);
  console.log(`Data API: ${config.dataApiHost}`);
  console.log(`Mode: ${dryRun ? "DRY-RUN (simulation)" : "LIVE (réel)"}\n`);

  const positions = await fetchActivePositions(funder, config.dataApiHost);
  const redeemable = positions.filter(
    (p) => p.redeemable && (p.curPrice >= 0.99 || p.curPrice <= 0.01),
  );

  console.log(`Positions actives totales: ${positions.length}`);
  console.log(`Positions redeemable (winners + losers): ${redeemable.length}\n`);

  if (redeemable.length === 0) {
    console.log("Aucune position à racheter. Au revoir !");
    return;
  }

  const winners = redeemable.filter((p) => p.curPrice >= 0.99);
  const losers = redeemable.filter((p) => p.curPrice <= 0.01);
  const winnerValue = winners.reduce((s, p) => s + p.size, 0);

  console.log(`  Gagnants (curPrice >= 0.99): ${winners.length} → ~$${winnerValue.toFixed(2)} à créditer`);
  console.log(`  Perdants  (curPrice <= 0.01): ${losers.length} → $0 (cleanup de tokens)\n`);

  console.log("--- Liste ---");
  for (const p of redeemable) {
    const kind = p.curPrice >= 0.99 ? "WIN" : "LOSS";
    console.log(
      `  [${kind}] ${p.slug || p.title} | ${p.outcome} | size=${p.size.toFixed(2)} ` +
        `| curPrice=${p.curPrice.toFixed(4)} | negRisk=${p.negRisk}`,
    );
  }
  console.log("");

  if (dryRun) {
    console.log("Dry-run : aucune transaction envoyée. Ajoutez sans --dry-run pour exécuter.");
    return;
  }

  // --- Live: racheter via le relayer ---
  const trader = new Trader(config);
  await trader.init();

  // Charger les redeems déjà effectués (depuis les dernières 24h) pour éviter les doublons
  const db = new DatabaseSync(config.dbPath);
  const recentKeys = new Set<string>();
  try {
    const since = Date.now() - 24 * 3600_000;
    const rows = db
      .prepare(
        "SELECT conditionId, outcomeIndex FROM redeems WHERE success = 1 AND ts >= ?",
      )
      .all(since) as Array<{ conditionId: string; outcomeIndex: number }>;
    for (const r of rows) {
      recentKeys.add(`${r.conditionId}:${r.outcomeIndex}`);
    }
  } finally {
    db.close();
  }

  let successCount = 0;
  let failCount = 0;
  let totalCredited = 0;

  for (const p of redeemable) {
    const key = `${p.conditionId}:${p.outcomeIndex}`;
    if (recentKeys.has(key)) {
      console.log(`  SKIP (déjà racheté dans les dernières 24h): ${p.slug || p.title} | ${p.outcome}`);
      continue;
    }

    const isWinner = p.curPrice >= 0.99;
    console.log(
      `  REDEEM [${isWinner ? "WIN" : "LOSS"}] ${p.slug || p.title} | ${p.outcome} ` +
        `| size=${p.size.toFixed(2)} | conditionId=${p.conditionId}...`,
    );

    try {
      const result = await trader.redeemPosition(
        p.conditionId,
        p.outcomeIndex,
        p.negRisk,
      );
      successCount++;
      if (isWinner) totalCredited += p.size;
      recentKeys.add(key);
      console.log(`    ✅ txHash=${result.txHash}`);
    } catch (error) {
      failCount++;
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`    ❌ ${msg}`);
    }

    // Petite pause entre les transactions pour éviter le rate-limit du relayer
    await sleep(2000);
  }

  console.log("\n=== RÉSULTAT ===");
  console.log(`Succès: ${successCount}`);
  console.log(`Échecs: ${failCount}`);
  console.log(`pUSD crédité (gagnants): ~$${totalCredited.toFixed(2)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("Erreur fatale:", error);
  process.exit(1);
});