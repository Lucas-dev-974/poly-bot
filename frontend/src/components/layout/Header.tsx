import { Show, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "../ui/Badge";
import { config, mode, botEnabled, setBotEnabled } from "../../stores/botStore";
import { openPositionList } from "../../stores/positionStore";
import { relayerQuota } from "../../stores/quotaStore";
import { api } from "../../api/client";
import { addLog } from "../../stores/logStore";
import { fmtUsd } from "../../utils/format";

export function Header(props: {
  simulatedCash: () => number | null;
  liveBalance: () => { availableCollateral: number; positionsValue: number } | null;
  onReset: () => void;
  resetting: boolean;
}): JSX.Element {
  const m = createMemo(() => mode());

  const badge = createMemo(() => {
    const modeVal = m();
    if (modeVal === "dry") return <Badge variant="dry">DRY RUN</Badge>;
    if (modeVal === "readonly") return <Badge variant="dry">LIVE (READONLY)</Badge>;
    return <Badge variant="live">LIVE</Badge>;
  });

  const capital = createMemo(() => {
    const cash = props.simulatedCash();
    if (cash !== null) {
      const positionsValue = openPositionList().reduce((s, p) => s + (p.cost || 0), 0);
      const total = cash + positionsValue;
      return (
        <div class="capital-badge">
          {fmtUsd(total)}
          <span class="sub">
            cash {fmtUsd(cash)} · positions {fmtUsd(positionsValue)}
          </span>
        </div>
      );
    }
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
      {badge()}
      <BotToggle />
      <Show when={config() !== null && mode() === "dry"}>
        <button
          class="reset-btn"
          onClick={props.onReset}
          disabled={props.resetting}
          title="Réinitialiser toute la base de données"
        >
          {props.resetting ? "Réinitialisation…" : "Réinitialiser la DB"}
        </button>
      </Show>
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

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}
