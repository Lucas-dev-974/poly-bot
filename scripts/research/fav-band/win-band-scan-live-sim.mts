// Scan exhaustif des tranches horaires de win pour fav-band (simulation live paper).
// Question : existe-t-il une tranche horaire ET qui "s'applique" sur les 12 jours ?
// Méthode : bandes [start, start+width) — start pas de 5 min, widths {15,30,45,60,90,120,180} min ;
// une position est dans la bande si le DEBUT de sa fenêtre marché (ET) tombe dans la bande (même
// convention que win-streaks-live-sim.mts). Par bande : wins/losses/PnL totaux + par jour ET
// (≥1 win, ≥2 win, jour actif sans loss). Critères signalés : 12/12 ≥1 win ; jours actifs tous
// sans loss ; tranches "or" (0 loss globale, ≥4 wins).
// Usage : node --experimental-strip-types --experimental-sqlite scripts/research/fav-band/win-band-scan-live-sim.mts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NOW_TS = Date.now();
const WIDTHS_MIN = [15, 30, 45, 60, 90, 120, 180];
const STEP_MIN = 5;

type Row = {
  id: string;
  eventSlug: string;
  status: string;
  pnl: number | null;
  createdAt: number;
};

const db = new DatabaseSync("data/bot-live.db", { readOnly: true });
const rows = [
  ...db
    .prepare(
      `SELECT id, eventSlug, status, pnl, createdAt FROM sim_positions
       WHERE strategyId = 'fav-band' AND status IN ('won','lost')`,
    )
    .all(),
  ...db
    .prepare(
      `SELECT id, eventSlug, status, pnl, createdAt FROM sim_positions_archive
       WHERE strategyId = 'fav-band' AND status IN ('won','lost')`,
    )
    .all(),
] as unknown as Row[];

// dédoublonnage par id
const seen = new Set<string>();
const uniq = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));

