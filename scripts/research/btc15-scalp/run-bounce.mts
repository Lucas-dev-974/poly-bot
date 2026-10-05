/**
 * Buy-low sell-higher bounce search. Resolution does not count as a win.
 * Same 1272 windows, train 763 / holdout 509. Holdout only if a train cell
 * has n>=40, win rate > 0.60, and pnl > 0.
 *
 * Run from repo root: npx tsx scripts/research/btc15-scalp/run-bounce.mts
 */
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const STAKE = 4;
const MIN_SHARES = 5;
const MAX_SPREAD = 0.1;
const MIN_TICKS = 601;
const MAX_GAP_MS = 60_000;
const WINDOW_SEC = 900;
const EPS = 1e-6;
const SLACK_MS = 2_000;
const LAST_START = 1791088200;
const TRAIN_FIRST = 1788848100;
const HOLD_FIRST = 1789794900;

function finite(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function computeSize(usdc, price) {
  const px = Math.max(price, 0.01);
  const size = Math.floor((usdc / px) * 100) / 100;
  if (size < MIN_SHARES) return null;
  return size;
}

function refIndex(ts, i, Lms) {
  const target = ts[i] - Lms;
  let lo = 0;
  let hi = i - 1;
  let j = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= target) {
      j = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (j < 0) return -1;
  if (target - ts[j] > SLACK_MS) return -1;
  return j;
}

function sideBook(w, side) {
  return side === 0
    ? { ask: w.a0, bid: w.b0, sz: w.s0 }
    : { ask: w.a1, bid: w.b1, sz: w.s1 };
}

function canBuy(ask, bid, sz) {
  if (!finite(ask) || !finite(bid) || ask <= 0 || ask > 0.45) return null;
  const spread = ask - bid;
  if (!(spread > 0) || spread > MAX_SPREAD) return null;
  const size = computeSize(STAKE, ask);
  if (size == null) return null;
  if (finite(sz) && sz + 1e-9 < size) return null;
  return size;
}

function roundTrip(w, side, i, ask, size, T, S, holdMs) {
  const bids = side === 0 ? w.b0 : w.b1;
  const deadline = w.ts[i] + holdMs;
  let last = Number.NaN;
  let reason = "end";
  let exitBid = 0;
  for (let k = i + 1; k < w.ts.length; k++) {
    const bid = bids[k];
    if (finite(bid)) last = bid;
    const ended = w.ts[k] >= w.endMs;
    const timed = w.ts[k] >= deadline;
    if (!finite(bid)) {
      if (ended || timed) break;
      continue;
    }
    if (bid <= ask - S + 1e-12) {
      reason = "sl";
      exitBid = bid;
      break;
    }
    if (bid >= ask + T - 1e-12) {
      reason = "tp";
      exitBid = bid;
      break;
    }
    if (timed) {
      reason = "time";
      exitBid = bid;
      break;
    }
    if (ended) {
      reason = "end";
      exitBid = bid;
      break;
    }
    reason = "end";
    exitBid = bid;
  }
  if (!finite(exitBid) || (reason === "end" && exitBid === 0 && finite(last))) exitBid = finite(last) ? last : 0;
  const pnl = size * (exitBid - ask);
  return { pnl, pnlPer1: (exitBid - ask) / ask, reason, exitBid };
}

function barrier(ts, bids, i, entryAsk, T, S, endMs) {
  const limit = ts[i] + 120_000;
  for (let k = i + 1; k < ts.length; k++) {
    if (ts[k] > limit) break;
    const bid = bids[k];
    if (!finite(bid)) {
      if (ts[k] >= endMs) return "none";
      continue;
    }
    const stop = bid <= entryAsk - S + 1e-12;
    const tp = bid >= entryAsk + T - 1e-12;
    if (stop) return "stop";
    if (tp) return "tp";
    if (ts[k] >= endMs) return "none";
  }
  return "none";
}

function diagnose(train) {
  const specs = [
    { T: 0.08, S: 0.08 },
    { T: 0.06, S: 0.06 },
    { T: 0.1, S: 0.08 },
  ];
  const hits = specs.map(() => ({ tp: 0, stop: 0, none: 0 }));
  let n = 0;
  for (const w of train) {
    for (const side of [0, 1]) {
      const book = sideBook(w, side);
      let i0 = -1;
      for (let i = 0; i < w.ts.length; i++) {
        const ask = book.ask[i];
        if (finite(ask) && ask >= 0.2 - 1e-12 && ask <= 0.35 + 1e-12) {
          i0 = i;
          break;
        }
      }
      if (i0 < 0) continue;
      n++;
      const entryAsk = book.ask[i0];
      for (let s = 0; s < specs.length; s++) {
        const outcome = barrier(w.ts, book.bid, i0, entryAsk, specs[s].T, specs[s].S, w.endMs);
        hits[s][outcome]++;
      }
    }
  }
  return {
    definition: "First tick each token ask is inside [0.20, 0.35]. Success = bid touches entryAsk+T before entryAsk-S within 120s. Same-tick stop wins the tie. Neither or window end = failure. Not a strategy.",
    n,
    barriers: specs.map((spec, s) => ({
      T: spec.T,
      S: spec.S,
      tpBeforeStop: hits[s].tp,
      stopFirst: hits[s].stop,
      neither: hits[s].none,
      p: n ? hits[s].tp / n : 0,
    })),
  };
}

function pickSide(cands) {
  if (!cands.length) return null;
  cands.sort((a, b) => a.ask - b.ask || b.score - a.score);
  return cands[0];
}

function signalBounce(w, D, Lsec) {
  const Lms = Lsec * 1000;
  const cands = [];
  for (let i = 0; i < w.ts.length; i++) {
    for (const side of [0, 1]) {
      const book = sideBook(w, side);
      const ask = book.ask[i];
      const j = refIndex(w.ts, i, Lms);
      if (j < 0 || !finite(book.ask[j]) || !finite(ask)) continue;
      let low = Number.POSITIVE_INFINITY;
      let lowK = -1;
      for (let k = j + 1; k <= i; k++) {
        if (finite(book.ask[k]) && book.ask[k] < low) {
          low = book.ask[k];
          lowK = k;
        }
      }
      if (lowK < 0 || lowK === i) continue;
      if (book.ask[j] - low < D - 1e-12) continue;
      if (low < 0.15 || low > 0.4) continue;
      if (ask < low + 0.02 - 1e-12) continue;
      if (ask > 0.45) continue;
      const size = canBuy(ask, book.bid[i], book.sz[i]);
      if (size == null) continue;
      cands.push({ i, side, ask, size, score: ask - low });
    }
    if (cands.length) return pickSide(cands);
  }
  return null;
}

function signalSupported(w) {
  const cands = [];
  for (let i = 0; i < w.ts.length; i++) {
    for (const side of [0, 1]) {
      const book = sideBook(w, side);
      const ask = book.ask[i];
      const bid = book.bid[i];
      const j = refIndex(w.ts, i, 30_000);
      if (j < 0 || !finite(book.ask[j]) || !finite(book.bid[j]) || !finite(ask) || !finite(bid)) continue;
      if (book.ask[j] - ask < 0.1 - 1e-12) continue;
      if (bid < book.bid[j] - 0.03 - 1e-12) continue;
      if (ask < 0.18 || ask > 0.4) continue;
      const size = canBuy(ask, bid, book.sz[i]);
      if (size == null) continue;
      cands.push({ i, side, ask, size, score: book.ask[j] - ask });
    }
    if (cands.length) return pickSide(cands);
  }
  return null;
}

function signalBreakout(w) {
  const cands = [];
  for (let i = 0; i < w.ts.length; i++) {
    for (const side of [0, 1]) {
      const book = sideBook(w, side);
      const ask = book.ask[i];
      if (!finite(ask) || ask <= 0.35 || ask > 0.42) continue;
      const t = w.ts[i];
      let maxPrior = Number.NEGATIVE_INFINITY;
      let covered20 = false;
      let bad20 = false;
      for (let k = i - 1; k >= 0; k--) {
        const age = t - w.ts[k];
        if (age > 30_000) break;
        if (finite(book.ask[k]) && book.ask[k] > maxPrior) maxPrior = book.ask[k];
        if (age <= 20_000) {
          if (!finite(book.ask[k]) || book.ask[k] > 0.35 + 1e-12) bad20 = true;
        }
        if (age >= 20_000) covered20 = true;
      }
      if (!covered20 || bad20) continue;
      if (!(ask > maxPrior + 1e-12)) continue;
      const size = canBuy(ask, book.bid[i], book.sz[i]);
      if (size == null) continue;
      cands.push({ i, side, ask, size, score: ask - maxPrior });
    }
    if (cands.length) return pickSide(cands);
  }
  return null;
}

function blank() {
  return { n: 0, wins: 0, losses: 0, pnl: 0, pnlPer1: 0, winSum: 0, lossSum: 0, reasons: {} };
}

function add(agg, pnl, pnlPer1, reason) {
  agg.n++;
  agg.pnl += pnl;
  agg.pnlPer1 += pnlPer1;
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
    pnlPer1: agg.pnlPer1,
    avgWin: agg.wins ? agg.winSum / agg.wins : null,
    avgLoss: agg.losses ? agg.lossSum / agg.losses : null,
    exitReasons: agg.reasons,
  };
}

