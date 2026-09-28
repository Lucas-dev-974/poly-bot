import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { CollapseChevron, isCollapsed, writeCollapsed } from "./Collapsible";

export function Panel(props: {
  title: string;
  full?: boolean;
  /** Pliable : header cliquable, état persisté en localStorage. */
  collapsible?: boolean;
  /** Clé de persistance stable (le titre peut être dynamique, ex. compteurs). */
  collapsibleId?: string;
  children: JSX.Element;
}): JSX.Element {
  const key = () => props.collapsibleId ?? props.title;
  // Initialisé une fois (le corps du composant tourne une fois en Solid) :
  // absent de la map localStorage → déplié.
  const [open, setOpen] = createSignal(props.collapsible ? !isCollapsed(key()) : true);

  function toggle(): void {
    if (!props.collapsible) return;
    const next = !open();
    setOpen(next);
    writeCollapsed(key(), !next);
  }

  return (
    <div
      class={`panel${props.full ? " full" : ""}${props.collapsible ? " panel-collapsible" : ""}`}
    >
      <Show when={props.collapsible} fallback={<h2>{props.title}</h2>}>
        <h2
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
          {props.title}
        </h2>
      </Show>
      <Show when={!props.collapsible || open()}>{props.children}</Show>
    </div>
  );
}