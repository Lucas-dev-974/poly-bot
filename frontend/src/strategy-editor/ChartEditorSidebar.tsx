import { For, Show } from "solid-js";
import type { JSX } from "solid-js";

export type ChartWindowOption = {
  eventSlug: string;
  eventTitle: string;
  windowStart: number;
  windowEnd: number;
  ticks: number;
  live?: boolean;
};

function fmtClock(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function windowLabel(w: ChartWindowOption): string {
  const title = w.eventTitle || w.eventSlug;
  const time = fmtClock(w.windowStart);
  return w.live ? `${title} · ${time} · live` : `${title} · ${time}`;
}

export function ChartEditorSidebar(props: {
  name: string;
  leadsWithEdge: boolean;
  windows: ChartWindowOption[];
  engines: Array<{ id: string; name: string; native: boolean }>;
  selectedSlug: string | null;
  selectedStrategyId: string | null;
  onName: (name: string) => void;
  onLeadsWithEdge: (v: boolean) => void;
  onLoadWindow: (w: ChartWindowOption) => void;
  onClearWindow: () => void;
  onLoadStrategy: (id: string) => void;
  onNewStrategy: () => void;
}): JSX.Element {
  return (
    <aside class="se-palette se-chart-sidebar">
      <h3>Stratégie</h3>
      <label class="se-field">
        Nom
        <input
          class="se-name"
          type="text"
          value={props.name}
          onInput={(e) => props.onName(e.currentTarget.value)}
        />
      </label>
      <label class="se-field">
        Enregistrée
        <select
          value={props.selectedStrategyId ?? ""}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v === "__new__") props.onNewStrategy();
            else if (v) props.onLoadStrategy(v);
          }}
        >
          <option value="">Brouillon</option>
          <option value="__new__">Nouvelle</option>
          <For each={props.engines.filter((e) => !e.native)}>
            {(e) => (
              <option value={e.id}>{e.name || e.id}</option>
            )}
          </For>
        </select>
      </label>
      <label class="se-field">
        Marché
        <select
          value={props.selectedSlug ?? ""}
          onChange={(e) => {
            const slug = e.currentTarget.value;
            if (!slug) {
              props.onClearWindow();
              return;
            }
            const w = props.windows.find((row) => row.eventSlug === slug);
            if (w) props.onLoadWindow(w);
          }}
        >
          <option value="">Axe 0–15 min</option>
          <For each={props.windows}>
            {(w) => (
              <option value={w.eventSlug}>{windowLabel(w)}</option>
            )}
          </For>
        </select>
      </label>
      <Show when={props.windows.length === 0}>
        <p class="se-hint">Aucun marché. Le bot doit scanner, ou un live watching apparaîtra ici.</p>
      </Show>
      <details class="se-advanced">
        <summary>Avancé</summary>
        <label class="se-check">
          <input
            type="checkbox"
            checked={props.leadsWithEdge}
            onChange={(e) => props.onLeadsWithEdge(e.currentTarget.checked)}
          />
          Edge d’abord
        </label>
        <p class="se-hint">
          Plomberie bot (GTC, tri favori, skip C2). Requis pour acheter/vendre le favori.
          Les zones « vendre cheap » ne s’exécutent pas.
        </p>
      </details>
      <p class="se-hint">
        Rectangle = bande prix (snap 0.01). Poignées = redimensionner. Alt + glisser = déplacer
        la bande. Point droit d’une zone vers une autre = lien (1→2 et 1→3). Ctrl+Z annule.
      </p>
    </aside>
  );
}
