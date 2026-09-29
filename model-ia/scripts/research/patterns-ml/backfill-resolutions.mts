/**
 * Backfill market_resolutions pour les fenêtres complètes (>=801 ticks) sans résolution.
 *
 * Réutilise la logique de production de src/backtest/resolve.ts (endpoint Gamma
 * /events?slug=..., parsing outcomePrices), pilotée en batch :
 *   - dry-run : ./node_modules/.bin/tsx model-ia/scripts/research/patterns-ml/backfill-resolutions.mts --dry-run
 *   - run complet : ... backfill-resolutions.mts
 *   - échantillon : ... backfill-resolutions.mts --limit 10
 *
 * Sécurités :
 *   - 100 ms entre chaque appel (aucune clé API requise, endpoint public)
 *   - verdict void (settlement 50/50) persisté avec winnerOutcomeIndex=2 —
 *     le dataset ML l'exclut depuis dataset.mts (filtre != 2)
 *   - fenêtres non résolues laissées sans ligne (retry possible plus tard)
 *   - rapport final model-ia/patterns/backfill-<ts>.md
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const MIN_TICKS = 801;
const DELAY_MS = 100;
const TIMEOUT_MS = 10_000;
const GAMMA_HOST = process.env.GAMMA_API_HOST || 'https://gamma-api.polymarket.com';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? Number(args[limitIdx + 1]) : undefined;

interface GammaMarketResult {
  outcomes?: string | string[];
  winningOutcome?: string;
  outcomePrices?: string | string[];
  closed?: boolean;
  umaResolutionStatus?: string;
}

function parsePrices(value: unknown): number[] | null {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch {
      return null;
    }
  }
  return null;
}

/** Miroir de winnerIndexFromGamma (resolve.ts) : 0=Up, 1=Down, 2=void, null=indéterminé */
function winnerIndexFromGamma(result: GammaMarketResult): 0 | 1 | 2 | null {
  const prices = parsePrices(result.outcomePrices);
  if (!prices || prices.length < 2) return null;
  const [up, down] = prices;
  if (up >= 0.99) return 0;
  if (up <= 0.01) return 1;
  if (down >= 0.99) return 1;
  if (down <= 0.01) return 0;
  // Les deux ≈ 0.5 → règlement 50/50 (void)
  if (Math.abs(up - 0.5) < 0.02 && Math.abs(down - 0.5) < 0.02) return 2;
  return null;
}

async function fetchEventMarket(eventSlug: string, closed?: boolean): Promise<GammaMarketResult | null> {
  const url = new URL('/events', GAMMA_HOST);
  url.searchParams.set('slug', eventSlug);
  if (closed === true) url.searchParams.set('closed', 'true');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const events = (await response.json()) as Array<{ markets?: GammaMarketResult[] }>;
    return events[0]?.markets?.[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = new Database('data/bot-live.db');
  const startedAt = new Date().toISOString();

  // 1. Fenêtres complètes SANS résolution
  const targets = db
    .prepare(
      `SELECT bs.eventSlug, COUNT(*) tickCount, MIN(bs.ts) windowStart
       FROM book_snapshots bs LEFT JOIN market_resolutions mr ON mr.eventSlug = bs.eventSlug
       WHERE mr.eventSlug IS NULL
       GROUP BY bs.eventSlug HAVING COUNT(*) >= ${MIN_TICKS}
       ORDER BY windowStart`
    )
    .all() as { eventSlug: string; tickCount: number; windowStart: number }[];

  console.log(`${targets.length} fenêtres complètes sans résolution (dry-run: ${DRY_RUN}, limit: ${LIMIT ?? 'aucune'})`);

  // 2. Résolutions existantes pour éviter de re-scraper (cache local optionnel)
  const existing = new Set(
    (db.prepare('SELECT eventSlug FROM market_resolutions').all() as { eventSlug: string }[]).map((r) => r.eventSlug)
  );

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO market_resolutions (eventSlug, winnerOutcomeIndex, source, ts) VALUES (?, ?, ?, ?)`
  );

  const resolved = { 0: 0, 1: 0, 2: 0 } as Record<0 | 1 | 2, number>;
  const failed: string[] = [];
  const samples: string[] = [];

  const batch = LIMIT !== undefined ? targets.slice(0, LIMIT) : targets;

  for (let i = 0; i < batch.length; i++) {
    const { eventSlug } = batch[i];
    if (existing.has(eventSlug)) continue;

    // resolve.ts : d'abord marché ouvert, puis marché fermé
    let market = await fetchEventMarket(eventSlug);
    let idx = market ? winnerIndexFromGamma(market) : null;
    if (idx === null) {
      market = await fetchEventMarket(eventSlug, true);
      idx = market ? winnerIndexFromGamma(market) : null;
    }

    if (idx === null) {
      failed.push(eventSlug);
    } else {
      resolved[idx]++;
      if (!DRY_RUN) {
        upsert.run(eventSlug, idx, 'gamma-backfill', Date.now());
      }
      if (samples.length < 10) {
        samples.push(
          `${eventSlug} -> ${idx}${idx === 2 ? ' (VOID)' : ''} [${market?.outcomePrices ? JSON.stringify(market.outcomePrices) : '?'}]`
        );
      }
    }

    if ((i + 1) % 50 === 0) {
      const done = resolved[0] + resolved[1] + resolved[2] + failed.length;
      console.log(`  ${i + 1}/${batch.length} traités — Up:${resolved[0]} Down:${resolved[1]} Void:${resolved[2]} Échecs:${failed.length}`);
      if (done > 0 && samples.length < 10) samples.forEach((s) => console.log(`    ex: ${s}`));
    }
    await sleep(DELAY_MS);
  }

  db.close();

  // 3. Rapport
  const reportPath = path.resolve(`model-ia/patterns/backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  const lines = [
    `# Backfill market_resolutions`,
    ``,
    `**Date:** ${startedAt}  |  **Dry-run:** ${DRY_RUN}  |  **Limit:** ${LIMIT ?? 'toutes'}  |  **Min ticks:** ${MIN_TICKS}`,
    ``,
    `| Résultat | n |`,
    `|---|---|`,
    `| Up gagne (0) | ${resolved[0]} |`,
    `| Down gagne (1) | ${resolved[1]} |`,
    `| Void 50/50 (2) | ${resolved[2]} |`,
    `| Non résolues (échec API/parsing) | ${failed.length} |`,
    ``,
    `## Échantillon`,
    ...samples.map((s) => `- ${s}`),
    ``,
    `## Slugs en échec`,
    ...(failed.length ? failed.map((s) => `- ${s}`) : ['- aucun']),
    ``,
  ];
  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`\nRapport: ${reportPath}`);
  console.log(`Résumé: Up=${resolved[0]} Down=${resolved[1]} Void=${resolved[2]} Échecs=${failed.length}${DRY_RUN ? ' (DRY-RUN — rien écrit)' : ''}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});