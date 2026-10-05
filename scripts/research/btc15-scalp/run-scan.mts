/**
 * BTC 15m scalp scan. Offline only. Entry at ask, exit at bid.
 * Train = first 60% of complete windows by start time. Holdout = last 40%.
 * Holdout is scored once per concept, in order, and stops when one clears:
 *   n>=40, win rate>=60%, total PnL>0 after the bid/ask cross.
 *
 * Run from repo root: npx tsx scripts/research/btc15-scalp/run-scan.mts
 */
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const STAKE = 4;
const MAX_SPREAD = 0.1;
const MIN_TICKS = 601;
const MAX_GAP_MS = 60_000;
const WINDOW_SEC = 900;
const PREFIX = "btc-updown-15m-";
const EPS = 1e-6;
const LOOKBACK_SLACK_MS = 2_000;

const PANIC_D = [0.08, 0.12, 0.18];
const PANIC_L = [15, 30, 60];
const PANIC_T = [0.06, 0.1, 0.15];
const PANIC_S = [0.06, 0.1];
const PANIC_BAND = [0.15, 0.45];
const PANIC_HOLD_MS = 120_000;

const SUM_TH = [1.03, 1.05, 1.08];
const SUM_EXIT = 1.02;
const SUM_T = [0.04, 0.06, 0.1];
const SUM_S = [0.04, 0.06, 0.1];
const SUM_BAND = [0.2, 0.48];
const SUM_HOLD_MS = 90_000;

const DEP_T = [0.06, 0.08, 0.1, 0.12];
const DEP_S = [0.04, 0.06, 0.08];
const DEP_AGE = [10, 30, 60];
const DEP_BAND = [0.25, 0.45];
const DEP_HOLD_MS = 90_000;

// Extra concept, literature only (no spot/chainlink table in this DB):
// Cardozo & Rivero-Wildemauwe, arXiv:2609.12878 (2026): buys <10c lose ~19c/$,
// buys >=90c earn. Scalp a dip that leaves the token still the favorite.
const FAV_D = [0.06, 0.1, 0.15];
const FAV_L = [15, 30, 60];
const FAV_T = [0.04, 0.06, 0.1];
const FAV_S = [0.04, 0.06];
const FAV_BAND = [0.55, 0.8];
const FAV_HOLD_MS = 90_000;

function finite(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function lookbackRefs(ts, ask, Lms) {
  const n = ts.length;
  const ref = new Float64Array(n);
  ref.fill(Number.NaN);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = ts[i] - Lms;
    while (j < i && ts[j] <= target) j++;
    const c = j - 1;
    if (c >= 0 && c < i && target - ts[c] <= LOOKBACK_SLACK_MS && finite(ask[c])) {
      ref[i] = ask[c];
    }
  }
  return ref;
}

function entryOk(ask, bid, sz, lo, hi) {
  if (!finite(ask) || !finite(bid)) return false;
  if (ask < lo || ask > hi) return false;
  const spread = ask - bid;
  if (!(spread > 0) || spread > MAX_SPREAD) return false;
  const shares = STAKE / ask;
  if (!Number.isFinite(shares) || shares <= 0) return false;
  if (finite(sz) && sz + 1e-9 < shares) return false;
  return true;
}

function pnlOf(entryAsk, exitBid) {
  return (STAKE / entryAsk) * (exitBid - entryAsk);
}

function exitOnBids(ts, bids, entryI, entryAsk, T, S, holdMs, endMs, asksForSum) {
  let lastBid = Number.NaN;
  const deadline = ts[entryI] + holdMs;
  for (let k = entryI + 1; k < ts.length; k++) {
    const bid = bids[k];
    if (finite(bid)) lastBid = bid;
    const timed = ts[k] >= deadline;
    const ended = ts[k] >= endMs;
    if (!finite(bid)) {
      if (ended) break;
      continue;
    }
    if (bid <= entryAsk - S + 1e-12) return { bid, reason: "sl" };
    if (bid >= entryAsk + T - 1e-12) return { bid, reason: "tp" };
    if (asksForSum) {
      const s = asksForSum(k);
      if (s != null && s < SUM_EXIT) return { bid, reason: "snap" };
    }
    if (timed) return { bid, reason: "time" };
    if (ended) return { bid, reason: "end" };
  }
  if (finite(lastBid)) return { bid: lastBid, reason: "end" };
  return { bid: 0, reason: "nobid" };
}

