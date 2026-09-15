/**
 * Dip-revert hedge research — buy the OPPOSITE leg for coverage.
 * READ-ONLY on data/bot-live.db. NO production code changes (user request).
 *
 * Three hedge policies (hedge = BUY the opposite token):
 *   post : immediately at entry, opposite token's ask (3-level walk FOK).
 *          Cost now; pays 1$/share at resolution iff the entry was wrong.
 *   free : only hedge when favAsk + oppAsk <= freeMaxSum (pair locks
 *          (1 - sum) * shares at resolution, whatever the winner).
 *   stop : when the HELD token's ask collapses below stopAsk (market prices
 *          us as the loser), buy the opposite token at its ask.
 *
 * Position: hold-to-resolution (2026-09-14 lesson: early sells degrade PnL).
 * Accounting: hedge cost paid at execution (once); position + hedge payouts
 * settled at resolution (once).
 *
 * Run: npx tsx scripts/research/dip-revert-research/dip-hedge-sim.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUniverse, BASE } from "./dip-sim.mts";

type Mode = "post" | "free" | "stop" | "limit";

interface HedgeParams {
  mode: Mode;
  ratio: number; // hedge notional = ratio * position notional
  freeMaxSum: number; // free: trigger on favAsk + oppAsk
  stopAsk: number | null; // stop: trigger when held ask <= stopAsk
  entryBase: "official" | "winner"; // official base vs e150+d050 winner
  /** true: hedge shares = position shares (classic coverage, locks size*(1-sum)). */
  shareParity?: boolean;
  /** limit: resting BUY limit price on the opposite leg (fills incrementally). */
  limitAsk?: number | null;
}

const P0: HedgeParams = {
  mode: "post",
  ratio: 1.0,
  freeMaxSum: 1.0,
  stopAsk: null,
  entryBase: "official",
};

interface Level {
  px: number;
  sz: number;
}
interface SideBook {
  ask: number | null;
  bid: number | null;
  askSize: number | null;
  asks: Level[];
  bids: Level[];
}
interface Tick {
  ts: number;
  up: SideBook;
  down: SideBook;
}
interface Universe {
  slugs: Map<string, Tick[]>;
  resMap: Map<string, number>;
}

/** FOK buy with worst-price protection: fills ONLY at <= orderPx (CLOB contract:
 * the market-order price is a worst-price limit, insufficient depth = KILLED,
 * see references/clob-market-orders.md). Returns null when killed. */
function buyFok(asks: Level[], orderPx: number, size: number) {
  let left = size;
  let notional = 0;
  for (let i = 0; i < 3 && i < asks.length; i++) {
    if (asks[i].px > orderPx + 1e-9) break; // beyond worst-price protection
    const take = Math.min(left, asks[i].sz);
    notional += take * asks[i].px;
    left -= take;
  }
  if (left > 1e-9) return null;
  return { shares: size, notional };
}

