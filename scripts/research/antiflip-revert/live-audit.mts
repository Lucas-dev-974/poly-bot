// Audit live antiflip-revert v2 : vérification du signal avec la fenêtre fidèle
// au moteur (flip AVANT l'entrée, tick le plus proche de createdAt).
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/bot-live.db", { readOnly: true });

const positions = db
  .prepare(
    `SELECT * FROM positions WHERE strategyId = 'antiflip-revert' ORDER BY createdAt ASC`,
  )
  .all();

console.log("=== VERIFICATION SIGNAL v2 (fenêtre fidèle au moteur) ===");
console.log(
  "Gates attendus : flip récent (≤90s) AVANT l'entrée, nouveau favori 0.45-0.65,",
  "\ndéchu dans bande [0.35,0.45] + floor 0.40, elapsed ≥ 240s, spread ≤ 0.05\n",
);

for (const p of positions) {
  const slugStart = Number(p.eventSlug.split("-").pop());
  const entry = p.createdAt;
  const t0 = entry - 150_000;

  const snaps = db
    .prepare(
      `SELECT ts, outcomeIndex, bestAsk, bestBid FROM book_snapshots
       WHERE eventSlug = ? AND ts >= ? AND ts <= ? ORDER BY ts`,
    )
    .all(p.eventSlug, t0, entry);
  const byTs = new Map();
  for (const s of snaps) {
    let e = byTs.get(s.ts);
    if (!e) {
      e = {};
      byTs.set(s.ts, e);
    }
    if (s.outcomeIndex === 0) {
      e.upAsk = s.bestAsk;
      e.upBid = s.bestBid;
    } else {
      e.downAsk = s.bestAsk;
      e.downBid = s.bestBid;
    }
  }
  const sorted = [...byTs.entries()].sort((a, b) => a[0] - b[0]);
  let prevFav: number | null = null;
  let lastFlipTs: number | null = null;
  let lastTick: { ts: number; upAsk: number | null; downAsk: number | null; upBid: number | null; downBid: number | null } | null = null;
  for (const [ts, e] of sorted) {
    if (e.upAsk == null || e.downAsk == null) continue;
    const fav = e.upAsk >= e.downAsk ? 0 : 1;
    if (prevFav !== null && prevFav !== fav) lastFlipTs = ts;
    prevFav = fav;
    lastTick = { ts, ...e };
  }
  if (!lastTick) {
    console.log(`${p.eventSlug.slice(-10)} : pas de tick avant l'entrée`);
    continue;
  }
  const favIdx = lastTick.upAsk! >= lastTick.downAsk! ? 0 : 1;
  const favAsk = favIdx === 0 ? lastTick.upAsk : lastTick.downAsk;
  const deposedAsk = favIdx === 0 ? lastTick.downAsk : lastTick.upAsk;
  const deposedBid = favIdx === 0 ? lastTick.downBid : lastTick.upBid;
  const flipAgeSec = lastFlipTs ? (entry - lastFlipTs) / 1000 : null;
  const elapsedSec = (entry - slugStart * 1000) / 1000;
  const spread = deposedAsk != null && deposedBid != null ? deposedAsk - deposedBid : null;

  const checks = {
    "flip frais ≤90s": flipAgeSec !== null && flipAgeSec >= 0 && flipAgeSec <= 90,
    "flip existe": lastFlipTs !== null,
    "nouveau fav 0.45-0.65": favAsk != null && favAsk >= 0.45 && favAsk <= 0.65,
    "déchu dans bande 0.35-0.45":
      deposedAsk != null && deposedAsk >= 0.35 && deposedAsk <= 0.45,
    "floor déchu ≥0.40": deposedAsk != null && deposedAsk >= 0.40,
    "spread ≤0.05": spread != null && spread <= 0.05,
    "elapsed ≥240s": elapsedSec >= 240,
    "achat du DÉCHU (outcome opposé au favori)":
      (favIdx === 0 && p.outcomeIndex === 1) || (favIdx === 1 && p.outcomeIndex === 0),
  };
  const allOk = Object.values(checks).every(Boolean);
  console.log(
    `${p.eventSlug.slice(-10)} | entry ${p.outcome}@${p.fillPrice} (fill -0.01 vs tick ${deposedAsk}) | flipAge=${flipAgeSec?.toFixed(0)}s | fav=${favAsk} | déchu=${deposedAsk} | spread=${spread?.toFixed(3)} | elapsed=${elapsedSec.toFixed(0)}s`,
  );
  for (const [k, v] of Object.entries(checks)) {
    if (!v) console.log(`   ✗ ${k}`);
  }
  if (allOk) console.log("   ✓ tous les gates passent — signal fidèle au backtest");
  console.log("");
}

// Résolution vs position : la fenêtre de la position open
const openPos = positions.find((p) => p.status === "open");
if (openPos) {
  const res = db
    .prepare("SELECT winnerOutcomeIndex, ts FROM market_resolutions WHERE eventSlug = ?")
    .get(openPos.eventSlug);
  const now = Date.now();
  const windowEndMs = openPos.windowEnd * 1000;
  console.log(
    `Position open : ${openPos.eventSlug.slice(-10)} ${openPos.outcome}@${openPos.fillPrice} — fenêtre finit ${new Date(windowEndMs).toISOString()} (${Math.round((windowEndMs - now) / 1000)}s restantes)`,
  );
  if (res) console.log(`  déjà résolue : winner=${res.winnerOutcomeIndex}`);
}

const mx = db.prepare("SELECT MAX(ts) as m FROM book_snapshots").get();
console.log(`\nfreshness: dernier tick ${new Date(mx.m).toISOString()}`);
db.close();