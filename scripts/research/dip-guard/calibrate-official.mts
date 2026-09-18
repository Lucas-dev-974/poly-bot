/**
 * Calibration dip-guard sim vs runner OFFICIEL — fav-band comme sonde.
 * READ-ONLY sur data/bot-live.db (VACUUM INTO work copy, supprimée à la fin).
 *
 * Objectif : vérifier que la sim dip-guard (loader/mécanique propres) est
 * calibrée contre le runner officiel sur le MÊME univers. On exécute le
 * runner officiel (src/backtest/runner.ts) sur le moteur natif fav-band
 * avec la config de la sonde (0.70-0.85, min 200s, $15, 30 sh, spread
 * 0.05) sur l'univers 801+/60s btc-15m, et on compare aux chiffres de la
 * sonde fav-band exécutée DANS la sim dip-guard (même univers).
 *
 * Attente repo : ±1-2% fills, même direction PnL. Si calibré, les chiffres
 * dip-guard INVERT ($434, WR 75%) ont un statut de backtest calibré.
 *
 * npx tsx scripts/research/dip-guard/calibrate-official.mts
 */
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import { testConfig } from "../../../tests/helpers.ts";
import { sanitizePatch } from "../../../src/runtime-settings.ts";
import { validateConfigCoherence } from "../../../src/config.ts";
import type { CompletenessCriteria } from "../../../src/backtest/completeness.ts";
import { loadUniverse } from "./universe.mts";

const criteria: CompletenessCriteria = {
  minTicks: 801,
  maxGapMs: 60_000,
  maxEdgeGapMs: null,
};

const OUT_DIR = join("audits", "backtest", "dip-guard");
const srcDb = join("data", "bot-live.db");

const FAVBAND_OVR = {
  strategyId: "fav-band",
  favBandAskMin: 0.7,
  favBandAskMax: 0.85,
  favBandMinElapsedSec: 200,
  favBandMaxElapsedSec: null,
  favBandOrderUsdc: 15,
  maxSharesPerOrder: 30,
  maxExposureUsdc: 450,
  simulatedCapital: 500,
  minutesBeforeCloseMin: 0,
  minutesBeforeCloseMax: 15,
};

