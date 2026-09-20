/**
 * Lower-lows detection for fav-band exit analysis.
 * Port of the Python analysis logic to TypeScript for backend integration.
 */

import type { BacktestSeriesPoint } from "./types.js";

export interface LowerLowEvent {
  sequenceId: number;
  lowNumber: number;
  lowPrice: number;
  lowTs: number;
  bouncePrice: number;
  dropCents: number;
  bounceCents: number;
  requiredBounceCents: number;
}

export interface LowerLowAnalysisResult {
  slug: string;
  up: {
    events: LowerLowEvent[];
    maxSequence: number;
    finalPrice: number | null;
  };
  down: {
    events: LowerLowEvent[];
    maxSequence: number;
    finalPrice: number | null;
  };
}

/** Polymarket L1 tick in cents — floor for a confirming bounce. */
const PRICE_TICK_CENTS = 1;

/** Default parameters (aligned with fav-band-strategy.ts) */
export interface LowerLowParams {
  minSwingCents: number;      // favBandExitMinLowerHighDrop * 100
  retraceRatio: number;       // favBandExitRetraceRatio
  consecutiveRequired: number; // favBandExitConsecutive
  lookbackMs: number;         // favBandExitLookbackMs
}

export const DEFAULT_LOWER_LOW_PARAMS: LowerLowParams = {
  minSwingCents: 5,        // 0.05 = 5¢
  retraceRatio: 0.25,      // 25%
  consecutiveRequired: 3,  // 3 lower-lows
  lookbackMs: 120_000,     // 120 seconds
};

function priceToCents(price: number): number {
  return Math.round(price * 100);
}

/**
 * Calculate required bounce to confirm a low.
 * After a real swing (>= minSwing), bounce is clamp(ratio × drop, 1 tick, minSwing)
 * A later extension of >= minSwing below the last low confirms on 1 tick.
 */
function requiredBounceCents(
  dropC: number,
  minSwingC: number,
  ratio: number,
  lowestLowC: number | null,
  curLowC: number,
): number {
  if (lowestLowC != null && lowestLowC - curLowC >= minSwingC) {
    return PRICE_TICK_CENTS;
  }
  const cap = Math.max(PRICE_TICK_CENTS, minSwingC);
  const proportional = Math.round(ratio * dropC);
  return Math.min(cap, Math.max(PRICE_TICK_CENTS, proportional));
}

/**
 * Analyze a series of price points for lower-lows.
 * points: array of { t: number (unix seconds), upMid, downMid }
 * outcomeIndex: 0 for Up (Yes), 1 for Down (No)
 */
function analyzeSeries(
  points: BacktestSeriesPoint[],
  outcomeIndex: 0 | 1,
  params: LowerLowParams,
): LowerLowEvent[] {
  if (points.length < 10) return [];

  const getMid = (p: BacktestSeriesPoint): number => 
    outcomeIndex === 0 ? (p.upMid ?? 0) : (p.downMid ?? 0);

  const firstMid = getMid(points[0]);
  if (firstMid === 0) return [];

  // State machine (same logic as fav-band-strategy.ts)
  let phase: "down" | "up" = "down";
  let lastHighC = priceToCents(firstMid);    // structure high (BOS level)
  let legHighC = lastHighC;                   // origin of current down-leg
  let lowestLowC: number | null = null;       // lowest confirmed low
  let lastSwingLowC: number | null = null;    // most recent confirmed low
  let curExtremeC = lastHighC;                // running min (down) or max (up)
  let lowerLows = 0;
  let lastEventTs: number | null = null;
  let sequenceId = 0;

  const events: LowerLowEvent[] = [];
  const minSwingC = params.minSwingCents;

  for (const pt of points) {
    const mid = getMid(pt);
    if (mid === 0) continue;
    
    const askC = priceToCents(mid);
    const tsMs = pt.t * 1000;

    // Decay: incomplete sequence with no fresh event inside lookback resets count
    if (
      lowerLows > 0 &&
      lowerLows < params.consecutiveRequired &&
      lastEventTs != null &&
      tsMs - lastEventTs > params.lookbackMs
    ) {
      lowerLows = 0;
      lastEventTs = null;
    }

    if (phase === "down") {
      if (askC >= lastHighC) {
        // Reclaimed structure high — full reset
        lastHighC = askC;
        legHighC = askC;
        curExtremeC = askC;
        if (lowestLowC != null) {
          lowestLowC = null;
          lastSwingLowC = null;
          lowerLows = 0;
          lastEventTs = null;
        }
        continue;
      }

      curExtremeC = Math.min(curExtremeC, askC);
      const dropC = legHighC - curExtremeC;
      const bounceC = askC - curExtremeC;

      if (dropC < minSwingC) continue;

      const needed = requiredBounceCents(
        dropC,
        minSwingC,
        params.retraceRatio,
        lowestLowC,
        curExtremeC,
      );

      if (bounceC >= needed) {
        // Confirm a low
        const lowNumber = (lowestLowC == null || curExtremeC < lowestLowC) 
          ? lowerLows + 1 
          : lowerLows;

        events.push({
          sequenceId,
          lowNumber,
          lowPrice: curExtremeC / 100,
          lowTs: tsMs,
          bouncePrice: (curExtremeC + bounceC) / 100,
          dropCents: dropC,
          bounceCents: bounceC,
          requiredBounceCents: needed,
        });

        if (lowestLowC == null || curExtremeC < lowestLowC) {
          lowerLows += 1;
          lastEventTs = tsMs;
          lowestLowC = curExtremeC;
          sequenceId += 1;
        }
        lastSwingLowC = curExtremeC;

        phase = "up";
        curExtremeC = askC;
      }
    } else {
      // phase === "up": tracking bounce off last low
      if (askC >= lastHighC) {
        // Full recovery above structure high
        phase = "down";
        lastHighC = askC;
        legHighC = askC;
        curExtremeC = askC;
        lowestLowC = null;
        lastSwingLowC = null;
        lowerLows = 0;
        lastEventTs = null;
        continue;
      }

      curExtremeC = Math.max(curExtremeC, askC);

      // Failed bounce / continuation: broke below last confirmed low
      if (lastSwingLowC != null && askC < lastSwingLowC) {
        phase = "down";
        legHighC = curExtremeC;
        curExtremeC = askC;
      }
    }
  }

  return events;
}

/**
 * Analyze lower-lows for all visible markets.
 * Returns results per market slug.
 */
export function analyzeLowerLows(
  series: Record<string, BacktestSeriesPoint[]>,
  params: LowerLowParams = DEFAULT_LOWER_LOW_PARAMS,
): LowerLowAnalysisResult[] {
  const results: LowerLowAnalysisResult[] = [];

  for (const [slug, points] of Object.entries(series)) {
    const upEvents = analyzeSeries(points, 0, params);
    const downEvents = analyzeSeries(points, 1, params);

    const upMaxSeq = upEvents.length > 0 
      ? Math.max(...upEvents.map(e => e.lowNumber)) 
      : 0;
    const downMaxSeq = downEvents.length > 0 
      ? Math.max(...downEvents.map(e => e.lowNumber)) 
      : 0;

    const finalUp = points.length > 0 ? (points[points.length - 1].upMid ?? null) : null;
    const finalDown = points.length > 0 ? (points[points.length - 1].downMid ?? null) : null;

    results.push({
      slug,
      up: {
        events: upEvents,
        maxSequence: upMaxSeq,
        finalPrice: finalUp,
      },
      down: {
        events: downEvents,
        maxSequence: downMaxSeq,
        finalPrice: finalDown,
      },
    });
  }

  return results;
}