import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { logs } from "../../stores/logStore";
import { timeStr } from "../../utils/format";
import {
  disableNotify,
  notifyPref,
  requestNotifyPermission,
  type NotifyPref,
} from "../../utils/notifications";

/** Button label for the current notification preference. */
function notifyLabel(pref: NotifyPref): string {
  switch (pref) {
    case "granted":
      return "Notifications d'erreur : activées (cliquer pour désactiver)";
    case "denied":
      // Browser-level block: nothing the page can do, the user must unblock
      // in the address bar; the button then returns to the default state.
      return "Notifications bloquées (à débloquer dans le navigateur)";
    default:
      return "Activer les notifications d'erreur";
  }
}

export function Logs(): JSX.Element {
  const [pref, setPref] = createSignal<NotifyPref>(notifyPref());

  async function toggleNotifications(): Promise<void> {
    if (pref() === "granted") {
      disableNotify();
      setPref("default");
      return;
    }
    setPref(await requestNotifyPermission());
  }

  return (
    <Panel title="Logs" full>
      <div class="logs">
        <Show
          when={logs.length > 0}
          fallback={<EmptyState text="Aucun log pour l'instant." />}
        >
          <For each={logs}>
            {(log) => (
              <div>
                <span class="ts">[{timeStr(log.ts)}]</span>{" "}
                <span class={log.isError ? "err" : "ok"}>{log.message}</span>
                {log.data ? " " + JSON.stringify(log.data) : ""}
              </div>
            )}
          </For>
        </Show>
      </div>
      <div class="logs-notify">
        <Show
          when={pref() !== "unsupported"}
          fallback={
            <span class="muted">Notifications non supportées par ce navigateur</span>
          }
        >
          <button
            class="btn"
            type="button"
            disabled={pref() === "denied"}
            onClick={() => void toggleNotifications()}
          >
            {notifyLabel(pref())}
          </button>
        </Show>
      </div>
    </Panel>
  );
}