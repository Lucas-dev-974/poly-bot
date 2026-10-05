/**
 * Shared feature extraction for fav-band win/loss pattern research.
 * Ticks come from book_snapshots (same source as listBacktestWindows / research sims).
 */
export type TickPoint = {
  ts: number;
  outcomeIndex: number;
  bestAsk: number | null;
  bestBid: number | null;
  bestAskSize: number | null;
};

export type AlignedTick = {
  ts: number;
  upAsk: number | null;
  downAsk: number | null;
  upBid: number | null;
  downBid: number | null;
  upAskSize: number | null;
  downAskSize: number | null;
};

export type PositionInput = {
  id: string;
  source: "live" | "backtest";
  eventSlug: string;
  outcome: string;
  outcomeIndex: number | null;
  fillPrice: number | null;
  bestAskAtFill: number | null;
  size: number | null;
  cost: number | null;
  pnl: number | null;
  status: string;
  createdAt: number;
  resolvedAt: number | null;
  windowEnd: number | null;
  sellPrice: number | null;
  runId?: string | null;
};

export type FeatureRow = PositionInput & {
  label: "win" | "loss" | "flat";
  windowStartSec: number | null;
  durationSec: number | null;
  elapsedSec: number | null;
  remainingSec: number | null;
  entryAsk: number | null;
  entryBid: number | null;
  entrySpread: number | null;
  entryAskSize: number | null;
  otherAskAtEntry: number | null;
  favMarginAtEntry: number | null;
  ticksBefore: number;
  ticksAfter: number;
  flipsBefore: number;
  flipsAfter: number;
  askMinBefore: number | null;
  askMaxBefore: number | null;
  askRangeBefore: number | null;
  askMinAfter: number | null;
  askMaxAfter: number | null;
  askRangeAfter: number | null;
  pathDelta30s: number | null;
  pathDelta60s: number | null;
  pathDelta120s: number | null;
  maeAsk: number | null;
  mfeAsk: number | null;
  favShareBefore: number | null;
  favShareAfter: number | null;
  lowerLowsAfter: number;
  timeToResolveSec: number | null;
  coverageOk: boolean;
  coverageNote: string;
};

export function parseWindowStartSec(slug: string): number | null {
  const m = slug.match(/-(\d{10})$/);
  return m ? Number(m[1]) : null;
}

export function windowDurationSec(slug: string): number | null {
  const m = slug.match(/-(\d+)([mh])-\d{10}$/);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "h" ? 3600 : 60);
}

export function outcomeIndexOf(outcome: string, outcomeIndex: number | null): number {
  if (outcomeIndex === 0 || outcomeIndex === 1) return outcomeIndex;
  const o = outcome.trim().toLowerCase();
  if (o === "up" || o === "yes") return 0;
  if (o === "down" || o === "no") return 1;
  return 0;
}

export function labelFromPosition(status: string, pnl: number | null): "win" | "loss" | "flat" {
  if (status === "won") return "win";
  if (status === "lost") return "loss";
  if (pnl != null) {
    if (pnl > 0) return "win";
    if (pnl < 0) return "loss";
  }
  return "flat";
}

