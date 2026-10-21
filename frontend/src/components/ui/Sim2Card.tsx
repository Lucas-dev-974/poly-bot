/**
 * Socle des cartes « sim2 » — partagé par le Dashboard (/) et la page
 * Simulation (/simulation). Une carte = en-tête (titre, note, compteur,
 * onglets, outils) + corps (padding standard ou flush).
 *
 * Remplace les coquilles écrites à la main dans les deux pages :
 *   - pages/dashboard/HistoryCard.tsx  (carte à onglets)
 *   - pages/simulation/HistoryCard.tsx  (carte à onglets)
 *   - pages/simulation/LiveFeedCard.tsx (carte à onglets)
 *   - pages/simulation/EquityCard.tsx   (carte simple, corps conditionnel)
 */
import { For, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";

export function Sim2Card(props: {
  title: JSX.Element;
  /** Badge compteur dans le header (omis si undefined). */
  count?: number | string;
  /** Note atténuée après le titre (résumé de stats, rappel…). */
  note?: JSX.Element;
  /** Onglets segmentés dans le header (carte à onglets). */
  tabs?: JSX.Element;
  /** Outils à droite du header (select, bouton, tri…). */
  tools?: JSX.Element;
  /** Variante flush : le contenu gère son propre espacement (tables scrollables,
      tuiles ActiveMarkets, flux Logs). */
  flush?: boolean;
  /** Variante raw : AUCUN conteneur de corps — les enfants sont rendus
      directement dans la carte (barres de pagination, sections empilées).
      Le corps gère alors son propre padding. */
  raw?: boolean;
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
        <Show when={props.tabs}>{props.tabs}</Show>
        <div class="sim2-card-spacer" />
        {props.tools}
      </div>
      <Show
        when={!props.raw}
        fallback={props.children}
      >
        <div class={props.flush ? "sim2-card-b sim2-card-b-flush" : "sim2-card-b"}>
          {props.children}
        </div>
      </Show>
    </section>
  );
}

/**
 * Groupe d'onglets segmentés (`.sim2-seg`) — un bouton par onglet, compteur
 * de l'onglet affiché à côté du libellé.
 *
 * `tabs` est un ACCESSEUR : la liste est relue au rendu, pas capturée à la
 * création du JSX (piège Solid : un tableau figé ne se rafraîchit pas).
 * L'onglet actif est porté par l'appelant (signal externe) : ce composant
 * ne gère pas d'état.
 */
export function Sim2Tabs<T extends string>(props: {
  tabs: Accessor<ReadonlyArray<{ id: T; label: string; count?: number | string }>>;
  active: T;
  onSelect: (id: T) => void;
  ariaLabel?: string;
}): JSX.Element {
  return (
    <div class="sim2-seg" role="tablist" aria-label={props.ariaLabel}>
      <For each={props.tabs()}>
        {(t) => (
          <button
            role="tab"
            aria-selected={props.active === t.id}
            classList={{ on: props.active === t.id }}
            onClick={() => props.onSelect(t.id)}
          >
            {t.label}
            {t.count != null && <span class="n">{t.count}</span>}
          </button>
        )}
      </For>
    </div>
  );
}
