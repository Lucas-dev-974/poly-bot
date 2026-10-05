import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

const STORAGE_KEY = "ui-collapsed-sections";

/**
 * Map id → plié lue depuis localStorage. Une clé absente = section dépliée
 * (état par défaut) ; `true` = pliée. Lecture synchrone (petit JSON).
 */
function readCollapsedMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** État plié d'une section (clé absente = dépliée). */
export function isCollapsed(id: string): boolean {
  return readCollapsedMap()[id] === true;
}

/** Écrit l'état plié d'une section (supprime la clé si dépliée). */
export function writeCollapsed(id: string, collapsed: boolean): void {
  const map = readCollapsedMap();
  if (collapsed) map[id] = true;
  else delete map[id];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* localStorage indisponible (navigation privée) : état session seule. */
  }
}

/** Chevron de pliage : ▸ pivotant à 90° quand la section est ouverte. */
export function CollapseChevron(props: { open: boolean }): JSX.Element {
  return (
    <span class={`collapse-chevron${props.open ? " open" : ""}`} aria-hidden="true">
      ▸
    </span>
  );
}

/**
 * Section pliable générique : header cliquable (chevron + titre + actions
 * optionnelles à droite), contenu rendu uniquement si déplié. L'état est
 * persisté en localStorage sous `ui-collapsed-sections[id]` → il survit à la
 * navigation et au rechargement. Les `actions` (boutons du header) ne
 * déclenchent pas le pliage (stopPropagation).
 */
export function CollapsibleSection(props: {
  id: string;
  title: JSX.Element;
  actions?: JSX.Element;
  class?: string;
  /** Variante « carte » : la section porte le style .panel, le header n'est
   * plus une carte séparée mais la ligne cliquable en haut de la carte. */
  boxed?: boolean;
  children: JSX.Element;
}): JSX.Element {
  // Initialisation une seule fois (le corps du composant tourne une fois en
  // Solid) : absent de la map → déplié.
  const [open, setOpen] = createSignal(!isCollapsed(props.id));

  function toggle(): void {
    const next = !open();
    setOpen(next);
    writeCollapsed(props.id, !next);
  }

  return (
    <section
      class={`collapsible-section${props.boxed ? " boxed" : ""}${props.class ? ` ${props.class}` : ""}`}
    >
      <div
        class="collapsible-header"
        role="button"
        tabindex={0}
        aria-expanded={open()}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <CollapseChevron open={open()} />
        <span class="collapsible-title">{props.title}</span>
        <Show when={props.actions}>
          <span
            class="collapsible-actions"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {props.actions}
          </span>
        </Show>
      </div>
      <Show when={open()}>
        <div class="collapsible-body">{props.children}</div>
      </Show>
    </section>
  );
}