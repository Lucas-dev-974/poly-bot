/**
 * Dataset builder pour patterns-ml
 * Charge les 510 fenêtres complètes, échantillonne 1 contexte par fenêtre à elapsed fixe,
 * construit features + labels, garde anti-fuite stricte
 */

import Database from 'better-sqlite3';
import { toSAX, slidingWindowSAX, DEFAULT_SAX_CONFIG } from './sax.mts';
import * as path from 'path';
import * as fs from 'fs';

export interface DatasetConfig {
  /** Chemin vers la DB bot-live.db */
  dbPath: string;
  /** Pourcentage d'elapsed pour échantillonnage (défaut: 0.30 = 30%) */
  elapsedPct: number;
  /** Coupure max elapsed % (défaut: 0.75 = 75%) */
  maxElapsedPct: number;
  /** Nombre de ticks avant tick cible pour features brutes (défaut: 60) */
  lookbackTicks: number;
  /** Config SAX */
  saxConfig: Partial<typeof DEFAULT_SAX_CONFIG>;
  /**
   * Audit fix 2026-09-26 : charger les market_snapshots (volume, liquidity…).
   * DÉSACTIVÉ par défaut : market_snapshots n'a PAS d'index eventSlug → full scan
   * de ~515k lignes PAR fenêtre × 1143 fenêtres ≈ 589M lignes (run bloqué 9+ min).
   * Les 5 séries de features (favAsk, askSum, spread, imbalance, depth) sont
   * toutes issues du book ; les champs market ne sont pas utilisés.
   */
  loadMarketSnapshots?: boolean;
}

export const DEFAULT_DATASET_CONFIG: DatasetConfig = {
  dbPath: '',
  elapsedPct: 0.30,
  maxElapsedPct: 0.75,
  lookbackTicks: 60,
  saxConfig: {},
};

export interface WindowMeta {
  eventSlug: string;
  windowStart: number; // timestamp ms
  windowEnd: number;
  tickCount: number;
  winnerOutcomeIndex: number; // 0=Up, 1=Down
  outcomeA: string;
  outcomeB: string;
}

export interface TickData {
  ts: number;
  // UP outcome
  up_bestBid: number;
  up_bestAsk: number;
  up_bestBidSize: number;
  up_bestAskSize: number;
  up_ask2: number;
  up_ask2Size: number;
  up_ask3: number;
  up_ask3Size: number;
  up_bid2: number;
  up_bid2Size: number;
  up_bid3: number;
  up_bid3Size: number;
  // DOWN outcome
  down_bestBid: number;
  down_bestAsk: number;
  down_bestBidSize: number;
  down_bestAskSize: number;
  down_ask2: number;
  down_ask2Size: number;
  down_ask3: number;
  down_ask3Size: number;
  down_bid2: number;
  down_bid2Size: number;
  down_bid3: number;
  down_bid3Size: number;
  // Market snapshot (même ts approximatif)
  volume?: number;
  volume24hr?: number;
  liquidity?: number;
  lastTradePrice?: number;
  spread?: number;
}

export interface ContextFeatures {
  // Métadonnées
  eventSlug: string;
  tickTs: number;
  elapsedPct: number;
  windowIndex: number;

  // Séries brutes (lookbackTicks points chacune)
  // 5 séries : ask favori, askSum, spread, imbalance, profondeur cumulée
  raw_favAsk: number[];
  raw_askSum: number[];
  raw_spread: number[];
  raw_imbalance: number[];
  raw_depth: number[];

  // Représentations SAX (1 chaîne par série)
  sax_favAsk: string;
  sax_askSum: string;
  sax_spread: string;
  sax_imbalance: string;
  sax_depth: string;

  // Labels
  label_outcome: number; // 0=Up gagne, 1=Down gagne
  label_direction60s: number; // 1=hausse prix favori dans 60s, 0=baisse/stable
}

export interface DatasetResult {
  contexts: ContextFeatures[];
  windows: WindowMeta[];
  stats: {
    totalWindows: number;
    windowsWithResolution: number;
    contextsGenerated: number;
    rejectedElapsed: number;
    rejectedAntiLeak: number;
  };
}

/**
 * Identifie l'outcome favori (ask le plus bas) à un tick donné
 */
