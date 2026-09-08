import { createMemo, createSignal, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Header } from "./components/layout/Header";
import { ConfigBar } from "./components/layout/ConfigBar";
import { OpenPositions } from "./components/panels/OpenPositions";
import { ActiveMarkets } from "./components/panels/ActiveMarkets";
import { RecentOrders } from "./components/panels/RecentOrders";
import { Performance } from "./components/panels/Performance";
import { ResolvedPositions } from "./components/panels/ResolvedPositions";
import { PolymarketPositions } from "./components/panels/PolymarketPositions";
import { Logs } from "./components/panels/Logs";
import { ConfirmModal } from "./components/modals/ConfirmModal";
import { SettingsModal } from "./components/modals/SettingsModal";
import { useEventSource } from "./hooks/useEventSource";
import { useInterval } from "./hooks/useInterval";
import { api } from "./api/client";
import { dispatchEvent } from "./stores/dispatcher";
import { setConfig, config, setBotEnabled } from "./stores/botStore";
import { clearMarkets } from "./stores/marketStore";
import { clearPositions, replaceOpen, replaceResolved } from "./stores/positionStore";
import { clearOrders, replaceOrders } from "./stores/orderStore";
import { setSimStats } from "./stores/statsStore";
import { updateRelayerQuota } from "./stores/quotaStore";
import {
  clearPoly,
  failRedeem,
  finishRedeem,
  polyPositions,
  startRedeem,
} from "./stores/polyStore";
import { addLog } from "./stores/logStore";
import { fmtUsd } from "./utils/format";
import type { BalanceSnapshot, BotEvent } from "./types";