const parseSlug = (slug: string) => {
  const m = slug.match(/-updown-(\d+)(m|h)-(\d{10})$/);
  return m ? Number(m[3]) * 1000 : null;
};

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type Pos = { day: string; minuteOfDay: number; status: "won" | "lost"; pnl: number };
const positions: Pos[] = [];
for (const r of uniq) {
  const ws = parseSlug(r.eventSlug);
  if (ws == null) continue;
  const p = Object.fromEntries(
    partsFmt.formatToParts(ws).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  positions.push({
    day: `${p.year}-${p.month}-${p.day}`,
    minuteOfDay: Number(p.hour) * 60 + Number(p.minute),
    status: r.status as "won" | "lost",
    pnl: r.pnl ?? 0,
  });
}
positions.sort((a, b) => a.day.localeCompare(b.day) || a.minuteOfDay - b.minuteOfDay);
const days = [...new Set(positions.map((p) => p.day))].sort();

const scan: {
  width: number;
  start: number;
  wins: number;
  losses: number;
  pnl: number;
  daysActive: number;
  daysWithWin: number;
  daysWithWin2: number;
  daysPerfect: number;
  missingDays: string[];
  lossDays: string[];
}[] = [];

for (const width of WIDTHS_MIN) {
  for (let s0 = 0; s0 + width <= 1440; s0 += STEP_MIN) {
    const s1 = s0 + width;
    let wins = 0,
      losses = 0,
      pnl = 0;
    const dayW = new Map<string, number>();
    const dayL = new Map<string, number>();
    for (const p of positions) {
      if (p.minuteOfDay < s0 || p.minuteOfDay >= s1) continue;
      if (p.status === "won") {
        wins++;
        dayW.set(p.day, (dayW.get(p.day) ?? 0) + 1);
      } else {
        losses++;
        dayL.set(p.day, (dayL.get(p.day) ?? 0) + 1);
      }
      pnl += p.pnl;
    }
    if (wins + losses === 0) continue;
    const daysActive = new Set([...dayW.keys(), ...dayL.keys()]).size;
    const daysWithWin = dayW.size;
    let daysWithWin2 = 0,
      daysPerfect = 0;
    for (const d of dayW.keys()) {
      if (dayW.get(d)! >= 2) daysWithWin2++;
      if ((dayL.get(d) ?? 0) === 0) daysPerfect++;
    }
    const lossDays = [...dayL.keys()].sort();
    scan.push({
      width,
      start: s0,
      wins,
      losses,
      pnl: Math.round(pnl * 100) / 100,
      daysActive,
      daysWithWin,
      daysWithWin2,
      daysPerfect,
      missingDays: days.filter((d) => (dayW.get(d) ?? 0) === 0),
      lossDays,
    });
  }
}
scan.sort((a, b) => b.daysWithWin - a.daysWithWin || b.wins - a.wins || a.width - b.width || a.start - b.start);

const fmtSlice = (s: number) => {
  const h = Math.floor(s / 60),
    m = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

const maxDaysWithWin = Math.max(...scan.map((b) => b.daysWithWin));
const atMax = scan.filter((b) => b.daysWithWin === maxDaysWithWin);
const golden = scan.filter((b) => b.losses === 0 && b.wins >= 4).sort((a, b) => b.wins - a.wins || a.start - b.start);
const bestPerWidth = WIDTHS_MIN.map((w) => {
  const sel = scan.filter((b) => b.width === w).sort((a, b) => b.daysWithWin - a.daysWithWin || b.wins - a.wins);
  return { width: w, best: sel[0] ?? null };
});

const out = {
  meta: {
    generatedAt: new Date(NOW_TS).toISOString(),
    rule: "dans la tranche = début de fenêtre marché (ET) ∈ [start, start+width)",
    stepMin: STEP_MIN,
    widths: WIDTHS_MIN,
    days,
    totals: { positions: positions.length },
  },
  scan,
  maxDaysWithWin,
  atMax,
  golden,
  bestPerWidth,
};

mkdirSync("audits/backtest/fav-band", { recursive: true });
const base = `win-band-scan-live-sim-${NOW_TS}`;
writeFileSync(join("audits/backtest/fav-band", `${base}.json`), JSON.stringify(out, null, 2));

const L: string[] = [];
L.push(`# fav-band — scan exhaustif des tranches de win (simulation live)`);
L.push("");
L.push(`- Généré : ${new Date(NOW_TS).toISOString()} — ${positions.length} positions W/L, ${days.length} jours ET (${days[0]} → ${days[days.length - 1]})`);
L.push(`- Convention : une position est « dans la tranche » si le **début de sa fenêtre marché (ET)** tombe dans [start, start+width) ; pas de pas : 5 min ; largeurs : ${WIDTHS_MIN.join("/")} min`);
L.push("");
L.push(`## Verdict « tranche qui s'applique sur les ${days.length} jours »`);
L.push("");
L.push(`- Nombre maximal de jours avec ≥ 1 win dans une même tranche : **${maxDaysWithWin}/${days.length} jours**`);
const atMaxWidest = [...atMax].sort((a, b) => b.width - a.width)[0];
L.push(`- Tranche la plus large au max de couverture : **${fmtSlice(atMaxWidest.start)}–${fmtSlice(atMaxWidest.start + atMaxWidest.width)} ET** (${atMaxWidest.wins}W/${atMaxWidest.losses}L) — jours manquants : ${atMaxWidest.missingDays.join(", ") || "aucun"}`);
L.push(`- Bandes au max de couverture : ${atMax.length} (top 10 ci-dessous)`);
L.push("");
L.push(`| Tranche (ET) | Largeur | W | L | WR | PnL | Jours avec ≥1 win | Jours sans win |
|---|---|---|---|---|---|---|---|`);
for (const b of atMax.slice(0, 10)) {
  const wrVal = b.wins + b.losses ? +(100 * (b.wins / (b.wins + b.losses))).toFixed(1) : null;
  L.push(
    `| ${fmtSlice(b.start)}–${fmtSlice(b.start + b.width)} | ${b.width} min | ${b.wins} | ${b.losses} | ${wrVal === null ? "–" : `${wrVal} %`} | ${b.pnl >= 0 ? "+" : ""}$${b.pnl} | ${b.daysWithWin}/${days.length} | ${b.missingDays.join(", ") || "–"} |`,
  );
}
L.push("");
L.push(`## Tranches « or » : 0 loss (100 % WR) avec ≥ 4 wins`);
L.push("");
if (golden.length === 0) L.push("_Aucune bande 0-loss avec ≥ 4 wins._");
else {
  L.push(`| Tranche (ET) | Largeur | W | PnL | Jours actifs | Jours parfaits (sans loss) |
|---|---|---|---|---|---|`);
  for (const b of golden.slice(0, 15)) {
    L.push(
      `| ${fmtSlice(b.start)}–${fmtSlice(b.start + b.width)} | ${b.width} min | ${b.wins} | ${b.pnl >= 0 ? "+" : ""}$${b.pnl} | ${b.daysActive} | ${b.daysPerfect} |`,
    );
  }
}
L.push("");
L.push(`## Meilleure bande par largeur`);
L.push("");
L.push(`| Largeur | Meilleure tranche (ET) | W | L | WR | Jours avec ≥1 win | Jours manquants |
|---|---|---|---|---|---|---|`);
for (const { width, best } of bestPerWidth) {
  if (!best) continue;
  const wrVal = best.wins + best.losses ? +(100 * (best.wins / (best.wins + best.losses))).toFixed(1) : null;
  L.push(
    `| ${width} min | ${fmtSlice(best.start)}–${fmtSlice(best.start + best.width)} | ${best.wins} | ${best.losses} | ${wrVal === null ? "–" : `${wrVal} %`} | ${best.daysWithWin}/${days.length} | ${best.missingDays.join(", ") || "–"} |`,
  );
}
L.push("");
L.push(`## Meilleures bandes "2 wins/jour" (max jours avec ≥2 wins)`);
L.push("");
const maxWin2 = Math.max(...scan.map((b) => b.daysWithWin2));
const atMaxWin2 = scan.filter((b) => b.daysWithWin2 === maxWin2).slice(0, 8);
L.push(`- Max jours avec ≥2 wins dans la même tranche : **${maxWin2}/${days.length}**`);
L.push("");
L.push(`| Tranche (ET) | Largeur | W | L | WR | Jours ≥2win |
|---|---|---|---|---|---|`);
for (const b of atMaxWin2) {
  const wrVal = b.wins + b.losses ? +(100 * (b.wins / (b.wins + b.losses))).toFixed(1) : null;
  L.push(
    `| ${fmtSlice(b.start)}–${fmtSlice(b.start + b.width)} | ${b.width} min | ${b.wins} | ${b.losses} | ${wrVal === null ? "–" : `${wrVal} %`} | ${b.daysWithWin2}/${days.length} |`,
  );
}
L.push("");
writeFileSync(join("audits/backtest/fav-band", `${base}.md`), L.join("\n"));
console.log(`Écrit : audits/backtest/fav-band/${base}.md + .json`);
console.log(`maxDaysWithWin = ${maxDaysWithWin}/${days.length} ; bandes au max : ${atMax.length} ; golden (0 loss ≥4W) : ${golden.length}`);
for (const b of atMax.slice(0, 10)) {
  const wrVal = +(100 * (b.wins / (b.wins + b.losses))).toFixed(1);
  console.log(`  ${fmtSlice(b.start)}–${fmtSlice(b.start + b.width)} w${b.width}: ${b.wins}W/${b.losses}L (${wrVal}%) joursWin=${b.daysWithWin}/${days.length} manquants=[${b.missingDays.join(",")}]`);
}