#!/usr/bin/env node
// 01-collector.mjs — Collecte temps réel des marchés BTC Up/Down 5min.
//
// Boucle (par défaut 1 s) :
//   1. Découvre les fenêtres btc-updown-5m (courante ± voisines) via Gamma.
//   2. Fetch CLOB book des 2 tokens → ticks kind='book' (bid/ask depth-1).
//   3. À la clôture : résolution Gamma → winnerIndex.
//   4. Rattrape les résolutions manquantes au démarrage.
//
// Usage : node audits/5min-strategies/01-collector.mjs [--interval=1000] [--once]
import { openDb, upsertWindow, insertTicksTx, upsertResolution, setMeta } from "./lib/tickdb.js";
import { GATEWAY } from "./lib/api.js";

const args = process.argv.slice(2);
const INTERVAL_MS = Number(args.find((a) => a.startsWith("--interval="))?.split("=")[1] ?? 1000);
const ONCE = args.includes("--once");
const PREFIX = "btc-updown-5m";
const POST_CLOSE_POLL_SEC = 90; // continue de poller 90 s après la fin du book

const db = openDb();

let lastBookTs = 0;

console.log(`[collector] interval=${INTERVAL_MS}ms`);
logStats();

let running = true;
process.on("SIGINT", () => {
  console.log("\n[collector] SIGINT — arrêt propre...");
  running = false;
});

// Cache mémoire : slug -> { startTs, endTs, tokenUp, tokenDown, resolved }
const known = new Map();
let loopCount = 0;

function bestOf(levels, mode) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  let best = null;
  for (const l of levels) {
    const p = Number(l.price);
    if (!Number.isFinite(p)) continue;
    if (best === null || (mode === "bid" ? p > best.p : p < best.p)) best = { p, s: Number(l.size) };
  }
  return best;
}

async function discoverWindows() {
  const nowSec = Math.floor(Date.now() / 1000);
  const currentStart = Math.floor(nowSec / 300) * 300;
  const candidates = [currentStart, currentStart + 300, currentStart + 600, currentStart - 300];
  for (const startTs of candidates) {
    const slug = `${PREFIX}-${startTs}`;
    if (known.has(slug)) continue;
    try {
      const ev = await GATEWAY.eventBySlug(slug);
      const market = ev?.markets?.[0];
      if (!market) continue;
      const tokenIds = GATEWAY.parseGammaList(market.clobTokenIds);
      const outcomes = GATEWAY.parseGammaList(market.outcomes).map((o) => o.toLowerCase());
      if (tokenIds.length !== 2 || tokenIds.some((t) => !t)) continue;
      const upIdx = outcomes.findIndex((o) => o.includes("up"));
      const downIdx = outcomes.findIndex((o) => o.includes("down"));
      if (upIdx < 0 || downIdx < 0 || upIdx === downIdx) continue;
      const info = {
        startTs,
        endTs: startTs + 300,
        tokenUp: tokenIds[upIdx],
        tokenDown: tokenIds[downIdx],
        conditionId: market.conditionId,
        resolved: false,
      };
      known.set(slug, info);
      upsertWindow(db, {
        slug, startTs, endTs: info.endTs,
        conditionId: info.conditionId,
        tokenUp: info.tokenUp, tokenDown: info.tokenDown,
        source: "collector",
      });
      console.log(`[collector] fenêtre suivie: ${slug}`);
    } catch (e) {
      if (startTs === currentStart) console.log(`[collector] fenêtre courante pas dispo: ${e.message}`);
    }
  }
}

async function pollBooks() {
  const nowSec = Math.floor(Date.now() / 1000);
  const batch = [];
  for (const [slug, info] of known) {
    if (nowSec > info.endTs + POST_CLOSE_POLL_SEC) continue;
    try {
      const [bookUp, bookDown] = await Promise.all([
        GATEWAY.book(info.tokenUp),
        GATEWAY.book(info.tokenDown),
      ]);
      const ts = Date.now();
      lastBookTs = ts;
      const sides = [
        [0, bookUp],
        [1, bookDown],
      ];
      for (const [side, book] of sides) {
        const bid = bestOf(book.bids, "bid");
        const ask = bestOf(book.asks, "ask");
        batch.push({
          slug, ts, side, kind: "book",
          bid: bid?.p ?? null, ask: ask?.p ?? null,
          bidSize: bid?.s ?? null, askSize: ask?.s ?? null,
        });
      }
    } catch {
      // book vide / erreur HTTP : le tick suivant retentera
    }
  }
  if (batch.length > 0) insertTicksTx(db, batch);
}

