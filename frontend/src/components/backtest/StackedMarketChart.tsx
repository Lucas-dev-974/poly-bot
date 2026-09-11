import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { BacktestPositionRow, BacktestSeriesPoint, BacktestWindowMeta } from "../../types";
import { fmtSizePair, fmtSpread, fmtUsd, fmtUsdCompact } from "../../utils/format";
import {
  CHART_LABEL_W,
  CHART_PLOT_PAD,
  CHART_ROW_H,
  CHART_WORLD_W,
  LIQUIDITY_COLOR,
  NO_COLOR,
  VOLUME_COLOR,
  YES_COLOR,
  chartContentHeight,
  clampViewBox,
  clientToWorld,
  diamondPoints,
  fittedViewBox,
  fmtClock,
  fmtClockSec,
  fmtPx,
  groupPositionsBySlug,
  isHorizontalEdge,
  isLabelOrPriceGutter,
  lastMid,
  marketRealizedPnl,
  metricScaleMax,
  overlayMarksForWindow,
  markerRadiiWorld,
  isSellMark,
  nearestOverlayHit,
  nearestPoint,
  rowAsset,
  rowIndexAtY,
  rowMetricY,
  rowPriceY,
  rowTimeX,
  seriesPath,
  toChartTimeSec,
  visibleRowRange,
  worldXToTime,
  type ChartViewBox,
  type WalletOverlayMark,
} from "../../utils/stacked-chart";

interface HoverInfo {
  index: number;
  x: number;
  yesY: number | null;
  noY: number | null;
  t: number;
  yes: number | null;
  no: number | null;
  volume: number | null;
  liquidity: number | null;
  upSpread: number | null;
  downSpread: number | null;
  upBidSize: number | null;
  upAskSize: number | null;
  downBidSize: number | null;
  downAskSize: number | null;
  title: string;
  left: number;
  top: number;
  position: HoverPosition | null;
  wallet: HoverWallet | null;
  hasMarketLegs: boolean;
  marketPnl: number | null;
}

interface HoverPosition {
  outcome: string;
  kind: string;
  side: string;
  fillPrice: number;
  size: number;
  status: string;
  pnl: number | null;
}

interface HoverWallet {
  outcome: string;
  side: string;
  fillPrice: number;
  size: number;
}

function fmtMid(value: number | null): string {
  return value == null ? "—" : fmtPx(value);
}

function pnlTone(pnl: number | null): string {
  if (pnl == null) return "";
  return pnl >= 0 ? " yes" : " no";
}

function countMarks<T extends { id: string; ts: number; fillPrice: number; eventSlug: string }>(
  windows: BacktestWindowMeta[],
  bySlug: Map<string, T[]>,
): number {
  let n = 0;
  for (const w of windows) {
    n += overlayMarksForWindow(bySlug.get(w.eventSlug) ?? [], w.windowStart, w.windowEnd).length;
  }
  return n;
}

