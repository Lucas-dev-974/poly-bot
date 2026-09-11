import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { CHART_COLORS } from "../utils/chart";
import { askAt, fmtPlayClock, type ReplaySignal } from "./chart-rule-replay";
import {
  chartRuleIndexLabel,
  chartRuleLegend,
  chartRuleLinks,
  guessRuleFromBand,
  linkChartRules,
  newChartRule,
  snapChartBand,
  snapChartRange,
  snapMovedRule,
  translateChartRule,
  unlinkChartRules,
  type ChartRule,
} from "./graph-types";

export type ChartSeriesPoint = { t: number; ask: number | null; bid: number | null };

export type ChartFillMark = {
  t: number;
  price: number;
  outcomeIndex: number;
  side: "BUY" | "SELL";
};

const PAD = { top: 16, right: 22, bottom: 28, left: 50 };
const MIN_DRAG_PX = 8;
const HANDLE_W = 10;
const HANDLE_H = 10;
const PORT_R = 6;
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

type Drag =
  | { kind: "create"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "resize"; ruleId: string; edge: "start" | "end"; x: number }
  | { kind: "resize-band"; ruleId: string; edge: "min" | "max"; y: number }
  | {
      kind: "move";
      ruleId: string;
      origin: ChartRule;
      x0: number;
      y0: number;
      x: number;
      y: number;
    }
  | { kind: "link"; fromId: string; x0: number; y0: number; x: number; y: number };

