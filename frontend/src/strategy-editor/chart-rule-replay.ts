import {
  DEFAULT_LOOKBACK_MS,
  DEFAULT_MIN_SLOPE,
  hasPriceBand,
  orderChartRules,
  uniqueDependsOn,
  type ChartRule,
} from "./graph-types";

type SeriesPoint = { t: number; ask: number | null; bid: number | null };

export type ReplaySignal = {
  t: number;
  elapsedSec: number;
  ruleId: string;
  token: "cheap" | "favorite";
  action: "buy" | "sell";
  direction: "up" | "down";
  price: number;
  outcomeIndex: number;
};

export type ReplayQuote = {
  elapsedSec: number;
  upAsk: number | null;
  downAsk: number | null;
  cheapAsk: number | null;
  favoriteAsk: number | null;
  cheapOutcomeIndex: number | null;
};

type Sample = { ts: number; px: number };

type NormRule = ChartRule & {
  lookbackMs: number;
  minSlope: number;
  once: boolean;
};

type ConfirmState = { samples: number[]; outcome: string };

function normalize(rule: ChartRule): NormRule {
  return {
    ...rule,
    lookbackMs:
      typeof rule.lookbackMs === "number" && rule.lookbackMs > 0
        ? rule.lookbackMs
        : DEFAULT_LOOKBACK_MS,
    minSlope:
      typeof rule.minSlope === "number" && rule.minSlope > 0
        ? rule.minSlope
        : DEFAULT_MIN_SLOPE,
    once: rule.once !== false,
    afterFill:
      rule.afterFill === "cheap" || rule.afterFill === "favorite"
        ? rule.afterFill
        : rule.action === "sell"
          ? rule.token
          : "none",
  };
}

function lastPxAt(
  points: SeriesPoint[],
  t: number,
  field: "ask" | "bid",
): number | null {
  let px: number | null = null;
  for (const p of points) {
    if (p.t > t) break;
    if (p[field] != null) px = p[field];
  }
  return px;
}

function lastAskAt(points: SeriesPoint[], t: number): number | null {
  return lastPxAt(points, t, "ask");
}

export function askAt(points: SeriesPoint[], t: number): number | null {
  return lastAskAt(points, t);
}

function slopePerSecond(samples: Sample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = (last.ts - first.ts) / 1000;
  if (dt <= 0) return null;
  return (last.px - first.px) / dt;
}

function trendMatches(samples: Sample[], nowMs: number, rule: NormRule): boolean {
  const windowed = samples.filter((s) => nowMs - s.ts <= rule.lookbackMs);
  const slope = slopePerSecond(windowed);
  if (slope == null) return false;
  if (rule.direction === "up") return slope > rule.minSlope;
  return slope < -rule.minSlope;
}

function inBand(ask: number, rule: ChartRule): boolean {
  const min = rule.bandMin ?? Number.NEGATIVE_INFINITY;
  const max = rule.bandMax ?? Number.POSITIVE_INFINITY;
  return ask >= min && ask <= max;
}

function uniqueTimes(up: SeriesPoint[], down: SeriesPoint[]): number[] {
  const set = new Set<number>();
  for (const p of up) set.add(p.t);
  for (const p of down) set.add(p.t);
  return [...set].sort((a, b) => a - b);
}

export function quoteAt(
  up: SeriesPoint[],
  down: SeriesPoint[],
  windowStart: number,
  elapsedSec: number,
): ReplayQuote {
  const t = windowStart + elapsedSec;
  const upAsk = lastAskAt(up, t);
  const downAsk = lastAskAt(down, t);
  let cheapAsk: number | null = null;
  let favoriteAsk: number | null = null;
  let cheapOutcomeIndex: number | null = null;
  if (upAsk != null && downAsk != null) {
    if (downAsk < upAsk) {
      cheapAsk = downAsk;
      favoriteAsk = upAsk;
      cheapOutcomeIndex = 1;
    } else {
      cheapAsk = upAsk;
      favoriteAsk = downAsk;
      cheapOutcomeIndex = 0;
    }
  } else if (upAsk != null) {
    cheapAsk = upAsk;
    cheapOutcomeIndex = 0;
  } else if (downAsk != null) {
    cheapAsk = downAsk;
    cheapOutcomeIndex = 1;
  }
  return {
    elapsedSec,
    upAsk,
    downAsk,
    cheapAsk,
    favoriteAsk,
    cheapOutcomeIndex,
  };
}

function confirmPush(
  prev: ConfirmState | undefined,
  ask: number,
  outcome: string,
  rule: NormRule,
): { ready: boolean; next: ConfirmState | undefined } {
  let state =
    prev && prev.outcome === outcome ? prev : { samples: [] as number[], outcome };
  const min = rule.bandMin ?? 0;
  const max = rule.bandMax ?? 1;
  if (ask < min || ask > max) return { ready: false, next: undefined };
  const last = state.samples[state.samples.length - 1];
  const maxDown = rule.maxDownTick ?? 0.01;
  if (last !== undefined && last - ask > maxDown + 1e-9) {
    return { ready: false, next: undefined };
  }
  const samples = [...state.samples, ask];
  const first = samples[0];
  const lastS = samples[samples.length - 1];
  const mean = samples.reduce((sum, s) => sum + s, 0) / samples.length;
  const n = rule.confirmTicks ?? 0;
  const ready = n > 0 && samples.length >= n && lastS >= first && mean > first;
  return { ready, next: { samples, outcome } };
}

