/**
 * Rail « Paramètres » de la page Simulation — édition runtime des paramètres
 * de la stratégie ACTIVE (tous moteurs) sous forme d'accordéons :
 * sections communes remaniées (useSimSettings) + spécifiques au moteur,
 * filtres 5m actifs/inactifs pour antiflip-revert, presets utilisateur,
 * footer Réinitialiser / Appliquer au moteur.
 *
 * IMPORTANT SolidJS : toutes les lectures de signaux (form, sending, erreurs)
 * sont INLINE dans les expressions JSX — les capturer en variables avant le
 * JSX figerait les attributs (value/disabled) au rendu initial.
 */
import type { JSX } from "solid-js";
import { For, Show, createMemo } from "solid-js";
import { SIM_5M_FILTER_FIELDS } from "../../config/sim5mStrategies";
import { strategyShortLabel, type ParamFieldDef } from "../../config/strategyFields";
import type { ConfigFormState } from "../../utils/configForm";
import { userPresets } from "../../stores/userPresetsStore";
import { fieldMatches, sectionEnableField, useSimSettings } from "./useSimSettings";
import type { SimControl } from "./useSimControl";

/**
 * Composant générique d'un champ de paramètre (number/text/checkbox/select).
 * `dimmed` : atténué quand le module de la section est désactivé.
 */
function SimParamField(props: { set: ReturnType<typeof useSimSettings>; ctrl: SimControl; field: ParamFieldDef; dimmed?: boolean }): JSX.Element {
  return (
    <label
      class="sim2-fld"
      classList={{ "sim2-fld-dim": props.dimmed === true }}
      title={props.field.hint ?? props.field.label}
    >
      {props.field.label}
      <Show
        when={props.field.type === "checkbox"}
        fallback={
          <Show
            when={props.field.type === "select"}
            fallback={
              <input
                type={props.field.type === "text" ? "text" : "number"}
                step={props.field.step}
                min={props.field.min}
                max={props.field.max}
                placeholder={props.field.placeholder}
                classList={{ "input-error": !!(props.set.fieldError(props.field.key)) }}
                disabled={props.ctrl.sending()}
                value={String(props.set.form()?.[props.field.key] ?? "")}
                onInput={(e) => props.set.updateFieldRaw(props.field.key as string, e.currentTarget.value)}
              />
            }
          >
            <select
              classList={{ "input-error": !!(props.set.fieldError(props.field.key)) }}
              disabled={props.ctrl.sending()}
              value={String(props.set.form()?.[props.field.key] ?? "")}
              onChange={(e) => props.set.updateFieldRaw(props.field.key as string, e.currentTarget.value)}
            >
              <For each={props.field.options ?? []}>
                {(opt) => <option value={opt.value}>{opt.label}</option>}
              </For>
            </select>
          </Show>
        }
      >
        <input
          type="checkbox"
          class="sim2-check"
          disabled={props.ctrl.sending()}
          checked={Boolean(props.set.form()?.[props.field.key])}
          onInput={(e) => props.set.updateFieldRaw(props.field.key as string, e.currentTarget.checked)}
        />
      </Show>
      <Show when={props.set.fieldError(props.field.key)}>
        <span class="field-error">{props.set.fieldError(props.field.key)}</span>
      </Show>
    </label>
  );
}

/** Ligne switch pour la checkbox d'activation d'une section (ligne pleine). */
function SimEnableSwitch(props: { set: ReturnType<typeof useSimSettings>; ctrl: SimControl; field: ParamFieldDef; accordionId: string }): JSX.Element {
  return (
    <label class="sim2-switch-row" title={props.field.hint ?? props.field.label}>
      <span>{props.field.label}</span>
      <input
        type="checkbox"
        class="sim2-switch"
        disabled={props.ctrl.sending()}
        checked={Boolean(props.set.form()?.[props.field.key])}
        onInput={(e) => {
          props.set.updateFieldRaw(props.field.key as string, e.currentTarget.checked);
          if (e.currentTarget.checked) props.set.openAccordion(props.accordionId);
        }}
      />
    </label>
  );
}

