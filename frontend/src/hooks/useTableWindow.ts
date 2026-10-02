import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import {
  VIRTUALIZE_THRESHOLD,
  sliceVisible,
  visibleRowRange,
} from "../utils/visible-window";

export type TableWindow = {
  /** True dès que rowCount ≥ threshold — active le cage scroll + spacers. */
  active: Accessor<boolean>;
  range: Accessor<{ start: number; end: number }>;
  padTop: Accessor<number>;
  padBottom: Accessor<number>;
  rowHeight: number;
  maxHeightPx: number;
  /** Style du conteneur scroll (max-height seulement si actif). */
  scrollerStyle: Accessor<Record<string, string> | undefined>;
  onScroll: (e: Event) => void;
  setRef: (el: HTMLElement | undefined) => void;
  /** Slice des items visibles (+ overscan). */
  slice: <T>(items: readonly T[]) => T[];
};

/**
 * Virtualiseur de lignes de table. Sous le seuil : rendu complet, pas de
 * contrainte de hauteur. Au-delà : viewport fixe + spacers pour préserver
 * le scrollHeight.
 */
export function useTableWindow(
  rowCount: Accessor<number>,
  opts?: { rowHeight?: number; overscan?: number; threshold?: number; maxHeightPx?: number },
): TableWindow {
  const rowHeight = opts?.rowHeight ?? 32;
  const overscan = opts?.overscan ?? 8;
  const threshold = opts?.threshold ?? VIRTUALIZE_THRESHOLD;
  const maxHeightPx = opts?.maxHeightPx ?? 480;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(maxHeightPx);

  let ro: ResizeObserver | undefined;

  const active = createMemo(() => rowCount() >= threshold);
  const range = createMemo(() => {
    const n = rowCount();
    if (!active()) return { start: 0, end: n };
    return visibleRowRange(scrollTop(), viewportH(), n, rowHeight, overscan);
  });
  const padTop = createMemo(() => (active() ? range().start * rowHeight : 0));
  const padBottom = createMemo(() =>
    active() ? Math.max(0, (rowCount() - range().end) * rowHeight) : 0,
  );
  const scrollerStyle = createMemo(() =>
    active()
      ? { "max-height": `${maxHeightPx}px`, overflow: "auto" }
      : undefined,
  );

  // Si la liste raccourcit sous le scroll courant, ramener scrollTop pour
  // éviter un viewport vide (padTop énorme + slice vide).
  createEffect(() => {
    const n = rowCount();
    if (!active()) {
      if (scrollTop() !== 0) setScrollTop(0);
      return;
    }
    const maxScroll = Math.max(0, n * rowHeight - viewportH());
    if (scrollTop() > maxScroll) setScrollTop(maxScroll);
  });

  function onScroll(e: Event): void {
    setScrollTop((e.currentTarget as HTMLElement).scrollTop);
  }

  function setRef(el: HTMLElement | undefined): void {
    ro?.disconnect();
    ro = undefined;
    if (!el) return;
    setViewportH(el.clientHeight || maxHeightPx);
    setScrollTop(el.scrollTop);
    ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h != null && h > 0) setViewportH(h);
    });
    ro.observe(el);
  }

  onCleanup(() => {
    ro?.disconnect();
    ro = undefined;
  });

  function slice<T>(items: readonly T[]): T[] {
    const { start, end } = range();
    return sliceVisible(items, start, end);
  }

  return {
    active,
    range,
    padTop,
    padBottom,
    rowHeight,
    maxHeightPx,
    scrollerStyle,
    onScroll,
    setRef,
    slice,
  };
}
