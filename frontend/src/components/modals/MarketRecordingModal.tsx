import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import { addLog } from "../../stores/logStore";
import { notifyError } from "../../utils/notifications";
import type {
  MarketRuleRow,
  MarketRulesResponse,
} from "../../types";

const STORAGE_KEY = "market-recording.lastPrefix";
const PREFIX_RE = /^[a-z0-9]+(-[a-z0-9]+)*-updown-15m$/;

function isValidPrefix(prefix: string): boolean {
  return PREFIX_RE.test(prefix);
}

type ToggleField = "recording" | "trading";

export function MarketRecordingModal(props: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const [data, setData] = createSignal<MarketRulesResponse | null>(null);
  const [newPrefix, setNewPrefix] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [pendingToggle, setPendingToggle] = createSignal<string | null>(null); // `${prefix}:${field}`

  async function refresh(): Promise<void> {
    try {
      const r = await api.marketRules();
      setData(r);
    } catch (e) {
      addLog(
        "Enregistrements : échec du chargement — " +
          (e instanceof Error ? e.message : String(e)),
        undefined,
        true,
      );
    }
  }

  // Reload each time the dialog opens (modal stays mounted — onMount won't replay).
  createEffect(() => {
    if (props.open) {
      setNewPrefix(localStorage.getItem(STORAGE_KEY) ?? "");
      void refresh();
    }
  });

  async function add(): Promise<void> {
    const prefix = newPrefix().trim().toLowerCase();
    if (!isValidPrefix(prefix) || adding()) return;
    setAdding(true);
    try {
      const r = await api.addMarketRule({ prefix });
      if (!r.ok) throw new Error(r.error || "Échec de l'ajout");
      localStorage.setItem(STORAGE_KEY, prefix);
      addLog(`Famille ajoutée : ${prefix}`);
      setNewPrefix("");
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("Erreur d'ajout : " + msg, undefined, true);
      notifyError("Ajout famille échoué", msg);
    } finally {
      setAdding(false);
    }
  }

  async function toggle(row: MarketRuleRow, field: ToggleField): Promise<void> {
    const key = `${row.prefix}:${field}`;
    if (pendingToggle()) return;
    setPendingToggle(key);
    const enabled = field === "recording"
      ? row.recordingEnabled !== 1
      : row.tradingEnabled !== 1;
    try {
      const r = await api.toggleMarketRule({
        prefix: row.prefix,
        field,
        enabled,
      });
      if (!r.ok) throw new Error(r.error || "Échec du changement");
      addLog(
        `${row.prefix} : ${field === "recording" ? "enregistrement" : "trading"} ${enabled ? "activé" : "désactivé"}`,
      );
      if (r.warning) addLog(r.warning, undefined, true);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("Erreur de toggle : " + msg, undefined, true);
      notifyError("Changement refusé", msg);
    } finally {
      setPendingToggle(null);
    }
  }

  const newPrefixError = (): string | null => {
    const v = newPrefix().trim();
    if (!v) return null; // neutre
    if (!isValidPrefix(v)) return "Format attendu : <asset>-updown-15m (15m uniquement)";
    const d = data();
    if (d?.configPrefixes.includes(v)) return "Famille déjà configurée";
    return null;
  };

  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={props.onClose}>
        <div class="modal market-rules-modal" onClick={(e) => e.stopPropagation()}>
          <h3>Enregistrements — marchés</h3>
          <p class="market-rules-hint">
            Les règles s'appliquent par famille de slugs (ex. btc-updown-15m).
            Désactiver l'enregistrement rend les fenêtres futures incomplètes
            pour le backtest. Désactiver le trading n'arrête ni la gestion des
            ordres reposés ni la résolution des positions.
          </p>

          <div class="market-rules-add">
            <input
              type="text"
              class="cfg-input"
              placeholder="sol-updown-15m"
              value={newPrefix()}
              onInput={(e) => setNewPrefix(e.currentTarget.value)}
            />
            <button
              class="btn"
              disabled={adding() || !newPrefix().trim() || newPrefixError() !== null}
              onClick={() => void add()}
            >
              {adding() ? "Ajout…" : "Ajouter"}
            </button>
          </div>
          <Show when={newPrefixError()}>
            {(msg) => <p class="market-rules-error">{msg()}</p>}
          </Show>

          <Show when={(data()?.discovered.length ?? 0) > 0}>
            <div class="market-rules-suggestions">
              Familles vues récemment, non configurées :
              <For each={data()?.discovered ?? []}>
                {(d) => (
                  <button
                    class="btn market-rules-suggestion"
                    onClick={() => setNewPrefix(d.prefix)}
                    title={`Vu ${new Date(d.lastSeenTs).toLocaleString()} · ${d.slugCount} slugs`}
                  >
                    + {d.prefix}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <div class="market-rules-table">
            <div class="market-rules-row market-rules-head">
              <span>Famille</span>
              <span>Enregistrement</span>
              <span>Trading</span>
            </div>
            <Show
              when={data() && data()!.rules.length > 0}
              fallback={
                <p class="market-rules-empty">
                  {data() ? "Aucune famille enregistrée." : "Chargement…"}
                </p>
              }
            >
              <For each={data()!.rules}>
                {(row) => (
                  <div class="market-rules-row">
                    <span class="market-rules-prefix" title={row.prefix}>
                      {row.prefix}
                    </span>
                    <RuleToggle
                      on={row.recordingEnabled === 1}
                      busy={pendingToggle() === `${row.prefix}:recording`}
                      disabled={pendingToggle() !== null}
                      label={row.recordingEnabled === 1 ? "ON" : "OFF"}
                      onToggle={() => void toggle(row, "recording")}
                    />
                    <RuleToggle
                      on={row.tradingEnabled === 1}
                      busy={pendingToggle() === `${row.prefix}:trading`}
                      disabled={pendingToggle() !== null}
                      label={row.tradingEnabled === 1 ? "ON" : "OFF"}
                      onToggle={() => void toggle(row, "trading")}
                    />
                  </div>
                )}
              </For>
            </Show>
          </div>

          <div class="modal-actions">
            <button class="btn" onClick={props.onClose}>
              Fermer
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

function RuleToggle(props: {
  on: boolean;
  busy: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      class={`rule-toggle ${props.on ? "on" : "off"}`}
      disabled={props.disabled || props.busy}
      onClick={props.onToggle}
      aria-pressed={props.on}
    >
      <span class="rule-toggle-track">
        <span class="rule-toggle-thumb" />
      </span>
      <span class="rule-toggle-label">{props.busy ? "…" : props.label}</span>
    </button>
  );
}