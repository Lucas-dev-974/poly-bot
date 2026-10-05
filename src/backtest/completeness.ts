import { parseWindowStart, windowSecondsFromSlug, WINDOW_SECONDS } from "../utils/market.js";

export const EXPECTED_TICKS = 900;
const WINDOW_MS = WINDOW_SECONDS * 1000;
export const MIN_TICKS = 855;
const MAX_GAP_MS = 2000;
const MAX_EDGE_GAP_MS = 2000;

/**
 * Ticks attendus pour une durée de fenêtre au tick bot 1 Hz (900 pour 15m,
 * 300 pour 5m). 1 tick par seconde → ticks = durée en secondes. Les
 * constantes ci-dessus restent les valeurs 15m de repli pour les slugs
 * sans durée lisible.
 */
export function expectedTicksForDuration(durationSec: number): number {
  return Math.max(1, Math.round(durationSec));
}

/** Seuil par défaut ≈ 95 % de l'attendu (miroir de MIN_TICKS = 855/900). */
export function minTicksForDuration(durationSec: number): number {
  return Math.round(expectedTicksForDuration(durationSec) * 0.95);
}

interface CompletenessStats {
  tickCount: number;
  maxGapMs: number;
  gapCount: number;
  coveragePct: number;
  complete: boolean;
  firstTs: number | null;
  lastTs: number | null;
}

/** Resolved rules: `null` means the check is disabled. */
export interface CompletenessCriteria {
  minTicks: number | null;
  maxGapMs: number | null;
  maxEdgeGapMs: number | null;
}

/** Raw payload from UI / query / persisted run request. */
export interface CompletenessRequest {
  requireMinTicks?: boolean;
  minTicks?: number;
  requireMaxGap?: boolean;
  maxGapMs?: number;
  requireEdge?: boolean;
  maxEdgeGapMs?: number;
}

export const DEFAULT_COMPLETENESS: CompletenessCriteria = {
  minTicks: MIN_TICKS,
  maxGapMs: MAX_GAP_MS,
  maxEdgeGapMs: MAX_EDGE_GAP_MS,
};

/**
 * `tickTs` = distinct bot tick timestamps (ms) where both outcomes exist,
 * already filtered to the window. Inclusive window: [startMs, endMs].
 */
export function evaluateCompleteness(
  windowStartSec: number,
  windowEndSec: number,
  tickTs: number[],
  criteria: CompletenessCriteria = DEFAULT_COMPLETENESS,
): CompletenessStats {
  const startMs = windowStartSec * 1000;
  const endMs = windowEndSec * 1000;
  const sorted = [...tickTs].filter((ts) => ts >= startMs && ts <= endMs).sort((a, b) => a - b);
  const tickCount = sorted.length;
  const firstTs = sorted[0] ?? null;
  const lastTs = sorted[sorted.length - 1] ?? null;

  let maxGapMs = 0;
  let gapCount = 0;
  const gapLimit = criteria.maxGapMs ?? MAX_GAP_MS;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > maxGapMs) maxGapMs = gap;
    if (gap > gapLimit) gapCount++;
  }

  const coveragePct = EXPECTED_TICKS > 0 ? tickCount / EXPECTED_TICKS : 0;
  const complete = isCompleteFromStats(
    { tickCount, maxGapMs, firstTs, lastTs },
    windowStartSec,
    windowEndSec,
    criteria,
  );

  return {
    tickCount,
    maxGapMs,
    gapCount,
    coveragePct,
    complete,
    firstTs,
    lastTs,
  };
}

export function isCompleteFromStats(
  stats: {
    tickCount: number;
    maxGapMs: number;
    firstTs: number | null | undefined;
    lastTs: number | null | undefined;
  },
  windowStartSec: number,
  windowEndSec: number,
  criteria: CompletenessCriteria = DEFAULT_COMPLETENESS,
): boolean {
  if (criteria.minTicks != null && stats.tickCount < criteria.minTicks) return false;
  if (criteria.maxGapMs != null && stats.maxGapMs > criteria.maxGapMs) return false;
  if (criteria.maxEdgeGapMs != null) {
    const startMs = windowStartSec * 1000;
    const endMs = windowEndSec * 1000;
    const firstTs = stats.firstTs ?? null;
    const lastTs = stats.lastTs ?? null;
    if (firstTs === null || lastTs === null) return false;
    if (firstTs - startMs > criteria.maxEdgeGapMs) return false;
    if (endMs - lastTs > criteria.maxEdgeGapMs) return false;
  }
  return true;
}

export function parseCompletenessCriteria(input: unknown): CompletenessCriteria {
  const src =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    minTicks: parseRule(src.requireMinTicks, src.minTicks, MIN_TICKS, 1, EXPECTED_TICKS),
    maxGapMs: parseRule(src.requireMaxGap, src.maxGapMs, MAX_GAP_MS, 1, WINDOW_MS),
    maxEdgeGapMs: parseRule(src.requireEdge, src.maxEdgeGapMs, MAX_EDGE_GAP_MS, 1, WINDOW_MS),
  };
}

export function completenessFromSearchParams(params: URLSearchParams): CompletenessCriteria {
  return parseCompletenessCriteria({
    requireMinTicks: params.get("requireMinTicks") ?? undefined,
    minTicks: params.get("minTicks") ?? undefined,
    requireMaxGap: params.get("requireMaxGap") ?? undefined,
    maxGapMs: params.get("maxGapMs") ?? undefined,
    requireEdge: params.get("requireEdge") ?? undefined,
    maxEdgeGapMs: params.get("maxEdgeGapMs") ?? undefined,
  });
}

export function normalizeCompletenessRequest(input: unknown): CompletenessRequest {
  const src =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const criteria = parseCompletenessCriteria(src);
  return {
    requireMinTicks: criteria.minTicks != null,
    minTicks: criteria.minTicks ?? intOr(src.minTicks, MIN_TICKS, 1, EXPECTED_TICKS),
    requireMaxGap: criteria.maxGapMs != null,
    maxGapMs: criteria.maxGapMs ?? intOr(src.maxGapMs, MAX_GAP_MS, 1, WINDOW_MS),
    requireEdge: criteria.maxEdgeGapMs != null,
    maxEdgeGapMs: criteria.maxEdgeGapMs ?? intOr(src.maxEdgeGapMs, MAX_EDGE_GAP_MS, 1, WINDOW_MS),
  };
}

export function windowBoundsFromSlug(
  slug: string,
): { windowStart: number; windowEnd: number } | null {
  const windowStart = parseWindowStart(slug);
  if (windowStart === null) return null;
  // Durée dérivée du slug (multi-timeframe) ; repli 15m si format legacy.
  const durationSec = windowSecondsFromSlug(slug) ?? WINDOW_SECONDS;
  return { windowStart, windowEnd: windowStart + durationSec };
}

function parseRule(
  requireRaw: unknown,
  valueRaw: unknown,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (!parseBool(requireRaw, true)) return null;
  return intOr(valueRaw, fallback, min, max);
}

function intOr(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function parseBool(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (raw === false || raw === 0 || raw === "0" || raw === "false") return false;
  if (raw === true || raw === 1 || raw === "1" || raw === "true") return true;
  return fallback;
}