function score(windows, signalFn, T, S, holdSec) {
  const agg = blank();
  for (const w of windows) {
    const sig = signalFn(w);
    if (!sig) continue;
    const ex = roundTrip(w, sig.side, sig.i, sig.ask, sig.size, T, S, holdSec * 1000);
    add(agg, ex.pnl, ex.pnlPer1, ex.reason);
  }
  return view(agg);
}

function slugStart(slug) {
  const m = /^btc-updown-15m-(\d+)$/.exec(slug);
  return m ? Number(m[1]) : null;
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
  for (let k = 1; k < ts.length; k++) if (ts[k] - ts[k - 1] > maxGap) maxGap = ts[k] - ts[k - 1];
  if (maxGap > MAX_GAP_MS) return null;
  return {
    slug,
    start,
    endMs,
    ts: Float64Array.from(ts),
    a0: Float64Array.from(a0),
    b0: Float64Array.from(b0),
    s0: Float64Array.from(s0),
    a1: Float64Array.from(a1),
    b1: Float64Array.from(b1),
    s1: Float64Array.from(s1),
  };
}

function roundObj(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null;
  if (Array.isArray(v)) return v.map(roundObj);
  if (typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = roundObj(val);
    return o;
  }
  return v;
}

function line(label, m) {
  if (!m) return label + " not_scored";
  return (
    label +
    " n=" + m.n +
    " WR=" + (100 * m.winRate).toFixed(2) + "%" +
    " pnl=" + m.pnl.toFixed(4) +
    " pnlPer1=" + m.pnlPer1.toFixed(4) +
    " avgWin=" + (m.avgWin == null ? "n/a" : m.avgWin.toFixed(4)) +
    " avgLoss=" + (m.avgLoss == null ? "n/a" : m.avgLoss.toFixed(4))
  );
}