function runHedgeSim(u: Universe, P: HedgeParams, slugFilter?: (slug: string) => boolean) {
  let fills = 0;
  let hedges = 0;
  let hedgeKills = 0;
  let wins = 0;
  let losses = 0;
  let pnl = 0;
  let hedgeCostTot = 0;
  let hedgeSharesTotal = 0;

  for (const [slug, ticks] of u.slugs) {
    if (slugFilter && !slugFilter(slug)) continue;
    const res = u.resMap.get(slug);
    if (res === undefined) continue;
    const wStartSec = Number(slug.split("-").pop());
    const wsMs = wStartSec * 1000;

    const samples: Array<{ ts: number; ask: number }> = [];
    let entry: {
      price: number;
      size: number;
      idx: 0 | 1;
      hedgeShares: number;
      hedgeCost: number;
      limitTarget: number;
    } | null = null;
    let hedged = false;

    for (const t of ticks) {
      const held = entry?.idx === 1 ? t.down : t.up;
      const opp = entry?.idx === 1 ? t.up : t.down;
      const fav =
        t.up.ask != null && (t.down.ask == null || t.up.ask >= t.down.ask) ? t.up : t.down;
      const favAsk = fav.ask;

      // favorite ask sample series (as live strategy: push before guards)
      if (favAsk != null) {
        const cutoff = Math.max(t.ts - BASE.lookbackMs, wsMs);
        while (samples.length > 0 && samples[0].ts < cutoff) samples.shift();
        if (samples.length === 0 || samples[samples.length - 1].ts !== t.ts) {
          samples.push({ ts: t.ts, ask: favAsk });
        } else {
          samples[samples.length - 1].ask = favAsk;
        }
      }

      // --- hedge triggers on an existing position ---
      if (entry) {
        // limit: resting BUY limit at limitAsk on the OPPOSITE leg. Fills
        // incrementally each tick the opposite ask <= limitAsk (GTC,
        // no cancel — the window is short so the order just expires).
        const oppAsks = opp.asks ?? [];
        if (P.mode === "limit" && P.limitAsk != null) {
          const remaining = entry.limitTarget - entry.hedgeShares;
          if (remaining > 1e-9 && oppAsks.length > 0 && oppAsks[0].px <= P.limitAsk) {
            // walk levels priced <= limit
            let left = remaining;
            let notional = 0;
            for (let i = 0; i < oppAsks.length && left > 0; i++) {
              const lv = oppAsks[i];
              if (lv.px > P.limitAsk) break;
              const take = Math.min(left, lv.sz);
              notional += take * lv.px;
              left -= take;
            }
            if (left < remaining - 1e-9) {
              const filled = remaining - left;
              pnl -= notional;
              hedgeCostTot += notional;
              hedgeSharesTotal += filled;
              entry.hedgeShares += filled;
              entry.hedgeCost += notional;
              if (left <= 1e-9) {
                hedges++; // fully filled
                hedged = true;
              }
            }
          }
        }
        // free: recheck each tick until the pair costs <= freeMaxSum
        else if (
          !hedged &&
          P.mode === "free" &&
          favAsk != null &&
          opp.ask != null &&
          oppAsks.length > 0 &&
          favAsk + opp.ask <= P.freeMaxSum
        ) {
          const hSize = P.shareParity
            ? Math.min(entry.size, 30)
            : Math.min((P.ratio * entry.price * entry.size) / opp.ask, 30);
          // FOK priced at the current ask (worst-price limit: fills only at <= ask)
          const f = buyFok(oppAsks, opp.ask, hSize);
          if (f) {
            pnl -= f.notional;
            hedgeCostTot += f.notional;
            hedgeSharesTotal += f.shares;
            hedges++;
            hedged = true;
            entry.hedgeShares += f.shares;
            entry.hedgeCost += f.notional;
          } else {
            hedgeKills++;
          }
        }
        // stop: held ask collapsed; hedge at opposite ask
        else if (
          !hedged &&
          P.mode === "stop" &&
          P.stopAsk != null &&
          held.ask != null &&
          held.ask <= P.stopAsk &&
          oppAsks.length > 0
        ) {
          const hSize = Math.min((P.ratio * entry.price * entry.size) / Math.max(opp.ask ?? 0.05, 0.05), 30);
          // FOK priced at the current ask (worst-price limit)
          const f = opp.ask != null ? buyFok(oppAsks, opp.ask, hSize) : null;
          if (f) {
            pnl -= f.notional;
            hedgeCostTot += f.notional;
            hedgeSharesTotal += f.shares;
            hedges++;
            hedged = true;
            entry.hedgeShares += f.shares;
            entry.hedgeCost += f.notional;
          } else {
            hedgeKills++;
          }
        }
      }

      if (entry) continue;

      // --- entry gates (mirror dip-sim, same series/guards) ---
      const minElapsedSec = P.entryBase === "winner" ? 150 : 180;
      const minDrop = P.entryBase === "winner" ? 0.05 : 0.03;
      const elapsedSec = t.ts / 1000 - wStartSec;
      if (elapsedSec < minElapsedSec) continue;
      if (favAsk == null) continue;
      if (favAsk < BASE.bandMin || favAsk > BASE.bandMax) continue;
      const favBid = fav.bid;
      if (favBid != null && favAsk - favBid > BASE.maxSpread) continue;
      const size = Math.min(BASE.orderUsdc / favAsk, 30);
      if (fav.askSize != null && fav.askSize < size) continue;
      if (samples.length < 2) continue;
      if (samples[samples.length - 1].ts - samples[0].ts < BASE.lookbackMs * 0.7) continue;
      const low = Math.min(...samples.map((s) => s.ask));
      if (samples[0].ask - favAsk < minDrop) continue;
      if (!(favAsk > low)) continue;
      if (!(favAsk - low >= 0.001)) continue;

      entry = {
        price: favAsk,
        size,
        idx: fav === t.up ? 0 : 1,
        hedgeShares: 0,
        hedgeCost: 0,
        // limit mode: target the SAME number of shares as the position
        // (locks size * (1 - entry - limitAsk) once fully filled)
        limitTarget: P.mode === "limit" ? size : 0,
      };
      fills++;

      // post: hedge immediately at the opposite ask
      if (P.mode === "post") {
        const hSize = Math.min((P.ratio * entry.price * entry.size) / Math.max(opp.ask ?? 1, 0.05), 30);
        // FOK priced at the current ask (worst-price limit)
        const f = opp.ask != null && opp.asks.length > 0 ? buyFok(opp.asks, opp.ask, hSize) : null;
        if (f) {
          pnl -= f.notional;
          hedgeCostTot += f.notional;
          hedgeSharesTotal += f.shares;
          hedges++;
          hedged = true;
          entry.hedgeShares += f.shares;
          entry.hedgeCost += f.notional;
        } else {
          hedgeKills++;
        }
      }
    }

    if (!entry) continue;
    // resolution: position pays 1$/share iff right; hedge pays 1$/share iff wrong
    const posPayout = entry.size * (res === entry.idx ? 1 : 0);
    const hedgePayout = entry.hedgeShares * (res === entry.idx ? 0 : 1);
    pnl += posPayout - entry.price * entry.size + hedgePayout;
    if (res === entry.idx) wins++;
    else losses++;
  }

  return {
    fills,
    hedges,
    hedgeKills,
    wins,
    losses,
    winRate: fills ? Math.round((wins / fills) * 1000) / 10 : null,
    pnl: Math.round(pnl * 100) / 100,
    hedgeCostTot: Math.round(hedgeCostTot * 100) / 100,
    hedgeSharesTotal: Math.round(hedgeSharesTotal * 100) / 100,
  };
}

