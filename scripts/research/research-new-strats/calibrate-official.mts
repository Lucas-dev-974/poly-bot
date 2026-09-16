/**
 * Calibration sim vs runner OFFICIEL — fav-band comme sonde.
 * READ-ONLY sur data/bot-live.db (VACUUM INTO work copy, supprimée à la fin).
 *
 * La discovery sim (research-new-strats) réutilise le loader/mécanique de
 * dip-sim. Pour lui donner un statut de backtest calibré, on exécute le
 * runner officiel (src/backtest/runner.ts) sur le moteur natif fav-band
 * avec la même config que la repro sim (0.70-0.85, min 200s, $15, 30 sh,
 * spread 0.05) et on compare fills / PnL / WR.
 *
 * Attente (calibration dip-sim historique) : ±1% fills, même direction.
 *
 * npx tsx scripts/research/research-new-strats/calibrate-official.mts
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

const criteria: CompletenessCriteria = {
  minTicks: 801,
  maxGapMs: 60_000,
  maxEdgeGapMs: null,
};

const OUT_DIR = join("audits", "backtest", "research-new-strats");
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

async function main() {
  if (!existsSync(srcDb)) {
    console.error("base source introuvable:", srcDb);
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const workDb = join("data", `_calib-newstrats-${Date.now()}.db`);
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
      runId: `calib-favband-${Date.now()}`,
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

    const official = {
      engine: "fav-band (runner officiel)",
      config: FAVBAND_OVR,
      windows: windows.length,
      fills: result.fillCount,
      tradedWindows: traded.length,
      pnl,
      winRate: wr,
      unresolvedWindows: result.unresolvedWindows,
      rejects: result.rejectCount,
    };
    const simRef = {
      engine: "FAVBAND-REPRO sim (discovery-sim2)",
      fills: 387,
      pnl: 293.15,
      winRate: 77.3,
      avgEntryPrice: 0.734,
    };
    const report = {
      phase: "calibration-sim-vs-official",
      generatedAt: new Date().toISOString(),
      universe: `${windows.length} fenêtres complètes (801+/60s)`,
      official,
      simRef,
      note: "La sim discovery (même loader/mécanique que dip-sim, calibrée ±1% fills) reproduit fav-band sur le même univers. Si fills/PnL/WR sont dans le même ordre de grandeur, les résultats ANTIFLIP/FIRSTFAV/FLIPCONFIRM des discovery-sim ont un statut de backtest calibré (ranking fiable).",
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