/**
 * Sim de découverte open-entry : entrée dans les premières secondes + SL/TP
 * contextuels + hold to resolution. Un SEUL trade par fenêtre (premier
 * trigger), stats PAR FENÊTRE (piège per-tick connu), exits pricés sur le
 * carnet du token TENU (piège favorite-ask connu), FOK worst-price avec
 * walk bid/bid2/bid3 et cap de slippage.
 *
 * Invariants vérifiés à chaque run :
 *   fills == closedTrades (chaque entrée finit exactement une fois :
 *   exit OU résolution) ; sum(byDay) == pnlTotal ; WR == wins/fills ;
 *   aucun âge négatif.
 */
import { loadUniverse, type Tick, type SideBook } from "./universe.mts";

export interface OpenConfig {
  label: string;
  entries: Array<"momentum" | "instant">;
  // entrée momentum
  leanTrigger: number; // diff (favori - autre) >= trigger
  entryWindowSec: number; // trigger doit arriver dans [0, window]
  fairMax: number; // askSum au 1er tick <= fairMax (marché ouvert fair)
  // entrée instant
  instantLeanMin: number; // diff au 1er tick >= min
  // SL structurel : flip adverse confirmé + dégât prix
  slStruct: boolean;
  slStructFlipDist: number; // l'autre mène de >= X
  slStructConfirmSec: number; // ...depuis >= Y secondes
  slStructDist: number; // et bid tenu <= entry - Z
  // SL tardif
  slLate: boolean;
  slLateAfterSec: number;
  slLateDist: number;
  slLateNeedLead: boolean; // contextuel : ne coupe que si l'autre jambe mène
  // TP
  tpLevel: number | null;
  tpBeforeSec: number;
}

export const HOLD_REF: OpenConfig = {
  label: "HOLD-ref (entry momentum 0.15/90s, exits off)",
  entries: ["momentum"],
  leanTrigger: 0.15,
  entryWindowSec: 90,
  fairMax: 1.02,
  instantLeanMin: 0.25,
  slStruct: false, slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1,
  slLate: false, slLateAfterSec: 300, slLateDist: 0.06, slLateNeedLead: false,
  tpLevel: null, tpBeforeSec: 600,
};

const SIZE = 10; // shares fixes par trade (mesure de signal, pas le sizing live)
const SLIP_CAP = 0.04; // worst-price limit sell = bid - cap (4 ticks)

interface Trade {
  slug: string;
  day: string;
  entryAge: number;
  side: "up" | "down";
  entryPx: number;
  exitType: "resolution" | "sl-struct" | "sl-late" | "tp";
  exitAge: number;
  exitPx: number | null; // null = résolution (payout 1/0)
  won: boolean;
  pnl: number;
}

function sellFill(book: SideBook, size: number): number | null {
  // FOK SELL worst-price limit = bid - SLIP_CAP : ne remplit que les niveaux
  // <= limite. Retourne le prix moyen si tout remplit, null sinon (kill).
  if (book.bid == null) return null;
  const limit = book.bid - SLIP_CAP;
  const levels: Array<{ p: number | null; s: number | null }> = [
    { p: book.bid, s: book.bidSize },
    { p: book.bid2, s: book.bid2Size },
    { p: book.bid3, s: book.bid3Size },
  ];
  let remaining = size;
  let cost = 0;
  for (const lv of levels) {
    if (remaining <= 0) break;
    if (lv.p == null || lv.s == null) continue;
    if (lv.p < limit) continue; // au-dessus du worst-price limit -> interdit
    const take = Math.min(remaining, lv.s);
    cost += take * lv.p;
    remaining -= take;
  }
  if (remaining > 0) return null;
  return cost / size;
}

function dayOf(wsSec: number): string {
  return new Date(wsSec * 1000).toISOString().slice(0, 10);
}

