/**
 * Contrôle du moteur de simulation (page /simulation) — état et opérations
 * de bout en bout : démarrage/arrêt, patchs de config, édition inline du
 * capital (KPI), archivage des résolues, count paginé. Le hook est instancié
 * UNE FOIS par la page (composition root) et l'objet est passé en props aux
 * composants présentationnels (KpiStrip, HistoryCard, SettingsRail…).
 */
import { createMemo, createSignal } from "solid-js";
import { api, type SimConfigPatch, type SimEngineState } from "../../api/client";
import { toMessage } from "../../utils/display";
import { allPresetsForStrategy, type AnyPreset, type StrategyId } from "../../config/strategyPresets";
import { useAdaptiveSync } from "../../hooks/useAdaptiveSync";
import { addLog } from "../../stores/logStore";
import { pushError } from "../../stores/toastStore";
import {
  replaceSimLists,
  replaceSimRestingAndJournal,
  simBalance,
  simConfigState,
  simResolvedPagedActive,
  simResolvedPaging,
  simResolvedPositions,
  fetchSimResolvedPage,
  resetSimResolvedPaging,
  setSimBalance,
  setSimConfigState,
  setSimEffectiveConfig,
  setSimEngineStats,
  setSimJournal,
  setSimOpenPositions,
  setSimResting,
} from "../../stores/simStore";
import { fmtUsd } from "../../utils/format";

export interface SimControl {
  /** Requête en cours (disable global des contrôles). */
  sending(): boolean;
  /** Manipuler l'état sending depuis les sous-composants (pagination, apply). */
  setSending(v: boolean): void;
  /** Moteur sélectionné (copie locale). */
  engine(): StrategyId;
  /** Preset sélectionné (copie locale). */
  presetId(): string;
  /** Presets du moteur courant. */
  presets(): readonly AnyPreset[];
  currentPreset(): AnyPreset | undefined;
  /** Démarrer / Arrêter le moteur paper. */
  toggleEngine(): Promise<void>;
  /** Changement de moteur (applique immédiatement + preset par défaut). */
  changeEngine(id: StrategyId): Promise<void>;
  /** Changement de preset (applique immédiatement). */
  changePreset(id: string): Promise<void>;
  /** Recharge l'état complet (config + listes). Exposé pour les autres hooks. */
  reload(): Promise<void>;
  // ── Édition inline du KPI Capital total ──
  editingCapital(): boolean;
  capitalEditValue(): string;
  setCapitalEditValue(v: string): void;
  startCapitalEdit(): void;
  cancelCapitalEdit(): void;
  commitCapitalEdit(): Promise<void>;
  // ── Archivage des positions résolues (modal de confirmation gérée ici) ──
  confirmReset(): boolean;
  setConfirmReset(v: boolean): void;
  doReset(): Promise<void>;
  /** Compteur resolved (mode paginé = total DB, sinon longueur vivante). */
  resolvedCount(): number;
}

