/**
 * Dip-revert TRAILING STOP research — READ-ONLY, no production changes.
 *
 * Trailing stop on the HELD token's own book (v2 lesson: never price an exit
 * on the current favorite's book). Peak = max held ask since entry (init =
 * entry price). Trigger: heldAsk <= peak - trailAbs (absolute) or
 * heldAsk <= peak * (1 - trailPct) (relative). Optional profit-arm: the trail
 * only arms once peak >= entry + armCents (protects against giving back the
 * entry dip bounce).
 *
 * Exit = FOK SELL walking up to 3 bid levels of the HELD token (slippage cap
 * = bid3), killed when depth < size (worst-price semantics, same convention
 * as the 2026-09-14 exit axes for comparability). Killed => retry next tick
 * while the trigger holds (live would re-quote too). Guard: held spread
 * <= 0.05 (a wide-spread book cannot absorb a market sell).
 *
 * After a successful sell the position is CLOSED (cash idle until window end,
 * no re-entry: one leg per pair). No sell => hold-to-resolution.
 *
 * Run: npx tsx scripts/research/dip-revert-research/dip-trailing-sim.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUniverse, BASE, type Universe } from "./dip-sim.mts";

interface TrailParams {
  /** absolute trail distance below peak (cents). null = no trailing. */
  trailAbs: number | null;
  /** relative trail: sell when heldAsk <= peak * (1 - pct). */
  trailPct: number | null;
  /** trail arms only when peak >= entry + armCents (0 = armed immediately). */
  armCents: number;
  /** entry variant: official base or winner (e150+d050). */
  entryBase: "official" | "winner";
}

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

/** FOK SELL walking up to 3 bid levels (desc); null when depth < size. */
function sellFok(bids: Level[], size: number) {
  if (!bids.length) return null;
  let left = size;
  let notional = 0;
  for (let i = 0; i < 3 && i < bids.length; i++) {
    const take = Math.min(left, bids[i].sz);
    notional += take * bids[i].px;
    left -= take;
  }
  if (left > 1e-9) return null;
  return { notional };
}

export function runTrailSim(u: Universe, P: TrailParams, slugFilter?: (s: string) => boolean) {
  let fills = 0;
  let sells = 0;
  let sellKills = 0;
  let wins = 0;
  let losses = 0;
  let pnl = 0;
  let peak = 0;
  let drawdown = 0;
  let sellNotional = 0;
  let holdWins = 0;

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
      peak: number;
      armed: boolean;
    } | null = null;
    let exited = false;

    for (const t of ticks) {
      const held = entry?.idx === 1 ? t.down : t.up;
      const fav =
        t.up.ask != null && (t.down.ask == null || t.up.ask >= t.down.ask) ? t.up : t.down;
      const favAsk = fav.ask;

      // favorite ask series (as live strategy)
      if (favAsk != null) {
        const cutoff = Math.max(t.ts - BASE.lookbackMs, wsMs);
        while (samples.length > 0 && samples[0].ts < cutoff) samples.shift();
        if (samples.length === 0 || samples[samples.length - 1].ts !== t.ts) {
          samples.push({ ts: t.ts, ask: favAsk });
        } else {
          samples[samples.length - 1].ask = favAsk;
        }
      }

      if (entry && !exited) {
        const heldAsk = held.ask;
        const heldBid = held.bid;
        if (heldAsk != null) {
          if (heldAsk > entry.peak) entry.peak = heldAsk;
          if (!entry.armed && entry.peak >= entry.price + P.armCents) entry.armed = true;
          const trigAbs = P.trailAbs != null && heldAsk <= entry.peak - P.trailAbs;
          const trigPct =
            P.trailPct != null && heldAsk <= entry.peak * (1 - P.trailPct);
          if ((P.trailAbs != null || P.trailPct != null) && entry.armed && (trigAbs || trigPct)) {
            const spreadOk =
              heldBid != null && heldAsk - heldBid <= 0.05 + 1e-9 && heldBid != null;
            if (spreadOk) {
              const f = sellFok(held.bids, entry.size);
              if (f) {
                const tradePnl = f.notional - entry.price * entry.size;
                pnl += tradePnl;
                sellNotional += f.notional;
                sells++;
                if (tradePnl > 0) wins++;
                else losses++;
                exited = true;
                peak = Math.max(peak, pnl);
                drawdown = Math.max(drawdown, peak - pnl);
              } else {
                sellKills++; // retry next tick while trigger holds
              }
            }
          }
        }
        continue;
      }
      if (entry) continue;

      // --- entry gates (mirror dip-sim runSim) ---
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

      entry = { price: favAsk, size, idx: fav === t.up ? 0 : 1, peak: favAsk, armed: P.armCents === 0 };
      fills++;
    }

    if (!entry || exited) continue;
    // hold to resolution
    const tradePnl = (res === entry.idx ? 1 : 0) * entry.size - entry.price * entry.size;
    pnl += tradePnl;
    if (res === entry.idx) {
      wins++;
      holdWins++;
    } else losses++;
    peak = Math.max(peak, pnl);
    drawdown = Math.max(drawdown, peak - pnl);
  }

  return {
    fills,
    sells,
    sellKills,
    wins,
    losses,
    winRate: fills ? Math.round((wins / fills) * 1000) / 10 : null,
    pnl: Math.round(pnl * 100) / 100,
    maxDrawdown: Math.round(drawdown * 100) / 100,
    holdWins,
    sellNotional: Math.round(sellNotional * 100) / 100,
  };
}

