#!/usr/bin/env node
// 12 — Calibration ciblée : chercher des conditions à WR > 60 % avec prix
// d'entrée ≤ 0.40 (5 shares ≤ 2 $, gain si win = 5 − 5×ask ≥ 3 $).
//
// Méthode : pour chaque tick, calculer des caractéristiques observables
// (identité du leader, momentum de chaque côté, dislocation askUp+askDown,
// stabilité du leader, profondeur du sous-pricing) puis croiser les
// conditions et mesurer P(win | condition) en hold-to-resolution (5 shares).
//
// Sorties :
//   - classement FULL dataset (découverte)
//   - split chronologique 50/50 IS/OOS pour valider les meilleures cellules
//   - export JSON results/cal60.json

import { openDb, loadWindows } from "./lib/tickdb.js";
import { seriesAtOrBefore } from "./lib/engine-helpers.js";
import { writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  }),
);
const MIN_N = Number(args["min-n"] ?? 250);

const db = openDb();
const windows = loadWindows(db, { minTicks: 100 });
console.log(`[cal60] ${windows.length} fenêtres, min n = ${MIN_N}`);

// ── Buckets ─────────────────────────────────────────────────────────────────
// 3 maps : ALL / IS / OOS (split chronologique 50/50 par index de fenêtre).
const B_ALL = new Map(), B_IS = new Map(), B_OOS = new Map();
const midChrono = windows.length / 2;

// (version propre)
function bookSide(map, key, side, winnerIndex, ask) {
  let b = map.get(key);
  if (!b) {
    b = { n: 0, wins: 0, pnl5: 0, cost: 0 };
    map.set(key, b);
  }
  const cost = 5 * ask;
  const credit = side === winnerIndex ? 5 : 0;
  b.n++;
  b.cost += cost;
  b.pnl5 += credit - cost;
  if (credit > 0) b.wins++;
}

