import type { BotConfig } from "../config.js";

/**
 * Buffer in-memory de confirmation edge-lead.
 *
 * Pour chaque paire, on accumule les bestAsk consécutifs du token edge
 * (favori) tant qu'ils restent dans la bande [edgeBandMin, edgeBandMax] et
 * sans drop tick-à-tick trop fort. Dès que `edgeConfirmSamples` ticks
 * consécutifs valides sont réunis ET que la série est globalement croissante
 * (last >= first et mean > first), le signal est prêt.
 *
 * Le buffer est volontairement in-memory : perdu au restart (on re-confirme
 * 5 ticks). Les claims/fills DB survivent.
 */

interface EdgeConfirmState {
  /** BestAsk échantillonnés (dans l'ordre chronologique). */
  samples: number[];
  /** Outcome du token edge confirmé (sticky). */
  edgeOutcome: string;
}

function seriesIsReady(samples: number[], config: BotConfig): boolean {
  if (samples.length < config.edgeConfirmSamples) return false;
  const first = samples[0];
  const lastSample = samples[samples.length - 1];
  const mean = samples.reduce((sum, s) => sum + s, 0) / samples.length;
  // Série globalement croissante : last >= first ET mean > first.
  // Un plat (0.85 × 5) → mean === first → pas d'entrée.
  return lastSample >= first && mean > first;
}

export class EdgeConfirmBuffer {
  private readonly states = new Map<string, EdgeConfirmState>();

  /**
   * Enregistre un sample pour une paire. Retourne true si le signal est prêt
   * (N samples consécutifs valides + série croissante).
   *
   * `edgeOutcome` est le token edge attendu. Si l'identité change (l'autre
   * token devient le favori), on reset le buffer et on re-arme sur le nouveau.
   */
  push(
    pairId: string,
    ask: number,
    edgeOutcome: string,
    config: BotConfig,
  ): boolean {
    const current = this.states.get(pairId);

    // Identité edge changée → reset et re-arme sur le nouveau token.
    if (current && current.edgeOutcome !== edgeOutcome) {
      this.states.delete(pairId);
    }

    const state = this.states.get(pairId) ?? {
      samples: [],
      edgeOutcome,
    };

    // Hors bande → reset.
    if (ask < config.edgeBandMin || ask > config.edgeBandMax) {
      this.states.delete(pairId);
      return false;
    }

    // Drop tick-à-tick trop fort → reset. Tolérance epsilon pour éviter que
    // 0.86 − 0.85 = 0.010000000000000009 ne déclenche un faux reset.
    const last = state.samples[state.samples.length - 1];
    if (last !== undefined && last - ask > config.edgeMaxDownTick + 1e-9) {
      this.states.delete(pairId);
      return false;
    }

    state.samples.push(ask);
    this.states.set(pairId, state);
    return seriesIsReady(state.samples, config);
  }

  /** Reset le buffer d'une paire (cancel hors bande, fenêtre, etc.). */
  reset(pairId: string): void {
    this.states.delete(pairId);
  }

  /** Outcome edge confirmé pour une paire, si un buffer existe. */
  getEdgeOutcome(pairId: string): string | undefined {
    return this.states.get(pairId)?.edgeOutcome;
  }

  /** Nombre de samples accumulés pour une paire (diagnostic). */
  sampleCount(pairId: string): number {
    return this.states.get(pairId)?.samples.length ?? 0;
  }
}
