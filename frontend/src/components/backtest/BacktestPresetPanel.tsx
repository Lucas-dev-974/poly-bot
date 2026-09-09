import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { ConfigFormState } from "../../utils/configForm";

type PresetTab = "cheap" | "hedge" | "edge" | "risk" | "window";

export function BacktestPresetPanel(props: {
  form: ConfigFormState | null;
  onUpdate: <K extends keyof ConfigFormState>(key: K, value: ConfigFormState[K]) => void;
  saving: boolean;
  saveMsg: string | null;
  saveErr: string | null;
  onSave: () => void;
  onLoadLive: () => void;
}): JSX.Element {
  const [tab, setTab] = createSignal<PresetTab>("cheap");
  const sid = createMemo(() => props.form?.strategyId ?? "arb");
  const tabs = createMemo((): Array<{ id: PresetTab; label: string }> => {
    if (sid() === "edge-lead") {
      return [
        { id: "edge", label: "Edge" },
        { id: "risk", label: "Risque" },
        { id: "window", label: "Fenêtre" },
      ];
    }
    return [
      { id: "cheap", label: "Cheap" },
      { id: "hedge", label: "Hedge" },
      { id: "risk", label: "Risque" },
      { id: "window", label: "Fenêtre" },
    ];
  });
  const active = createMemo(() => {
    const ids = tabs().map((t) => t.id);
    return ids.includes(tab()) ? tab() : ids[0];
  });

  return (
    <section class="bt-preset">
      <div class="bt-preset-bar">
        <span class="bt-preset-title">Preset run</span>
        <div class="bt-preset-tabs">
          <For each={tabs()}>
            {(t) => (
              <button
                type="button"
                class={`bt-preset-tab${active() === t.id ? " is-on" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>
        <div class="bt-preset-actions">
          <Show when={props.saveErr}>
            <span class="err">{props.saveErr}</span>
          </Show>
          <Show when={props.saveMsg}>
            <span class="ok">{props.saveMsg}</span>
          </Show>
          <button class="btn" type="button" onClick={props.onLoadLive}>
            Charger live
          </button>
          <button
            class="btn btn-primary"
            type="button"
            disabled={props.saving || !props.form}
            onClick={props.onSave}
          >
            {props.saving ? "…" : "Enregistrer preset"}
          </button>
        </div>
      </div>
      <Show when={props.form} fallback={<p class="bt-runs-empty">Config introuvable.</p>}>
        {(form) => (
          <div class="bt-preset-body">
            <Show when={active() === "cheap"}>
              <div class="bt-preset-grid">
                <Num label="Cheap min" value={form().cheapBuyMin} step={0.01} onInput={(v) => props.onUpdate("cheapBuyMin", v)} />
                <Num label="Cheap max" value={form().cheapBuyMax} step={0.01} onInput={(v) => props.onUpdate("cheapBuyMax", v)} />
                <Num label="Cheap USDC" value={form().cheapOrderUsdc} step={0.1} onInput={(v) => props.onUpdate("cheapOrderUsdc", v)} />
                <Num label="Pair lock" value={form().pairLockMax} step={0.01} onInput={(v) => props.onUpdate("pairLockMax", v)} />
              </div>
            </Show>
            <Show when={active() === "hedge"}>
              <div class="bt-preset-grid">
                <Num label="Hedge min" value={form().expensiveBuyMin} step={0.01} onInput={(v) => props.onUpdate("expensiveBuyMin", v)} />
                <Num label="Hedge max" value={form().expensiveBuyMax} step={0.01} onInput={(v) => props.onUpdate("expensiveBuyMax", v)} />
                <Num label="Hedge USDC" value={form().expensiveOrderUsdc} step={0.1} onInput={(v) => props.onUpdate("expensiveOrderUsdc", v)} />
                <label class="bt-pf">
                  <span>Type hedge</span>
                  <select
                    value={form().expensiveOrderType}
                    onChange={(e) => props.onUpdate("expensiveOrderType", e.currentTarget.value as "FOK" | "GTC")}
                  >
                    <option value="FOK">FOK</option>
                    <option value="GTC">GTC</option>
                  </select>
                </label>
                <Num label="Ratio hedge" value={form().barbellHedgeRatio} step={0.05} onInput={(v) => props.onUpdate("barbellHedgeRatio", v)} />
                <label class="bt-pf bt-pf-check">
                  <input
                    type="checkbox"
                    checked={form().enableExpensiveHedge}
                    onChange={(e) => props.onUpdate("enableExpensiveHedge", e.currentTarget.checked)}
                  />
                  Hedge on
                </label>
              </div>
            </Show>
            <Show when={active() === "edge"}>
              <div class="bt-preset-grid">
                <Num label="Edge min" value={form().edgeBandMin} step={0.01} onInput={(v) => props.onUpdate("edgeBandMin", v)} />
                <Num label="Edge max" value={form().edgeBandMax} step={0.01} onInput={(v) => props.onUpdate("edgeBandMax", v)} />
                <Num label="Confirm ticks" value={form().edgeConfirmSamples} step={1} onInput={(v) => props.onUpdate("edgeConfirmSamples", v)} />
                <Num label="Drop / tick" value={form().edgeMaxDownTick} step={0.001} onInput={(v) => props.onUpdate("edgeMaxDownTick", v)} />
                <Num label="Cheap min" value={form().edgeCheapBandMin} step={0.01} onInput={(v) => props.onUpdate("edgeCheapBandMin", v)} />
                <Num label="Cheap max" value={form().edgeCheapBandMax} step={0.01} onInput={(v) => props.onUpdate("edgeCheapBandMax", v)} />
                <Num label="Edge USDC" value={form().edgeOrderUsdc} step={1} onInput={(v) => props.onUpdate("edgeOrderUsdc", v)} />
                <Num label="Max shares edge" value={form().maxShareEdge} step={1} onInput={(v) => props.onUpdate("maxShareEdge", v)} />
                <Num label="Cheap USDC" value={form().edgeCheapOrderUsdc} step={1} onInput={(v) => props.onUpdate("edgeCheapOrderUsdc", v)} />
              </div>
            </Show>
            <Show when={active() === "risk"}>
              <div class="bt-preset-grid">
                <Num label="Max shares" value={form().maxSharesPerOrder} step={1} onInput={(v) => props.onUpdate("maxSharesPerOrder", v)} />
                <Num label="Max shares edge" value={form().maxShareEdge} step={1} onInput={(v) => props.onUpdate("maxShareEdge", v)} />
                <Num label="Max pos / côté" value={form().maxOpenPositionsPerSide} step={1} onInput={(v) => props.onUpdate("maxOpenPositionsPerSide", v)} />
                <Num label="Max expo USDC" value={form().maxExposureUsdc} step={1} onInput={(v) => props.onUpdate("maxExposureUsdc", v)} />
                <Num label="Capital sim" value={form().simulatedCapital} step={1} onInput={(v) => props.onUpdate("simulatedCapital", v)} />
                <label class="bt-pf bt-pf-wide">
                  <span>Préfixes live</span>
                  <input
                    type="text"
                    value={form().marketSlugPrefixes}
                    onInput={(e) => props.onUpdate("marketSlugPrefixes", e.currentTarget.value)}
                  />
                </label>
              </div>
            </Show>
            <Show when={active() === "window"}>
              <div class="bt-preset-grid">
                <Num label="Min avant close" value={form().minutesBeforeCloseMin} step={1} onInput={(v) => props.onUpdate("minutesBeforeCloseMin", v)} />
                <Num label="Max avant close" value={form().minutesBeforeCloseMax} step={1} onInput={(v) => props.onUpdate("minutesBeforeCloseMax", v)} />
                <Num label="Stop buy &lt; min" value={form().minMinutesBeforeCloseToBuy} step={1} onInput={(v) => props.onUpdate("minMinutesBeforeCloseToBuy", v)} />
              </div>
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}

function Num(props: {
  label: string;
  value: string;
  step: number;
  onInput: (v: string) => void;
}): JSX.Element {
  return (
    <label class="bt-pf">
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
    </label>
  );
}