function selftest() {
  if (computeSize(4, 0.4) !== 10) throw new Error("size");
  if (computeSize(4, 0.85) !== null) throw new Error("min shares");
  const n = 80;
  const start = 1_700_000_000;
  const w = {
    slug: "btc-updown-15m-1700000000",
    start,
    endMs: (start + 900) * 1000,
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
    if (i >= 45 && i < 50) a = 0.25;
    if (i >= 50) a = 0.4;
    w.a0[i] = a;
    w.b0[i] = i >= 55 ? 0.46 : a - 0.01;
    w.a1[i] = 0.62;
    w.b1[i] = 0.61;
  }
  const sig = signalBounce(w, 0.12, 45);
  if (!sig || sig.side !== 0 || Math.abs(sig.ask - 0.4) > 1e-9) throw new Error("bounce signal " + JSON.stringify(sig));
  const ex = roundTrip(w, sig.side, sig.i, sig.ask, sig.size, 0.05, 0.04, 120000);
  if (ex.reason !== "tp" || !(ex.pnl > 0)) throw new Error("bounce exit " + JSON.stringify(ex));
  const out = barrier(w.ts, w.b0, 10, w.a0[10], 0.08, 0.08, w.endMs);
  if (out === "tp") throw new Error("barrier should not tp from flat 0.40");
  console.log("selftest_ok", "entryAsk", sig.ask, "pnl", ex.pnl.toFixed(4));
}

