/**
 * Last pass: elapsed slices of the best confirmed bounce, then second-dip only.
 * Holdout is scored once, and only if a train cell has n>=40, WR>0.60, pnl>0.
 * Run from repo root: npx tsx scripts/research/btc15-scalp/run-bounce-slices.mts
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
const BIN_LABELS = ["0-3min", "3-6min", "6-9min", "9-12min", "12-15min"];

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
  return side === 0 ? { ask: w.a0, bid: w.b0, sz: w.s0 } : { ask: w.a1, bid: w.b1, sz: w.s1 };
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
function binOf(elapsed) {
  if (elapsed < 0) return -1;
  const b = Math.floor(elapsed / 180);
  return b >= 5 ? 4 : b;
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
    if (bid <= ask - S + 1e-12) return finish(size, ask, bid, "sl");
    if (bid >= ask + T - 1e-12) return finish(size, ask, bid, "tp");
    if (timed) return finish(size, ask, bid, "time");
    if (ended) return finish(size, ask, bid, "end");
    last = bid;
  }
  return finish(size, ask, finite(last) ? last : 0, "end");
}
function finish(size, ask, exitBid, reason) {
  const pnl = size * (exitBid - ask);
  return { pnl, pnlPer1: (exitBid - ask) / ask, reason, exitBid };
}
function dipShape(book, ts, i, Lms, D) {
  const ask = book.ask[i];
  const j = refIndex(ts, i, Lms);
  if (j < 0 || !finite(book.ask[j]) || !finite(ask)) return null;
  let low = Number.POSITIVE_INFINITY;
  let lowK = -1;
  for (let k = j + 1; k <= i; k++) {
    if (finite(book.ask[k]) && book.ask[k] < low) {
      low = book.ask[k];
      lowK = k;
    }
  }
  if (lowK < 0) return null;
  return { ask, low, lowK, drop: book.ask[j] - low >= D - 1e-12 };
}
function signalBounce(w, D, Lsec) {
  const Lms = Lsec * 1000;
  for (let i = 0; i < w.ts.length; i++) {
    const cands = [];
    for (const side of [0, 1]) {
      const book = sideBook(w, side);
      const shape = dipShape(book, w.ts, i, Lms, D);
      if (!shape || !shape.drop || shape.lowK === i) continue;
      if (shape.low < 0.15 || shape.low > 0.4) continue;
      if (shape.ask < shape.low + 0.02 - 1e-12) continue;
      if (shape.ask > 0.45) continue;
      const size = canBuy(shape.ask, book.bid[i], book.sz[i]);
      if (size == null) continue;
      cands.push({ i, side, ask: shape.ask, size, score: shape.ask - shape.low });
    }
    if (cands.length) {
      cands.sort((a, b) => a.ask - b.ask || b.score - a.score);
      const sig = cands[0];
      const elapsed = w.ts[sig.i] / 1000 - w.start;
      return { ...sig, elapsed, bin: binOf(elapsed) };
    }
  }
  return null;
}
function signalSecondDip(w) {
  const st = [
    { dipCount: 0, inDip: false, armed: true },
    { dipCount: 0, inDip: false, armed: true },
  ];
  for (let i = 0; i < w.ts.length; i++) {
    const cands = [];
    for (const side of [0, 1]) {
      const book = sideBook(w, side);
      const s = st[side];
      if (s.dipCount > 2) continue;
      const shape = dipShape(book, w.ts, i, 30_000, 0.1);
      const drop = !!shape && shape.drop;
      if (!drop) {
        s.inDip = false;
        s.armed = true;
        continue;
      }
      if (!s.armed) continue;
      if (!s.inDip) {
        s.dipCount++;
        s.inDip = true;
      }
      if (!shape || shape.lowK === i) continue;
      const lifted = shape.ask >= shape.low + 0.02 - 1e-12;
      if (!lifted) continue;
      if (s.dipCount === 1) {
        s.inDip = false;
        s.armed = false;
        continue;
      }
      if (s.dipCount !== 2) continue;
      if (shape.low < 0.15 || shape.low > 0.4 || shape.ask > 0.45) {
        s.inDip = false;
        s.armed = false;
        s.dipCount = 99;
        continue;
      }
      const size = canBuy(shape.ask, book.bid[i], book.sz[i]);
      if (size == null) continue;
      cands.push({ i, side, ask: shape.ask, size, score: shape.ask - shape.low });
    }
    if (cands.length) {
      cands.sort((a, b) => a.ask - b.ask || b.score - a.score);
      const sig = cands[0];
      const elapsed = w.ts[sig.i] / 1000 - w.start;
      return { ...sig, elapsed, bin: binOf(elapsed) };
    }
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
function score(windows, signalFn, T, S, binFilter) {
  const agg = blank();
  for (const w of windows) {
    const sig = signalFn(w);
    if (!sig) continue;
    if (binFilter != null && sig.bin !== binFilter) continue;
    const ex = roundTrip(w, sig.side, sig.i, sig.ask, sig.size, T, S, 120_000);
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
    slug, start, endMs,
    ts: Float64Array.from(ts),
    a0: Float64Array.from(a0), b0: Float64Array.from(b0), s0: Float64Array.from(s0),
    a1: Float64Array.from(a1), b1: Float64Array.from(b1), s1: Float64Array.from(s1),
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
  return label + " n=" + m.n + " WR=" + (m.n ? m.winRate.toFixed(6) : "na") + " pnl=" + m.pnl.toFixed(4);
}
function cellClears(m) {
  return !!m && m.n >= 40 && m.winRate > 0.6 && m.pnl > 0;
}

function main() {
  const root = process.cwd();
  const work = path.resolve(root, "data", "_btc15-slice-work.db");
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
    const stmt = db.prepare("SELECT eventSlug, ts, outcomeIndex, bestBid, bestAsk, bestAskSize FROM book_snapshots WHERE eventSlug LIKE 'btc-updown-15m-%'");
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
      throw new Error("split mismatch");
    }
    console.log("split_ok");

    const bounce = (w) => signalBounce(w, 0.12, 45);
    const replay = score(train, bounce, 0.05, 0.08, null);
    console.log(line("REPLAY", replay));
    if (replay.n !== 720 || replay.wins !== 361) {
      throw new Error("replay does not match frozen cell n=720 wins=361, got " + replay.n + " " + replay.wins);
    }

    const bins = [];
    for (let b = 0; b < 5; b++) {
      const scored = score(train, bounce, 0.05, 0.08, b);
      const row = { id: "elapsed-slice", params: { bin: BIN_LABELS[b], D: 0.12, L: 45, lift: 0.02, T: 0.05, S: 0.08, holdSec: 120 }, ...scored };
      bins.push(row);
      console.log(line("BIN " + BIN_LABELS[b], scored));
    }
    const sumN = bins.reduce((s, r) => s + r.n, 0);
    if (sumN !== replay.n) throw new Error("bin sum " + sumN + " != replay " + replay.n);

    const cells = [...bins];
    const hotBins = bins.filter((r) => r.n >= 40 && r.winRate > 0.6);
    console.log("hot_bins", hotBins.map((r) => r.params.bin).join(",") || "none");
    for (const hot of hotBins) {
      const b = BIN_LABELS.indexOf(hot.params.bin);
      for (const T of [0.04, 0.05, 0.08]) {
        for (const S of [0.05, 0.08]) {
          const scored = score(train, bounce, T, S, b);
          const row = { id: "elapsed-slice-grid", params: { bin: hot.params.bin, D: 0.12, L: 45, lift: 0.02, T, S, holdSec: 120 }, ...scored };
          cells.push(row);
          console.log(line("GRID " + hot.params.bin + " T=" + T + " S=" + S, scored));
        }
      }
    }

    for (const T of [0.04, 0.06]) {
      for (const S of [0.06, 0.1]) {
        const scored = score(train, signalSecondDip, T, S, null);
        const row = { id: "second-dip", params: { drop: 0.1, L: 30, whichDip: 2, lowBand: [0.15, 0.4], lift: 0.02, T, S, holdSec: 120 }, ...scored };
        cells.push(row);
        console.log(line("SECOND T=" + T + " S=" + S, scored));
      }
    }

    const withN = cells.filter((c) => c.n >= 40);
    const ceiling = [...withN].sort((a, b) => b.winRate - a.winRate || b.pnl - a.pnl || b.n - a.n)[0] || null;
    const qualified = withN.filter((c) => c.winRate > 0.6 && c.pnl > 0);
    qualified.sort((a, b) => b.pnl - a.pnl || b.n - a.n);
    let frozen = null;
    let holdout = null;
    if (!qualified.length) {
      console.log("TRAIN_GATE_FAIL holdout not scored");
    } else {
      const q = qualified[0];
      frozen = { id: q.id, params: q.params };
      console.log("FROZEN", JSON.stringify(frozen));
      const fn = q.id === "second-dip" ? signalSecondDip : bounce;
      const binFilter = q.id === "second-dip" ? null : BIN_LABELS.indexOf(q.params.bin);
      holdout = score(hold, fn, q.params.T, q.params.S, binFilter);
      console.log(line("HOLDOUT", holdout));
    }
    const clears = cellClears(holdout);
    console.log("CLEARS", clears);
    if (ceiling) console.log(line("CEILING", ceiling), ceiling.id, JSON.stringify(ceiling.params));

    const payload = {
      generatedAt: new Date().toISOString(),
      split: { nTrain: 763, nHoldout: 509, trainFirstStart: TRAIN_FIRST, holdoutFirstStart: HOLD_FIRST },
      replayFrozenRule: { note: "Same confirmed bounce as bounce-results best train cell, all elapsed.", ...replay },
      elapsedBins: bins,
      hotBinsTried: hotBins.map((r) => r.params.bin),
      secondDip:
        "Second time a token's ask is down 0.10 over 30s, after the prior dip has lifted 0.02 or the drop condition has gone false. Enter only that second dip, and only once ask lifts 0.02 off a low in [0.15, 0.40], entry ask <= 0.45.",
      cells,
      ceilingTrainN40: ceiling,
      frozen,
      train: qualified[0] || null,
      holdout,
      clearsBar: clears,
    };
    const outPath = path.join(outDir, "bounce-slices.json");
    writeFileSync(outPath, JSON.stringify(roundObj(payload), null, 2));
    console.log("wrote", outPath);
  } finally {
    db.close();
    for (const s of ["", "-wal", "-shm"]) if (existsSync(work + s)) rmSync(work + s);
    console.log("temp_db_deleted");
  }
}

main();
