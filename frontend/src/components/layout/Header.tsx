import { Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "../ui/Badge";
import { config, mode, botEnabled, setBotEnabled } from "../../stores/botStore";
import { api } from "../../api/client";
import { addLog } from "../../stores/logStore";
import { liveBalance } from "../../stores/balanceStore";
import { fmtUsd } from "../../utils/format";
import { QuotaBadge, WsBadge } from "./Badges";

export function Header(props: {
  onOpenWallet?: () => void;
  onOpenRecording?: () => void;
}): JSX.Element {
  const m = createMemo(() => mode());

  const badge = createMemo(() => {
    const modeVal = m();
    if (modeVal === "readonly") return <Badge variant="dry">LIVE (READONLY)</Badge>;
    return <Badge variant="live">LIVE</Badge>;
  });

  const capital = createMemo(() => {
    const live = liveBalance();
    if (live) {
      return (
        <div class="capital-badge">
          {fmtUsd(live.availableCollateral + live.positionsValue)}
          <span class="sub">
            cash {fmtUsd(live.availableCollateral)} · positions {fmtUsd(live.positionsValue)}
          </span>
        </div>
      );
    }
    return null;
  });

  return (
    <header class="header">
      <h1>Polymarket Reverse Bot</h1>
      <a href="/guide" class="btn guide-nav-link">
        Guide stratégie
      </a>
      <a href="/backtest" class="btn guide-nav-link">
        Backtest
      </a>
      <a href="/strategy-editor" class="btn guide-nav-link">
        Éditeur
      </a>
      <a href="/donnees" class="btn guide-nav-link">
        Données
      </a>
      <a href="/simulation" class="btn guide-nav-link">
        Simulation
      </a>
      {badge()}
      <BotToggle />
      <Show when={props.onOpenWallet}>
        {(fn) => (
          <button
            class="btn wallet-btn"
            onClick={() => fn()()}
            title="Retirer du pUSD vers un wallet externe"
          >
            Wallet
          </button>
        )}
      </Show>
      <Show when={props.onOpenRecording}>
        {(fn) => (
          <button
            class="btn wallet-btn"
            onClick={() => fn()()}
            title="Enregistrement et trading par famille de marchés"
          >
            Enregistrements
          </button>
        )}
      </Show>

          <WsBadge />
      <QuotaBadge />
      {capital()}
    </header>
  );
}

function BotToggle(): JSX.Element {
  const [sending, setSending] = createSignal(false);

  async function toggle(): Promise<void> {
    const next = !botEnabled();
    setBotEnabled(next); // optimiste
    setSending(true);
    try {
      const res = await api.setBotEnabled(next);
      if (!res.ok) {
        setBotEnabled(!next); // rollback
        addLog("Échec du changement d'état du bot", undefined, true);
        return;
      }
      setBotEnabled(res.enabled ?? next);
      addLog(next ? "Bot activé" : "Bot désactivé");
    } catch (e) {
      setBotEnabled(!next); // rollback
      addLog(
        "Erreur lors du changement d'état : " +
          (e instanceof Error ? e.message : String(e)),
        undefined,
        true,
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <button
      class={`bot-toggle ${botEnabled() ? "on" : "off"}`}
      onClick={() => void toggle()}
      disabled={sending()}
      title={botEnabled() ? "Désactiver le bot" : "Activer le bot"}
      aria-pressed={botEnabled()}
    >
      <span class="bot-toggle-track">
        <span class="bot-toggle-thumb" />
      </span>
      <span class="bot-toggle-label">
        {botEnabled() ? "ACTIF" : "EN PAUSE"}
      </span>
    </button>
  );
}