export function alignTicks(rows: TickPoint[]): AlignedTick[] {
  const byTs = new Map<number, AlignedTick>();
  for (const r of rows) {
    let t = byTs.get(r.ts);
    if (!t) {
      t = {
        ts: r.ts,
        upAsk: null,
        downAsk: null,
        upBid: null,
        downBid: null,
        upAskSize: null,
        downAskSize: null,
      };
      byTs.set(r.ts, t);
    }
    if (r.outcomeIndex === 0) {
      t.upAsk = r.bestAsk;
      t.upBid = r.bestBid;
      t.upAskSize = r.bestAskSize;
    } else {
      t.downAsk = r.bestAsk;
      t.downBid = r.bestBid;
      t.downAskSize = r.bestAskSize;
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

function sideAsk(t: AlignedTick, side: number): number | null {
  return side === 0 ? t.upAsk : t.downAsk;
}
function sideBid(t: AlignedTick, side: number): number | null {
  return side === 0 ? t.upBid : t.downBid;
}
function sideAskSize(t: AlignedTick, side: number): number | null {
  return side === 0 ? t.upAskSize : t.downAskSize;
}
function otherAsk(t: AlignedTick, side: number): number | null {
  return side === 0 ? t.downAsk : t.upAsk;
}

function favoriteSide(t: AlignedTick): 0 | 1 | null {
  if (t.upAsk == null || t.downAsk == null) return null;
  if (t.upAsk === t.downAsk) return null;
  return t.upAsk > t.downAsk ? 0 : 1;
}

function countFlips(ticks: AlignedTick[]): number {
  let flips = 0;
  let prev: 0 | 1 | null = null;
  for (const t of ticks) {
    const fav = favoriteSide(t);
    if (fav == null) continue;
    if (prev != null && fav !== prev) flips++;
    prev = fav;
  }
  return flips;
}

function pathDelta(ticks: AlignedTick[], entryTs: number, side: number, entryAsk: number, delayMs: number): number | null {
  const target = entryTs + delayMs;
  let best: AlignedTick | null = null;
  for (const t of ticks) {
    if (t.ts < entryTs) continue;
    if (t.ts > target + 5_000) break;
    if (t.ts >= target - 2_000) {
      best = t;
      if (t.ts >= target) break;
    }
  }
  if (!best) return null;
  const a = sideAsk(best, side);
  return a == null ? null : Number((a - entryAsk).toFixed(4));
}

/** Simplified lower-low count on held ask after entry (cents, min swing 3c). */
function countLowerLows(ticks: AlignedTick[], side: number): number {
  const asks: number[] = [];
  for (const t of ticks) {
    const a = sideAsk(t, side);
    if (a != null) asks.push(Math.round(a * 100));
  }
  if (asks.length < 8) return 0;
  let phase: "down" | "up" = "down";
  let legHigh = asks[0];
  let curLow = asks[0];
  let lastSwingLow: number | null = null;
  let count = 0;
  const MIN_SWING = 3;
  for (const c of asks) {
    if (phase === "down") {
      if (c >= legHigh) {
        legHigh = c;
        curLow = c;
        continue;
      }
      curLow = Math.min(curLow, c);
      const drop = legHigh - curLow;
      const bounce = c - curLow;
      if (drop >= MIN_SWING && bounce >= 1) {
        if (lastSwingLow != null && curLow < lastSwingLow) count++;
        lastSwingLow = curLow;
        phase = "up";
        legHigh = c;
      }
    } else {
      if (c > legHigh) legHigh = c;
      if (legHigh - c >= MIN_SWING) {
        phase = "down";
        curLow = c;
      }
    }
  }
  return count;
}

export function extractFeatures(pos: PositionInput, rawTicks: TickPoint[]): FeatureRow {
  const windowStartSec = parseWindowStartSec(pos.eventSlug);
  const durationSec = windowDurationSec(pos.eventSlug);
  const side = outcomeIndexOf(pos.outcome, pos.outcomeIndex);
  const aligned = alignTicks(rawTicks);
  const label = labelFromPosition(pos.status, pos.pnl);

  const base: FeatureRow = {
    ...pos,
    outcomeIndex: side,
    label,
    windowStartSec,
    durationSec,
    elapsedSec: null,
    remainingSec: null,
    entryAsk: null,
    entryBid: null,
    entrySpread: null,
    entryAskSize: null,
    otherAskAtEntry: null,
    favMarginAtEntry: null,
    ticksBefore: 0,
    ticksAfter: 0,
    flipsBefore: 0,
    flipsAfter: 0,
    askMinBefore: null,
    askMaxBefore: null,
    askRangeBefore: null,
    askMinAfter: null,
    askMaxAfter: null,
    askRangeAfter: null,
    pathDelta30s: null,
    pathDelta60s: null,
    pathDelta120s: null,
    maeAsk: null,
    mfeAsk: null,
    favShareBefore: null,
    favShareAfter: null,
    lowerLowsAfter: 0,
    timeToResolveSec: null,
    coverageOk: aligned.length > 0,
    coverageNote: aligned.length ? "ok" : "no_book_ticks",
  };

  if (!aligned.length || windowStartSec == null) {
    if (windowStartSec == null) base.coverageNote = "bad_slug";
    return base;
  }

  const entryTs = pos.createdAt;
  const windowEndMs =
    pos.windowEnd != null
      ? pos.windowEnd * (pos.windowEnd < 1e12 ? 1000 : 1)
      : (windowStartSec + (durationSec ?? 900)) * 1000;

  base.elapsedSec = Number(((entryTs - windowStartSec * 1000) / 1000).toFixed(1));
  base.remainingSec = Number(((windowEndMs - entryTs) / 1000).toFixed(1));
  if (pos.resolvedAt != null) {
    base.timeToResolveSec = Number(((pos.resolvedAt - entryTs) / 1000).toFixed(1));
  }

  const before = aligned.filter((t) => t.ts <= entryTs);
  const after = aligned.filter((t) => t.ts >= entryTs);
  base.ticksBefore = before.length;
  base.ticksAfter = after.length;
  base.flipsBefore = countFlips(before);
  base.flipsAfter = countFlips(after);

  // Entry tick: nearest at or before entry, else first after
  let entryTick: AlignedTick | null = null;
  for (let i = before.length - 1; i >= 0; i--) {
    if (sideAsk(before[i], side) != null) {
      entryTick = before[i];
      break;
    }
  }
  if (!entryTick) {
    for (const t of after) {
      if (sideAsk(t, side) != null) {
        entryTick = t;
        break;
      }
    }
  }

  const entryAsk =
    (entryTick ? sideAsk(entryTick, side) : null) ??
    pos.bestAskAtFill ??
    pos.fillPrice;
  base.entryAsk = entryAsk;
  if (entryTick) {
    base.entryBid = sideBid(entryTick, side);
    base.entryAskSize = sideAskSize(entryTick, side);
    base.otherAskAtEntry = otherAsk(entryTick, side);
    if (entryAsk != null && base.entryBid != null) {
      base.entrySpread = Number((entryAsk - base.entryBid).toFixed(4));
    }
    if (entryAsk != null && base.otherAskAtEntry != null) {
      base.favMarginAtEntry = Number((entryAsk - base.otherAskAtEntry).toFixed(4));
    }
  }

  const minsMax = (ticks: AlignedTick[]) => {
    let mn: number | null = null;
    let mx: number | null = null;
    for (const t of ticks) {
      const a = sideAsk(t, side);
      if (a == null) continue;
      mn = mn == null ? a : Math.min(mn, a);
      mx = mx == null ? a : Math.max(mx, a);
    }
    return { mn, mx, range: mn != null && mx != null ? Number((mx - mn).toFixed(4)) : null };
  };
  const b = minsMax(before);
  const a = minsMax(after);
  base.askMinBefore = b.mn;
  base.askMaxBefore = b.mx;
  base.askRangeBefore = b.range;
  base.askMinAfter = a.mn;
  base.askMaxAfter = a.mx;
  base.askRangeAfter = a.range;

  if (entryAsk != null) {
    if (a.mn != null) base.maeAsk = Number((a.mn - entryAsk).toFixed(4));
    if (a.mx != null) base.mfeAsk = Number((a.mx - entryAsk).toFixed(4));
    base.pathDelta30s = pathDelta(after, entryTs, side, entryAsk, 30_000);
    base.pathDelta60s = pathDelta(after, entryTs, side, entryAsk, 60_000);
    base.pathDelta120s = pathDelta(after, entryTs, side, entryAsk, 120_000);
  }

  const favShare = (ticks: AlignedTick[]) => {
    let ok = 0;
    let n = 0;
    for (const t of ticks) {
      const mine = sideAsk(t, side);
      const oth = otherAsk(t, side);
      if (mine == null || oth == null) continue;
      n++;
      if (mine >= oth) ok++;
    }
    return n ? Number((ok / n).toFixed(4)) : null;
  };
  base.favShareBefore = favShare(before);
  base.favShareAfter = favShare(after);
  base.lowerLowsAfter = countLowerLows(after, side);

  if (base.ticksBefore + base.ticksAfter < 50) {
    base.coverageOk = false;
    base.coverageNote = "sparse_ticks";
  }

  return base;
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return a[lo];
  return a[lo] * (hi - i) + a[hi] * (i - lo);
}
export function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}
export function cohenD(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const ma = mean(a)!;
  const mb = mean(b)!;
  const sa = stdev(a)!;
  const sb = stdev(b)!;
  const pooled = Math.sqrt(((a.length - 1) * sa ** 2 + (b.length - 1) * sb ** 2) / (a.length + b.length - 2));
  if (!pooled) return null;
  return (ma - mb) / pooled;
}
export function round(n: number | null, d = 4): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
