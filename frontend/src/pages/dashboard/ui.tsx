/**
 * Composants de présentation propres au Dashboard sim2 (pages/dashboard/).
 * Sim2Card reproduit l'anatomie des cartes de la page Simulation
 * (pages/simulation/*.tsx + styles/sim2.css) : header avec titre, badge
 * compteur, note atténuée, outils à droite, corps standard ou flush.
 */
import { Show } from "solid-js";
import type { JSX } from "solid-js";

export function Sim2Card(props: {
  title: JSX.Element;
  /** Badge compteur dans le header (omis si undefined). */
  count?: number | string;
  /** Note atténuée après le titre (résumé de stats, rappel…). */
  note?: JSX.Element;
  /** Outils à droite du header (select, bouton, tri…). */
  tools?: JSX.Element;
  /** Variante flush : le contenu gère son propre espacement (tables scrollables,
      tuiles ActiveMarkets, flux Logs). */
  flush?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section class="sim2-card">
      <div class="sim2-card-h">
        <h2>{props.title}</h2>
        <Show when={props.note}>
          <span class="sim2-card-note">{props.note}</span>
        </Show>
        <Show when={props.count != null}>
          <span class="sim2-count num">{props.count}</span>
        </Show>
        <div class="sim2-card-spacer" />
        {props.tools}
      </div>
      <div class={props.flush ? "sim2-card-b sim2-card-b-flush" : "sim2-card-b"}>
        {props.children}
      </div>
    </section>
  );
}