function blank() {
  return { n: 0, wins: 0, pnl: 0, winSum: 0, lossSum: 0, losses: 0, reasons: {} };
}

function add(agg, pnl, reason) {
  agg.n++;
  agg.pnl += pnl;
  agg.reasons[reason] = (agg.reasons[reason] || 0) + 1;
  if (pnl > EPS) {
    agg.wins++;
    agg.winSum += pnl;
  } else {
    agg.losses++;
    agg.lossSum += pnl;
  }
}

function view(agg) {
  const n = agg.n;
  return {
    n,
    wins: agg.wins,
    losses: agg.losses,
    winRate: n ? agg.wins / n : 0,
    pnl: agg.pnl,
    pnlPer1: agg.pnl / STAKE,
    avgWin: agg.wins ? agg.winSum / agg.wins : null,
    avgLoss: agg.losses ? agg.lossSum / agg.losses : null,
    exitReasons: agg.reasons,
  };
}

function better(a, b) {
  if (a.pnl !== b.pnl) return a.pnl > b.pnl;
  if (a.wins / a.n !== b.wins / b.n) return a.wins / a.n > b.wins / b.n;
  if (a.n !== b.n) return a.n > b.n;
  return String(a.params) < String(b.params);
}

function pick(cells) {
  const eligible = cells.filter((c) => c.n >= 40 && c.wins / c.n >= 0.55 - 1e-12);
  const pool = eligible.length ? eligible : cells.filter((c) => c.n >= 40);
  if (!pool.length) return { frozen: null, rule: "no train cell with n>=40", eligible: eligible.length };
  let best = pool[0];
  for (const c of pool) if (better(c, best)) best = c;
  return {
    frozen: best,
    rule: eligible.length ? "best train PnL among WR>=55% and n>=40" : "no WR>=55% cell; best train PnL among n>=40",
    eligible: eligible.length,
  };
}

const refCache = new WeakMap();
function cachedRefs(w, side, Lms) {
  let m = refCache.get(w);
  if (!m) {
    m = new Map();
    refCache.set(w, m);
  }
  const key = side + ":" + Lms;
  let arr = m.get(key);
  if (!arr) {
    arr = lookbackRefs(w.ts, side === 0 ? w.a0 : w.a1, Lms);
    m.set(key, arr);
  }
  return arr;
}
const favCache = new WeakMap();
function cachedFav(w) {
  let fav = favCache.get(w);
  if (!fav) {
    fav = favSeries(w);
    favCache.set(w, fav);
  }
  return fav;
}
function simulatePanic(w, Lms, D, T, S) {
  const ref0 = cachedRefs(w, 0, Lms);
  const ref1 = cachedRefs(w, 1, Lms);
  for (let i = 0; i < w.ts.length; i++) {
    let side = -1;
    let drop = -1;
    for (const s of [0, 1]) {
      const ask = s === 0 ? w.a0[i] : w.a1[i];
      const bid = s === 0 ? w.b0[i] : w.b1[i];
      const sz = s === 0 ? w.s0[i] : w.s1[i];
      const ref = s === 0 ? ref0[i] : ref1[i];
      if (!finite(ref) || ref - ask < D - 1e-12) continue;
      if (!entryOk(ask, bid, sz, PANIC_BAND[0], PANIC_BAND[1])) continue;
      const d = ref - ask;
      if (d > drop + 1e-12 || (Math.abs(d - drop) <= 1e-12 && (side < 0 || ask < (side === 0 ? w.a0[i] : w.a1[i])))) {
        drop = d;
        side = s;
      }
    }
    if (side < 0) continue;
    const ask = side === 0 ? w.a0[i] : w.a1[i];
    const bids = side === 0 ? w.b0 : w.b1;
    const ex = exitOnBids(w.ts, bids, i, ask, T, S, PANIC_HOLD_MS, w.endMs, null);
    return { pnl: pnlOf(ask, ex.bid), reason: ex.reason, entryAsk: ask, exitBid: ex.bid, entryTs: w.ts[i], side };
  }
  return null;
}

