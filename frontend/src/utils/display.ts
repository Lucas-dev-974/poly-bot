/**
 * Helpers d'affichage partagés (Dashboard + pages) — sans état, sans JSX.
 * Remplace `pages/simPageHelpers.ts` : les trois règles y vivaient sous un
 * nom « sim » alors qu'elles servent les deux pages.
 */
export { countdownClass } from "./market";

/** Message d'erreur lisible : Error → message, sinon String(e). */
export function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Classe CSS de couleur d'un P&L : `pnl-pos` / `pnl-neg` / neutre.
 *
 * Règle : 0 est NEUTRE (ni vert ni rouge). Les tableaux du dashboard
 * utilisaient la variante `x >= 0 ? pnl-pos : pnl-neg`, qui coloriait un
 * P&L de $0.00 en vert — un P&L nul n'est pas un gain. Cette fonction
 * (identique à celle que la page Simulation utilisait déjà) est désormais
 * la seule source : pas de couleur pour 0, vert pour >0, rouge pour <0.
 */
export function pnlClass(pnl: number): string {
  if (pnl > 0) return "pnl-pos";
  if (pnl < 0) return "pnl-neg";
  return "";
}