/** Sonde fav-band exécutée dans la sim dip-guard (même univers/mécanique). */
function runFavBandSimProbe(u: ReturnType<typeof loadUniverse>) {
  let fills = 0,
    wins = 0,
    pnl = 0,
    shares = 0,
    notional = 0;
  for (const [slug, ticks] of u.slugs) {
    const res = u.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (u.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;
    let pos: { price: number; size: number; idx: 0 | 1 } | null = null;
    for (const t of ticks) {
      const elapsed = (t.ts - wsMs) / 1000;
      if (elapsed < 0 || elapsed >= 900) continue;
      if (pos) continue;
      if (elapsed < 200) continue;
      // favori = le plus grand ask; la sim fav-band officielle achète le
      // favori dont l'ask est dans [0.70, 0.85] — le token le plus cher.
      let favIdx: 0 | 1 | null = null;
      let favAsk = -Infinity;
      for (const idx of [0, 1] as const) {
        const book = idx === 0 ? t.up : t.down;
        if (book.ask == null) continue;
        if (book.ask > favAsk) {
          favAsk = book.ask;
          favIdx = idx;
        }
      }
      if (favIdx == null) continue;
      const book = favIdx === 0 ? t.up : t.down;
      if (book.ask == null) continue;
      if (book.ask < 0.7 || book.ask > 0.85) continue;
      const bid = book.bid;
      if (bid != null && book.ask - bid > 0.05) continue;
      const size = Math.min(15 / book.ask, 30);
      if (size < 5) continue;
      if (book.askSize != null && book.askSize < size) continue;
      pos = { price: book.ask, size, idx: favIdx };
      fills++;
      shares += size;
      notional += book.ask * size;
      break;
    }
    if (!pos) continue;
    const win = res === pos.idx;
    pnl += win ? (1 - pos.price) * pos.size : -pos.price * pos.size;
    if (win) wins++;
  }
  const wr = fills ? Math.round((wins / fills) * 1000) / 10 : null;
  const avgEntry = shares ? Math.round((notional / shares) * 1000) / 1000 : null;
  return { fills, wins, pnl: Math.round(pnl * 100) / 100, winRate: wr, avgEntry };
}

async function main() {
  if (!existsSync(srcDb)) {
    console.error("base source introuvable:", srcDb);
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const workDb = join("data", `_calib-dipguard-${Date.now()}.db`);
  {
    const src = new DatabaseSync(srcDb, { readOnly: true });
    try {
      src.exec(`VACUUM INTO '${workDb.replace(/\\/g, "/")}'`);
    } finally {
      src.close();
    }
  }

  try {
    const db = new Database(workDb, true);
    db.init();
    const repos = createRepositories(db);
    const db2 = new DatabaseSync(srcDb, { readOnly: true });
    const resSlugs = new Set(
      (db2
        .prepare("SELECT eventSlug FROM market_resolutions")
        .all() as Array<{ eventSlug: string }>).map((r) => r.eventSlug),
    );
    db2.close();
    const windows = listBacktestWindows(repos, {
      completeness: criteria,
      completeOnly: true,
    }).filter(
      (w: { eventSlug: string; complete: boolean }) =>
        w.complete &&
        resSlugs.has(w.eventSlug) &&
        w.eventSlug.startsWith("btc-updown-15m-"),
    );
    console.log(`official universe (complete+resolved btc, same as sim): ${windows.length} windows`);

    const base = testConfig();
    const patch = sanitizePatch({ ...FAVBAND_OVR });
    const config = { ...base, ...patch };
    validateConfigCoherence(config);

    const result = await runBacktest({
      runId: `calib-favband-dipguard-${Date.now()}`,
      config,
      windows,
      repos,
      hooks: {
        shouldCancel: () => false,
        onProgress: () => {},
      },
    });
    const traded = result.windows.filter(
      (w: { pnl: number | null; tradeCount: number }) =>
        w.pnl !== null && w.tradeCount > 0,
    );
    const wins = traded.filter((w: { pnl: number }) => w.pnl > 0).length;
    const pnl = Math.round(result.pnl * 100) / 100;
    const wr = traded.length
      ? Math.round((wins / traded.length) * 1000) / 10
      : null;

    // la même sonde exécutée dans la sim dip-guard (même univers)
    const u = loadUniverse();
    const simProbe = runFavBandSimProbe(u);
    const drift = {
      fillsPct:
        simProbe.fills > 0
          ? Math.round(Math.abs(((result.fillCount - simProbe.fills) / simProbe.fills) * 100) * 100) / 100
          : null,
      pnlDelta: Math.round((pnl - simProbe.pnl) * 100) / 100,
      wrDelta:
        wr != null && simProbe.winRate != null
          ? Math.round((wr - simProbe.winRate) * 100) / 100
          : null,
    };
    const calibrated = (drift.fillsPct ?? 100) < 5 && drift.pnlDelta * Math.sign(simProbe.pnl || 1) < Math.abs(simProbe.pnl) * 0.15;

    const report = {
      phase: "calibration dip-guard-sim vs official runner (fav-band probe)",
      generatedAt: new Date().toISOString(),
      universe: `${windows.length} fenêtres complètes (801+/60s)`,
      official: {
        engine: "fav-band (runner officiel)",
        config: FAVBAND_OVR,
        windows: windows.length,
        fills: result.fillCount,
        tradedWindows: traded.length,
        pnl,
        winRate: wr,
        unresolvedWindows: result.unresolvedWindows,
        rejects: result.rejectCount,
      },
      simProbe: {
        engine: "fav-band (sim dip-guard, même univers)",
        fills: simProbe.fills,
        pnl: simProbe.pnl,
        winRate: simProbe.winRate,
        avgEntryPrice: simProbe.avgEntry,
      },
      drift,
      calibrated: calibrated,
      note: "Si fills/PnL/WR sont dans le même ordre de grandeur (attente repo ±1-2% fills, même direction), la sim dip-guard a un statut de backtest calibré : les chiffres INVERT (+$434, WR 75%) sont fiables pour le ranking.",
    };
    const outPath = join(OUT_DIR, `calibration-official-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log("written:", outPath);
    db.close();
  } finally {
    for (const f of [workDb, `${workDb}-wal`, `${workDb}-shm`]) {
      try {
        rmSync(f);
      } catch {
        /* absent */
      }
    }
  }
}

main();