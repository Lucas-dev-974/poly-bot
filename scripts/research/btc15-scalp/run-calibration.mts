/**
 * Calibration entry + optional touch-fill bounce.
 * Same 1272 complete btc-updown-15m windows as run-scan (cutoff start <= 1791088200).
 * Train = first 763, holdout = last 509. Fair table is train-only.
 * Holdout is scored only after the train gate for that concept passes.
 *
 * Run from repo root: npx tsx scripts/research/btc15-scalp/run-calibration.mts
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
const LOOKBACK_SLACK_MS = 2_000;
const LAST_START = 1791088200;
const TRAIN_FIRST = 1788848100;
const HOLD_FIRST = 1789794900;
const MARGINS = [0.03, 0.05, 0.08];

function finite(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function computeSize(usdc, price) {
  const px = Math.max(price, 0.01);
  const size = Math.floor((usdc / px) * 100) / 100;
  if (size < MIN_SHARES) return null;
  return size;
}

function centsOf(ask) {
  return Math.round(ask * 100);
}

function askBinOf(ask) {
  return Math.floor(centsOf(ask) / 5);
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
    if (c >= 0 && c < i && target - ts[c] <= LOOKBACK_SLACK_MS && finite(ask[c])) ref[i] = ask[c];
  }
  return ref;
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

function holdPnl(size, ask, won) {
  const cost = size * ask;
  const pnl = won ? size - cost : -cost;
  const pnlPer1 = won ? 1 / ask - 1 : -1;
  return { pnl, pnlPer1 };
}

function tradePnl(size, entry, exitBid) {
  const pnl = size * (exitBid - entry);
  const pnlPer1 = (exitBid - entry) / entry;
  return { pnl, pnlPer1 };
}

function exitAtBid(w, side, entryI, entryPx, targetPx, stopDist, holdMs) {
  const bids = side === 0 ? w.b0 : w.b1;
  const deadline = holdMs == null ? Number.POSITIVE_INFINITY : w.ts[entryI] + holdMs;
  let lastBid = Number.NaN;
  for (let k = entryI + 1; k < w.ts.length; k++) {
    const bid = bids[k];
    if (finite(bid)) lastBid = bid;
    const ended = w.ts[k] >= w.endMs;
    if (!finite(bid)) {
      if (ended) break;
      continue;
    }
    if (stopDist != null && bid <= entryPx - stopDist + 1e-12) return { bid, reason: "sl" };
    if (targetPx != null && bid >= targetPx - 1e-12) return { bid, reason: "tp" };
    if (w.ts[k] >= deadline) return { bid, reason: "time" };
    if (ended) return { bid, reason: "end" };
  }
  if (finite(lastBid)) return { bid: lastBid, reason: "end" };
  return { bid: 0, reason: "nobid" };
}

function buildTable(train) {
  const table = new Map();
  let samples = 0;
  let skippedNoRes = 0;
  for (const w of train) {
    if (w.winner !== 0 && w.winner !== 1) {
      skippedNoRes++;
      continue;
    }
    let last0 = -1;
    let last1 = -1;
    for (let i = 0; i < w.ts.length; i++) {
      const elapsed = w.ts[i] / 1000 - w.start;
      if (elapsed < 0 || elapsed > WINDOW_SEC) continue;
      const sBin = Math.floor(elapsed / 30);
      const eBin = Math.floor(elapsed / 60);
      for (const side of [0, 1]) {
        if (side === 0 ? sBin === last0 : sBin === last1) continue;
        const ask = side === 0 ? w.a0[i] : w.a1[i];
        if (!finite(ask) || ask <= 0 || ask > 1) continue;
        if (side === 0) last0 = sBin;
        else last1 = sBin;
        const aBin = askBinOf(ask);
        const key = eBin + ":" + aBin;
        let cell = table.get(key);
        if (!cell) table.set(key, (cell = { eBin, aBin, askLo: aBin * 0.05, n: 0, wins: 0 }));
        cell.n++;
        samples++;
        if (w.winner === side) cell.wins++;
      }
    }
  }
  const kept = [];
  for (const cell of table.values()) {
    if (cell.n < 80) continue;
    cell.fair = cell.wins / cell.n;
    kept.push(cell);
  }
  const fair = new Map();
  for (const cell of kept) fair.set(cell.eBin + ":" + cell.aBin, cell);
  return { fair, kept, samples, skippedNoRes, rawCells: table.size };
}

function entryAt(w, i, side, fairMap, margin) {
  const ask = side === 0 ? w.a0[i] : w.a1[i];
  const bid = side === 0 ? w.b0[i] : w.b1[i];
  const sz = side === 0 ? w.s0[i] : w.s1[i];
  if (!finite(ask) || !finite(bid) || ask <= 0 || ask > 1) return null;
  const spread = ask - bid;
  if (!(spread > 0) || spread > MAX_SPREAD) return null;
  const elapsed = w.ts[i] / 1000 - w.start;
  if (elapsed < 0 || elapsed > WINDOW_SEC) return null;
  const key = Math.floor(elapsed / 60) + ":" + askBinOf(ask);
  const cell = fairMap.get(key);
  if (!cell || !(cell.fair >= 0.6)) return null;
  if (ask > cell.fair - margin + 1e-12) return null;
  const size = computeSize(STAKE, ask);
  if (size == null) return null;
  if (finite(sz) && sz + 1e-9 < size) return null;
  return { side, ask, size, fair: cell.fair, eBin: cell.eBin, aBin: cell.aBin, edge: cell.fair - ask };
}

function firstEntry(w, fairMap, margin) {
  for (let i = 0; i < w.ts.length; i++) {
    const a = entryAt(w, i, 0, fairMap, margin);
    const b = entryAt(w, i, 1, fairMap, margin);
    if (!a && !b) continue;
    if (a && b) return { i, pick: a.edge > b.edge + 1e-12 ? a : b.edge > a.edge + 1e-12 ? b : a.ask <= b.ask ? a : b };
    return { i, pick: a || b };
  }
  return null;
}

function scoreWindows(windows, fairMap, margin, exitMode) {
  const agg = blank();
  const examples = [];
  let noResolution = 0;
  for (const w of windows) {
    const hit = firstEntry(w, fairMap, margin);
    if (!hit) continue;
    const { i, pick } = hit;
    if (exitMode === "hold") {
      if (w.winner !== 0 && w.winner !== 1) {
        noResolution++;
        continue;
      }
      const won = w.winner === pick.side;
      const p = holdPnl(pick.size, pick.ask, won);
      add(agg, p.pnl, p.pnlPer1, won ? "resolve_win" : "resolve_loss");
      if (examples.length < 5) {
        examples.push({ slug: w.slug, side: pick.side, entryAsk: pick.ask, fair: pick.fair, size: pick.size, pnl: p.pnl, pnlPer1: p.pnlPer1, reason: won ? "resolve_win" : "resolve_loss" });
      }
    } else {
      const ex = exitAtBid(w, pick.side, i, pick.ask, pick.fair, 0.08, null);
      const p = tradePnl(pick.size, pick.ask, ex.bid);
      add(agg, p.pnl, p.pnlPer1, ex.reason);
      if (examples.length < 5) {
        examples.push({ slug: w.slug, side: pick.side, entryAsk: pick.ask, fair: pick.fair, exitBid: ex.bid, size: pick.size, pnl: p.pnl, pnlPer1: p.pnlPer1, reason: ex.reason });
      }
    }
  }
  return { ...view(agg), examples, noResolution };
}

function simulateTouch(w) {
  const ref0 = lookbackRefs(w.ts, w.a0, 30_000);
  const ref1 = lookbackRefs(w.ts, w.a1, 30_000);
  const n = w.ts.length;
  for (let i = 0; i < n; i++) {
    let best = null;
    for (const side of [0, 1]) {
      const ask = side === 0 ? w.a0[i] : w.a1[i];
      const ref = side === 0 ? ref0[i] : ref1[i];
      if (!finite(ask) || !finite(ref)) continue;
      if (ask < 0.2 || ask > 0.45) continue;
      if (ref - ask < 0.12 - 1e-12) continue;
      const limit = Math.round((ask - 0.02) * 100) / 100;
      if (!(limit > 0) || !(limit < ask - 1e-12)) continue;
      const size = computeSize(STAKE, limit);
      if (size == null) continue;
      const drop = ref - ask;
      if (!best || drop > best.drop + 1e-12) best = { side, ask, limit, size, drop };
    }
    if (!best) continue;
    const deadline = w.ts[i] + 20_000;
    let fillK = -1;
    for (let k = i + 1; k < n && w.ts[k] <= deadline + 1e-9; k++) {
      const ask = best.side === 0 ? w.a0[k] : w.a1[k];
      if (finite(ask) && ask <= best.limit + 1e-9) {
        fillK = k;
        break;
      }
    }
    if (fillK < 0) {
      let j = i;
      while (j + 1 < n && w.ts[j + 1] <= deadline + 1e-9) j++;
      i = j;
      continue;
    }
    const ex = exitAtBid(w, best.side, fillK, best.limit, best.limit + 0.08, 0.05, 90_000);
    const p = tradePnl(best.size, best.limit, ex.bid);
    return {
      pnl: p.pnl,
      pnlPer1: p.pnlPer1,
      reason: ex.reason,
      slug: w.slug,
      side: best.side,
      signalAsk: best.ask,
      fill: best.limit,
      exitBid: ex.bid,
      size: best.size,
    };
  }
  return null;
}

function scoreTouch(windows) {
  const agg = blank();
  const examples = [];
  for (const w of windows) {
    const r = simulateTouch(w);
    if (!r) continue;
    add(agg, r.pnl, r.pnlPer1, r.reason);
    if (examples.length < 5) examples.push(r);
  }
  return { ...view(agg), examples };
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
  for (let k = 1; k < ts.length; k++) {
    const g = ts[k] - ts[k - 1];
    if (g > maxGap) maxGap = g;
  }
  if (maxGap > MAX_GAP_MS) return null;
  return {
    slug,
    start,
    endMs,
    ticks: ts.length,
    ts: Float64Array.from(ts),
    a0: Float64Array.from(a0),
    b0: Float64Array.from(b0),
    s0: Float64Array.from(s0),
    a1: Float64Array.from(a1),
    b1: Float64Array.from(b1),
    s1: Float64Array.from(s1),
    winner: null,
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
  const aw = m.avgWin == null ? "n/a" : m.avgWin.toFixed(4);
  const al = m.avgLoss == null ? "n/a" : m.avgLoss.toFixed(4);
  return (
    label +
    " n=" + m.n +
    " WR=" + (100 * m.winRate).toFixed(2) + "%" +
    " pnl=" + m.pnl.toFixed(4) +
    " pnlPer1=" + m.pnlPer1.toFixed(4) +
    " avgWin=" + aw +
    " avgLoss=" + al
  );
}

function clearsBar(m) {
  return !!m && m.n >= 40 && m.winRate >= 0.6 - 1e-12 && m.pnl > 0;
}

function selftest() {
  const size = computeSize(4, 0.4);
  if (size !== 10) throw new Error("size 0.4 " + size);
  if (computeSize(4, 0.85) !== null) throw new Error("size 0.85 should be null");
  const h = holdPnl(10, 0.4, true);
  if (Math.abs(h.pnl - 6) > 1e-9 || Math.abs(h.pnlPer1 - 1.5) > 1e-9) throw new Error("hold pnl");
  const loss = holdPnl(10, 0.4, false);
  if (Math.abs(loss.pnl + 4) > 1e-9 || Math.abs(loss.pnlPer1 + 1) > 1e-9) throw new Error("hold loss");
  console.log("selftest_ok");
}

function main() {
  selftest();
  const root = process.cwd();
  const srcPath = path.resolve(root, "data", "bot-live.db");
  const work = path.resolve(root, "data", "_btc15-cal-work.db");
  const outDir = path.resolve(root, "audits", "backtest", "btc15-scalp");
  mkdirSync(outDir, { recursive: true });
  for (const s of ["", "-wal", "-shm"]) if (existsSync(work + s)) rmSync(work + s);
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
  try {
    const resolutions = new Map();
    for (const row of db.prepare("SELECT eventSlug, winnerOutcomeIndex FROM market_resolutions").iterate()) {
      const w = Number(row.winnerOutcomeIndex);
      if (w === 0 || w === 1) resolutions.set(row.eventSlug, w);
    }
    const packs = new Map();
    let nrows = 0;
    const stmt = db.prepare(
      "SELECT eventSlug, ts, outcomeIndex, bestBid, bestAsk, bestAskSize FROM book_snapshots WHERE eventSlug LIKE 'btc-updown-15m-%'",
    );
    for (const row of stmt.iterate()) {
      nrows++;
      if (!slugStart(row.eventSlug)) continue;
      let bucket = packs.get(row.eventSlug);
      if (!bucket) packs.set(row.eventSlug, (bucket = []));
      bucket.push({ ts: row.ts, o: row.outcomeIndex, bid: row.bestBid, ask: row.bestAsk, sz: row.bestAskSize });
    }
    console.log("rows", nrows, "slugs", packs.size, "resolutions", resolutions.size);
    let windows = [];
    for (const [slug, rows] of packs) {
      const w = packWindow(slug, rows);
      if (!w) continue;
      if (w.start > LAST_START) continue;
      w.winner = resolutions.has(w.slug) ? resolutions.get(w.slug) : null;
      windows.push(w);
    }
    packs.clear();
    windows.sort((a, b) => a.start - b.start || (a.slug < b.slug ? -1 : 1));
    console.log("complete_through_cutoff", windows.length, "first", windows[0] && windows[0].start, "last", windows.at(-1) && windows.at(-1).start);
    if (windows.length !== 1272) {
      throw new Error("split mismatch: expected 1272 complete windows through " + LAST_START + ", got " + windows.length);
    }
    const train = windows.slice(0, 763);
    const hold = windows.slice(763);
    if (hold.length !== 509) throw new Error("holdout length " + hold.length);
    if (train[0].start !== TRAIN_FIRST) throw new Error("train start " + train[0].start);
    if (hold[0].start !== HOLD_FIRST) throw new Error("hold start " + hold[0].start);
    if (windows[windows.length - 1].start !== LAST_START) throw new Error("last start " + windows[windows.length - 1].start);
    const resCount = (arr) => arr.filter((w) => w.winner === 0 || w.winner === 1).length;
    console.log("split_ok train", train.length, "resolved", resCount(train), "holdout", hold.length, "resolved", resCount(hold));

    const built = buildTable(train);
    const fairGe60 = built.kept.filter((c) => c.fair >= 0.6).length;
    console.log("calib_samples", built.samples, "raw_cells", built.rawCells, "kept_n80", built.kept.length, "fair_ge_0.60", fairGe60, "train_windows_without_resolution", built.skippedNoRes);

    const trainGrid = [];
    for (const margin of MARGINS) {
      for (const exitMode of ["hold", "scalp"]) {
        const scored = scoreWindows(train, built.fair, margin, exitMode);
        const row = { margin, exit: exitMode, ...scored };
        trainGrid.push(row);
        console.log(line("TRAIN calib m=" + margin + " " + exitMode, row));
      }
    }
    const qualified = trainGrid.filter((r) => r.n >= 40 && r.winRate >= 0.6 - 1e-12);
    qualified.sort((a, b) => b.pnl - a.pnl || b.winRate - a.winRate || a.margin - b.margin);
    let frozen = null;
    let holdout = null;
    let trainGate = false;
    if (!qualified.length) {
      console.log("CALIB_TRAIN_GATE_FAIL no exit with n>=40 and WR>=60%. Holdout not scored.");
    } else {
      trainGate = true;
      frozen = { margin: qualified[0].margin, exit: qualified[0].exit };
      console.log("FROZEN", JSON.stringify(frozen), "train_pnl", qualified[0].pnl);
      holdout = scoreWindows(hold, built.fair, frozen.margin, frozen.exit);
      console.log(line("HOLDOUT calib", holdout));
      console.log("CLEARS", clearsBar(holdout));
    }

    const calibClears = clearsBar(holdout);
    let touch = null;
    if (!calibClears) {
      console.log("tuning touch-fill on train only");
      const touchTrain = scoreTouch(train);
      console.log(line("TRAIN touch-fill", touchTrain));
      const touchGate = touchTrain.n >= 40 && touchTrain.winRate >= 0.55 - 1e-12 && touchTrain.pnl > 0;
      let touchHold = null;
      if (!touchGate) {
        console.log("TOUCH_TRAIN_GATE_FAIL n>=40 WR>=55% PnL>0 not met. Holdout not scored.");
      } else {
        touchHold = scoreTouch(hold);
        console.log(line("HOLDOUT touch-fill", touchHold));
        console.log("CLEARS", clearsBar(touchHold));
      }
      touch = {
        rule: "After a 0.12 ask drop over 30s with ask in [0.20,0.45], rest a bid 0.02 under that ask. Fill only if a later ask is at or below the bid within 20s. Then taker-sell at the bid for +0.08 / -0.05 / 90s or window end.",
        trainGate: touchGate,
        train: touchTrain,
        holdout: touchHold,
        clearsBar: clearsBar(touchHold),
      };
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      stakeUsd: STAKE,
      shareSizing: "computeSize: floor(stake/price*100)/100 shares, minimum 5. Same as src/utils/prices.ts. maxShares uncapped.",
      pnlDefinition: "Engine $ PnL uses floored shares. pnlPer1 is the per-$1 formula: hold win 1/ask-1 loss -1; scalp (exit-entry)/entry. Win means engine PnL > 0. A scratch is not a win.",
      split: {
        nComplete: windows.length,
        nTrain: train.length,
        nHoldout: hold.length,
        trainFirstStart: train[0].start,
        holdoutFirstStart: hold[0].start,
        lastStart: windows[windows.length - 1].start,
        trainResolved: resCount(train),
        holdoutResolved: resCount(hold),
      },
      calibration: {
        samples: built.samples,
        rawCells: built.rawCells,
        keptCells: built.kept.length,
        cellsFairGe060: fairGe60,
        trainWindowsSkippedNoResolution: built.skippedNoRes,
        cells: built.kept
          .map((c) => ({ eBin: c.eBin, askLo: c.askLo, n: c.n, wins: c.wins, fair: c.fair }))
          .sort((a, b) => a.eBin - b.eBin || a.askLo - b.askLo),
        trainGrid: trainGrid.map((r) => {
          const { examples, ...rest } = r;
          return rest;
        }),
        trainGate,
        frozen,
        train: frozen ? trainGrid.find((r) => r.margin === frozen.margin && r.exit === frozen.exit) : null,
        holdout,
        clearsBar: calibClears,
      },
      touchFill: touch,
    };
    const outPath = path.join(outDir, "calibration-results.json");
    writeFileSync(outPath, JSON.stringify(roundObj(payload), null, 2));
    console.log("wrote", outPath);
  } finally {
    db.close();
    for (const s of ["", "-wal", "-shm"]) if (existsSync(work + s)) rmSync(work + s);
    console.log("temp_db_deleted");
  }
}

main();