export function App(): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  const [simulatedCash, setSimulatedCash] = createSignal<number | null>(null);
  const [liveBalance, setLiveBalance] = createSignal<BalanceSnapshot | null>(null);
  const [resetting, setResetting] = createSignal(false);
  const [confirmReset, setConfirmReset] = createSignal(false);
  const [redeemTarget, setRedeemTarget] = createSignal<string | null>(null);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [confirmDiscardSettings, setConfirmDiscardSettings] = createSignal(false);

  // SSE → stores + signaux locaux (balance)
  useEventSource((event: BotEvent) => {
    if (event.type === "balance") {
      setLiveBalance(event.balance);
      return;
    }
    if (event.type === "simulatedBalance") {
      setSimulatedCash(event.balance);
      return;
    }
    dispatchEvent(event);
  });

  // Tick chaque seconde (countdowns)
  useInterval(() => setNow(Date.now()), 1000);

  // Sync REST périodique (fallback si SSE perdu)
  useInterval(() => {
    void syncPositions();
  }, 10_000);

  async function syncPositions(): Promise<void> {
    try {
      const [open, resolved] = await Promise.all([
        api.openPositions(),
        api.resolvedPositions(),
      ]);
      replaceOpen(open.positions);
      replaceResolved(resolved.positions);
    } catch {
      /* ignore */
    }
  }

  async function loadInitialState(): Promise<void> {
    try {
      const [state, recentOrders] = await Promise.all([
        api.state(),
        api.orders().catch(() => ({ orders: [] })),
      ]);
      // Charger l'état du quota relayer (affiché dans le header).
      api.relayerQuota()
        .then((r) => updateRelayerQuota(r.quota))
        .catch(() => {});
      // Charger l'état activé/désactivé du bot (affiché dans le header).
      api.botControlState()
        .then((r) => setBotEnabled(r.enabled))
        .catch(() => {});
      if (state.config) {
        setConfig(state.config);
        if (state.config.dryRun && simulatedCash() === null) {
          setSimulatedCash(state.config.simulatedCapital);
        }
      }
      const hydrated = recentOrders.orders.length > 0;
      if (hydrated) replaceOrders(recentOrders.orders);
      for (const event of state.events) {
        if (event.type === "order" && hydrated) continue;
        if (event.type === "balance") {
          setLiveBalance(event.balance);
        } else if (event.type === "simulatedBalance") {
          setSimulatedCash(event.balance);
        } else {
          dispatchEvent(event);
        }
      }
    } catch (e) {
      addLog("Impossible de charger l'état initial", undefined, true);
    }
    await syncPositions();
  }

  async function handleReset(): Promise<void> {
    setConfirmReset(false);
    setResetting(true);
    try {
      const data = await api.reset();
      if (!data.ok) throw new Error(data.error || "Échec de la réinitialisation");
      // Reset local UI state
      clearMarkets();
      clearOrders();
      clearPositions();
      setSimStats(null);
      setSimulatedCash(null);
      setLiveBalance(null);
      clearPoly();
      addLog("Base de données réinitialisée");
    } catch (e) {
      addLog(
        "Erreur lors de la réinitialisation : " +
          (e instanceof Error ? e.message : String(e)),
        undefined,
        true,
      );
    } finally {
      setResetting(false);
    }
  }

  function handleRedeem(conditionId: string): void {
    const p = polyPositions.find((x) => x.conditionId === conditionId);
    if (!p || !p.redeemable) {
      addLog("Clôture impossible : position introuvable ou non redeemable", undefined, true);
      return;
    }
    setRedeemTarget(conditionId);
  }

  async function confirmRedeem(): Promise<void> {
    const conditionId = redeemTarget();
    if (!conditionId) return;
    const p = polyPositions.find((x) => x.conditionId === conditionId);
    setRedeemTarget(null);
    if (!p) return;
    startRedeem(conditionId);
    try {
      const data = await api.redeem({
        conditionId: p.conditionId,
        outcomeIndex: p.outcomeIndex,
        negRisk: p.negRisk,
      });
      if (!data.ok) throw new Error(data.error || "Échec du redeem");
      finishRedeem(conditionId);
      addLog("Position clôturée (redeem)", {
        txHash: data.txHash,
        market: p.title,
        outcome: p.outcome,
      });
    } catch (e) {
      failRedeem(conditionId);
      addLog(
        "Erreur lors de la clôture : " + (e instanceof Error ? e.message : String(e)),
        undefined,
        true,
      );
    }
  }

  onMount(() => {
    void loadInitialState();
  });

  const redeemPosition = createMemo(() =>
    polyPositions.find((x) => x.conditionId === redeemTarget()),
  );

  return (
    <>
      <Header
        simulatedCash={simulatedCash}
        liveBalance={liveBalance}
        onReset={() => setConfirmReset(true)}
        resetting={resetting()}
      />
      <ConfigBar onConfigure={() => setSettingsOpen(true)} />
      <div class="grid">
        <PolymarketPositions onRedeem={handleRedeem} />
        <OpenPositions now={now()} />
        <ActiveMarkets now={now()} />
        <RecentOrders now={now()} />
        <Performance />
        <ResolvedPositions />
        <Logs />
      </div>
      <ConfirmModal
        open={confirmReset()}
        title="Réinitialiser la base de données ?"
        message="Cette action efface définitivement l'historique des positions, paires, capital, événements et stats. Le capital simulé revient à sa valeur initiale."
        confirmLabel="Réinitialiser"
        onConfirm={() => void handleReset()}
        onCancel={() => setConfirmReset(false)}
      />
      <ConfirmModal
        open={redeemTarget() !== null}
        title={`Clôturer la position "${redeemPosition()?.title ?? ""}" ?`}
        message={
          redeemPosition()
            ? `Cela va redeem ${redeemPosition()!.size} tokens pour ${fmtUsd(redeemPosition()!.currentValue)} de pUSD.`
            : ""
        }
        confirmLabel="Clôturer"
        onConfirm={() => void confirmRedeem()}
        onCancel={() => setRedeemTarget(null)}
      />
      <Show when={config()}>
        {(c) => (
          <SettingsModal
            open={settingsOpen()}
            config={c()}
            onClose={() => setSettingsOpen(false)}
            onSaved={() => addLog("Configuration mise à jour")}
            onDirtyClose={() => setConfirmDiscardSettings(true)}
          />
        )}
      </Show>
      <ConfirmModal
        open={confirmDiscardSettings()}
        title="Abandonner les modifications ?"
        message="Des changements non enregistrés seront perdus."
        confirmLabel="Abandonner"
        onConfirm={() => {
          setConfirmDiscardSettings(false);
          setSettingsOpen(false);
        }}
        onCancel={() => setConfirmDiscardSettings(false)}
      />
    </>
  );
}
