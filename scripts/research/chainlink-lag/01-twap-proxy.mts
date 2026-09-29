/**
 * Phase 0 / Task 0.2 — MESURE A6 (prérequise au moteur chainlink-lag).
 * Hypothèse A6 : la TWAP-60s Binance approxime la TWAP-60s Chainlink
 * (composite multi-exchanges) assez bien pour prédire le côté de résolution.
 *
 * Méthode (plan §4 Task 0.2) :
 *   - fenêtres RÉSOLUES du dataset backtest (bot-live.db, BTC+ETH),
 *   - reconstruire TWAP-60s début/fin de fenêtre depuis klines 1s Binance,
 *   - sign(twapEnd − twapStart) vs market_resolutions.winnerOutcomeIndex
 *     (0=Up, 1=Down ; tie résout Up — cf. plan A2),
 *   - DEUX conventions de barre mesurées (la convention réelle de Chainlink
 *     n'est pas documentée — le WR le plus élevé la révèle) :
 *       * BACKWARD : barre = buffer glissant [ws-59, ws] figé à l'instant ws
 *         (c'est ce que capture le FeedManager du plan, twap60AtWindowStart),
 *       * FORWARD  : barre = TWAP [ws, ws+59] démarrant à l'ouverture,
 *     la fin est toujours la dernière minute de fenêtre [we-59, we].
 *   - WR du proxy (objectif >= 97-98 %) + fréquence de triggers
 *     + split-half + par asset.
 *
 * Source klines : **data.binance.vision** (ZIP quotidiens 1s, CDN public,
 * sans rate-limit). open_time en MICROsecondes dans ces fichiers.
 * Cache: data/chainlink-lag-cache/klines-1s/<SYM>.json (clés en secondes).
 *
 * Sortie : audits/chainlink-lag/A6-PROXY-<stamp>.md + .json
 *
 *   npx tsx scripts/research/chainlink-lag/01-twap-proxy.mts
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// ── Constantes ──────────────────────────────────────────────────────────────
const DB_PATH = "data/bot-live.db";
const KLINES_DIR = "data/chainlink-lag-cache/klines-1s";
const WINDOW_SEC = 900;
const TWAP_SEC = 60;
const OUT_DIR = "audits/chainlink-lag";
const BINANCE_VISION = "https://data.binance.vision/data/spot/daily/klines";
const EDGE_PAD_SEC = 60;
/** Pas de complétion REST : les CSV vision sont complets (1440 min/j).
 *  Le jour courant (404) est ignoré — ses fenêtres ne seront pas mesurables. */
const DAY_MS = 86_400_000;

const SYMBOLS: Array<{ symbol: string; asset: string }> = [
  { symbol: "BTCUSDT", asset: "btc" },
  { symbol: "ETHUSDT", asset: "eth" },
];

type Kline = { openSec: number; close: number };

// ── Cache par jour (1 fichier JSON/jour/symbole, robuste aux interruptions) ─
function dayFile(symbol: string, date: string): string {
  return join(KLINES_DIR, symbol, `${date}.json`);
}

async function loadDay(symbol: string, date: string): Promise<Map<number, number> | null> {
  const file = dayFile(symbol, date);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Array<[number, number]>;
    return new Map(raw);
  } catch {
    return null;
  }
}

async function saveDay(symbol: string, date: string, map: Map<number, number>): Promise<void> {
  const file = dayFile(symbol, date);
  mkdirSync(join(KLINES_DIR, symbol), { recursive: true });
  const arr: Array<[number, number]> = [...map.entries()].sort((a, b) => a[0] - b[0]);
  await writeFile(file, JSON.stringify(arr));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Source : data.binance.vision (ZIP quotidiens, open_time en µs) ──────────
/** Télécharge+extrait (idempotent) le ZIP d'un jour ; retourne null si 404. */
async function ensureDayCsv(symbol: string, date: string): Promise<boolean> {
  const symbolDir = join(KLINES_DIR, symbol);
  mkdirSync(symbolDir, { recursive: true });
  const zipName = `${symbol}-1s-${date}.zip`;
  const zipPath = join(symbolDir, zipName);
  const csvPath = join(symbolDir, `${zipName.replace(".zip", "")}.csv`);
  if (existsSync(csvPath)) return true;
  const url = `${BINANCE_VISION}/${symbol}/1s/${zipName}`;
  const res = await fetch(url);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await (await import("node:fs/promises")).writeFile(zipPath, buf);
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${symbolDir}' -Force`],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 },
  );
  unlinkSync(zipPath);
  return existsSync(csvPath);
}

