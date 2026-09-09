import { STRATEGY_ENGINE_OPTIONS, STRATEGY_PRESETS } from "../config/strategyPresets";
import type { BacktestRunSummary, BotConfig, StrategyId } from "../types";

export function runEngineId(run: BacktestRunSummary | null): string | undefined {
  if (!run) return undefined;
  const direct = run.result?.strategyId ?? run.request?.strategyId ?? run.request?.settings?.strategyId;
  if (direct) return direct;
  const preset = STRATEGY_PRESETS.find((p) => p.id === run.request?.presetId);
  return preset?.strategyId;
}

export function settingsForRun(run: BacktestRunSummary | null): Partial<BotConfig> | null {
  if (!run?.request) return null;
  const stored = run.request.settings;
  if (stored && Object.keys(stored).length > 0) return stored;
  const preset = STRATEGY_PRESETS.find((p) => p.id === run.request?.presetId);
  if (!preset) return null;
  return { ...preset.settings, strategyId: preset.strategyId };
}

export function runCompletenessLabel(run: BacktestRunSummary | null): string | null {
  const req = run?.request;
  if (!req) return null;
  if (!req.completeOnly) return "tous";
  const c = req.completeness;
  if (!c) return "complets";
  const parts: string[] = [];
  if (c.requireMinTicks !== false) parts.push(`≥${c.minTicks ?? 855} ticks`);
  if (c.requireMaxGap !== false) {
    const sec = (c.maxGapMs ?? 2000) / 1000;
    parts.push(`trou≤${formatSec(sec)}`);
  }
  if (c.requireEdge !== false) {
    const sec = (c.maxEdgeGapMs ?? 2000) / 1000;
    parts.push(`bords≤${formatSec(sec)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "tous (règles off)";
}

function formatSec(sec: number): string {
  return `${sec}s`;
}

export function runPresetLabel(run: BacktestRunSummary | null, strategyId?: string): string {
  const sid = strategyId ?? runEngineId(run) ?? "—";
  const engine = STRATEGY_ENGINE_OPTIONS.find((o) => o.id === sid)?.label ?? sid;
  if (run?.request?.useCurrentConfig) return `${engine} · config live`;
  const preset = STRATEGY_PRESETS.find((p) => p.id === run?.request?.presetId);
  if (preset) return `${engine} · ${preset.name}`;
  if (run?.request?.settings) return `${engine} · personnalisé`;
  return engine;
}

export interface SettingRow {
  key: string;
  label: string;
  value: string;
}

export interface SettingGroup {
  id: string;
  label: string;
  rows: SettingRow[];
}

const SETTING_GROUPS: Array<{
  id: string;
  label: string;
  engines?: StrategyId[];
  keys: Array<[keyof BotConfig, string]>;
}> = [
  {
    id: "cheap",
    label: "Cheap",
    engines: ["arb", "barbell"],
    keys: [
      ["cheapBuyMin", "Cheap min"],
      ["cheapBuyMax", "Cheap max"],
      ["cheapOrderUsdc", "Cheap USDC"],
      ["pairLockMax", "Pair lock"],
    ],
  },
  {
    id: "hedge",
    label: "Hedge",
    engines: ["arb", "barbell"],
    keys: [
      ["expensiveBuyMin", "Hedge min"],
      ["expensiveBuyMax", "Hedge max"],
      ["expensiveOrderUsdc", "Hedge USDC"],
      ["expensiveOrderType", "Type hedge"],
      ["barbellHedgeRatio", "Ratio hedge"],
      ["enableExpensiveHedge", "Hedge on"],
    ],
  },
  {
    id: "edge",
    label: "Edge",
    engines: ["edge-lead"],
    keys: [
      ["edgeBandMin", "Edge min"],
      ["edgeBandMax", "Edge max"],
      ["edgeConfirmSamples", "Confirm ticks"],
      ["edgeMaxDownTick", "Drop / tick"],
      ["edgeCheapBandMin", "Cheap min"],
      ["edgeCheapBandMax", "Cheap max"],
      ["edgeOrderUsdc", "Edge USDC"],
      ["edgeCheapOrderUsdc", "Cheap USDC"],
      ["edgeCheapMargin", "Cheap margin"],
    ],
  },
  {
    id: "risk",
    label: "Risque",
    keys: [
      ["maxSharesPerOrder", "Max shares"],
      ["maxShareEdge", "Max shares edge"],
      ["maxOpenPositionsPerSide", "Max pos / côté"],
      ["maxExposureUsdc", "Max expo USDC"],
      ["simulatedCapital", "Capital sim"],
      ["marketSlugPrefixes", "Préfixes"],
      ["pollIntervalMs", "Poll (ms)"],
    ],
  },
  {
    id: "window",
    label: "Fenêtre",
    keys: [
      ["minutesBeforeCloseMin", "Min avant close"],
      ["minutesBeforeCloseMax", "Max avant close"],
      ["minMinutesBeforeCloseToBuy", "Stop buy < min"],
    ],
  },
];

export function groupedSettings(
  settings: Partial<BotConfig>,
  strategyId: string | undefined,
): SettingGroup[] {
  const sid = (strategyId ?? settings.strategyId) as StrategyId | undefined;
  const groups: SettingGroup[] = [];
  for (const group of SETTING_GROUPS) {
    if (group.engines && sid && !group.engines.includes(sid)) continue;
    const rows: SettingRow[] = [];
    for (const [key, label] of group.keys) {
      if (!(key in settings)) continue;
      const raw = settings[key];
      if (raw === undefined) continue;
      rows.push({ key, label, value: formatSettingValue(raw) });
    }
    if (rows.length > 0) groups.push({ id: group.id, label: group.label, rows });
  }
  return groups;
}

function formatSettingValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "oui" : "non";
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.map(String).join(", ");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(4).replace(/\.?0+$/, "");
  }
  return String(value);
}

