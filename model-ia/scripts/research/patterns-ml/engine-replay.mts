/**
 * Engine replay : rejoue les 4 moteurs du bot (dip-revert, flip-confirm,
 * early-conviction, antiflip) sur les ticks de la DB, puis croise leurs
 * signaux avec les clusters SAX + winrate par cluster (matrice de confusion
 * moteurs × clusters pour le Gate G-A1).
 *
 * Audit fix 2026-09-26 : les moteurs du bot définissent le FAVORI comme le
 * token à l'ask le plus HAUT (pickEdgeToken = max ask ; early-conviction
 * attend un ask >= 0.60) — l'ancien dataset.mts prenait l'ask le plus bas
 * (l'outsider). Le replay utilise la convention du bot.
 *
 * Usage: npx tsx model-ia/scripts/research/patterns-ml/engine-replay.mts
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { kMedoidsPAM, assignWindowToCluster, type ShapeletCandidate } from './shapelets.mts';
import { toSAX, DEFAULT_SAX_CONFIG } from './sax.mts';

// ---------------------------------------------------------------------------
// Config : defaults de src/config.ts (marchés 15m)
// ---------------------------------------------------------------------------
const CFG = {
  dip: {
    bandMin: 0.55, bandMax: 0.65, minDrop: 0.03, lookbackMs: 60_000,
    minElapsedSec: 180, maxElapsedSec: null as number | null, maxSpread: 0.04,
  },
  antiflip: {
    bandMin: 0.35, bandMax: 0.45, deposedAskMin: 0.40, flipLookbackMs: 90_000,
    minElapsedSec: 240, maxElapsedSec: null as number | null, maxSpread: 0.05,
    favAskMin: 0.45, favAskMax: 0.65, entryDelaySec: 0, sharpDropMin: 0, bounceMin: 0,
  },
  flip: {
    bandMin: 0.55, bandMax: 0.65, flipLookbackMs: 90_000,
    minElapsedSec: 120, maxElapsedSec: 180, maxSpread: 0.05,
  },
  early: { askMin: 0.60, askMax: 0.80, maxElapsedSec: 45, maxSpread: 0.05 },
};

const PAA_SEGMENTS = 120;
const ALPHABET = 8;

interface Tick {
  ts: number;
  upAsk: number;
  downAsk: number;
  upBid: number;
  downBid: number;
}

interface Entry {
  ts: number;            // ms d'entrée
  elapsedSec: number;    // secondes depuis windowStart
  tokenIdx: 0 | 1;       // 0 = Up, 1 = Down (token acheté)
  price: number;         // ask d'entrée
  win: boolean;          // le token acheté a-t-il gagné ?
}

// ---------------------------------------------------------------------------
// Chargement ticks (1 requête par fenêtre, merge par ts — convention du bot)
// ---------------------------------------------------------------------------
function loadTicks(db: Database.Database, eventSlug: string, windowStart: number): Tick[] {
  const rows = db.prepare(`
    SELECT ts, outcomeIndex, bestAsk, bestBid
    FROM book_snapshots
    WHERE eventSlug = ?
    ORDER BY ts
  `).all(eventSlug) as any[];

  const byTs = new Map<number, { upAsk: number | null; downAsk: number | null; upBid: number | null; downBid: number | null }>();
  for (const r of rows) {
    const e = byTs.get(r.ts) || { upAsk: null, downAsk: null, upBid: null, downBid: null };
    if (r.outcomeIndex === 0) { e.upAsk = r.bestAsk; e.upBid = r.bestBid; }
    else if (r.outcomeIndex === 1) { e.downAsk = r.bestAsk; e.downBid = r.bestBid; }
    byTs.set(r.ts, e);
  }

  const ticks: Tick[] = [];
  for (const [ts, e] of [...byTs.entries()].sort((a, b) => a[0] - b[0])) {
    if (e.upAsk == null || e.downAsk == null) continue;
    ticks.push({
      ts,
      upAsk: e.upAsk,
      downAsk: e.downAsk,
      upBid: e.upBid ?? 0,
      downBid: e.downBid ?? 0,
    });
  }
  // Filtre les ticks antérieurs au windowStart (données résiduelles)
  return ticks.filter((t) => t.ts >= windowStart);
}

/** Favori à la convention du bot : ask le plus HAUT (tie -> Up). */
function favIdxOf(t: Tick): 0 | 1 {
  return t.upAsk >= t.downAsk ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Replays (un seul déclenchement par fenêtre, comme les moteurs : FOK unique)
// ---------------------------------------------------------------------------

function runDipRevert(ticks: Tick[], windowStart: number): Entry | null {
  const cfg = CFG.dip;
  const samples: Array<{ ts: number; ask: number }> = [];
  for (const t of ticks) {
    const elapsedSec = (t.ts - windowStart) / 1000;
    const favIdx = favIdxOf(t);
    const ask = favIdx === 0 ? t.upAsk : t.downAsk;
    const bid = favIdx === 0 ? t.upBid : t.downBid;

    // Fenêtre glissante (lookbackMs, pas de reset sur flip — série du leader)
    const cutoff = Math.max(t.ts - cfg.lookbackMs, windowStart);
    while (samples.length > 0 && samples[0].ts < cutoff) samples.shift();
    const last = samples[samples.length - 1];
    if (!last || last.ts !== t.ts) samples.push({ ts: t.ts, ask });
    if (samples.length < 2) continue;

    // Gates d'entrée
    if (elapsedSec < cfg.minElapsedSec) continue;
    if (cfg.maxElapsedSec != null && elapsedSec > cfg.maxElapsedSec) continue;
    if (ask < cfg.bandMin || ask > cfg.bandMax) continue;
    if (ask - bid > cfg.maxSpread) continue;

    // Signal : chute >= minDrop sur le lookback + rebond au-dessus du plancher
    const first = samples[0];
    if (last.ts - first.ts < cfg.lookbackMs * 0.7) continue;
    const low = Math.min(...samples.map((s) => s.ask));
    if (first.ask - ask >= cfg.minDrop && ask > low && ask - low >= 0.001) {
      return { ts: t.ts, elapsedSec, tokenIdx: favIdx, price: ask, win: false };
    }
  }
  return null;
}

function runFlipConfirm(ticks: Tick[], windowStart: number): Entry | null {
  const cfg = CFG.flip;
  let lastFlipTs: number | null = null;
  let prevFavIdx: 0 | 1 | null = null;
  for (const t of ticks) {
    const elapsedSec = (t.ts - windowStart) / 1000;
    const favIdx = favIdxOf(t);
    if (prevFavIdx !== null && prevFavIdx !== favIdx) lastFlipTs = t.ts;
    prevFavIdx = favIdx;

    if (elapsedSec < cfg.minElapsedSec || elapsedSec > cfg.maxElapsedSec) continue;
    if (lastFlipTs == null || t.ts - lastFlipTs > cfg.flipLookbackMs) continue;

    const ask = favIdx === 0 ? t.upAsk : t.downAsk;
    const bid = favIdx === 0 ? t.upBid : t.downBid;
    if (ask < cfg.bandMin || ask > cfg.bandMax) continue;
    if (ask - bid > cfg.maxSpread) continue;

    return { ts: t.ts, elapsedSec, tokenIdx: favIdx, price: ask, win: false };
  }
  return null;
}

function runEarlyConviction(ticks: Tick[], windowStart: number): Entry | null {
  const cfg = CFG.early;
  for (const t of ticks) {
    const elapsedSec = (t.ts - windowStart) / 1000;
    if (elapsedSec > cfg.maxElapsedSec) continue;
    const favIdx = favIdxOf(t);
    const ask = favIdx === 0 ? t.upAsk : t.downAsk;
    const bid = favIdx === 0 ? t.upBid : t.downBid;
    if (ask < cfg.askMin || ask > cfg.askMax) continue;
    if (ask - bid > cfg.maxSpread) continue;
    return { ts: t.ts, elapsedSec, tokenIdx: favIdx, price: ask, win: false };
  }
  return null;
}

function runAntiflip(ticks: Tick[], windowStart: number): Entry | null {
  const cfg = CFG.antiflip;
  const LEADER_WINDOW = 6;
  const LEADER_STALE_MS = 1_000;
  let lastFlipTs: number | null = null;
  let prevFavIdx: 0 | 1 | null = null;
  let leaderAsks: Array<{ ts: number; ask: number }> = [];
  let deposedPreFlipPeak: number | null = null;

  for (const t of ticks) {
    const elapsedSec = (t.ts - windowStart) / 1000;
    const favIdx = favIdxOf(t);
    const favAsk = favIdx === 0 ? t.upAsk : t.downAsk;
    const deposedIdx = favIdx === 0 ? 1 : 0;
    const deposedAsk = deposedIdx === 0 ? t.upAsk : t.downAsk;
    const deposedBid = deposedIdx === 0 ? t.upBid : t.downBid;

    // Flip détecté
    if (prevFavIdx !== null && prevFavIdx !== favIdx) {
      lastFlipTs = t.ts;
      // Sommet pré-flip du leader (samples >= 1s avant le flip)
      let peak: number | null = null;
      for (const s of leaderAsks) {
        if (t.ts - s.ts < LEADER_STALE_MS) continue;
        if (peak == null || s.ask > peak) peak = s.ask;
      }
      if (peak == null) {
        for (const s of leaderAsks) if (peak == null || s.ask > peak) peak = s.ask;
      }
      deposedPreFlipPeak = peak;
    }
    prevFavIdx = favIdx;
    leaderAsks.push({ ts: t.ts, ask: favAsk });
    if (leaderAsks.length > LEADER_WINDOW) leaderAsks.shift();

    if (elapsedSec < cfg.minElapsedSec) continue;
    if (cfg.maxElapsedSec != null && elapsedSec > cfg.maxElapsedSec) continue;
    if (lastFlipTs == null || t.ts - lastFlipTs > cfg.flipLookbackMs) continue;
    if (cfg.entryDelaySec > 0 && (t.ts - lastFlipTs) / 1000 < cfg.entryDelaySec) continue;
    if (favAsk < cfg.favAskMin || favAsk > cfg.favAskMax) continue;
    if (deposedAsk == null || deposedAsk < cfg.bandMin || deposedAsk > cfg.bandMax) continue;
    if (cfg.deposedAskMin != null && deposedAsk < cfg.deposedAskMin) continue;
    if (cfg.sharpDropMin > 0 && (deposedPreFlipPeak == null || deposedPreFlipPeak - deposedAsk < cfg.sharpDropMin)) continue;
    if (deposedBid != null && deposedAsk - deposedBid > cfg.maxSpread) continue;

    return { ts: t.ts, elapsedSec, tokenIdx: deposedIdx, price: deposedAsk, win: false };
  }
  return null;
}

// ---------------------------------------------------------------------------
// t-stat empirique sur PnL par trade (1 share)
// ---------------------------------------------------------------------------
function tStat(pnls: number[]): { t: number; mean: number; n: number } {
  const n = pnls.length;
  if (n < 2) return { t: 0, mean: 0, n };
  const mean = pnls.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { t: std > 0 ? (mean / std) * Math.sqrt(n) : 0, mean, n };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const dbPath = path.resolve(process.cwd(), 'data/bot-live.db');
  const db = new Database(dbPath, { readonly: true });

  console.log('=== ENGINE REPLAY (4 moteurs, convention ask-max) ===');

  // 1. Fenêtres complètes
  const windows = db.prepare(`
    SELECT bs.eventSlug, MIN(bs.ts) as windowStart, MAX(bs.ts) as windowEnd,
           COUNT(*) as tickCount, mr.winnerOutcomeIndex
    FROM book_snapshots bs
    JOIN market_resolutions mr ON mr.eventSlug = bs.eventSlug
    GROUP BY bs.eventSlug
    HAVING tickCount >= 801 AND (MAX(bs.ts) - MIN(bs.ts)) / 1000.0 / COUNT(*) <= 1.5
      AND mr.winnerOutcomeIndex IS NOT NULL
    ORDER BY windowStart
  `).all() as any[];
  console.log(`Fenêtres complètes: ${windows.length}`);

  // 2. Ticks + replay moteurs + SAX full-window (série LEADER = max ask)
  const saxConfig = { ...DEFAULT_SAX_CONFIG, alphabetSize: ALPHABET, paaSegments: PAA_SEGMENTS };
  const candidates: ShapeletCandidate[] = [];
  const results: Array<{
    eventSlug: string; winner: number; sax: string;
    dip: Entry | null; flip: Entry | null; early: Entry | null; antiflip: Entry | null;
  }> = [];

  const stmt = db.prepare(`
    SELECT ts, outcomeIndex, bestAsk, bestBid
    FROM book_snapshots WHERE eventSlug = ? ORDER BY ts
  `);
  for (const w of windows) {
    const ticks = loadTicks(db, w.eventSlug, w.windowStart);
    if (ticks.length < PAA_SEGMENTS) continue;

    const dip = runDipRevert(ticks, w.windowStart);
    const flip = runFlipConfirm(ticks, w.windowStart);
    const early = runEarlyConviction(ticks, w.windowStart);
    const anti = runAntiflip(ticks, w.windowStart);
    if (!dip && !flip && !early && !anti) continue; // fenêtre sans aucun signal

    // SAX sur la série leader (max ask) — la mesure que les moteurs suivent
    const series = ticks.map((t) => Math.max(t.upAsk, t.downAsk));
    const sax = toSAX(series, { ...saxConfig, windowTicks: series.length, stride: series.length, paaSegments: PAA_SEGMENTS });

    // Labels win par moteur
    for (const e of [dip, flip, early, anti]) {
      if (e) e.win = e.tokenIdx === w.winnerOutcomeIndex;
    }
    results.push({ eventSlug: w.eventSlug, winner: w.winnerOutcomeIndex as number, sax, dip, flip, early, antiflip: anti });
    candidates.push({ shapelet: sax, length: sax.length, start: 0, windowIndex: results.length - 1 });
  }
  console.log(`Fenêtres avec ≥1 signal: ${results.length}`);

  // 3. Clustering SAX (même pipeline que discover.mts)
  const clustering = kMedoidsPAM(candidates, { k: 8, maxIter: 10, seed: 42 });
  console.log(`Clusters: ${clustering.medoids.length}, silhouette=${clustering.silhouette.toFixed(3)}`);

  const winCluster = results.map((_, i) => assignWindowToCluster(results[i].sax, clustering.medoids)?.clusterId ?? -1);

  // 4. Résumé par moteur
  const engines = [
    { key: 'dip', name: 'dip-revert', get: (r: typeof results[0]) => r.dip },
    { key: 'flip', name: 'flip-confirm', get: (r: typeof results[0]) => r.flip },
    { key: 'early', name: 'early-conviction', get: (r: typeof results[0]) => r.early },
    { key: 'antiflip', name: 'antiflip', get: (r: typeof results[0]) => r.antiflip },
  ] as const;

  const lines: string[] = [];
  lines.push('# Engine Replay × Clusters SAX');
  lines.push('');
  lines.push(`**Date:** ${new Date().toISOString()}`);
  lines.push(`**Config:** k=8, alphabet=${ALPHABET}, paa=${PAA_SEGMENTS}, SAX sur série LEADER (max ask)`);
  lines.push(`**Fenêtres avec ≥1 signal:** ${results.length} / ${windows.length}`);
  lines.push('');
  lines.push('## Résumé par moteur');
  lines.push('');
  lines.push('| Moteur | Entrées | WR | Prix moyen | EV/share | t-stat |');
  lines.push('|--------|---------|-----|------------|----------|--------|');
  const engineStats: Record<string, { n: number; wr: number; avgPrice: number; ev: number; t: number }> = {};
  for (const eng of engines) {
    const entries = results.map(eng.get).filter((e): e is Entry => e !== null);
    const winsCount = entries.filter((e) => e.win).length;
    const wr = entries.length > 0 ? winsCount / entries.length : 0;
    const avgPrice = entries.length > 0 ? entries.reduce((s, e) => s + e.price, 0) / entries.length : 0;
    const pnls = entries.map((e) => (e.win ? 1 - e.price : -e.price));
    const { t } = tStat(pnls);
    const ev = wr - avgPrice;
    engineStats[eng.name] = { n: entries.length, wr, avgPrice, ev, t };
    lines.push(`| ${eng.name} | ${entries.length} | ${(wr * 100).toFixed(1)}% | ${avgPrice.toFixed(3)} | ${(ev * 100).toFixed(1)}¢ | ${t.toFixed(2)} |`);
  }

  // 5. Matrice moteurs × clusters
  lines.push('');
  lines.push('## Matrice moteurs × clusters');
  lines.push('');
  const clusterIds = [...new Set(winCluster.filter((c) => c >= 0))].sort((a, b) => a - b);
  const header = ['Moteur', ...clusterIds.map((c) => `C${c}`), 'Hors cluster'].join(' | ');
  lines.push(`| ${header} |`);
  lines.push(`|${clusterIds.map(() => '---').join('|')}|---|---|`);
  for (const eng of engines) {
    const cells: string[] = [eng.name];
    for (const cid of clusterIds) {
      const n = results.filter((r, i) => winCluster[i] === cid && eng.get(r) !== null).length;
      const wr = (() => {
        const entries = results.map((r, i) => (winCluster[i] === cid ? eng.get(r) : null)).filter((e): e is Entry => e !== null);
        return entries.length > 0 ? (entries.filter((e) => e.win).length / entries.length * 100).toFixed(0) + '%' : '-';
      })();
      cells.push(`${n} (${wr})`);
    }
    const outside = results.filter((r, i) => winCluster[i] === -1 && eng.get(r) !== null).length;
    cells.push(String(outside));
    lines.push(`| ${cells.join(' | ')} |`);
  }

  // 6. Chevauchement moteurs
  lines.push('');
  lines.push('## Chevauchement entre moteurs (fenêtres où les 2 signifient)');
  lines.push('');
  for (let a = 0; a < engines.length; a++) {
    for (let b = a + 1; b < engines.length; b++) {
      const both = results.filter((r) => engines[a].get(r) !== null && engines[b].get(r) !== null).length;
      lines.push(`- ${engines[a].name} ∩ ${engines[b].name}: ${both}`);
    }
  }

  // 7. Cluster summary (P(Up) par cluster)
  lines.push('');
  lines.push('## Clusters (rappel)');
  lines.push('');
  lines.push('| Cluster | n fenêtres | P(Up gagne) |');
  lines.push('|---------|------------|-------------|');
  for (const cid of clusterIds) {
    const idxs = results.map((_, i) => i).filter((i) => winCluster[i] === cid);
    const up = idxs.filter((i) => results[i].winner === 0).length;
    lines.push(`| ${cid} | ${idxs.length} | ${idxs.length > 0 ? (up / idxs.length).toFixed(3) : '-'} |`);
  }

  // Sauvegarde
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve('model-ia/patterns');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.resolve(outDir, `report-engine-replay-${ts}.md`);
  fs.writeFileSync(mdPath, lines.join('\n'));
  const jsonPath = path.resolve(outDir, `report-engine-replay-${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ engineStats, matrix: engines.map((e) => e.name), clusters: clusterIds, silhouette: clustering.silhouette, resultsCount: results.length }, null, 2));
  console.log(`\nSaved: ${mdPath}`);

  // Sortie console
  console.log(lines.join('\n'));

  db.close();
}

main();