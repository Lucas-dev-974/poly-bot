/**
 * Registre EXPORT/IMPORT des tables de snapshots marché — source de vérité
 * partagée entre l'export (CSV/NDJSON/SQLite) et l'import (staging + merge).
 *
 * Les specs voyagent vers le worker (snapshot-io-worker.cjs) via workerData :
 * le worker est GÉNÉRIQUE et ne hardcode aucune colonne. La colonne `id`
 * AUTOINCREMENT n'est jamais exportée ni importée (ids frais à l'insertion).
 * `ts` = epoch millisecondes UTC partout.
 *
 * ⚠ Colonnes calquées sur le schéma runtime (src/db/database.ts + les
 * migrations addColumnIfMissing de book_snapshots) — toute évolution de
 * schéma de snapshot doit être reflétée ici (cf. pages/data/meta.ts côté UI).
 */

export type SnapshotTableName =
  | "book_snapshots"
  | "market_snapshots"
  | "market_resolutions";

export interface SnapshotColSpec {
  name: string;
  type: "integer" | "real" | "text";
  /** NOT NULL dans le schéma SQLite → une ligne sans cette valeur est invalide. */
  required: boolean;
}

export interface SnapshotTableSpec {
  name: SnapshotTableName;
  cols: SnapshotColSpec[];
  /** Clé naturelle de déduplication du merge. */
  dedupeKey: string[];
  /**
   * Étendue du « Remplacer la plage » : "range+slug" (snapshots : plage ts ×
   * slugs présents dans le fichier) ou "key" (market_resolutions : PK).
   */
  replaceScope: "range+slug" | "key";
}

export const BOOK_SNAPSHOT_COLS: SnapshotColSpec[] = [
  { name: "ts", type: "integer", required: true },
  { name: "eventSlug", type: "text", required: true },
  { name: "tokenId", type: "text", required: true },
  { name: "outcome", type: "text", required: true },
  { name: "outcomeIndex", type: "integer", required: true },
  { name: "bestBid", type: "real", required: false },
  { name: "bestAsk", type: "real", required: false },
  { name: "bestAskSize", type: "real", required: false },
  { name: "bestBidSize", type: "real", required: false },
  { name: "ask2", type: "real", required: false },
  { name: "ask2Size", type: "real", required: false },
  { name: "ask3", type: "real", required: false },
  { name: "ask3Size", type: "real", required: false },
  { name: "bid2", type: "real", required: false },
  { name: "bid2Size", type: "real", required: false },
  { name: "bid3", type: "real", required: false },
  { name: "bid3Size", type: "real", required: false },
];

export const MARKET_SNAPSHOT_COLS: SnapshotColSpec[] = [
  { name: "ts", type: "integer", required: true },
  { name: "eventSlug", type: "text", required: true },
  { name: "eventTitle", type: "text", required: true },
  { name: "conditionId", type: "text", required: true },
  { name: "windowStart", type: "integer", required: true },
  { name: "windowEnd", type: "integer", required: true },
  { name: "volume", type: "real", required: false },
  { name: "volume24hr", type: "real", required: false },
  { name: "liquidity", type: "real", required: false },
  { name: "lastTradePrice", type: "real", required: false },
  { name: "spread", type: "real", required: false },
];

export const MARKET_RESOLUTION_COLS: SnapshotColSpec[] = [
  { name: "eventSlug", type: "text", required: true },
  { name: "winnerOutcomeIndex", type: "integer", required: true },
  { name: "source", type: "text", required: true },
  { name: "ts", type: "integer", required: true },
];

export const SNAPSHOT_TABLE_SPECS: Record<SnapshotTableName, SnapshotTableSpec> = {
  book_snapshots: {
    name: "book_snapshots",
    cols: BOOK_SNAPSHOT_COLS,
    dedupeKey: ["ts", "tokenId"],
    replaceScope: "range+slug",
  },
  market_snapshots: {
    name: "market_snapshots",
    cols: MARKET_SNAPSHOT_COLS,
    dedupeKey: ["ts", "eventSlug"],
    replaceScope: "range+slug",
  },
  market_resolutions: {
    name: "market_resolutions",
    cols: MARKET_RESOLUTION_COLS,
    dedupeKey: ["eventSlug"],
    replaceScope: "key",
  },
};

export const SNAPSHOT_TABLE_NAMES: SnapshotTableName[] = [
  "book_snapshots",
  "market_snapshots",
  "market_resolutions",
];

/** Alias paramètre API → table de registre (book / market). */
export function resolveTableParam(
  raw: string,
): SnapshotTableName | null {
  switch (raw.toLowerCase()) {
    case "book":
    case "book_snapshots":
      return "book_snapshots";
    case "market":
    case "market_snapshots":
      return "market_snapshots";
    default:
      return null;
  }
}

export function specFor(
  name: SnapshotTableName,
): SnapshotTableSpec {
  return SNAPSHOT_TABLE_SPECS[name];
}

/** Liste des colonnes exportables (hors id — l'ordre = header CSV). */
export function exportableCols(
  spec: SnapshotTableSpec,
): string[] {
  return spec.cols.map((c) => c.name);
}