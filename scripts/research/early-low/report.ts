// Rapport MD du backtest early-low officiel.
export interface EarlyLowSummary {
  label: string;
  strategyId: string;
  criteria: { minTicks: number; maxGapMs: number; maxEdgeGapMs: number | null };
  windows: number;
  skippedIncomplete: number;
  ms: number;
  pnl: number;
  capitalStart: number;
  capitalEnd: number;
  fills: number;
  rejects: number;
  unresolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  tradedWindows: number;
  windowResults: Array<{
    eventSlug: string;
    pnl: number | null;
    tradeCount: number;
    unresolved: boolean;
  }>;
}

export function makeMdReport(s: EarlyLowSummary): string {
  const lines: string[] = [];
  lines.push("# Backtest officiel early-low");
  lines.push("");
  lines.push(
    `Exécution : npx tsx scripts/research/early-low/backtest-official.mts ${s.criteria.minTicks} ${s.criteria.maxGapMs}`,
  );
  lines.push("");
  lines.push("| Métrique | Valeur |");
  lines.push("|---|---|");
  lines.push(`| Fenêtres testées | ${s.windows} (15m, >= ${s.criteria.minTicks} ticks) |`);
  lines.push(`| Fenêtres ignorées (incomplètes / autres durées) | ${s.skippedIncomplete} |`);
  lines.push(`| PnL total | $${s.pnl.toFixed(2)} |`);
  lines.push(`| Capital initial | $${s.capitalStart} |`);
  lines.push(`| Capital final | $${s.capitalEnd} |`);
  lines.push(`| Fills / rejects | ${s.fills} / ${s.rejects} |`);
  lines.push(`| Fenêtres non résolues | ${s.unresolved} |`);
  lines.push(`| Wins / losses | ${s.wins} / ${s.losses} |`);
  lines.push(`| Winrate | ${s.winRate === null ? "n/a" : `${s.winRate} %`} |`);
  lines.push(`| Fenêtres tradées | ${s.tradedWindows} |`);
  lines.push(`| Durée | ${(s.ms / 1000).toFixed(1)} s |`);
  return lines.join("\n");
}