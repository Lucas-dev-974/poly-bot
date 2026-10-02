/**
 * Fenêtre visible pour listes/tables longues (même idée que visibleWindows
 * du StackedMarketChart) : ne monter que les lignes dans le viewport + overscan.
 */
export const VIRTUALIZE_THRESHOLD = 200;

export function visibleRowRange(
  scrollTop: number,
  viewportH: number,
  rowCount: number,
  rowH: number,
  overscan = 8,
): { start: number; end: number } {
  if (rowCount <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(rowCount, Math.ceil((scrollTop + Math.max(viewportH, rowH)) / rowH) + overscan);
  return { start, end };
}

export function sliceVisible<T>(items: readonly T[], start: number, end: number): T[] {
  if (start <= 0 && end >= items.length) return items as T[];
  return items.slice(start, end);
}