async function resolveWindows() {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [slug, info] of known) {
    if (info.resolved || nowSec < info.endTs + 10) continue;
    try {
      const res = await GATEWAY.resolution(slug);
      if (res) {
        upsertResolution(db, { slug, winnerIndex: res.winnerIndex, winner: res.winner, ts: Date.now(), source: "gamma" });
        upsertWindow(db, {
          slug, startTs: info.startTs, endTs: info.endTs,
          winnerIndex: res.winnerIndex, resolutionTs: Date.now(), source: "collector",
        });
        info.resolved = true;
        console.log(`[collector] ${slug} résolu: winner=${res.winner} (index ${res.winnerIndex})`);
      }
    } catch {
      /* retry next loop */
    }
  }
}

// Rattrapage des résolutions manquantes (ex. collector relancé après un arrêt).
async function backfillResolutions() {
  const rows = db.prepare(`
    SELECT w.slug, w.startTs, w.endTs FROM windows w
    LEFT JOIN resolutions r ON r.slug = w.slug
    WHERE w.slug LIKE ? AND r.slug IS NULL AND w.endTs < ?
    ORDER BY w.startTs DESC LIMIT 100
  `).all(`${PREFIX}-%`, Math.floor(Date.now() / 1000));
  let done = 0;
  for (const row of rows) {
    try {
      const res = await GATEWAY.resolution(row.slug);
      if (res) {
        upsertResolution(db, { slug: row.slug, winnerIndex: res.winnerIndex, winner: res.winner, ts: Date.now(), source: "gamma" });
        upsertWindow(db, {
          slug: row.slug, startTs: row.startTs, endTs: row.endTs,
          winnerIndex: res.winnerIndex, resolutionTs: Date.now(), source: "collector",
        });
        done++;
      }
      await GATEWAY.sleep(250);
    } catch {
      /* skip */
    }
  }
  if (done > 0) console.log(`[collector] backfill: ${done} résolution(s) récupérée(s)`);
}

function logStats() {
  const s = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM windows WHERE slug LIKE 'btc-updown-5m-%') AS windows,
      (SELECT COUNT(*) FROM ticks) AS ticks,
      (SELECT COUNT(*) FROM resolutions) AS resolutions,
      (SELECT COUNT(*) FROM windows WHERE winnerIndex IS NOT NULL) AS resolved
  `).get();
  console.log(`[collector] fenêtres=${s.windows} résolues=${s.resolved} ticks=${s.ticks} résolutions=${s.r} lastBook=${lastBookTs ? new Date(lastBookTs).toISOString() : "—"}`);
}

// Purge mémoire des fenêtres vieilles de > 3 h (elles sont en DB).
function pruneKnown() {
  const cutoff = Math.floor(Date.now() / 1000) - 3 * 3600;
  for (const [slug, info] of known) {
    if (info.endTs < cutoff && info.resolved) known.delete(slug);
  }
}

async function loop() {
  while (running) {
    try {
      await discoverWindows();
      await pollBooks();
      await resolveWindows();
      if (loopCount % 60 === 0) {
        await backfillResolutions();
        pruneKnown();
      }
    } catch (e) {
      console.error(`[collector] erreur boucle: ${e.message}`);
    }
    loopCount++;
    if (loopCount % 30 === 0) logStats();
    if (ONCE) break;
    await GATEWAY.sleep(INTERVAL_MS);
  }
  setMeta(db, "collectorLastRun", Date.now());
  db.close();
  console.log("[collector] arrêté");
}

await backfillResolutions();
await loop();