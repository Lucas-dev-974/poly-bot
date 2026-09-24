#!/usr/bin/env node
// 02b-import-botdb.mjs — Import des données 5m enregistrées par la base du bot
// (data/bot-live.db → book_snapshots @1Hz + market_resolutions).
//
// NOTE : import de DONNÉES uniquement (lecture seule). Aucune logique du bot
// n'est réutilisée — les scripts de ce dossier sont indépendants.
//
// Les book_snapshots du bot sont des ticks "book" (bid/ask + depth 3) à ~1 Hz
// sur les fenêtres btc-updown-5m : la source la plus dense disponible.
// Les résolutions manquantes sont rattrapées via Gamma.
//
// Usage : node 02b-import-botdb.mjs [--botdb=../../data/bot-live.db] [--prefix=btc-updown-5m]
import { DatabaseSync } from "node:sqlite";
import { openDb, upsertWindow, insertTicksTx, upsertResolution, setMeta } from "./lib/tickdb.js";
import { GATEWAY } from "./lib/api.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  }),
);

const PREFIX = args.prefix ?? "btc-updown-5m";
const BOT_DB = args.botdb ?? join(HERE, "..", "..", "data", "bot-live.db");
const GAMMA_BACKFILL = args["gamma-backfill"] !== "false"; // défaut on

console.log(`[botdb] source: ${BOT_DB}`);
console.log(`[botdb] prefix: ${PREFIX}`);

const bot = new DatabaseSync(BOT_DB, { readOnly: true });
const db = openDb();

// 1. Résolutions du bot (table market_resolutions, source gamma).
const resolutions = bot.prepare(`
  SELECT eventSlug, winnerOutcomeIndex, ts FROM market_resolutions WHERE eventSlug LIKE ?
`).all(`${PREFIX}-%`);
console.log(`[botdb] ${resolutions.length} résolutions dans la base du bot`);
const resBySlug = new Map(resolutions.map((r) => [r.eventSlug, r]));

// 2. Fenêtres avec book_snapshots (windowStart dérivé du slug : 10 derniers chiffres).
const windows = bot.prepare(`
  SELECT eventSlug, COUNT(*) AS n, COUNT(DISTINCT tokenId) AS tokens
  FROM book_snapshots WHERE eventSlug LIKE ?
  GROUP BY eventSlug ORDER BY eventSlug
`).all(`${PREFIX}-%`).map((w) => ({
  ...w,
  startTs: Number(w.eventSlug.match(/-(\d{10})$/)?.[1] ?? 0),
})).filter((w) => w.startTs > 0);
console.log(`[botdb] ${windows.length} fenêtres avec des books`);

// 3. Mapping tokenId → outcomeIndex depuis un échantillon.
const outcomeMap = new Map(); // tokenId -> { side, outcome }
const oRows = bot.prepare(`
  SELECT DISTINCT tokenId, outcome, outcomeIndex FROM book_snapshots WHERE eventSlug LIKE ?
`).all(`${PREFIX}-%`);
for (const r of oRows) {
  const side = r.outcomeIndex === 0 ? 0 : 1;
  outcomeMap.set(r.tokenId, { side, outcome: r.outcome });
}
console.log(`[botdb] ${outcomeMap.size} tokens mappés`);

let imported = 0, lowData = 0, withWinner = 0;
const t0 = Date.now();
const preparedWindows = []; // { slug, startTs, endTs, n } pour le backfill Gamma

for (const w of windows) {
  const res = resBySlug.get(w.eventSlug);
  const endTs = w.startTs + 300;

  // Ticks par token.
  const rows = bot.prepare(`
    SELECT ts, tokenId, outcomeIndex, bestBid, bestAsk, bestBidSize, bestAskSize
    FROM book_snapshots WHERE eventSlug = ? ORDER BY ts
  `).all(w.eventSlug);

  const ticks = rows.map((r) => {
    const side = r.outcomeIndex === 0 ? 0 : 1;
    return {
      slug: w.eventSlug,
      ts: Number(r.ts),
      side,
      kind: "book",
      bid: r.bestBid,
      ask: r.bestAsk,
      bidSize: r.bestBidSize,
      askSize: r.bestAskSize,
    };
  });

  const upTicks = ticks.filter((t) => t.side === 0).length;
  const downTicks = ticks.filter((t) => t.side === 1).length;
  if (upTicks < 20 || downTicks < 20) { lowData++; continue; }

  upsertWindow(db, {
    slug: w.eventSlug,
    startTs: w.startTs,
    endTs,
    winnerIndex: res?.winnerOutcomeIndex ?? null,
    resolutionTs: res ? Number(res.ts) : null,
    tradeCount: ticks.length,
    source: "botdb",
  });
  if (res) {
    upsertResolution(db, {
      slug: w.eventSlug,
      winnerIndex: res.winnerOutcomeIndex,
      winner: null,
      ts: Number(res.ts),
      source: "bot-db",
    });
    withWinner++;
  } else {
    preparedWindows.push({ slug: w.eventSlug, startTs: w.startTs, endTs });
  }
  insertTicksTx(db, ticks);
  imported++;
  if (imported % 100 === 0) console.log(`[botdb] ${imported} fenêtres importées...`);
}

console.log(`\n[botdb] import terminé en ${((Date.now() - t0) / 1000).toFixed(0)}s: imported=${imported} withWinner=${withWinner} lowData=${lowData}`);
setMeta(db, "botdbLastImport", Date.now());
setMeta(db, "botdbLastImportCount", imported);
bot.close();

// 4. Backfill Gamma des résolutions manquantes.
// Gamma garde les événements 5m fermés plusieurs jours : on les résout un par un.
let gammaResolved = 0;
if (GAMMA_BACKFILL && preparedWindows.length > 0) {
  // Trier du plus récent au plus ancien (les plus récents ont le plus de chance d'être gardés).
  const targets = preparedWindows.sort((a, b) => b.startTs - a.startTs);
  console.log(`[botdb] ${targets.length} fenêtres sans résolution, tentative Gamma...`);
  for (const row of targets) {
    try {
      const res = await GATEWAY.resolution(row.slug);
      if (res) {
        upsertResolution(db, { slug: row.slug, winnerIndex: res.winnerIndex, winner: res.winner, ts: Date.now(), source: "gamma" });
        upsertWindow(db, { slug: row.slug, startTs: row.startTs, endTs: row.endTs, winnerIndex: res.winnerIndex, resolutionTs: Date.now(), source: "botdb" });
        gammaResolved++;
        if (gammaResolved % 50 === 0) console.log(`[botdb] gamma: ${gammaResolved}/${targets.length} résolutions récupérées...`);
      }
      await GATEWAY.sleep(250);
    } catch {
      /* skip */
    }
  }
  console.log(`[botdb] gamma backfill: ${gammaResolved}/${targets.length} résolutions récupérées`);
}

// Bilan final.
const final = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM windows WHERE slug LIKE ?) AS windows,
    (SELECT COUNT(*) FROM windows WHERE slug LIKE ? AND winnerIndex IS NOT NULL) AS resolved,
    (SELECT COUNT(*) FROM ticks) AS ticks
`).all(`${PREFIX}-%`, `${PREFIX}-%`)[0];
console.log(`[botdb] état DB: fenêtres=${final.windows} résolues=${final.resolved} ticks=${final.ticks}`);

db.close();