// ---- grid driver ----
const u = loadUniverse() as unknown as Universe;
const dayOf = (slug: string) =>
  new Date(Number(slug.split("-").pop()) * 1000).toISOString().slice(0, 10);
const days = [...new Set([...u.slugs.keys()].map(dayOf))].sort();

const rows: any[] = [];
function push(label: string, P: HedgeParams) {
  const r = runHedgeSim(u, P);
  const byDay: Record<string, number> = {};
  for (const d of days) {
    const rd = runHedgeSim(u, P, (slug) => dayOf(slug) === d);
    byDay[d] = Math.round(rd.pnl * 100) / 100;
  }
  rows.push({ label, ...r, byDay });
  process.stderr.write(
    `${label}: fills=${r.fills} hedges=${r.hedges} kills=${r.hedgeKills} pnl=${r.pnl}\n`,
  );
}

// reference: pure hold (no hedge ever triggers)
push("no-hedge-ref", { ...P0, mode: "free", freeMaxSum: 0 });
// parity: classic same-shares coverage, hedge as soon as sum <= threshold
push("free-parity-sum1.00", { ...P0, mode: "free", freeMaxSum: 1.0, shareParity: true });
push("free-parity-sum1.02", { ...P0, mode: "free", freeMaxSum: 1.02, shareParity: true });
push("free-parity-sum1.05", { ...P0, mode: "free", freeMaxSum: 1.05, shareParity: true });
push("free-parity-sum1.00-winner", { ...P0, mode: "free", freeMaxSum: 1.0, shareParity: true, entryBase: "winner" });
// POST: hedge at entry, ratio of the position notional
push("post-r100", { ...P0, mode: "post", ratio: 1.0 });
push("post-r050", { ...P0, mode: "post", ratio: 0.5 });
push("post-r100-winner", { ...P0, mode: "post", ratio: 1.0, entryBase: "winner" });
push("post-r050-winner", { ...P0, mode: "post", ratio: 0.5, entryBase: "winner" });
// FREE: hedge only when the pair costs <= 1 (locked profit)
push("free-sum0.98", { ...P0, mode: "free", freeMaxSum: 0.98 });
push("free-sum0.99", { ...P0, mode: "free", freeMaxSum: 0.99 });
push("free-sum1.00", { ...P0, mode: "free", freeMaxSum: 1.0 });
push("free-sum1.00-winner", { ...P0, mode: "free", freeMaxSum: 1.0, entryBase: "winner" });
// STOP: hedge when the held ask collapses
push("stop-a0.35", { ...P0, mode: "stop", stopAsk: 0.35 });
push("stop-a0.30", { ...P0, mode: "stop", stopAsk: 0.30 });
push("stop-a0.25", { ...P0, mode: "stop", stopAsk: 0.25 });
push("stop-a0.20", { ...P0, mode: "stop", stopAsk: 0.20 });
push("stop-a0.30-winner", { ...P0, mode: "stop", stopAsk: 0.3, entryBase: "winner" });

