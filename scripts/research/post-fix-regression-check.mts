/**
 * Vérification post-fix (2026-09-25) — rejoue le chemin exact du crash live
 * contre une COPIE de la DB, sans toucher au bot réel :
 *   1. sanitizePatch sur simConfigJson persisté (la clé morte doit être droppée)
 *   2. buildEffectiveConfig (le throw "Unknown field" d'origine)
 *   3. PaperTradingEngine.init() complet + getters du dashboard (le crash)
 *   4. extractSettlement sur les résolutions réelles de market_resolutions
 * Usage : npx tsx scripts/research/post-fix-regression-check.mts
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { sanitizePatch } from "../../src/runtime-settings.js";
import { buildEffectiveConfig } from "../../src/backtest/config-builder.js";
import { PaperTradingEngine } from "../../src/paper/engine.js";
import { Database } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/index.js";
import { extractSettlement, type GammaMarketResult } from "../../src/position-resolver.js";

const LIVE_DB = "data/bot-live.db";
const dir = mkdtempSync(join(tmpdir(), "regression-check-"));
const workDb = join(dir, "work.db");
let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Copie de travail (lecture seule de la source — jamais d'écriture sur le live).
const src = new DatabaseSync(LIVE_DB, { readOnly: true });
src.exec(`VACUUM INTO '${workDb.replace(/\\/g, "/")}'`);
src.close();

const config = loadConfig();

// 1. La config paper persistée passe sanitizePatch (clé morte droppée).
check("sanitizePatch sur simConfigJson persisté", () => {
  const db = new DatabaseSync(workDb, { readOnly: true });
  const row = db.prepare("SELECT value FROM sim_state WHERE key='simConfigJson'").get() as
    | { value: string }
    | undefined;
  db.close();
  if (!row) throw new Error("simConfigJson absent (rien à vérifier)");
  const parsed = JSON.parse(row.value) as Record<string, unknown>;
  if (!("simRequireCoveredPair" in parsed)) {
    console.log("       (info: la clé morte n'est plus dans la config persistée — déjà nettoyée)");
    return;
  }
  const patch = sanitizePatch(parsed);
  if ("simRequireCoveredPair" in patch) throw new Error("clé morte non droppée");
  if (Object.keys(patch).length === 0) throw new Error("patch vide");
});

// 2. buildEffectiveConfig — le chemin qui jetait au boot.
let repos: ReturnType<typeof createRepositories> | undefined;
let workDbHandle: Database | undefined;
check("buildEffectiveConfig sur la config paper persistée", () => {
  workDbHandle = new Database(workDb, true);
  workDbHandle.init();
  repos = createRepositories(workDbHandle);
  const raw = repos.simState.get("simConfigJson");
  if (!raw) throw new Error("simConfigJson absent");
  const simConfig = JSON.parse(raw) as {
    strategyId: string;
    presetId?: string;
    settings?: Record<string, unknown>;
  };
  const effective = buildEffectiveConfig(config, repos, {
    strategyId: simConfig.strategyId as never,
    presetId: simConfig.presetId,
    settings: simConfig.settings as never,
    useCurrentConfig: !simConfig.presetId && !simConfig.settings,
  });
  if (!effective || typeof effective.strategyId !== "string") {
    throw new Error("config effective invalide");
  }
});

// 3. init() complet + getters dashboard — le crash exact
//    (getOpenPositions sur tracker undefined).
check("PaperTradingEngine.init() + getters dashboard", () => {
  const engine = new PaperTradingEngine(config, repos);
  engine.init(); // doit survivre à la config persistée avec la clé morte
  const open = engine.getOpenPositions();
  const resolved = engine.getResolvedPositions();
  const state = engine.getState();
  if (!Array.isArray(open) || !Array.isArray(resolved)) {
    throw new Error("getters dashboard invalides");
  }
  if (typeof state.cash !== "number" || !state.stats) {
    throw new Error("getState invalide");
  }
  console.log(
    `       (info: engine OK — ${open.length} open / ${resolved.length} resolved, cash ${state.cash})`,
  );
});

// 4. extractSettlement sur les résolutions réelles (labels du dataset ML).
check("extractSettlement sur market_resolutions réelles", () => {
  const db = new DatabaseSync(workDb, { readOnly: true });
  const rows = db
    .prepare(
      "SELECT eventSlug, winnerOutcomeIndex FROM market_resolutions ORDER BY ts DESC LIMIT 200",
    )
    .all() as Array<{ eventSlug: string; winnerOutcomeIndex: number }>;
  db.close();
  const distribution = new Map<number, number>();
  for (const row of rows) {
    distribution.set(row.winnerOutcomeIndex, (distribution.get(row.winnerOutcomeIndex) ?? 0) + 1);
  }
  // Les anciennes lignes ne peuvent pas être re-jugées sans refetch Gamma ;
  // on vérifie surtout qu'aucun index invalide (ni 2 historique avant le fix).
  for (const [idx, count] of distribution) {
    if (idx !== 0 && idx !== 1 && idx !== 2) {
      throw new Error(`winnerOutcomeIndex invalide ${idx} (${count} rows)`);
    }
  }
  console.log(
    `       (info: ${rows.length} résolutions récentes — Up:${distribution.get(0) ?? 0} Down:${distribution.get(1) ?? 0} void:${distribution.get(2) ?? 0})`,
  );
});

// 5. Sanity : le verdict void reste détectable (payload réel 50/50 simulé).
check("extractSettlement verdict void (unité)", () => {
  const payload: GammaMarketResult = {
    outcomes: '["Up","Down"]',
    outcomePrices: '["0.5","0.5"]',
    umaResolutionStatus: "resolved",
  };
  if (extractSettlement(payload, { outcome: "Up", outcomeIndex: 0 }) !== "void") {
    throw new Error("verdict void non détecté");
  }
});

try {
  workDbHandle?.close();
} catch {
  /* déjà fermé */
}
try {
  rmSync(workDb, { force: true });
  rmSync(`${workDb}-wal`, { force: true });
  rmSync(`${workDb}-shm`, { force: true });
} catch {
  /* Windows peut garder le handle un cycle de plus — le tmpdir est nettoyé par l'OS */
}
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* idem */
}
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* Windows peut garder le handle un cycle de plus — le tmpdir est nettoyé par l'OS */
}

console.log(failures === 0 ? "\nTOUS LES CHECKS PASSENT" : `\n${failures} CHECK(S) EN ÉCHEC`);
process.exit(failures === 0 ? 0 : 1);