// ── État par fenêtre pour les caractéristiques ──────────────────────────────
let windowIndex = 0;
for (const win of windows) {
  const half = windowIndex < midChrono ? "IS" : "OOS";
  windowIndex++;

  const up = win.ticksUp, down = win.ticksDown;
  const startMs = win.startTs * 1000, endMs = win.endTs * 1000;
  const windowMs = endMs - startMs;
  const winnerIndex = win.winnerIndex;

  // État glissant de la fenêtre.
  let prevFav = null;
  let flipTs = null;

  for (let t = startMs; t < endMs - 10_000; t += 1000) {
    const u = seriesAtOrBefore(up, t);
    const d = seriesAtOrBefore(down, t);
    if (!u?.ask || !d?.ask) continue;
    const askUp = u.ask, askDown = d.ask;
    const favIdx = askUp >= askDown ? 0 : 1;
    const favAsk = favIdx === 0 ? askUp : askDown;
    const dogAsk = favIdx === 0 ? askDown : askUp;

    // Flip : changement d'identité du favori.
    if (prevFav !== null && favIdx !== prevFav) flipTs = t;
    const sinceFlipMs = flipTs == null ? null : t - flipTs;
    prevFav = favIdx;

    // Momentum : ask il y a 30s (par token).
    const upPast = seriesAtOrBefore(up, t - 30_000);
    const downPast = seriesAtOrBefore(down, t - 30_000);
    const upMom = upPast?.ask != null ? askUp - upPast.ask : null;
    const downMom = downPast != null && downPast.ask != null ? askDown - downPast.ask : null;

    const frac = (t - startMs) / windowMs;
    const dislocation = askUp + askDown; // < 1 : sous-cotation globale

    // ── CANDIDATS (achat à ≤ 0.40 ⇒ gain ≥ 3$ sur 5 shares) ──
    // C1 : buy UNDERDOG (anti-leader) par bande de prix × momentum underdog.
    {
      const pBand =
        dogAsk < 0.20 ? "<0.20" : dogAsk < 0.30 ? "0.20-0.30" : dogAsk < 0.40 ? "0.30-0.40" : "0.40+";
      const momBand = upMom == null ? "na" : upMom <= -0.10 ? "mom≤-10" : upMom < 0 ? "mom<0" : "mom≥0";
      // (momentum du underdog = momentum du token anti-leader)
      const dogMom = favIdx === 0 ? downMom : upMom;
      const dmBand = dogMom == null ? "na" : dogMom <= -0.10 ? "≤-10¢" : dogMom < 0 ? "-10..0" : "≥0";
      const fBand = frac < 0.25 ? "00-25%" : frac < 0.5 ? "25-50%" : frac < 0.75 ? "50-75%" : "75%+";
      const key = `BUY-DOG ${pBand} ${dmBand} ${fBand}`;
      const side = 1 - favIdx;
      for (const [m, h] of [[B_ALL, "ALL"], [B_IS, "IS"], [B_OOS, "OOS"]]) {
        if (h === "IS" && half !== "IS") continue;
        if (h === "OOS" && half !== "OOS") continue;
        bookSide(m, key, side, winnerIndex, dogAsk);
      }
    }
    // C2 : buy FAVORI pas cher (0.30-0.40 : le favori n'est pas si fort).
    if (favAsk <= 0.4) {
      const momBand = (favIdx === 0 ? upMom : downMom) == null
        ? "na"
        : (favIdx === 0 ? upMom : downMom) >= 0.05
          ? "mom≥+5¢"
          : (favIdx === 0 ? upMom : downMom) > -0.05
            ? "mom~0"
            : "mom≤-5¢";
      const fBand = frac < 0.25 ? "00-25%" : frac < 0.5 ? "25-50%" : frac < 0.75 ? "50-75%" : "75%+";
      const key = `BUY-FAV ≤0.40 ${momBand} ${fBand}`;
      for (const [m, h] of [[B_ALL, "ALL"], [B_IS, "IS"], [B_OOS, "OOS"]]) {
        if (h === "IS" && half !== "IS") continue;
        if (h === "OOS" && half !== "OOS") continue;
        bookSide(m, key, favIdx, winnerIndex, favAsk);
      }
    }
    // C3 : dislocation (somme des asks < 1) — buy le sous-coté relatif (le plus bas des deux ≤ 0.40).
    if (dislocation <= 0.96) {
      const dBand = dislocation < 0.90 ? "<0.90" : "0.90-0.96";
      const cheaper = askUp <= askDown ? 0 : 1;
      const cheaperAsk = cheaper === 0 ? askUp : askDown;
      if (cheaperAsk <= 0.4) {
        const key = `BUY-CHEAPER dis${dBand}`;
        for (const [m, h] of [[B_ALL, "ALL"], [B_IS, "IS"], [B_OOS, "OOS"]]) {
          if (h === "IS" && half !== "IS") continue;
          if (h === "OOS" && half !== "OOS") continue;
          bookSide(m, key, cheaper, winnerIndex, cheaperAsk);
        }
      }
    }
    // C4 : underdog dans [0.30,0.40] SANS flip récent (leader stable ≥ 60s).
    if (dogAsk >= 0.3 && dogAsk <= 0.4) {
      const stable = sinceFlipMs == null || sinceFlipMs >= 60_000;
      const key = `BUY-DOG stable60 ${stable ? "oui" : "non"} (flip${sinceFlipMs == null ? "jamais" : Math.round(sinceFlipMs / 1000) + "s"})`;
      const side = 1 - favIdx;
      const fBand = frac < 0.5 ? "00-50%" : "50%+";
      const stableKey = `BUY-DOG stable ${stable ? "≥60s" : "<60s"} ${fBand}`;
      for (const [m, h] of [[B_ALL, "ALL"], [B_IS, "IS"], [B_OOS, "OOS"]]) {
        if (h === "IS" && half !== "IS") continue;
        if (h === "OOS" && half !== "OOS") continue;
        bookSide(m, stableKey, side, winnerIndex, dogAsk);
      }
    }
    // C5 : post-flip tardif (> 60s) : le marché a digéré, buy underdog 0.30-0.40.
    if (sinceFlipMs != null && sinceFlipMs >= 60_000 && dogAsk >= 0.3 && dogAsk <= 0.4) {
      const key = `BUY-DOG flip>60s`;
      for (const [m, h] of [[B_ALL, "ALL"], [B_IS, "IS"], [B_OOS, "OOS"]]) {
        if (h === "IS" && half !== "IS") continue;
        if (h === "OOS" && half !== "OOS") continue;
        bookSide(m, key, 1 - favIdx, winnerIndex, dogAsk);
      }
    }
    // C6 : leader fort en momentum (mom ≥ +10¢/30s) mais ask ≤ 0.40 (rare).
    if (favAsk <= 0.4 && (favIdx === 0 ? upMom : downMom) != null && (favIdx === 0 ? upMom : downMom) >= 0.10) {
      const key = `BUY-FAV ≤0.40 mom≥+10¢`;
      for (const [m, h] of [[B_ALL, "ALL"], [B_IS, "IS"], [B_OOS, "OOS"]]) {
        if (h === "IS" && half !== "IS") continue;
        if (h === "OOS" && half !== "OOS") continue;
        bookSide(m, key, favIdx, winnerIndex, favAsk);
      }
    }
  }
}