// LIMIT: resting BUY limit on the opposite leg (fills incrementally, GTC)
push("limit-0.20", { ...P0, mode: "limit", limitAsk: 0.20 });
push("limit-0.15", { ...P0, mode: "limit", limitAsk: 0.15 });
push("limit-0.25", { ...P0, mode: "limit", limitAsk: 0.25 });
push("limit-0.30", { ...P0, mode: "limit", limitAsk: 0.30 });
push("limit-0.10", { ...P0, mode: "limit", limitAsk: 0.10 });
push("limit-0.20-winner", { ...P0, mode: "limit", limitAsk: 0.2, entryBase: "winner" });
push("limit-0.15-winner", { ...P0, mode: "limit", limitAsk: 0.15, entryBase: "winner" });
push("limit-0.25-winner", { ...P0, mode: "limit", limitAsk: 0.25, entryBase: "winner" });

mkdirSync(join("audits", "backtest", "dip-revert"), { recursive: true });
const outPath = join("audits", "backtest", "dip-revert", `dip-hedge-sim-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(rows, null, 2));

const basePnl = rows.find((r) => r.label === "no-hedge-ref")!.pnl;
const ranked = [...rows].sort((a, b) => b.pnl - a.pnl);
console.log("\n--- ranked by pnl (delta vs no-hedge) ---");
for (const r of ranked) {
  const dayStr = days.map((d) => `${d.slice(5)}:${r.byDay[d] ?? 0}`).join(" ");
  console.log(
    `${r.label.padEnd(20)} fills=${String(r.fills).padStart(3)} hedges=${String(r.hedges).padStart(3)} kills=${String(r.hedgeKills).padStart(3)} wr=${String(r.winRate).padStart(5)} pnl=${String(r.pnl).padStart(8)} d=${String(Math.round((r.pnl - basePnl) * 100) / 100).padStart(7)} | ${dayStr}`,
  );
}
console.log(`\nsaved: ${outPath}`);