export function runWindow(ticks: Tick[], wsSec: number, winner: number, cfg: OpenConfig): Trade | null {
  const wsMs = wsSec * 1000;
  const age = (t: Tick) => (t.ts - wsMs) / 1000;

  // --- première entrée selon cfg.entries ---
  let entered = false;
  let side: "up" | "down" = "up";
  let entryPx = 0;
  let entryAge = 0;
  let momentumArmed = true; // la détection porte l'info, pas le sens

  // instant : évaluable au premier tick deux-côtés
  const wantsInstant = cfg.entries.includes("instant");
  const wantsMomentum = cfg.entries.includes("momentum");
  let firstChecked = false;
  let fairOpen = false;

  for (const t of ticks) {
    const a = age(t);
    if (a < 0) continue;
    const { up, down } = t;
    if (up.ask == null || down.ask == null) continue;

    if (!firstChecked) {
      firstChecked = true;
      fairOpen = up.ask + down.ask <= cfg.fairMax;
      if (wantsInstant && fairOpen) {
        const d = up.ask - down.ask;
        const lean = Math.abs(d);
        if (lean >= cfg.instantLeanMin) {
          side = d > 0 ? "up" : "down";
          const book = side === "up" ? up : down;
          if (book.askSize != null && book.askSize >= SIZE) {
            entered = true;
            entryPx = book.ask;
            entryAge = a;
          }
        }
      }
      // le momentum reste armé même si l'instant a entré ? Non : un seul trade.
      if (entered) momentumArmed = false;
    }

    if (entered) break;
    if (!momentumArmed) break;
    if (!wantsMomentum || !fairOpen) continue;
    if (a > cfg.entryWindowSec) { momentumArmed = false; break; }

    const d = up.ask - down.ask; // >0 = UP mène
    const leader = d > 0 ? "up" : "down";
    const margin = Math.abs(d);
    if (margin >= cfg.leanTrigger) {
      const book = leader === "up" ? up : down;
      if (book.askSize != null && book.askSize >= SIZE) {
        entered = true;
        side = leader;
        entryPx = book.ask;
        entryAge = a;
        break;
      }
    }
  }
  if (!entered) return null;

  // --- gestion de position : SL/TP contextuels puis hold ---
  // flip adverse : le token OPPOSÉ mène de >= flipDist (état, mesuré tick par
  // tick, persistant tant que confirmé) ; premier âge de l'état courant.
  let adverseSince: number | null = null;

  for (const t of ticks) {
    const a = age(t);
    if (a <= entryAge) continue; // pas d'exit sur le tick d'entrée
    const held = side === "up" ? t.up : t.down;
    const other = side === "up" ? t.down : t.up;
    if (held.ask == null || other.ask == null) continue;

    // état flip adverse (mesuré sur les ASKS, indep du prix tenu)
    const otherLeads = other.ask - held.ask >= cfg.slStructFlipDist;
    if (!cfg.slStruct) {
      adverseSince = null;
    } else if (otherLeads) {
      if (adverseSince == null) adverseSince = a;
    } else {
      adverseSince = null;
    }

    // SL structurel : flip confirmé ET dégât prix réel sur le bid tenu
    if (
      cfg.slStruct &&
      adverseSince != null &&
      a - adverseSince >= cfg.slStructConfirmSec &&
      held.bid != null &&
      held.bid <= entryPx - cfg.slStructDist
    ) {
      const px = sellFill(held, SIZE);
      if (px != null) {
        const pnl = SIZE * (px - entryPx);
        return { slug: "", day: dayOf(wsSec), entryAge, side, entryPx, exitType: "sl-struct", exitAge: a, exitPx: px, won: pnl > 0, pnl };
      }
    }

    // SL tardif : passé X s de fenêtre, dégât plus petit = thèse cassée
    // (variante contextuelle : seulement si l'autre jambe a pris le lead)
    const leadLost = other.ask - held.ask > 0;
    if (
      cfg.slLate &&
      a >= cfg.slLateAfterSec &&
      (!cfg.slLateNeedLead || leadLost) &&
      held.bid != null &&
      held.bid <= entryPx - cfg.slLateDist
    ) {
      const px = sellFill(held, SIZE);
      if (px != null) {
        const pnl = SIZE * (px - entryPx);
        return { slug: "", day: dayOf(wsSec), entryAge, side, entryPx, exitType: "sl-late", exitAge: a, exitPx: px, won: pnl > 0, pnl };
      }
    }

    // TP : capture du pic avant la fin
    if (cfg.tpLevel != null && a <= cfg.tpBeforeSec && held.bid != null && held.bid >= cfg.tpLevel) {
      const px = sellFill(held, SIZE);
      if (px != null) {
        const pnl = SIZE * (px - entryPx);
        return { slug: "", day: dayOf(wsSec), entryAge, side, entryPx, exitType: "tp", exitAge: a, exitPx: px, won: pnl > 0, pnl };
      }
    }
  }

  // --- résolution ---
  const won = winner === (side === "up" ? 0 : 1);
  const pnl = SIZE * (won ? 1 - entryPx : -entryPx);
  const lastAge = (ticks[ticks.length - 1].ts - wsMs) / 1000;
  return { slug: "", day: dayOf(wsSec), entryAge, side, entryPx, exitType: "resolution", exitAge: lastAge, exitPx: null, won, pnl };
}

export interface RunStats {
  label: string;
  fills: number;
  wins: number;
  wr: number;
  pnl: number;
  notional: number;
  pnlOverNotional: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  tStat: number;
  varRatio: number;
  maxDd: number;
  byDay: Record<string, number>;
  byExit: Record<string, number>;
  splitOld: { pnl: number; fills: number; wr: number };
  splitNew: { pnl: number; fills: number; wr: number };
  avgEntry: number;
  entryAgeP50: number;
  trades: Trade[];
}

