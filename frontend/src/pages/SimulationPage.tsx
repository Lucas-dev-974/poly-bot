import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api, type SimEngineState, type SimConfigPatch, type SimTrade, type SimRestingOrder } from "../api/client";
import type { SimulatedPosition } from "../types";
import { ActiveMarkets } from "../components/panels/ActiveMarkets";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { ConfirmModal } from "../components/modals/ConfirmModal";
import {
  allPresetsForStrategy,
  STRATEGY_ENGINE_OPTIONS,
  type StrategyId,
} from "../config/strategyPresets";
import { SIM_5M_STRATEGIES, type Sim5mStrategyDef } from "../config/sim5mStrategies";
import { useEventSource } from "../hooks/useEventSource";
import { useInterval } from "../hooks/useInterval";
import { dispatchEvent } from "../stores/dispatcher";
import { markets } from "../stores/marketStore";
import {
  replaceSimLists,
  simBalance,
  simConfigState,
  simOpenPositions,
  setSimConfigState,
  setSimOpenPositions,
  setSimEngineStats,
  simResolvedPositions,
  simStats,
} from "../stores/simStore";
import { countdown, fmtPrice, fmtShares, fmtUsd, pct, timeStr } from "../utils/format";
import { addLog } from "../stores/logStore";
import { pushError } from "../stores/toastStore";

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pnlClass(pnl: number): string {
  if (pnl > 0) return "pnl-pos";
  if (pnl < 0) return "pnl-neg";
  return "";
}

/** Classe du countdown selon l'urgence (miroir des seuils ActiveMarkets). */
function countdownClass(windowEnd: number, now: number): string {
  const left = windowEnd * 1000 - now;
  if (left <= 5 * 60 * 1000) return "am-countdown--hot";
  if (left <= 15 * 60 * 1000) return "am-countdown--warm";
  return "";
}

/** Titre du marché pour un tokenId (lookup dans le store markets SSE). */
function marketTitleForToken(tokenId: string): string {
  for (const m of Object.values(markets)) {
    if (m.books.some((b) => b.tokenId === tokenId)) return m.title;
  }
  return tokenId.length > 14 ? `${tokenId.slice(0, 14)}…` : tokenId;
}

/**
 * Bid live d'un tokenId (store markets SSE). Appelée dans le JSX d'une ligne :
 * les lectures du store sont trackées → la cellule se met à jour à chaque tick.
 */
function liveBidForToken(tokenId: string): number | null {
  for (const m of Object.values(markets)) {
    const book = m.books.find((b) => b.tokenId === tokenId);
    if (book?.bestBid != null) return book.bestBid;
  }
  return null;
}

/** P&L non réalisé d'une position ouverte, au prix de sortie (bid live). */
function unrealizedPnl(p: SimulatedPosition): number | null {
  const bid = liveBidForToken(p.tokenId);
  if (bid == null) return null;
  return (bid - p.fillPrice) * p.size;
}

