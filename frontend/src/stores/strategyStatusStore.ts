/**
 * Store du statut whipsaw du bot LIVE (fav-band).
 * Event SSE `strategyStatus` (toutes les 5 s) + GET /api/strategy/status.
 */
import { createWhipsawStore } from "./whipsawStore";

const store = createWhipsawStore();

export const strategyStatus = store.snapshot;
export const setStrategyStatus = store.set;
export const remainingMsAt = store.remainingMsAt;