// ---- grid ----
const u = loadUniverse() as unknown as Universe;
const dayOf = (slug: string) =>
  new Date(Number(slug.split("-").pop()) * 1000).toISOString().slice(0, 10);
const days = [...new Set([...u.slugs.keys()].map(dayOf))].sort();

const rows: any[] = [];
function push(label: string, P: TrailParams) {
  const r = runTrailSim(u, P);
  const byDay: Record<string, number> = {};
  for (const d of days) {
    const rd = runTrailSim(u, P, (slug) => dayOf(slug) === d);
    byDay[d] = Math.round(rd.pnl * 100) / 100;
  }
  rows.push({ label, ...r, byDay });
  process.stderr.write(
    `${label}: fills=${r.fills} sells=${r.sells} kills=${r.sellKills} wr=${r.winRate} pnl=${r.pnl}\n`,
  );
}

push("hold-ref", { trailAbs: null, trailPct: null, armCents: 0, entryBase: "official" });
// absolute trails, armed immediately
push("trail-0.05", { trailAbs: 0.05, trailPct: null, armCents: 0, entryBase: "official" });
push("trail-0.08", { trailAbs: 0.08, trailPct: null, armCents: 0, entryBase: "official" });
push("trail-0.10", { trailAbs: 0.10, trailPct: null, armCents: 0, entryBase: "official" });
push("trail-0.12", { trailAbs: 0.12, trailPct: null, armCents: 0, entryBase: "official" });
push("trail-0.15", { trailAbs: 0.15, trailPct: null, armCents: 0, entryBase: "official" });
// relative trails
push("trailp-0.10", { trailAbs: null, trailPct: 0.10, armCents: 0, entryBase: "official" });
push("trailp-0.15", { trailAbs: null, trailPct: 0.15, armCents: 0, entryBase: "official" });
push("trailp-0.20", { trailAbs: null, trailPct: 0.20, armCents: 0, entryBase: "official" });
push("trailp-0.25", { trailAbs: null, trailPct: 0.25, armCents: 0, entryBase: "official" });
// profit-armed (trail arms only after +4c over entry)
push("trail-0.08-arm4", { trailAbs: 0.08, trailPct: null, armCents: 0.04, entryBase: "official" });
push("trail-0.10-arm4", { trailAbs: 0.10, trailPct: null, armCents: 0.04, entryBase: "official" });
push("trail-0.12-arm4", { trailAbs: 0.12, trailPct: null, armCents: 0.04, entryBase: "official" });
push("trailp-0.15-arm4", { trailAbs: null, trailPct: 0.15, armCents: 0.04, entryBase: "official" });
push("trailp-0.20-arm4", { trailAbs: null, trailPct: 0.20, armCents: 0.04, entryBase: "official" });
// winner entry (e150+d050) with the best-looking trailing candidates
push("trail-0.10-winner", { trailAbs: 0.10, trailPct: null, armCents: 0, entryBase: "winner" });
push("trail-0.12-arm4-winner", { trailAbs: 0.12, trailPct: null, armCents: 0.04, entryBase: "winner" });
push("trailp-0.20-winner", { trailAbs: null, trailPct: 0.20, armCents: 0, entryBase: "winner" });

mkdirSync(join("audits", "backtest", "dip-revert"), { recursive: true });
const outPath = join("audits", "backtest", "dip-revert", `dip-trailing-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(rows, null, 2));

const basePnl = rows.find((r) => r.label === "hold-ref")!.pnl;
console.log("\n--- ranked by pnl (delta vs hold-to-resolution) ---");
for (const r of [...rows].sort((a, b) => b.pnl - a.pnl)) {
  const dayStr = days.map((d) => `${d.slice(5)}:${r.byDay[d] ?? 0}`).join(" ");
  console.log(
    `${r.label.padEnd(22)} fills=${String(r.fills).padStart(3)} sells=${String(r.sells).padStart(3)} kills=${String(r.sellKills).padStart(3)} wr=${String(r.winRate).padStart(5)} pnl=${String(r.pnl).padStart(8)} d=${String(Math.round((r.pnl - basePnl) * 100) / 100).padStart(7)} dd=${String(r.maxDrawdown).padStart(6)} | ${dayStr}`,
  );
}
console.log(`\nsaved: ${outPath}`);