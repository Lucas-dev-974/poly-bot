/**
 * Rail Paramètres de la page Simulation — hook instancié dans SettingsRail.
 * État : form déclaratif (configForm.ts) dérivé de la config effective du
 * moteur, erreurs de validation, compte dirty (diff form vs config), sections
 * d'accordéon (communes remaniées + spécifiques au moteur, ids persistés en
 * localStorage), recherche par libellé, actions Appliquer / Réinitialiser /
 * Presets utilisateur.
 *
 * Le hook reçoit `reload` (recharge de l'état moteur) de la page via
 * SimControl — pas d'import croisé entre hooks.
 */
import { createEffect, createMemo, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { api } from "../../api/client";
import { toMessage } from "../simPageHelpers";
import { SIM_5M_STRATEGIES, SIM_5M_FILTER_FIELDS } from "../../config/sim5mStrategies";
import {
  COMMON_PARAM_SECTIONS,
  paramSectionsFor,
  strategyShortLabel,
  type ParamFieldDef,
} from "../../config/strategyFields";
import {
  applySettingsToForm,
  configToForm,
  fieldErrors,
  formToSettings,
  type ConfigFormState,
} from "../../utils/configForm";
import { addLog } from "../../stores/logStore";
import { pushError } from "../../stores/toastStore";
import { commitUserPreset, removeUserPreset } from "../../stores/userPresetsStore";
import { simConfigState, simEffectiveConfig } from "../../stores/simStore";
import type { BotConfig } from "../../types";

/** Section de paramètres du rail (id stable + champs). */
export interface SimSection {
  id: string;
  title: string;
  fields: readonly ParamFieldDef[];
}

/** Checkbox d'activation d'une section (badge + atténuation). */
export function sectionEnableField(
  fields: readonly ParamFieldDef[],
): ParamFieldDef | undefined {
  return fields.find((f) => f.type === "checkbox" && /activ/i.test(f.label));
}

/** Vrai si un champ de section matche la requête de recherche (vide = tout). */
export function fieldMatches(q: string, label: string): boolean {
  if (!q) return true;
  return label.toLowerCase().includes(q);
}

/** Slug stable pour l'état d'accordéon (localStorage). */
function slugOf(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface SimSettings {
  /** Form courant (null = config effective pas encore chargée). */
  form(): ConfigFormState | null;
  /** StrategyId du moteur actif (pour les sections + titres). */
  strategyId(): string;
  /** Erreurs de validation par clé de champ. */
  fieldError(key: keyof ConfigFormState): string | undefined;
  hasErrors(): boolean;
  /** Nombre de champs édités non appliqués. */
  dirtyCount(): number;
  /** Recherche rail (filtre les champs par libellé). */
  searchQuery(): string;
  setSearchQuery(v: string): void;
  /** Setter générique (string pour inputs, boolean pour checkboxes). */
  updateFieldRaw(key: string, value: string | boolean): void;
  updateField<K extends keyof ConfigFormState>(key: K, value: ConfigFormState[K]): void;
  /** Remise au niveau de la config effective (local, sans patch moteur). */
  resetForm(): void;
  /** PATCH complet des settings au moteur + reload. */
  applySettings(): Promise<void>;
  // ── Presets utilisateur ──
  presetName(): string;
  setPresetName(v: string): void;
  confirmPresetSave(): boolean;
  setConfirmPresetSave(v: boolean): void;
  savePreset(): Promise<void>;
  deletePreset(id: string): void;
  /** Charge les settings d'un preset utilisateur dans le form (base = config effective). */
  applyPresetToForm(settings: Partial<BotConfig>): void;
  // ── Accordéons + sections ──
  railSections(): SimSection[];
  openAccs(): Set<string>;
  toggleAccordion(id: string): void;
  openAccordion(id: string): void;
  // ── Filtres 5m du moteur antiflip-revert ──
  sim5mSelected(): (typeof SIM_5M_STRATEGIES)[number] | null;
  sim5mInactiveFields(): Array<keyof typeof SIM_5M_FILTER_FIELDS>;
  sim5mFieldStep(field: keyof typeof SIM_5M_FILTER_FIELDS): string;
}

export function useSimSettings(opts: {
  reload: () => Promise<void>;
  /** État « requête en cours » partagé de la page (disable des contrôles). */
  setSending: (v: boolean) => void;
}): SimSettings {
  const [sim5mForm, setSim5mForm] = createSignal<ConfigFormState | null>(null);
  const [confirmPresetSave, setConfirmPresetSave] = createSignal(false);
  const [presetName, setPresetName] = createSignal("");
  const [settingsQuery, setSettingsQuery] = createSignal("");

  // Form = config effective + settings courants du rail. GÉNÉRIQUE pour
  // toutes les stratégies : le rail s'affiche dès que la config effective
  // est disponible, quel que soit le moteur actif.
  const sim5mBase = createMemo(() => simEffectiveConfig());
  const formErrors = createMemo(() => (sim5mForm() ? fieldErrors(sim5mForm()!, true) : {}));
  const hasErrors = createMemo(() => Object.keys(formErrors()).length > 0);

  /** Re-remplit le form dès que la config effective CHANGE DE CONTENU
   * (preset/strategy switché depuis un select, la barre de contexte ou un
   * autre onglet). Empreinte obligatoire : le SSE simConfig rediffuse la
   * config effective sur Démarrer/Arrêter (setEnabled) et Reset — nouvelle
   * référence JSON mais contenu identique — et sans empreinte ces events
   * écraseraient les éditions non appliquées du rail. */
  let lastDerivedForm: string | null = null;
  createEffect(() => {
    const base = sim5mBase();
    if (!base) {
      lastDerivedForm = null;
      setSim5mForm(null);
      return;
    }
    const next = configToForm(base);
    const fingerprint = JSON.stringify(next);
    if (fingerprint === lastDerivedForm) return;
    lastDerivedForm = fingerprint;
    setSim5mForm(next);
  });

  const dirtyCount = createMemo(() => {
    const form = sim5mForm();
    if (!form || !sim5mBase()) return 0;
    const base = configToForm(sim5mBase()!);
    if (JSON.stringify(form) === JSON.stringify(base)) return 0;
    let n = 0;
    for (const k of Object.keys(form) as Array<keyof ConfigFormState>) {
      if (form[k] !== base[k]) n += 1;
    }
    return n;
  });

  function updateField<K extends keyof ConfigFormState>(key: K, value: ConfigFormState[K]): void {
    setSim5mForm((f) => (f ? { ...f, [key]: value } : f));
  }

  /** Setter brut pour le rendu générique (cast nécessaire : unions / booleans). */
  function updateFieldRaw(key: string, value: string | boolean): void {
    setSim5mForm((f) => (f ? ({ ...f, [key]: value } as ConfigFormState) : f));
  }

  function fieldError(key: keyof ConfigFormState): string | undefined {
    return (formErrors() as Partial<Record<keyof ConfigFormState, string>>)[key];
  }

  function resetForm(): void {
    const base = sim5mBase();
    if (base) setSim5mForm(configToForm(base));
  }

  async function applySettings(): Promise<void> {
    const form = sim5mForm();
    if (!form) return;
    const errors = fieldErrors(form, true);
    if (Object.keys(errors).length > 0) {
      pushError("Paramètres : corrigez les champs invalides", { group: "sim-error", replaceGroup: true });
      return;
    }
    opts.setSending(true);
    try {
      // presetId = preset COURANT du moteur (pas le preset 5m antiflip :
      // celui-ci est null pour les moteurs non-antiflip et un null explicite
      // purgerait le preset actif côté engine.applyConfig).
      const res = await api.simUpdateConfig({
        strategyId: form.strategyId,
        presetId: simConfigState()?.presetId ?? null,
        settings: formToSettings(form),
      });
      if (!res.ok) throw new Error(res.error ?? "Échec de l'application");
      await opts.reload();
      addLog("Paramètres appliqués au moteur paper");
    } catch (e) {
      pushError("Paramètres : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      opts.setSending(false);
    }
  }

  async function savePreset(): Promise<void> {
    const form = sim5mForm();
    const name = presetName().trim();
    if (!form || !name) return;
    const errors = fieldErrors(form, true);
    if (Object.keys(errors).length > 0) {
      pushError("Paramètres : corrigez les champs invalides avant de sauvegarder", { group: "sim-error", replaceGroup: true });
      return;
    }
    try {
      commitUserPreset({
        name,
        description: `Preset sim utilisateur — ${strategyShortLabel(form.strategyId)}`,
        strategyId: form.strategyId,
        settings: formToSettings(form),
      });
      setPresetName("");
      setConfirmPresetSave(false);
      addLog(`Preset sauvegardé : ${name}`);
    } catch (e) {
      pushError("Paramètres : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    }
  }

  function deletePreset(id: string): void {
    removeUserPreset(id);
    addLog("Preset utilisateur supprimé");
  }

  /** Charge les settings d'un preset utilisateur dans le form (la base reste
   * la config effective : les clés absentes du preset gardent leur valeur). */
  function applyPresetToForm(settings: Partial<BotConfig>): void {
    const base = sim5mBase();
    if (base) setSim5mForm(applySettingsToForm(base, settings));
  }

  // ── Sections du rail (communes remaniées + spécifiques au moteur) ────────
  /** Sections COMMUNES pour le rail : Marchés & cadence ; Garde-fous & fenêtre
   * (fusion des sections « Garde-fous » + « Fenêtre de trading ») ;
   * Moteur de simulation. strategyFields.ts reste intact (partagé). */
  const commonRailSections = createMemo<SimSection[]>(() => {
    const guards: readonly ParamFieldDef[] = [
      ...(COMMON_PARAM_SECTIONS.find((s) => s.title === "Garde-fous")?.fields ?? []),
      ...(COMMON_PARAM_SECTIONS.find((s) => s.title === "Fenêtre de trading")?.fields ?? []),
    ];
    const out: SimSection[] = [];
    for (const s of COMMON_PARAM_SECTIONS) {
      if (s.title === "Garde-fous" || s.title === "Fenêtre de trading") continue;
      out.push({ id: slugOf(s.title), title: s.title, fields: s.fields });
    }
    const at = out.findIndex((s) => s.title === "Marchés & cadence") + 1;
    out.splice(at, 0, { id: "garde-fous", title: "Garde-fous & fenêtre", fields: guards });
    return out;
  });

  /** Liste des accordéons du rail : communs + spécifiques au moteur actif ; les
   * filtres 5m antiflip et les presets utilisateur sont gérés séparément. */
  const railSections = createMemo<SimSection[]>(() => {
    const strategy = sim5mForm()?.strategyId ?? "arb";
    const engineSections: SimSection[] = paramSectionsFor(strategy).map((s) => ({
      id: slugOf(s.title),
      title: s.title,
      fields: s.fields,
    }));
    return [...commonRailSections(), ...engineSections];
  });

  // État des accordéons : persisté localStorage (ids ouverts). Défaut = les
  // sections communes + la première section moteur ouverts.
  const ACC_STORAGE_KEY = "sim-acc-open";
  function readOpenAccs(): Set<string> {
    const defaults = new Set([
      ...commonRailSections().map((s) => s.id),
      ...paramSectionsFor(sim5mForm()?.strategyId ?? "arb")
        .slice(0, 1)
        .map((s) => slugOf(s.title)),
    ]);
    try {
      const raw = localStorage.getItem(ACC_STORAGE_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      /* localStorage indisponible — défauts. */
    }
    return defaults;
  }
  const [openAccs, setOpenAccs] = createSignal<Set<string>>(readOpenAccs());
  function persistAccs(next: Set<string>): void {
    try {
      localStorage.setItem(ACC_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      /* stockage indisponible : état session seule. */
    }
  }
  function toggleAccordion(id: string): void {
    setOpenAccs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistAccs(next);
      return next;
    });
  }
  function openAccordion(id: string): void {
    setOpenAccs((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      persistAccs(next);
      return next;
    });
  }

  // ── Détails 5m (moteur antiflip-revert) ──────────────────────────────────
  const sim5mActiveId = createMemo(() => {
    const c = simConfigState();
    if (!c || c.strategyId !== "antiflip-revert" || !c.presetId) return null;
    return SIM_5M_STRATEGIES.some((s) => s.presetId === c.presetId) ? c.presetId : null;
  });
  const sim5mSelected = createMemo(() => {
    const id = sim5mActiveId();
    return SIM_5M_STRATEGIES.find((s) => s.presetId === id) ?? null;
  });

  /** Champs « filtres » INACTIFS pour la stratégie courante = tous les champs
   * de SIM_5M_FILTER_FIELDS moins les actifs. Affichés en section repliable. */
  const sim5mInactiveFields = createMemo(() => {
    const active = new Set(sim5mSelected()?.activeFields ?? []);
    return (Object.keys(SIM_5M_FILTER_FIELDS) as Array<keyof typeof SIM_5M_FILTER_FIELDS>)
      .filter((f) => !active.has(f));
  });

  /** Step HTML selon le champ (TP = fraction, prix = centimes). */
  function sim5mFieldStep(field: keyof typeof SIM_5M_FILTER_FIELDS): string {
    return field === "antiflipTakeProfitPct" ? "0.05" : "0.01";
  }

  return {
    form: sim5mForm,
    strategyId: () => sim5mForm()?.strategyId ?? "",
    fieldError,
    hasErrors,
    dirtyCount,
    searchQuery: settingsQuery,
    setSearchQuery: setSettingsQuery,
    updateFieldRaw,
    updateField,
    resetForm,
    applySettings,
    presetName,
    setPresetName: setPresetName,
    confirmPresetSave,
    setConfirmPresetSave,
    savePreset,
    deletePreset,
    applyPresetToForm,
    railSections,
    openAccs,
    toggleAccordion,
    openAccordion,
    sim5mSelected,
    sim5mInactiveFields,
    sim5mFieldStep,
  };
}