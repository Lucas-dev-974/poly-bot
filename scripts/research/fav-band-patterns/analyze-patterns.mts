/**
 * Pattern analysis: fav-band winners vs losers.
 * Reads audits/backtest/fav-band/patterns/dataset-latest.json (from extract-dataset.mts).
 * Writes stats JSON + French Markdown report.
 *
 * Usage: npx tsx scripts/research/fav-band-patterns/analyze-patterns.mts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cohenD,
  mean,
  median,
  quantile,
  round,
  stdev,
  type FeatureRow,
} from "./features.mts";

const OUT_DIR = join("audits", "backtest", "fav-band", "patterns");
const DATASET = join(OUT_DIR, "dataset-latest.json");

type NumKey = keyof FeatureRow;

const FEATURES: { key: NumKey; label: string }[] = [
  { key: "elapsedSec", label: "Elapsed a l'entree (s)" },
  { key: "remainingSec", label: "Temps restant a l'entree (s)" },
  { key: "entryAsk", label: "Ask favori a l'entree" },
  { key: "fillPrice", label: "Fill price" },
  { key: "bestAskAtFill", label: "Best ask at fill" },
  { key: "entrySpread", label: "Spread a l'entree" },
  { key: "entryAskSize", label: "Ask size a l'entree" },
  { key: "favMarginAtEntry", label: "Marge favori vs autre a l'entree" },
  { key: "flipsBefore", label: "Flips favori avant entree" },
  { key: "flipsAfter", label: "Flips favori apres entree" },
  { key: "askRangeBefore", label: "Range ask avant entree" },
  { key: "askRangeAfter", label: "Range ask apres entree" },
  { key: "pathDelta30s", label: "Delta ask +30s" },
  { key: "pathDelta60s", label: "Delta ask +60s" },
  { key: "pathDelta120s", label: "Delta ask +120s" },
  { key: "maeAsk", label: "MAE ask (min apres - entree)" },
  { key: "mfeAsk", label: "MFE ask (max apres - entree)" },
  { key: "favShareBefore", label: "Part favori avant entree" },
  { key: "favShareAfter", label: "Part favori apres entree" },
  { key: "lowerLowsAfter", label: "Lower-lows apres entree" },
  { key: "timeToResolveSec", label: "Delai entree -> resolution (s)" },
  { key: "ticksBefore", label: "Ticks avant entree" },
  { key: "ticksAfter", label: "Ticks apres entree" },
];

function nums(rows: FeatureRow[], key: NumKey): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

function summarize(rows: FeatureRow[], key: NumKey) {
  const xs = nums(rows, key);
  return {
    n: xs.length,
    mean: round(mean(xs), 4),
    median: round(median(xs), 4),
    p25: round(quantile(xs, 0.25), 4),
    p75: round(quantile(xs, 0.75), 4),
    stdev: round(stdev(xs), 4),
  };
}

type FilterSpec = { id: string; description: string; test: (r: FeatureRow) => boolean };

function wr(rows: FeatureRow[]) {
  const wins = rows.filter((r) => r.label === "win").length;
  const losses = rows.filter((r) => r.label === "loss").length;
  const n = wins + losses;
  const pnl = rows.reduce((s, r) => s + (r.pnl ?? 0), 0);
  return { n, wins, losses, wr: n ? wins / n : 0, pnl: round(pnl, 2)! };
}

function buildFilters(): FilterSpec[] {
  return [
    { id: "elapsed_ge_300", description: "elapsedSec >= 300", test: (r) => (r.elapsedSec ?? -1) >= 300 },
    { id: "elapsed_ge_400", description: "elapsedSec >= 400", test: (r) => (r.elapsedSec ?? -1) >= 400 },
    { id: "elapsed_lt_350", description: "elapsedSec < 350", test: (r) => (r.elapsedSec ?? 9999) < 350 },
    { id: "entryAsk_ge_0.78", description: "entryAsk >= 0.78", test: (r) => (r.entryAsk ?? 0) >= 0.78 },
    { id: "entryAsk_le_0.75", description: "entryAsk <= 0.75", test: (r) => (r.entryAsk ?? 1) <= 0.75 },
    { id: "entryAsk_0.72_0.80", description: "0.72 <= entryAsk <= 0.80", test: (r) => { const a = r.entryAsk; return a != null && a >= 0.72 && a <= 0.80; } },
    { id: "flipsBefore_eq_0", description: "flipsBefore == 0", test: (r) => r.flipsBefore === 0 },
    { id: "flipsBefore_le_1", description: "flipsBefore <= 1", test: (r) => r.flipsBefore <= 1 },
    { id: "flipsBefore_ge_3", description: "flipsBefore >= 3", test: (r) => r.flipsBefore >= 3 },
    { id: "askRangeBefore_le_0.08", description: "askRangeBefore <= 0.08", test: (r) => (r.askRangeBefore ?? 99) <= 0.08 },
    { id: "askRangeBefore_ge_0.15", description: "askRangeBefore >= 0.15", test: (r) => (r.askRangeBefore ?? 0) >= 0.15 },
    { id: "favShareBefore_ge_0.85", description: "favShareBefore >= 0.85", test: (r) => (r.favShareBefore ?? 0) >= 0.85 },
    { id: "favShareBefore_lt_0.70", description: "favShareBefore < 0.70", test: (r) => (r.favShareBefore ?? 1) < 0.70 },
    { id: "favMargin_ge_0.20", description: "favMarginAtEntry >= 0.20", test: (r) => (r.favMarginAtEntry ?? 0) >= 0.20 },
    { id: "path60_ge_0", description: "pathDelta60s >= 0 (ex-post)", test: (r) => (r.pathDelta60s ?? -1) >= 0 },
    { id: "mae_gt_-0.05", description: "maeAsk > -0.05 (ex-post)", test: (r) => (r.maeAsk ?? -1) > -0.05 },
    { id: "lowerLows_eq_0", description: "lowerLowsAfter == 0 (ex-post)", test: (r) => r.lowerLowsAfter === 0 },
    { id: "remaining_ge_400", description: "remainingSec >= 400", test: (r) => (r.remainingSec ?? -1) >= 400 },
    { id: "spread_le_0.02", description: "entrySpread <= 0.02", test: (r) => (r.entrySpread ?? 99) <= 0.02 },
  ];
}

if (!existsSync(DATASET)) throw new Error("Missing " + DATASET + ". Run extract-dataset.mts first.");

const payload = JSON.parse(readFileSync(DATASET, "utf8")) as { meta: any; rows: FeatureRow[] };
const rows = payload.rows.filter((r) => r.label === "win" || r.label === "loss");
const wins = rows.filter((r) => r.label === "win");
const losses = rows.filter((r) => r.label === "loss");
const covered = rows.filter((r) => r.coverageOk);
const baseline = wr(rows);

const featureStats = FEATURES.map((f) => {
  const w = summarize(wins, f.key);
  const l = summarize(losses, f.key);
  const d = cohenD(nums(wins, f.key), nums(losses, f.key));
  return {
    key: f.key,
    label: f.label,
    wins: w,
    losses: l,
    meanDiff: round((w.mean ?? 0) - (l.mean ?? 0), 4),
    cohenD: round(d, 3),
    absD: round(d == null ? null : Math.abs(d), 3),
  };
}).sort((a, b) => (b.absD ?? 0) - (a.absD ?? 0));

const filterResults = buildFilters()
  .map((f) => {
    const sub = rows.filter(f.test);
    const m = wr(sub);
    return {
      id: f.id,
      description: f.description,
      ...m,
      wrPct: round(m.wr * 100, 2),
      baselineWrPct: round(baseline.wr * 100, 2),
      liftPp: round((m.wr - baseline.wr) * 100, 2),
      coveragePct: round((m.n / Math.max(1, baseline.n)) * 100, 1),
      exPost: /ex-post/.test(f.description),
    };
  })
  .sort((a, b) => (b.liftPp ?? 0) - (a.liftPp ?? 0));

function bucketTable(key: NumKey, edges: number[]) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const sub = rows.filter((r) => {
      const v = r[key];
      return typeof v === "number" && v >= lo && v < hi;
    });
    const m = wr(sub);
    out.push({ key, bucket: "[" + lo + ", " + hi + ")", ...m, wrPct: round(m.wr * 100, 2) });
  }
  return out;
}

const buckets = {
  entryAsk: bucketTable("entryAsk", [0.65, 0.7, 0.74, 0.78, 0.82, 0.9]),
  elapsedSec: bucketTable("elapsedSec", [0, 200, 300, 400, 500, 700, 900]),
  flipsBefore: bucketTable("flipsBefore", [0, 1, 2, 4, 8, 50]),
  favShareBefore: bucketTable("favShareBefore", [0, 0.5, 0.7, 0.85, 0.95, 1.01]),
  askRangeBefore: bucketTable("askRangeBefore", [0, 0.05, 0.08, 0.12, 0.2, 0.5]),
};

const byStatus = ["won", "lost", "sold"].map((status) => {
  const sub = payload.rows.filter((r) => r.status === status);
  return { status, n: sub.length, pnl: round(sub.reduce((s, r) => s + (r.pnl ?? 0), 0), 2), avgPnl: round(mean(sub.map((r) => r.pnl ?? 0)), 3) };
});

const byOutcome = ["Up", "Down"].map((outcome) => {
  const sub = rows.filter((r) => r.outcome === outcome);
  const m = wr(sub);
  return { outcome, ...m, wrPct: round(m.wr * 100, 2) };
});

const EX_ANTE = new Set([
  "elapsedSec", "remainingSec", "entryAsk", "fillPrice", "bestAskAtFill",
  "entrySpread", "entryAskSize", "favMarginAtEntry", "flipsBefore",
  "askRangeBefore", "favShareBefore", "ticksBefore",
]);
const exAnteStats = featureStats.filter((f) => EX_ANTE.has(String(f.key)));
const exPostStats = featureStats.filter((f) => !EX_ANTE.has(String(f.key)));

const stats = {
  generatedAt: new Date().toISOString(),
  datasetMeta: payload.meta,
  baseline: { ...baseline, wrPct: round(baseline.wr * 100, 2) },
  coverage: { rows: rows.length, coverageOk: covered.length },
  byStatus,
  byOutcome,
  featureStats,
  filterResults,
  buckets,
  topDiscriminators: featureStats.slice(0, 8),
  topExAnteDiscriminators: exAnteStats.slice(0, 8),
  topExPostDiscriminators: exPostStats.slice(0, 8),
  topActionableFilters: filterResults.filter((f) => !f.exPost && (f.n ?? 0) >= 40).slice(0, 10),
};

mkdirSync(OUT_DIR, { recursive: true });
const statsPath = join(OUT_DIR, "stats-latest.json");
writeFileSync(statsPath, JSON.stringify(stats, null, 2));

const day = new Date().toISOString().slice(0, 10);
const reportPath = join(OUT_DIR, "RAPPORT-patterns-fav-band-" + day + ".md");
const pct = (x: number | null | undefined) => (x == null ? "n/a" : x.toFixed(1) + "%");
const n4 = (x: number | null | undefined) => (x == null ? "n/a" : String(x));
const top5 = stats.topExAnteDiscriminators.slice(0, 5);
const top5Post = stats.topExPostDiscriminators.slice(0, 5);
const actionable = stats.topActionableFilters.slice(0, 5);
const liveCount = payload.meta?.sources?.live?.count ?? "?";
const bt = payload.meta?.sources?.backtest;
const cap50Path = payload.meta?.sources?.cap50Json?.path ?? "absent";
const cap50Row = JSON.stringify(payload.meta?.sources?.cap50Json?.row ?? null);

const mdParts: string[] = [];
const M = (s: string) => mdParts.push(s);
M("# Rapport patterns fav-band - " + day);
M("");
M("## Contexte");
M("");
M("Analyse **gagnants vs perdants** pour la strategie `fav-band`, a partir des ticks");
M("`book_snapshots` (meme source que les scripts research fav-band / backtests).");
M("");
M("### Sources de donnees");
M("");
M("| Source | Utilisee ? | Detail |");
M("|--------|------------|--------|");
M("| Positions live `data/bot-live.db` (`strategyId='fav-band'`, status won/lost/sold) | **Oui (primaire)** | " + liveCount + " positions |");
M("| JSON backtest cap50 `fav-band-opt-cap50-*.json` | Meta seulement | Resume pnl/trades/wr - **pas de lignes par position** |");
M("| `backtest_positions` (run optionnel) | " + (bt ? "Oui" : "Non") + " | " + (bt ? JSON.stringify(bt) : "non demande") + " |");
M("");
M("Cap50 de reference : `" + cap50Path + "`");
M("");
M("Resume cap50 : `" + cap50Row + "`");
M("");
M("**Coverage ticks** : " + stats.coverage.coverageOk + "/" + stats.coverage.rows + " positions win/loss avec books exploitables.");
M("Les chiffres ci-dessous ne sont **pas inventes** : si une feature a `n` faible, elle est marquee comme telle.");
M("");
M("## Baseline");
M("");
M("- Positions win/loss analysees : **" + baseline.n + "** (wins=" + baseline.wins + ", losses=" + baseline.losses + ")");
M("- Winrate : **" + pct(stats.baseline.wrPct) + "**");
M("- PnL cumule (labels win+loss) : **" + n4(baseline.pnl) + "** USDC");
M("- Par status brut : " + byStatus.map((s) => s.status + ": n=" + s.n + " pnl=" + s.pnl).join(" | "));
M("- Par outcome : " + byOutcome.map((o) => o.outcome + ": n=" + o.n + " WR=" + pct(o.wrPct)).join(" | "));
M("");
M("## Top discriminateurs EX-ANTE (Cohen's d, win vs loss)");
M("");
M("Features disponibles **a l'entree** (pas de path post-fill). |d|~0.2 faible, 0.5 moyen, 0.8 fort.");
M("");
M("| Rang | Feature | mean(win) | mean(loss) | diff | Cohen's d | n win/loss |");
M("|------|---------|-----------|------------|------|-----------|------------|");
for (let i = 0; i < top5.length; i++) {
  const f = top5[i];
  M("| " + (i + 1) + " | " + f.label + " (`" + f.key + "`) | " + n4(f.wins.mean) + " | " + n4(f.losses.mean) + " | " + n4(f.meanDiff) + " | **" + n4(f.cohenD) + "** | " + f.wins.n + "/" + f.losses.n + " |");
}
M("");
M("### Lecture rapide des 5 plus forts");
M("");
for (let i = 0; i < top5.length; i++) {
  const f = top5[i];
  const dir = (f.meanDiff ?? 0) > 0 ? "plus elevee chez les wins" : "plus elevee chez les losses";
  M((i + 1) + ". **" + f.label + "** : " + dir + " (dmean=" + n4(f.meanDiff) + ", d=" + n4(f.cohenD) + ").");
}
M("");
M("");
M("## Top discriminateurs EX-POST (diagnostic uniquement)");
M("");
M("Ces features utilisent le chemin **apres** l'entree : elles separent tres bien win/loss mais ne sont **pas** des filtres live.");
M("");
M("| Rang | Feature | mean(win) | mean(loss) | diff | Cohen's d | n win/loss |");
M("|------|---------|-----------|------------|------|-----------|------------|");
for (let i = 0; i < top5Post.length; i++) {
  const f = top5Post[i];
  M("| " + (i + 1) + " | " + f.label + " (`" + f.key + "`) | " + n4(f.wins.mean) + " | " + n4(f.losses.mean) + " | " + n4(f.meanDiff) + " | **" + n4(f.cohenD) + "** | " + f.wins.n + "/" + f.losses.n + " |");
}
M("");
M("## Filtres actionnables (lift vs baseline, ex-ante seulement)");
M("");
M("Filtres calculables **a l'entree** (pas de path post-entry). Lift = WR_filtre - WR_baseline (points de %).");
M("");
M("| Filtre | n | WR | Lift (pp) | Couverture | PnL |");
M("|--------|---|----|-----------|------------|-----|");
for (const f of actionable) {
  M("| " + f.description + " | " + f.n + " | " + pct(f.wrPct) + " | **" + n4(f.liftPp) + "** | " + pct(f.coveragePct) + " | " + n4(f.pnl) + " |");
}
M("");
M("> Les filtres marques ex-post dans `stats-latest.json` (path/MAE/lower-lows apres entree) servent au diagnostic, **pas** comme filtre live.");
M("");
M("## Distributions par buckets");
M("");
M("### entryAsk");
for (const b of buckets.entryAsk) M("- " + b.bucket + ": n=" + b.n + " WR=" + pct(b.wrPct) + " pnl=" + n4(b.pnl));
M("");
M("### elapsedSec");
for (const b of buckets.elapsedSec) M("- " + b.bucket + ": n=" + b.n + " WR=" + pct(b.wrPct) + " pnl=" + n4(b.pnl));
M("");
M("### flipsBefore");
for (const b of buckets.flipsBefore) M("- " + b.bucket + ": n=" + b.n + " WR=" + pct(b.wrPct) + " pnl=" + n4(b.pnl));
M("");
M("### favShareBefore");
for (const b of buckets.favShareBefore) M("- " + b.bucket + ": n=" + b.n + " WR=" + pct(b.wrPct) + " pnl=" + n4(b.pnl));
M("");
M("### askRangeBefore");
for (const b of buckets.askRangeBefore) M("- " + b.bucket + ": n=" + b.n + " WR=" + pct(b.wrPct) + " pnl=" + n4(b.pnl));
M("");
M("## Idees de filtres a tester (backtest)");
M("");
M("1. **Ask plus haut / favori plus net** : tester `favBandAskMin` remonte (ex. 0.72-0.78) et/ou un seuil `favMarginAtEntry` (ask_held - ask_other).");
M("2. **Bande sweet-spot** : sur ce live, `[0.70, 0.78)` a le meilleur couple WR/PnL - a rejouer sur le runner officiel fav-band-opt.");
M("3. **Elapsed >= 300s** : lift modeste mais PnL live positif sur le sous-ensemble - tester `favBandMinElapsedSec=300`.");
M("4. **Ne pas sur-filtrer les flips** : `flipsBefore<=1` degrade le WR ici (contre-intuitif) - ne pas bloquer sur stabilite seule.");
M("5. **Exit / MAE** : les losses ont MAE ask bien plus profonde (ex-post) - retenter exit-B / lower-low cut sur le grid, pas un filtre d'entree.");
M("");
M("## Limites / caveats");
M("");
M("- Le JSON **fav-band-opt-cap50** ne contient pas les positions individuelles : l'analyse porte sur le **live** fav-band (et un run backtest seulement si `--include-backtest-run` a ete passe a l'extract).");
M("- Le live peut differer du preset `fav-band-opt` (sizing, maxElapsed, exit rules, capital).");
M("- Cohen's d et lifts sont **descriptifs** ; pas de correction multiple ni de validation out-of-sample ici.");
M("- Features path/MAE/lower-lows sont **ex-post** : utiles pour comprendre les pertes, pas pour filtrer a l'entree.");
M("- Coverage partielle possible sur de tres vieilles fenetres : voir `coverageNote` dans le dataset.");
M("");
M("## Fichiers");
M("");
M("- Dataset : `audits/backtest/fav-band/patterns/dataset-latest.json` (+ CSV)");
M("- Stats : `audits/backtest/fav-band/patterns/stats-latest.json`");
M("- Scripts : `scripts/research/fav-band-patterns/`");
M("");
M("## Re-run");
M("");
M('```bash');
M("npx tsx scripts/research/fav-band-patterns/extract-dataset.mts");
M("npx tsx scripts/research/fav-band-patterns/analyze-patterns.mts");
M("# ou");
M("npx tsx scripts/research/fav-band-patterns/run-pipeline.mts");
M('```');
M("");

const md = mdParts.join("\n");
const bom = "\uFEFF";
writeFileSync(reportPath, bom + md, "utf8");
writeFileSync(join(OUT_DIR, "RAPPORT-patterns-fav-band-latest.md"), bom + md, "utf8");

console.log(JSON.stringify({
  statsPath,
  reportPath,
  baseline: stats.baseline,
  top5ExAnte: top5.map((f) => ({ key: f.key, cohenD: f.cohenD, meanDiff: f.meanDiff, winMean: f.wins.mean, lossMean: f.losses.mean })),
  top5ExPost: top5Post.map((f) => ({ key: f.key, cohenD: f.cohenD, meanDiff: f.meanDiff, winMean: f.wins.mean, lossMean: f.losses.mean })),
  topFilters: actionable.map((f) => ({ id: f.id, liftPp: f.liftPp, wrPct: f.wrPct, n: f.n })),
}, null, 2));