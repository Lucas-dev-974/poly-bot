/**
 * Badges d'état partagés (Header + topbar sim2 du dashboard).
 * Style components.css (.quota-badge / .ws-badge) — inchangé.
 */
import { Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { useClock, clockNow } from "../../stores/clockStore";
import { relayerQuota } from "../../stores/quotaStore";
import { wsMarket, wsUser } from "../../stores/wsStore";

/**
 * Affiche l'état du quota relayer Polymarket. Quand le quota est épuisé,
 * affiche un compte à rebours en direct jusqu'au reset.
 */
export function QuotaBadge(): JSX.Element {
  // Horloge globale partagée (tick 1 s) — countdown du reset de quota.
  useClock();

  const quota = createMemo(() => relayerQuota());

  const display = createMemo(() => {
    const q = quota();
    if (!q) return null;
    if (!q.exhausted) {
      return { label: "Relayer quota OK", sub: null as string | null, cls: "ok" };
    }
    const remaining = Math.max(0, Math.ceil((q.resetAt - clockNow()) / 1000));
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
export function WsBadge(): JSX.Element {
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