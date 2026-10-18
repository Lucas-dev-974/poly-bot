// Win-streak analysis for the fav-band engine in the live simulation (paper trading).
// Spec (feu vert):
//   - Source: data/bot-live.db, tables sim_positions + sim_positions_archive, strategyId='fav-band', status != 'open'.
//   - Wins/losses: status 'won' / 'lost'. Any other status ('sold', ...) is excluded and does NOT cut a run.
//   - Time reference: the market window start time as stated in the market title (ET, America/New_York),
//     derived from the slug `{asset}-updown-{dur}{m|h}-{windowStartSec10}`. Days = ET calendar days.
//   - Run: maximal sequence of consecutive 'won' positions within one ET day; threshold = 3 wins.
//   - Repetition across days:
//       A) exact repeats — runs with the SAME start/end window clock time (to the minute) on >= 2 distinct days;
//       B) start-anchor repeats — runs whose window START falls within +/- 15 min across days (>= 3 distinct days).
//     Each group also reports the band WR (all closed won/lost positions whose window overlaps the group span).
//   - Extras: hourly ET WR table, day x hour heatmap, per-day summary.
// Usage: node --experimental-strip-types --experimental-sqlite scripts/research/fav-band/win-streaks-live-sim.mts [--inspect]
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NOW_TS = Date.now();
const MIN_RUN_WINS = 3; // seuil feu vert
const ANCHOR_TOL_MIN = 15; // tolérance d'ancrage de démarrage

type Row = {
  id: string;
  eventSlug: string;
  eventTitle: string;
  tokenId: string;
  outcome: string;
  kind: string;
  fillPrice: number;
  size: number;
  cost: number;
  windowEnd: number;
  status: string;
  resolvedAt: number | null;
  pnl: number | null;
  fillReason: string;
  pairId: string;
  orderType: string | null;
  sellPrice: number | null;
  createdAt: number;
  src: string;
};

const COLS =
  "id, eventSlug, eventTitle, tokenId, outcome, outcomeIndex, kind, limitPrice, fillPrice, size, cost, windowEnd, status, resolvedAt, pnl, fillReason, pairId, bestAskAtFill, orderType, strategyId, sellPrice, createdAt";

const db = new DatabaseSync("data/bot-live.db", { readOnly: true });

const rows: Row[] = [
  ...db
    .prepare(
      `SELECT ${COLS}, 'live' AS src FROM sim_positions
       WHERE strategyId = 'fav-band' AND status != 'open'`,
    )
    .all(),
  ...db
    .prepare(
      `SELECT ${COLS}, 'archive' AS src FROM sim_positions_archive
       WHERE strategyId = 'fav-band' AND status != 'open'`,
    )
    .all(),
] as unknown as Row[];

// ---- dédoublonnage par id (une position archivée peut exister dans les deux sources pendant la fenêtre WAL)
const byId = new Map<string, Row & { dupes: number }>();
let dupeCount = 0;
for (const r of rows) {
  const prev = byId.get(r.id);
  if (prev) {
    dupeCount++;
    // la version archive est la plus récente (moved after resolution/audit)
    if (prev.src !== "archive") byId.set(r.id, { ...r, dupes: (prev.dupes ?? 0) + 1 });
    else prev.dupes = (prev.dupes ?? 0) + 1;
  } else {
    byId.set(r.id, { ...r, dupes: 0 });
  }
}
const list = [...byId.values()];

// ---- slug parsing
const parseSlug = (slug: string) => {
  const m = slug.match(/-updown-(\d+)(m|h)-(\d{10})$/);
  if (!m) return null;
  return {
    durationSec: Number(m[1]) * (m[2] === "h" ? 3600 : 60),
    windowStartSec: Number(m[3]),
  };
};

// ---- ET time helpers ( America/New_York, DST-aware )
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const fmtDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const etOf = (ms: number) => {
  const p = Object.fromEntries(
    partsFmt
      .formatToParts(ms)
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type as string, x.value as string]),
  ) as Record<string, string>;
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour,
    minute,
    hourFloat: hour + minute / 60,
  };
};