function simulateSum(w, th, T, S) {
  for (let i = 0; i < w.ts.length; i++) {
    if (!finite(w.a0[i]) || !finite(w.a1[i])) continue;
    const sum = w.a0[i] + w.a1[i];
    if (sum < th - 1e-12) continue;
    const side = w.a0[i] < w.a1[i] ? 0 : w.a1[i] < w.a0[i] ? 1 : -1;
    if (side < 0) continue;
    const ask = side === 0 ? w.a0[i] : w.a1[i];
    const bid = side === 0 ? w.b0[i] : w.b1[i];
    const sz = side === 0 ? w.s0[i] : w.s1[i];
    if (!entryOk(ask, bid, sz, SUM_BAND[0], SUM_BAND[1])) continue;
    const bids = side === 0 ? w.b0 : w.b1;
    const ex = exitOnBids(w.ts, bids, i, ask, T, S, SUM_HOLD_MS, w.endMs, (k) =>
      finite(w.a0[k]) && finite(w.a1[k]) ? w.a0[k] + w.a1[k] : null,
    );
    return { pnl: pnlOf(ask, ex.bid), reason: ex.reason, entryAsk: ask, exitBid: ex.bid, entryTs: w.ts[i], side };
  }
  return null;
}

function favSeries(w) {
  const fav = new Int8Array(w.ts.length);
  fav.fill(-1);
  let prev = -1;
  for (let i = 0; i < w.ts.length; i++) {
    const ua = w.a0[i];
    const da = w.a1[i];
    if (finite(ua) && finite(da)) {
      if (ua > da) prev = 0;
      else if (da > ua) prev = 1;
    }
    fav[i] = prev;
  }
  return fav;
}

function simulateDeposed(w, T, S, ageSec) {
  const fav = cachedFav(w);
  const ageMs = ageSec * 1000;
  for (let i = 1; i < w.ts.length; i++) {
    if (fav[i] < 0 || fav[i - 1] < 0 || fav[i] === fav[i - 1]) continue;
    const deposed = fav[i - 1];
    const flipTs = w.ts[i];
    for (let k = i; k < w.ts.length; k++) {
      if (w.ts[k] - flipTs > ageMs) break;
      if (fav[k] === deposed) break;
      const ask = deposed === 0 ? w.a0[k] : w.a1[k];
      const bid = deposed === 0 ? w.b0[k] : w.b1[k];
      const sz = deposed === 0 ? w.s0[k] : w.s1[k];
      if (!entryOk(ask, bid, sz, DEP_BAND[0], DEP_BAND[1])) continue;
      const bids = deposed === 0 ? w.b0 : w.b1;
      const ex = exitOnBids(w.ts, bids, k, ask, T, S, DEP_HOLD_MS, w.endMs, null);
      return { pnl: pnlOf(ask, ex.bid), reason: ex.reason, entryAsk: ask, exitBid: ex.bid, entryTs: w.ts[k], side: deposed };
    }
  }
  return null;
}