function main() {
  selftest();
  const root = process.cwd();
  const work = path.resolve(root, "data", "_btc15-bounce-work.db");
  const outDir = path.resolve(root, "audits", "backtest", "btc15-scalp");
  mkdirSync(outDir, { recursive: true });
  for (const s of ["", "-wal", "-shm"]) if (existsSync(work + s)) rmSync(work + s);
  const src = new DatabaseSync(path.resolve(root, "data", "bot-live.db"), { readOnly: true });
  const t0 = Date.now();
  try {
    src.exec("PRAGMA busy_timeout = 30000");
    src.exec("VACUUM INTO '" + work.replaceAll("\\", "/") + "'");
  } finally {
    src.close();
  }
  console.log("vacuum_ms", Date.now() - t0);
  const db = new Database(work, { readonly: true, fileMustExist: true });
  try {
    const packs = new Map();
    const stmt = db.prepare(
      "SELECT eventSlug, ts, outcomeIndex, bestBid, bestAsk, bestAskSize FROM book_snapshots WHERE eventSlug LIKE 'btc-updown-15m-%'",
    );
    let nrows = 0;
    for (const row of stmt.iterate()) {
      nrows++;
      if (!slugStart(row.eventSlug)) continue;
      let bucket = packs.get(row.eventSlug);
      if (!bucket) packs.set(row.eventSlug, (bucket = []));
      bucket.push({ ts: row.ts, o: row.outcomeIndex, bid: row.bestBid, ask: row.bestAsk, sz: row.bestAskSize });
    }
    console.log("rows", nrows, "slugs", packs.size);
    const windows = [];
    for (const [slug, rows] of packs) {
      const w = packWindow(slug, rows);
      if (!w || w.start > LAST_START) continue;
      windows.push(w);
    }
    packs.clear();
    windows.sort((a, b) => a.start - b.start || (a.slug < b.slug ? -1 : 1));
    if (windows.length !== 1272) throw new Error("expected 1272 got " + windows.length);
    const train = windows.slice(0, 763);
    const hold = windows.slice(763);
    if (train[0].start !== TRAIN_FIRST || hold[0].start !== HOLD_FIRST || hold.length !== 509) {
      throw new Error("split mismatch " + train[0].start + " " + hold[0].start + " " + hold.length);
    }
    if (windows[windows.length - 1].start !== LAST_START) throw new Error("last " + windows[windows.length - 1].start);
    console.log("split_ok", train.length, hold.length);

    const diagnostic = diagnose(train);
    for (const b of diagnostic.barriers) {
      console.log("BASE", "T", b.T, "S", b.S, "n", diagnostic.n, "p", b.p.toFixed(4), "tp", b.tpBeforeStop, "stop", b.stopFirst, "none", b.neither);
    }

    const jobs = [];
    for (const D of [0.08, 0.12]) {
      for (const L of [20, 45]) {
        for (const T of [0.05, 0.08]) {
          for (const S of [0.04, 0.08]) {
            jobs.push({
              id: "confirmed-bounce",
              params: { D, L, T, S, holdSec: 120, lowBand: [0.15, 0.4], lift: 0.02, entryAskMax: 0.45 },
              signal: (w) => signalBounce(w, D, L),
              T,
              S,
              holdSec: 120,
            });
          }
        }
      }
    }
    for (const T of [0.06, 0.08]) {
      jobs.push({
        id: "supported-dip",
        params: { drop: 0.1, L: 30, bidDropMax: 0.03, band: [0.18, 0.4], T, S: 0.05, holdSec: 90 },
        signal: signalSupported,
        T,
        S: 0.05,
        holdSec: 90,
      });
    }
    for (const T of [0.05, 0.08]) {
      jobs.push({
        id: "micro-breakout",
        params: { ceil: 0.35, holdUnderSec: 20, highSec: 30, entryAskMax: 0.42, T, S: 0.05, holdSec: 90 },
        signal: signalBreakout,
        T,
        S: 0.05,
        holdSec: 90,
      });
    }

    const trainCells = [];
    for (const job of jobs) {
      const tA = Date.now();
      const scored = score(train, job.signal, job.T, job.S, job.holdSec);
      trainCells.push({ id: job.id, params: job.params, ...scored, _job: job });
      console.log(line("TRAIN " + job.id + " " + JSON.stringify(job.params), scored), "ms", Date.now() - tA);
    }

    const withN = trainCells.filter((c) => c.n >= 40);
    const bestByWr = [...withN].sort((a, b) => b.winRate - a.winRate || b.pnl - a.pnl || b.n - a.n)[0] || null;
    const qualified = withN.filter((c) => c.winRate > 0.6 && c.pnl > 0);
    qualified.sort((a, b) => b.pnl - a.pnl || b.n - a.n);
    let frozen = null;
    let holdout = null;
    if (!qualified.length) {
      console.log("TRAIN_GATE_FAIL no cell with n>=40, WR>0.60 and pnl>0. Holdout not scored.");
    } else {
      const q = qualified[0];
      frozen = { id: q.id, params: q.params };
      console.log("FROZEN", JSON.stringify(frozen));
      holdout = score(hold, q._job.signal, q._job.T, q._job.S, q._job.holdSec);
      console.log(line("HOLDOUT", holdout));
    }
    const clears = !!holdout && holdout.n >= 40 && holdout.winRate > 0.6 && holdout.pnl > 0;
    console.log("CLEARS", clears);

    const strip = (c) => {
      if (!c) return null;
      const { _job, ...rest } = c;
      return rest;
    };
    const payload = {
      generatedAt: new Date().toISOString(),
      stakeUsd: STAKE,
      shareSizing: "floor(stake/price*100)/100 shares, minimum 5, skip if bestAskSize is known and smaller. Spread must be in (0, 0.10].",
      winDefinition: "Engine pnl = shares * (exitBid - entryAsk) > 0. Resolution is not a win. Scratch is not a win. Target only if bid >= entryAsk+T. Stop if bid <= entryAsk-S. Otherwise mark at bid on time stop or window end.",
      split: {
        nComplete: 1272,
        nTrain: 763,
        nHoldout: 509,
        trainFirstStart: train[0].start,
        holdoutFirstStart: hold[0].start,
        lastStart: windows[windows.length - 1].start,
      },
      diagnostic,
      trainCells: trainCells.map(strip),
      bestTrainByWinRateN40: strip(bestByWr),
      frozen,
      train: frozen ? strip(qualified[0]) : null,
      holdout,
      clearsBar: clears,
    };
    const outPath = path.join(outDir, "bounce-results.json");
    writeFileSync(outPath, JSON.stringify(roundObj(payload), null, 2));
    console.log("wrote", outPath);
  } finally {
    db.close();
    for (const s of ["", "-wal", "-shm"]) if (existsSync(work + s)) rmSync(work + s);
    console.log("temp_db_deleted");
  }
}

main();