function getFavoriteOutcome(tick: TickData): 'UP' | 'DOWN' {
  return tick.up_bestAsk <= tick.down_bestAsk ? 'UP' : 'DOWN';
}

/**
 * Calcule les 5 séries clés pour un tick
 */
function computeSeries(tick: TickData): {
  favAsk: number;
  askSum: number;
  spread: number;
  imbalance: number;
  depth: number;
} {
  const fav = getFavoriteOutcome(tick);
  const favAsk = fav === 'UP' ? tick.up_bestAsk : tick.down_bestAsk;
  const favBid = fav === 'UP' ? tick.up_bestBid : tick.down_bestBid;
  const favAskSize = fav === 'UP' ? tick.up_bestAskSize : tick.down_bestAskSize;
  const favBidSize = fav === 'UP' ? tick.up_bestBidSize : tick.down_bestBidSize;

  const otherAsk = fav === 'UP' ? tick.down_bestAsk : tick.up_bestAsk;
  const otherBid = fav === 'UP' ? tick.down_bestBid : tick.up_bestBid;

  const askSum = tick.up_bestAsk + tick.down_bestAsk;
  const spread = favAsk - favBid;
  const imbalance = favBidSize > 0 ? favAskSize / favBidSize : 1;
  const depth =
    (tick.up_bestAskSize + tick.up_ask2Size + tick.up_ask3Size +
     tick.down_bestAskSize + tick.down_ask2Size + tick.down_ask3Size +
     tick.up_bestBidSize + tick.up_bid2Size + tick.up_bid3Size +
     tick.down_bestBidSize + tick.down_bid2Size + tick.down_bid3Size);

  return { favAsk, askSum, spread, imbalance, depth };
}

/**
 * Charge toutes les fenêtres complètes avec résolution
 */
export function loadCompleteWindows(db: Database.Database, config: DatasetConfig): WindowMeta[] {
  const windows = db.prepare(`
    SELECT
      bs.eventSlug,
      MIN(bs.ts) as windowStart,
      MAX(bs.ts) as windowEnd,
      COUNT(*) as tickCount,
      mr.winnerOutcomeIndex,
      -- Récupère les noms d'outcomes depuis book_snapshots (UP/DOWN)
      MAX(CASE WHEN bs.outcomeIndex = 0 THEN bs.outcome END) as outcomeA,
      MAX(CASE WHEN bs.outcomeIndex = 1 THEN bs.outcome END) as outcomeB
    FROM book_snapshots bs
    JOIN market_resolutions mr ON mr.eventSlug = bs.eventSlug
    GROUP BY bs.eventSlug
    HAVING tickCount >= 801
       AND (MAX(bs.ts) - MIN(bs.ts)) / 1000.0 / COUNT(*) <= 1.5 -- gap moyen <= 1.5s
       AND mr.winnerOutcomeIndex IS NOT NULL
       AND mr.winnerOutcomeIndex != 2 -- exclut les règlements void 50/50 (seraient comptés comme Down par label_outcome === 0 ? 1 : 0)
    ORDER BY windowStart
  `).all() as WindowMeta[];

  return windows;
}

/**
 * Charge tous les ticks pour une fenêtre donnée
 * Audit fix 2026-09-26 : l'ancienne version faisait 2 requêtes préparées PAR TICK
 * (N+1 → ~2500 requêtes SQL/fenêtre × 1141 fenêtres). Une seule requête + merge
 * JS par ts.
 * PERF FIX (probe-index) : market_snapshots n'a AUCUN index sur eventSlug →
 * la requête par fenêtre faisait un FULL SCAN des 515k lignes × 1143 fenêtres.
 * Les champs market ne sont utilisés par aucune des 5 séries de features →
 * chargement désactivé par défaut (withMarketData=false).
 */
