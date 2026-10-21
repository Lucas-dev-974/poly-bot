/**
 * Store du statut whipsaw du moteur PAPER (fav-band).
 * Event SSE `simStrategyStatus` (toutes les 5 s) + GET
 * /api/sim/strategy-status. La pause est armée par les pertes des positions
 * SIMULÉES, jamais par le live.
 */
import { createWhipsawStore } from "./whipsawStore";

const store = createWhipsawStore();

export const simWhipsaw = store.snapshot;
export const setSimWhipsaw = store.set;
export const simRemainingMsAt = store.remainingMsAt;
