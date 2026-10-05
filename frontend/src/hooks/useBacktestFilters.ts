import { createMemo, createSignal } from "solid-js";
import { api } from "../api/client";
import {
  windows,
  setWindows as setBacktestWindows,
  loadSeriesFor,
} from "../stores/backtestStore";
import type { BacktestWindowMeta, CompletenessRequest } from "../types";

function dayKey(windowStart: number): string {
  const d = new Date(windowStart * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Tri des timeframes par durée croissante ("5m" avant "15m" avant "1h"). */
function byDurationAsc(a: string, b: string): number {
  const toSec = (tf: string): number => {
    const m = tf.match(/^(\d+)([mh])$/);
    if (!m) return Number.MAX_SAFE_INTEGER;
    return Number(m[1]) * (m[2] === "h" ? 3600 : 60);
  };
  return toSec(a) - toSec(b);
}

export function dateRange(
  key: string,
  list: BacktestWindowMeta[],
): { from: number; to: number } | undefined {
  if (key === "all" || list.length === 0) return undefined;
  const day = list.filter((w) => dayKey(w.windowStart) === key);
  if (day.length === 0) return undefined;
  return {
    from: Math.min(...day.map((w) => w.windowStart)),
    to: Math.max(...day.map((w) => w.windowStart)),
  };
}

/**
 * Filtres fenêtre backtest (date / timeframe / marché / règles de complétude)
 * + chargement des windows. Seam clair extrait de BacktestPage.
 */
export function useBacktestFilters() {
  const [completeOnly, setCompleteOnly] = createSignal(true);
  const [minTicksOn, setMinTicksOn] = createSignal(true);
  const [minTicks, setMinTicks] = createSignal("855");
  const [maxGapOn, setMaxGapOn] = createSignal(true);
  const [maxGapSec, setMaxGapSec] = createSignal("2");
  const [edgeOn, setEdgeOn] = createSignal(true);
  const [edgeSec, setEdgeSec] = createSignal("2");
  const [cutGaps, setCutGaps] = createSignal(true);
  const [dateKey, setDateKey] = createSignal("all");
  const [prefix, setPrefix] = createSignal("");
  const [timeframe, setTimeframe] = createSignal("");

  let windowsTimer: number | undefined;

  const dates = createMemo(() => {
    const keys = new Set<string>();
    for (const w of windows()) {
      keys.add(dayKey(w.windowStart));
    }
    return [...keys].sort().reverse();
  });

  const prefixes = createMemo(() => {
    const seen = new Set<string>();
    for (const w of windows()) {
      seen.add(w.eventSlug.replace(/-\d{10}$/, ""));
    }
    return [...seen].sort();
  });

  const timeframes = createMemo(() => {
    const seen = new Set<string>();
    for (const p of prefixes()) {
      const m = p.match(/-updown-(\d+)([mh])$/);
      if (m) seen.add(`${m[1]}${m[2]}`);
    }
    return [...seen].sort(byDurationAsc);
  });

  const prefixesForTimeframe = createMemo(() => {
    const tf = timeframe();
    if (!tf) return prefixes();
    return prefixes().filter((p) => p.endsWith(`-updown-${tf}`));
  });

  const filtered = createMemo(() => {
    const key = dateKey();
    const p = prefix();
    const tf = timeframe();
    return windows().filter((w) => {
      if (key !== "all" && dayKey(w.windowStart) !== key) return false;
      if (tf && !w.eventSlug.includes(`-updown-${tf}-`)) return false;
      if (p && !w.eventSlug.startsWith(p)) return false;
      return true;
    });
  });

  function completenessPayload(): CompletenessRequest {
    const ticks = Number(minTicks());
    const gapSec = Number(maxGapSec());
    const edge = Number(edgeSec());
    return {
      requireMinTicks: minTicksOn(),
      minTicks: Number.isFinite(ticks) && ticks >= 1 ? Math.round(ticks) : 855,
      requireMaxGap: maxGapOn(),
      maxGapMs: Number.isFinite(gapSec) && gapSec > 0 ? Math.round(gapSec * 1000) : 2000,
      requireEdge: edgeOn(),
      maxEdgeGapMs: Number.isFinite(edge) && edge > 0 ? Math.round(edge * 1000) : 2000,
    };
  }

  function reloadWindowsSoon(): void {
    window.clearTimeout(windowsTimer);
    windowsTimer = window.setTimeout(() => {
      void loadWindows();
    }, 400);
  }

  async function loadWindows(): Promise<void> {
    window.clearTimeout(windowsTimer);
    const res = await api.backtestWindows({
      completeOnly: completeOnly(),
      completeness: completenessPayload(),
    });
    setBacktestWindows(res.windows);
    void loadSeriesFor(res.windows.slice(0, 20).map((w) => w.eventSlug));
  }

  function disposeFilters(): void {
    window.clearTimeout(windowsTimer);
  }

  return {
    completeOnly,
    setCompleteOnly,
    minTicksOn,
    setMinTicksOn,
    minTicks,
    setMinTicks,
    maxGapOn,
    setMaxGapOn,
    maxGapSec,
    setMaxGapSec,
    edgeOn,
    setEdgeOn,
    edgeSec,
    setEdgeSec,
    cutGaps,
    setCutGaps,
    dateKey,
    setDateKey,
    prefix,
    setPrefix,
    timeframe,
    setTimeframe,
    dates,
    prefixes,
    timeframes,
    prefixesForTimeframe,
    filtered,
    completenessPayload,
    reloadWindowsSoon,
    loadWindows,
    disposeFilters,
  };
}