export function SimulationPage(): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  const [sending, setSending] = createSignal(false);
  // Copie de travail de la config papier (formulaire moteur/preset/capital).
  const [engine, setEngine] = createSignal<StrategyId>("arb");
  const [presetId, setPresetId] = createSignal<string>("");
  const [capitalInput, setCapitalInput] = createSignal("");
  const [confirmReset, setConfirmReset] = createSignal(false);
  // Onglet de la section historique : positions résolues | journal des ordres.
  const [historyTab, setHistoryTab] = createSignal<"resolved" | "journal">("resolved");
  // Ordres en attente (resting GTC), hydratés via /api/sim/state puis /api/sim/resting.
  const [resting, setResting] = createSignal<SimRestingOrder[]>([]);
  // Journal des ordres (sim_trades), hydraté à l'ouverture puis rafraîchi au tick 10s.
  const [journal, setJournal] = createSignal<SimTrade[]>([]);
  // Ordre de tri des listes : plus récent d'abord par défaut.
  const [reverseOrder, setReverseOrder] = createSignal(true);

  // SSE → dispatcher (simStore + marketStore pour « Marché actif »)
  useEventSource(dispatchEvent);

  // Tick 1s (countdowns).
  useInterval(() => setNow(Date.now()), 1000);

  // Sync REST 10s : fallback si SSE perdu + refresh journal/resting.
  useInterval(() => {
    void api
      .simPositions("open")
      .then((data) => setSimOpenPositions(data.positions))
      .catch(() => {});
    void api
      .simTrades(300)
      .then((data) => setJournal(data.trades))
      .catch(() => {});
    void api
      .simResting("")
      .then((data) => setResting(data.resting))
      .catch(() => {});
  }, 10_000);

  async function loadInitialState(): Promise<void> {
    try {
      const data = await api.simState();
      applyState(data.state);
      replaceSimLists(data.open, data.resolved);
      setResting(data.resting ?? []);
      setJournal(data.trades ?? []);
      if (data.state.stats) setSimEngineStats(data.state.stats);
    } catch {
      addLog("Simulation : chargement de l'état impossible", undefined, true);
    }
  }

  function applyState(state: SimEngineState): void {
    setEngine(state.strategyId as StrategyId);
    setPresetId(state.presetId ?? "");
    setCapitalInput(String(state.capitalInitial));
    setSimConfigState({
      enabled: state.enabled,
      strategyId: state.strategyId,
      presetId: state.presetId,
      capitalInitial: state.capitalInitial,
    });
  }

  async function toggleEngine(): Promise<void> {
    const next = !simConfigState()?.enabled;
    setSending(true);
    try {
      const res = await api.simControl(next);
      if (!res.ok) throw new Error(res.error ?? "Échec du changement d'état");
      setSimConfigState((c) => (c ? { ...c, enabled: next } : c));
      addLog(next ? "Simulation démarrée" : "Simulation arrêtée");
    } catch (e) {
      pushError("Simulation : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setSending(false);
    }
  }

  async function saveConfig(): Promise<void> {
    const payload: SimConfigPatch = {
      strategyId: engine(),
      presetId: presetId() || null,
    };
    // Capital envoyé UNIQUEMENT si modifié : côté moteur, `capital` remplace
    // le cash courant (correction manuelle). L'envoyer systématiquement
    // écraserait le cash courant (pertes/gains) à chaque enregistrement.
    const capital = Number(capitalInput());
    if (Number.isFinite(capital) && capital > 0 && capital !== simConfigState()?.capitalInitial) {
      payload.capital = capital;
    }
    setSending(true);
    try {
      const res = await api.simUpdateConfig(payload);
      if (!res.ok) throw new Error(res.error ?? "Échec de l'enregistrement");
      await loadInitialState();
      addLog("Configuration de simulation enregistrée");
    } catch (e) {
      pushError("Simulation : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setSending(false);
    }
  }

  async function doReset(): Promise<void> {
    setConfirmReset(false);
    setSending(true);
    try {
      const res = await api.simReset();
      if (!res.ok) throw new Error(res.error ?? "Échec de la réinitialisation");
      await loadInitialState();
      replaceSimLists([], []);
      addLog("Simulation réinitialisée (capital + positions + journal)");
    } catch (e) {
      pushError("Simulation : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setSending(false);
    }
  }

  const presets = createMemo(() => allPresetsForStrategy(engine(), []));
  const currentPreset = createMemo(() => presets().find((p) => p.id === presetId()));

  // ── Sélection rapide des 3 stratégies 5m (presets du backtest audits/5min-strategies).
  // Chaque carte = (moteur antiflip-revert, preset 5m). "Active" = config de travail
  // du moteur sim correspond à ce preset. Une seule position à la fois : les 3
  // variantes sont mutuellement exclusives au niveau du moteur sim (un preset à la
  // fois), mais restent combinables en multi-moteurs via le live.
  const sim5mActiveId = createMemo(() => {
    const c = simConfigState();
    if (!c || c.strategyId !== "antiflip-revert" || !c.presetId) return null;
    return SIM_5M_STRATEGIES.some((s) => s.presetId === c.presetId) ? c.presetId : null;
  });

  async function activateSim5mStrategy(def: Sim5mStrategyDef): Promise<void> {
    if (sending()) return;
    setSending(true);
    try {
      // 1. Appliquer le preset au moteur sim (swap à chaud, sans toucher au cash).
      const res = await api.simUpdateConfig({
        strategyId: def.strategyId,
        presetId: def.presetId,
      });
      if (!res.ok) throw new Error(res.error ?? "Échec de l'activation");
      // 2. Démarrer la sim si elle est à l'arrêt (activation = prête à trader).
      if (!simConfigState()?.enabled) {
        const start = await api.simControl(true);
        if (!start.ok) throw new Error(start.error ?? "Échec du démarrage");
      }
      await loadInitialState();
      addLog(`Simulation 5m : stratégie ${def.name} activée (marchés 5m uniquement)`);
    } catch (e) {
      pushError("Simulation : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setSending(false);
    }
  }

  // État "modifié" : compare la copie de travail à la config active du moteur.
  const capitalDirty = createMemo(() => {
    const n = Number(capitalInput());
    return Number.isFinite(n) && n > 0 && n !== simConfigState()?.capitalInitial;
  });
  const configDirty = createMemo(() => {
    const c = simConfigState();
    if (!c) return false;
    return (
      engine() !== (c.strategyId as StrategyId) ||
      (presetId() || null) !== (c.presetId ?? null) ||
      capitalDirty()
    );
  });

  onMount(() => {
    void loadInitialState();
  });

  // Listes triées : "Plus récent d'abord" trié explicitement (le store peut
  // contenir un mélange hydratation REST + events SSE insérés en queue).
  const sortedResolved = createMemo(() => {
    const list = [...simResolvedPositions()];
    list.sort((a, b) => (b.resolvedAt ?? b.windowEnd * 1000) - (a.resolvedAt ?? a.windowEnd * 1000));
    return reverseOrder() ? list : list.reverse();
  });

  const sortedJournal = createMemo(() => {
    const list = [...journal()];
    list.sort((a, b) => b.ts - a.ts);
    return reverseOrder() ? list : list.reverse();
  });

  return (
    <div class="page simulation-page">
      {/* Header : retour + titre + badge + actions */}
      <header class="sim-header">
        <div class="sim-header-left">
          <a class="btn sim-back" href="/">
            ← Dashboard
          </a>
          <h1>Simulation live</h1>
          <Show when={simConfigState()} fallback={<span class="sim-muted">chargement…</span>}>
            {(c) => (
              <span class={`sim-badge ${c().enabled ? "on" : "off"}`}>
                {c().enabled ? "EN COURS" : "À L'ARRÊT"}
              </span>
            )}
          </Show>
        </div>
        <div class="sim-header-actions">
          <button
            class="btn btn-primary"
            onClick={() => void toggleEngine()}
            disabled={sending()}
          >
            {simConfigState()?.enabled ? "Arrêter" : "Démarrer"}
          </button>
          <button class="btn danger" onClick={() => setConfirmReset(true)}>
            Réinitialiser
          </button>
        </div>
      </header>

      {/* Cartes KPI */}
      <div class="sim-kpis">
        <div class="sim-kpi sim-kpi-capital">
          <span class="sim-kpi-label">Capital total</span>
          <Show when={simBalance()} fallback={<span class="sim-kpi-value sim-muted">—</span>}>
            {(b) => (
              <>
                <span class="sim-kpi-value">{fmtUsd(b().total)}</span>
                <span class="sim-kpi-sub">
                  cash {fmtUsd(b().cash)} · positions {fmtUsd(b().positionsValue)}
                </span>
              </>
            )}
          </Show>
        </div>
        <div class="sim-kpi">
          <span class="sim-kpi-label">P&L réalisé</span>
          <Show when={simStats()} fallback={<span class="sim-kpi-value sim-muted">—</span>}>
            {(s) => (
              <span class={`sim-kpi-value ${pnlClass(s().realizedPnl)}`}>
                {fmtUsd(s().realizedPnl)}
              </span>
            )}
          </Show>
        </div>
        <div class="sim-kpi">
          <span class="sim-kpi-label">Winrate</span>
          <Show when={simStats()} fallback={<span class="sim-kpi-value sim-muted">—</span>}>
            {(s) => (
              <>
                <span class="sim-kpi-value">{Math.round(s().winRate * 100)}%</span>
                <span class="sim-kpi-sub">
                  {s().wins}G / {s().losses}P · {s().resolvedPositionsCount} résolues
                </span>
              </>
            )}
          </Show>
        </div>
        <div class="sim-kpi">
          <span class="sim-kpi-label">Exposition ouverte</span>
          <Show when={simStats()} fallback={<span class="sim-kpi-value sim-muted">—</span>}>
            {(s) => (
              <>
                <span class="sim-kpi-value">{fmtUsd(s().openExposure)}</span>
                <span class="sim-kpi-sub">{s().openPositionsCount} positions ouvertes</span>
              </>
            )}
          </Show>
        </div>
      </div>

      {/* Sélection rapide : 3 stratégies 5m validées par backtest (audits/5min-strategies).
          Le gate "5m uniquement" est dans le moteur (antiflip5mOnly) : impossible
          d'ouvrir une position papier sur un marché 15m avec ces presets. */}
      <div class="sim-5m-cards">
        <For each={SIM_5M_STRATEGIES}>
          {(def) => {
            const isActive = () => sim5mActiveId() === def.presetId;
            const isRunning = () => isActive() && simConfigState()?.enabled === true;
            return (
              <button
                type="button"
                class={`sim-5m-card ${isActive() ? "sim-5m-card--active" : ""} ${isRunning() ? "sim-5m-card--running" : ""}`}
                onClick={() => void activateSim5mStrategy(def)}
                disabled={sending()}
                title={isRunning()
                  ? "Active — cliquer pour ré-appliquer (idempotent)"
                  : "Activer en paper trading (marchés 5m uniquement)"}
              >
                <div class="sim-5m-card-top">
                  <span class="sim-5m-card-name">{def.name}</span>
                  <span class="sim-5m-card-rank">#{def.rank} · {def.tag}</span>
                </div>
                <p class="sim-5m-card-desc">{def.description}</p>
                <div class="sim-5m-card-stats">
                  <For each={def.stats}>
                    {(s) => (
                      <span class={s.ok ? "ok" : ""}>
                        {s.label} {s.value}
                      </span>
                    )}
                  </For>
                </div>
                <Show when={def.warn}>
                  <p class="sim-5m-card-warn">⚠ {def.warn}</p>
                </Show>
                <div class="sim-5m-card-foot">
                  <span class="sim-5m-card-badge">
                    {isRunning() ? "● active (en cours)" : isActive() ? "● configurée (à l'arrêt)" : "cliquer pour activer"}
                  </span>
                  <span class="sim-5m-card-badge">5m only</span>
                </div>
              </button>
            );
          }}
        </For>
      </div>
      <p class="sim-5m-note">
        Ces 3 stratégies proviennent du backtest <code>audits/5min-strategies</code> (836 fenêtres BTC
        Up/Down 5m, 402k ticks). Le moteur <code>antiflip-revert</code> avec preset 5m
        refuse toute entrée sur un marché non-5m — la protection est active en paper trading comme en live.
      </p>

      {/* Barre de configuration : groupes Stratégie | Capital + actions */}
      <div class="sim-control-bar">
        <div class="sim-cb-group">
          <span class="sim-cb-title">Stratégie</span>
          <div class="sim-cb-fields">
            <label class="sim-field">
              Moteur
              <select
                value={engine()}
                onChange={(e) => {
                  const id = e.currentTarget.value as StrategyId;
                  setEngine(id);
                  // Preset par défaut du nouveau moteur (cohérence moteur↔preset).
                  const first = allPresetsForStrategy(id, [])[0];
                  setPresetId(first?.id ?? "");
                }}
              >
                <For each={STRATEGY_ENGINE_OPTIONS}>
                  {(opt) => <option value={opt.id}>{opt.label}</option>}
                </For>
              </select>
            </label>
            <label class="sim-field">
              Preset
              <select value={presetId()} onChange={(e) => setPresetId(e.currentTarget.value)}>
                <option value="">Aucun preset</option>
                <For each={presets()}>
                  {(p) => (
                    <option value={p.id}>
                      {p.isUser ? "★ " : ""}{p.name}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </div>
          <Show when={currentPreset()}>
            {(p) => <p class="sim-cb-hint">{p().description}</p>}
          </Show>
        </div>
        <div class="sim-cb-divider" />
        <div class="sim-cb-group">
          <span class="sim-cb-title">Capital</span>
          <div class="sim-cb-fields">
            <label class="sim-field">
              Capital initial
              <span class="sim-field-control">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={capitalInput()}
                  onInput={(e) => setCapitalInput(e.currentTarget.value)}
                />
                <span class="sim-field-unit">pUSD</span>
              </span>
            </label>
          </div>
          <Show when={capitalDirty()}>
            <p class="sim-cb-hint warn">
              Modifié : l'enregistrement remplace le cash courant ({fmtUsd(simBalance()?.cash ?? 0)}).
            </p>
          </Show>
        </div>
        <div class="sim-cb-actions">
          <Show when={capitalDirty()}>
            <button
              class="btn sim-cb-revert"
              type="button"
              onClick={() => setCapitalInput(String(simConfigState()?.capitalInitial ?? ""))}
            >
              Annuler
            </button>
          </Show>
          <button
            class={`btn ${configDirty() ? "btn-primary" : ""}`}
            onClick={() => void saveConfig()}
            disabled={sending() || !configDirty()}
            title={configDirty() ? "Appliquer au moteur de simulation" : "Aucune modification à enregistrer"}
          >
            Enregistrer config
          </button>
        </div>
      </div>

      <div class="grid">
        {/* Positions ouvertes */}
        <Panel title={`Positions ouvertes (${simOpenPositions().length})`}>
          <Show
            when={simOpenPositions().length > 0}
            fallback={<EmptyState text="Aucune position papier ouverte." />}
          >
            <table class="sim-table">
              <thead>
                <tr>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th>Kind</th>
                  <th>Fill</th>
                  <th>Size</th>
                  <th>Coût</th>
                  <th>P&L en cours</th>
                  <th>Fin de fenêtre</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                <For each={simOpenPositions()}>
                  {(p) => (
                    <tr title={p.eventSlug}>
                      <td>{p.eventTitle}</td>
                      <td>{p.outcome}</td>
                      <td>{p.kind}</td>
                      <td>{fmtPrice(p.fillPrice)}</td>
                      <td>{fmtShares(p.size)}</td>
                      <td>{fmtUsd(p.cost)}</td>
                      <td class={pnlClass(unrealizedPnl(p) ?? 0)}>
                        <Show when={unrealizedPnl(p) != null} fallback="—">
                          {fmtUsd(unrealizedPnl(p)!)}
                          <Show when={p.cost > 0}>
                            <span class="sim-pnl-pct"> ({pct((unrealizedPnl(p)! / p.cost) * 100)})</span>
                          </Show>
                        </Show>
                      </td>
                      <td class={countdownClass(p.windowEnd, now())}>
                        {countdown(p.windowEnd, now())}
                      </td>
                      <td>{p.orderType ?? "GTC"}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Panel>

        {/* Ordres en attente (GTC papier non encore remplis) */}
        <Panel title={`Ordres en attente (${resting().length})`}>
          <Show
            when={resting().length > 0}
            fallback={<EmptyState text="Aucun ordre GTC en attente." />}
          >
            <table class="sim-table">
              <thead>
                <tr>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th>Kind</th>
                  <th>Limite</th>
                  <th>Taille</th>
                  <th>Coût</th>
                  <th>Fin de fenêtre</th>
                </tr>
              </thead>
              <tbody>
                <For each={resting()}>
                  {(o) => (
                    <tr class="sim-resting-row" title={o.key}>
                      <td>{marketTitleForToken(o.tokenId)}</td>
                      <td>{o.outcome}</td>
                      <td>{o.kind}</td>
                      <td>{fmtPrice(o.limitPrice)}</td>
                      <td>{fmtShares(o.size)}</td>
                      <td>{fmtUsd(o.cost)}</td>
                      <td class={countdownClass(o.windowEnd, now())}>
                        {countdown(o.windowEnd, now())}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Panel>
      </div>

      {/* Marché actif (temps réel, réutilise marketStore alimenté par SSE) */}
      <div class="sim-active-markets">
        <Panel title="Marché actif (temps réel)">
          <ActiveMarkets now={now()} />
        </Panel>
      </div>

      {/* Historique à onglets : positions résolues | journal des ordres */}
      <div class="sim-history">
        <div class="panel">
          <div class="sim-tabs">
          <button
            class={`sim-tab ${historyTab() === "resolved" ? "active" : ""}`}
            onClick={() => setHistoryTab("resolved")}
          >
            Positions résolues ({simResolvedPositions().length})
          </button>
          <button
            class={`sim-tab ${historyTab() === "journal" ? "active" : ""}`}
            onClick={() => setHistoryTab("journal")}
          >
            Journal des ordres ({journal().length})
          </button>
          <label class="sim-tab-toggle" title="Inverser l'ordre d'affichage">
            <input
              type="checkbox"
              checked={reverseOrder()}
              onChange={(e) => setReverseOrder(e.currentTarget.checked)}
            />
            Plus récent d'abord
          </label>
        </div>

        <Show when={historyTab() === "resolved"} fallback={
          /* Onglet journal : chaque ordre simulé (rempli ou non) */
          <Show
            when={sortedJournal().length > 0}
            fallback={<EmptyState text="Aucun ordre simulé pour l'instant." />}
          >
            <table class="sim-table">
              <thead>
                <tr>
                  <th>Heure</th>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th>Kind</th>
                  <th>Côté</th>
                  <th>Limite</th>
                  <th>Fill</th>
                  <th>Taille</th>
                  <th>Type</th>
                  <th>P&L</th>
                </tr>
              </thead>
              <tbody>
                <For each={sortedJournal()}>
                  {(t) => (
                    <tr
                      class={t.filled ? "" : "sim-resting-row"}
                      title={t.reason ?? undefined}
                    >
                      <td>{timeStr(t.ts)}</td>
                      <td>{t.eventSlug}</td>
                      <td>{t.outcome}</td>
                      <td>{t.kind}</td>
                      <td class={t.side === "BUY" ? "ok" : "err"}>{t.side}</td>
                      <td>{fmtPrice(t.limitPrice)}</td>
                      <td>{t.fillPrice != null ? fmtPrice(t.fillPrice) : "—"}</td>
                      <td>{fmtShares(t.size)}</td>
                      <td>{t.orderType ?? "—"}</td>
                      <td class={pnlClass(t.pnl ?? 0)}>
                        {t.pnl != null ? fmtUsd(t.pnl) : "—"}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        }>
          {/* Onglet positions résolues */}
          <Show
            when={sortedResolved().length > 0}
            fallback={<EmptyState text="Aucune position résolue pour l'instant." />}
          >
            <table class="sim-table">
              <thead>
                <tr>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th>Kind</th>
                  <th>Fill</th>
                  <th>Vente</th>
                  <th>Size</th>
                  <th>P&L</th>
                  <th>Résolu</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <For each={sortedResolved()}>
                  {(p) => (
                    <tr title={p.eventSlug}>
                      <td>{p.eventTitle}</td>
                      <td>{p.outcome}</td>
                      <td>{p.kind}</td>
                      <td>{fmtPrice(p.fillPrice)}</td>
                      <td>{p.sellPrice != null ? fmtPrice(p.sellPrice) : "—"}</td>
                      <td>{fmtShares(p.size)}</td>
                      <td class={pnlClass(p.pnl ?? 0)}>{fmtUsd(p.pnl ?? 0)}</td>
                      <td>{timeStr(p.resolvedAt ?? p.windowEnd * 1000)}</td>
                      <td>{p.status}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>
      </div>
      </div>

      <ConfirmModal
        open={confirmReset()}
        title="Réinitialiser la simulation ?"
        message="Le capital revient à la valeur initiale et toutes les positions/ordres simulés sont effacés. Irréversible."
        confirmLabel="Réinitialiser"
        onConfirm={() => void doReset()}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}