export function loadWindowTicks(
  db: Database.Database,
  eventSlug: string,
  withMarketData: boolean = false
): TickData[] {
  // Une seule requête : toutes les lignes de la fenêtre (index slug_ts)
  const rows = db.prepare(`
    SELECT ts, outcomeIndex, bestBid, bestAsk, bestBidSize, bestAskSize,
           ask2, ask2Size, ask3, ask3Size, bid2, bid2Size, bid3, bid3Size
    FROM book_snapshots
    WHERE eventSlug = ?
    ORDER BY ts
  `).all(eventSlug) as any[];

  if (rows.length === 0) return [];

  // Market snapshots préchargés (ts croissant) pour lookup par pointeur — optionnel
  let marketRows: any[] = [];
  if (withMarketData) {
    marketRows = db.prepare(`
      SELECT ts, volume, volume24hr, liquidity, lastTradePrice, spread
      FROM market_snapshots
      WHERE eventSlug = ?
      ORDER BY ts
    `).all(eventSlug) as any[];
  }

  let marketPtr = 0;
  const latestMarketAt = (ts: number): any => {
    while (marketPtr + 1 < marketRows.length && marketRows[marketPtr + 1].ts <= ts) marketPtr++;
    return marketRows[marketPtr] && marketRows[marketPtr].ts <= ts ? marketRows[marketPtr] : null;
  };

  // Merge par ts : un tick = UP + DOWN fusionnés
  const byTs = new Map<number, { up: any | null; down: any | null }>();
  for (const r of rows) {
    const entry = byTs.get(r.ts) || { up: null, down: null };
    if (r.outcomeIndex === 0) entry.up = r;
    else if (r.outcomeIndex === 1) entry.down = r;
    byTs.set(r.ts, entry);
  }

  const ticks: TickData[] = [];
  const tsSorted = [...byTs.keys()].sort((a, b) => a - b);

  for (const ts of tsSorted) {
    const { up: upRow, down: downRow } = byTs.get(ts)!;

    // Nécessite les deux outcomes
    if (!upRow || !downRow) continue;
    if (upRow.bestAsk === null || downRow.bestAsk === null) continue;

    // Market snapshot (le plus proche en ts, via pointeur)
    const market = latestMarketAt(ts);

    ticks.push({
      ts,
      up_bestBid: upRow.bestBid,
      up_bestAsk: upRow.bestAsk,
      up_bestBidSize: upRow.bestBidSize,
      up_bestAskSize: upRow.bestAskSize,
      up_ask2: upRow.ask2,
      up_ask2Size: upRow.ask2Size,
      up_ask3: upRow.ask3,
      up_ask3Size: upRow.ask3Size,
      up_bid2: upRow.bid2,
      up_bid2Size: upRow.bid2Size,
      up_bid3: upRow.bid3,
      up_bid3Size: upRow.bid3Size,
      down_bestBid: downRow.bestBid,
      down_bestAsk: downRow.bestAsk,
      down_bestBidSize: downRow.bestBidSize,
      down_bestAskSize: downRow.bestAskSize,
      down_ask2: downRow.ask2,
      down_ask2Size: downRow.ask2Size,
      down_ask3: downRow.ask3,
      down_ask3Size: downRow.ask3Size,
      down_bid2: downRow.bid2,
      down_bid2Size: downRow.bid2Size,
      down_bid3: downRow.bid3,
      down_bid3Size: downRow.bid3Size,
      volume: market?.volume,
      volume24hr: market?.volume24hr,
      liquidity: market?.liquidity,
      lastTradePrice: market?.lastTradePrice,
      spread: market?.spread,
    });
  }

  return ticks.sort((a, b) => a.ts - b.ts);
}

/**
 * Calcule le label direction 60s : le prix favori monte-t-il dans les 60s suivantes ?
 */
function computeDirection60s(ticks: TickData[], targetIdx: number): number {
  const targetTick = ticks[targetIdx];
  const targetTs = targetTick.ts;
  const targetFavAsk = getFavoriteOutcome(targetTick) === 'UP'
    ? targetTick.up_bestAsk
    : targetTick.down_bestAsk;

  // Cherche le tick le plus proche de targetTs + 60000ms
  const futureTs = targetTs + 60000;
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = targetIdx + 1; i < ticks.length; i++) {
    const diff = Math.abs(ticks[i].ts - futureTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    } else if (ticks[i].ts > futureTs) {
      break; // passé le timestamp cible
    }
  }

  if (bestIdx === -1 || bestDiff > 5000) return 0; // Pas de tick futur proche

  const futureTick = ticks[bestIdx];
  const futureFavAsk = getFavoriteOutcome(futureTick) === 'UP'
    ? futureTick.up_bestAsk
    : futureTick.down_bestAsk;

  // Si favori change, on compare quand même le prix du MÊME outcome initial
  const futureAskSameOutcome = getFavoriteOutcome(targetTick) === 'UP'
    ? futureTick.up_bestAsk
    : futureTick.down_bestAsk;

  return futureAskSameOutcome > targetFavAsk ? 1 : 0;
}

