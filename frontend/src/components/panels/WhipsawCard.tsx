/**
 * Carte « Filtre Whipsaw (fav-band) » — présentation PARTAGÉE par le
 * dashboard live (/) et la page Simulation (/simulation).
 *
 * La carte est un composant de FONCTION (panels/), pas de présentation
 * primitive : elle consomme la vue dérivée `useWhipsawView` (panels/) et la
 * coquille `Sim2Card` (ui/). Chaque page fournit ses DONNÉES (store SSE,
 * config effective) et son ACTION (reset) via props — la carte ne connaît
 * ni le live ni le sim.
 *
 * Elle n'est affichée QUE si le filtre whipsaw est ACTIVÉ dans la config
 * (gate porté par l'appelant : `view.enabled()`).
 */
import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Sim2Card } from "../ui/Sim2Card";
import type { WhipsawView } from "./useWhipsawView";

export function WhipsawCard(props: {
  /** Vue dérivée (statut, badge, countdown, seuil). */
  view: WhipsawView;
  /** Reset de la pause en cours (disable le bouton). */
  resetting: boolean;
  /** Action de reset de la pause. */
  onReset: () => void;
}): JSX.Element {
  /** Phrase de statut sous les détails (seuil atteint / série de pertes). */
  const statusText = (): string | null => {
    const s = props.view.status();
    if (!s) return null;
    if (s.active) return `Pause active — ${props.view.remainingText() ?? "—"} restants`;
    if (props.view.thresholdReached()) {
      return `Seuil atteint (${s.lossStreak}/${s.pauseAfterLosses}) — la prochaine perte déclenche la pause`;
    }
    return `Actif — série de pertes : ${s.lossStreak}/${s.pauseAfterLosses ?? "—"}`;
  };

  return (
    <Sim2Card title="Filtre Whipsaw (fav-band)">
      <div class="whipsaw-status">
        <div class={`whipsaw-badge ${props.view.badgeClass()}`}>
          <span class="dot" />
          <span class="label">
            {props.view.badgeClass() === "active" && "⏸️ Pause active"}
            {props.view.badgeClass() === "ready" && "✅ Prêt"}
            {props.view.badgeClass() === "unknown" && "❓ Inconnu"}
          </span>
        </div>

        <Show when={props.view.status()}>
          {(s) => (
            <div class="whipsaw-details">
              <div class="detail-row">
                <span class="detail-label">Fenêtres de pause :</span>
                <span class="detail-value">
                  {s().pauseWindows} fenêtre(s) (≈{s().pauseWindows * 15} min)
                </span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Seuil déclenchement :</span>
                <span class="detail-value">
                  {s().pauseAfterLosses != null
                    ? `${s().pauseAfterLosses} pertes consécutives`
                    : "Non configuré"}
                </span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Série pertes actuelle :</span>
                <span class="detail-value">{s().lossStreak}</span>
              </div>
              <Show when={s().active}>
                <div class="detail-row highlight">
                  <span class="detail-label">Temps restant :</span>
                  <span class="detail-value countdown">{props.view.remainingText()}</span>
                </div>
              </Show>
              <Show when={s().active}>
                <div class="detail-row reset-row">
                  <button
                    class="btn btn-danger-solid"
                    onClick={props.onReset}
                    disabled={props.resetting}
                  >
                    {props.resetting ? "⏳ Réinitialisation..." : "🔄 Réinitialiser la pause"}
                  </button>
                </div>
              </Show>
              <div class="detail-row status-text">{statusText()}</div>
            </div>
          )}
        </Show>
      </div>
    </Sim2Card>
  );
}
