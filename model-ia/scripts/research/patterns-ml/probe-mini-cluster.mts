/**
 * Sonde 2 : mini-clustering CORRIGÉ à petite échelle pour valider la pipeline
 * - Charge 48 fenêtres réparties sur toute la DB
 * - SAX full-window (200 segments, alphabet 8) sur favAsk
 * - Shapelets len [10,20,40] stride 20 → ~1200 candidats → PAM k=8 faisable
 * - Compare P(Up) par cluster vs baseline, et un conditionnement simple favAsk<0.5
 * Usage: npx tsx model-ia/scripts/research/patterns-ml/probe-mini-cluster.mts
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import { toSAX, DEFAULT_SAX_CONFIG } from './sax.mts';
import { kMedoidsPAM, assignWindowToCluster, type ShapeletCandidate } from './shapelets.mts';

const db = new Database(path.resolve(process.cwd(), 'data/bot-live.db'), { readonly: true });

// 1. Fenêtres complètes, réparties uniformément
const all = db.prepare(`
  SELECT bs.eventSlug, MIN(bs.ts) as windowStart, MAX(bs.ts) as windowEnd, COUNT(*) as tickCount,
         mr.winnerOutcomeIndex
  FROM book_snapshots bs
  JOIN market_resolutions mr ON mr.eventSlug = bs.eventSlug
  GROUP BY bs.eventSlug
  HAVING tickCount >= 801 AND (MAX(bs.ts) - MIN(bs.ts)) / 1000.0 / COUNT(*) <= 1.5
    AND mr.winnerOutcomeIndex IS NOT NULL
  ORDER BY windowStart
`).all() as any[];
console.log(`Fenêtres complètes: ${all.length}`);
const stride = Math.max(1, Math.floor(all.length / 48));
const sample = all.filter((_, i) => i % stride === 0).slice(0, 48);
console.log(`Échantillon: ${sample.length} fenêtres (1/${stride})`);

// 2. SAX par fenêtre (requête unique par fenêtre, merge JS par ts)
const windows: Array<{ slug: string; sax: string; winner: number; favAskAt30: number }> = [];
const stmt = db.prepare(`SELECT ts, outcomeIndex, bestAsk, bestBid FROM book_snapshots WHERE eventSlug = ? ORDER BY ts`);
for (const w of sample) {
  const rows = stmt.all(w.eventSlug) as any[];
  const byTs = new Map<number, { up?: number; down?: number }>();
  for (const r of rows) {
    if (r.bestAsk === null) continue;
    const e = byTs.get(r.ts) || {};
    if (r.outcomeIndex === 0) e.up = r.bestAsk; else e.down = r.bestAsk;
    byTs.set(r.ts, e);
  }
  const tsSorted = [...byTs.keys()].sort((a, b) => a - b);
  const series: number[] = [];
  let favAskAt30 = NaN;
  const start = w.windowStart, end = w.windowEnd;
  for (const ts of tsSorted) {
    const e = byTs.get(ts)!;
    if (e.up === undefined || e.down === undefined) continue;
    const fav = e.up <= e.down ? e.up : e.down;
    series.push(fav);
    const elapsed = (ts - start) / (end - start);
    if (!Number.isFinite(favAskAt30) && elapsed >= 0.30) favAskAt30 = fav;
  }
  if (series.length < 100) continue;
  const sax = toSAX(series, { ...DEFAULT_SAX_CONFIG, windowTicks: series.length, stride: series.length, paaSegments: 200 });
  windows.push({ slug: w.eventSlug, sax, winner: w.winnerOutcomeIndex as number, favAskAt30 });
}
console.log(`SAX construits: ${windows.length}`);
const nUp = windows.filter((w) => w.winner === 0).length;
console.log(`Baseline P(Up) échantillon: ${(nUp / windows.length).toFixed(4)} (n=${windows.length})`);

// Distribution des symboles SAX (vérifie le skew PAA)
const counts = new Map<string, number>();
for (const w of windows) for (const ch of w.sax) counts.set(ch, (counts.get(ch) || 0) + 1);
console.log('Distribution symboles:', [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${((n / (windows.length * 200)) * 100).toFixed(1)}%`).join(' '));

// 3. Shapelets + PAM (k=8, subsampling stride 20)
// NOTE: une seule longueur — hammingDistance crash sur longueurs mixtes (bug shapelets.mts)
const candidates: ShapeletCandidate[] = [];
windows.forEach((w, idx) => {
  for (let start = 0; start + 20 <= w.sax.length; start += 20) {
    candidates.push({ shapelet: w.sax.slice(start, start + 20), length: 20, start, windowIndex: idx });
  }
});
console.log(`Candidats shapelets: ${candidates.length}`);
const t0 = Date.now();
const { medoids, clusters, cost } = kMedoidsPAM(candidates, { k: 8, maxIter: 3, lengths: [20] } as any);
console.log(`PAM: ${medoids.length} médiodes, cost=${cost.toFixed(4)}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 4. Assignation fenêtre → cluster + P(Up) par cluster
const winCluster = windows.map((w) => assignWindowToCluster(w.sax, medoids)?.clusterId ?? -1);
const byCluster = new Map<number, number[]>();
winCluster.forEach((c, i) => { if (!byCluster.has(c)) byCluster.set(c, []); byCluster.get(c)!.push(i); });
console.log('\n=== CLUSTERS (fenêtres) ===');
console.log('| cluster | n | P(Up) | médiod (début) |');
for (const [cid, idxs] of [...byCluster.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const up = idxs.filter((i) => windows[i].winner === 0).length;
  const med = medoids.find((m) => m.clusterId === cid);
  console.log(`| ${cid} | ${idxs.length} | ${(up / idxs.length).toFixed(3)} | ${(med?.shapelet || '').slice(0, 20)} |`);
}

// 5. Conditionnement simple : favAsk<0.5 à 30% elapsed (le "prix" comme prédicteur)
const lo = windows.filter((w) => Number.isFinite(w.favAskAt30) && w.favAskAt30 < 0.5);
const hi = windows.filter((w) => Number.isFinite(w.favAskAt30) && w.favAskAt30 >= 0.5);
const pUpLo = lo.filter((w) => w.winner === 0).length / (lo.length || 1);
const pUpHi = hi.filter((w) => w.winner === 0).length / (hi.length || 1);
console.log(`\nConditionnement prix (favAsk<0.5): n=${lo.length}, P(Up)=${pUpLo.toFixed(3)}`);
console.log(`Conditionnement prix (favAsk>=0.5): n=${hi.length}, P(Up)=${pUpHi.toFixed(3)}`);

db.close();
console.log('\n=== SONDE 2 TERMINÉE ===');