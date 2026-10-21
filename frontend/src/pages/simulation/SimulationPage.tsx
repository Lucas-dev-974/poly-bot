/**
 * Page « Simulation live » (paper trading) — composition root du redesign
 * sim2 : topbar sticky (état moteur + actions), barre de contexte (selects
 * moteur/preset, marchés, scan, countdown de fenêtre), rangée KPI, flux en
 * direct, courbe de capital, historique et rail Paramètres.
 *
 * Découpage :
 *   useSimControl      — état/opérations moteur (sending, patchs, capital, reset)
 *   useSimEquity       — historique equity (courbe de capital, sparkline)
 *   ui.tsx             — composants de présentation purs
 *   KpiStrip / EquityCard / LiveFeedCard / HistoryCard / SettingsRail
 *
 * Le hook useSimControl est instancié UNE FOIS ici ; les sous-composants le
 * reçoivent en props (pas d'écho de signaux module-scope). useAdaptiveSync
 * vit dans useSimControl — un seul cycle de réconciliation REST.
 */
import type { JSX } from "solid-js";
import { Show, createMemo, createSignal, onMount } from "solid-js";
import type { ChartTarget } from "../../types";
import { ConfirmModal } from "../../components/modals/ConfirmModal";
import { LazyMarketHistoryModal } from "../../components/modals/LazyMarketHistoryModal";
import { SimWhipsawStatus } from "../../components/panels/SimWhipsawStatus";
import { EngineSelect, PresetSelect } from "../../components/strategy/EnginePresetSelects";
import { useClock, clockNow } from "../../stores/clockStore";
import { simConfigState, simEffectiveConfig, simOpenPositions } from "../../stores/simStore";
import { countdown } from "../../utils/format";
import { KpiStrip } from "./KpiStrip";
import { EquityCard } from "./EquityCard";
import { LiveFeedCard } from "./LiveFeedCard";
import { HistoryCard } from "./HistoryCard";
import { SettingsRail } from "./SettingsRail";
import { useSimControl } from "./useSimControl";
import { useSimEquity } from "./useSimEquity";
import "../../styles/sim.css";