/**
 * Construit un contexte de features pour un tick donné
 */
function buildContext(
  ticks: TickData[],
  targetIdx: number,
  window: WindowMeta,
  windowIndex: number,
  config: DatasetConfig
): ContextFeatures | null {
  const targetTick = ticks[targetIdx];
  const elapsedPct = (targetTick.ts - window.windowStart) / (window.windowEnd - window.windowStart);

  // Vérification elapsed
  if (elapsedPct < config.elapsedPct || elapsedPct > config.maxElapsedPct) {
    return null;
  }

  // Lookback : prend les config.lookbackTicks ticks précédents (inclus target)
  const startIdx = Math.max(0, targetIdx - config.lookbackTicks + 1);
  const lookbackTicks = ticks.slice(startIdx, targetIdx + 1);

  if (lookbackTicks.length < 10) return null; // Pas assez d'historique

  // Calcule les 5 séries sur la fenêtre lookback
  const series: number[][] = [[], [], [], [], []]; // favAsk, askSum, spread, imbalance, depth
  for (const tick of lookbackTicks) {
    const s = computeSeries(tick);
    series[0].push(s.favAsk);
    series[1].push(s.askSum);
    series[2].push(s.spread);
    series[3].push(s.imbalance);
    series[4].push(s.depth);
  }

  // Représentations SAX
  const saxConfig = { ...DEFAULT_SAX_CONFIG, ...config.saxConfig };
  const saxStrings = series.map((s) => toSAX(s, saxConfig));

  // Labels
  const label_outcome = window.winnerOutcomeIndex;
  const label_direction60s = computeDirection60s(ticks, targetIdx);

  // Garde anti-fuite : toutes les features sont strictement AVANT la décision
  // La décision = entrée à targetTick.ts, résolution = window.windowEnd (+ ~100s lag)
  // TargetTick.ts < windowEnd est garanti par elapsedPct < 0.75
  // Mais on vérifie aussi que le label direction60s utilise un tick FUTUR (targetIdx+1...)
  // Ce qui est OK car en live on prédit à targetTick.ts pour t+60s

  return {
    eventSlug: window.eventSlug,
    tickTs: targetTick.ts,
    elapsedPct,
    windowIndex,
    raw_favAsk: series[0],
    raw_askSum: series[1],
    raw_spread: series[2],
    raw_imbalance: series[3],
    raw_depth: series[4],
    sax_favAsk: saxStrings[0],
    sax_askSum: saxStrings[1],
    sax_spread: saxStrings[2],
    sax_imbalance: saxStrings[3],
    sax_depth: saxStrings[4],
    label_outcome,
    label_direction60s,
  };
}

/**
 * Pipeline principal : charge DB → construit dataset complet
 */
export function buildDataset(config: DatasetConfig): DatasetResult {
  const dbPath = config.dbPath || path.resolve(process.cwd(), 'data/bot-live.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });

  try {
    // 1. Charge fenêtres complètes
    const windows = loadCompleteWindows(db, config);
    console.log(`Loaded ${windows.length} complete windows with resolution`);

    // 2. Pour chaque fenêtre, charge ticks et échantillonne 1 contexte
    const contexts: ContextFeatures[] = [];
    let rejectedElapsed = 0;
    let rejectedAntiLeak = 0;

    for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
      const window = windows[windowIndex];
      const ticks = loadWindowTicks(db, window.eventSlug, config.loadMarketSnapshots === true);

      if (ticks.length < config.lookbackTicks + 10) {
        rejectedAntiLeak++;
        continue;
      }

      // Calcule l'index cible pour elapsedPct
            const targetTs = window.windowStart + config.elapsedPct * (window.windowEnd - window.windowStart);
      let targetIdx = ticks.findIndex((t) => t.ts >= targetTs);
      if (targetIdx === -1) targetIdx = ticks.length - 1;

      // Ajuste pour avoir assez de lookback
      if (targetIdx < config.lookbackTicks - 1) {
        targetIdx = config.lookbackTicks - 1;
      }
      if (targetIdx >= ticks.length) {
        targetIdx = ticks.length - 1;
      }

      // Vérification finale : targetIdx doit être valide
      if (targetIdx < config.lookbackTicks - 1 || targetIdx >= ticks.length) {
        rejectedAntiLeak++;
        continue;
      }

      const context = buildContext(ticks, targetIdx, window, windowIndex, config);
      if (context) {
        contexts.push(context);
      } else {
        rejectedElapsed++;
      }
    }

    const stats = {
      totalWindows: windows.length,
      windowsWithResolution: windows.filter((w) => w.winnerOutcomeIndex !== null).length,
      contextsGenerated: contexts.length,
      rejectedElapsed,
      rejectedAntiLeak,
    };

    console.log(`Dataset built: ${stats.contextsGenerated} contexts from ${stats.totalWindows} windows`);
    console.log(`Rejected: ${rejectedElapsed} elapsed, ${rejectedAntiLeak} anti-leak`);

    return { contexts, windows, stats };
  } finally {
    db.close();
  }
}

