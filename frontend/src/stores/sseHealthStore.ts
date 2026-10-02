import { createSignal } from "solid-js";

/**
 * Santé du flux SSE dashboard (/events). Permet aux pollers REST de s'adapter
 * : fréquence nominale quand le SSE vit, accélérée quand il est perdu.
 *
 * IMPORTANT : le SSE frontend se connecte avec replay=0 — les events émis
 * pendant une coupure ne sont jamais rejoués. Le polling REST reste donc le
 * seul réconciliateur après une reconnexion (les stores sont append-only).
 */
const [lastEventAt, setLastEventAt] = createSignal(0);
const [connected, setConnected] = createSignal(false);

export { lastEventAt, connected };

/** Appelé par transport/sse à chaque message SSE reçu. */
export function markSseEvent(): void {
  setLastEventAt(Date.now());
  setConnected(true);
}

/** Appelé par transport/sse en cas d'erreur de connexion. */
export function markSseError(): void {
  setConnected(false);
}

/** Appelé par transport/sse à l'ouverture de la connexion. */
export function markSseOpen(): void {
  setConnected(true);
}

/**
 * Le SSE est-il considéré vivant ? Un event doit être arrivé dans les
 * `toleranceMs` dernières millisecondes (défaut : 20 s — le backend émet des
 * events watching/stats bien plus souvent que toutes les 5 s en fonctionnement
 * normal ; en bot en pause le flux peut être calme, d'où une tolérance large).
 */
export function isSseAlive(toleranceMs = 20_000): boolean {
  return connected() && Date.now() - lastEventAt() < toleranceMs;
}