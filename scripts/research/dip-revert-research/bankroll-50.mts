/**
 * Dip-revert 15m bankroll backtest — starting capital $50.
 *
 * Reuses entry rules + hold PnL from partial-tp-grid.mts /
 * config/presets/dip-revert.json. Chronological by entryTs.
 *
 * Sizing modes:
 *   - capital-capped (PRIMARY): orderUsdc = min(capital, $15)
 *   - fixed-15: always $15 if capital funds it, else skip
 *   - kelly-lite: full sample Kelly fraction of capital, capped at $15
 *     (half-Kelly reported as inert check — below MIN_CLOB at $50)
 *
 * If sized size < MIN_CLOB (5) or cost > capital → skip signal.
 * After trade: capital += pnl; if capital <= 0 → ruin, stop.
 *
 * Usage (repo root):
 *   npx tsx scripts/research/dip-revert-research/bankroll-50.mts
 *
 * READ-ONLY on data/bot-live.db. Writes only under audits/backtest/dip-revert/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUniverse, type Universe } from "../antiflip-revert/universe.mts";

const OUT_DIR = join("audits", "backtest", "dip-revert");
const START_CAPITAL = 50;
const ORDER_USDC = 15;
const MAX_SHARES = 30;
const MIN_CLOB = 5;
const BAND_MIN = 0.55;
const BAND_MAX = 0.65;
const MIN_DROP = 0.03;
const LOOKBACK_MS = 60_000;
const MIN_ELAPSED = 180;
const MAX_ELAPSED = 420;
const MAX_SPREAD = 0.04;

interface Entry {
  slug: string;
  wsSec: number;
  entryTs: number;
  price: number;
  refSize: number;
  outcomeIdx: 0 | 1;
  winnerIdx: number;
}

function collectEntries(universe: Universe): Entry[] {
  const out: Entry[] = [];
  for (const [slug, ticks] of universe.slugs) {
    const res = universe.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (universe.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;

    const samples: Array<{ ts: number; ask: number }> = [];
    let entry: Omit<Entry, "slug" | "wsSec" | "winnerIdx"> | null = null;

    for (let i = 0; i < ticks.length; i++) {
      const t = ticks[i];
      const elapsedSec = (t.ts - wsMs) / 1000;
      if (elapsedSec < 0 || elapsedSec >= 900) continue;

      const favIdx: 0 | 1 | null =
        t.up.ask != null && t.down.ask == null
          ? 0
          : t.down.ask != null && t.up.ask == null
            ? 1
            : t.up.ask != null && t.down.ask != null
              ? t.up.ask >= t.down.ask
                ? 0
                : 1
              : null;
      if (favIdx == null) continue;
      const favBook = favIdx === 0 ? t.up : t.down;
      const favAsk = favBook.ask;
      if (favAsk == null) continue;

      const cutoff = Math.max(t.ts - LOOKBACK_MS, wsMs);
      while (samples.length > 0 && samples[0].ts < cutoff) samples.shift();
      samples.push({ ts: t.ts, ask: favAsk });

      if (entry) continue;
      if (elapsedSec < MIN_ELAPSED) continue;
      if (elapsedSec > MAX_ELAPSED) continue;
      if (favAsk < BAND_MIN || favAsk > BAND_MAX) continue;
      const favBid = favBook.bid;
      if (favBid != null && favAsk - favBid > MAX_SPREAD) continue;
      const size = Math.min(ORDER_USDC / favAsk, MAX_SHARES);
      if (size < MIN_CLOB) continue;
      if (favBook.askSize != null && favBook.askSize < size) continue;
      if (samples.length < 2) continue;
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (last.ts - first.ts < LOOKBACK_MS * 0.7) continue;
      const low = Math.min(...samples.map((s) => s.ask));
      if (first.ask - favAsk < MIN_DROP) continue;
      if (!(favAsk > low)) continue;
      if (!(favAsk - low >= 0.001)) continue;

      entry = {
        entryTs: t.ts,
        price: favAsk,
        refSize: size,
        outcomeIdx: favIdx,
      };
    }

    if (!entry) continue;
    out.push({
      slug,
      wsSec: wsMs / 1000,
      winnerIdx: res,
      ...entry,
    });
  }
  return out;
}

type SizeMode = "capital-capped" | "fixed-15" | "kelly-lite";

interface Sized {
  orderUsdc: number;
  size: number;
  cost: number;
}

function sizeOrder(
  capital: number,
  price: number,
  mode: SizeMode,
  kellyFrac: number,
): Sized | null {
  if (capital <= 0 || price <= 0) return null;
  let orderUsdc: number;
  if (mode === "fixed-15") {
    orderUsdc = ORDER_USDC;
  } else if (mode === "kelly-lite") {
    const raw = Math.max(0, kellyFrac * capital);
    orderUsdc = Math.min(ORDER_USDC, raw);
  } else {
    orderUsdc = Math.min(capital, ORDER_USDC);
  }
  if (orderUsdc <= 0) return null;
  orderUsdc = Math.min(orderUsdc, capital);
  const size = Math.min(orderUsdc / price, MAX_SHARES);
  if (size < MIN_CLOB) return null;
  const cost = size * price;
  if (cost > capital + 1e-9) return null;
  return { orderUsdc: cost, size, cost };
}

function holdPnl(price: number, size: number, outcomeIdx: 0 | 1, winnerIdx: number): number {
  const won = outcomeIdx === winnerIdx;
  return won ? (1 - price) * size : -price * size;
}

interface EquityPoint {
  i: number;
  slug: string;
  entryTs: number;
  capitalBefore: number;
  orderUsdc: number;
  size: number;
  price: number;
  won: boolean;
  pnl: number;
  capitalAfter: number;
}

interface BankrollResult {
  mode: SizeMode;
  startCapital: number;
  endCapital: number;
  totalPnl: number;
  peakCapital: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  tradesTaken: number;
  tradesSkipped: number;
  signalsSeen: number;
  wins: number;
  losses: number;
  winRate: number | null;
  ruin: boolean;
  ruinAtTrade: number | null;
  ruinTs: number | null;
  ruinIso: string | null;
  stoppedEarly: boolean;
  signalsRemainingAtStop: number;
  kellyFracUsed: number | null;
  equityCurve: EquityPoint[];
}

function runBankroll(
  entriesChrono: Entry[],
  mode: SizeMode,
  kellyFrac: number,
): BankrollResult {
  let capital = START_CAPITAL;
  let peak = capital;
  let maxDd = 0;
  let taken = 0;
  let skipped = 0;
  let wins = 0;
  let losses = 0;
  let ruin = false;
  let ruinAtTrade: number | null = null;
  let ruinTs: number | null = null;
  const curve: EquityPoint[] = [];
  let i = 0;

  for (; i < entriesChrono.length; i++) {
    const e = entriesChrono[i];
    if (capital <= 0) {
      ruin = true;
      break;
    }
    const sized = sizeOrder(capital, e.price, mode, kellyFrac);
    if (!sized) {
      skipped++;
      continue;
    }
    const won = e.outcomeIdx === e.winnerIdx;
    const pnl = holdPnl(e.price, sized.size, e.outcomeIdx, e.winnerIdx);
    const before = capital;
    capital = Math.round((capital + pnl) * 1e6) / 1e6;
    if (capital < 0) capital = 0;
    taken++;
    if (won) wins++;
    else losses++;
    if (capital > peak) peak = capital;
    const dd = peak - capital;
    if (dd > maxDd) maxDd = dd;
    curve.push({
      i: taken,
      slug: e.slug,
      entryTs: e.entryTs,
      capitalBefore: before,
      orderUsdc: Math.round(sized.cost * 100) / 100,
      size: Math.round(sized.size * 1000) / 1000,
      price: e.price,
      won,
      pnl: Math.round(pnl * 100) / 100,
      capitalAfter: Math.round(capital * 100) / 100,
    });
    if (capital <= 0) {
      ruin = true;
      ruinAtTrade = taken;
      ruinTs = e.entryTs;
      i++;
      break;
    }
  }

  const remaining = entriesChrono.length - i;

  return {
    mode,
    startCapital: START_CAPITAL,
    endCapital: Math.round(capital * 100) / 100,
    totalPnl: Math.round((capital - START_CAPITAL) * 100) / 100,
    peakCapital: Math.round(peak * 100) / 100,
    maxDrawdown: Math.round(maxDd * 100) / 100,
    maxDrawdownPct: peak > 0 ? Math.round((maxDd / peak) * 1000) / 10 : 0,
    tradesTaken: taken,
    tradesSkipped: skipped,
    signalsSeen: entriesChrono.length,
    wins,
    losses,
    winRate: taken ? Math.round((wins / taken) * 1000) / 10 : null,
    ruin,
    ruinAtTrade,
    ruinTs,
    ruinIso: ruinTs != null ? new Date(ruinTs).toISOString() : null,
    stoppedEarly: ruin,
    signalsRemainingAtStop: remaining,
    kellyFracUsed: mode === "kelly-lite" ? kellyFrac : null,
    equityCurve: curve,
  };
}

function money(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
}

function pct(x: number | null): string {
  return x == null ? "n/a" : `${x.toFixed(1)}%`;
}

const universe = loadUniverse();
console.log(`universe: ${universe.slugs.size} windows (official-aligned BTC 15m)`);

const allEntries = collectEntries(universe);
allEntries.sort((a, b) => a.entryTs - b.entryTs || a.wsSec - b.wsSec);
console.log(`dip-revert hold signals (chrono): ${allEntries.length}`);

let refPnl = 0;
let refWins = 0;
for (const e of allEntries) {
  const pnl = holdPnl(e.price, e.refSize, e.outcomeIdx, e.winnerIdx);
  refPnl += pnl;
  if (e.outcomeIdx === e.winnerIdx) refWins++;
}
const refWr = allEntries.length
  ? Math.round((refWins / allEntries.length) * 1000) / 10
  : 0;
const refEv =
  allEntries.length ? Math.round((refPnl / allEntries.length) * 1000) / 1000 : 0;
const avgPrice =
  allEntries.length
    ? allEntries.reduce((s, e) => s + e.price, 0) / allEntries.length
    : 0.6;
const pWin = refWr / 100;
const bOdds = avgPrice > 0 && avgPrice < 1 ? (1 - avgPrice) / avgPrice : 1;
const fFull = bOdds > 0 ? pWin - (1 - pWin) / bOdds : 0;
const kellyHalf = Math.max(0, Math.min(1, 0.5 * fFull));
const kellyLiteFrac = Math.max(0, Math.min(1, fFull));
console.log(
  `ref hold: n=${allEntries.length} WR=${refWr}% EV=${refEv} totalPnl=${Math.round(refPnl * 100) / 100}`,
);
console.log(
  `kelly-lite: avgPrice=${avgPrice.toFixed(4)} b=${bOdds.toFixed(3)} f*=${fFull.toFixed(4)} halfKelly=${kellyHalf.toFixed(4)} fullKelly=${kellyLiteFrac.toFixed(4)}`,
);

const primary = runBankroll(allEntries, "capital-capped", kellyLiteFrac);
const fixed15 = runBankroll(allEntries, "fixed-15", kellyLiteFrac);
const kellyLite = runBankroll(allEntries, "kelly-lite", kellyLiteFrac);
const kellyHalfResult = runBankroll(allEntries, "kelly-lite", kellyHalf);

mkdirSync(OUT_DIR, { recursive: true });
const generatedAt = new Date().toISOString();
const ts = Date.now();

function summarizeBlock(r: BankrollResult, title: string): string {
  const lines = [
    `### ${title}`,
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Start capital | $${r.startCapital.toFixed(2)} |`,
    `| End capital | $${r.endCapital.toFixed(2)} |`,
    `| Total PnL | ${money(r.totalPnl)} |`,
    `| Peak capital | $${r.peakCapital.toFixed(2)} |`,
    `| Max drawdown | $${r.maxDrawdown.toFixed(2)} (${r.maxDrawdownPct}% of peak) |`,
    `| Signals seen | ${r.signalsSeen} |`,
    `| Trades taken | ${r.tradesTaken} |`,
    `| Trades skipped (undersized) | ${r.tradesSkipped} |`,
    `| Wins / Losses | ${r.wins} / ${r.losses} |`,
    `| Win rate (taken) | ${pct(r.winRate)} |`,
    `| Ruin | ${r.ruin ? "YES" : "NO"} |`,
  ];
  if (r.ruin) {
    lines.push(`| Ruin at trade # | ${r.ruinAtTrade} |`);
    lines.push(`| Ruin time (UTC) | ${r.ruinIso} |`);
    lines.push(`| Signals remaining after stop | ${r.signalsRemainingAtStop} |`);
  }
  if (r.kellyFracUsed != null) {
    lines.push(`| Kelly frac used | ${r.kellyFracUsed.toFixed(4)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function equityTable(r: BankrollResult, maxRows = 24): string {
  if (r.equityCurve.length === 0) return "_No trades taken._\n";
  const head =
    "| # | Entry (UTC) | Slug | Price | Order $ | Won | PnL | Capital after |\n|---|---|---|---|---|---|---|---|";
  const row = (p: EquityPoint) =>
    `| ${p.i} | ${new Date(p.entryTs).toISOString()} | ${p.slug} | ${p.price.toFixed(3)} | ${p.orderUsdc.toFixed(2)} | ${p.won ? "Y" : "N"} | ${money(p.pnl)} | ${p.capitalAfter.toFixed(2)} |`;
  if (r.equityCurve.length <= maxRows) {
    return [head, ...r.equityCurve.map(row)].join("\n") + "\n";
  }
  const half = Math.floor(maxRows / 2);
  const first = r.equityCurve.slice(0, half);
  const last = r.equityCurve.slice(-Math.ceil(maxRows / 2));
  const gap = `| … | … | (${r.equityCurve.length - maxRows} rows omitted) | … | … | … | … | … |`;
  return [head, ...first.map(row), gap, ...last.map(row)].join("\n") + "\n";
}

const firstTs = allEntries[0]?.entryTs;
const lastTs = allEntries[allEntries.length - 1]?.entryTs;
const refPnlR = Math.round(refPnl * 100) / 100;
const minCapAfter = primary.equityCurve.length
  ? Math.min(...primary.equityCurve.map((p) => p.capitalAfter))
  : null;

const md = `# Dip-revert 15m — bankroll backtest ($50 start)

Generated: ${generatedAt} (machine local / ISO)
Universe: ${universe.slugs.size} complete BTC 15m windows (book_snapshots, >=801 ticks, maxGap<=60s, resolved).
Entry: dip-revert preset hold — band ask [${BAND_MIN}, ${BAND_MAX}], minDrop ${MIN_DROP} lookback ${LOOKBACK_MS / 1000}s, rebound (ask>low>=0.001), minElapsed ${MIN_ELAPSED}s, maxElapsed ${MAX_ELAPSED}s, spread<=${MAX_SPREAD}, depth guard, one entry/window.
Exit: **hold to resolution** (no partial TP) — best recent paper (partial-tp-grid: WR~${refWr}%, EV~${money(refEv)}).
Signals: ${allEntries.length} chronological ${firstTs != null ? new Date(firstTs).toISOString() : "n/a"} → ${lastTs != null ? new Date(lastTs).toISOString() : "n/a"}.
Unconstrained ref (fixed $${ORDER_USDC}, no bankroll): n=${allEntries.length}, WR=${pct(refWr)}, total PnL=${money(refPnlR)}, EV/trade=${money(refEv)}.

## Position sizing (documented)

| Mode | Rule | Role |
|---|---|---|
| **capital-capped** | orderUsdc = min(capital, ${ORDER_USDC}); size = min(orderUsdc/ask, ${MAX_SHARES}); require size >= ${MIN_CLOB} and cost <= capital | **PRIMARY** |
| fixed-15 | Always $${ORDER_USDC} if capital funds full cost + size>=${MIN_CLOB}, else skip | Sensitivity |
| kelly-lite | orderUsdc = min(${ORDER_USDC}, f* * capital); f*=${kellyLiteFrac.toFixed(4)} (full sample Kelly from WR=${pct(refWr)}, avgAsk=${avgPrice.toFixed(4)}, b=(1-p)/p). Half-Kelly=${kellyHalf.toFixed(4)} is inert at $50 (below MIN_CLOB). | Sensitivity |

Ruin: after a fill, if capital <= 0 then stop trading. Signals with insufficient capital for min CLOB size are **skipped** (not ruin).

## Primary: capital-capped

${summarizeBlock(primary, "capital-capped (PRIMARY)")}

### Equity curve (primary, truncated)

${equityTable(primary, 24)}

## Sensitivity

${summarizeBlock(fixed15, "fixed-$15 (skip if underfunded)")}
${summarizeBlock(kellyLite, "kelly-lite (full sample Kelly f*, cap $15)")}
${summarizeBlock(kellyHalfResult, "kelly half-Kelly (inert check)")}

## Interpretation (short)

- Primary path starts at $${START_CAPITAL} and ends at **$${primary.endCapital.toFixed(2)}** (PnL ${money(primary.totalPnl)}).
- Ruin: **${primary.ruin ? "YES" : "NO"}**${primary.ruin && primary.ruinIso ? ` at trade #${primary.ruinAtTrade} (${primary.ruinIso})` : "."}
- Max DD on primary: **$${primary.maxDrawdown.toFixed(2)}** (${primary.maxDrawdownPct}% of peak $${primary.peakCapital.toFixed(2)}).
- Taken vs skipped: **${primary.tradesTaken}** taken, **${primary.tradesSkipped}** skipped${primary.signalsRemainingAtStop ? `, ${primary.signalsRemainingAtStop} never reached after stop` : ""}.
- With start $${START_CAPITAL} > order $${ORDER_USDC}, capital-capped matches fixed-$15 unless equity dips below $${ORDER_USDC} (here min capitalAfter=${minCapAfter != null ? "$" + minCapAfter.toFixed(2) : "n/a"}).
- Compared to unconstrained fixed-$${ORDER_USDC} paper (PnL ${money(refPnlR)} on ${allEntries.length} fills), bankroll compounds the same dollar PnL when always sizing at $${ORDER_USDC}.

## Notes

- Fills/PnL path aligned with partial-tp-grid.mts hold variant (same entry guards).
- No live settings changed; DB opened read-only; no push/remote; no real spend.
- Metrics above are computed from this run only — not invented.
`;

const payload = {
  phase: "dip-revert-15m-bankroll-50",
  generatedAt,
  startCapital: START_CAPITAL,
  entryPreset: {
    bandMin: BAND_MIN,
    bandMax: BAND_MAX,
    minDrop: MIN_DROP,
    lookbackMs: LOOKBACK_MS,
    minElapsedSec: MIN_ELAPSED,
    maxElapsedSec: MAX_ELAPSED,
    maxSpread: MAX_SPREAD,
    orderUsdc: ORDER_USDC,
    maxShares: MAX_SHARES,
    minClob: MIN_CLOB,
    exit: "hold",
    source: "config/presets/dip-revert.json + partial-tp-grid.mts",
  },
  universeSize: universe.slugs.size,
  nSignals: allEntries.length,
  range: {
    firstEntryIso: firstTs != null ? new Date(firstTs).toISOString() : null,
    lastEntryIso: lastTs != null ? new Date(lastTs).toISOString() : null,
  },
  unconstrainedRef: {
    n: allEntries.length,
    winRate: refWr,
    totalPnl: refPnlR,
    evPerTrade: refEv,
    avgPrice: Math.round(avgPrice * 10000) / 10000,
  },
  kelly: {
    pWin,
    avgPrice: Math.round(avgPrice * 10000) / 10000,
    bOdds: Math.round(bOdds * 1000) / 1000,
    fFull: Math.round(fFull * 10000) / 10000,
    halfKelly: Math.round(kellyHalf * 10000) / 10000,
    kellyLiteFrac: Math.round(kellyLiteFrac * 10000) / 10000,
  },
  primary,
  sensitivity: {
    fixed15,
    kellyLite,
    kellyHalf: kellyHalfResult,
  },
};

const jsonPath = join(OUT_DIR, `bankroll-50-${ts}.json`);
const mdPath = join(OUT_DIR, `bankroll-50-${ts}.md`);
const latestMd = join(OUT_DIR, "bankroll-50-latest.md");
const latestJson = join(OUT_DIR, "bankroll-50-latest.json");

writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
writeFileSync(mdPath, md);
writeFileSync(latestJson, JSON.stringify(payload, null, 2));
writeFileSync(latestMd, md);

console.log("\n=== PRIMARY capital-capped ===");
console.log(
  `start=${primary.startCapital} end=${primary.endCapital} pnl=${primary.totalPnl} ruin=${primary.ruin} maxDD=${primary.maxDrawdown} taken=${primary.tradesTaken} skipped=${primary.tradesSkipped} WR=${primary.winRate}`,
);
console.log("\n=== fixed-15 ===");
console.log(
  `end=${fixed15.endCapital} pnl=${fixed15.totalPnl} ruin=${fixed15.ruin} maxDD=${fixed15.maxDrawdown} taken=${fixed15.tradesTaken} skipped=${fixed15.tradesSkipped}`,
);
console.log("\n=== kelly-lite (full f*) ===");
console.log(
  `end=${kellyLite.endCapital} pnl=${kellyLite.totalPnl} ruin=${kellyLite.ruin} maxDD=${kellyLite.maxDrawdown} taken=${kellyLite.tradesTaken} skipped=${kellyLite.tradesSkipped} frac=${kellyLiteFrac.toFixed(4)}`,
);
console.log("\n=== kelly half (inert check) ===");
console.log(
  `end=${kellyHalfResult.endCapital} taken=${kellyHalfResult.tradesTaken} skipped=${kellyHalfResult.tradesSkipped} frac=${kellyHalf.toFixed(4)}`,
);
console.log("written:", mdPath);
console.log("written:", jsonPath);
console.log("latest:", latestMd);
