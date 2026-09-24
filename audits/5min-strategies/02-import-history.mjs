#!/usr/bin/env node
// 02-import-history.mjs — Import de l'historique 5m BTC via l'API /trades de Polymarket.
//
// Principe : chaque trade exécuté (prix + taille + side) est un point de donnée
// "trade". Ces points, triés par timestamp, constituent une série temporelle
// dense (~10-60 trades/5min par token) qui reconstitue le chemin du marché.
// Le collector ajoute les ticks 'book' (bid/ask) à 1 Hz sur les fenêtres futures.
//
// Pour chaque fenêtre : fetch trades des 2 tokens + résolution Gamma.
//
// Usage :
//   node 02-import-history.mjs                       # fenêtres des 2 derniers jours
//   node 02-import-history.mjs --hours=48            # période personnalisée
//   node 02-import-history.mjs --from=1790000000 --to=1790140000
//   node 02-import-history.mjs --max-windows=200     # garde-fou
import { openDb, upsertWindow, insertTicksTx, upsertResolution, getMeta, setMeta } from "./lib/tickdb.js";
import { GATEWAY } from "./lib/api.js";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  }),
);

const PREFIX = "btc-updown-5m";
const nowSec = Math.floor(Date.now() / 1000);
const FROM = args.from ? Number(args.from) : nowSec - (Number(args.hours ?? 48) * 3600);
const TO = args.to ? Number(args.to) : nowSec;
const MAX_WINDOWS = Number(args["max-windows"] ?? 0); // 0 = illimité
const SKIP_EXISTING = args["skip-existing"] === "true";
const DRY = args.dry === "true";

console.log(`[history] fenêtres ${FROM} → ${TO} (${Math.round((TO - FROM) / 300)} fenêtres potentielles)`);

const db = openDb();

// Découverte des slugs par balayage des tags 5M (comme le scanner du bot).
// Gamma tag "5M" + filtre par fenêtre temporelle : on scanne par plages.
async function discoverSlugs() {
  const slugs = new Map(); // slug -> { startTs }
  // Balayage 5m par 5m de FROM à TO : fetch direct par slug (l'API /events?slug= marche sur les fenêtres passées).
  // 48h = 576 requêtes — trop. On utilise le tag "5M" paginé (limit 100, ~12 pages pour couvrir 576 fenêtres).
  const url = new URL("/events", GATEWAY.GAMMA_HOST);
  url.searchParams.set("tag_slug", "5M");
  url.searchParams.set("closed", "true");
  url.searchParams.set("end_date_min", new Date(FROM * 1000).toISOString());
  url.searchParams.set("limit", "100");
  for (let offset = 0; offset < 4000; offset += 100) {
    url.searchParams.set("offset", String(offset));
    let events;
    try {
      events = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).json();
    } catch (e) {
      console.warn(`[history] scan page offset=${offset} failed: ${e.message}`);
      break;
    }
    if (!Array.isArray(events) || events.length === 0) break;
    let inRange = 0;
    for (const e of events) {
      if (!e.slug?.startsWith(`${PREFIX}-`)) continue;
      const startTs = Number(e.slug.match(/-(\d{10})$/)?.[1] ?? 0);
      if (startTs < FROM || startTs > TO) continue;
      inRange++;
      slugs.set(e.slug, { startTs, title: e.title, conditionId: e.markets?.[0]?.conditionId });
    }
    console.log(`[history] scan offset=${offset}: ${events.length} events, ${inRange} btc 5m in range`);
    if (events.length < 100) break;
    await GATEWAY.sleep(400);
  }
  return slugs;
}

console.log("[history] scan Gamma (closed=true, tag 5M)...");
const slugs = await discoverSlugs();
console.log(`[history] ${slugs.size} fenêtres btc-updown-5m trouvées dans la plage`);

if (slugs.size === 0) {
  console.log("[history] rien à importer");
  process.exit(0);
}

const targets = [...slugs.entries()].sort((a, b) => a[1].startTs - b[1].startTs);
const filtered = MAX_WINDOWS > 0 ? targets.slice(-MAX_WINDOWS) : targets;
console.log(`[history] ${filtered.length} fenêtres à importer${DRY ? " (DRY RUN)" : ""}`);

let imported = 0, skipped = 0, noTrades = 0, noResolution = 0;
const t0 = Date.now();

for (const [slug, meta] of filtered) {
  if (SKIP_EXISTING) {
    const existing = db.prepare("SELECT winnerIndex, tradeCount FROM windows WHERE slug = ?").get(slug);
    if (existing?.winnerIndex != null && (existing.tradeCount ?? 0) > 0) {
      skipped++;
      continue;
    }
  }

  // Résolution d'abord (si indisponible, la fenêtre est inutilisable pour le backtest).
  const res = await GATEWAY.resolution(slug);
  if (!res) {
    noResolution++;
    console.log(`[history] ${slug}: pas de résolution, skip`);
    continue;
  }

  const conditionId = res.conditionId ?? meta.conditionId;
  if (!conditionId) {
    noResolution++;
    continue;
  }

  // Tokens depuis Gamma.
  let tokenUp = null, tokenDown = null;
  if (res.clobTokenIds.length === 2) {
    tokenUp = res.clobTokenIds[0];
    tokenDown = res.clobTokenIds[1];
  }

  // Trades du marché (les 2 tokens ensemble : data-api indexe par conditionId).
  const trades = await GATEWAY.allTrades(conditionId, {
    onProgress: (n) => console.log(`[history]   ${slug}: ${n} trades...`),
  });

  if (trades.length === 0) {
    noTrades++;
    continue;
  }

  // Convertit les trades en ticks (les 2 tokens sont mélangés : side par outcomeIndex).
  let upCount = 0, downCount = 0;
  for (const tr of trades) {
    if (tr.outcomeIndex === 0) upCount++;
    else downCount++;
  }

  // Upsert fenêtre + résolution + ticks.
  if (!DRY) {
    upsertWindow(db, {
      slug,
      startTs: meta.startTs,
      endTs: meta.startTs + 300,
      conditionId,
      tokenUp, tokenDown,
      winnerIndex: res.winnerIndex,
      resolutionTs: Date.now(),
      tradeCount: trades.length,
      source: "history",
    });
    upsertResolution(db, { slug, winnerIndex: res.winnerIndex, winner: res.winner, ts: Date.now(), source: "gamma" });
    insertTicksTx(db, trades.map((tr) => ({
      slug,
      ts: Number(tr.timestamp) * 1000,
      side: tr.outcomeIndex === 0 ? 0 : 1,
      kind: "trade",
      price: Number(tr.price),
      size: Number(tr.size),
      tradeSide: tr.side,
    })));
  }

  imported++;
  console.log(`[history] ${slug}: ${trades.length} trades (Up=${upCount} Down=${downCount}) winner=${res.winner}`);
  await GATEWAY.sleep(200);
}

console.log(`\n[history] terminé en ${((Date.now() - t0) / 1000).toFixed(0)}s: imported=${imported} skipped=${skipped} noTrades=${noTrades} noResolution=${noResolution}`);
setMeta(db, "historyLastImport", Date.now());
setMeta(db, "historyLastImportCount", imported);
db.close();