function linkBezier(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(36, Math.abs(x2 - x1) * 0.4);
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

export function ChartRulesCanvas(props: {
  durationSec: number;
  windowStartUnix: number;
  up: ChartSeriesPoint[];
  down: ChartSeriesPoint[];
  fills?: ChartFillMark[];
  signals?: ReplaySignal[];
  playheadSec: number;
  showYes: boolean;
  showNo: boolean;
  tooltipEnabled: boolean;
  rules: ChartRule[];
  selectedRuleId: string | null;
  onSelectRule: (id: string | null) => void;
  onRulesChange: (rules: ChartRule[]) => void;
  onLinkRejected?: (message: string) => void;
  onSeek?: (sec: number) => void;
}): JSX.Element {
  let wrapRef: HTMLDivElement | undefined;
  let svgRef: SVGSVGElement | undefined;
  const [size, setSize] = createSignal({ w: 1, h: 1 });
  const [drag, setDrag] = createSignal<Drag | null>(null);
  const [hover, setHover] = createSignal<{ x: number; y: number; sec: number } | null>(null);
  const [altDown, setAltDown] = createSignal(false);
  const [selectedLink, setSelectedLink] = createSignal<{ fromId: string; toId: string } | null>(
    null,
  );

  createEffect(() => {
    const link = selectedLink();
    if (!link) return;
    const stillThere = chartRuleLinks(props.rules).some(
      (item) => item.fromId === link.fromId && item.toId === link.toId,
    );
    if (!stillThere) setSelectedLink(null);
  });

  onMount(() => {
    const el = wrapRef;
    if (!el) return;
    const measure = () => {
      setSize({
        w: Math.max(el.clientWidth, 1),
        h: Math.max(el.clientHeight, 1),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const syncAlt = (e: KeyboardEvent | PointerEvent | MouseEvent) => {
      setAltDown("altKey" in e ? e.altKey : false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltDown(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt" || !e.altKey) setAltDown(false);
    };
    const onDelete = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const link = selectedLink();
      if (!link) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) {
        return;
      }
      e.preventDefault();
      props.onRulesChange(unlinkChartRules(props.rules, link.fromId, link.toId));
      setSelectedLink(null);
    };
    const onBlur = () => setAltDown(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onDelete);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointermove", syncAlt);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onDelete);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointermove", syncAlt);
    });
  });

  const layout = createMemo(() => {
    const w = size().w;
    const h = size().h;
    const plotW = Math.max(w - PAD.left - PAD.right, 1);
    const plotH = Math.max(h - PAD.top - PAD.bottom, 1);
    const duration = Math.max(props.durationSec, 1);
    const origin = props.windowStartUnix;
    const playhead = Math.min(Math.max(props.playheadSec, 0), duration);
    const showYes = props.showYes;
    const showNo = props.showNo;
    const secToX = (sec: number) => PAD.left + (sec / duration) * plotW;
    const yPrice = (p: number) =>
      PAD.top + (1 - Math.min(Math.max(p, 0), 1)) * plotH;
    const yToPrice = (y: number) => {
      const rel = (y - PAD.top) / plotH;
      return Math.min(Math.max(1 - rel, 0), 1);
    };
    const linePath = (points: ChartSeriesPoint[], untilSec = duration) => {
      const filtered = points.filter((p) => {
        if (p.ask == null) return false;
        const sec = p.t - origin;
        return sec >= 0 && sec <= untilSec;
      });
      if (filtered.length === 0) return "";
      return filtered
        .map((p, i) => {
          const x = secToX(p.t - origin);
          const y = yPrice(p.ask!);
          return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(" ");
    };
    const xSecs: number[] = [];
    for (let i = 0; i <= 6; i++) xSecs.push((duration * i) / 6);
    const yTicks = Y_TICKS.map((p) => ({ p, y: yPrice(p) }));
    const xTicks = xSecs.map((sec) => ({
      sec,
      x: secToX(sec),
      label: `${Math.round(sec / 60)} min`,
    }));
    const gridPath = [
      ...yTicks.map(
        (tick) => `M ${PAD.left} ${tick.y.toFixed(1)} H ${(w - PAD.right).toFixed(1)}`,
      ),
      ...xTicks.map(
        (tick) => `M ${tick.x.toFixed(1)} ${PAD.top} V ${(h - PAD.bottom).toFixed(1)}`,
      ),
    ].join(" ");
    return {
      w,
      h,
      plotW,
      plotH,
      secToX,
      yPrice,
      yToPrice,
      yTicks,
      xTicks,
      gridPath,
      playheadX: secToX(playhead),
      playhead,
      upPath: showYes ? linePath(props.up, playhead) : "",
      downPath: showNo ? linePath(props.down, playhead) : "",
      upFuture: showYes ? linePath(props.up) : "",
      downFuture: showNo ? linePath(props.down) : "",
      fills: (props.fills ?? [])
        .filter((f) => {
          const sec = f.t - origin;
          if (sec < 0 || sec > playhead || f.price < 0) return false;
          if (f.outcomeIndex === 0) return showYes;
          return showNo;
        })
        .map((f) => {
          const x = secToX(f.t - origin);
          const y = yPrice(f.price);
          const r = 5;
          const points =
            f.side === "SELL"
              ? `${x},${y + r} ${x - r},${y - r} ${x + r},${y - r}`
              : `${x},${y - r} ${x - r},${y + r} ${x + r},${y + r}`;
          return {
            points,
            color: f.outcomeIndex === 1 ? CHART_COLORS.down : CHART_COLORS.up,
          };
        }),
      signals: (props.signals ?? [])
        .filter((s) => {
          if (s.phase === "fill") return false; // internal for dependsOn; POST already marked
          if (s.elapsedSec > playhead + 0.001) return false;
          if (s.outcomeIndex === 0) return showYes;
          return showNo;
        })
        .map((s) => {
          const x = secToX(s.elapsedSec);
          const y = yPrice(s.price);
          const r = 6;
          const buy = s.action === "buy";
          const points = buy
            ? `${x},${y - r} ${x - r},${y + r} ${x + r},${y + r}`
            : `${x},${y + r} ${x - r},${y - r} ${x + r},${y - r}`;
          return {
            points,
            color: s.outcomeIndex === 1 ? CHART_COLORS.down : CHART_COLORS.up,
            action: s.action,
          };
        }),
    };
  });

  const xToSec = (x: number) => {
    const { plotW } = layout();
    const rel = (x - PAD.left) / plotW;
    return Math.min(Math.max(rel * props.durationSec, 0), props.durationSec);
  };

  const clientX = (e: PointerEvent) => {
    const rect = svgRef!.getBoundingClientRect();
    return ((e.clientX - rect.left) / Math.max(rect.width, 1)) * layout().w;
  };

  const clientY = (e: PointerEvent) => {
    const rect = svgRef!.getBoundingClientRect();
    return ((e.clientY - rect.top) / Math.max(rect.height, 1)) * layout().h;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    if (
      target?.closest(".se-chart-handle") ||
      target?.closest(".se-chart-zone") ||
      target?.closest(".se-chart-port") ||
      target?.closest(".se-chart-link")
    ) {
      return;
    }
    if (e.altKey) return;
    setSelectedLink(null);
    const x = clientX(e);
    const y = clientY(e);
    if (x < PAD.left || x > layout().w - PAD.right) return;
    if (y > layout().h - PAD.bottom && props.onSeek) {
      props.onSeek(xToSec(x));
      return;
    }
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    setDrag({ kind: "create", x0: x, y0: y, x1: x, y1: y });
  };

  const startResize = (ruleId: string, edge: "start" | "end", e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    svgRef?.setPointerCapture(e.pointerId);
    setDrag({ kind: "resize", ruleId, edge, x: clientX(e) });
    props.onSelectRule(ruleId);
  };

  const startResizeBand = (ruleId: string, edge: "min" | "max", e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    svgRef?.setPointerCapture(e.pointerId);
    setDrag({ kind: "resize-band", ruleId, edge, y: clientY(e) });
    props.onSelectRule(ruleId);
  };

  const startMove = (rule: ChartRule, e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    svgRef?.setPointerCapture(e.pointerId);
    const x = clientX(e);
    const y = clientY(e);
    setDrag({ kind: "move", ruleId: rule.id, origin: { ...rule }, x0: x, y0: y, x, y });
    props.onSelectRule(rule.id);
    setSelectedLink(null);
  };

  const startLink = (fromId: string, e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    svgRef?.setPointerCapture(e.pointerId);
    const x = clientX(e);
    const y = clientY(e);
    setDrag({ kind: "link", fromId, x0: x, y0: y, x, y });
    props.onSelectRule(fromId);
    setSelectedLink(null);
  };

  const onPointerMove = (e: PointerEvent) => {
    const x = clientX(e);
    const y = clientY(e);
    const l = layout();
    const inPlot =
      x >= PAD.left &&
      x <= l.w - PAD.right &&
      y >= PAD.top &&
      y <= l.h - PAD.bottom;
    const d = drag();
    if (props.tooltipEnabled && inPlot && !d) {
      setHover({ x, y, sec: xToSec(x) });
    } else {
      setHover(null);
    }
    if (!d) return;
    if (d.kind === "create") setDrag({ ...d, x1: x, y1: y });
    else if (d.kind === "resize") setDrag({ ...d, x });
    else if (d.kind === "resize-band") setDrag({ ...d, y });
    else setDrag({ ...d, x, y });
  };

  const clearHover = () => setHover(null);

  const tooltip = createMemo(() => {
    const hov = hover();
    if (!props.tooltipEnabled || !hov) return null;
    const t = props.windowStartUnix + hov.sec;
    const yes = props.showYes ? askAt(props.up, t) : null;
    const no = props.showNo ? askAt(props.down, t) : null;
    const l = layout();
    const flipX = hov.x > l.w - 150;
    const flipY = hov.y > l.h - 90;
    return {
      sec: hov.sec,
      x: hov.x,
      y: hov.y,
      left: flipX ? hov.x - 12 : hov.x + 12,
      top: flipY ? hov.y - 12 : hov.y + 12,
      transform: `translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`,
      yes,
      no,
      yesY: yes != null ? l.yPrice(yes) : null,
      noY: no != null ? l.yPrice(no) : null,
    };
  });

  const yToPrice = (y: number) => layout().yToPrice(y);

  const visibleRule = (rule: ChartRule): ChartRule => {
    const d = drag();
    if (!d) return rule;
    if (d.kind === "resize" && d.ruleId === rule.id) {
      const sec = xToSec(d.x);
      if (d.edge === "start") return { ...rule, startSec: Math.min(sec, rule.endSec - 1) };
      return { ...rule, endSec: Math.max(sec, rule.startSec + 1) };
    }
    if (d.kind === "resize-band" && d.ruleId === rule.id) {
      const p = yToPrice(d.y);
      const min = rule.bandMin ?? 0;
      const max = rule.bandMax ?? 1;
      if (d.edge === "max") {
        return { ...rule, bandMax: Math.min(1, Math.max(p, min + 0.01)) };
      }
      return { ...rule, bandMin: Math.max(0, Math.min(p, max - 0.01)) };
    }
    if (d.kind === "move" && d.ruleId === rule.id) {
      return translateChartRule(
        d.origin,
        xToSec(d.x) - xToSec(d.x0),
        yToPrice(d.y) - yToPrice(d.y0),
        props.durationSec,
      );
    }
    return rule;
  };

  const paintRules = () => {
    const unbanded: ChartRule[] = [];
    const banded: ChartRule[] = [];
    for (const rule of props.rules) {
      if (rule.bandMin == null && rule.bandMax == null) unbanded.push(rule);
      else banded.push(rule);
    }
    return [...unbanded, ...banded];
  };

  const zoneBox = (rule: ChartRule) => {
    const shown = visibleRule(rule);
    const l = layout();
    const x = l.secToX(shown.startSec);
    const w = Math.max(l.secToX(shown.endSec) - x, 2);
    if (shown.bandMin == null && shown.bandMax == null) {
      return { x, y: PAD.top, w, h: l.plotH };
    }
    const y = l.yPrice(shown.bandMax ?? 1);
    const h = Math.max(l.yPrice(shown.bandMin ?? 0) - y, 2);
    return { x, y, w, h };
  };

  const hitTestZone = (px: number, py: number): ChartRule | null => {
    const pad = PORT_R * 2;
    for (const rule of [...paintRules()].reverse()) {
      const b = zoneBox(rule);
      if (px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y && py <= b.y + b.h) {
        return rule;
      }
    }
    return null;
  };

  const paintedLinks = () => {
    const boxes = new Map(props.rules.map((rule) => [rule.id, zoneBox(rule)]));
    const sel = selectedLink();
    return chartRuleLinks(props.rules).flatMap((link) => {
      const from = boxes.get(link.fromId);
      const to = boxes.get(link.toId);
      if (!from || !to) return [];
      return [
        {
          ...link,
          d: linkBezier(
            from.x + from.w + PORT_R,
            from.y + from.h / 2,
            to.x - PORT_R,
            to.y + to.h / 2,
          ),
          selected: sel?.fromId === link.fromId && sel?.toId === link.toId,
        },
      ];
    });
  };

  const linkTargetId = () => {
    const d = drag();
    if (!d || d.kind !== "link") return null;
    const hit = hitTestZone(d.x, d.y);
    return hit && hit.id !== d.fromId ? hit.id : null;
  };

  const linkDraft = () => {
    const d = drag();
    if (!d || d.kind !== "link") return null;
    const from = props.rules.find((r) => r.id === d.fromId);
    if (!from) return null;
    const box = zoneBox(from);
    return linkBezier(box.x + box.w + PORT_R, box.y + box.h / 2, d.x, d.y);
  };

  const finishDrag = () => {
    const d = drag();
    setDrag(null);
    if (!d) return;
    if (d.kind === "create") {
      const dx = Math.abs(d.x1 - d.x0);
      const dy = Math.abs(d.y1 - d.y0);
      if (dx < MIN_DRAG_PX && dy < MIN_DRAG_PX) {
        props.onSelectRule(null);
        setSelectedLink(null);
        return;
      }
      let time = snapChartRange(
        xToSec(Math.min(d.x0, d.x1)),
        xToSec(Math.max(d.x0, d.x1)),
        props.durationSec,
      );
      if (dx < MIN_DRAG_PX) {
        const sec = xToSec(d.x0);
        time = snapChartRange(sec - 30, sec + 30, props.durationSec);
      }
      const banded = dy >= MIN_DRAG_PX;
      const band = banded
        ? snapChartBand(yToPrice(d.y0), yToPrice(d.y1))
        : null;
      // Une bande de prix (rectangle) → guess buy favori/cheap d'après le prix.
      // Une zone temps seule → buy par défaut (newChartRule()).
      const guess = band ? guessRuleFromBand(band.bandMin, band.bandMax) : {};
      const rule = newChartRule({ ...time, ...(band ?? {}), ...guess });
      props.onRulesChange([...props.rules, rule]);
      props.onSelectRule(rule.id);
      return;
    }
    if (d.kind === "link") {
      const target = hitTestZone(d.x, d.y);
      if (!target || target.id === d.fromId) return;
      const next = linkChartRules(props.rules, d.fromId, target.id);
      if (next) {
        props.onRulesChange(next);
        setSelectedLink({ fromId: d.fromId, toId: target.id });
        props.onSelectRule(target.id);
      } else {
        props.onLinkRejected?.(
          "Lien refusé : cycle (A→B→A) ou zones identiques.",
        );
      }
      return;
    }
    const rule = props.rules.find((r) => r.id === d.ruleId);
    if (!rule) return;
    if (d.kind === "move") {
      if (Math.abs(d.x - d.x0) < MIN_DRAG_PX && Math.abs(d.y - d.y0) < MIN_DRAG_PX) {
        props.onSelectRule(rule.id);
        return;
      }
      const moved = translateChartRule(
        d.origin,
        xToSec(d.x) - xToSec(d.x0),
        yToPrice(d.y) - yToPrice(d.y0),
        props.durationSec,
      );
      const next = snapMovedRule(moved, props.durationSec);
      props.onRulesChange(
        props.rules.map((r) => (r.id === rule.id ? next : r)),
      );
      return;
    }
    if (d.kind === "resize-band") {
      const p = yToPrice(d.y);
      const min = rule.bandMin ?? 0;
      const max = rule.bandMax ?? 1;
      const next =
        d.edge === "max"
          ? snapChartBand(min, p)
          : snapChartBand(p, max);
      props.onRulesChange(
        props.rules.map((r) => (r.id === rule.id ? { ...r, ...next } : r)),
      );
      return;
    }
    const sec = xToSec(d.x);
    const next =
      d.edge === "start"
        ? snapChartRange(sec, rule.endSec, props.durationSec)
        : snapChartRange(rule.startSec, sec, props.durationSec);
    props.onRulesChange(
      props.rules.map((r) => (r.id === rule.id ? { ...r, ...next } : r)),
    );
  };

  const draft = () => {
    const d = drag();
    if (!d || d.kind !== "create") return null;
    const dx = Math.abs(d.x1 - d.x0);
    const dy = Math.abs(d.y1 - d.y0);
    const banded = dy >= MIN_DRAG_PX;
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    let label: string | null = null;
    if (banded) {
      const { bandMin, bandMax } = snapChartBand(yToPrice(d.y0), yToPrice(d.y1));
      label = `${bandMin.toFixed(2)}–${bandMax.toFixed(2)}`;
    }
    return {
      x,
      w: Math.max(dx, 2),
      y: banded ? y : PAD.top,
      h: banded ? Math.max(dy, 2) : layout().plotH,
      banded,
      label,
    };
  };

  return (
    <div class="se-chart-wrap" ref={wrapRef}>
      <svg
        ref={svgRef}
        class={`se-chart-svg${altDown() || drag()?.kind === "move" ? " is-move" : ""}${drag()?.kind === "link" ? " is-link" : ""}`}
        width={layout().w}
        height={layout().h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onPointerLeave={clearHover}
      >
        <defs>
          <marker
            id="se-chart-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 Z" class="se-chart-link-head" />
          </marker>
          <marker
            id="se-chart-arrow-sel"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 Z" class="se-chart-link-head is-sel" />
          </marker>
        </defs>
        <path d={layout().gridPath} fill="none" class="se-chart-grid" />
        {layout().yTicks.map((tick) => (
          <text
            x={PAD.left - 6}
            y={tick.y + 4}
            text-anchor="end"
            class="se-chart-label"
          >
            {tick.p.toFixed(2)}
          </text>
        ))}
        {layout().xTicks.map((tick) => (
          <text
            x={tick.x}
            y={layout().h - 8}
            text-anchor="middle"
            class="se-chart-label"
          >
            {tick.label}
          </text>
        ))}
        <For each={paintRules()}>
          {(rule) => {
            const shown = () => visibleRule(rule);
            const x = () => layout().secToX(shown().startSec);
            const w = () => Math.max(layout().secToX(shown().endSec) - x(), 2);
            const band = () => {
              const r = shown();
              const l = layout();
              if (r.bandMin == null && r.bandMax == null) {
                return { y: PAD.top, h: l.plotH, banded: false };
              }
              const y = l.yPrice(r.bandMax ?? 1);
              const h = Math.max(l.yPrice(r.bandMin ?? 0) - y, 2);
              return { y, h, banded: true };
            };
            const sel = () => props.selectedRuleId === rule.id;
            const linking = () => linkTargetId() === rule.id;
            return (
              <g class="se-chart-zone-g">
                <rect
                  x={x()}
                  y={band().y}
                  width={w()}
                  height={band().h}
                  class={`se-chart-zone se-chart-zone--${rule.action}${sel() ? " is-sel" : ""}${band().banded ? " se-chart-zone--band" : ""}${linking() ? " is-link-target" : ""}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (e.button !== 0) return;
                    if (e.altKey) startMove(rule, e);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.altKey) return;
                    setSelectedLink(null);
                    props.onSelectRule(rule.id);
                  }}
                />
                <text x={x() + 6} y={band().y + 14} class="se-chart-zone-label">
                  {chartRuleIndexLabel(props.rules, rule.id)} {chartRuleLegend(shown())}
                </text>
                <Show when={sel() && drag()?.kind !== "move"}>
                  <rect
                    x={x() - HANDLE_W / 2}
                    y={band().y}
                    width={HANDLE_W}
                    height={band().h}
                    class="se-chart-handle"
                    onPointerDown={(e) => startResize(rule.id, "start", e)}
                  />
                  <rect
                    x={x() + w() - HANDLE_W / 2}
                    y={band().y}
                    width={HANDLE_W}
                    height={band().h}
                    class="se-chart-handle"
                    onPointerDown={(e) => startResize(rule.id, "end", e)}
                  />
                  <Show when={band().banded}>
                    <rect
                      x={x()}
                      y={band().y - HANDLE_H / 2}
                      width={w()}
                      height={HANDLE_H}
                      class="se-chart-handle se-chart-handle--band"
                      onPointerDown={(e) => startResizeBand(rule.id, "max", e)}
                    />
                    <rect
                      x={x()}
                      y={band().y + band().h - HANDLE_H / 2}
                      width={w()}
                      height={HANDLE_H}
                      class="se-chart-handle se-chart-handle--band"
                      onPointerDown={(e) => startResizeBand(rule.id, "min", e)}
                    />
                  </Show>
                </Show>
              </g>
            );
          }}
        </For>
        <path
          d={layout().downFuture}
          fill="none"
          stroke={CHART_COLORS.down}
          stroke-width="1.2"
          opacity="0.2"
        />
        <path
          d={layout().upFuture}
          fill="none"
          stroke={CHART_COLORS.up}
          stroke-width="1.2"
          opacity="0.2"
        />
        <path d={layout().downPath} fill="none" stroke={CHART_COLORS.down} stroke-width="1.8" />
        <path d={layout().upPath} fill="none" stroke={CHART_COLORS.up} stroke-width="1.8" />
        <line
          x1={layout().playheadX}
          y1={PAD.top}
          x2={layout().playheadX}
          y2={layout().h - PAD.bottom}
          class="se-chart-playhead"
        />
        {layout().fills.map((fill) => (
          <polygon
            points={fill.points}
            fill={fill.color}
            stroke="#0b0f14"
            stroke-width="1"
            class="se-chart-fill"
          />
        ))}
        {layout().signals.map((sig) => (
          <polygon
            points={sig.points}
            fill={sig.color}
            stroke={sig.action === "buy" ? "#3ecf8e" : "#e85d5d"}
            stroke-width="1.5"
            class="se-chart-signal"
          />
        ))}
        <For each={paintedLinks()}>
          {(link) => (
            <g class={`se-chart-link${link.selected ? " is-sel" : ""}`}>
              <path
                d={link.d}
                fill="none"
                class="se-chart-link-hit"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setSelectedLink({ fromId: link.fromId, toId: link.toId });
                  props.onSelectRule(null);
                }}
              />
              <path
                d={link.d}
                fill="none"
                class="se-chart-link-stroke"
                marker-end={link.selected ? "url(#se-chart-arrow-sel)" : "url(#se-chart-arrow)"}
                pointer-events="none"
              />
            </g>
          )}
        </For>
        <Show when={linkDraft()}>
          {(d) => (
            <path
              d={d()}
              fill="none"
              class="se-chart-link-stroke se-chart-link-stroke--draft"
              marker-end="url(#se-chart-arrow)"
              pointer-events="none"
            />
          )}
        </Show>
        <For each={paintRules()}>
          {(rule) => {
            const shown = () => visibleRule(rule);
            const x = () => layout().secToX(shown().startSec);
            const w = () => Math.max(layout().secToX(shown().endSec) - x(), 2);
            const midY = () => {
              const r = shown();
              const l = layout();
              if (r.bandMin == null && r.bandMax == null) {
                return PAD.top + l.plotH / 2;
              }
              const y = l.yPrice(r.bandMax ?? 1);
              const h = Math.max(l.yPrice(r.bandMin ?? 0) - y, 2);
              return y + h / 2;
            };
            const sel = () => props.selectedRuleId === rule.id;
            return (
              <g class="se-chart-ports">
                <circle
                  cx={x() - PORT_R}
                  cy={midY()}
                  r={PORT_R}
                  class={`se-chart-port se-chart-port--in${sel() ? " is-sel" : ""}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    props.onSelectRule(rule.id);
                    setSelectedLink(null);
                  }}
                />
                <circle
                  cx={x() + w() + PORT_R}
                  cy={midY()}
                  r={PORT_R}
                  class={`se-chart-port se-chart-port--out${sel() ? " is-sel" : ""}`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    startLink(rule.id, e);
                  }}
                />
              </g>
            );
          }}
        </For>
        <Show when={draft()}>
          {(d) => (
            <>
              <rect
                x={d().x}
                y={d().y}
                width={d().w}
                height={d().h}
                class={`se-chart-zone se-chart-zone--draft${d().banded ? " se-chart-zone--band" : ""}`}
              />
              <Show when={d().label}>
                <text x={d().x + 6} y={d().y + 14} class="se-chart-zone-label">
                  {d().label}
                </text>
              </Show>
            </>
          )}
        </Show>
        <Show when={tooltip()}>
          {(tip) => (
            <g class="se-chart-hover" pointer-events="none">
              <line
                x1={tip().x}
                y1={PAD.top}
                x2={tip().x}
                y2={layout().h - PAD.bottom}
                class="se-chart-hover-line"
              />
              <Show when={tip().yesY != null}>
                <circle
                  cx={tip().x}
                  cy={tip().yesY!}
                  r="4"
                  fill={CHART_COLORS.up}
                  stroke="#0b0f14"
                  stroke-width="1"
                />
              </Show>
              <Show when={tip().noY != null}>
                <circle
                  cx={tip().x}
                  cy={tip().noY!}
                  r="4"
                  fill={CHART_COLORS.down}
                  stroke="#0b0f14"
                  stroke-width="1"
                />
              </Show>
            </g>
          )}
        </Show>
        <text x={PAD.left} y={12} class="se-chart-legend">
          <Show when={props.showYes}>
            <tspan fill={CHART_COLORS.up}>Yes</tspan>
          </Show>
          <Show when={props.showYes && props.showNo}>
            <tspan fill="var(--muted)"> · </tspan>
          </Show>
          <Show when={props.showNo}>
            <tspan fill={CHART_COLORS.down}>No</tspan>
          </Show>
          <tspan fill="var(--muted)"> · △ stratégie · ▲ fill bot · point droit → zone = lien</tspan>
        </text>
      </svg>
      <Show when={tooltip()}>
        {(tip) => (
          <div
            class="se-chart-tooltip"
            style={{
              left: `${tip().left}px`,
              top: `${tip().top}px`,
              transform: tip().transform,
            }}
          >
            <div class="se-chart-tooltip-time">{fmtPlayClock(tip().sec)}</div>
            <Show when={props.showYes}>
              <div class="se-chart-tooltip-row is-yes">
                Yes <strong>{tip().yes != null ? tip().yes!.toFixed(3) : "—"}</strong>
              </div>
            </Show>
            <Show when={props.showNo}>
              <div class="se-chart-tooltip-row is-no">
                No <strong>{tip().no != null ? tip().no!.toFixed(3) : "—"}</strong>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