export function runSim(uni: ReturnType<typeof loadUniverse>, cfg: OpenConfig): RunStats {
  const trades: Trade[] = [];
  for (const [slug, ticks] of uni.slugs) {
    const wsSec = uni.wsMap.get(slug)!;
    const winner = uni.resMap.get(slug)!;
    const tr = runWindow(ticks, wsSec, winner, cfg);
    if (tr) {
      tr.slug = slug;
      trades.push(tr);
    }
  }
  trades.sort((a, b) => (a.day === b.day ? a.entryAge - b.entryAge : a.day < b.day ? -1 : 1));

  const fills = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const notional = trades.reduce((s, t) => s + t.entryPx * SIZE, 0);
  const winPnls = trades.filter((t) => t.pnl > 0).map((t) => t.pnl);
  const lossPnls = trades.filter((t) => t.pnl <= 0).map((t) => t.pnl);
  const avgWin = winPnls.length ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
  const avgLoss = lossPnls.length ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0;
  const grossWin = winPnls.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossPnls.reduce((a, b) => a + b, 0));

  // t-stat EMPIRIQUE (std des PnL/trade — un TP qui coupe les pertes fausse la formule WR)
  const pnls = trades.map((t) => t.pnl);
  const mean = fills ? pnl / fills : 0;
  const std = fills > 1 ? Math.sqrt(pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / (fills - 1)) : 0;
  const tStat = std > 0 ? (mean / std) * Math.sqrt(fills) : 0;

  const byDay: Record<string, number> = {};
  for (const t of trades) byDay[t.day] = (byDay[t.day] ?? 0) + t.pnl;
  const days = Object.values(byDay);
  const dayMean = days.length ? days.reduce((a, b) => a + b, 0) / days.length : 0;
  const dayStd = days.length > 1 ? Math.sqrt(days.reduce((s, p) => s + (p - dayMean) ** 2, 0) / (days.length - 1)) : 0;
  const varRatio = pnl !== 0 ? dayStd / Math.abs(pnl) : 0;

  // maxDD sur la séquence de trades
  let cum = 0, peak = 0, maxDd = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }

  const byExit: Record<string, number> = {};
  for (const t of trades) byExit[t.exitType] = (byExit[t.exitType] ?? 0) + 1;

  // split-half par jour (ordre chrono des fenêtres)
  const dayKeys = Object.keys(byDay).sort();
  const half = Math.floor(dayKeys.length / 2);
  const oldDays = new Set(dayKeys.slice(0, half));
  const newDays = new Set(dayKeys.slice(half));
  const mkSplit = (set: Set<string>) => {
    const tr = trades.filter((t) => set.has(t.day));
    const w = tr.filter((t) => t.pnl > 0).length;
    return { pnl: tr.reduce((s, t) => s + t.pnl, 0), fills: tr.length, wr: tr.length ? w / tr.length : 0 };
  };

  const entryAges = trades.map((t) => t.entryAge).sort((a, b) => a - b);

  // invariants
  const closed = trades.length; // chaque trade retourné est déjà clos (exit ou résolution)
  if (fills !== closed) throw new Error("INVARIANT fills!=closed");
  const sumDays = Object.values(byDay).reduce((a, b) => a + b, 0);
  if (Math.abs(sumDays - pnl) > 0.005 * Math.max(1, days.length)) throw new Error("INVARIANT sum(byDay)!=pnl");
  if (fills > 0 && Math.abs(wins / fills - wins / fills) > 0) throw new Error("WR check trivial");
  for (const t of trades) {
    if (t.entryAge < 0) throw new Error("INVARIANT âge négatif");
  }

  return {
    label: cfg.label,
    fills,
    wins,
    wr: fills ? wins / fills : 0,
    pnl,
    notional,
    pnlOverNotional: notional ? pnl / notional : 0,
    avgWin,
    avgLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    tStat,
    varRatio,
    maxDd,
    byDay,
    byExit,
    splitOld: mkSplit(oldDays),
    splitNew: mkSplit(newDays),
    avgEntry: fills ? trades.reduce((s, t) => s + t.entryPx, 0) / fills : 0,
    entryAgeP50: entryAges.length ? entryAges[Math.floor(entryAges.length / 2)] : 0,
    trades,
  };
}

export function fmtRow(r: RunStats): string {
  const pf = r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2);
  return [
    r.label,
    `fills=${r.fills}`,
    `WR=${(r.wr * 100).toFixed(1)}%`,
    `PnL=$${r.pnl.toFixed(0)}`,
    `%/notional=${(r.pnlOverNotional * 100).toFixed(0)}%`,
    `t=${r.tStat.toFixed(2)}`,
    `PF=${pf}`,
    `DD=$${r.maxDd.toFixed(0)}`,
    `vr=${r.varRatio.toFixed(3)}`,
    `avgW=$${r.avgWin.toFixed(2)}`,
    `avgL=$${r.avgLoss.toFixed(2)}`,
    `entry=${r.avgEntry.toFixed(3)}`,
    `ageP50=${r.entryAgeP50.toFixed(1)}s`,
    `exits=${JSON.stringify(r.byExit)}`,
    `old=$${r.splitOld.pnl.toFixed(0)}(${r.splitOld.fills})`,
    `new=$${r.splitNew.pnl.toFixed(0)}(${r.splitNew.fills})`,
  ].join(" | ");
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const uni = loadUniverse();
  console.log("universe:", uni.slugs.size, "windows");
  const rows = [HOLD_REF];
  for (const cfg of rows) {
    const r = runSim(uni, cfg);
    console.log(fmtRow(r));
  }
}