/** Parse le CSV d'un jour -> Map<openSec, close>. */
async function parseDayCsv(symbol: string, date: string): Promise<Map<number, number>> {
  const csvPath = join(KLINES_DIR, symbol, `${symbol}-1s-${date}.csv`);
  const csv = await readFile(csvPath, "utf8");
  const out = new Map<number, number>();
  for (const line of csv.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const c = t.split(",");
    if (c.length < 5) continue;
    const openTimeUs = Number(c[0]);
    const close = Number(c[4]);
    if (!Number.isFinite(openTimeUs) || !Number.isFinite(close)) continue;
    out.set(Math.floor(openTimeUs / 1_000_000), close);
  }
  return out;
}

/** Charge (télécharge si besoin) les klines 1s d'un jour UTC. */
async function loadOrFetchDay(symbol: string, date: string): Promise<Map<number, number> | null> {
  const cached = await loadDay(symbol, date);
  if (cached) return cached;
  const ok = await ensureDayCsv(symbol, date);
  if (!ok) return null;
  const parsed = await parseDayCsv(symbol, date);
  await saveDay(symbol, date, parsed);
  return parsed;
}

// ── Univers ─────────────────────────────────────────────────────────────────
function parseWindowStart(slug: string): number | null {
  const parts = slug.split("-");
  const startSec = Number(parts[parts.length - 1]);
  return Number.isFinite(startSec) && startSec > 1e9 ? startSec : null;
}

interface Win {
  slug: string;
  wsSec: number;
  weSec: number;
  winner: number;
  asset: string;
}

function resolvedWindows(db: DatabaseSync): Win[] {
  const rows = db
    .prepare(
      `SELECT eventSlug, winnerOutcomeIndex FROM market_resolutions
       WHERE eventSlug LIKE 'btc-updown-15m-%' OR eventSlug LIKE 'eth-updown-15m-%'
       ORDER BY eventSlug`,
    )
    .all() as unknown as Array<{ eventSlug: string; winnerOutcomeIndex: number }>;
  const out: Win[] = [];
  for (const r of rows) {
    const wsSec = parseWindowStart(r.eventSlug);
    if (wsSec == null) continue;
    const asset = r.eventSlug.startsWith("btc-updown-15m") ? "btc" : "eth";
    out.push({ slug: r.eventSlug, wsSec, weSec: wsSec + WINDOW_SEC, winner: r.winnerOutcomeIndex, asset });
  }
  return out;
}

// ── Stats ───────────────────────────────────────────────────────────────────
type MoveKey = "movePctBack" | "movePctFwd";
type Measurable = { winner: number; movePctBack: number; movePctFwd: number };

