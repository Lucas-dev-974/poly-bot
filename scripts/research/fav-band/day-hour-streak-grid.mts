// Grille jour x tranche horaire (ET) des successions de wins — moteur fav-band, simulation live.
// Lecture : data/bot-live.db (sim_positions + sim_positions_archive, strategyId='fav-band', won/lost).
// Une position appartient au cellule (jour ET, tranche h) si le DEBUT de sa fenêtre marché (ET) est dans [h, h+1).
// bloc = suite de wins adjacents DANS l'ordre du jour (pas de 'lost' entre deux) ; ■ = bloc >= 2 ;
// gras (**) si bloc >= 3. 'sold' et autres statuts exclus (ne coupent rien).
// Usage : node --experimental-strip-types --experimental-sqlite scripts/research/fav-band/day-hour-streak-grid.mts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NOW_TS = Date.now();

type Row = { id: string; eventSlug: string; status: string; pnl: number | null; createdAt: number };
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

type Pos = { day: string; hour: number; minuteOfDay: number; status: "won" | "lost"; pnl: number };
const positions: Pos[] = [];
for (const r of uniq) {
  const ws = parseSlug(r.eventSlug);
  if (ws == null) continue;
  const p = Object.fromEntries(
    partsFmt.formatToParts(ws).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const mod = Number(p.hour) * 60 + Number(p.minute);
  positions.push({
    day: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minuteOfDay: mod,
    status: r.status as "won" | "lost",
    pnl: r.pnl ?? 0,
  });
}
positions.sort((a, b) => a.day.localeCompare(b.day) || a.minuteOfDay - b.minuteOfDay);
const days = [...new Set(positions.map((p) => p.day))].sort();
const byDay = new Map<string, Pos[]>();
for (const p of positions) {
  const a = byDay.get(p.day) ?? [];
  a.push(p);
  byDay.set(p.day, a);
}

// runs (>=3 wins adjacents sur le jour) pour la colonne "runs"
const runsPerDay = new Map<string, { start: string; end: string; nWins: number }[]>();
const runLenHist = new Map<number, number>();
for (const [day, seq] of byDay) {
  const runs: { start: string; end: string; nWins: number }[] = [];
  let cur: Pos[] = [];
  const flush = () => {
    if (cur.length >= 2) runLenHist.set(cur.length, (runLenHist.get(cur.length) ?? 0) + 1);
    if (cur.length >= 3) {
      const t = (m: number) =>
        `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      runs.push({ start: t(cur[0].minuteOfDay), end: t(cur[cur.length - 1].minuteOfDay), nWins: cur.length });
    }
    cur = [];
  };
  for (const p of seq) {
    if (p.status === "won") cur.push(p);
    else if (p.status === "lost") flush();
  }
  flush();
  runsPerDay.set(day, runs);
}

type Cell = { hour: number; wins: number; losses: number; blocks: number; blockMax: number; blockTotal: number };
const grid = new Map<string, Cell[]>(); // day -> 24 cells
for (const [day, seq] of byDay) {
  const cells: Cell[] = Array.from({ length: 24 }, (_, h) => ({ hour: h, wins: 0, losses: 0, blocks: 0, blockMax: 0, blockTotal: 0 }));
  const perHour = new Map<number, Pos[]>();
  for (const p of seq) {
    const a = perHour.get(p.hour) ?? [];
    a.push(p);
    perHour.set(p.hour, a);
  }
  // par tranche : les positions in-cellule sont contiguës dans l'ordre du jour
  // (toute position entre deux cellules a un start dans la même tranche), donc
  // les coupures de bloc = les 'lost' de la cellule uniquement.
  for (const [h, inCell] of perHour) {
    const c = cells[h];
    let block = 0;
    for (const p of inCell) {
      if (p.status === "won") {
        c.wins++;
        block++;
        c.blockTotal++;
        c.blockMax = Math.max(c.blockMax, block);
      } else {
        block = 0;
        c.losses++;
      }
    }
    c.blocks = c.wins === 0 && c.losses === 0 ? 0 : c.blockTotal === c.blockMax ? 1 : 2;
  }
  grid.set(day, cells);
}

const cellMd = (c: Cell) => {
  if (c.wins === 0 && c.losses === 0) return "·";
  const w = c.wins,
    l = c.losses;
  let s: string;
  if (l === 0) {
    s = w >= 2 ? `■${w}W` : `${w}W`;
  } else if (w === 0) {
    s = `${l}L`;
  } else if (c.blocks === 1) {
    s = `■${w}W/${l}L`;
  } else {
    s = `${w}W${c.blockMax >= 2 ? `(${c.blockMax})` : ""}/${l}L`;
  }
  return c.blockMax >= 3 ? `**${s}**` : s;
};

const L: string[] = [];
L.push(`# fav-band — grille des successions de wins par jour x tranche horaire (simulation live)`);
L.push("");
L.push(`- Généré : ${new Date(NOW_TS).toISOString()} — ${positions.length} positions W/L, ${days.length} jours ET (${days[0]} → ${days[days.length - 1]})`);
L.push(`- Cellule (jour, tranche h ET) = fenêtres dont le **début** EST dans [h, h+1) ; \`■kW\` = succession de **k wins adjacents** (aucune loss entre eux) ; \`3L\` = losses sans win ; \`2W(1)/1L\` = wins dispersés (bloc max entre parenthèses) ; **gras = bloc ≥ 3 wins** ; \`·\` = rien`);
L.push(`- \`sold\` exclu (2 positions, sans effet sur les successions) ; l'ordre est celui des fenêtres marché du jour ; la fin d'un run = **début de la dernière fenêtre gagnante** (convention window-start)`);
L.push("");

L.push(`## Grille`);
L.push("");
L.push(`| Jour (ET) | ` + Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")).join(" | ") + ` | W/L | PnL |`);
L.push(`|---|` + Array.from({ length: 24 }, () => "---").join("|") + `|---|---|`);
let totalW = 0,
  totalL = 0,
  totalP = 0;
const hourTot = Array.from({ length: 24 }, () => ({ w: 0, l: 0 }));
for (const d of days) {
  const cells = grid.get(d)!;
  const seq = byDay.get(d)!;
  const w = seq.filter((p) => p.status === "won").length;
  const l = seq.length - w;
  const p = Math.round(seq.reduce((s, x) => s + x.pnl, 0) * 100) / 100;
  totalW += w;
  totalL += l;
  totalP += p;
  cells.forEach((c) => {
    hourTot[c.hour].w += c.wins;
    hourTot[c.hour].l += c.losses;
  });
  L.push(
    `| **${d}** | ` + cells.map(cellMd).join(" | ") + ` | ${w}/${l} | ${p >= 0 ? "+" : ""}$${p} |`,
  );
}
L.push(`| **Σ heure** | ` + hourTot.map((x) => `${x.w}W${x.l ? `/${x.l}L` : ""}`).join(" | ") + ` | ${totalW}/${totalL} | $${Math.round(totalP * 100) / 100} |`);
L.push("");
L.push(`## Runs ≥ 3 par jour (détail des tranches)`);
L.push("");
L.push(`| Jour (ET) | Successions (tranche — nombre de wins) |
|---|---|`);
for (const d of days) {
  const rs = runsPerDay.get(d)!.sort((a, b) => a.start.localeCompare(b.start));
  if (!rs.length) {
    L.push(`| ${d} | – |`);
    continue;
  }
  L.push(`| ${d} | ${rs.map((r) => `\`${r.start}–${r.end}\` → **${r.nWins} wins**`).join(" ; ")} |`);
}
L.push("");
L.push(`- Histogramme des runs (≥2 wins adjacents, tous jours) : \`${JSON.stringify(Object.fromEntries([...runLenHist.entries()].sort((a, b) => a[0] - b[0])))}\``);

const out = {
  meta: { generatedAt: new Date(NOW_TS).toISOString(), days, convention: "cellule = début de fenêtre ET dans [h, h+1)" },
  grid: Object.fromEntries([...grid.entries()].map(([d, cells]) => [d, cells])),
  runs: Object.fromEntries([...runsPerDay.entries()]),
  hourTotals: hourTot,
  totals: { wins: totalW, losses: totalL, pnl: Math.round(totalP * 100) / 100 },
  runLenHist: Object.fromEntries([...runLenHist.entries()].sort((a, b) => a[0] - b[0])),
};

mkdirSync("audits/backtest/fav-band", { recursive: true });
const base = `streak-grid-live-sim-${NOW_TS}`;
writeFileSync(join("audits/backtest/fav-band", `${base}.json`), JSON.stringify(out, null, 2));
writeFileSync(join("audits/backtest/fav-band", `${base}.md`), L.join("\n"));
console.log(`Écrit : audits/backtest/fav-band/${base}.md + .json`);
console.log(L.join("\n"));