function simulateFavDip(w, Lms, D, T, S) {
  const ref0 = cachedRefs(w, 0, Lms);
  const ref1 = cachedRefs(w, 1, Lms);
  const fav = cachedFav(w);
  for (let i = 0; i < w.ts.length; i++) {
    const side = fav[i];
    if (side < 0) continue;
    const ask = side === 0 ? w.a0[i] : w.a1[i];
    const bid = side === 0 ? w.b0[i] : w.b1[i];
    const sz = side === 0 ? w.s0[i] : w.s1[i];
    const ref = side === 0 ? ref0[i] : ref1[i];
    if (!finite(ref) || ref - ask < D - 1e-12) continue;
    if (!entryOk(ask, bid, sz, FAV_BAND[0], FAV_BAND[1])) continue;
    const bids = side === 0 ? w.b0 : w.b1;
    const ex = exitOnBids(w.ts, bids, i, ask, T, S, FAV_HOLD_MS, w.endMs, null);
    return { pnl: pnlOf(ask, ex.bid), reason: ex.reason, entryAsk: ask, exitBid: ex.bid, entryTs: w.ts[i], side };
  }
  return null;
}

function runCells(windows, cells, sim) {
  const aggs = cells.map(() => blank());
  let seen = 0;
  for (const w of windows) {
    if (++seen % 400 === 0) console.log("  sim", seen, "/", windows.length);
    for (let c = 0; c < cells.length; c++) {
      const r = sim(w, cells[c]);
      if (r) add(aggs[c], r.pnl, r.reason);
    }
  }
  return cells.map((params, i) => ({ params, ...view(aggs[i]), _agg: aggs[i] }));
}

function scoreOne(windows, params, sim) {
  const agg = blank();
  const examples = [];
  for (const w of windows) {
    const r = sim(w, params);
    if (!r) continue;
    add(agg, r.pnl, r.reason);
    if (examples.length < 5) {
      examples.push({
        slug: w.slug,
        side: r.side,
        entryTs: r.entryTs,
        entryAsk: r.entryAsk,
        exitBid: r.exitBid,
        pnl: r.pnl,
        reason: r.reason,
      });
    }
  }
  return { ...view(agg), examples };
}

function selftest() {
  const n = 700;
  const start = 1_700_000_000;
  const w = {
    slug: "btc-updown-15m-1700000000",
    start,
    endMs: (start + WINDOW_SEC) * 1000,
    ts: new Float64Array(n),
    a0: new Float64Array(n),
    b0: new Float64Array(n),
    s0: new Float64Array(n),
    a1: new Float64Array(n),
    b1: new Float64Array(n),
    s1: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    w.ts[i] = start * 1000 + i * 1000;
    w.s0[i] = 1000;
    w.s1[i] = 1000;
    let a = 0.4;
    if (i >= 100) a = 0.28;
    if (i >= 110) a = 0.4;
    w.a0[i] = a;
    w.b0[i] = a - 0.01;
    w.a1[i] = Math.round((1.01 - a) * 100) / 100;
    w.b1[i] = w.a1[i] - 0.01;
  }
  const hit = simulatePanic(w, 30_000, 0.12, 0.06, 0.06);
  if (!hit || hit.reason !== "tp" || !(hit.pnl > 0)) {
    throw new Error("selftest panic failed " + JSON.stringify(hit));
  }
  w.a0.fill(0.3);
  w.b0.fill(0.29);
  w.a1.fill(0.78);
  w.b1.fill(0.77);
  for (let i = 50; i < 80; i++) {
    w.a0[i] = 0.4;
    w.b0[i] = 0.39;
    w.a1[i] = 0.7;
    w.b1[i] = 0.69;
  }
  const sumHit = simulateSum(w, 1.05, 0.06, 0.06);
  if (!sumHit) throw new Error("selftest sum missed entry");
  console.log("selftest_ok", "panicPnl", hit.pnl.toFixed(4), "sumReason", sumHit.reason);
}

function slugStart(slug) {
  const m = /^btc-updown-15m-(\d+)$/.exec(slug);
  if (!m) return null;
  return Number(m[1]);
}

