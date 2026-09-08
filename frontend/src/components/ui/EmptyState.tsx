import type { JSX } from "solid-js";

export function EmptyState(props: { text: string }): JSX.Element {
  return <div class="empty">{props.text}</div>;
}
