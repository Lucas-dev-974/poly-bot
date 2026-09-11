import { randomUUID } from "node:crypto";
import type { BotConfig } from "../config.js";
import { validateConfigCoherence, validateTradingConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import { sanitizePatch, type RuntimeSettingsPatch } from "../runtime-settings.js";
import { parseStrategyId, type StrategyId } from "../strategy/ids.js";
import { leadsWithEdgeFor } from "../strategy/registry.js";
import { listStrategyPresets } from "../strategy-presets.js";
import {
  normalizeCompletenessRequest,
  parseCompletenessCriteria,
  type CompletenessRequest,
} from "./completeness.js";
import { runBacktest } from "./runner.js";
import type { BacktestProgress, BacktestResult, BacktestWindowMeta } from "./types.js";
import { listBacktestWindows, windowMatchesPrefix } from "./windows.js";

export interface BacktestRunRequest {
  strategyId: StrategyId;
  presetId?: string;
  useCurrentConfig?: boolean;
  settings?: RuntimeSettingsPatch;
  completeOnly?: boolean;
  completeness?: CompletenessRequest;
  from?: number;
  to?: number;
  prefixes?: string[];
  slugs?: string[];
}

interface JobState {
  progress: BacktestProgress;
  result: BacktestResult | null;
  cancel: boolean;
}

export class BacktestJob {
  private current: JobState | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly liveConfig: BotConfig,
    private readonly repos?: Repositories,
  ) {}

  isRunning(): boolean {
    return this.current?.progress.status === "running";
  }

  currentRunId(): string | null {
    return this.current?.progress.runId ?? null;
  }

  getProgress(id: string): BacktestProgress | null {
    if (this.current?.progress.runId === id) return this.current.progress;
    const row = this.repos?.backtestRuns.get(id);
    if (!row) return null;
    return {
      runId: row.id,
      status: row.status,
      current: 0,
      total: 0,
      eventSlug: null,
      pct: row.status === "done" ? 100 : 0,
      error: row.error ?? undefined,
    };
  }

  getResult(id: string): BacktestResult | null {
    if (this.current?.progress.runId === id) return this.current.result;
    const row = this.repos?.backtestRuns.get(id);
    if (!row?.resultJson) return null;
    try {
      return JSON.parse(row.resultJson) as BacktestResult;
    } catch {
      return null;
    }
  }

  cancel(id: string): boolean {
    if (!this.current || this.current.progress.runId !== id) return false;
    this.current.cancel = true;
    return true;
  }

  cancelCurrent(): void {
    if (this.current) this.current.cancel = true;
  }

  async waitUntilIdle(): Promise<void> {
    if (this.running) await this.running;
  }

  start(body: BacktestRunRequest): { runId: string } | { error: string; status: number; runId?: string } {
    if (this.isRunning()) {
      return { error: "Un backtest est déjà en cours", status: 409, runId: this.currentRunId() ?? undefined };
    }

    let config: BotConfig;
    try {
      config = this.buildConfig(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message, status: 400 };
    }

    const completeOnly = body.completeOnly !== false;
    const completeness = parseCompletenessCriteria(body.completeness);
    body.completeness = normalizeCompletenessRequest(body.completeness);
    let windows = listBacktestWindows(this.repos, {
      from: body.from,
      to: body.to,
      completeOnly: false,
      completeness,
    });
    const prefixes = body.prefixes?.length ? body.prefixes : undefined;
    if (prefixes) {
      windows = windows.filter((w) => prefixes.some((p) => windowMatchesPrefix(w.eventSlug, p)));
    }
    if (body.slugs?.length) {
      const allow = new Set(body.slugs);
      windows = windows.filter((w) => allow.has(w.eventSlug));
    }
    const skippedIncomplete = completeOnly
      ? windows.filter((w) => !w.complete).length
      : 0;
    if (completeOnly) windows = windows.filter((w) => w.complete);

    const runId = randomUUID();
    const startedAt = Date.now();
    this.current = {
      cancel: false,
      result: null,
      progress: {
        runId,
        status: "running",
        current: 0,
        total: windows.length,
        eventSlug: null,
        pct: 0,
      },
    };
    this.repos?.backtestRuns.insert({
      id: runId,
      startedAt,
      finishedAt: null,
      status: "running",
      requestJson: JSON.stringify(body),
      resultJson: null,
      error: null,
    });

    this.running = this.execute(runId, config, windows, skippedIncomplete);
    return { runId };
  }

  private async execute(
    runId: string,
    config: BotConfig,
    windows: BacktestWindowMeta[],
    skippedIncomplete: number,
  ): Promise<void> {
    try {
      const result = await runBacktest({
        runId,
        config,
        windows,
        repos: this.repos,
        skippedIncomplete,
        hooks: {
          shouldCancel: () => this.current?.cancel === true,
          onProgress: (current, total, eventSlug) => {
            if (!this.current || this.current.progress.runId !== runId) return;
            this.current.progress = {
              runId,
              status: "running",
              current,
              total,
              eventSlug,
              pct: total === 0 ? 100 : Math.round((current / total) * 100),
            };
          },
        },
      });
      const cancelled = this.current?.cancel === true;
      const status = cancelled ? "cancelled" : "done";
      if (this.current && this.current.progress.runId === runId) {
        this.current.result = result;
        this.current.progress = {
          runId,
          status,
          current: result.windowsTested,
          total: result.windowsTested,
          eventSlug: null,
          pct: 100,
        };
      }
      this.repos?.backtestRuns.update({
        id: runId,
        finishedAt: Date.now(),
        status,
        resultJson: JSON.stringify(result),
        error: null,
      });
      this.repos?.backtestRuns.pruneKeepLatest(20);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.current && this.current.progress.runId === runId) {
        this.current.progress = {
          ...this.current.progress,
          status: "error",
          error: message,
        };
      }
      this.repos?.backtestRuns.update({
        id: runId,
        finishedAt: Date.now(),
        status: "error",
        resultJson: null,
        error: message,
      });
    }
  }

  private buildConfig(body: BacktestRunRequest): BotConfig {
    const copy: BotConfig = { ...this.liveConfig, readonlyLive: false };
    const settings = body.settings && Object.keys(body.settings).length > 0 ? body.settings : null;
    if (settings) {
      applyPatch(copy, sanitizePatch({ ...settings, strategyId: body.strategyId }));
    } else if (body.useCurrentConfig) {
      copy.strategyId = body.strategyId;
    } else if (body.presetId) {
      const preset = listStrategyPresets().find((p) => p.id === body.presetId);
      if (!preset) throw new Error(`Preset inconnu: ${body.presetId}`);
      if (preset.strategyId !== body.strategyId) {
        throw new Error(`Le preset ${body.presetId} n'appartient pas au moteur ${body.strategyId}`);
      }
      const patch = sanitizePatch({ ...preset.settings, strategyId: body.strategyId });
      applyPatch(copy, patch);
    } else {
      copy.strategyId = parseStrategyId(body.strategyId);
    }
    const leadsWithEdge = leadsWithEdgeFor(copy.strategyId, this.repos);
    validateConfigCoherence(copy, { leadsWithEdge });
    validateTradingConfig(copy, { leadsWithEdge });
    return copy;
  }
}

function applyPatch(config: BotConfig, patch: RuntimeSettingsPatch): void {
  const target = config as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) target[key] = value;
  }
}