function packWindow(slug, rows) {
  const start = slugStart(slug);
  if (start == null) return null;
  const startMs = start * 1000;
  const endMs = (start + WINDOW_SEC) * 1000;
  rows.sort((a, b) => a.ts - b.ts || a.o - b.o);
  const ts = [];
  const a0 = [];
  const b0 = [];
  const s0 = [];
  const a1 = [];
  const b1 = [];
  const s1 = [];
  let i = 0;
  while (i < rows.length) {
    const t = rows[i].ts;
    let r0 = null;
    let r1 = null;
    while (i < rows.length && rows[i].ts === t) {
      if (rows[i].o === 0) r0 = rows[i];
      else if (rows[i].o === 1) r1 = rows[i];
      i++;
    }
    if (t < startMs || t > endMs) continue;
    if (!r0 || !r1) continue;
    ts.push(t);
    a0.push(finite(r0.ask) ? r0.ask : Number.NaN);
    b0.push(finite(r0.bid) ? r0.bid : Number.NaN);
    s0.push(finite(r0.sz) ? r0.sz : Number.NaN);
    a1.push(finite(r1.ask) ? r1.ask : Number.NaN);
    b1.push(finite(r1.bid) ? r1.bid : Number.NaN);
    s1.push(finite(r1.sz) ? r1.sz : Number.NaN);
  }
  if (ts.length < MIN_TICKS) return null;
  let maxGap = 0;
  for (let k = 1; k < ts.length; k++) {
    const g = ts[k] - ts[k - 1];
    if (g > maxGap) maxGap = g;
  }
  if (maxGap > MAX_GAP_MS) return null;
  return {
    slug,
    start,
    endMs,
    maxGap,
    ticks: ts.length,
    ts: Float64Array.from(ts),
    a0: Float64Array.from(a0),
    b0: Float64Array.from(b0),
    s0: Float64Array.from(s0),
    a1: Float64Array.from(a1),
    b1: Float64Array.from(b1),
    s1: Float64Array.from(s1),
  };
}

function eachRow(stmt) {
  if (typeof stmt.iterate === "function") return stmt.iterate();
  return stmt.all();
}

function roundObj(v) {
  if (v == null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Math.round(v * 1e6) / 1e6;
  }
  if (Array.isArray(v)) return v.map(roundObj);
  if (typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "_agg" || k === "examples") continue;
      o[k] = roundObj(val);
    }
    return o;
  }
  return v;
}

function clears(hold) {
  return !!hold && hold.n >= 40 && hold.winRate >= 0.6 - 1e-12 && hold.pnl > 0;
}

function cellLine(label, m) {
  if (!m) return label + " n/a";
  const wr = (100 * m.winRate).toFixed(2);
  const aw = m.avgWin == null ? "n/a" : m.avgWin.toFixed(4);
  const al = m.avgLoss == null ? "n/a" : m.avgLoss.toFixed(4);
  return (
    label +
    " n=" + m.n +
    " WR=" + wr + "%" +
    " pnl=" + m.pnl.toFixed(4) +
    " pnlPer1=" + m.pnlPer1.toFixed(4) +
    " avgWin=" + aw +
    " avgLoss=" + al
  );
}