export function SettingsRail(props: { ctrl: SimControl }): JSX.Element {
  const set = useSimSettings({
    reload: () => props.ctrl.reload(),
    setSending: props.ctrl.setSending,
  });

  /** Champ d'activation présent dans cette section, déjà coché. */
  const enabledNow = (enable: ParamFieldDef | undefined): boolean =>
    enable !== undefined &&
    Boolean(set.form()?.[enable.key as keyof ConfigFormState]);

  return (
    <Show when={set.form() !== null}>
      <section class="sim2-card sim2-settings">
        <div class="sim2-set-h">
          <h2>Paramètres — {strategyShortLabel(set.form()!.strategyId)}</h2>
          <Show when={set.dirtyCount() > 0}>
            <span class="sim2-dirty">● {set.dirtyCount()} modifié{set.dirtyCount() > 1 ? "s" : ""}</span>
          </Show>
          <span class="sim2-card-spacer" />
          <button
            type="button"
            class="btn btn-ghost sim2-set-reset"
            disabled={props.ctrl.sending() || set.dirtyCount() === 0}
            onClick={() => set.resetForm()}
          >
            Réinitialiser
          </button>
        </div>
        <Show when={props.ctrl.currentPreset()}>
          {(p) => <p class="sim2-set-hint">{p().description}</p>}
        </Show>

        <div class="sim2-set-search">
          <div class="sim2-search sim2-search-full">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              type="search"
              placeholder="Rechercher un paramètre…"
              value={set.searchQuery()}
              onInput={(e) => set.setSearchQuery(e.currentTarget.value)}
            />
          </div>
        </div>

        <For each={set.railSections()}>
          {(sec) => {
            const q = () => set.searchQuery().trim().toLowerCase();
            const enable = sectionEnableField(sec.fields);
            const paramFields = () => sec.fields.filter((f) => f !== enable);
            const visibleCount = createMemo(() =>
              sec.fields.filter((f) => fieldMatches(q(), f.label)).length,
            );
            const isOn = () => enabledNow(enable);
            return (
              <Show when={q() === "" || visibleCount() > 0}>
                <div class="sim2-acc" classList={{ open: set.openAccs().has(sec.id) }}>
                  <div
                    class="sim2-acc-h"
                    role="button"
                    tabindex={0}
                    aria-expanded={set.openAccs().has(sec.id)}
                    onClick={() => set.toggleAccordion(sec.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        set.toggleAccordion(sec.id);
                      }
                    }}
                  >
                    <span class="sim2-acc-chev" aria-hidden="true">▸</span>
                    <span class="sim2-acc-t">{sec.title}</span>
                    <span class="sim2-acc-meta">
                      <Show when={enable}>
                        <span class="sim2-acc-off" classList={{ "sim2-acc-off-yes": isOn() }}>
                          {isOn() ? "actif" : "off"}
                        </span>
                      </Show>
                      <span>
                        {visibleCount()} champ{visibleCount() > 1 ? "s" : ""}
                      </span>
                    </span>
                  </div>
                  <div class="sim2-acc-b" style={{ display: set.openAccs().has(sec.id) ? "" : "none" }}>
                    <div
                      class="sim2-acc-grid"
                      classList={{ "sim2-acc-grid-dim": enable !== undefined && !isOn() }}
                    >
                      {/* Switch d'activation (ligne pleine) */}
                      <Show when={enable} keyed>
                        {(en) => <SimEnableSwitch set={set} ctrl={props.ctrl} field={en} accordionId={sec.id} />}
                      </Show>
                      <For each={paramFields()}>
                        {(field) => (
                          <SimParamField set={set} ctrl={props.ctrl} field={field} dimmed={enable !== undefined && !isOn()} />
                        )}
                      </For>
                    </div>
                  </div>
                </div>
              </Show>
            );
          }}
        </For>

        {/* ── Antiflip : filtres 5m actifs / inactifs ── */}
        <Show when={set.form()!.strategyId === "antiflip-revert" && set.sim5mSelected()?.activeFields.length}>
          <div class="sim2-acc open">
            <div class="sim2-acc-h">
              <span class="sim2-acc-chev" aria-hidden="true">▸</span>
              <span class="sim2-acc-t">Filtres actifs — {set.sim5mSelected()?.name}</span>
              <span class="sim2-acc-meta">
                {set.sim5mSelected()?.activeFields.length} champ
                {(set.sim5mSelected()?.activeFields.length ?? 0) > 1 ? "s" : ""}
              </span>
            </div>
            <div class="sim2-acc-b" style={{ display: "" }}>
              <div class="sim2-acc-grid">
                <For each={set.sim5mSelected()?.activeFields ?? []}>
                  {(field) => (
                    <label class="sim2-fld" title={SIM_5M_FILTER_FIELDS[field]}>
                      {SIM_5M_FILTER_FIELDS[field]}
                      <input
                        type="number"
                        step={set.sim5mFieldStep(field)}
                        min="0"
                        classList={{ "input-error": !!(set.fieldError(field)) }}
                        disabled={props.ctrl.sending()}
                        onInput={(e) => set.updateField(field, e.currentTarget.value)}
                        value={set.form()![field]}
                      />
                      <Show when={set.fieldError(field)}>
                        <span class="field-error">{set.fieldError(field)}</span>
                      </Show>
                    </label>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Show>
        <Show when={set.form()!.strategyId === "antiflip-revert" && set.sim5mInactiveFields().length > 0}>
          <div class="sim2-acc" classList={{ open: set.openAccs().has("filtres-inactifs") }}>
            <div
              class="sim2-acc-h"
              role="button"
              tabindex={0}
              aria-expanded={set.openAccs().has("filtres-inactifs")}
              onClick={() => set.toggleAccordion("filtres-inactifs")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  set.toggleAccordion("filtres-inactifs");
                }
              }}
            >
              <span class="sim2-acc-chev" aria-hidden="true">▸</span>
              <span class="sim2-acc-t">Filtres inactifs</span>
              <span class="sim2-acc-meta">
                {set.sim5mInactiveFields().length} champ{set.sim5mInactiveFields().length > 1 ? "s" : ""}
              </span>
            </div>
            <div class="sim2-acc-b" style={{ display: set.openAccs().has("filtres-inactifs") ? "" : "none" }}>
              <div class="sim2-acc-grid">
                <For each={set.sim5mInactiveFields()}>
                  {(field) => (
                    <label class="sim2-fld" title={SIM_5M_FILTER_FIELDS[field]}>
                      {SIM_5M_FILTER_FIELDS[field]}
                      <input
                        type="number"
                        step={set.sim5mFieldStep(field)}
                        min="0"
                        classList={{ "input-error": !!(set.fieldError(field)) }}
                        disabled={props.ctrl.sending()}
                        onInput={(e) => set.updateField(field, e.currentTarget.value)}
                        value={set.form()![field]}
                      />
                      <Show when={set.fieldError(field)}>
                        <span class="field-error">{set.fieldError(field)}</span>
                      </Show>
                    </label>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Show>

        {/* ── Presets utilisateur ── */}
        <div class="sim2-acc" classList={{ open: set.openAccs().has("presets-utilisateur") }}>
          <div
            class="sim2-acc-h"
            role="button"
            tabindex={0}
            aria-expanded={set.openAccs().has("presets-utilisateur")}
            onClick={() => set.toggleAccordion("presets-utilisateur")}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                set.toggleAccordion("presets-utilisateur");
              }
            }}
          >
            <span class="sim2-acc-chev" aria-hidden="true">▸</span>
            <span class="sim2-acc-t">Presets utilisateur</span>
            <span class="sim2-acc-meta">
              {userPresets().filter((p) => p.strategyId === set.form()!.strategyId).length} enregistré(s)
            </span>
          </div>
          <div class="sim2-acc-b" style={{ display: set.openAccs().has("presets-utilisateur") ? "" : "none" }}>
            <div class="sim2-presets">
              <Show
                when={set.confirmPresetSave()}
                fallback={
                  <button
                    class="btn btn-ghost sim2-preset-add"
                    disabled={props.ctrl.sending() || set.hasErrors()}
                    onClick={() => set.setConfirmPresetSave(true)}
                  >
                    + Sauvegarder l'état courant comme preset
                  </button>
                }
              >
                <div class="sim2-preset-save">
                  <input
                    type="text"
                    placeholder="Nom du preset"
                    value={set.presetName()}
                    disabled={props.ctrl.sending()}
                    onInput={(e) => set.setPresetName(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void set.savePreset();
                      if (e.key === "Escape") set.setConfirmPresetSave(false);
                    }}
                  />
                  <button class="btn btn-primary" disabled={!set.presetName().trim() || props.ctrl.sending()} onClick={() => void set.savePreset()}>
                    Enregistrer
                  </button>
                  <button class="btn btn-ghost" onClick={() => set.setConfirmPresetSave(false)}>Annuler</button>
                </div>
              </Show>
              <Show when={userPresets().length > 0}>
                <div class="sim2-preset-list">
                  <For each={userPresets().filter((p) => p.strategyId === set.form()!.strategyId)}>
                    {(p) => (
                      <div class="sim2-preset-item">
                        <span class="sim2-preset-name" title={p.description}>{p.name}</span>
                        <div class="sim2-preset-actions">
                          <button
                            class="btn btn-ghost sim2-btn-xs"
                            title="Charger dans le formulaire"
                            disabled={props.ctrl.sending()}
                            onClick={() => set.applyPresetToForm(p.settings)}
                          >
                            Charger
                          </button>
                          <button class="btn btn-ghost sim2-btn-xs sim2-btn-danger" onClick={() => set.deletePreset(p.id)}>
                            Suppr.
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </div>

        {/* Footer du rail : réinitialiser + appliquer — le bouton n'est actif
            QUE si des edits existent (dirtyCount > 0) et sans erreur bloquante :
            au load il est grisé ("aucune modification"), et une édition avec
            erreur (ex : Hedge inverse + max positions < 2) le garde grisé avec
            le résumé des erreurs à corriger. */}
        <div class="sim2-set-foot">
          <Show
            when={set.hasErrors() && set.errorList().length > 0}
            fallback={
              <span class="sim2-set-foot-note">
                {set.dirtyCount() === 0
                  ? "aucune modification à appliquer"
                  : "l'application remplace l'ensemble des settings du moteur"}
              </span>
            }
          >
            <span class="sim2-set-err" role="alert">
              <For each={set.errorList()}>
                {(e, i) => (
                  <>
                    <Show when={i() > 0}> · </Show>
                    <b title={`Section : ${e.section}`}>{e.label}</b> {e.msg}
                  </>
                )}
              </For>
            </span>
          </Show>
          <button
            type="button"
            class="btn btn-primary sim2-set-apply"
            disabled={props.ctrl.sending() || set.hasErrors() || set.dirtyCount() === 0}
            onClick={() => void set.applySettings()}
          >
            Appliquer au moteur
          </button>
        </div>
      </section>
    </Show>
  );
}