export function StackedMarketChart(props: {
  windows: BacktestWindowMeta[];
  series: Record<string, BacktestSeriesPoint[]>;
  cutGaps: boolean;
  positions?: BacktestPositionRow[];
  walletMarks?: WalletOverlayMark[];
  walletOn?: boolean;
  walletLoading?: boolean;
  onVisible: (slugs: string[]) => void;
}): JSX.Element {
  let wrap: HTMLDivElement | undefined;
  const [svgEl, setSvgEl] = createSignal<SVGSVGElement | undefined>();
  const [size, setSize] = createSignal({ w: 800, h: 480 });
  const [vb, setVb] = createSignal<ChartViewBox>({ x: 0, y: 0, w: CHART_WORLD_W, h: 480 });
  const [dragging, setDragging] = createSignal(false);
  const [edgeScroll, setEdgeScroll] = createSignal(false);
  const [hover, setHover] = createSignal<HoverInfo | null>(null);
  const [showMetrics, setShowMetrics] = createSignal(true);
  const contentH = createMemo(() => chartContentHeight(props.windows.length));
  const range = createMemo(() => visibleRowRange(vb(), props.windows.length));
  const visibleWindows = createMemo(() => {
    const { start, end } = range();
    return props.windows.slice(start, end);
  });
  const positionsBySlug = createMemo(() => groupPositionsBySlug(props.positions ?? []));
  const walletBySlug = createMemo(() => groupPositionsBySlug(props.walletMarks ?? []));
  const overlayCount = createMemo(() => countMarks(props.windows, positionsBySlug()));
  const walletCount = createMemo(() => countMarks(props.windows, walletBySlug()));
  const marker = createMemo(() => markerRadiiWorld(vb().w, vb().h, size().w, size().h));

  function applyVb(next: ChartViewBox): void {
    setVb(clampViewBox(next, contentH(), size().w, size().h));
  }

  function fit(): void {
    applyVb(fittedViewBox(props.windows.length, size().w, size().h));
  }

  function reportVisible(): void {
    props.onVisible(visibleWindows().map((w) => w.eventSlug));
  }

  createEffect(() => {
    props.windows.length;
    size();
    fit();
  });

  createEffect(() => {
    visibleWindows();
    props.series;
    reportVisible();
  });

  onMount(() => {
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      setSize({ w: Math.max(cr.width, 1), h: Math.max(cr.height, 1) });
    });
    if (wrap) ro.observe(wrap);
    onCleanup(() => ro.disconnect());
  });

  function wheelScrolls(clientX: number, clientY: number, rect: DOMRect): boolean {
    const world = clientToWorld(clientX, clientY, rect, vb());
    return isHorizontalEdge(clientX, rect) || isLabelOrPriceGutter(world.x);
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const el = svgEl();
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cur = vb();
    if (wheelScrolls(e.clientX, e.clientY, rect)) {
      const dy = e.deltaY * (cur.h / Math.max(rect.height, 1));
      applyVb({ ...cur, y: cur.y + dy });
      return;
    }
    const cursor = clientToWorld(e.clientX, e.clientY, rect, cur);
    const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    const w = cur.w * factor;
    const h = cur.h * factor;
    applyVb({
      x: cursor.x - ((cursor.x - cur.x) / cur.w) * w,
      y: cursor.y - ((cursor.y - cur.y) / cur.h) * h,
      w,
      h,
    });
  }

  function updateHover(clientX: number, clientY: number): void {
    const el = svgEl();
    if (!el || dragging()) {
      setHover(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const world = clientToWorld(clientX, clientY, rect, vb());
    const index = rowIndexAtY(world.y, props.windows.length);
    if (index === null || isLabelOrPriceGutter(world.x)) {
      setHover(null);
      return;
    }
    const window = props.windows[index];
    const points = props.series[window.eventSlug] ?? [];
    const t = worldXToTime(world.x, window.windowStart, window.windowEnd);
    const pt = nearestPoint(points, t);
    const xOf = rowTimeX(window.windowStart, window.windowEnd);
    const yOf = rowPriceY(index * CHART_ROW_H);
    const maxDx = (10 / Math.max(rect.width, 1)) * vb().w;
    const legs = positionsBySlug().get(window.eventSlug) ?? [];
    const walletLegs = walletBySlug().get(window.eventSlug) ?? [];
    const runHit = nearestOverlayHit(
      legs,
      world.x,
      window.windowStart,
      window.windowEnd,
      maxDx,
    );
    const walletHit = nearestOverlayHit(
      walletLegs,
      world.x,
      window.windowStart,
      window.windowEnd,
      maxDx,
    );
    const closer =
      runHit && walletHit
        ? runHit.dist <= walletHit.dist
          ? runHit
          : walletHit
        : (runHit ?? walletHit);
    const overlayT = closer ? toChartTimeSec(closer.row.ts) : null;
    const x = overlayT != null ? xOf(overlayT) : pt ? xOf(pt.t) : world.x;
    let yes = pt?.upMid ?? null;
    let no = pt?.downMid ?? null;
    if (closer) {
      if (closer.row.outcomeIndex === 1) no = closer.row.fillPrice;
      else yes = closer.row.fillPrice;
    }
    const overlay = runHit?.row;
    const wallet = walletHit?.row;
    const wrapRect = wrap?.getBoundingClientRect();
    const left = wrapRect ? clientX - wrapRect.left : clientX - rect.left;
    const top = wrapRect ? clientY - wrapRect.top : clientY - rect.top;
    setHover({
      index,
      x,
      yesY: yes != null ? yOf(yes) : null,
      noY: no != null ? yOf(no) : null,
      t: overlayT ?? pt?.t ?? t,
      yes,
      no,
      volume: pt?.volume ?? null,
      liquidity: pt?.liquidity ?? null,
      upSpread: pt?.upSpread ?? null,
      downSpread: pt?.downSpread ?? null,
      upBidSize: pt?.upBidSize ?? null,
      upAskSize: pt?.upAskSize ?? null,
      downBidSize: pt?.downBidSize ?? null,
      downAskSize: pt?.downAskSize ?? null,
      title: window.eventTitle || `${rowAsset(window.eventSlug)} · ${fmtClock(window.windowStart)}`,
      left,
      top,
      hasMarketLegs: legs.length > 0,
      marketPnl: marketRealizedPnl(legs),
      position: overlay
        ? {
            outcome: overlay.outcome,
            kind: overlay.kind,
            side: overlay.side,
            fillPrice: overlay.fillPrice,
            size: overlay.size,
            status: overlay.status,
            pnl: overlay.pnl,
          }
        : null,
      wallet: wallet
        ? {
            outcome: wallet.outcome,
            side: wallet.side,
            fillPrice: wallet.fillPrice,
            size: wallet.size,
          }
        : null,
    });
  }

  function onPointerMoveCursor(e: PointerEvent): void {
    const el = svgEl();
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setEdgeScroll(wheelScrolls(e.clientX, e.clientY, rect));
    updateHover(e.clientX, e.clientY);
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !svgEl()) return;
    setHover(null);
    svgEl()!.setPointerCapture(e.pointerId);
    setDragging(true);
    const origin = { x: e.clientX, y: e.clientY, vb: vb() };
    const rect0 = svgEl()!.getBoundingClientRect();

    const move = (ev: PointerEvent) => {
      const dx = ((ev.clientX - origin.x) / Math.max(rect0.width, 1)) * origin.vb.w;
      const dy = ((ev.clientY - origin.y) / Math.max(rect0.height, 1)) * origin.vb.h;
      applyVb({
        ...origin.vb,
        x: origin.vb.x - dx,
        y: origin.vb.y - dy,
      });
    };
    const up = (ev: PointerEvent) => {
      svgEl()?.releasePointerCapture(ev.pointerId);
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function zoomBy(factor: number): void {
    const cur = vb();
    const cx = cur.x + cur.w / 2;
    const cy = cur.y + cur.h / 2;
    const w = cur.w * factor;
    const h = cur.h * factor;
    applyVb({ x: cx - w / 2, y: cy - h / 2, w, h });
  }

  createEffect(() => {
    const el = svgEl();
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => el.removeEventListener("wheel", onWheel));
  });

  return (
    <div class="bt-chart">
      <div class="bt-chart-bar">
        <span class="bt-legend">
          <span class="bt-swatch yes" />
          Yes
          <span class="bt-swatch no" />
          No
          <button
            class={`bt-legend-toggle${showMetrics() ? " is-on" : ""}`}
            type="button"
            title="Volume et liquidité enregistrés"
            onClick={() => setShowMetrics((v) => !v)}
          >
            <span class="bt-swatch vol" />
            Vol
            <span class="bt-swatch liq" />
            Liq
          </button>
          <Show when={(props.positions ?? []).length > 0}>
            <span class="bt-swatch-mark buy" />
            Run
            <span class="bt-chart-pos">{overlayCount()}</span>
            <span class="bt-swatch-mark sell" />
            Sell
          </Show>
          <Show when={props.walletOn}>
            <span class="bt-swatch-mark wallet" />
            Wallet
            <span class="bt-chart-pos bt-chart-wal">
              {props.walletLoading ? "…" : walletCount()}
            </span>
          </Show>
        </span>
        <span class="bt-chart-count">{props.windows.length}</span>
        <div class="bt-zoom">
          <button class="bt-icon-btn" type="button" title="Zoom +" onClick={() => zoomBy(1 / 1.25)}>
            +
          </button>
          <button class="bt-icon-btn" type="button" title="Zoom −" onClick={() => zoomBy(1.25)}>
            −
          </button>
          <button class="bt-icon-btn" type="button" title="Fit" onClick={() => fit()}>
            ⌂
          </button>
        </div>
      </div>
      <div
        class="bt-svg-wrap"
        ref={(el) => {
          wrap = el;
        }}
      >
        <Show when={props.windows.length === 0}>
          <div class="bt-empty">Aucun marché enregistré pour ces filtres.</div>
        </Show>
        <Show when={props.windows.length > 0}>
          <svg
            ref={setSvgEl}
            class={`bt-svg${dragging() ? " is-panning" : ""}${edgeScroll() ? " is-edge-scroll" : ""}${hover() && !edgeScroll() ? " is-reading" : ""}`}
            viewBox={`${vb().x} ${vb().y} ${vb().w} ${vb().h}`}
            preserveAspectRatio="none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMoveCursor}
            onPointerLeave={() => {
              setEdgeScroll(false);
              setHover(null);
            }}
          >
            <For each={visibleWindows()}>
              {(w, i) => (
                <MarketRow
                  window={w}
                  index={range().start + i()}
                  points={props.series[w.eventSlug] ?? []}
                  cutGaps={props.cutGaps}
                  showMetrics={showMetrics()}
                  positions={positionsBySlug().get(w.eventSlug) ?? []}
                  walletMarks={walletBySlug().get(w.eventSlug) ?? []}
                  markerRx={marker().rx}
                  markerRy={marker().ry}
                />
              )}
            </For>
            <Show when={hover()}>
              {(h) => (
                <g class="bt-cursor" pointer-events="none">
                  <rect
                    x={0}
                    y={h().index * CHART_ROW_H}
                    width={CHART_WORLD_W}
                    height={CHART_ROW_H}
                    fill="rgba(79,140,255,0.07)"
                  />
                  <line
                    x1={h().x}
                    y1={h().index * CHART_ROW_H}
                    x2={h().x}
                    y2={h().index * CHART_ROW_H + CHART_ROW_H}
                    stroke="rgba(255,255,255,0.55)"
                    stroke-width="1"
                    vector-effect="non-scaling-stroke"
                  />
                  <Show when={h().yesY != null}>
                    <circle cx={h().x} cy={h().yesY!} r="2.4" fill={YES_COLOR} vector-effect="non-scaling-stroke" />
                  </Show>
                  <Show when={h().noY != null}>
                    <circle cx={h().x} cy={h().noY!} r="2.4" fill={NO_COLOR} vector-effect="non-scaling-stroke" />
                  </Show>
                </g>
              )}
            </Show>
          </svg>
          <Show when={hover()}>
            {(h) => (
              <div
                class="bt-tip"
                style={{
                  left: `${h().left > size().w - 180 ? h().left - 168 : h().left + 12}px`,
                  top: `${Math.max(8, h().top - 8)}px`,
                }}
              >
                <div class="bt-tip-mkt">{h().title}</div>
                <div class="bt-tip-t">{fmtClockSec(h().t)}</div>
                <div class="bt-tip-row yes">
                  Yes <span>{fmtMid(h().yes)}</span>
                </div>
                <div class="bt-tip-row no">
                  No <span>{fmtMid(h().no)}</span>
                </div>
                <Show
                  when={
                    h().upSpread != null ||
                    h().downSpread != null ||
                    h().upBidSize != null ||
                    h().upAskSize != null ||
                    h().downBidSize != null ||
                    h().downAskSize != null
                  }
                >
                  <div class="bt-tip-row spr">
                    Spr Yes <span>{fmtSpread(h().upSpread)}</span>
                  </div>
                  <div class="bt-tip-row spr">
                    Spr No <span>{fmtSpread(h().downSpread)}</span>
                  </div>
                  <div class="bt-tip-row sz">
                    Sz Yes <span>{fmtSizePair(h().upBidSize, h().upAskSize)}</span>
                  </div>
                  <div class="bt-tip-row sz">
                    Sz No <span>{fmtSizePair(h().downBidSize, h().downAskSize)}</span>
                  </div>
                </Show>
                <Show when={showMetrics()}>
                  <div class="bt-tip-row vol">
                    Vol <span>{fmtUsdCompact(h().volume)}</span>
                  </div>
                  <div class="bt-tip-row liq">
                    Liq <span>{fmtUsdCompact(h().liquidity)}</span>
                  </div>
                </Show>
                <Show when={h().hasMarketLegs}>
                  <div class={`bt-tip-row bt-tip-pnl${pnlTone(h().marketPnl)}`}>
                    PnL <span>{h().marketPnl == null ? "—" : fmtUsd(h().marketPnl)}</span>
                  </div>
                </Show>
                <Show when={h().position}>
                  {(p) => (
                    <>
                      <div class="bt-tip-pos">
                        Run · {p().side} {p().outcome} · {p().kind} · {p().status}
                      </div>
                      <div class="bt-tip-row">
                        Fill <span>{fmtPx(p().fillPrice)}</span>
                      </div>
                      <div class="bt-tip-row">
                        Size <span>{p().size.toFixed(2)}</span>
                      </div>
                      <div class={`bt-tip-row${pnlTone(p().pnl)}`}>
                        Fill PnL <span>{p().pnl == null ? "—" : fmtUsd(p().pnl)}</span>
                      </div>
                    </>
                  )}
                </Show>
                <Show when={h().wallet}>
                  {(w) => (
                    <>
                      <div class="bt-tip-pos bt-tip-wallet">
                        Wallet · {w().side} {w().outcome}
                      </div>
                      <div class="bt-tip-row">
                        Fill <span>{fmtPx(w().fillPrice)}</span>
                      </div>
                      <div class="bt-tip-row">
                        Size <span>{w().size.toFixed(2)}</span>
                      </div>
                    </>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}

function MarketRow(props: {
  window: BacktestWindowMeta;
  index: number;
  points: BacktestSeriesPoint[];
  cutGaps: boolean;
  showMetrics: boolean;
  positions: BacktestPositionRow[];
  walletMarks: WalletOverlayMark[];
  markerRx: number;
  markerRy: number;
}): JSX.Element {
  const top = () => props.index * CHART_ROW_H;
  const x = () => rowTimeX(props.window.windowStart, props.window.windowEnd);
  const y = () => rowPriceY(top());
  const metricMax = () => metricScaleMax(props.points);
  const yMetric = () => rowMetricY(top(), metricMax());
  const plotLeft = CHART_LABEL_W + CHART_PLOT_PAD.left;
  const plotRight = CHART_WORLD_W - CHART_PLOT_PAD.right;
  const midY = () => top() + CHART_ROW_H / 2;
  const yesD = () => seriesPath(props.points, "upMid", x(), y(), props.cutGaps);
  const noD = () => seriesPath(props.points, "downMid", x(), y(), props.cutGaps);
  const volD = () =>
    props.showMetrics && metricMax() > 0
      ? seriesPath(props.points, "volume", x(), yMetric(), props.cutGaps)
      : "";
  const liqD = () =>
    props.showMetrics && metricMax() > 0
      ? seriesPath(props.points, "liquidity", x(), yMetric(), props.cutGaps)
      : "";
  const yesLast = () => lastMid(props.points, "upMid");
  const noLast = () => lastMid(props.points, "downMid");
  const labelY = () => top() + CHART_ROW_H / 2 + 3;
  const marks = createMemo(() =>
    overlayMarksForWindow(props.positions, props.window.windowStart, props.window.windowEnd),
  );
  const walletMarks = createMemo(() =>
    overlayMarksForWindow(props.walletMarks, props.window.windowStart, props.window.windowEnd),
  );

  return (
    <g class="bt-mkt">
      <rect
        x={0}
        y={top()}
        width={CHART_WORLD_W}
        height={CHART_ROW_H}
        fill={props.index % 2 === 0 ? "rgba(255,255,255,0.018)" : "transparent"}
      />
      <line
        x1={0}
        y1={top() + CHART_ROW_H}
        x2={CHART_WORLD_W}
        y2={top() + CHART_ROW_H}
        stroke="rgba(255,255,255,0.05)"
        vector-effect="non-scaling-stroke"
      />
      <line
        x1={CHART_LABEL_W}
        y1={top()}
        x2={CHART_LABEL_W}
        y2={top() + CHART_ROW_H}
        stroke="rgba(255,255,255,0.06)"
        vector-effect="non-scaling-stroke"
      />
      <line
        x1={plotLeft}
        y1={midY()}
        x2={plotRight}
        y2={midY()}
        stroke="rgba(255,255,255,0.04)"
        vector-effect="non-scaling-stroke"
      />
      <circle
        cx={8}
        cy={labelY() - 1}
        r={1.6}
        fill={props.window.complete ? YES_COLOR : "#f1c40f"}
      />
      <text x={15} y={labelY()} class="bt-svg-title">
        {rowAsset(props.window.eventSlug)}
      </text>
      <Show when={volD()}>
        <path
          d={volD()}
          fill="none"
          stroke={VOLUME_COLOR}
          stroke-width="1"
          stroke-linejoin="round"
          stroke-linecap="round"
          opacity="0.85"
          vector-effect="non-scaling-stroke"
        />
      </Show>
      <Show when={liqD()}>
        <path
          d={liqD()}
          fill="none"
          stroke={LIQUIDITY_COLOR}
          stroke-width="1"
          stroke-dasharray="4 3"
          stroke-linejoin="round"
          stroke-linecap="round"
          opacity="0.9"
          vector-effect="non-scaling-stroke"
        />
      </Show>
      <Show when={yesD()}>
        <path
          d={yesD()}
          fill="none"
          stroke={YES_COLOR}
          stroke-width="1.2"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
        />
      </Show>
      <Show when={noD()}>
        <path
          d={noD()}
          fill="none"
          stroke={NO_COLOR}
          stroke-width="1.2"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
        />
      </Show>
      <Show when={yesLast() != null}>
        <text x={CHART_WORLD_W - 5} y={top() + 13} class="bt-svg-px yes" text-anchor="end">
          {fmtPx(yesLast()!)}
        </text>
      </Show>
      <Show when={noLast() != null}>
        <text x={CHART_WORLD_W - 5} y={top() + CHART_ROW_H - 5} class="bt-svg-px no" text-anchor="end">
          {fmtPx(noLast()!)}
        </text>
      </Show>
      <g class="bt-pos-marks" pointer-events="none">
        <For each={marks()}>
          {(p) => {
            const t = toChartTimeSec(p.ts);
            const cx = x()(t);
            const cy = y()(p.fillPrice);
            const color = p.outcomeIndex === 1 ? NO_COLOR : YES_COLOR;
            const sell = isSellMark(p);
            if (sell) {
              // Marqueur de vente : croix rouge au prix de revente.
              const r = props.markerRx;
              return (
                <g pointer-events="none">
                  <line
                    x1={cx - r}
                    y1={cy - r}
                    x2={cx + r}
                    y2={cy + r}
                    stroke="#ff4444"
                    stroke-width="2"
                    vector-effect="non-scaling-stroke"
                  />
                  <line
                    x1={cx - r}
                    y1={cy + r}
                    x2={cx + r}
                    y2={cy - r}
                    stroke="#ff4444"
                    stroke-width="2"
                    vector-effect="non-scaling-stroke"
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r * 0.4}
                    fill="none"
                    stroke="#ff4444"
                    stroke-width="1"
                    vector-effect="non-scaling-stroke"
                  />
                </g>
              );
            }
            return (
              <ellipse
                cx={cx}
                cy={cy}
                rx={props.markerRx}
                ry={props.markerRy}
                fill={color}
                stroke="rgba(255,255,255,0.9)"
                stroke-width="1"
                vector-effect="non-scaling-stroke"
              />
            );
          }}
        </For>
        <For each={walletMarks()}>
          {(p) => {
            const t = toChartTimeSec(p.ts);
            const cx = x()(t);
            const cy = y()(p.fillPrice);
            const color = p.outcomeIndex === 1 ? NO_COLOR : YES_COLOR;
            return (
              <polygon
                points={diamondPoints(cx, cy, props.markerRy)}
                fill={color}
                stroke="rgba(255,255,255,0.95)"
                stroke-width="1"
                vector-effect="non-scaling-stroke"
              />
            );
          }}
        </For>
      </g>
    </g>
  );
}