/**
 * Rejoue les chartRules sur les séries Up/Down (preview, pas un POST/fill).
 * afterFill / dependsOn : un signal buy parent compte comme fill-approx.
 * sell lossPct : approx. vs le dernier buy favori ; live/backtest restent la source de vérité.
 */
export function replayChartRules(opts: {
  rules: ChartRule[];
  up: SeriesPoint[];
  down: SeriesPoint[];
  windowStart: number;
  durationSec: number;
}): ReplaySignal[] {
  const rules = orderChartRules(opts.rules.map(normalize));
  if (rules.length === 0) return [];
  const times = uniqueTimes(opts.up, opts.down).filter((t) => {
    const elapsed = t - opts.windowStart;
    return elapsed >= 0 && elapsed <= opts.durationSec;
  });
  const samples = { cheap: [] as Sample[], favorite: [] as Sample[] };
  const fired = new Set<string>();
  const satisfied = new Set<string>();
  const confirms = new Map<string, ConfirmState>();
  const lossStart = new Map<string, number>();
  const out: ReplaySignal[] = [];
  const maxAge = rules.reduce((m, r) => Math.max(m, r.lookbackMs), DEFAULT_LOOKBACK_MS);

  const push = (leg: "cheap" | "favorite", px: number | null, nowMs: number) => {
    if (px == null) return;
    samples[leg] = [...samples[leg], { ts: nowMs, px }].filter(
      (s) => nowMs - s.ts <= maxAge * 2,
    );
  };

  const sawBuy = (token: "cheap" | "favorite") =>
    out.some((s) => s.action === "buy" && s.token === token);

  const lastFavBuy = () => {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].action === "buy" && out[i].token === "favorite") return out[i];
    }
    return null;
  };

  for (const t of times) {
    const elapsed = t - opts.windowStart;
    const nowMs = t * 1000;
    const q = quoteAt(opts.up, opts.down, opts.windowStart, elapsed);
    push("cheap", q.cheapAsk, nowMs);
    push("favorite", q.favoriteAsk, nowMs);
    for (const rule of rules) {
      if (rule.once && fired.has(rule.id)) continue;
      if (elapsed < rule.startSec || elapsed > rule.endSec) {
        confirms.delete(rule.id);
        continue;
      }
      if (rule.minElapsedSec != null && elapsed < rule.minElapsedSec) continue;
      if (uniqueDependsOn(rule).some((id) => !satisfied.has(id))) continue;
      if (rule.action === "sell") {
        const need = rule.afterFill === "cheap" || rule.afterFill === "favorite"
          ? rule.afterFill
          : rule.token;
        if (need === "favorite" && !sawBuy("favorite")) continue;
        if (need === "cheap" && !sawBuy("cheap")) continue;
      } else {
        if (rule.afterFill === "favorite" && !sawBuy("favorite")) continue;
        if (rule.afterFill === "cheap" && !sawBuy("cheap")) continue;
      }

      const favBuy = lastFavBuy();
      let price: number | null;
      let outcomeIndex: number;
      if (rule.token === "cheap" && favBuy && rule.afterFill === "favorite") {
        outcomeIndex = favBuy.outcomeIndex === 0 ? 1 : 0;
        price = outcomeIndex === 0 ? q.upAsk : q.downAsk;
      } else {
        price = rule.token === "cheap" ? q.cheapAsk : q.favoriteAsk;
        const cheapIdx = q.cheapOutcomeIndex ?? 0;
        outcomeIndex = rule.token === "cheap" ? cheapIdx : cheapIdx === 0 ? 1 : 0;
      }
      if (price == null) continue;

      let ready = false;
      if (rule.action === "sell" && rule.lossPct != null) {
        if (!favBuy) continue;
        const bid =
          (outcomeIndex === 0
            ? lastPxAt(opts.up, t, "bid")
            : lastPxAt(opts.down, t, "bid")) ?? price;
        const lossPct = ((bid - favBuy.price) / favBuy.price) * 100;
        if (lossPct > -rule.lossPct) {
          lossStart.delete(rule.id);
          continue;
        }
        const start = lossStart.get(rule.id) ?? nowMs;
        lossStart.set(rule.id, start);
        const windowMs = rule.lossWindowMs ?? 10_000;
        ready = nowMs - start >= windowMs;
      } else if ((rule.confirmTicks ?? 0) > 0) {
        const outcome = String(outcomeIndex);
        const pushed = confirmPush(confirms.get(rule.id), price, outcome, rule);
        if (pushed.next) confirms.set(rule.id, pushed.next);
        else confirms.delete(rule.id);
        ready = pushed.ready;
      } else if (hasPriceBand(rule)) {
        ready = inBand(rule.token === "cheap" ? Math.round(price * 100) / 100 : price, rule);
      } else {
        ready = trendMatches(samples[rule.token], nowMs, rule);
      }
      if (!ready) continue;

      out.push({
        t,
        elapsedSec: elapsed,
        ruleId: rule.id,
        token: rule.token,
        action: rule.action,
        direction: rule.direction,
        price,
        outcomeIndex,
      });
      satisfied.add(rule.id);
      if (rule.once) fired.add(rule.id);
    }
  }
  return out;
}

export function fmtPlayClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
