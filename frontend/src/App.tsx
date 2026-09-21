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
import { WhipsawStatus } from "./components/panels/WhipsawStatus";
import { ConfirmModal } from "./components/modals/ConfirmModal";
import { SettingsModal } from "./components/modals/SettingsModal";
import { WalletModal } from "./components/modals/WalletModal";
import { MarketRecordingModal } from "./components/modals/MarketRecordingModal";
import { useEventSource } from "./hooks/useEventSource";
import { useInterval } from "./hooks/useInterval";
import { api } from "./api/client";
import { dispatchEvent } from "./stores/dispatcher";
import { setConfig, config, setBotEnabled } from "./stores/botStore";
import { replaceOpen, replaceResolved } from "./stores/positionStore";
import { replaceOrders } from "./stores/orderStore";
import { updateRelayerQuota } from "./stores/quotaStore";
import {
  failRedeem,
  finishRedeem,
  polyPositions,
  startRedeem,
} from "./stores/polyStore";
import { addLog } from "./stores/logStore";
import { notifyError } from "./utils/notifications";
import { pushError } from "./stores/toastStore";
import { fmtUsd } from "./utils/format";
import type { BalanceSnapshot, BotEvent, SimulatedPosition } from "./types";

export function App(): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  const [liveBalance, setLiveBalance] = createSignal<BalanceSnapshot | null>(null);
  const [redeemTarget, setRedeemTarget] = createSignal<string | null>(null);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [confirmDiscardSettings, setConfirmDiscardSettings] = createSignal(false);
  const [closeTarget, setCloseTarget] = createSignal<SimulatedPosition | null>(null);
  const [closingId, setClosingId] = createSignal<string | null>(null);
  const [walletOpen, setWalletOpen] = createSignal(false);
  const [recordingOpen, setRecordingOpen] = createSignal(false);

  // SSE → stores + signaux locaux (balance)
  useEventSource((event: BotEvent) => {
    if (event.type === "balance") {
      setLiveBalance(event.balance);
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
      }
      const hydrated = recentOrders.orders.length > 0;
      if (hydrated) replaceOrders(recentOrders.orders);
      for (const event of state.events) {
        if (event.type === "order" && hydrated) continue;
        if (event.type === "balance") {
          setLiveBalance(event.balance);
        } else {
          dispatchEvent(event);
        }
      }
    } catch (e) {
      addLog("Impossible de charger l'état initial", undefined, true);
    }
    await syncPositions();
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
      const message = e instanceof Error ? e.message : String(e);
      addLog("Erreur lors de la clôture : " + message, undefined, true);
      pushError("Redeem échoué : " + message);
      notifyError("Redeem échoué : " + p.outcome, message);
    }
  }


  function handleClosePosition(position: SimulatedPosition): void {
    setCloseTarget(position);
  }

  async function confirmClosePosition(): Promise<void> {
    const position = closeTarget();
    if (!position) return;
    setCloseTarget(null);
    setClosingId(position.id);
    try {
      const data = await api.closePosition({ positionId: position.id });
      if (!data.ok) throw new Error(data.error || "Échec de la fermeture");
      addLog("Position fermée (FOK SELL)", {
        outcome: position.outcome,
        fillPrice: data.fillPrice,
        soldSize: data.soldSize,
        pnl: data.pnl,
      });
      await syncPositions();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addLog("Erreur fermeture manuelle : " + message, undefined, true);
      pushError(message, { group: "position-close", replaceGroup: true });
      notifyError("Clôture manuelle échouée", message);
    } finally {
      setClosingId(null);
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
        liveBalance={liveBalance}
        onOpenWallet={() => setWalletOpen(true)}
        onOpenRecording={() => setRecordingOpen(true)}
      />
      <ConfigBar onConfigure={() => setSettingsOpen(true)} />
      <div class="grid">
              <PolymarketPositions onRedeem={handleRedeem} />
              <OpenPositions
                now={now()}
                onClosePosition={handleClosePosition}
                closingId={closingId()}
              />
              <ActiveMarkets now={now()} />
              <RecentOrders now={now()} />
              <Performance />
              <ResolvedPositions />
              <Logs />
              <WhipsawStatus />
            </div>
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
      <ConfirmModal
        open={closeTarget() !== null}
        title={`Fermer la position "${closeTarget()?.outcome ?? ""}" ?`}
        message={
          closeTarget()
            ? `FOK SELL de ${closeTarget()!.size} shares au bid courant. Irréversible.`
            : ""
        }
        confirmLabel="Fermer"
        onConfirm={() => void confirmClosePosition()}
        onCancel={() => setCloseTarget(null)}
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
      <WalletModal open={walletOpen()} onClose={() => setWalletOpen(false)} />
      <MarketRecordingModal
        open={recordingOpen()}
        onClose={() => setRecordingOpen(false)}
      />
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
