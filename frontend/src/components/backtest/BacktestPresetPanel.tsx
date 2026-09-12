import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { BotConfig } from "../../types";
import type { ConfigFormState } from "../../utils/configForm";
import { CustomStrategyEditor } from "./CustomStrategyEditor";

type PresetTab = "cheap" | "hedge" | "edge" | "risk" | "window" | "zones";

export function BacktestPresetPanel(props: {
  form: ConfigFormState | null;
  onUpdate: <K extends keyof ConfigFormState>(key: K, value: ConfigFormState[K]) => void;
  saving: boolean;
  saveMsg: string | null;
  saveErr: string | null;
  onSave: () => void;
  onLoadLive: () => void;
  onResetPreset: () => void;
  fieldErrors: Partial<Record<keyof ConfigFormState, string>>;
  isDirty: boolean;
  presetDescription: () => string | null;
  presetName: () => string | null;
  isUserPreset: boolean;
  onSavePreset: () => void;
  onDeletePreset: () => void;
  onOpenEditor: () => void;
  onStrategyActivated: (config: BotConfig) => void;
}): JSX.Element {
  const [tab, setTab] = createSignal<PresetTab>("cheap");
  const [showDesc, setShowDesc] = createSignal(false);
  const sid = createMemo(() => props.form?.strategyId ?? "arb");
  const isCustom = createMemo(() => sid().startsWith("custom:"));
  const tabs = createMemo((): Array<{ id: PresetTab; label: string }> => {
    if (isCustom()) {
      return [
        { id: "zones", label: "Zones" },
        { id: "edge", label: "Edge" },
        { id: "risk", label: "Risque" },
        { id: "window", label: "Fenêtre" },
      ];
    }
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

  const tabErrorCount = createMemo((): Record<PresetTab, number> => {
    const fe = props.fieldErrors;
    const counts: Record<PresetTab, number> = { cheap: 0, hedge: 0, edge: 0, risk: 0, window: 0, zones: 0 };
    const cheapKeys: Array<keyof ConfigFormState> = ["cheapBuyMin", "cheapBuyMax", "cheapOrderUsdc", "pairLockMax"];
    const hedgeKeys: Array<keyof ConfigFormState> = ["expensiveBuyMin", "expensiveBuyMax", "expensiveOrderUsdc", "expensiveOrderType", "barbellHedgeRatio", "enableExpensiveHedge", "requireCheapFillBeforeExpensive"];
    const edgeKeys: Array<keyof ConfigFormState> = ["edgeBandMin", "edgeBandMax", "edgeConfirmSamples", "edgeMaxDownTick", "edgeCheapBandMin", "edgeCheapBandMax", "edgeSizingMode", "edgeSharesEdge", "edgeSharesCheap", "edgeOrderUsdc", "maxShareEdge", "edgeCheapOrderUsdc", "edgeSellExpensiveEnabled", "edgeSellExpensiveAfterMin", "edgeSellExpensiveLossPct", "edgeSellExpensiveLossWindowMs"];
    const riskKeys: Array<keyof ConfigFormState> = ["maxSharesPerOrder", "maxShareEdge", "maxOpenPositionsPerSide", "maxExposureUsdc", "simulatedCapital", "marketSlugPrefixes", "pollIntervalMs"];
    const windowKeys: Array<keyof ConfigFormState> = ["minutesBeforeCloseMin", "minutesBeforeCloseMax", "minMinutesBeforeCloseToBuy"];
    for (const k of cheapKeys) if (fe[k]) counts.cheap++;
    for (const k of hedgeKeys) if (fe[k]) counts.hedge++;
    for (const k of edgeKeys) if (fe[k]) counts.edge++;
    for (const k of riskKeys) if (fe[k]) counts.risk++;
    for (const k of windowKeys) if (fe[k]) counts.window++;
    return counts;
  });

  return (
    <section class="bt-preset">
      <div class="bt-preset-bar">
        <span class="bt-preset-title">
          Preset run
          <Show when={props.isDirty}>
            <span class="bt-preset-dirty" title="Config modifiée — non sauvegardée dans un preset">●</span>
          </Show>
        </span>
        <div class="bt-preset-tabs">
          <For each={tabs()}>
            {(t) => (
              <button
                type="button"
                class={`bt-preset-tab${active() === t.id ? " is-on" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                <Show when={tabErrorCount()[t.id] > 0}>
                  <span class="bt-preset-tab-err" title={`${tabErrorCount()[t.id]} erreur(s)`}>
                    {tabErrorCount()[t.id]}
                  </span>
                </Show>
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
          <Show when={props.presetDescription()}>
            <button
              type="button"
              class="bt-preset-info-btn"
              title={props.presetDescription() ?? ""}
              onClick={() => setShowDesc(!showDesc())}
            >
              ?
            </button>
          </Show>
          <Show when={props.presetName()}>
            <button class="btn" type="button" onClick={props.onResetPreset} disabled={!props.isDirty}>
              ↺ Reset
            </button>
          </Show>
          <button class="btn" type="button" onClick={props.onLoadLive}>
            Charger live
          </button>
          <Show when={isCustom()}>
            <button
              class="btn"
              type="button"
              onClick={props.onOpenEditor}
              title="Ouvrir l'éditeur de stratégie complet (graphique, replay, dependencies)"
            >
              Éditeur ↗
            </button>
          </Show>
          <button
            class="btn"
            type="button"
            onClick={props.onSavePreset}
            disabled={!props.form}
            title="Sauvegarder comme preset réutilisable (localStorage)"
          >
            ⬇ Preset
          </button>
          <Show when={props.isUserPreset}>
            <button
              class="btn btn-danger"
              type="button"
              onClick={props.onDeletePreset}
              title="Supprimer ce preset utilisateur"
            >
              🗑
            </button>
          </Show>
          <button
            class="btn btn-primary"
            type="button"
            disabled={props.saving || !props.form}
            onClick={props.onSave}
          >
            {props.saving ? "…" : "→ Live"}
          </button>
        </div>
      </div>

      <Show when={showDesc() && props.presetDescription()}>
        <div class="bt-preset-desc">{props.presetDescription()}</div>
      </Show>

      <Show when={props.form} fallback={<p class="bt-runs-empty">Config introuvable.</p>}>
        {(form) => (
          <div class="bt-preset-body">
            <Show when={active() === "cheap"}>
              <div class="bt-preset-grid">
                <Num label="Cheap min" value={form().cheapBuyMin} step={0.01} err={props.fieldErrors.cheapBuyMin} onInput={(v) => props.onUpdate("cheapBuyMin", v)} />
                <Num label="Cheap max" value={form().cheapBuyMax} step={0.01} err={props.fieldErrors.cheapBuyMax} onInput={(v) => props.onUpdate("cheapBuyMax", v)} />
                <Num label="Cheap USDC" value={form().cheapOrderUsdc} step={0.1} err={props.fieldErrors.cheapOrderUsdc} onInput={(v) => props.onUpdate("cheapOrderUsdc", v)} />
                <Show when={sid() !== "reverse"}>
                  <Num label="Pair lock" value={form().pairLockMax} step={0.01} err={props.fieldErrors.pairLockMax} onInput={(v) => props.onUpdate("pairLockMax", v)} />
                </Show>
              </div>
            </Show>
            <Show when={active() === "hedge"}>
              <div class="bt-preset-grid">
                <Num label="Hedge min" value={form().expensiveBuyMin} step={0.01} err={props.fieldErrors.expensiveBuyMin} onInput={(v) => props.onUpdate("expensiveBuyMin", v)} />
                <Num label="Hedge max" value={form().expensiveBuyMax} step={0.01} err={props.fieldErrors.expensiveBuyMax} onInput={(v) => props.onUpdate("expensiveBuyMax", v)} />
                <Num label="Hedge USDC" value={form().expensiveOrderUsdc} step={0.1} err={props.fieldErrors.expensiveOrderUsdc} onInput={(v) => props.onUpdate("expensiveOrderUsdc", v)} />
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
                <Show when={sid() !== "reverse"}>
                  <Num label="Ratio hedge" value={form().barbellHedgeRatio} step={0.05} err={props.fieldErrors.barbellHedgeRatio} onInput={(v) => props.onUpdate("barbellHedgeRatio", v)} />
                </Show>
                <label class="bt-pf bt-pf-check">
                  <input
                    type="checkbox"
                    checked={form().enableExpensiveHedge}
                    onChange={(e) => props.onUpdate("enableExpensiveHedge", e.currentTarget.checked)}
                  />
                  Hedge on
                </label>
                <Show when={sid() === "reverse"}>
                  <label class="bt-pf bt-pf-check">
                    <input
                      type="checkbox"
                      checked={form().requireCheapFillBeforeExpensive}
                      onChange={(e) => props.onUpdate("requireCheapFillBeforeExpensive", e.currentTarget.checked)}
                    />
                    Expensive après cheap fill
                  </label>
                </Show>
              </div>
            </Show>
            <Show when={active() === "edge"}>
              <Show when={isCustom()}>
                <p class="bt-preset-hint">
                  Ces valeurs sont les <strong>fallbacks</strong> utilisés quand une zone
                  (onglet Zones) ne définit pas explicitement <code>sizeUsdc</code>,{" "}
                  <code>confirmTicks</code> ou <code>maxDownTick</code>.
                </p>
              </Show>
              <div class="bt-preset-grid">
                <Num label="Edge min" value={form().edgeBandMin} step={0.01} err={props.fieldErrors.edgeBandMin} onInput={(v) => props.onUpdate("edgeBandMin", v)} />
                <Num label="Edge max" value={form().edgeBandMax} step={0.01} err={props.fieldErrors.edgeBandMax} onInput={(v) => props.onUpdate("edgeBandMax", v)} />
                <Num label="Confirm ticks" value={form().edgeConfirmSamples} step={1} err={props.fieldErrors.edgeConfirmSamples} onInput={(v) => props.onUpdate("edgeConfirmSamples", v)} />
                <Num label="Drop / tick" value={form().edgeMaxDownTick} step={0.001} err={props.fieldErrors.edgeMaxDownTick} onInput={(v) => props.onUpdate("edgeMaxDownTick", v)} />
                <Num label="Cheap min" value={form().edgeCheapBandMin} step={0.01} err={props.fieldErrors.edgeCheapBandMin} onInput={(v) => props.onUpdate("edgeCheapBandMin", v)} />
                <Num label="Cheap max" value={form().edgeCheapBandMax} step={0.01} err={props.fieldErrors.edgeCheapBandMax} onInput={(v) => props.onUpdate("edgeCheapBandMax", v)} />
                <label class="bt-pf bt-pf-wide">
                  <span>Mode sizing</span>
                  <select
                    value={form().edgeSizingMode}
                    onChange={(e) =>
                      props.onUpdate(
                        "edgeSizingMode",
                        e.currentTarget.value as ConfigFormState["edgeSizingMode"],
                      )
                    }
                  >
                    <option value="dynamic">Dynamique (budgets USDC)</option>
                    <option value="pusd">pUSD (budget USDC fixe)</option>
                    <option value="shares">Shares (nombre fixe)</option>
                  </select>
                </label>
                <Show when={form().edgeSizingMode === "shares"}>
                  <Num label="Shares edge" value={form().edgeSharesEdge} step={1} err={props.fieldErrors.edgeSharesEdge} onInput={(v) => props.onUpdate("edgeSharesEdge", v)} />
                  <Num label="Shares cheap" value={form().edgeSharesCheap} step={1} err={props.fieldErrors.edgeSharesCheap} onInput={(v) => props.onUpdate("edgeSharesCheap", v)} />
                </Show>
                <Show when={form().edgeSizingMode !== "shares"}>
                  <Num label="Edge USDC" value={form().edgeOrderUsdc} step={1} err={props.fieldErrors.edgeOrderUsdc} onInput={(v) => props.onUpdate("edgeOrderUsdc", v)} />
                  <Num label="Max shares edge" value={form().maxShareEdge} step={1} err={props.fieldErrors.maxShareEdge} onInput={(v) => props.onUpdate("maxShareEdge", v)} />
                  <Num label="Cheap USDC" value={form().edgeCheapOrderUsdc} step={1} err={props.fieldErrors.edgeCheapOrderUsdc} onInput={(v) => props.onUpdate("edgeCheapOrderUsdc", v)} />
                </Show>
                <label class="bt-pf bt-pf-wide">
                  <span>Vendre l'edge si perte</span>
                  <input
                    type="checkbox"
                    checked={form().edgeSellExpensiveEnabled}
                    onChange={(e) => props.onUpdate("edgeSellExpensiveEnabled", e.currentTarget.checked)}
                  />
                </label>
                <Show when={form().edgeSellExpensiveEnabled}>
                  <Num label="Vente après (min)" value={form().edgeSellExpensiveAfterMin} step={1} err={props.fieldErrors.edgeSellExpensiveAfterMin} onInput={(v) => props.onUpdate("edgeSellExpensiveAfterMin", v)} />
                  <Num label="Perte (%)" value={form().edgeSellExpensiveLossPct} step={1} err={props.fieldErrors.edgeSellExpensiveLossPct} onInput={(v) => props.onUpdate("edgeSellExpensiveLossPct", v)} />
                  <Num label="Fenêtre perte (ms)" value={form().edgeSellExpensiveLossWindowMs} step={100} err={props.fieldErrors.edgeSellExpensiveLossWindowMs} onInput={(v) => props.onUpdate("edgeSellExpensiveLossWindowMs", v)} />
                </Show>
              </div>
            </Show>
            <Show when={active() === "risk"}>
              <div class="bt-preset-grid">
                <Num label="Max shares" value={form().maxSharesPerOrder} step={1} err={props.fieldErrors.maxSharesPerOrder} onInput={(v) => props.onUpdate("maxSharesPerOrder", v)} />
                <Num label="Max shares edge" value={form().maxShareEdge} step={1} err={props.fieldErrors.maxShareEdge} onInput={(v) => props.onUpdate("maxShareEdge", v)} />
                <Num label="Max pos / côté" value={form().maxOpenPositionsPerSide} step={1} err={props.fieldErrors.maxOpenPositionsPerSide} onInput={(v) => props.onUpdate("maxOpenPositionsPerSide", v)} />
                <Num label="Max expo USDC" value={form().maxExposureUsdc} step={1} err={props.fieldErrors.maxExposureUsdc} onInput={(v) => props.onUpdate("maxExposureUsdc", v)} />
                <Num label="Capital sim" value={form().simulatedCapital} step={1} err={props.fieldErrors.simulatedCapital} onInput={(v) => props.onUpdate("simulatedCapital", v)} />
                <Num label="Poll (ms)" value={form().pollIntervalMs} step={100} err={props.fieldErrors.pollIntervalMs} onInput={(v) => props.onUpdate("pollIntervalMs", v)} />
                <Num label="Fill prob" value={form().simFillProbabilityNonMarketable} step={0.05} err={props.fieldErrors.simFillProbabilityNonMarketable} onInput={(v) => props.onUpdate("simFillProbabilityNonMarketable", v)} />
                <Num label="Resolve delay (s)" value={form().simResolveDelaySeconds} step={1} err={props.fieldErrors.simResolveDelaySeconds} onInput={(v) => props.onUpdate("simResolveDelaySeconds", v)} />
                <Num label="Resolve retry (ms)" value={form().simResolveRetryIntervalMs} step={500} err={props.fieldErrors.simResolveRetryIntervalMs} onInput={(v) => props.onUpdate("simResolveRetryIntervalMs", v)} />
                <Num label="Resolve max retries" value={form().simResolveMaxRetries} step={1} err={props.fieldErrors.simResolveMaxRetries} onInput={(v) => props.onUpdate("simResolveMaxRetries", v)} />
                <Num label="Max retry attempts" value={form().simMaxRetryAttempts} step={1} err={props.fieldErrors.simMaxRetryAttempts} onInput={(v) => props.onUpdate("simMaxRetryAttempts", v)} />
                <Text label="Seed (vide = aléa)" value={form().simRandomSeed} err={props.fieldErrors.simRandomSeed} onInput={(v) => props.onUpdate("simRandomSeed", v)} />
                <label class="bt-pf bt-pf-wide">
                  <span>Resolve fallback</span>
                  <select
                    value={form().simResolveFallback}
                    onChange={(e) => props.onUpdate("simResolveFallback", e.currentTarget.value as "none" | "probabilistic")}
                  >
                    <option value="none">none</option>
                    <option value="probabilistic">probabilistic</option>
                  </select>
                </label>
                <label class="bt-pf bt-pf-check">
                  <input
                    type="checkbox"
                    checked={form().simRequireCoveredPair}
                    onChange={(e) => props.onUpdate("simRequireCoveredPair", e.currentTarget.checked)}
                  />
                  Covered pair required
                </label>
                <label class="bt-pf bt-pf-wide">
                  <span>Préfixes live</span>
                  <input
                    type="text"
                    value={form().marketSlugPrefixes}
                    class={props.fieldErrors.marketSlugPrefixes ? " is-err" : ""}
                    onInput={(e) => props.onUpdate("marketSlugPrefixes", e.currentTarget.value)}
                  />
                </label>
                <Show when={props.fieldErrors.marketSlugPrefixes}>
                  <span class="bt-pf-err">{props.fieldErrors.marketSlugPrefixes}</span>
                </Show>
              </div>
            </Show>
            <Show when={active() === "window"}>
              <div class="bt-preset-grid">
                <Num label="Min avant close" value={form().minutesBeforeCloseMin} step={1} err={props.fieldErrors.minutesBeforeCloseMin} onInput={(v) => props.onUpdate("minutesBeforeCloseMin", v)} />
                <Num label="Max avant close" value={form().minutesBeforeCloseMax} step={1} err={props.fieldErrors.minutesBeforeCloseMax} onInput={(v) => props.onUpdate("minutesBeforeCloseMax", v)} />
                <Num label="Stop buy < min" value={form().minMinutesBeforeCloseToBuy} step={1} err={props.fieldErrors.minMinutesBeforeCloseToBuy} onInput={(v) => props.onUpdate("minMinutesBeforeCloseToBuy", v)} />
              </div>
            </Show>
            <Show when={active() === "zones" && isCustom()}>
              <CustomStrategyEditor
                strategyId={sid()}
                onActivated={(config) => props.onStrategyActivated(config)}
              />
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
  err?: string;
  onInput: (v: string) => void;
}): JSX.Element {
  return (
    <label class="bt-pf">
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step}
        value={props.value}
        class={props.err ? " is-err" : ""}
        title={props.err ?? ""}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      <Show when={props.err}>
        <span class="bt-pf-err">{props.err}</span>
      </Show>
    </label>
  );
}

function Text(props: {
  label: string;
  value: string;
  err?: string;
  onInput: (v: string) => void;
}): JSX.Element {
  return (
    <label class="bt-pf">
      <span>{props.label}</span>
      <input
        type="text"
        value={props.value}
        class={props.err ? " is-err" : ""}
        title={props.err ?? ""}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      <Show when={props.err}>
        <span class="bt-pf-err">{props.err}</span>
      </Show>
    </label>
  );
}