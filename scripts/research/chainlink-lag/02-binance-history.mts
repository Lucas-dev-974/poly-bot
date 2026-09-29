/**
 * Phase 0 / Task 0.3 — Profondeur de l'historique klines 1s Binance (A3).
 * Plan : "profondeur des klines 1s REST (limit 1000/requête) couvrant les
 * fenêtres du dataset backtest (~8 j). Si insuffisant → backtest limité aux
 * fenêtres futures (collecte live dès Phase 1)."
 *
 * Vérifie, pour chaque fenêtre résolue du dataset, si les klines 1s existent
 * encore côté Binance (les klines 1s ont une rétention limitée ~3 mois, la
 * question est surtout la couverture réelle + les trous de maintenance).
 * Utilise le même cache que 01-twap-proxy.mts (data/chainlink-lag-cache/).
 *
 * Sortie : audits/chainlink-lag/A3-HISTORY-<stamp>.md
 *
 *   npx tsx scripts/research/chainlink-lag/02-binance-history.mts
 *   Env: SAMPLE=120 (fenêtres échantillonnées), BUDGET=60
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = "data/bot-live.db";
const CACHE_DIR = "data/chainlink-lag-cache/klines-1s";
const BINANCE_REST = "https://api.binance.com/api/v3/klines";
const SAMPLE = Number(process.env.SAMPLE ?? 120);
const BUDGET = Number(process.env.BUDGET ?? 60);
const WINDOW_SEC = 900;

const SYMBOLS = [
  { symbol: "BTCUSDT", like: "btc-updown-15m-%" },
  { symbol: "ETHUSDT", like: "eth-updown-15m-%" },
];

let requestCount = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function loadCache(symbol: string): Map<number, { closeTime: number }> {
  const map = new Map<number, { closeTime: number }>();
  const file = join(CACHE_DIR, `${symbol}.json`);
  if (!existsSync(file)) return map;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Array<[number, number]>;
    for (const [openTime, closeTime] of raw) map.set(openTime, { closeTime });
  } catch {
    /* cache absent/corrompu */
  }
  return map;
}

/** Fetch léger : 1 requête de 1000 barres 1s à partir de startSec (sonde). */
async function probeKlines(symbol: string, startSec: number): Promise<number> {
  if (requestCount >= BUDGET) return -1;
  const url = `${BINANCE_REST}?symbol=${symbol}&interval=1s&startTime=${startSec * 1000}&limit=1000`;
  requestCount++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return -1;
    const rows = (await res.json()) as Array<[number, ...unknown[]]>;
    return rows.length;
  } catch {
    return -1;
  } finally {
    clearTimeout(timer);
  }
}

function parseWindowStart(slug: string): number | null {
  const parts = slug.split("-");
  const startSec = Number(parts[parts.length - 1]);
  return Number.isFinite(startSec) && startSec > 1e9 ? startSec : null;
}

interface Win {
  slug: string;
  wsSec: number;
  asset: string;
}

