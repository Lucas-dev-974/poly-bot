import { For, Show, type Accessor, type Setter } from "solid-js";
import type { JSX } from "solid-js";
import type { StrategyEngineSummary } from "../../api/client";
import {
  type AnyPreset,
  type StrategyId,
} from "../../config/strategyPresets";
import { EngineSelect, PresetSelect } from "../strategy/EnginePresetSelects";
import type { BacktestProgress } from "../../types";
import type { ConfigFormState } from "../../utils/configForm";

type Props = {
  dateKey: Accessor<string>;
  setDateKey: Setter<string>;
  dates: Accessor<string[]>;
  timeframe: Accessor<string>;
  setTimeframe: (v: string) => void;
  timeframes: Accessor<string[]>;
  prefix: Accessor<string>;
  setPrefix: Setter<string>;
  prefixesForTimeframe: Accessor<string[]>;
  completeOnly: Accessor<boolean>;
  setCompleteOnly: Setter<boolean>;
  minTicksOn: Accessor<boolean>;
  setMinTicksOn: Setter<boolean>;
  minTicks: Accessor<string>;
  setMinTicks: Setter<string>;
  maxGapOn: Accessor<boolean>;
  setMaxGapOn: Setter<boolean>;
  maxGapSec: Accessor<string>;
  setMaxGapSec: Setter<string>;
  edgeOn: Accessor<boolean>;
  setEdgeOn: Setter<boolean>;
  edgeSec: Accessor<string>;
  setEdgeSec: Setter<string>;
  cutGaps: Accessor<boolean>;
  setCutGaps: Setter<boolean>;
  walletOn: Accessor<boolean>;
  setWalletOn: Setter<boolean>;
  walletConfigured: Accessor<boolean | undefined>;
  walletLoading: Accessor<boolean>;
  walletMarksCount: Accessor<number>;
  lowerLowsLoading: Accessor<boolean>;
  filteredCount: Accessor<number>;
  onAnalyzeLowerLows: () => void;
  onReloadWindows: () => void;
  onReloadWindowsSoon: () => void;
  engine: Accessor<StrategyId>;
  customEngines: Accessor<StrategyEngineSummary[]>;
  presetId: Accessor<string>;
  presets: Accessor<AnyPreset[]>;
  onEngineChange: (id: StrategyId) => void;
  onPresetChange: (id: string) => void;
  progress: Accessor<BacktestProgress | null>;
  form: Accessor<ConfigFormState | null>;
  hasInlineErrors: Accessor<boolean>;
  onLaunch: () => void;
};

