import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { EmptyState } from "../ui/EmptyState";
import { globalStats, engineRows, refreshEngineStats } from "../../stores/statsStore";
import type { EngineStatsRow } from "../../types";
import { fmtUsd, pct } from "../../utils/format";
import { Sim2Card } from "../ui/Sim2Card";
import { pnlClass } from "../../utils/display";

/**
 * Panneau Performance : vue globale (flux SSE `stats`, tous moteurs
 * confondus) ou vue filtrée sur un moteur (agrégation SQL par strategyId,
 * refresh REST au montage + au changement de sélection).
 */
export function Performance(): JSX.Element {
  const GLOBAL = "__global__";
  const [selected, setSelected] = createSignal<string>(GLOBAL);

  const engines = createMemo(() => engineRows().map((r) => r.engine));
  const isGlobal = createMemo(() => selected() === GLOBAL);
  const selectedRow = createMemo(() =>
    engineRows().find((r) => r.engine === selected()),
  );

  void refreshEngineStats();

  return (
    <Sim2Card
      title="Performance"
      tools={
        <select
          class="sim2-mini-select"
          value={selected()}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setSelected(value);
            if (value !== GLOBAL) void refreshEngineStats();
          }}
        >
          <option value={GLOBAL}>Global (tous moteurs)</option>
          <For each={engines()}>
            {(engine) => <option value={engine}>{engine}</option>}
          </For>
        </select>
      }
    >
      <Show
        when={isGlobal()}
        fallback={
          <Show
            when={selectedRow()}
            fallback={<EmptyState text="Aucune donnée pour ce moteur." />}
          >
            {(r) => <EngineTable row={r()} />}
          </Show>
        }
      >
        <Show when={globalStats()} fallback={<EmptyState text="En attente de données…" />}>
          {(s) => <GlobalTable s={s()} />}
        </Show>
      </Show>
    </Sim2Card>
  );
}

/** Vue moteur : P&L + win/loss issus de l'agrégation SQL par strategyId. */
function EngineTable(props: { row: EngineStatsRow }): JSX.Element {
  // Accès réactif obligatoire : une capture eager (const r = props.row)
  // figerait les valeurs du premier moteur sélectionné.
  const r = () => props.row;
  const resolved = () => r().wins + r().losses;
  return (
    <table class="sim2-table perf-kv">
      <tbody>
        <tr>
          <td>P&amp;L réalisé</td>
          <td class={`num ${pnlClass(r().realizedPnl)}`}>{fmtUsd(r().realizedPnl)}</td>
        </tr>
        <tr>
          <td>Exposition ouverte</td>
          <td class="num">{fmtUsd(r().openExposure)}</td>
        </tr>
        <tr>
          <td>Positions ouvertes</td>
          <td class="num">{r().openCount}</td>
        </tr>
        <tr>
          <td>Win rate</td>
          <td class="num">
            {pct(resolved() > 0 ? r().wins / resolved() : 0)} ({r().wins}/
            {resolved()})
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Vue globale : table existante, inchangée (habillage sim2). */
function GlobalTable(props: { s: NonNullable<ReturnType<typeof globalStats>> }): JSX.Element {
  const s = () => props.s;
  return (
    <table class="sim2-table perf-kv">
      <tbody>
        <tr>
          <td>P&amp;L réalisé</td>
          <td class={`num ${pnlClass(s().realizedPnl)}`}>
            {fmtUsd(s().realizedPnl)}
          </td>
        </tr>
        <tr>
          <td>— Arbitrage couvert</td>
          <td class={`num ${pnlClass(s().arbRealizedPnl)}`}>
            {fmtUsd(s().arbRealizedPnl)}
          </td>
        </tr>
        <tr>
          <td>— Directionnel non couvert</td>
          <td class={`num ${pnlClass(s().directionalRealizedPnl)}`}>
            {fmtUsd(s().directionalRealizedPnl)}
          </td>
        </tr>
        <tr>
          <td>Exposition ouverte</td>
          <td class="num">{fmtUsd(s().openExposure)}</td>
        </tr>
        <tr>
          <td>— Couverte</td>
          <td class="num">{fmtUsd(s().coveredExposure)}</td>
        </tr>
        <tr>
          <td>— Non couverte</td>
          <td class="num">{fmtUsd(s().uncoveredExposure)}</td>
        </tr>
        <tr>
          <td>Positions ouvertes</td>
          <td class="num">{s().openPositionsCount}</td>
        </tr>
        <tr>
          <td>Positions résolues</td>
          <td class="num">{s().resolvedPositionsCount}</td>
        </tr>
        <tr>
          <td>Win rate</td>
          <td class="num">
            {pct(s().winRate)} ({s().wins}/{s().wins + s().losses})
          </td>
        </tr>
        <tr>
          <td>Fill rate</td>
          <td class="num">
            {pct(s().fillRate)} ({s().totalFilled}/{s().totalAttempted})
          </td>
        </tr>
        <tr>
          <td>Cover rate</td>
          <td class="num">
            {pct(s().coverRate)} ({s().coveredCount}/
            {s().coveredCount + s().uncoveredCount})
          </td>
        </tr>
      </tbody>
    </table>
  );
}