/**
 * Mini-courbe d'équité pour les résultats de backtest (modal Résultat).
 * Conventions sim2 : largeur MESURÉE via ResizeObserver → viewBox 1:1 px
 * (pas de distortion — le tracé porte des labels texte), nombres mono.
 * Indépendante des données : les valeurs entrent par props.
 */
import { createSignal, onMount, onCleanup } from "solid-js";
import type { JSX } from "solid-js";

export function EquityMini(props: {
  values: readonly number[];
  height?: number;
  class?: string;
}): JSX.Element {
  const [w, setW] = createSignal(720);
  let wrap: HTMLDivElement | undefined;
  onMount(() => {
    if (!wrap) return;
    const update = (): void => {
      setW(Math.max(320, Math.round(wrap!.getBoundingClientRect().width)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    onCleanup(() => ro.disconnect());
  });
  const h = (): number => props.height ?? 110;
  const pad = 8;
  const pathData = (): { line: string; area: string; last: string; first: string } => {
    const v = props.values;
    if (v.length < 2) return { line: "", area: "", last: "", first: "" };
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    const span = hi - lo || 1;
    const x = (i: number): number => pad + ((w() - 2 * pad) * i) / (v.length - 1);
    const y = (val: number): number => pad + (h() - 2 * pad - 14) * (1 - (val - lo) / span);
    let line = "";
    for (let i = 0; i < v.length; i++) {
      line += `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v[i]).toFixed(1)}`;
    }
    const base = h() - 2;
    const area = `${line}L${x(v.length - 1).toFixed(1)} ${base} L${x(0).toFixed(1)} ${base} Z`;
    return {
      line,
      area,
      last: `${v[v.length - 1].toFixed(2)}`,
      first: `${v[0].toFixed(2)}`,
    };
  };
  return (
    <div class={`eqmini ${props.class ?? ""}`} ref={wrap}>
      <svg width={w()} height={h()} viewBox={`0 0 ${w()} ${h()}`} aria-hidden="true">
        <ShowPath
          area={pathData().area}
          line={pathData().line}
          lastLabel={pathData().last}
          firstLabel={pathData().first}
          w={w()}
          h={h()}
        />
      </svg>
    </div>
  );
}

function ShowPath(props: {
  area: string;
  line: string;
  lastLabel: string;
  firstLabel: string;
  w: number;
  h: number;
}): JSX.Element {
  if (!props.line) return null;
  return (
    <>
      <path d={props.area} fill="rgba(62, 224, 122, 0.08)" />
      <path
        d={props.line}
        fill="none"
        stroke="var(--green)"
        stroke-width="1.4"
        stroke-linejoin="round"
      />
      <text
        x={2}
        y={props.h - 4}
        fill="var(--muted)"
        font-size="9"
        class="sim2-mono"
      >
        {props.firstLabel} $
      </text>
      <text
        x={props.w - 2}
        y={12}
        fill="var(--green)"
        font-size="10"
        text-anchor="end"
        class="sim2-mono"
      >
        {props.lastLabel} $
      </text>
    </>
  );
}