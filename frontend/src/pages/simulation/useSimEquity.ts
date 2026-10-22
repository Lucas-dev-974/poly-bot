/**
 * Historique equity de la simulation (courbe de capital) — hook instancié
 * une fois par la page. Fetch indépendant des tables (toutes les pages,
 * 200 résolutions par page — historique complet), rafraîchi au montage et
 * à chaque résolution (SSE → simResolvedPositions, debounce 400 ms).
 *
 * La série (utils/equity.ts) est ancrée : le DERNIER point vaut exactement
 * capitalInitial + P&L réalisé du moteur, même si l'historique est tronqué
 * ou archivé — la courbe reste cohérente avec les KPI.
 */
import { createEffect, createMemo, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { api } from "../../api/client";
import type { SimulatedPosition } from "../../types";
import { buildEquitySeries, type EquityStats } from "../../utils/equity";
import { simConfigState, simEngineStats, simResolvedPositions } from "../../stores/simStore";

export interface SimEquity {
  /** Stats + points de la courbe (memo). */
  stats(): EquityStats;
  /** Dernières valeurs pour la sparkline du KPI capital ([] si < 2 points). */
  sparkValues(): number[];
}

export function useSimEquity(): SimEquity {
  const [equityList, setEquityList] = createSignal<SimulatedPosition[]>([]);

async function fetchEquity(): Promise<void> {
    try {
      const pageSize = 200;
      // Historique complet : on pagine côté client jusqu'à la dernière page
      // (le backend plafonne une page à 200 résolutions). Avant on ne lisait
      // que la page 1, ce qui tronquait l'équité au-delà de 200 points.
      const first = await api.simResolvedPaged(1, pageSize);
      const chunks: SimulatedPosition[][] = [first.positions];
      let page = 1;
      const totalPages = Math.max(1, first.totalPages ?? 1);
      while (page < totalPages) {
        page += 1;
        const next = await api.simResolvedPaged(page, pageSize);
        if (next.positions.length === 0) break;
        chunks.push(next.positions);
      }
      setEquityList(chunks.flat());
      firstRunSinceMount = false;
    } catch {
      /* la dernière liste reste affichée */
    }
  }

  // Fetch immédiat au montage (première trace) puis à chaque changement de la
  // liste des résolues (résolution SSE / pagination / archivage) — debounce
  // 400 ms. La liste elle-même n'est PAS lue ici (sinon nouvelle référence =
  // re-déclenchement de l'effet en boucle).
  let equityTimer: ReturnType<typeof setTimeout> | null = null;
  let firstRunSinceMount = true;
  createEffect(() => {
    simResolvedPositions().length; // trace de dépendance réactive
    const delay = firstRunSinceMount ? 0 : 400;
    if (equityTimer !== null) clearTimeout(equityTimer);
    equityTimer = setTimeout(() => {
      void fetchEquity();
    }, delay);
  });

  const stats: Accessor<EquityStats> = createMemo(() =>
    buildEquitySeries(
      equityList(),
      simConfigState()?.capitalInitial ?? 0,
      simEngineStats()?.realizedPnl ?? 0,
    ),
  );
  const sparkValues = createMemo(() => {
    const pts = stats().points;
    if (pts.length < 2) return [] as number[];
    return pts.slice(-40).map((p) => p.v);
  });

  return { stats, sparkValues };
}