function wrOf(subset: Measurable[], key: MoveKey): { wr: number | null; n: number } {
  const ok = subset.filter((r) => (r[key] >= 0 ? 0 : 1) === r.winner).length;
  return { wr: subset.length ? (ok / subset.length) * 100 : null, n: subset.length };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const windows = resolvedWindows(db);
  console.log(`fenêtres résolues (BTC+ETH): ${windows.length}`);
  db.close();

  // Jours UTC nécessaires par symbole.
  const daysBySymbol = new Map<string, Set<string>>();
  for (const w of windows) {
    const symbol = w.asset === "btc" ? "BTCUSDT" : "ETHUSDT";
    let set = daysBySymbol.get(symbol);
    if (!set) {
      set = new Set();
      daysBySymbol.set(symbol, set);
    }
    // la barre BACKWARD [ws-59, ws] peut déborder sur le jour précédent
    const loDay = new Date((w.wsSec - EDGE_PAD_SEC) * 1000).toISOString().slice(0, 10);
    const weDay = new Date(w.weSec * 1000).toISOString().slice(0, 10);
    set.add(loDay);
    set.add(weDay);
  }

  // Téléchargement jour par jour (idempotent, robuste aux interruptions).
  for (const [symbol, days] of daysBySymbol) {
    const sorted = [...days].sort();
    console.log(`${symbol}: ${sorted.length} jours à télécharger (${sorted[0]} -> ${sorted[sorted.length - 1]})`);
    let done = 0;
    for (const date of sorted) {
      const m = await loadOrFetchDay(symbol, date);
      done++;
      if (m === null) console.warn(`[warn] ${date} absent (404)`);
      if (done % 5 === 0 || done === sorted.length) console.log(`  ${symbol}: ${done}/${sorted.length} jours`);
    }
  }

  // Chargement en mémoire + mesures.
  const klines = new Map<string, Map<number, number>>();
  for (const [symbol, days] of daysBySymbol) {
    const merged = new Map<number, number>();
    for (const date of days) {
      const m = await loadDay(symbol, date);
      if (!m) continue;
      for (const [k, v] of m) merged.set(k, v);
    }
    klines.set(symbol, merged);
    console.log(`${symbol}: ${merged.size} secondes de klines en mémoire`);
  }

  // Reconstruire les mesures par fenêtre (les DEUX conventions de barre).
  const results: Array<{
    slug: string;
    asset: string;
    winner: number;
    twapBarBack: number | null;
    twapBarFwd: number | null;
    twapEnd: number | null;
    movePctBack: number | null;
    movePctFwd: number | null;
  }> = [];
  for (const w of windows) {
    const symbol = w.asset === "btc" ? "BTCUSDT" : "ETHUSDT";
    const kl = klines.get(symbol) ?? new Map<number, number>();
    const twapOf = (startSec: number): number | null => {
      let sum = 0;
      let n = 0;
      for (let s = startSec; s < startSec + TWAP_SEC; s++) {
        const v = kl.get(s);
        if (v != null) {
          sum += v;
          n++;
        }
      }
      return n >= 55 ? sum / n : null;
    };
    const twapBarBack = twapOf(w.wsSec - (TWAP_SEC - 1));
    const twapBarFwd = twapOf(w.wsSec);
    const twapEnd = twapOf(w.weSec - (TWAP_SEC - 1));
    const movePctBack = twapBarBack != null && twapEnd != null ? ((twapEnd - twapBarBack) / twapBarBack) * 100 : null;
    const movePctFwd = twapBarFwd != null && twapEnd != null ? ((twapEnd - twapBarFwd) / twapBarFwd) * 100 : null;
    results.push({ slug: w.slug, asset: w.asset, winner: w.winner, twapBarBack, twapBarFwd, twapEnd, movePctBack, movePctFwd });
  }

  const measurable = results.filter((r) => r.movePctBack != null && r.movePctFwd != null) as Array<{
    slug: string;
    asset: string;
    winner: number;
    movePctBack: number;
    movePctFwd: number;
  }>;

  console.log(`mesurables (les 3 TWAP complètes): ${measurable.length}/${results.length}`);
  if (measurable.length < 50) {
    console.warn("[warn] < 50 fenêtres mesurables — verdict peu fiable");
  }

  const thresholds = [0, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6];

  // ── Rapport ───────────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push("# A6 — Proxy TWAP-60s Binance vs résolution Polymarket");
  lines.push("");
  lines.push(`- Généré: ${new Date().toISOString()}`);
  lines.push(`- Dataset: bot-live.db, fenêtres résolues BTC+ETH`);
  lines.push(`- Source klines: data.binance.vision (ZIP quotidiens 1s, open_time µs)`);
  lines.push(`- TWAP: moyenne arithmétique des closes 1s Binance sur 60 s (proxy de la TWAP-60s Chainlink Data Streams)`);
  lines.push(`- Règle (plan A2): twapEnd >= barre → Up (0), sinon Down (1) ; tie → Up`);
  lines.push(`- Conventions de barre: BACKWARD = buffer glissant [ws-59, ws] figé à l'ouverture (FeedManager du plan) ; FORWARD = TWAP [ws, ws+59]`);
  lines.push("");
  lines.push(`Fenêtres mesurables: **${measurable.length}/${results.length}**`);
  lines.push("");

  for (const [label, key] of [
    ["BACKWARD (barre figée à l'instant ws — hypothèse du plan)", "movePctBack"],
    ["FORWARD (TWAP [ws, ws+59])", "movePctFwd"],
  ] as const) {
    lines.push(`## WR proxy — convention ${label}`);
    lines.push("");
    lines.push("| Seuil (\\|movePct\\| >= X) | Triggers | WR proxy | IC95 (approx binomiale) |");
    lines.push("|---|---|---|---|");
    for (const thr of thresholds) {
      const subset = measurable.filter((r) => Math.abs(r[key]) >= thr);
      const { wr, n } = wrOf(subset, key);
      if (n === 0 || wr == null) {
        lines.push(`| ${thr} | 0 | — | — |`);
        continue;
      }
      const se = Math.sqrt((wr * (100 - wr)) / n);
      lines.push(`| ${thr} | ${n} | ${wr.toFixed(2)}% | ±${(1.96 * se).toFixed(2)}% |`);
    }
    lines.push("");
  }

  // ── Fréquence de triggers ────────────────────────────────────────────────
  lines.push("## Fréquence de triggers attendue (convention BACKWARD)");
  lines.push("");
  lines.push("| Seuil | Triggers | Fréquence |");
  lines.push("|---|---|---|");
  for (const t of [0.1, 0.15, 0.25, 0.5, 1.0]) {
    const n = measurable.filter((r) => Math.abs(r.movePctBack) >= t).length;
    lines.push(`| ${t} | ${n} | ${((n / measurable.length) * 100).toFixed(1)}% |`);
  }
  lines.push("");

  // ── Split-half + par asset sur la MEILLEURE convention ──────────────────
  const wrBack015 = wrOf(
    measurable.filter((r) => Math.abs(r.movePctBack) >= 0.15),
    "movePctBack",
  );
  const wrFwd015 = wrOf(
    measurable.filter((r) => Math.abs(r.movePctFwd) >= 0.15),
    "movePctFwd",
  );
  const bestKey: MoveKey = (wrBack015.wr ?? 0) >= (wrFwd015.wr ?? 0) ? "movePctBack" : "movePctFwd";

  lines.push(`## Détails (convention retenue: ${bestKey === "movePctBack" ? "BACKWARD" : "FORWARD"}, seuil 0.15)`);
  lines.push("");
  const thrSplit = 0.15;
  const withMoves = measurable
    .map((r) => ({ ...r, ts: (Number(r.slug.split("-").pop()) ?? 0) * 1000 }))
    .sort((a, b) => a.ts - b.ts);
  const half = Math.floor(withMoves.length / 2);
  for (const [label, part] of [
    ["moitié ancienne", withMoves.slice(0, half)],
    ["moitié récente", withMoves.slice(half)],
  ] as const) {
    const { wr, n } = wrOf(part.filter((r) => Math.abs(r[bestKey]) >= thrSplit), bestKey);
    lines.push(`- Split-half ${label}: ${n} triggers, WR ${wr == null ? "—" : wr.toFixed(2) + "%"}`);
  }
  for (const asset of ["btc", "eth"]) {
    const { wr, n } = wrOf(measurable.filter((r) => r.asset === asset && Math.abs(r[bestKey]) >= thrSplit), bestKey);
    lines.push(`- ${asset}: ${n} triggers, WR ${wr == null ? "—" : wr.toFixed(2) + "%"}`);
  }
  lines.push("");

  // ── Distribution brute des moves ────────────────────────────────────────
  const moves = measurable.map((r) => r[bestKey]).sort((a, b) => a - b);
  const q = (p: number): number => moves[Math.floor(p * (moves.length - 1))] ?? NaN;
  lines.push(`## Distribution de movePct (${bestKey === "movePctBack" ? "twapEnd - barreBackward" : "twapEnd - barreForward"}, %)`);
  lines.push("");
  if (moves.length > 0) {
    lines.push(
      `- min / p5 / p25 / médiane / p75 / p95 / max: ${moves[0].toFixed(3)} / ${q(0.05).toFixed(3)} / ${q(0.25).toFixed(3)} / ${q(0.5).toFixed(3)} / ${q(0.75).toFixed(3)} / ${q(0.95).toFixed(3)} / ${moves[moves.length - 1].toFixed(3)}`,
    );
  } else {
    lines.push("- aucune donnée");
  }
  lines.push("");

  // ── Verdict ──────────────────────────────────────────────────────────────
  const mainSubset = measurable.filter((r) => Math.abs(r[bestKey]) >= 0.15);
  const { wr: mainWr, n: mainN } = wrOf(mainSubset, bestKey);
  lines.push("## Verdict A6");
  lines.push("");
  if (mainN === 0 || mainWr == null) {
    lines.push("**INDÉTERMINÉ** — pas assez de triggers >= 0.15%. Vérifier la couverture klines.");
  } else if (mainWr >= 97) {
    lines.push(`**OK** — WR proxy ${mainWr.toFixed(2)}% (n=${mainN}) >= 97% : le proxy TWAP Binance suffit en v1 (convention ${bestKey === "movePctBack" ? "BACKWARD" : "FORWARD"}).`);
  } else if (mainWr >= 95) {
    lines.push(`**MARGINAL** — WR proxy ${mainWr.toFixed(2)}% (n=${mainN}) dans [95, 97) : l'erreur proxy contamine le signal ; considérer perps idx (A7) ou Data Streams (v2).`);
  } else {
    lines.push(`**DEAD pour v1** — WR proxy ${mainWr.toFixed(2)}% (n=${mainN}) < 95% : le proxy ne prédit pas la résolution. Fondation v1 gratuite perdue.`);
  }
  lines.push("");

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now();
  const md = lines.join("\n");
  const json = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      measurable: measurable.length,
      total: results.length,
      byThreshold: {
        backward: thresholds.map((t) => {
          const { wr, n } = wrOf(
            measurable.filter((r) => Math.abs(r.movePctBack) >= t),
            "movePctBack",
          );
          return { threshold: t, triggers: n, wr };
        }),
        forward: thresholds.map((t) => {
          const { wr, n } = wrOf(
            measurable.filter((r) => Math.abs(r.movePctFwd) >= t),
            "movePctFwd",
          );
          return { threshold: t, triggers: n, wr };
        }),
      },
      windows: results,
    },
    null,
    2,
  );
  writeFileSync(`audits/chainlink-lag/A6-PROXY-${stamp}.md`, md);
  writeFileSync(`audits/chainlink-lag/A6-PROXY-${stamp}.json`, json);
  console.log(md);
  console.log(`\nÉcrit: audits/chainlink-lag/A6-PROXY-${stamp}.md + .json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});