// ── Restitution ─────────────────────────────────────────────────────────────
function dump(map, title, minN) {
  const rows = [...map.entries()]
    .filter(([, b]) => b.n >= minN)
    .map(([k, b]) => ({
      key: k,
      n: b.n,
      wr: b.wins / b.n,
      avgCost: b.cost / b.n,
      pnl5: b.pnl5 / b.n,
    }))
    .sort((a, b) => b.wr - a.wr);
  console.log(`\n=== ${title} (n ≥ ${minN}, trié par WR) ===`);
  console.log("condition                                       |     n |    WR  | coût | PnL/5sh");
  for (const r of rows) {
    const gain = 5 - r.avgCost;
    console.log(
      `${r.key.padEnd(46)} | ${String(r.n).padStart(5)} | ${(r.wr * 100).toFixed(1).padStart(5)}% | ${r.avgCost.toFixed(2)} | ${(r.pnl5 >= 0 ? "+" : "") + r.pnl5.toFixed(2)}$ (gain win ${gain.toFixed(2)}$)`,
    );
  }
  return rows;
}

const allRows = dump(B_ALL, "TOUTES les fenêtres", MIN_N);

// IS/OOS pour les meilleures cellules (WR ≥ 55% full, n ≥ 2×minN).
const cands = allRows.filter((r) => r.wr >= 0.55 && r.n >= 2 * MIN_N);
console.log(`\n=== Validation IS/OOS des ${cands.length} candidates (WR≥55%, n≥${2 * MIN_N}) ===`);
const validated = [];
for (const c of cands) {
  const is = B_IS.get(c.key);
  const oos = B_OOS.get(c.key);
  const fmt = (b) =>
    b == null
      ? "        —"
      : `n=${String(b.n).padStart(4)} ${(100 * b.wins / b.n).toFixed(1).padStart(5)}%`;
  const oosWr = oos && oos.n >= MIN_N ? oos.wins / oos.n : null;
  const isWr = is && is.n >= MIN_N ? is.wins / is.n : null;
  const stable = isWr != null && oosWr != null && isWr >= 0.55 && oosWr >= 0.55;
  console.log(
    `${c.key.padEnd(46)} | ALL ${(c.wr * 100).toFixed(1)}% | IS ${fmt(is)} | OOS ${oos == null ? "—" : `n=${String(oos.n).padStart(4)} ${(oosWr * 100).toFixed(1).padStart(5)}%`} ${stable ? "✓ STABLE" : ""}`,
  );
  if (stable) {
    validated.push({
      key: c.key, n: c.n, wr: c.wr, avgCost: c.avgCost, pnl5: c.pnl5,
      is: { n: is.n, wr: isWr }, oos: { n: oos.n, wr: oosWr },
    });
  }
}

writeFileSync("audits/5min-strategies/results/cal60.json", JSON.stringify({
  generatedAt: new Date().toISOString(),
  windows: windows.length,
  minN: MIN_N,
  all: allRows,
  validated,
}, null, 1));
console.log("\n[cal60] export: audits/5min-strategies/results/cal60.json");
db.close();