export function SimulationPage(): JSX.Element {
  // Horloge globale partagée (tick 1 s) — countdowns.
  useClock();
  const now = clockNow;

  // Hooks de domaine (instanciés une fois : composition root).
  const ctrl = useSimControl();
  const equity = useSimEquity();

  // Dialog graphique d'historique de marché (MarketHistoryModal) : cible issue
  // d'une position résolue/ouverte ou d'une ligne du journal des ordres.
  const [chartTarget, setChartTarget] = createSignal<ChartTarget | null>(null);

  // ── Barre de contexte (labels dérivés de la config effective) ────────────
  /** Position ouverte la plus proche de sa clôture (chip countdown). */
  const nearestOpen = createMemo(() => {
    const list = [...simOpenPositions()];
    list.sort((a, b) => a.windowEnd - b.windowEnd);
    return list[0] ?? null;
  });
  const marketsLabel = createMemo(() => simEffectiveConfig()?.marketSlugPrefixes?.join(", ") || "—");
  /** Cadence affichée : celle du sim si définie (throttle), sinon celle du bot. */
  const scanLabel = createMemo(() => {
    const c = simEffectiveConfig();
    if (!c) return "—";
    return c.simIngestIntervalMs != null && c.simIngestIntervalMs > 0
      ? String(c.simIngestIntervalMs)
      : `${c.pollIntervalMs} (bot)`;
  });

  onMount(() => {
    void ctrl.reload();
  });

  return (
    <div class="page simulation-page sim2-shell">
      {/* ── Topbar (sticky) ─────────────────────────────────────────────── */}
      <header class="sim2-topbar">
        <div class="sim2-topbar-left">
          <a class="btn sim2-back" href="/">
            ← Dashboard
          </a>
          <h1 class="sim2-title">Simulation live</h1>
          <Show when={simConfigState()} fallback={<span class="sim2-muted">chargement…</span>}>
            {(c) => (
              <span class={`sim2-badge ${c().enabled ? "on" : "off"}`}>
                <span class="sim2-badge-dot" aria-hidden="true" />
                {c().enabled ? "EN COURS" : "À L'ARRÊT"}
              </span>
            )}
          </Show>
        </div>
        <div class="sim2-topbar-actions">
          <button
            class={simConfigState()?.enabled ? "btn sim2-danger-ghost" : "btn btn-primary"}
            onClick={() => void ctrl.toggleEngine()}
            disabled={ctrl.sending()}
          >
            {simConfigState()?.enabled ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
                Arrêter
              </>
            ) : (
              "Démarrer"
            )}
          </button>
          <button
            class="btn"
            onClick={() => ctrl.setConfirmReset(true)}
            disabled={ctrl.sending() || ctrl.resolvedCount() === 0}
            title="Archiver les positions résolues en DB puis vider la liste (ouvertes intactes)"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <rect x="3" y="4" width="18" height="5" rx="1" />
              <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
            </svg>
            Archiver résolues
            <span class="sim2-count num">{ctrl.resolvedCount()}</span>
          </button>
        </div>
      </header>

      {/* ── Barre de contexte moteur (sélecteurs + résumé + fenêtre) ────── */}
      <div class="sim2-context">
        <span class="sim2-chip">
          <span>Moteur</span>
          <EngineSelect
            value={ctrl.engine()}
            disabled={ctrl.sending()}
            onChange={(id) => {
              void ctrl.changeEngine(id);
            }}
            class="sim2-mini-select"
          />
          <span class="sim2-chip-sep" />
          <span>Preset</span>
          <PresetSelect
            value={ctrl.presetId()}
            disabled={ctrl.sending()}
            onChange={(id) => {
              void ctrl.changePreset(id);
            }}
            presets={ctrl.presets().slice()}
            emptyLabel="Aucun preset"
            class="sim2-mini-select"
          />
          <Show when={ctrl.currentPreset()}>
            <span class="sim2-chip-hint" title={ctrl.currentPreset()?.description}>
              ⓘ
            </span>
          </Show>
        </span>
        <span class="sim2-chip" title="Marchés surveillés et cadence de scan (éditables dans le rail Paramètres)">
          <b>Marchés</b>
          <span class="sim2-ellip num">{marketsLabel()}</span>
          <span class="sim2-chip-sep" />
          <b>Scan</b>
          <span class="num">{scanLabel()}<small> ms</small></span>
        </span>
        <Show when={nearestOpen()} keyed>
          {(p) => (
            <span class="sim2-chip sim2-chip-timer" title="Clôture de la fenêtre la plus proche (positions ouvertes)">
              <small>CLÔTURE FENÊTRE</small>
              <b class="num">{countdown(p.windowEnd, now())}</b>
            </span>
          )}
        </Show>
      </div>

      {/* ── Rangée KPI ──────────────────────────────────────────────────── */}
      <KpiStrip ctrl={ctrl} equity={equity} />

      {/* ── Workspace : flux + courbe (1fr) + rail Paramètres (384px) ───── */}
      <div class="sim2-work">
        <main class="sim2-main">
          <EquityCard stats={equity.stats} />
          <LiveFeedCard onChart={setChartTarget} />
          <HistoryCard ctrl={ctrl} onChart={setChartTarget} />
        </main>

        {/* ── Rail : carte whipsaw + Paramètres ───────────────────────── */}
        <aside class="sim2-rail">
          <div class="sim2-whip-card">
            <SimWhipsawStatus />
          </div>
          <SettingsRail ctrl={ctrl} />
        </aside>
      </div>

      <ConfirmModal
        open={ctrl.confirmReset()}
        title="Archiver les positions résolues ?"
        message="Les positions résolues sont copiées dans l'archive DB puis retirées de la liste. Les positions ouvertes, ordres en attente et le capital restent intacts."
        confirmLabel="Archiver & vider"
        onConfirm={() => void ctrl.doReset()}
        onCancel={() => ctrl.setConfirmReset(false)}
      />

      {/* Dialog graphique : historique de prix du marché + markers entrée/sortie */}
      <Show when={chartTarget()} keyed>
        {(t) => <LazyMarketHistoryModal target={t} onClose={() => setChartTarget(null)} />}
      </Show>
    </div>
  );
}