export function useSimControl(): SimControl {
  const [sending, setSending] = createSignal(false);
  // Copie de travail de la config papier (selects moteur/preset de la barre
  // de contexte — le capital s'édite inline sur le KPI).
  const [engine, setEngine] = createSignal<StrategyId>("arb");
  const [presetId, setPresetId] = createSignal<string>("");
  // Édition inline du KPI « Capital total » (clic → champ → Enter/blur
  // applique, Échap annule).
  const [editingCapital, setEditingCapital] = createSignal(false);
  const [capitalEditInput, setCapitalEditInput] = createSignal("");
  const [confirmReset, setConfirmReset] = createSignal(false);

  // Sync REST adaptative (2 vitesses) : 60 s si SSE vivant, 10 s si perdu
  // (le SSE est replay=0 → le REST est le seul réconciliateur après coupure).
  useAdaptiveSync(
    () => {
      void api
        .simPositions("open")
        .then((data) => setSimOpenPositions(data.positions))
        .catch(() => {});
      void api
        .simTrades(300)
        .then((data) => setSimJournal(data.trades))
        .catch(() => {});
      void api
        .simResting("")
        .then((data) => setSimResting(data.resting))
        .catch(() => {});
    },
    { fastMs: 10_000, slowMs: 60_000 },
  );

  async function loadInitialState(): Promise<void> {
    try {
      const data = await api.simState();
      applyState(data.state);
      setSimEffectiveConfig(data.effectiveConfig ?? null);
      replaceSimLists(data.open, data.resolved);
      replaceSimRestingAndJournal(data.resting ?? [], data.trades ?? []);
      if (data.state.stats) setSimEngineStats(data.state.stats);
      // Interim = liste vivante /api/sim/state (plafond 200) ; le fetch paginé
      // DB complète remplace immédiatement si disponible — sinon fallback vivant.
      const pg = simResolvedPaging();
      const fetched = await fetchSimResolvedPage(pg.page, pg.pageSize);
      if (fetched === null) resetSimResolvedPaging();
    } catch {
      addLog("Simulation : chargement de l'état impossible", undefined, true);
    }
  }

  function applyState(state: SimEngineState): void {
    setEngine(state.strategyId as StrategyId);
    setPresetId(state.presetId ?? "");
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

  /**
   * Applique un patch config au moteur + recharge l'état (config effective,
   * rail Paramètres) — mutualise selects moteur/preset / rail Paramètres.
   */
  async function pushConfigPatch(payload: SimConfigPatch): Promise<void> {
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

  /** Ouvre l'édition inline du KPI Capital total, préremplie avec le total courant. */
  function startCapitalEdit(): void {
    if (editingCapital() || sending() || !simBalance()) return;
    setCapitalEditInput(simBalance()!.total.toFixed(2));
    setEditingCapital(true);
  }

  function cancelCapitalEdit(): void {
    setEditingCapital(false);
    setCapitalEditInput("");
  }

  /**
   * Valide l'édition inline du KPI « Capital total » : le moteur n'accepte que
   * le cash (patch `capital` = remplacement du cash + capitalInitial), donc le
   * total voulu est converti en cash = total − valeur des positions courantes.
   * Refusé si négatif (total < valeur des positions). Échap = annulation, vide
   * ou inchangé = no-op silencieux.
   */
  async function commitCapitalEdit(): Promise<void> {
    if (!editingCapital()) return;
    const raw = capitalEditInput().trim();
    setEditingCapital(false);
    setCapitalEditInput("");
    if (!raw) return; // Vide = annulation silencieuse.
    const total = Number(raw.replace(",", "."));
    if (!Number.isFinite(total) || total <= 0) {
      pushError("Capital total : entrez un montant positif.", { group: "sim-error", replaceGroup: true });
      return;
    }
    const balance = simBalance();
    if (!balance) return;
    const rounded = Math.round(total * 100) / 100;
    if (Math.abs(rounded - balance.total) < 0.005) return; // Inchangé.
    const cashWanted = Math.round((rounded - balance.positionsValue) * 100) / 100;
    if (cashWanted < 0) {
      pushError(
        `Total impossible : les positions valent ${fmtUsd(balance.positionsValue)} (cash ne peut pas être négatif).`,
        { group: "sim-error", replaceGroup: true },
      );
      return;
    }
    // No-op uniquement si le cash réel ne changerait pas (le patch `capital`
    // remplace le cash courant). Comparer à capitalInitial serait faux : le
    // cash courant dérive de capitalInitial après gains/pertes.
    if (Math.abs(cashWanted - balance.cash) < 0.005) {
      addLog("Capital total inchangé (cash déjà à jour)");
      return;
    }
    try {
      const res = await api.simUpdateConfig({ capital: cashWanted });
      if (!res.ok) throw new Error(res.error ?? "Échec de la modification du capital");
      // Le PATCH renvoie le nouvel état moteur : rafraîchit le solde + stats immédiatement
      // (sinon l'affichage attendrait le prochain tick SSE de 5 s).
      const refreshed = await api.simState();
      applyState(refreshed.state);
      const st = refreshed.state;
      setSimBalance({
        cash: st.cash,
        positionsValue: st.positionsValue,
        total: st.total,
      });
      if (st.stats) setSimEngineStats(st.stats);
      addLog(`Capital total édité : ${fmtUsd(rounded)} (cash ${fmtUsd(cashWanted)}, était ${fmtUsd(balance.cash)})`);
    } catch (e) {
      pushError("Simulation : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    }
  }

  /** Changement de moteur (barre de contexte) : applique immédiatement + preset par défaut. */
  async function changeEngine(id: StrategyId): Promise<void> {
    setEngine(id);
    const first = allPresetsForStrategy(id, [])[0];
    setPresetId(first?.id ?? "");
    await pushConfigPatch({ strategyId: id, presetId: first?.id ?? null });
  }

  /** Changement de preset (barre de contexte) : applique immédiatement. */
  async function changePreset(id: string): Promise<void> {
    setPresetId(id);
    await pushConfigPatch({ strategyId: engine(), presetId: id || null });
  }

  async function doReset(): Promise<void> {
    setConfirmReset(false);
    setSending(true);
    try {
      const res = await api.simReset();
      if (!res.ok) throw new Error(res.error ?? "Echec de la reinitialisation");
      resetSimResolvedPaging();
      await loadInitialState();
      const n = res.archived ?? 0;
      addLog(
        n > 0
          ? `Positions résolues archivées (${n}) puis vidées — positions ouvertes conservées`
          : "Aucune position résolue à archiver — positions ouvertes conservées",
      );
    } catch (e) {
      pushError("Simulation : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setSending(false);
    }
  }

  /** Compteur resolved : mode paginé = total DB (COUNT SQL), sinon vivant. */
  const resolvedCount = createMemo(() =>
    simResolvedPagedActive() ? simResolvedPaging().total : simResolvedPositions().length,
  );

  return {
    sending,
    setSending,
    engine,
    presetId,
    presets: () => allPresetsForStrategy(engine(), []),
    currentPreset: () => allPresetsForStrategy(engine(), []).find((p) => p.id === presetId()),
    toggleEngine,
    changeEngine,
    changePreset,
    reload: loadInitialState,
    editingCapital,
    capitalEditValue: capitalEditInput,
    setCapitalEditValue: setCapitalEditInput,
    startCapitalEdit,
    cancelCapitalEdit,
    commitCapitalEdit,
    confirmReset,
    setConfirmReset,
    doReset,
    resolvedCount,
  };
}