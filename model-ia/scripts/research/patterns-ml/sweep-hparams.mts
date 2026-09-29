/**
 * Sweep d'hyperparamètres pour le clustering SAX (Phase 1, §8 du plan).
 *
 * Grille (bornée, cf. PHASE-1-DEVELOPMENT.md §8) :
 *  - série d'entrée : niveaux vs rendements (Δ) de la série leader (max ask)
 *  - paaSegments    : 60 / 120 / 200 (longueur de la chaîne SAX)
 *  - alphabet       : 6 / 8 / 10 symboles
 *  - k              : 4 / 8 / 12 / 16 médiodes
 * Soit 72 configs. Chaque config est évaluée sur les MÊMES 1144 fenêtres :
 *  - silhouette (séparabilité, seuil non-séparabilité = 0.25)
 *  - ARI split-half réel (stabilité, seuil 0.6)
 *  - edge par cluster : binomial exact vs baseline P(Up) + BH-FDR 10% + MDE
 *
 * Sorties (model-ia/patterns/) :
 *  - report-hparam-sweep-<ts>.csv  (toutes les configs, triées par score)
 *  - report-hparam-sweep-<ts>.json (détails par cluster)
 *  - report-hparam-sweep-<ts>.md   (synthèse + top configs)
 *
 * Usage: npx tsx model-ia/scripts/research/patterns-ml/sweep-hparams.mts
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { kMedoidsPAM, assignWindowToCluster, type ShapeletCandidate } from './shapelets.mts';
import { toSAX, DEFAULT_SAX_CONFIG } from './sax.mts';
import { binomialTest, benjaminiHochberg, adjustedRandIndex, computeMDE } from './discover.mts';

// ---------------------------------------------------------------------------
// Grille
// ---------------------------------------------------------------------------
const SERIES_VARIANTS = ['levels', 'returns'] as const;
const PAA_OPTIONS = [60, 120, 200];
const ALPHABET_OPTIONS = [6, 8, 10];
const K_OPTIONS = [4, 8, 12, 16];

const MIN_CLUSTER_SIZE = 50;
const FDR = 0.10;
const ALPHA = 0.05;
const POWER = 0.8;
const ARI_THRESHOLD = 0.6;
const SILHOUETTE_THRESHOLD = 0.25;
const SEED = 42;

interface Tick { ts: number; upAsk: number; downAsk: number; }

interface WindowData {
  eventSlug: string;
  winner: number; // 0=Up, 1=Down
  levels: number[];   // série leader (max ask)
  returns: number[];  // Δ leader
}

// ---------------------------------------------------------------------------
// Chargement (une seule fois)
// ---------------------------------------------------------------------------
function loadData(): { windows: WindowData[]; baselinePUp: number } {
  const db = new Database(path.resolve(process.cwd(), 'data/bot-live.db'), { readonly: true });
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

  const stmt = db.prepare(`
    SELECT ts, outcomeIndex, bestAsk FROM book_snapshots WHERE eventSlug = ? ORDER BY ts
  `);

  const data: WindowData[] = [];
  for (const w of windows) {
    const rows = stmt.all(w.eventSlug) as any[];
    const byTs = new Map<number, { up: number | null; down: number | null }>();
    for (const r of rows) {
      const e = byTs.get(r.ts) || { up: null, down: null };
      if (r.outcomeIndex === 0) e.up = r.bestAsk;
      else if (r.outcomeIndex === 1) e.down = r.bestAsk;
      byTs.set(r.ts, e);
    }
    const tsSorted = [...byTs.keys()].sort((a, b) => a - b);
    const levels: number[] = [];
    for (const ts of tsSorted) {
      const e = byTs.get(ts)!;
      if (e.up == null || e.down == null) continue;
      levels.push(Math.max(e.up, e.down)); // série leader (convention du bot)
    }
    if (levels.length < 200) continue;
    const returns = levels.map((v, i) => (i === 0 ? 0 : v - levels[i - 1]));
    data.push({ eventSlug: w.eventSlug, winner: w.winnerOutcomeIndex as number, levels, returns });
  }
  db.close();

  const baselinePUp = data.filter((d) => d.winner === 0).length / data.length;
  return { windows: data, baselinePUp };
}

// ---------------------------------------------------------------------------
// Évaluation d'une config
// ---------------------------------------------------------------------------
interface ConfigResult {
  series: string; paa: number; alphabet: number; k: number;
  silhouette: number;
  ari: number;
  nClusters: number;
  clustersGE50: number;
  maxAbsDeltaP: number;
  bhSignificant: number;
  bestCluster: { id: number; n: number; pUp: number; deltaP: number; pValue: number } | null;
  elapsedMs: number;
  clusterDetails: Array<{ id: number; n: number; pUp: number; deltaP: number; pValue: number; sig: boolean }>;
}

function evaluateConfig(
  data: WindowData[],
  baselinePUp: number,
  seriesKey: 'levels' | 'returns',
  paaSegments: number,
  alphabetSize: number,
  k: number
): ConfigResult {
  const t0 = Date.now();
  const saxCfg = { ...DEFAULT_SAX_CONFIG, alphabetSize, paaSegments };

  // SAX de chaque fenêtre
  const saxList: string[] = data.map((d) =>
    toSAX(d[seriesKey], { ...saxCfg, windowTicks: d[seriesKey].length, stride: d[seriesKey].length, paaSegments })
  );

  const candidates: ShapeletCandidate[] = saxList.map((sax, i) => ({
    shapelet: sax, length: sax.length, start: 0, windowIndex: i,
  }));

  // Clustering complet
  const full = kMedoidsPAM(candidates, { k, maxIter: 10, seed: SEED });

  // Assignation fenêtre → cluster
  const assignments = saxList.map((sax) => assignWindowToCluster(sax, full.medoids)?.clusterId ?? -1);

  // Split-half : clustering jours pairs vs impairs (ARI croisé)
  const dayOf = (i: number): string => {
    // windowStart approx : on utilise l'index temporel du slug btc-updown-15m-<ts>
    const m = /(\d{10})$/.exec(data[i].eventSlug);
    return m ? new Date(parseInt(m[1], 10) * 1000).toISOString().split('T')[0] : 'unknown';
  };
  const daysSorted = [...new Set(data.map((_, i) => dayOf(i)))].sort();
  const earlyDays = new Set(daysSorted.filter((_, i) => i % 2 === 0));
  const earlyIdx: number[] = [];
  const lateIdx: number[] = [];
  for (let i = 0; i < data.length; i++) (earlyDays.has(dayOf(i)) ? earlyIdx : lateIdx).push(i);

  let ari = 0;
  if (earlyIdx.length >= k * 5 && lateIdx.length >= k * 5) {
    const mk = (idxs: number[]) => idxs.map((i) => ({ shapelet: saxList[i], length: saxList[i].length, start: 0, windowIndex: i }));
    const earlyRes = kMedoidsPAM(mk(earlyIdx), { k, maxIter: 10, seed: SEED });
    const lateRes = kMedoidsPAM(mk(lateIdx), { k, maxIter: 10, seed: SEED + 1 });
    const lE = saxList.map((s) => assignWindowToCluster(s, earlyRes.medoids)?.clusterId ?? -1);
    const lL = saxList.map((s) => assignWindowToCluster(s, lateRes.medoids)?.clusterId ?? -1);
    ari = adjustedRandIndex(lE, lL);
  }

  // Stats par cluster + BH
  const mde = computeMDE(MIN_CLUSTER_SIZE, POWER, ALPHA, baselinePUp);
  const clusterDetails: ConfigResult['clusterDetails'] = [];
  const pValues: number[] = [];

  // Membres par clusterId
  const membersByCluster = new Map<number, number[]>();
  for (let i = 0; i < data.length; i++) {
    const cid = assignments[i];
    if (!membersByCluster.has(cid)) membersByCluster.set(cid, []);
    membersByCluster.get(cid)!.push(i);
  }
  for (const medoid of full.medoids) {
    const idxs = membersByCluster.get(medoid.clusterId) ?? [];
    const n = idxs.length;
    if (n < MIN_CLUSTER_SIZE) {
      clusterDetails.push({ id: medoid.clusterId, n, pUp: 0.5, deltaP: 0, pValue: 1, sig: false });
      pValues.push(1);
      continue;
    }
    const up = idxs.filter((i) => data[i].winner === 0).length;
    const pUp = up / n;
    const pVal = binomialTest(up, n, baselinePUp);
    clusterDetails.push({ id: medoid.clusterId, n, pUp, deltaP: pUp - baselinePUp, pValue: pVal, sig: false });
    pValues.push(pVal);
  }
  const bh = benjaminiHochberg(pValues, FDR);
  for (let i = 0; i < clusterDetails.length; i++) {
    clusterDetails[i].sig = bh[i].significant && Math.abs(clusterDetails[i].deltaP) >= mde;
  }

  const sig = clusterDetails.filter((c) => c.sig).length;
  const best = clusterDetails
    .filter((c) => c.n >= MIN_CLUSTER_SIZE)
    .sort((a, b) => Math.abs(b.deltaP) - Math.abs(a.deltaP))[0] ?? null;

  return {
    series: seriesKey, paa: paaSegments, alphabet: alphabetSize, k,
    silhouette: full.silhouette,
    ari,
    nClusters: full.medoids.length,
    clustersGE50: clusterDetails.filter((c) => c.n >= MIN_CLUSTER_SIZE).length,
    maxAbsDeltaP: best ? Math.abs(best.deltaP) : 0,
    bhSignificant: sig,
    bestCluster: best ? { id: best.id, n: best.n, pUp: best.pUp, deltaP: best.deltaP, pValue: best.pValue } : null,
    elapsedMs: Date.now() - t0,
    clusterDetails,
  };
}

function main(): void {
  console.log('=== SWEEP HYPERPARAMÈTRES (clustering SAX) ===');
  console.log(`Grille: ${SERIES_VARIANTS.length} séries × ${PAA_OPTIONS.length} paa × ${ALPHABET_OPTIONS.length} alphabets × ${K_OPTIONS.length} k = ${SERIES_VARIANTS.length * PAA_OPTIONS.length * ALPHABET_OPTIONS.length * K_OPTIONS.length} configs`);

  const { windows: data, baselinePUp } = loadData();
  console.log(`Fenêtres: ${data.length}, baseline P(Up)=${baselinePUp.toFixed(4)}`);

  const results: ConfigResult[] = [];
  let done = 0;
  for (const seriesKey of SERIES_VARIANTS) {
    for (const paaSegments of PAA_OPTIONS) {
      for (const alphabetSize of ALPHABET_OPTIONS) {
        for (const k of K_OPTIONS) {
          const r = evaluateConfig(data, baselinePUp, seriesKey, paaSegments, alphabetSize, k);
          results.push(r);
          done++;
          console.log(`[${done}/72] ${seriesKey} paa=${paaSegments} abc=${alphabetSize} k=${k} → sil=${r.silhouette.toFixed(3)} ari=${r.ari.toFixed(3)} sig=${r.bhSignificant} (${(r.elapsedMs / 1000).toFixed(1)}s)`);
        }
      }
    }
  }

  // Tri par (silhouette + ari + sig*2) décroissant
  const scored = [...results].sort((a, b) => score(b) - score(a));
  function score(r: ConfigResult): number {
    return r.silhouette + r.ari + r.bhSignificant * 2;
  }

  // CSV
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve('model-ia/patterns');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.resolve(outDir, `report-hparam-sweep-${ts}.csv`);
  const csvLines = ['series,paa,alphabet,k,silhouette,ari,nClusters,clustersGE50,maxAbsDeltaP,bhSignificant,bestClusterN,bestClusterDeltaP,elapsedMs'];
  for (const r of scored) {
    csvLines.push([
      r.series, r.paa, r.alphabet, r.k,
      r.silhouette.toFixed(4), r.ari.toFixed(4), r.nClusters, r.clustersGE50,
      r.maxAbsDeltaP.toFixed(4), r.bhSignificant,
      r.bestCluster?.n ?? 0, r.bestCluster ? r.bestCluster.deltaP.toFixed(4) : '0',
      r.elapsedMs,
    ].join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  // JSON
  const jsonPath = path.resolve(outDir, `report-hparam-sweep-${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ baselinePUp, grid: { SERIES_VARIANTS, PAA_OPTIONS, ALPHABET_OPTIONS, K_OPTIONS }, results }, null, 2));

  // MD
  const md: string[] = [];
  md.push('# Sweep Hyperparamètres — Clustering SAX');
  md.push('');
  md.push(`**Date:** ${new Date().toISOString()}`);
  md.push(`**Données:** ${data.length} fenêtres, baseline P(Up)=${baselinePUp.toFixed(4)}`);
  md.push(`**Grille:** série {${SERIES_VARIANTS.join(',')}} × paa {${PAA_OPTIONS.join(',')}} × alphabet {${ALPHABET_OPTIONS.join(',')}} × k {${K_OPTIONS.join(',')}} = 72 configs`);
  md.push(`**Critères:** silhouette ≥ ${SILHOUETTE_THRESHOLD} (séparabilité), ARI ≥ ${ARI_THRESHOLD} (stabilité), BH-FDR ${FDR} + |ΔP| ≥ MDE(n≥${MIN_CLUSTER_SIZE})`);
  md.push('');
  md.push('## Top 10 configs (score = silhouette + ARI + 2×nb clusters significatifs)');
  md.push('');
  md.push('| # | série | paa | alphabet | k | silhouette | ARI | clus n≥50 | maxAbsΔP | BH-sig | verdict |');
  md.push('|---|-------|-----|----------|---|------------|-----|-----------|----------|--------|---------|');
  for (let i = 0; i < Math.min(10, scored.length); i++) {
    const r = scored[i];
    const verdict = r.bhSignificant > 0 ? '✅ SIGNAL' : (r.silhouette >= SILHOUETTE_THRESHOLD && r.ari >= ARI_THRESHOLD ? '🟡 séparé+stable' : '❌');
    md.push(`| ${i + 1} | ${r.series} | ${r.paa} | ${r.alphabet} | ${r.k} | ${r.silhouette.toFixed(3)} | ${r.ari.toFixed(3)} | ${r.nClusters} | ${r.maxAbsDeltaP.toFixed(4)} | ${r.bhSignificant} | ${verdict} |`);
  }
  md.push('');
  md.push('## Synthèse par dimension (moyennes)');
  md.push('');
  const avg = (arr: number[]) => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0;
  md.push(`- **Série:** levels sil=${avg(results.filter(r => r.series === 'levels').map(r => r.silhouette)).toFixed(3)} vs returns sil=${avg(results.filter(r => r.series === 'returns').map(r => r.silhouette)).toFixed(3)}`);
  for (const p of PAA_OPTIONS) md.push(`- **paa=${p}:** sil=${avg(results.filter(r => r.paa === p).map(r => r.silhouette)).toFixed(3)}`);
  for (const a of ALPHABET_OPTIONS) md.push(`- **alphabet=${a}:** sil=${avg(results.filter(r => r.alphabet === a).map(r => r.silhouette)).toFixed(3)}`);
  for (const kk of K_OPTIONS) md.push(`- **k=${kk}:** sil=${avg(results.filter(r => r.k === kk).map(r => r.silhouette)).toFixed(3)}, ari=${avg(results.filter(r => r.k === kk).map(r => r.ari)).toFixed(3)}`);
  md.push('');
  const best = scored[0];
  md.push('## Détail de la meilleure config');
  md.push('');
  md.push(`**${best.series}, paa=${best.paa}, alphabet=${best.alphabet}, k=${best.k}** — silhouette=${best.silhouette.toFixed(3)}, ARI=${best.ari.toFixed(3)}`);
  md.push('');
  md.push('| Cluster | n | P(Up) | ΔP | p-value | BH-sig |');
  md.push('|---------|---|-------|-----|---------|--------|');
  for (const c of best.clusterDetails) {
    md.push(`| ${c.id} | ${c.n} | ${c.pUp.toFixed(4)} | ${c.deltaP >= 0 ? '+' : ''}${c.deltaP.toFixed(4)} | ${c.pValue.toFixed(4)} | ${c.sig ? '✅' : '❌'} |`);
  }
  md.push('');
  const mdPath = path.resolve(outDir, `report-hparam-sweep-${ts}.md`);
  fs.writeFileSync(mdPath, md.join('\n'));

  console.log('\n=== SWEEP TERMINÉ ===');
  console.log(`Top 3:`);
  for (let i = 0; i < Math.min(3, scored.length); i++) {
    const r = scored[i];
    console.log(`  ${i + 1}. ${r.series} paa=${r.paa} abc=${r.alphabet} k=${r.k} → sil=${r.silhouette.toFixed(3)} ari=${r.ari.toFixed(3)} sig=${r.bhSignificant}`);
  }
  console.log(`Saved: ${csvPath}`);
  console.log(`Saved: ${mdPath}`);
}

main();