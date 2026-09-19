import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { simStats } from "../../stores/statsStore";
import { api } from "../../api/client";
import type { EngineStatsRow } from "../../types";
import { fmtUsd, pct } from "../../utils/format";

/**
 * Panneau Performance : vue globale (flux SSE `stats`, tous moteurs
 * confondus) ou vue filtrée sur un moteur (agrégation SQL par strategyId,
 * rafraîchie par polling REST).
 */
export function Performance(): JSX.Element {
  const GLOBAL = "__global__";
  const [selected, setSelected] = createSignal<string>(GLOBAL);
  const [engineRows, setEngineRows] = createSignal<EngineStatsRow[]>([]);

  const engines = createMemo(() => engineRows().map((r) => r.engine));
  const isGlobal = createMemo(() => selected() === GLOBAL);
  const selectedRow = createMemo(() =>
    engineRows().find((r) => r.engine === selected()),
  );

  async function refreshEngines(): Promise<void> {
    try {
      const { engines: rows } = await api.statsByEngine();
      setEngineRows(rows);
      // Le moteur sélectionné a disparu (reset DB) → retour au global.
      if (!isGlobal() && !rows.some((r) => r.engine === selected())) {
        setSelected(GLOBAL);
      }
    } catch {
      // Endpoint indisponible (backend ancien) : on garde le global.
      setEngineRows([]);
    }
  }
  void refreshEngines();

  return (
    <Panel title="Performance">
      <div class="perf-filter">
        <select
          class="perf-filter__select"
          value={selected()}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setSelected(value);
            if (value !== GLOBAL) void refreshEngines();
          }}
        >
          <option value={GLOBAL}>Global (tous moteurs)</option>
          <For each={engines()}>
            {(engine) => <option value={engine}>{engine}</option>}
          </For>
        </select>
      </div>
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
        <Show when={simStats()} fallback={<EmptyState text="En attente de données…" />}>
          {(s) => <GlobalTable s={s()} />}
        </Show>
      </Show>
    </Panel>
  );
}

/** Vue moteur : P&L + win/loss issus de l'agrégation SQL par strategyId. */
function EngineTable(props: { row: EngineStatsRow }): JSX.Element {
  // Accès réactif obligatoire : une capture eager (const r = props.row)
  // figerait les valeurs du premier moteur sélectionné.
  const r = () => props.row;
  const resolved = () => r().wins + r().losses;
  return (
    <table>
      <tbody>
        <tr>
          <td>P&L réalisé</td>
          <td class={r().realizedPnl >= 0 ? "ok" : "err"}>{fmtUsd(r().realizedPnl)}</td>
        </tr>
        <tr>
          <td>Exposition ouverte</td>
          <td>{fmtUsd(r().openExposure)}</td>
        </tr>
        <tr>
          <td>Positions ouvertes</td>
          <td>{r().openCount}</td>
        </tr>
        <tr>
          <td>Win rate</td>
          <td>
            {pct(resolved() > 0 ? r().wins / resolved() : 0)} ({r().wins}/
            {resolved()})
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Vue globale : table existante, inchangée. */
function GlobalTable(props: { s: NonNullable<ReturnType<typeof simStats>> }): JSX.Element {
  const s = () => props.s;
  return (
    <table>
      <tbody>
        <tr>
          <td>P&L réalisé</td>
          <td class={s().realizedPnl >= 0 ? "ok" : "err"}>
            {fmtUsd(s().realizedPnl)}
          </td>
        </tr>
        <tr>
          <td>— Arbitrage couvert</td>
          <td class={s().arbRealizedPnl >= 0 ? "ok" : "err"}>
            {fmtUsd(s().arbRealizedPnl)}
          </td>
        </tr>
        <tr>
          <td>— Directionnel non couvert</td>
          <td class={s().directionalRealizedPnl >= 0 ? "ok" : "err"}>
            {fmtUsd(s().directionalRealizedPnl)}
          </td>
        </tr>
        <tr>
          <td>Exposition ouverte</td>
          <td>{fmtUsd(s().openExposure)}</td>
        </tr>
        <tr>
          <td>— Couverte</td>
          <td>{fmtUsd(s().coveredExposure)}</td>
        </tr>
        <tr>
          <td>— Non couverte</td>
          <td>{fmtUsd(s().uncoveredExposure)}</td>
        </tr>
        <tr>
          <td>Positions ouvertes</td>
          <td>{s().openPositionsCount}</td>
        </tr>
        <tr>
          <td>Positions résolues</td>
          <td>{s().resolvedPositionsCount}</td>
        </tr>
        <tr>
          <td>Win rate</td>
          <td>
            {pct(s().winRate)} ({s().wins}/{s().wins + s().losses})
          </td>
        </tr>
        <tr>
          <td>Fill rate</td>
          <td>
            {pct(s().fillRate)} ({s().totalFilled}/{s().totalAttempted})
          </td>
        </tr>
        <tr>
          <td>Cover rate</td>
          <td>
            {pct(s().coverRate)} ({s().coveredCount}/
            {s().coveredCount + s().uncoveredCount})
          </td>
        </tr>
      </tbody>
    </table>
  );
}