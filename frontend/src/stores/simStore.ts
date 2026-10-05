import { createSignal } from "solid-js";
import type { BotConfig, SimBalance, SimConfigState, SimulatedPosition, SimulatedStats } from "../types";
import type { SimResolvedPagedResponse, SimRestingOrder, SimTrade } from "../api/client";

/** État live du moteur paper trading (simulation). */
export const [simBalance, setSimBalance] = createSignal<SimBalance | null>(null);
export const [simConfigState, setSimConfigState] = createSignal<SimConfigState | null>(null);
/** Config effective du moteur (preset + settings appliqués) — panneau config 5m. */
export const [simEffectiveConfig, setSimEffectiveConfig] = createSignal<BotConfig | null>(null);
export const [simOpenPositions, setSimOpenPositions] = createSignal<SimulatedPosition[]>([]);
export const [simResolvedPositions, setSimResolvedPositions] = createSignal<SimulatedPosition[]>([]);

// ── Pagination des positions résolues sim ────────────────────────────────────
// La liste affichée vient de /api/sim/resolved (DB complète, sans les plafonds
// slice(0, 200) ni MAX_RESOLVED_IN_MEMORY) ; total/totalPages viennent du
// COUNT SQL côté backend.
interface SimResolvedPaging {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Tailles de page autorisées par le backend (SIM_RESOLVED_PAGE_SIZES). */
export const SIM_RESOLVED_PAGE_SIZES = [25, 50, 100, 200];
const SIM_RESOLVED_PAGE_SIZE_KEY = "sim-resolved-pageSize";
const DEFAULT_RESOLVED_PAGE_SIZE = 50;

function initialResolvedPageSize(): number {
  try {
    const n = Number(localStorage.getItem(SIM_RESOLVED_PAGE_SIZE_KEY));
    return SIM_RESOLVED_PAGE_SIZES.includes(n) ? n : DEFAULT_RESOLVED_PAGE_SIZE;
  } catch {
    return DEFAULT_RESOLVED_PAGE_SIZE;
  }
}

const DEFAULT_PAGING: SimResolvedPaging = {
  page: 1,
  pageSize: DEFAULT_RESOLVED_PAGE_SIZE,
  total: 0,
  totalPages: 1,
};

/** État de pagination de l'onglet « Positions résolues » (page 1-based). */
export const [simResolvedPaging, setSimResolvedPaging] = createSignal<SimResolvedPaging>({
  ...DEFAULT_PAGING,
  pageSize: initialResolvedPageSize(),
});

/**
 * True quand la liste affichée vient d'une réponse paginée (/api/sim/resolved).
 * False = mode vivant (hydratation /api/sim/state, préfixe SSE non tronqué) —
 * fallback si le fetch paginé échoue.
 */
export const [simResolvedPagedActive, setSimResolvedPagedActive] = createSignal(false);

/** Applique une réponse paginée /api/sim/resolved : liste + métadonnées. */
function applySimResolvedPage(res: SimResolvedPagedResponse): void {
  setSimResolvedPositions(res.positions);
  setSimResolvedPagedActive(true);
  setSimResolvedPaging({
    page: Math.max(1, Math.floor(res.page)),
    pageSize: res.pageSize,
    total: res.total,
    totalPages: Math.max(1, res.totalPages),
  });
}

/** Change la taille de page (persistée en localStorage) et revient à la page 1. */
export function setSimResolvedPageSize(size: number): void {
  if (!SIM_RESOLVED_PAGE_SIZES.includes(size)) return;
  setSimResolvedPaging((p) => ({
    ...p,
    pageSize: size,
    page: 1,
    totalPages: Math.max(1, Math.ceil(p.total / size)),
  }));
  try {
    localStorage.setItem(SIM_RESOLVED_PAGE_SIZE_KEY, String(size));
  } catch {
    // localStorage indisponible (navigation privée) — persistence best-effort.
  }
}

/**
 * Charge une page de positions résolues depuis /api/sim/resolved (DB complète).
 * Met à jour liste + métadonnées. Retourne null en cas d'échec (l'appelant
 * garde alors ses données affichées et peut afficher une erreur).
 */
export async function fetchSimResolvedPage(
  page: number,
  pageSize: number,
): Promise<SimResolvedPagedResponse | null> {
  const { api } = await import("../api/client");
  try {
    const data = await api.simResolvedPaged(page, pageSize);
    applySimResolvedPage(data);
    return data;
  } catch {
    return null;
  }
}

/** Reset pagination (après « Archiver résolues », reset moteur, SSE reconnect). */
export function resetSimResolvedPaging(): void {
  setSimResolvedPagedActive(false);
  setSimResolvedPaging({ ...DEFAULT_PAGING, pageSize: initialResolvedPageSize() });
}

/**
 * Mise à jour SSE d'une position résolue : injectée en tête de la liste
 * UNIQUEMENT si la page 1 est affichée. En mode paginé la liste est tronquée à
 * pageSize (cohérent avec la pagination serveur : la dernière ligne rejoint la
 * page 2) ; en mode vivant, comportement historique (préfixe non tronqué).
 * Le compteur total/totalPages n'est incrémenté qu'en mode paginé (sinon le
 * total réel est inconnu et reste 0 jusqu'au premier fetch paginé).
 */
export function resolveSimPosition(position: SimulatedPosition): void {
  if (simResolvedPagedActive()) {
    setSimResolvedPaging((p) => {
      const total = p.total + 1;
      return { ...p, total, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) };
    });
  }
  setSimResolvedPositions((prev) => {
    const withoutDup = prev.filter((p) => p.id !== position.id);
    if (simResolvedPagedActive() && simResolvedPaging().page !== 1) return withoutDup;
    const next = [position, ...withoutDup];
    return simResolvedPagedActive() ? next.slice(0, simResolvedPaging().pageSize) : next;
  });
  removeSimOpen(position);
}