async function main(): Promise<void> {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const stmt = db.prepare(
    `SELECT eventSlug FROM market_resolutions
     WHERE eventSlug LIKE ? ORDER BY eventSlug`,
  );
  const allWins: Win[] = [];
  for (const s of SYMBOLS) {
    const rows = stmt.all(s.like) as Array<{ eventSlug: string }>;
    for (const r of rows) {
      const ws = parseWindowStart(r.eventSlug);
      if (ws == null) continue;
      allWins.push({ slug: r.eventSlug, wsSec: ws, asset: s.symbol === "BTCUSDT" ? "btc" : "eth" });
    }
  }
  db.close();
  console.log(`fenêtres résolues: ${allWins.length}`);

  // Échantillonner régulièrement sur la durée (couverture temporelle équitable).
  const sorted = [...allWins].sort((a, b) => a.wsSec - b.wsSec);
  const step = Math.max(1, Math.floor(sorted.length / SAMPLE));
  const sample: Win[] = [];
  for (let i = 0; i < sorted.length && sample.length < SAMPLE; i += step) sample.push(sorted[i]);

  // Pour chaque fenêtre échantillonnée : 3 sondes (début, milieu, fin de fenêtre)
  // -> couverture klines = 2e disponibles / 3 requises (approx). En plus on
  // vérifie la complétude fine via le cache 01 (si présent).
  const lines: string[] = [];
  lines.push("# A3 — Profondeur klines 1s Binance vs fenêtres du dataset");
  lines.push("");
  lines.push(`- Généré: ${new Date().toISOString()}`);
  lines.push(`- Sondes: 3 requêtes de 1000 barres par fenêtre échantillonnée (début/milieu/fin, fenêtre 900 s = 900 barres 1s)`);
  lines.push(`- Échantillon: ${sample.length}/${allWins.length} fenêtres (BUDGET=${BUDGET} requêtes partagées)`);
  lines.push("");

  const byAsset = new Map<string, { ok: number; partial: number; none: number; total: number }>();
  const detail: Array<{ slug: string; asset: string; cov: string; ws: string }> = [];
  let budgetExhausted = false;

  for (const w of sample) {
    const symbol = w.asset === "btc" ? "BTCUSDT" : "ETHUSDT";
    if (budgetExhausted) {
      detail.push({ slug: w.slug, asset: w.asset, cov: "skipped-budget", ws: new Date(w.wsSec * 1000).toISOString() });
      continue;
    }
    const probes = [w.wsSec, w.wsSec + 400, w.wsSec + WINDOW_SEC - 100];
    let found = 0;
    for (const p of probes) {
      const n = await probeKlines(symbol, p);
      if (n < 0) {
        budgetExhausted = requestCount >= BUDGET;
        continue;
      }
      // n barres retournées sur 1000 demandées : la zone [p, p+999] est
      // couverte si n est proche de la zone demandée (on sonde 900 s).
      if (n >= 900) found++;
      else if (n > 0) found += 0.5;
    }
    const cov = found >= 3 ? "full" : found > 0 ? "partial" : "none";
    const cur = byAsset.get(w.asset) ?? { ok: 0, partial: 0, none: 0, total: 0 };
    cur.total++;
    if (cov === "full") cur.ok++;
    else if (cov === "partial") cur.partial++;
    else cur.none++;
    byAsset.set(w.asset, cur);
    detail.push({ slug: w.slug, asset: w.asset, cov, ws: new Date(w.wsSec * 1000).toISOString() });
    await sleep(150);
  }

  lines.push(`Requêtes utilisées: ${requestCount}/${BUDGET}`);
  lines.push("");
  lines.push("| Asset | Fenêtres | full | partial | none |");
  lines.push("|---|---|---|---|---|");
  for (const [asset, c] of byAsset) {
    lines.push(`| ${asset} | ${c.total} | ${c.ok} | ${c.partial} | ${c.none} |`);
  }
  lines.push("");

  // Couverture cache (complétude fine si 01 a déjà tourné).
  lines.push("## Complétude fine via cache local (01-twap-proxy)");
  lines.push("");
  for (const s of SYMBOLS) {
    const cache = loadCache(s.symbol);
    if (cache.size === 0) {
      lines.push(`- ${s.symbol}: cache absent/vide`);
      continue;
    }
    const times = [...cache.keys()].sort((a, b) => a - b);
    let holes = 0;
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > 1) holes += times[i] - times[i - 1] - 1;
    const spanDays = (times[times.length - 1] - times[0]) / 86400;
    lines.push(
      `- ${s.symbol}: ${cache.size} barres sur ${spanDays.toFixed(2)} j (${new Date(times[0] * 1000).toISOString()} -> ${new Date(times[times.length - 1] * 1000).toISOString()}), trous cumulés: ${holes} s`,
    );
  }
  lines.push("");

  lines.push("## Verdict A3");
  lines.push("");
  const totalOk = [...byAsset.values()].reduce((a, c) => a + c.ok, 0);
  const total = [...byAsset.values()].reduce((a, c) => a + c.total, 0);
  const okPct = total ? (totalOk / total) * 100 : NaN;
  if (Number.isNaN(okPct)) {
    lines.push("**INDÉTERMINÉ** — budget épuisé avant mesure.");
  } else if (okPct >= 90) {
    lines.push(`**OK** — ${okPct.toFixed(1)}% des fenêtres échantillonnées sont couvertes en klines 1s : backfill historique viable (Task 1.5).`);
  } else if (okPct >= 50) {
    lines.push(`**PARTIEL** — ${okPct.toFixed(1)}% seulement : backtest limité aux fenêtres couvertes + repli collecte live (Phase 2 décalée).`);
  } else {
    lines.push(`**INSUFFISANT** — ${okPct.toFixed(1)}% : l'historique klines 1s ne couvre pas le dataset → collecte live 3-5 j requise avant Phase 2.`);
  }
  lines.push("");

  mkdirSync("audits/chainlink-lag", { recursive: true });
  const stamp = Date.now();
  writeFileSync(`audits/chainlink-lag/A3-HISTORY-${stamp}.md`, lines.join("\n"));
  writeFileSync(
    `audits/chainlink-lag/A3-HISTORY-${stamp}.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), sample, detail, byAsset: [...byAsset] }, null, 2),
  );
  console.log(lines.join("\n"));
  console.log(`\nÉcrit: audits/chainlink-lag/A3-HISTORY-${stamp}.md + .json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});