import { For, Show, createMemo, createSignal, createEffect } from "solid-js";
import type { JSX } from "solid-js";
import type { BotConfig } from "../../types";
import { api } from "../../api/client";
import {
  newChartRule,
  type ChartRule,
  type StrategyGraph,
} from "../../strategy-editor/graph-types";

/**
 * Éditeur simplifié de chartRules pour les stratégies custom (custom:*)
 * intégré dans le panel preset de la page backtest.
 * Permet de charger, modifier et sauvegarder les zones sans aller sur
 * la page éditeur complète.
 */
export function CustomStrategyEditor(props: {
  strategyId: string;
  onActivated?: (config: BotConfig) => void;
}): JSX.Element {
  const [graph, setGraph] = createSignal<StrategyGraph | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [saveMsg, setSaveMsg] = createSignal<string | null>(null);
  const [saveErr, setSaveErr] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal(false);

  const rules = createMemo(() => graph()?.chartRules ?? []);
  const graphName = createMemo(() => graph()?.name ?? props.strategyId);

  async function load(): Promise<void> {
    setLoading(true);
    setSaveErr(null);
    try {
      const res = await api.strategyGet(props.strategyId);
      setGraph(res.graph);
      setDirty(false);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function save(): Promise<void> {
    const g = graph();
    if (!g) return;
    setSaving(true);
    setSaveErr(null);
    setSaveMsg(null);
    try {
      const res = await api.strategyUpdate(g.id, g);
      setGraph(res.graph);
      setDirty(false);
      setSaveMsg("Stratégie sauvegardée");
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function activate(): Promise<void> {
    const g = graph();
    if (!g) return;
    setSaving(true);
    setSaveErr(null);
    setSaveMsg(null);
    try {
      const updated = await api.strategyUpdate(g.id, g);
      setGraph(updated.graph);
      const res = await api.strategyActivate(updated.graph.id);
      setDirty(false);
      setSaveMsg(`Activée : ${updated.graph.id}`);
      if (res.config && props.onActivated) {
        props.onActivated(res.config);
      }
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function patchRules(next: ChartRule[]): void {
    const g = graph();
    if (!g) return;
    setGraph({ ...g, chartRules: next });
    setDirty(true);
    setSaveMsg(null);
  }

  function patchRule(id: string, patch: Partial<ChartRule>): void {
    patchRules(rules().map((r: ChartRule) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRule(id: string): void {
    patchRules(rules().filter((r: ChartRule) => r.id !== id));
  }

  function addRule(): void {
    const rule = newChartRule({
      startSec: 0,
      endSec: Math.min(300, 900),
      token: "cheap",
      action: "buy",
      direction: "up",
      once: true,
    });
    patchRules([...rules(), rule]);
  }

  // Chargement initial + rechargement quand strategyId change.
  // createEffect fires on mount (initial load) and whenever strategyId changes.
  let lastLoadedId: string | null = null;
  createEffect(() => {
    const id = props.strategyId;
    if (id === lastLoadedId) return;
    lastLoadedId = id;
    void load();
  });

  return (
    <div class="bt-custom-editor">
      <Show when={loading()}>
        <p class="bt-runs-empty">Chargement de la stratégie…</p>
      </Show>
      <Show when={!loading() && saveErr() && !graph()}>
        <p class="err">{saveErr()}</p>
      </Show>
      <Show when={graph()}>
        <div class="bt-custom-header">
          <span class="bt-custom-name" title={props.strategyId}>{graphName()}</span>
          <div class="bt-custom-actions">
            <Show when={saveErr()}>
              <span class="err">{saveErr()}</span>
            </Show>
            <Show when={saveMsg()}>
              <span class="ok">{saveMsg()}</span>
            </Show>
            <Show when={dirty()}>
              <span class="bt-preset-dirty" title="Modifié — non sauvegardé">●</span>
            </Show>
            <button class="btn" type="button" disabled={saving()} onClick={() => void load()}>
              Recharger
            </button>
            <button class="btn" type="button" disabled={saving() || !dirty()} onClick={() => void save()}>
              {saving() ? "…" : "Sauver"}
            </button>
            <button class="btn btn-primary" type="button" disabled={saving()} onClick={() => void activate()}>
              Activer live
            </button>
          </div>
        </div>
        <div class="bt-custom-rules">
          <table class="bt-custom-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Action</th>
                <th>Token</th>
                <th>Début (s)</th>
                <th>Fin (s)</th>
                <th>Bande min</th>
                <th>Bande max</th>
                <th>Once</th>
                <th>Confirm</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <For each={rules()}>
                {(rule, i) => (
                  <tr>
                    <td class="bt-custom-idx">{i() + 1}</td>
                    <td>
                      <select
                        value={rule.action}
                        onChange={(e) => {
                          const action = e.currentTarget.value as ChartRule["action"];
                          patchRule(rule.id,
                            action === "sell"
                              ? { action, afterFill: rule.token }
                              : { action },
                          );
                        }}
                      >
                        <option value="buy">Buy</option>
                        <option value="sell">Sell</option>
                      </select>
                    </td>
                    <td>
                      <select
                        value={rule.token}
                        onChange={(e) => {
                          const token = e.currentTarget.value as ChartRule["token"];
                          patchRule(rule.id,
                            rule.action === "sell"
                              ? { token, afterFill: token }
                              : { token },
                          );
                        }}
                      >
                        <option value="cheap">Cheap</option>
                        <option value="favorite">Favori</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        max="900"
                        step="60"
                        value={rule.startSec}
                        onInput={(e) => patchRule(rule.id, { startSec: Number(e.currentTarget.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        max="900"
                        step="60"
                        value={rule.endSec}
                        onInput={(e) => patchRule(rule.id, { endSec: Number(e.currentTarget.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        placeholder="—"
                        value={rule.bandMin ?? ""}
                        onInput={(e) => {
                          const raw = e.currentTarget.value;
                          patchRule(rule.id, { bandMin: raw === "" ? undefined : Number(raw) });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        placeholder="—"
                        value={rule.bandMax ?? ""}
                        onInput={(e) => {
                          const raw = e.currentTarget.value;
                          patchRule(rule.id, { bandMax: raw === "" ? undefined : Number(raw) });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={rule.once !== false}
                        onChange={(e) => patchRule(rule.id, { once: e.currentTarget.checked })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="2"
                        step="1"
                        placeholder="—"
                        value={rule.confirmTicks ?? ""}
                        onInput={(e) => {
                          const raw = e.currentTarget.value;
                          patchRule(rule.id, { confirmTicks: raw === "" ? undefined : Number(raw) });
                        }}
                      />
                    </td>
                    <td>
                      <button
                        class="bt-custom-del"
                        type="button"
                        title="Supprimer cette zone"
                        onClick={() => removeRule(rule.id)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <button class="btn" type="button" onClick={() => addRule()}>
            + Zone
          </button>
        </div>
      </Show>
    </div>
  );
}