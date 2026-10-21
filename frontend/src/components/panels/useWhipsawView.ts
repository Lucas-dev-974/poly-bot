/**
 * Logique dérivée du statut whipsaw (fav-band) — partagée par le panneau
 * LIVE (dashboard) et le panneau SIM (rail Paramètres de /simulation).
 *
 * Les deux panneaux affichent le même statut, avec des libellés légèrement
 * différents (« Inactif… » côté live, « Actif… » côté sim) mais des règles
 * de calcul identiques : classe de badge, countdown restant, phrase de
 * seuil. Cette hook factorise les règles ; le libellé reste au composant.
 */
import { createMemo } from "solid-js";
import type { Accessor } from "solid-js";
import { useClock, clockNow } from "../../stores/clockStore";
import type { FavBandWhipsawStatus } from "../../types";

export interface WhipsawView {
  /** Statut courant (null = moteur ≠ fav-band, ou pas encore reçu). */
  status: Accessor<FavBandWhipsawStatus | null>;
  /** Classe CSS du badge : unknown | disabled | active | ready. */
  badgeClass: Accessor<string>;
  /** Countdown restant « m:ss » (null si pas de pause active). */
  remainingText: Accessor<string | null>;
  /** remainingMs bruts (null si pas de snapshot). */
  remainingMs: Accessor<number | null>;
  /** Phrase « seuil atteint » (null si le seuil n'est pas atteint). */
  thresholdReached: Accessor<boolean>;
}

export function useWhipsawView(
  snapshot: Accessor<{ status: FavBandWhipsawStatus | null } | null>,
  remainingMsAt: (now: number) => number | null,
): WhipsawView {
  // Horloge globale partagée (tick 1 s) pour le countdown client.
  useClock();

  const status = createMemo(() => snapshot()?.status ?? null);

  // Countdown ancré : remainingMs mesuré à receivedAt, décompté par
  // l'horloge locale (remainingMsAt lit aussi le snapshot → réactif).
  const remainingMs = createMemo(() => {
    if (!snapshot()) return null;
    void clockNow(); // réactivité 1 s
    return remainingMsAt(clockNow());
  });

  const badgeClass = createMemo(() => {
    const s = status();
    if (!s) return "unknown";
    if (!s.enabled) return "disabled";
    if (s.active) return "active";
    return "ready";
  });

  const remainingText = createMemo(() => {
    const ms = remainingMs();
    if (ms == null || !status()?.active) return null;
    const remaining = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(remaining / 60);
    const sec = remaining % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  });

  const thresholdReached = createMemo(() => {
    const s = status();
    return Boolean(
      s && s.enabled && s.lossStreak > 0 &&
        s.pauseAfterLosses != null && s.lossStreak >= s.pauseAfterLosses,
    );
  });

  return { status, badgeClass, remainingText, remainingMs, thresholdReached };
}
