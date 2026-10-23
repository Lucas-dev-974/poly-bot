/**
 * Rangée de cartes KPI « simples » — ossature commune : LABEL (majuscules) /
 * valeur (mono, classe d'état) / sous-ligne (—).
 * Utilisée par les pages à cartes simples (BacktestKpis, DataPage).
 * Les strips RICHES du dashboard et de la simulation (RingGauge, barres,
 * édition capital, sparkline) gardent leur JSX dédié : les abstraire
 * ferait perdre plus en lisibilité que le gain en duplication.
 *
 * Convention Solid : `cards` est un ACCESSOR (comme Sim2Tabs.tabs) et les
 * champs value/sub sont des accessors appelés DANS les cartes — la liste
 * doit être construite sans lecture réactive (objets stables) pour que
 * <For> ne remonte jamais les cartes ; seuls leurs contenus restent réactifs.
 *
 * États (sim2.css) : valueClass `pnl-pos/pnl-neg` via pnlClass() (0 = neutre),
 * `pos/neg` = état sémantique, `acc` = accent, carte `hl` = carte accentuée.
 */
import { For, Show } from "solid-js";
import type { JSX } from "solid-js";

export type Sim2KpiCard = {
  label: string;
  /** Valeur mono — accessor, lue inline dans la carte. */
  value: () => JSX.Element;
  /** Classe d'état de la valeur — accessor (réactif). */
  valueClass?: () => string;
  /** Sous-ligne — accessor, lue inline dans la carte (null = omise). */
  sub?: () => JSX.Element | null;
  /** Tooltip de la sous-ligne. */
  subTitle?: () => string | undefined;
  /** Classe supplémentaire de la carte (ex. page : data-kpi-warn). */
  cardClass?: string;
  /** Carte accentuée (bordure + dégradé accent). */
  hl?: boolean;
};

export function Sim2Kpis(props: {
  cards: () => readonly Sim2KpiCard[];
  class?: string | undefined;
}): JSX.Element {
  return (
    <section class={`sim2-kpis${props.class ? ` ${props.class}` : ""}`}>
      <For each={props.cards()}>
        {(c) => (
          <div class={`sim2-kpi${c.hl ? " hl" : ""}${c.cardClass ? ` ${c.cardClass}` : ""}`}>
            <span class="sim2-kpi-label">{c.label}</span>
            <span class={`sim2-kpi-value${c.valueClass?.() ? ` ${c.valueClass?.()}` : ""}`}>
              {c.value()}
            </span>
            <Show when={c.sub}>
              <span class="sim2-kpi-sub" title={c.subTitle?.()}>
                {c.sub?.()}
              </span>
            </Show>
          </div>
        )}
      </For>
    </section>
  );
}