export function upsertSimOpen(position: SimulatedPosition): void {
  setSimOpenPositions((prev) => {
    const idx = prev.findIndex((p) => p.id === position.id);
    if (idx >= 0) {
      const next = [...prev];
      next[idx] = position;
      return next;
    }
    return [...prev, position];
  });
}

function removeSimOpen(position: SimulatedPosition): void {
  // Les variantes vendues (:sold-xxx) partagent le préfixe d'id de l'origine.
  setSimOpenPositions((prev) =>
    prev.filter((p) => p.id !== position.id && !p.id.startsWith(`${position.id}:sold-`)),
  );
}

/**
 * Remplace les listes de positions (hydratation REST /api/sim/state). La liste
 * résolue sert d'interim avant le fetch paginé de la page courante (la page
 * Simulation re-fetch immédiatement) et de fallback si ce fetch échoue.
 */
export function replaceSimLists(open: SimulatedPosition[], resolved: SimulatedPosition[]): void {
  setSimOpenPositions(open);
  setSimResolvedPositions(resolved);
  setSimResolvedPagedActive(false);
}

/** Remplace resting + journal (hydratation REST /api/sim/state, poll adaptatif). */
export function replaceSimRestingAndJournal(
  resting: SimRestingOrder[],
  journal: SimTrade[],
): void {
  setSimResting(resting);
  setSimJournal(journal);
}

/**
 * Stats du moteur paper (event SSE `simStats`). Nommage explicite : l'homonymie
 * historique avec statsStore.simStats (global) était une source de confusion.
 */
export const [simEngineStats, setSimEngineStats] = createSignal<SimulatedStats | null>(null);
/**
 * Ordres en attente (GTC papier) + journal des ordres — sortaient de signaux
 * locaux de SimulationPage (perdus à la navigation). Hydratés par /api/sim/state
 * + le poll adaptatif, mis à jour par le dispatcher pour la partie SSE.
 */
export const [simResting, setSimResting] = createSignal<SimRestingOrder[]>([]);
export const [simJournal, setSimJournal] = createSignal<SimTrade[]>([]);