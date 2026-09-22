import { Show, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "../ui/Badge";
import { config, mode, botEnabled, setBotEnabled } from "../../stores/botStore";
import { relayerQuota } from "../../stores/quotaStore";
import { wsMarket, wsUser } from "../../stores/wsStore";
import { api } from "../../api/client";
import { addLog } from "../../stores/logStore";
import { fmtUsd } from "../../utils/format";

export function Header(props: {
  liveBalance: () => { availableCollateral: number; positionsValue: number } | null;
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
    const live = props.liveBalance();
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

/**
 * Affiche l'état du quota relayer Polymarket. Quand le quota est épuisé,
 * affiche un compte à rebours en direct jusqu'au reset.
 */
function QuotaBadge(): JSX.Element {
  const [now, setNow] = createSignal(Date.now());

  // Tick chaque seconde pour le compte à rebours.
  onMount(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  });

  const quota = createMemo(() => relayerQuota());

  const display = createMemo(() => {
    const q = quota();
    if (!q) return null;
    if (!q.exhausted) {
      return { label: "Relayer quota OK", sub: null as string | null, cls: "ok" };
    }
    const remaining = Math.max(0, Math.ceil((q.resetAt - now()) / 1000));
    if (remaining <= 0) {
      return { label: "Relayer quota", sub: "reset imminent…", cls: "exhausted" };
    }
    return {
      label: "Relayer quota épuisé",
      sub: `reset dans ${formatDuration(remaining)}`,
      cls: "exhausted",
    };
  });

  return (
    <Show when={display()} fallback={<></>}>
      {(d) => (
        <div class={`quota-badge ${d().cls}`}>
          {d().label}
          <Show when={d().sub}>
            <span class="sub">{d().sub}</span>
          </Show>
        </div>
      )}
    </Show>
  );
}

/**
 * Badge WS : état des deux canaux CLOB (market + user). Vert = connecté,
 * gris = déconnecté (fallback REST), tooltip = compte des reconnexions.
 */
function WsBadge(): JSX.Element {
  const market = createMemo(() => wsMarket());
  const user = createMemo(() => wsUser());

  const display = createMemo(() => {
    const m = market();
    const u = user();
    if (!m && !u) return null;
    const connected = m?.connected !== false && u?.connected !== false;
    const reconnects = (m?.reconnects ?? 0) + (u?.reconnects ?? 0);
    return {
      label: connected ? "WS OK" : "WS off",
      sub: reconnects > 0 ? `${reconnects} recon.` : null,
      cls: connected ? "ok" : "off",
    };
  });

  return (
    <Show when={display()} fallback={<></>}>
      {(d) => (
        <div class={`quota-badge ${d().cls}`}>
          {d().label}
          <Show when={d().sub}>
            <span class="sub">{d().sub}</span>
          </Show>
        </div>
      )}
    </Show>
  );
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}