export function BacktestFilterBar(props: Props): JSX.Element {
  return (
    <div class="bt-toolbar">
      <label>
        Date
        <select value={props.dateKey()} onChange={(e) => props.setDateKey(e.currentTarget.value)}>
          <option value="all">Toutes</option>
          <For each={props.dates()}>{(d) => <option value={d}>{d}</option>}</For>
        </select>
      </label>
      <label title="Durée de fenêtre (dérivée des données enregistrées)">
        Timeframe
        <select
          value={props.timeframe()}
          onChange={(e) => {
            props.setTimeframe(e.currentTarget.value);
            props.setPrefix("");
          }}
        >
          <option value="">Tous</option>
          <For each={props.timeframes()}>{(tf) => <option value={tf}>{tf}</option>}</For>
        </select>
      </label>
      <label>
        Marché
        <select value={props.prefix()} onChange={(e) => props.setPrefix(e.currentTarget.value)}>
          <option value="">Tous</option>
          <For each={props.prefixesForTimeframe()}>{(p) => <option value={p}>{p}</option>}</For>
        </select>
      </label>
      <label class="bt-check" title="Ne garder que les fenêtres qui passent les règles ci-contre">
        <input
          type="checkbox"
          checked={props.completeOnly()}
          onChange={(e) => {
            props.setCompleteOnly(e.currentTarget.checked);
            props.onReloadWindows();
          }}
        />
        Complets
      </label>
      <div class="bt-rules">
        <label
          class={`bt-rule${props.minTicksOn() ? "" : " is-off"}`}
          title="Minimum de ticks (les deux outcomes) dans la fenêtre"
        >
          <input
            type="checkbox"
            checked={props.minTicksOn()}
            onChange={(e) => {
              props.setMinTicksOn(e.currentTarget.checked);
              props.onReloadWindows();
            }}
          />
          Ticks
          <input
            type="number"
            min="1"
            max="900"
            step="1"
            value={props.minTicks()}
            disabled={!props.minTicksOn()}
            onInput={(e) => {
              props.setMinTicks(e.currentTarget.value);
              props.onReloadWindowsSoon();
            }}
          />
        </label>
        <label
          class={`bt-rule${props.maxGapOn() ? "" : " is-off"}`}
          title="Écart max entre deux ticks successifs"
        >
          <input
            type="checkbox"
            checked={props.maxGapOn()}
            onChange={(e) => {
              props.setMaxGapOn(e.currentTarget.checked);
              props.onReloadWindows();
            }}
          />
          Trou
          <input
            type="number"
            min="0.5"
            max="900"
            step="0.5"
            value={props.maxGapSec()}
            disabled={!props.maxGapOn()}
            onInput={(e) => {
              props.setMaxGapSec(e.currentTarget.value);
              props.onReloadWindowsSoon();
            }}
          />
          s
        </label>
        <label
          class={`bt-rule${props.edgeOn() ? "" : " is-off"}`}
          title="Premier / dernier tick à moins de N secondes des bords de fenêtre"
        >
          <input
            type="checkbox"
            checked={props.edgeOn()}
            onChange={(e) => {
              props.setEdgeOn(e.currentTarget.checked);
              props.onReloadWindows();
            }}
          />
          Bords
          <input
            type="number"
            min="0.5"
            max="900"
            step="0.5"
            value={props.edgeSec()}
            disabled={!props.edgeOn()}
            onInput={(e) => {
              props.setEdgeSec(e.currentTarget.value);
              props.onReloadWindowsSoon();
            }}
          />
          s
        </label>
      </div>
      <label class="bt-check" title="Couper les courbes sur les trous">
        <input
          type="checkbox"
          checked={props.cutGaps()}
          onChange={(e) => props.setCutGaps(e.currentTarget.checked)}
        />
        Trous
      </label>
      <label
        class="bt-check"
        title={
          props.walletConfigured() === false
            ? "FUNDER_ADDRESS manquant — pas de wallet à interroger"
            : "Afficher les fills Data API du wallet sur le graphique"
        }
      >
        <input
          type="checkbox"
          checked={props.walletOn()}
          disabled={props.walletConfigured() === false}
          onChange={(e) => props.setWalletOn(e.currentTarget.checked)}
        />
        Wallet
        <Show when={props.walletOn()}>
          <span class="bt-wallet-count">{props.walletLoading() ? "…" : props.walletMarksCount()}</span>
        </Show>
      </label>
      <button
        class="btn"
        type="button"
        disabled={props.lowerLowsLoading() || props.filteredCount() === 0}
        onClick={() => props.onAnalyzeLowerLows()}
        title="Analyser les lower-lows sur les marchés affichés"
      >
        {props.lowerLowsLoading() ? "Lower-lows…" : "Analyser Lower-lows"}
      </button>
      <label>
        Moteur
        <EngineSelect
          value={props.engine()}
          onChange={(id) => props.onEngineChange(id)}
          customEngines={props.customEngines()}
        />
      </label>
      <label>
        Preset
        <PresetSelect
          value={props.presetId()}
          onChange={(id) => props.onPresetChange(id)}
          presets={props.presets()}
          emptyLabel="Personnalisé"
        />
      </label>
      <button
        class="btn"
        type="button"
        disabled={
          props.progress()?.status === "running" ||
          (props.completeOnly() && props.filteredCount() === 0) ||
          !props.form() ||
          props.hasInlineErrors()
        }
        onClick={() => props.onLaunch()}
        title={props.hasInlineErrors() ? "Corrigez les erreurs de validation avant de lancer" : "Ctrl+Enter"}
      >
        Lancer
      </button>
    </div>
  );
}