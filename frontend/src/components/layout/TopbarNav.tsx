/**
 * Navigation partagée des en-têtes « sim2 » — extraite de
 * pages/dashboard/Topbar.tsx pour que les pages secondaires (Backtest,
 * Données, …) réutilisent la MÊME liste de liens que la référence
 * (le topbar du dashboard) et ne puissent plus en exposer un sous-ensemble.
 *
 * Liens = ancres <a href> (charge/recharge la page, même comportement que
 * le Topbar du dashboard) ; `activeHref` marque la page courante.
 */
import { For } from "solid-js";
import type { JSX } from "solid-js";

export type NavHref = "/" | "/guide" | "/backtest" | "/strategy-editor" | "/donnees" | "/simulation";

export const NAV_LINKS: ReadonlyArray<{ href: NavHref; label: string }> = [
  { href: "/", label: "Dashboard" },
  { href: "/guide", label: "Guide" },
  { href: "/backtest", label: "Backtest" },
  { href: "/strategy-editor", label: "Éditeur" },
  { href: "/donnees", label: "Données" },
  { href: "/simulation", label: "Simulation" },
];

export function TopbarNavLinks(props: { activeHref?: string; ariaLabel?: string }): JSX.Element {
  return (
    <nav class="sim2-topnav" aria-label={props.ariaLabel ?? "Navigation"}>
      <For each={NAV_LINKS}>
        {(l) => (
          <a
            class={`sim2-nav-link${props.activeHref === l.href ? " on" : ""}`}
            href={l.href}
            aria-current={props.activeHref === l.href ? "page" : undefined}
          >
            {l.label}
          </a>
        )}
      </For>
    </nav>
  );
}