import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import {
  DEFAULT_CHART_DURATION_SEC,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_MIN_SLOPE,
  chartRuleIndexLabel,
  chartRuleLegend,
  linkChartRules,
  newChartRule,
  snapChartBand,
  snapChartRange,
  stripDependsOn,
  uniqueDependsOn,
  unlinkChartRules,
  type ChartRule,
} from "./graph-types";

export function ChartRulePanel(props: {
  rules: ChartRule[];
  selectedId: string | null;
  durationSec: number;
  onChange: (rules: ChartRule[]) => void;
  onSelect: (id: string | null) => void;
  onApplyEdgeLead?: () => void;
  onLinkRejected?: (message: string) => void;
}): JSX.Element {
  const selected = () => props.rules.find((r) => r.id === props.selectedId) ?? null;

  const patchSelected = (patch: Partial<ChartRule>) => {
    const id = props.selectedId;
    if (!id) return;
    props.onChange(
      props.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  };

  const snapSelected = () => {
    const rule = selected();
    if (!rule) return;
    patchSelected(snapChartRange(rule.startSec, rule.endSec, props.durationSec));
  };

  const snapBandSelected = () => {
    const rule = selected();
    if (!rule || (rule.bandMin == null && rule.bandMax == null)) return;
    patchSelected(snapChartBand(rule.bandMin ?? 0, rule.bandMax ?? 1));
  };

  const addBand = () => {
    const rule = selected();
    if (!rule) return;
    const mid = rule.token === "favorite" ? 0.875 : 0.09;
    const half = rule.token === "favorite" ? 0.025 : 0.05;
    patchSelected(snapChartBand(mid - half, mid + half));
  };

  const clearBand = () => {
    patchSelected({
      bandMin: undefined,
      bandMax: undefined,
      confirmTicks: undefined,
      maxDownTick: undefined,
    });
  };

  const remove = (id: string) => {
    props.onChange(stripDependsOn(props.rules, id));
    if (props.selectedId === id) props.onSelect(null);
  };

  const toggleParent = (parentId: string, on: boolean) => {
    const id = props.selectedId;
    if (!id) return;
    if (on) {
      const next = linkChartRules(props.rules, parentId, id);
      if (next) props.onChange(next);
      else {
        props.onLinkRejected?.(
          "Lien refusé : ce parent créerait un cycle.",
        );
      }
      return;
    }
    props.onChange(unlinkChartRules(props.rules, parentId, id));
  };

  const addPreset = () => {
    const rule = newChartRule({
      startSec: 0,
      endSec: Math.min(300, props.durationSec),
    });
    props.onChange([...props.rules, rule]);
    props.onSelect(rule.id);
  };

  return (
    <aside class="se-props se-chart-props">
      <h3>Règle</h3>
      <p class="se-hint">
        Fenêtre 0–{Math.round(props.durationSec / 60)} min. Glisser un rectangle = bande de
        prix. Alt + glisser une bande = la déplacer. Trait horizontal = zone temps (pente).
        Point droit → autre zone = lien nœud (ex. 1→2 et 1→3). Clic flèche + Suppr pour
        détacher. Preset Edge-lead = confirmation favori, cheap après fill, vente à perte.
      </p>
      <div class="se-chart-preset-row">
        <button type="button" class="btn" onClick={addPreset}>
          Zone 0–5 min
        </button>
        <Show when={props.onApplyEdgeLead}>
          <button type="button" class="btn" onClick={() => props.onApplyEdgeLead?.()}>
            Preset Edge-lead
          </button>
        </Show>
      </div>
      <Show
        when={selected()}
        fallback={<p class="se-hint">Sélectionnez une zone ou glissez sur le graphique.</p>}
      >
        {(rule) => (
          <>
            <label class="se-field">
              Début (s)
              <input
                type="number"
                min={0}
                max={props.durationSec}
                step={60}
                value={rule().startSec}
                onInput={(e) =>
                  patchSelected({ startSec: Number(e.currentTarget.value) })
                }
                onBlur={snapSelected}
              />
            </label>
            <label class="se-field">
              Fin (s)
              <input
                type="number"
                min={0}
                max={props.durationSec}
                step={60}
                value={rule().endSec}
                onInput={(e) =>
                  patchSelected({ endSec: Number(e.currentTarget.value) })
                }
                onBlur={snapSelected}
              />
            </label>
            <label class="se-field">
              Bande min (prix)
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                placeholder="glisser un rectangle"
                value={rule().bandMin ?? ""}
                onInput={(e) =>
                  patchSelected({ bandMin: optNum(e.currentTarget.value) })
                }
                onBlur={snapBandSelected}
              />
            </label>
            <label class="se-field">
              Bande max (prix)
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                placeholder="ex. 0.90"
                value={rule().bandMax ?? ""}
                onInput={(e) =>
                  patchSelected({ bandMax: optNum(e.currentTarget.value) })
                }
                onBlur={snapBandSelected}
              />
            </label>
            <Show
              when={rule().bandMin == null && rule().bandMax == null}
              fallback={
                <button type="button" class="btn" onClick={clearBand}>
                  Retirer la bande de prix
                </button>
              }
            >
              <button type="button" class="btn" onClick={addBand}>
                Surveiller une bande de prix
              </button>
            </Show>
            <label class="se-field">
              Token
              <select
                value={rule().token}
                onChange={(e) => {
                  const token = e.currentTarget.value as ChartRule["token"];
                  patchSelected(
                    rule().action === "sell"
                      ? { token, afterFill: token }
                      : { token },
                  );
                }}
              >
                <option value="cheap">Cheap</option>
                <option value="favorite">Favori</option>
              </select>
            </label>
            <label class="se-field">
              Direction du prix
              <select
                value={rule().direction}
                onChange={(e) =>
                  patchSelected({
                    direction: e.currentTarget.value as ChartRule["direction"],
                  })
                }
              >
                <option value="up">Hausse</option>
                <option value="down">Baisse</option>
              </select>
            </label>
            <label class="se-field">
              Action
              <select
                value={rule().action}
                onChange={(e) => {
                  const action = e.currentTarget.value as ChartRule["action"];
                  patchSelected(
                    action === "sell"
                      ? { action, afterFill: rule().token }
                      : { action },
                  );
                }}
              >
                <option value="buy">Acheter position</option>
                <option value="sell">Vendre position</option>
              </select>
            </label>
            <Show when={rule().action === "sell"}>
              <p class="se-hint">
                Vente uniquement si une position {rule().token === "cheap" ? "cheap" : "favori"}{" "}
                est déjà ouverte (fill).
              </p>
              <p class="se-hint">
                Le moteur liquide toujours la position fillée complète (pas de vente partielle).
              </p>
            </Show>
            <label class="se-check">
              <input
                type="checkbox"
                checked={rule().once !== false}
                onChange={(e) => patchSelected({ once: e.currentTarget.checked })}
              />
              Une seule fois
            </label>
            <Show when={rule().once !== false}>
              <p class="se-hint">
                <strong>once</strong> se verrouille dès qu’un POST est accepté
                (même si le GTC est ensuite cancel-locké). Un POST raté se retente.
                Ce n’est pas la même chose que <strong>dependsOn</strong> ci-dessous
                (qui attend le <em>fill</em>, pas le POST).
              </p>
            </Show>
            <Show when={props.rules.length > 1}>
              <fieldset class="se-chart-deps">
                <legend>Attend le fill de</legend>
                <p class="se-hint">
                  <strong>dependsOn</strong> : la zone ne s’évalue qu’après le
                  <em>fill</em> des parents buy (un POST accepté sans fill ne
                  débloque pas). Distinct de <strong>once</strong> (lock au POST).
                  Une zone peut avoir plusieurs enfants.
                </p>
                <For each={props.rules.filter((r) => r.id !== rule().id)}>
                  {(parent) => (
                    <label class="se-check">
                      <input
                        type="checkbox"
                        checked={uniqueDependsOn(rule()).includes(parent.id)}
                        onChange={(e) =>
                          toggleParent(parent.id, e.currentTarget.checked)
                        }
                      />
                      {chartRuleIndexLabel(props.rules, parent.id)}{" "}
                      {chartRuleLegend(parent)}
                    </label>
                  )}
                </For>
              </fieldset>
            </Show>
            <label class="se-field">
              Lookback (ms)
              <input
                type="number"
                min={0}
                step={1000}
                value={rule().lookbackMs ?? DEFAULT_LOOKBACK_MS}
                onInput={(e) =>
                  patchSelected({ lookbackMs: Number(e.currentTarget.value) })
                }
              />
            </label>
            <label class="se-field">
              Pente min (prix/s)
              <input
                type="number"
                min={0}
                step={0.001}
                value={rule().minSlope ?? DEFAULT_MIN_SLOPE}
                onInput={(e) =>
                  patchSelected({ minSlope: Number(e.currentTarget.value) })
                }
              />
            </label>
            <label class="se-field">
              Taille USDC (optionnel)
              <input
                type="number"
                min={0}
                step={1}
                placeholder="config"
                value={rule().sizeUsdc ?? ""}
                onInput={(e) => {
                  const raw = e.currentTarget.value;
                  patchSelected({
                    sizeUsdc: raw === "" ? undefined : Number(raw),
                  });
                }}
              />
            </label>
            <details class="se-advanced">
              <summary>Edge / confirm / vente</summary>
              <label class="se-field">
                Confirm ticks
                <input
                  type="number"
                  min={2}
                  step={1}
                  placeholder="—"
                  value={rule().confirmTicks ?? ""}
                  onInput={(e) => {
                    if (rule().bandMin == null && rule().bandMax == null) return;
                    patchSelected({ confirmTicks: optNum(e.currentTarget.value) });
                  }}
                  disabled={rule().bandMin == null && rule().bandMax == null}
                />
              </label>
              <label class="se-field">
                Max down tick
                <input
                  type="number"
                  min={0}
                  step={0.001}
                  placeholder="—"
                  value={rule().maxDownTick ?? ""}
                  onInput={(e) =>
                    patchSelected({ maxDownTick: optNum(e.currentTarget.value) })
                  }
                />
              </label>
              <label class="se-field">
                Après fill
                <select
                  value={rule().afterFill ?? "none"}
                  onChange={(e) =>
                    patchSelected({
                      afterFill: e.currentTarget.value as ChartRule["afterFill"],
                    })
                  }
                >
                  <option value="none">Aucun</option>
                  <option value="favorite">Favori fillé</option>
                  <option value="cheap">Cheap fillé</option>
                </select>
              </label>
              <Show
                when={rule().token === "cheap" && rule().action === "buy"}
                fallback={
                  <Show when={rule().token === "favorite" && rule().action === "buy" && (rule().bandMin != null || rule().bandMax != null)}>
                    <p class="se-hint">
                      Favori avec bande : cancel-lock automatique hors bande (pas de réglage).
                    </p>
                  </Show>
                }
              >
                <label class="se-field">
                  Hors bande (cheap GTC)
                  <select
                    value={rule().outOfBand ?? "keep"}
                    onChange={(e) =>
                      patchSelected({
                        outOfBand: e.currentTarget.value as ChartRule["outOfBand"],
                      })
                    }
                  >
                    <option value="keep">Garder</option>
                    <option value="cancel-lock">Annuler (re-post)</option>
                  </select>
                </label>
              </Show>
              <label class="se-field">
                Âge min (s)
                <input
                  type="number"
                  min={0}
                  step={60}
                  placeholder="—"
                  value={rule().minElapsedSec ?? ""}
                  onInput={(e) =>
                    patchSelected({ minElapsedSec: optNum(e.currentTarget.value) })
                  }
                />
              </label>
              <label class="se-field">
                Perte %
                <input
                  type="number"
                  min={0}
                  step={1}
                  placeholder="—"
                  value={rule().lossPct ?? ""}
                  onInput={(e) =>
                    patchSelected({ lossPct: optNum(e.currentTarget.value) })
                  }
                />
              </label>
              <label class="se-field">
                Fenêtre perte (ms)
                <input
                  type="number"
                  min={0}
                  step={1000}
                  placeholder="—"
                  value={rule().lossWindowMs ?? ""}
                  onInput={(e) =>
                    patchSelected({ lossWindowMs: optNum(e.currentTarget.value) })
                  }
                />
              </label>
            </details>
            <button type="button" class="btn" onClick={() => remove(rule().id)}>
              Supprimer la zone
            </button>
          </>
        )}
      </Show>
      <h3 class="se-chart-rules-title">Règles ({props.rules.length})</h3>
      <ul class="se-chart-rule-list">
        <For each={props.rules}>
          {(rule) => (
            <li>
              <button
                type="button"
                class={`se-chart-rule-item${props.selectedId === rule.id ? " is-sel" : ""}`}
                onClick={() => props.onSelect(rule.id)}
              >
                {chartRuleIndexLabel(props.rules, rule.id)} · {fmtSec(rule.startSec)}–
                {fmtSec(rule.endSec)} · {chartRuleLegend(rule)}
                {uniqueDependsOn(rule).length > 0
                  ? ` ← ${uniqueDependsOn(rule)
                      .map((id) => chartRuleIndexLabel(props.rules, id))
                      .join(", ")}`
                  : ""}
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.rules.length === 0}>
        <p class="se-hint">Aucune zone — Activer lancerait le squelette graphe, pas le chart.</p>
      </Show>
    </aside>
  );
}

function optNum(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

export function chartDurationSec(
  windowStart: number | null,
  windowEnd: number | null,
): number {
  if (windowStart != null && windowEnd != null && windowEnd > windowStart) {
    return windowEnd - windowStart;
  }
  return DEFAULT_CHART_DURATION_SEC;
}