function main() {
  selftest();
  const root = process.cwd();
  const srcPath = path.resolve(root, "data", "bot-live.db");
  const work = path.resolve(root, "data", "_btc15-scalp-work.db");
  const outDir = path.resolve(root, "audits", "backtest", "btc15-scalp");
  mkdirSync(outDir, { recursive: true });
  for (const s of ["", "-wal", "-shm"]) {
    if (existsSync(work + s)) rmSync(work + s);
  }
  const t0 = Date.now();
  console.log("vacuum_into", work);
  const src = new DatabaseSync(srcPath, { readOnly: true });
  try {
    src.exec("PRAGMA busy_timeout = 30000");
    src.exec("VACUUM INTO '" + work.replaceAll("\\", "/") + "'");
  } finally {
    src.close();
  }
  console.log("vacuum_ms", Date.now() - t0);
  const db = new Database(work, { readonly: true, fileMustExist: true });
  let windows = [];
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    const spotish = tables.filter((n) => /chainlink|binance|spot|btc_price|price_feed/i.test(n));
    console.log("spot_tables", spotish.length ? spotish.join(",") : "none");
    const t1 = Date.now();
    const stmt = db.prepare(
      "SELECT eventSlug, ts, outcomeIndex, bestBid, bestAsk, bestAskSize FROM book_snapshots WHERE eventSlug LIKE 'btc-updown-15m-%'",
    );
    const packs = new Map();
    let nrows = 0;
    for (const row of stmt.iterate()) {
      nrows++;
      const slug = row.eventSlug;
      if (!slugStart(slug)) continue;
      let bucket = packs.get(slug);
      if (!bucket) {
        bucket = [];
        packs.set(slug, bucket);
      }
      bucket.push({
        ts: row.ts,
        o: row.outcomeIndex,
        bid: row.bestBid,
        ask: row.bestAsk,
        sz: row.bestAskSize,
      });
    }
    console.log("rows", nrows, "slugs", packs.size, "load_ms", Date.now() - t1);
    let rejected = 0;
    for (const [slug, rows] of packs) {
      const w = packWindow(slug, rows);
      if (!w) rejected++;
      else windows.push(w);
    }
    packs.clear();
    windows.sort((a, b) => a.start - b.start || (a.slug < b.slug ? -1 : 1));
    console.log("complete", windows.length, "rejected_or_incomplete", rejected);
    const trainN = Math.floor(windows.length * 0.6);
    const train = windows.slice(0, trainN);
    const hold = windows.slice(trainN);
    console.log(
      "split train",
      train.length,
      "holdout",
      hold.length,
      "trainStart",
      train[0] ? train[0].start : null,
      "holdStart",
      hold[0] ? hold[0].start : null,
      "last",
      windows.length ? windows[windows.length - 1].start : null,
    );

    const concepts = [];

    function finishConcept(id, plain, grid, sim, trainOnlyNote) {
      console.log("tuning", id, "cells", grid.length);
      const tA = Date.now();
      const trained = runCells(train, grid, sim);
      console.log("tuned_ms", id, Date.now() - tA);
      const choice = pick(trained);
      const top = [...trained]
        .filter((c) => c.n >= 40)
        .sort((a, b) => b.pnl - a.pnl)
        .slice(0, 8)
        .map((c) => roundObj({ params: c.params, n: c.n, winRate: c.winRate, pnl: c.pnl, pnlPer1: c.pnlPer1, avgWin: c.avgWin, avgLoss: c.avgLoss }));
      let holdout = null;
      let examples = [];
      if (choice.frozen && !trainOnlyNote) {
        const scored = scoreOne(hold, choice.frozen.params, sim);
        examples = scored.examples;
        holdout = roundObj(scored);
      }
      const trainView = choice.frozen ? roundObj(choice.frozen) : null;
      const row = {
        id,
        plain,
        selection: choice.rule,
        eligibleTrainCells: choice.eligible,
        frozen: choice.frozen ? choice.frozen.params : null,
        train: trainView,
        holdout,
        examples,
        clearsBar: clears(holdout),
        trainTop: top,
        skippedHoldout: trainOnlyNote || null,
      };
      concepts.push(row);
      console.log("FROZEN", id, JSON.stringify(row.frozen), choice.rule);
      console.log(cellLine("TRAIN " + id, trainView));
      console.log(cellLine("HOLDOUT " + id, holdout));
      console.log("CLEARS", id, row.clearsBar);
      return row.clearsBar;
    }

    const panicGrid = [];
    for (const D of PANIC_D) for (const L of PANIC_L) for (const T of PANIC_T) for (const S of PANIC_S) {
      panicGrid.push({ D, L, T, S, band: PANIC_BAND, holdSec: 120, maxSpread: MAX_SPREAD });
    }
    const panicSim = (w, p) => simulatePanic(w, p.L * 1000, p.D, p.T, p.S);
    let won = finishConcept(
      "panic-dip-bounce",
      "Buy the first side whose ask drops by D over L seconds and is still in [0.15,0.45]. Sell at bid when +T, -S, 120s, or window end.",
      panicGrid,
      panicSim,
      null,
    );

    if (!won) {
      const sumGrid = [];
      for (const th of SUM_TH) for (const T of SUM_T) for (const S of SUM_S) {
        sumGrid.push({ sumMin: th, T, S, band: SUM_BAND, sumExit: SUM_EXIT, holdSec: 90, maxSpread: MAX_SPREAD });
      }
      const sumSim = (w, p) => simulateSum(w, p.sumMin, p.T, p.S);
      won = finishConcept(
        "complement-sum-snapback",
        "When upAsk+downAsk >= threshold, buy the cheaper ask if it is in [0.20,0.48]. Exit when the sum falls under 1.02, or bid is +T / -S, or 90s, or window end.",
        sumGrid,
        sumSim,
        null,
      );
    }

    if (!won) {
      const depGrid = [];
      for (const T of DEP_T) for (const S of DEP_S) for (const ageSec of DEP_AGE) {
        depGrid.push({ T, S, ageSec, band: DEP_BAND, holdSec: 90, maxSpread: MAX_SPREAD });
      }
      const depSim = (w, p) => simulateDeposed(w, p.T, p.S, p.ageSec);
      won = finishConcept(
        "deposed-side-bounce",
        "After the higher-ask identity flips, buy the deposed ask while it is in [0.25,0.45] and the flip is still fresh. Scalp +T with a tight stop, max 90s. Not held to resolution.",
        depGrid,
        depSim,
        null,
      );
    }

    if (!won) {
      const favGrid = [];
      for (const D of FAV_D) for (const L of FAV_L) for (const T of FAV_T) for (const S of FAV_S) {
        favGrid.push({ D, L, T, S, band: FAV_BAND, holdSec: 90, maxSpread: MAX_SPREAD });
      }
      const favSim = (w, p) => simulateFavDip(w, p.L * 1000, p.D, p.T, p.S);
      finishConcept(
        "favorite-dip-scalp",
        "Literature add-on (no spot series in DB): buy the current favorite after its ask drops by D over L seconds, but only while it is still the favorite and in [0.55,0.80]. Scalp +T / -S / 90s. Not a longshot buy.",
        favGrid,
        favSim,
        null,
      );
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      stakeUsd: STAKE,
      maxSpread: MAX_SPREAD,
      completeness: {
        prefix: PREFIX,
        windowSec: WINDOW_SEC,
        minTicks: MIN_TICKS,
        maxGapMs: MAX_GAP_MS,
        edgeGapApplied: false,
        nComplete: windows.length,
        nTrain: train.length,
        nHoldout: hold.length,
        trainFirstStart: train[0] ? train[0].start : null,
        holdoutFirstStart: hold[0] ? hold[0].start : null,
        lastStart: windows.length ? windows[windows.length - 1].start : null,
      },
      fills: "taker buy at bestAsk, taker sell at bestBid; no mid fill; spread is the cost; no extra fee",
      spotSeriesInDb: false,
      literature:
        "No chainlink/binance/spot table, so spot-lead was not tested. Extra concept favorite-dip-scalp follows Cardozo & Rivero-Wildemauwe arXiv:2609.12878 (Polymarket favorite-longshot: sub-10c buys lose, >=90c buys earn) rather than buying the longshot dip. OpenMarket arXiv:2607.26245 reports 15m books usually one tick wide and no short-horizon alpha vs the mid.",
      concepts: concepts.map((c) => {
        const { examples, ...rest } = c;
        return { ...roundObj(rest), examples };
      }),
    };
    const outPath = path.join(outDir, "scan-results.json");
    writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log("wrote", outPath);
  } finally {
    db.close();
    for (const s of ["", "-wal", "-shm"]) {
      if (existsSync(work + s)) rmSync(work + s);
    }
    console.log("temp_db_deleted", work);
  }
}

main();