// HH:MM (24h) + libellé 12h style titre marché, arithmétique pure (aucune conversion TZ)
const timeParts = (hourFloat: number) => {
  let total = Math.round(hourFloat * 60);
  if (total > 1440) total = 1440;
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const hh24 =
    h24 >= 24 ? "24:00" : `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  const period = h24 < 12 || h24 >= 24 ? "AM" : "PM";
  return { hh24, label12: `${h12}:${String(m).padStart(2, "0")}${period}` };
};
const hm = (hf: number) => timeParts(hf).hh24;
const titleRange = (start: number, end: number) =>
  `${timeParts(start).label12} – ${timeParts(end).label12} ET (24h: ${hm(start)}–${hm(end)})`;

const inspect = process.argv.includes("--inspect");
if (inspect) {
  const statusDist = new Map<string, number>();
  const kindDist = new Map<string, number>();
  const srcDist = new Map<string, number>();
  const durDist = new Map<string, number>();
  let slugMiss = 0;
  let minTs = Infinity,
    maxTs = -Infinity;
  let minWin = Infinity,
    maxWin = -Infinity;
  const perWindow = new Map<string, number>();
  const titleSample: string[] = [];
  for (const r of list) {
    statusDist[r.status] = (statusDist[r.status] ?? 0) + 1;
    kindDist[r.kind] = (kindDist[r.kind] ?? 0) + 1;
    srcDist[r.src] = (srcDist[r.src] ?? 0) + 1;
    const s = parseSlug(r.eventSlug);
    if (!s) slugMiss++;
    else {
      const key = `${s.durationSec / 60}m`;
      durDist[key] = (durDist[key] ?? 0) + 1;
      perWindow.set(r.eventSlug, (perWindow.get(r.eventSlug) ?? 0) + 1);
      const wms = s.windowStartSec * 1000;
      if (wms < minWin) minWin = wms;
      if (wms > maxWin) maxWin = wms;
    }
    if (r.createdAt < minTs) minTs = r.createdAt;
    if (r.createdAt > maxTs) maxTs = r.createdAt;
    if (titleSample.length < 3 && !titleSample.includes(r.eventTitle)) titleSample.push(r.eventTitle);
  }
  const dupMulti = [...perWindow.values()].filter((c) => c > 1).length;
  console.log(JSON.stringify(
    {
      countRaw: rows.length,
      countUnique: list.length,
      dupeCount,
      statusDist,
      kindDist,
      srcDist,
      durDist,
      slugMiss,
      windowSpanET: {
        min: minWin === Infinity ? null : fmtDate.format(minWin),
        max: maxWin === -Infinity ? null : fmtDate.format(maxWin),
      },
      createdAtSpan: {
        min: minTs === Infinity ? null : new Date(minTs).toISOString(),
        max: maxTs === -Infinity ? null : new Date(maxTs).toISOString(),
      },
      windowsWithMultiplePositions: dupMulti,
      windowsMaxPerSlug: Math.max(0, ...perWindow.values()),
      titleSamples: titleSample,
    },
    null,
    2,
  ));
  process.exit(0);
}

// ---- construit la séquence par jour ET
type Pos = Row & {
  windowStartMs: number;
  durationSec: number;
  etDay: string;
  etStartFloat: number;
  etEndFloat: number;
};
const positions: Pos[] = [];
let slugSkipped = 0;
for (const r of list) {
  const s = parseSlug(r.eventSlug);
  if (!s) {
    slugSkipped++;
    continue;
  }
  const wms = s.windowStartSec * 1000;
  const e = etOf(wms);
  positions.push({
    ...r,
    windowStartMs: wms,
    durationSec: s.durationSec,
    etDay: e.day,
    etStartFloat: e.hourFloat,
    etEndFloat: Math.min(24, e.hourFloat + s.durationSec / 3600),
  });
}
positions.sort((a, b) => a.windowStartMs - b.windowStartMs || a.createdAt - b.createdAt);

const byDay = new Map<string, Pos[]>();
for (const p of positions) {
  const a = byDay.get(p.etDay) ?? [];
  a.push(p);
  byDay.set(p.etDay, a);
}

// ---- runs >= MIN_RUN_WINS par jour
type Run = {
  day: string;
  startH: number;
  endH: number;
  nWins: number;
  ids: string[];
};
const runs: Run[] = [];
const runLenHist = new Map<number, number>();
for (const [day, seq] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  let cur: Pos[] = [];
  const flush = () => {
    if (cur.length >= 2) runLenHist.set(cur.length, (runLenHist.get(cur.length) ?? 0) + 1);
    if (cur.length >= MIN_RUN_WINS) {
      runs.push({
        day,
        startH: cur[0].etStartFloat,
        endH: cur[cur.length - 1].etEndFloat,
        nWins: cur.length,
        ids: cur.map((p) => p.id),
      });
    }
    cur = [];
  };
  for (const p of seq) {
    if (p.status === "won") cur.push(p);
    else if (p.status === "lost") flush();
    // 'sold'/autres : ignorés, ne coupent pas le run
  }
  flush();
}

// ---- WR de bande : toutes positions W/L dont la fenêtre recouvre l'intervalle donné
const bandStatsFor = (c0: number, c1: number) => {
  let wins = 0,
    losses = 0,
    pnl = 0;
  for (const p of positions) {
    if (p.status !== "won" && p.status !== "lost") continue;
    const ov = Math.min(p.etEndFloat, c1) - Math.max(p.etStartFloat, c0);
    if (ov > 0) {
      if (p.status === "won") wins++;
      else losses++;
      pnl += p.pnl ?? 0;
    }
  }
  return {
    wins,
    losses,
    pnl: Math.round(pnl * 100) / 100,
    wr: wins + losses ? +(100 * (wins / (wins + losses))).toFixed(1) : null,
  };
};

// ---- (A) répétitions EXACTES : même heure de début ET de fin (à la minute) sur >= 2 jours distincts
type Group = {
  key: string;
  start: number;
  end: number;
  days: string[];
  nRuns: number;
  runsList: { day: string; start: string; end: string; nWins: number }[];
  winsRange: [number, number];
  band: ReturnType<typeof bandStatsFor>;
  span: { spanStart: number; spanEnd: number };
  core: { coreStart: number; coreEnd: number } | null;
  bandCore: ReturnType<typeof bandStatsFor> | null;
};
const buildGroup = (key: string, rs: Run[]): Group => {
  const start = Math.max(...rs.map((r) => r.startH)); // core commun (intersection, intervalles = Helly)
  const end = Math.min(...rs.map((r) => r.endH));
  const spanStart = Math.min(...rs.map((r) => r.startH));
  const spanEnd = Math.max(...rs.map((r) => r.endH));
  const ns = rs.map((r) => r.nWins);
  const sortedRuns = [...rs].sort((a, b) => a.day.localeCompare(b.day));
  return {
    key,
    start,
    end,
    days: [...new Set(sortedRuns.map((r) => r.day))],
    nRuns: rs.length,
    runsList: sortedRuns.map((r) => ({
      day: r.day,
      start: hm(r.startH),
      end: hm(r.endH),
      nWins: r.nWins,
    })),
    winsRange: [Math.min(...ns), Math.max(...ns)] as [number, number],
    band: bandStatsFor(spanStart, spanEnd),
    span: { spanStart, spanEnd },
    core: end > start ? { coreStart: start, coreEnd: end } : null,
    bandCore: end > start ? bandStatsFor(start, end) : null,
  };
};

const exactMap = new Map<string, Run[]>();
for (const r of runs) {
  const key = `${Math.round(r.startH * 60)}|${Math.round(r.endH * 60)}`;
  const a = exactMap.get(key) ?? [];
  a.push(r);
  exactMap.set(key, a);
}
const exactRepeats: Group[] = [];
for (const [key, rs] of exactMap) {
  const distinctDays = new Set(rs.map((r) => r.day));
  if (distinctDays.size >= 2) exactRepeats.push(buildGroup(key, rs));
}
exactRepeats.sort((a, b) => b.days.length - a.days.length || a.key.localeCompare(b.key));

// ---- (B) répétitions par ANCRE de démarrage : starts à +/- ANCHOR_TOL_MIN sur >= 2 jours distincts
const anchors: Group[] = [];
{
  const sorted = [...runs].sort((a, b) => a.startH - b.startH || a.day.localeCompare(b.day));
  let group: Run[] = [];
  const flushGroup = () => {
    if (group.length >= 2) {
      const g = buildGroup(`anchor-${hm(group[0].startH)}`, group);
      if (g.days.length >= 3) anchors.push(g); // créneau "récurrent" : >= 3 jours (table B)
    }
    group = [];
  };
  for (const r of sorted) {
    if (group.length === 0 || Math.round((r.startH - group[0].startH) * 60) <= ANCHOR_TOL_MIN + 1) group.push(r);
    else {
      flushGroup();
      group = [r];
    }
  }
  flushGroup();
  anchors.sort((a, b) => b.days.length - a.days.length || a.key.localeCompare(b.key));
}

// ---- WR par heure ET (toutes positions W/L, jour agrégé)
const hourly = Array.from({ length: 24 }, (_, h) => {
  const sel = positions.filter(
    (p) => (p.status === "won" || p.status === "lost") && Math.floor(p.etStartFloat) === h,
  );
  const wins = sel.filter((p) => p.status === "won").length;
  const losses = sel.length - wins;
  const pnl = Math.round(sel.reduce((s, p) => s + (p.pnl ?? 0), 0) * 100) / 100;
  return { hour: h, wins, losses, wr: sel.length ? +(100 * (wins / sel.length)).toFixed(1) : null, pnl };
});

// ---- heatmap jour x heure ET (fenêtres dont le START tombe dans l'heure)
const head = (ms: number) => {
  const e = etOf(ms);
  return `${e.day} ${String(e.hour).padStart(2, "0")}:${String(e.minute).padStart(2, "0")}`;
};
const days = [...byDay.keys()].sort();
const daysSummary = days.map((d) => {
  const seq = byDay.get(d)!;
  const runsD = runs.filter((r) => r.day === d);
  const wins = seq.filter((p) => p.status === "won").length;
  const losses = seq.filter((p) => p.status === "lost").length;
  const others = seq.length - wins - losses;
  const pnl = Math.round(seq.reduce((s, p) => s + (p.pnl ?? 0), 0) * 100) / 100;
  return {
    day: d,
    positions: seq.length,
    wins,
    losses,
    others,
    pnl,
    runs: runsD
      .sort((a, b) => a.startH - b.startH)
      .map((r) => ({ startET: hm(r.startH), endET: hm(r.endH), nWins: r.nWins, ids: r.ids })),
  };
});

const heat: Record<string, string[]> = {};
for (const d of days) {
  const seq = byDay.get(d)!;
  const perHour: string[] = [];
  for (let h = 0; h < 24; h++) {
    const w = seq.filter((p) => p.status === "won" && Math.floor(p.etStartFloat) === h).length;
    const l = seq.filter((p) => p.status === "lost" && Math.floor(p.etStartFloat) === h).length;
    perHour.push(w || l ? `${w}W${l ? `/${l}L` : ""}` : "·");
  }
  heat[d] = perHour;
}

// ---- résumé global
const closed = positions.filter((p) => p.status === "won" || p.status === "lost");
const totalWins = closed.filter((p) => p.status === "won").length;
const totalLosses = closed.length - totalWins;
const totalPnl = Math.round(closed.reduce((s, p) => s + (p.pnl ?? 0), 0) * 100) / 100;
const minTs = Math.min(...positions.map((p) => p.windowStartMs));
const maxTs = Math.max(...positions.map((p) => p.windowStartMs));
const dupPositionsSameWindow =
  [...positions.reduce((m, p) => m.set(p.eventSlug, (m.get(p.eventSlug) ?? 0) + 1), new Map<string, number>()).values()].filter(
    (c) => c > 1,
  ).length;

const out = {
  meta: {
    generatedAt: new Date(NOW_TS).toISOString(),
    dbPath: "data/bot-live.db",
    engine: "fav-band",
    source: "simulation live (paper) : sim_positions + sim_positions_archive",
    timeRef: "ET (America/New_York) — heure de début de la fenêtre marché (slug)",
    params: {
      minRunWins: MIN_RUN_WINS,
      anchorToleranceMin: ANCHOR_TOL_MIN,
      soldPolicy: "exclues, ne coupent pas le run",
    },
    countRaw: rows.length,
    countUnique: list.length,
    dupeCount,
    slugSkipped,
    dupPositionsSameWindow,
    windowSpanET: { min: fmtDate.format(minTs), max: fmtDate.format(maxTs) },
    firstWindowET: head(minTs),
    lastWindowET: head(maxTs),
    totals: {
      closed: closed.length,
      wins: totalWins,
      losses: totalLosses,
      wr: +(100 * (totalWins / closed.length)).toFixed(1),
      pnl: totalPnl,
      days: days.length,
    },
    runLenHist2plus: Object.fromEntries([...runLenHist.entries()].sort((a, b) => a[0] - b[0])),
    nExactRepeats: exactRepeats.length,
    nStartAnchorsRecurring: anchors.length,
  },
  runs,
  exactRepeats,
  startAnchors: anchors,
  daysSummary,
  hourly,
  heat,
};

mkdirSync("audits/backtest/fav-band", { recursive: true });
const base = `win-streaks-live-sim-${NOW_TS}`;
writeFileSync(join("audits/backtest/fav-band", `${base}.json`), JSON.stringify(out, null, 2));

// ---- rapport MD
const L: string[] = [];
L.push(`# fav-band — win-streaks par jour & créneaux récurrents (simulation live)`);
L.push("");
L.push(`- Généré : ${new Date(NOW_TS).toISOString()}`);
L.push(`- Source : \`data/bot-live.db\` → \`sim_positions\` + \`sim_positions_archive\`, \`strategyId='fav-band'\`, \`status!='open'\``);
L.push(`- Univers : **${positions.length} positions closées** sur **${days.length} jours ET** (${fmtDate.format(minTs)} → ${fmtDate.format(maxTs)} ; dernière entrée ${head(maxTs)} ET)`);
L.push(`- PnL closé : **$${totalPnl}** — ${totalWins}W / ${totalLosses}L — WR ${out.meta.totals.wr} %`);
L.push(`- Référence horaire : **ET (America/New_York)** = libellé des questions marché (ex. \`Bitcoin Up or Down – Oct 7, 12:00AM-12:15AM ET\`) ; jour = jour calendaire ET`);
L.push(`- Règles : runs ≥ **${MIN_RUN_WINS}** wins consécutifs ; \`sold\`/autres statuts exclus **sans couper** un run ; positions consécutives = triées par fenêtre marché (une fenêtre sans trade au milieu n'interrompt pas la série)`);
L.push(`- Script : \`scripts/research/fav-band/win-streaks-live-sim.mts\``);
L.push("");

const fmtRuns = (g: Group) =>
  g.runsList.map((r) => `${r.day} ${r.start}–${r.end} (${r.nWins}W)`).join(" · ");

L.push(`## 1) Tranches de wins par jour (runs ≥ ${MIN_RUN_WINS})`);
L.push("");
L.push(`| Jour (ET) | Tranche (ET, 24h) | Titre marché (12h) | Wins |`);
L.push(`|---|---|---|---|`);
for (const d of days) {
  const rs = runs
    .filter((r) => r.day === d)
    .sort((a, b) => a.startH - b.startH);
  if (!rs.length) continue;
  for (const r of rs) {
    L.push(`| ${d} | ${hm(r.startH)}–${hm(r.endH)} | ${timeParts(r.startH).label12}–${timeParts(r.endH).label12} | **${r.nWins}** |`);
  }
}
L.push("");

L.push(`## 2a) Répétition EXACTE de la même tranche (heure début + heure fin identiques, ≥ 2 jours)`);
L.push("");
if (exactRepeats.length === 0) {
  L.push("_Aucune tranche exacte répétée sur 2 jours distincts._");
} else {
  L.push(`| Tranche (ET, 24h) | Titre marché (12h) | Jours | Wins des runs | WR bande (span) | PnL bande |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const g of exactRepeats) {
    L.push(
      `| ${g.runsList[0].start}–${g.runsList[0].end} | ${timeParts(g.start).label12}–${timeParts(g.end).label12} | ${g.days.length} : ${g.days.join(", ")} | ${g.runsList.map((r) => `${r.nWins}W`).join(",")} | ${g.band.wr === null ? "–" : `${g.band.wr} % (${g.band.wins}W/${g.band.losses}L)`} | ${g.band.pnl >= 0 ? "+" : ""}$${g.band.pnl} |`,
    );
  }
}
L.push("");

L.push(`## 2b) Créneaux récurrents par ANCRE de début (start ≤ ${ANCHOR_TOL_MIN} min d'écart, ≥ 3 jours)`);
L.push("");
if (anchors.length === 0) {
  L.push("_Aucun ancre de début récurrent sur ≥ 3 jours._");
} else {
  L.push(`| Anchor début (ET) | Tranche span (ET) | Jours | WR span | PnL span | Détails des runs |
|---|---|---|---|---|---|`);
  for (const g of anchors) {
    L.push(
      `| ${g.key.replace("anchor-", "")} | ${hm(g.span.spanStart)}–${hm(g.span.spanEnd)} | ${g.days.length} : ${g.days.join(", ")} | ${g.band.wr === null ? "–" : `${g.band.wr} % (${g.band.wins}W/${g.band.losses}L)`} | ${g.band.pnl >= 0 ? "+" : ""}$${g.band.pnl} | ${fmtRuns(g)} |`,
    );
  }
}
L.push("");

L.push(`## 3) WR par heure de début de fenêtre (ET) — tous jours confondus`);
L.push("");
L.push(`| Heure ET | W | L | WR | PnL |
|---|---|---|---|---|`);
for (const h of hourly) {
  if (!h.wins && !h.losses) continue;
  L.push(
    `| ${String(h.hour).padStart(2, "0")}:00–${String((h.hour + 1) % 24).padStart(2, "0")}:00 | ${h.wins} | ${h.losses} | ${h.wr === null ? "–" : `${h.wr} %`} | ${h.pnl >= 0 ? "+" : ""}$${h.pnl} |`,
  );
}
L.push("");

L.push(`## 4) Grille jour x heure (ET) — W/L par heure de début de fenêtre`);
L.push("");
L.push(`| Jour (ET) | ` + hourly.map((h) => String(h.hour).padStart(2, "0")).join(" | ") + " |");
L.push(`|---|` + hourly.map(() => "---").join("|") + "|");
for (const d of days) {
  L.push(`| ${d} | ` + heat[d].join(" | ") + " |");
}
L.push("");

L.push(`## 5) Résumé par jour ET`);
L.push("");
L.push(
  `| Jour (ET) | Positions | W | L | Autres | PnL | Runs ≥ ${MIN_RUN_WINS} |
|---|---|---|---|---|---|---|`,
);
for (const d of daysSummary) {
  const rs = d.runs.map((r) => `${r.startET}–${r.endET}: ${r.nWins}W`).join(" ; ") || "–";
  L.push(
    `| ${d.day} | ${d.positions} | ${d.wins} | ${d.losses} | ${d.others} | ${d.pnl >= 0 ? "+" : ""}$${d.pnl} | ${rs} |`,
  );
}
L.push("");

L.push(`## Caveats`);
L.push("");
L.push(`- « Consécutif » = positions consécutives **du jour** (tri fenêtre marché asc). Les fenêtres sans trade fav-band entre deux wins n'interrompent pas le run ; seule une \`lost\` le casse (et les 2 \`sold\` du 10-01 ont été exclues sans casser).`);
L.push(`- Le "span" d'une bande = [début du 1er run, fin du dernier run] ; le WR "bande" compte **toutes** les positions de la fenêtre horaire (y compris les jours sans streak) — pour savoir si le créneau est intrinsèquement bon.`);
L.push(`- Les heures de tranche = heure de début de fenêtre marché ; l'entrée fav-band a lieu après \`favBandMinElapsedSec\` dans la fenêtre (décalage de quelques minutes).`);
L.push(`- ${dupPositionsSameWindow} fenêtre(s) marché contient 2 positions fav-band : \`btc-updown-15m-1790402400\` (26/09 02:00 ET) — buy Down fill 0.68 (won +1.6) puis buy Up fill 0.10 (lost −0.5), ordonnées Down→Up dans la séquence.`);
L.push(`- Slug non parseable : 0 position(s) ignorée(s).`);

const md = L.join("\n");
writeFileSync(join("audits/backtest/fav-band", `${base}.md`), md);
console.log(`Écrit : audits/backtest/fav-band/${base}.json`);
console.log(md);