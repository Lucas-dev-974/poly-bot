import { For, Show } from "solid-js";
import type { JSX } from "solid-js";

export function GuideStack(props: { gap?: number; children: JSX.Element }): JSX.Element {
  return (
    <div class="guide-stack" style={{ gap: `${props.gap ?? 16}px` }}>
      {props.children}
    </div>
  );
}

export function GuideRow(props: { gap?: number; children: JSX.Element }): JSX.Element {
  return (
    <div class="guide-row" style={{ gap: `${props.gap ?? 8}px` }}>
      {props.children}
    </div>
  );
}

export function GuideGrid(props: {
  columns: number;
  gap?: number;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div
      class="guide-grid"
      style={{
        "grid-template-columns": `repeat(${props.columns}, minmax(0, 1fr))`,
        gap: `${props.gap ?? 12}px`,
      }}
    >
      {props.children}
    </div>
  );
}

export function GuideCard(props: {
  title: string;
  trailing?: JSX.Element;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class="guide-card panel">
      <div class="guide-card__header">
        <h4>{props.title}</h4>
        <Show when={props.trailing}>{props.trailing}</Show>
      </div>
      <div class="guide-card__body">{props.children}</div>
    </div>
  );
}

export function GuidePill(props: {
  active?: boolean;
  onClick?: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      class={`guide-pill ${props.active ? "guide-pill--active" : ""}`}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function GuideCallout(props: {
  tone?: "info" | "warning" | "neutral";
  title: string;
  children: JSX.Element;
}): JSX.Element {
  const tone = () => props.tone ?? "neutral";
  return (
    <div class={`guide-callout guide-callout--${tone()}`}>
      <strong>{props.title}</strong>
      <div>{props.children}</div>
    </div>
  );
}

export function GuideStat(props: { value: string; label: string }): JSX.Element {
  return (
    <div class="guide-stat">
      <div class="guide-stat__value">{props.value}</div>
      <div class="guide-stat__label">{props.label}</div>
    </div>
  );
}

export function GuideTable(props: {
  headers: string[];
  rows: string[][];
  rowTone?: string[];
}): JSX.Element {
  return (
    <div class="guide-table-wrap">
      <table class="guide-table">
        <thead>
          <tr>
            <For each={props.headers}>{(h) => <th>{h}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row, i) => (
              <tr class={props.rowTone?.[i()] ? `guide-row--${props.rowTone[i()]}` : undefined}>
                <For each={row}>{(cell) => <td>{cell}</td>}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export function GuideDetails(props: {
  title: string;
  defaultOpen?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <details class="guide-details" open={props.defaultOpen}>
      <summary>{props.title}</summary>
      <div class="guide-details__body">{props.children}</div>
    </details>
  );
}

export function GuideTodoList(props: {
  items: { id: string; content: string; done: boolean }[];
}): JSX.Element {
  return (
    <GuideCard title="Checklist implémentation">
      <ul class="guide-todos">
        <For each={props.items}>
          {(item) => (
            <li class={item.done ? "guide-todos__item--done" : ""}>
              <span class="guide-todos__check">{item.done ? "✓" : "○"}</span>
              {item.content}
            </li>
          )}
        </For>
      </ul>
    </GuideCard>
  );
}