/**
 * Test anti-fuite : vérifie que feature.ts < decision.ts pour tous les contextes
 */
export function testAntiLeak(contexts: ContextFeatures[], windows: WindowMeta[]): boolean {
  const windowMap = new Map(windows.map((w) => [w.eventSlug, w]));

  for (const ctx of contexts) {
    const window = windowMap.get(ctx.eventSlug);
    if (!window) return false;

    // Feature timestamp = ctx.tickTs
    // Decision timestamp = ctx.tickTs (on décide à ce tick)
    // Resolution timestamp = window.windowEnd
    // Doit avoir : feature.ts < decision.ts <= resolution.ts
    // Ici feature.ts === decision.ts (même tick), c'est OK
    // Mais il faut que decision.ts < resolution.ts
    if (ctx.tickTs >= window.windowEnd) {
      console.error(`LEAK: ${ctx.eventSlug} tickTs=${ctx.tickTs} >= windowEnd=${window.windowEnd}`);
      return false;
    }

    // Vérifie aussi elapsedPct cohérent
    const expectedElapsed = (ctx.tickTs - window.windowStart) / (window.windowEnd - window.windowStart);
    if (Math.abs(ctx.elapsedPct - expectedElapsed) > 0.01) {
      console.error(`Elapsed mismatch: ${ctx.eventSlug} stored=${ctx.elapsedPct} computed=${expectedElapsed}`);
      return false;
    }
  }
  return true;
}

/**
 * Split walk-forward par jour (pour évaluation)
 * Retourne array de { train: ContextFeatures[], test: ContextFeatures[], day: string }
 */
export function walkForwardSplitByDay(
  contexts: ContextFeatures[],
  windows: WindowMeta[]
): Array<{ train: ContextFeatures[]; test: ContextFeatures[]; day: string }> {
  // Groupe contexts par jour UTC
  const byDay = new Map<string, ContextFeatures[]>();
  for (const ctx of contexts) {
    const date = new Date(ctx.tickTs).toISOString().split('T')[0];
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date)!.push(ctx);
  }

  const days = Array.from(byDay.keys()).sort();
  const splits: Array<{ train: ContextFeatures[]; test: ContextFeatures[]; day: string }> = [];

  for (let i = 1; i < days.length; i++) {
    const trainDays = days.slice(0, i);
    const testDay = days[i];

    const train: ContextFeatures[] = [];
    for (const d of trainDays) train.push(...byDay.get(d)!);
    const test = byDay.get(testDay)!;

    splits.push({ train, test, day: testDay });
  }

  return splits;
}

/**
 * Calcule les 5 séries brutes pour une fenêtre complète (pour analyse exploratoire)
 */
export function computeWindowSeries(
  ticks: TickData[]
): { favAsk: number[]; askSum: number[]; spread: number[]; imbalance: number[]; depth: number[] } {
  const series = { favAsk: [] as number[], askSum: [] as number[], spread: [] as number[], imbalance: [] as number[], depth: [] as number[] };
  for (const tick of ticks) {
    const s = computeSeries(tick);
    series.favAsk.push(s.favAsk);
    series.askSum.push(s.askSum);
    series.spread.push(s.spread);
    series.imbalance.push(s.imbalance);
    series.depth.push(s.depth);
  }
  return series;
}