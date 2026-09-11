import type { JSX } from "solid-js";
import { fmtPlayClock, type ReplayQuote, type ReplaySignal } from "./chart-rule-replay";

const SPEEDS = [1, 2, 4, 8] as const;

export function ChartReplayBar(props: {
  durationSec: number;
  playheadSec: number;
  playing: boolean;
  speed: number;
  hasSeries: boolean;
  quote: ReplayQuote | null;
  lastSignal: ReplaySignal | null;
  onPlayPause: () => void;
  onSeek: (sec: number) => void;
  onSpeed: (speed: number) => void;
  onRestart: () => void;
}): JSX.Element {
  return (
    <div class="se-player">
      <span
        class="se-player-title"
        title="Preview : POST = once ; fill (tick suivant) = dependsOn / afterFill. Sell favori sur bid."
      >
        Lecture (preview)
      </span>
      <button
        type="button"
        class="btn se-player-btn"
        disabled={!props.hasSeries}
        title="Revenir au début"
        onClick={props.onRestart}
      >
        ⏮
      </button>
      <button
        type="button"
        class="btn se-player-btn"
        disabled={!props.hasSeries}
        title="Espace : play / pause"
        onClick={props.onPlayPause}
      >
        {props.playing ? "❚❚" : "▶"}
      </button>
      <input
        class="se-player-scrub"
        type="range"
        min={0}
        max={props.durationSec}
        step={1}
        disabled={!props.hasSeries}
        value={Math.min(props.playheadSec, props.durationSec)}
        onInput={(e) => props.onSeek(Number(e.currentTarget.value))}
      />
      <span class="se-player-time">
        {fmtPlayClock(props.playheadSec)} / {fmtPlayClock(props.durationSec)}
      </span>
      <select
        class="se-player-speed"
        value={String(props.speed)}
        disabled={!props.hasSeries}
        onChange={(e) => props.onSpeed(Number(e.currentTarget.value))}
      >
        {SPEEDS.map((s) => (
          <option value={s}>{s}×</option>
        ))}
      </select>
      <span class="se-player-quote">
        {props.quote && props.quote.cheapAsk != null
          ? `cheap ${props.quote.cheapAsk.toFixed(2)} · fav ${props.quote.favoriteAsk?.toFixed(2) ?? "—"}`
          : "Pas de courbe"}
      </span>
      <span class={`se-player-signal${props.lastSignal ? ` is-${props.lastSignal.action}` : ""}`}>
        {props.lastSignal
          ? `${
              props.lastSignal.phase === "fill"
                ? "fill"
                : props.lastSignal.action === "buy"
                  ? "post"
                  : "vendre"
            } ${props.lastSignal.token}`
          : "—"}
      </span>
    </div>
  );
}
