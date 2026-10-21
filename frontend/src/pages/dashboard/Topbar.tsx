/**
 * Topbar sim2 du Dashboard — même design que /simulation (sim2.css global).
 * Titre + badge d'état du bot (ACTIF / EN PAUSE, point pulsant) + actions :
 * liens de navigation, Wallet, Enregistrements, Démarrer/Arrêter le bot
 * (logique BotToggle du Header, conservée à l'identique).
 */
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import { botEnabled, setBotEnabled } from "../../stores/botStore";
import { addLog } from "../../stores/logStore";

const NAV_LINKS: Array<{ href: string; label: string }> = [
  { href: "/guide", label: "Guide" },
  { href: "/backtest", label: "Backtest" },
  { href: "/strategy-editor", label: "Éditeur" },
  { href: "/donnees", label: "Données" },
  { href: "/simulation", label: "Simulation" },
];

export function Topbar(props: {
  onOpenWallet?: () => void;
  onOpenRecording?: () => void;
}): JSX.Element {
  // ── Démarrer / Arrêter le bot (ex-BotToggle du Header) ───────────────
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
    <header class="sim2-topbar">
      <div class="sim2-topbar-left">
        <h1 class="sim2-title">Dashboard</h1>
        <span class={`sim2-badge ${botEnabled() ? "on" : "off"}`}>
          <span class="sim2-badge-dot" aria-hidden="true" />
          {botEnabled() ? "ACTIF" : "EN PAUSE"}
        </span>
      </div>
      <div class="sim2-topbar-actions">
        <For each={NAV_LINKS}>
          {(l) => (
            <a class="btn btn-ghost" href={l.href}>
              {l.label}
            </a>
          )}
        </For>
        <Show when={props.onOpenWallet}>
          {(fn) => (
            <button
              type="button"
              class="btn btn-ghost"
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
              type="button"
              class="btn btn-ghost"
              onClick={() => fn()()}
              title="Enregistrement et trading par famille de marchés"
            >
              Enregistrements
            </button>
          )}
        </Show>
        <button
          class={botEnabled() ? "btn sim2-danger-ghost" : "btn btn-primary"}
          onClick={() => void toggle()}
          disabled={sending()}
          title={botEnabled() ? "Désactiver le bot" : "Activer le bot"}
          aria-pressed={botEnabled()}
        >
          {botEnabled() ? "Arrêter" : "Démarrer"}
        </button>
      </div>
    </header>
  );
}