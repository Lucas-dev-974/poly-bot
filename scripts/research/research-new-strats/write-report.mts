/**
 * Rapport final — 3 nouvelles stratégies backtestées (research-new-strats).
 * Assemble les résultats final-sim + calibration officielle + variance
 * dans un MD + JSON, et imprime les patchs de config live prêts à
 * hot-apply (structure des paramètres d'un futur moteur natif).
 *
 * npx tsx scripts/research/research-new-strats/write-report.mts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadUniverse } from "./universe.mts";
import { runStratSim, ANTIFLIP, FIRSTFAV, FLIPCONFIRM } from "./final-sim.mts";

const OUT_DIR = join("audits", "backtest", "research-new-strats");

function varianceTest(byDay: Record<string, number>, pnl: number): {
  stdDaily: number;
  ratio: number;
  nDays: number;
  nNegDays: number;
} {
  const vals = Object.values(byDay);
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return {
    stdDaily: Math.round(std * 100) / 100,
    ratio: pnl !== 0 ? Math.round((std / Math.abs(pnl)) * 1000) / 1000 : null,
    nDays: n,
    nNegDays: vals.filter((v) => v < 0).length,
  };
}

/** t-stat de l'EV/share (H0: EV=0), payout binaire win/loss à prix moyen. */
function tStat(r: {
  fills: number;
  winRate: number | null;
  avgEntryPrice: number | null;
}): number | null {
  if (!r.fills || r.winRate == null || r.avgEntryPrice == null) return null;
  const p = r.winRate / 100;
  const px = r.avgEntryPrice;
  const ev = p * (1 - px) - (1 - p) * px;
  const e2 = p * (1 - px) ** 2 + (1 - p) * px ** 2;
  const std = Math.sqrt(Math.max(e2 - ev * ev, 1e-12));
  return Math.round((ev / (std / Math.sqrt(r.fills))) * 100) / 100;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const universe = loadUniverse();
  const calib = JSON.parse(
    readFileSync(
      join(OUT_DIR, "calibration-official-1789459431313.json"),
      "utf-8",
    ),
  );

  const strats = [ANTIFLIP, FIRSTFAV, FLIPCONFIRM];
  const rows = strats.map((S) => {
    const full = runStratSim(universe, S);
    return {
      config: S,
      ...full,
      variance: varianceTest(full.byDay, full.pnl),
      tStat: tStat(full),
    };
  });

  const ts = Date.now();
  const reportJson = {
    phase: "new-strategies-backtest-report",
    generatedAt: new Date().toISOString(),
    sourceDb: "data/bot-live.db",
    universe: {
      windows: universe.slugs.size,
      criteria: "801+ ticks (book_snapshots, both outcomes), gap<=60s, résolution connue",
      period:
        [...universe.wsMap.values()].length > 0
          ? `${new Date(Math.min(...universe.wsMap.values()) * 1000).toISOString()} → ${new Date(Math.max(...universe.wsMap.values()) * 1000).toISOString()}`
          : "n/a",
    },
    calibration: {
      official: calib.official,
      simRef: calib.simRef,
      verdict:
        "Sim ≡ runner officiel sur le même univers (387 vs 386 fills, $293 vs $309, WR 77.3% vs 77.5%) — statut backtest calibré.",
    },
    strategies: rows,
  };
  const jsonPath = join(OUT_DIR, `new-strategies-report-${ts}.json`);
  writeFileSync(jsonPath, JSON.stringify(reportJson, null, 2));

  const fmt = (v: number | null) => (v == null ? "—" : v.toFixed(2));
  const md: string[] = [];
  md.push("# 3 nouvelles stratégies — backtest calibré (2026-09-15)");
  md.push("");
  md.push(
    `Univers : **${universe.slugs.size} fenêtres BTC 15m complètes et résolues** (>800 ticks, gaps ≤ 60s), ` +
      `source data/bot-live.db (lecture seule). Période : ${reportJson.universe.period}.`,
  );
  md.push("");
  md.push(
    "Calibration sim ↔ runner officiel (sonde fav-band, même univers) : **387 fills / $293.15 / WR 77.3%** " +
      "(sim) vs **386 fills / $308.57 / WR 77.5%** (runner officiel `runBacktest`) — écart 0.26% fills. " +
      "Les résultats ci-dessous ont donc un statut de backtest calibré.",
  );
  md.push("");
  md.push("## Résultats (hold-to-resolution, $15/ordre, 30 shares max, FOK ask + depth guard)");
  md.push("");
  md.push("| Stratégie | Fills | WR | PnL | DD max | EV/share | Prix moyen | PnL/notional | Jours +/- | Variance (std/\\|PnL\\|) | t-stat |");
  md.push("|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|");
  for (const r of rows) {
    const pctNotional = r.fills && r.notionalUsdc ? Math.round((r.pnl / r.notionalUsdc) * 1000) / 10 : null;
    md.push(
      `| **${r.label}** | ${r.fills} | ${r.winRate}% | ${fmt(r.pnl)} | ${fmt(r.maxDrawdown)} | $${r.evPerShare} | ${r.avgEntryPrice} | ${pctNotional == null ? "—" : pctNotional + "%"} | ${r.variance.nDays - r.variance.nNegDays}/${r.variance.nNegDays} | ${r.variance.ratio} | ${r.tStat} |`,
    );
  }
  md.push("");
  md.push("### 1. antiflip-revert — favori déchu après flip récent");
  md.push("");
  md.push("```");
  md.push("Signal : le favori d'identité FLIPPE (elapsed >= 240s), le nouveau favori");
  md.push("        cote 0.45-0.65, on achète l'ANCIEN favori (ask 0.35-0.45, floor 0.40)");
  md.push("        dans les 90s suivant le flip. Hold to resolution.");
  md.push("Thèse  : sur-réaction au retournement — l'ancien favori re-gagne ~52%");
  md.push("        alors qu'il cote ~0.43 (EV +9¢/share).");
  md.push("Contrôle causal : sans la condition flip → +$147 ; flip ancien (>180s) → +$2.7 ;");
  md.push("        flip récent → +$623. Le flip récent EST le signal.");
  md.push("Split-half : OLD +$380 / NEW +$242 — positif des deux côtés.");
  md.push("Robustesse tie-break : 3/232 entrées déclenchées par un flip d'égalité");
  md.push("        pure ; avec hystérésis (flip si lead >= 1 tick) PnL +$651 — pas");
  md.push("        un artefact de tie-break.");
  md.push("Profil d'entrée (elapsed) : l'essentiel du PnL vient de 240-360s (+$428,");
  md.push("        n=141) et 600-720s (+$184, n=25) ; les entrées 720-840s sont");
  md.push("        légèrement négatives (−$19, n=13) — exécutable en live.");
  md.push("```");
  md.push("");
  md.push("### 2. early-conviction — conviction immédiate du marché");
  md.push("");
  md.push("```");
  md.push("Signal : dans les 45 premières secondes, le favori cote déjà >= 0.60 (<= 0.80).");
  md.push("        On l'achète immédiatement. Hold to resolution.");
  md.push("Thèse  : un marché qui se fixe instantanément est un trend fort — le favori");
  md.push("        gagne 67.6% à un prix moyen de 0.615 (EV +6¢/share), drawdown $82.");
  md.push("Split-half : OLD +$96 / NEW +$235 — positif des deux côtés.");
  md.push("```");
  md.push("");
  md.push("### 3. flip-confirm — retournement confirmé en fenêtre médiane");
  md.push("");
  md.push("```");
  md.push("Signal : un flip survient tôt dans la fenêtre ; <= 90s après ce flip, on");
  md.push("        achète le NOUVEAU favori s'il cote 0.55-0.65, en elapsed [120,180]s.");
  md.push("        (La fenêtre [120,180] est le timing d'ENTRÉE ; le flip, lui, date de");
  md.push("         <= 90s avant l'entrée.) Hold to resolution.");
  md.push("Thèse  : les retournements confirmés en première mi-temps sont informatifs,");
  md.push("        les flips tardifs sont du bruit (entrées m180+ dégradent). WR 66.5%.");
  md.push("Split-half : OLD +$259 / NEW +$130 — positif des deux côtés.");
  md.push("Robustesse tie-break : 0 entrée sur flip d'égalité pure ; avec hystérésis");
  md.push("        (flip si lead >= 1 tick) le PnL monte à +$404 — pas un artefact.");
  md.push("```");
  md.push("");
  md.push("## Axes morts (ne pas re-balayer)");
  md.push("");
  md.push(
    "- **cheap-leader** (askSum < 1.00) : −$12 à −$47, askSum ne prédit rien.\n" +
      "- **fav-streak** (gate de stabilité) : dominé par fav-band existant sur la même bande (+$156 vs +$293).\n" +
      "- **late-lock** (favori tardif 600-840s) : −$46 à −$109, le favori tardif est pricé juste.\n" +
      "- **lotto underdog** (ud <= 0.12, fav >= 0.88) : −$138 à −$212, WR 7-10% insuffisant.\n" +
      "- **whipsaw** (double flip) : +$147 full mais OLD +$289 / NEW −$142 — pari de régime.\n" +
      "- **winstreak n3** (continuité cross-fenêtre) : +$113 mais 65 fills seulement, échantillon mince ; rejeté pour prudence.\n" +
      "- **flipconfirm hors fenêtre [120,180]** : s'effondre (m180 −$227, m240 −$652).",
  );
  md.push("");
  md.push("## Config des stratégies (paramètres retenus)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(rows.map((r) => r.config), null, 2));
  md.push("```");
  md.push("");
  md.push("## Réserves honnêtes");
  md.push("");
  md.push(
    "- Univers mono-régime (8 jours, BTC 15m uniquement) : les WR/PnL sont mesurés sur un seul régime de volatilité. Le t-stat le plus haut est 2.7 ; early-conviction (1.93) reste SOUS le seuil conventionnel de 2.0 — signal prometteur mais non significatif à lui seul.\n" +
      "- Chevauchement mesuré : antiflip ∩ flip-confirm = 129 fenêtres communes (même côté 73, opposé 56), antiflip ∩ early-conviction = 120 (même côté 72), flip-confirm ∩ early-conviction = 80 (même côté 30, opposé 50). Les trois PnL ne s'additionnent PAS : en combinant 2 moteurs, la somme des deux notionaux sur les fenêtres communes s'expose doublement au même résultat.\n" +
      "- antiflip-revert a le meilleur PnL mais le WR le plus bas (52%) : la variance par trade est élevée (avgWin $17.0 vs avgLoss $12.9) — sizing prudent requis.\n" +
      "- Les implémenter en moteurs natifs exigera le wiring complet (6 touch points config + guide frontend), cf. references/new-strategy-wiring.md.",
  );
  md.push("");
  const mdPath = join(OUT_DIR, `new-strategies-report-${ts}.md`);
  writeFileSync(mdPath, md.join("\n"));

  console.log("written:", jsonPath);
  console.log("written:", mdPath);
  console.log("\n--- headline ---");
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(18)} fills=${r.fills} WR=${r.winRate}% PnL=$${r.pnl} DD=$${r.maxDrawdown} EV/sh=${r.evPerShare}c variance-ratio=${r.variance.ratio}`,
    );
  }
}

main();