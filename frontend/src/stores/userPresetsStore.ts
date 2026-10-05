import { createSignal } from "solid-js";
import { saveUserPreset, deleteUserPreset, loadUserPresets, type UserPreset } from "../utils/user-presets";

/**
 * Presets utilisateur (localStorage) comme source réactive unique.
 * localStorage n'est plus re-parsé à chaque mutation des pages : le signal
 * est hydraté au premier accès puis mis à jour par les actions du store.
 */
const [userPresets, setUserPresetsRaw] = createSignal<UserPreset[]>(loadUserPresets());

export { userPresets };

/** Hydrate le signal depuis localStorage (re-scan explicite, ex. import manuel). */
function reloadUserPresets(): void {
  setUserPresetsRaw(loadUserPresets());
}

/** Sauvegarde + refresh du signal. Retourne le preset persisté. */
export function commitUserPreset(
  preset: Parameters<typeof saveUserPreset>[0],
): UserPreset {
  const saved = saveUserPreset(preset);
  reloadUserPresets();
  return saved;
}

/** Suppression + refresh du signal. */
export function removeUserPreset(id: string): void {
  deleteUserPreset(id);
  reloadUserPresets();
}