import type { JSX } from "solid-js";

export function Panel(props: {
  title: string;
  full?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class={`panel${props.full ? " full" : ""}`}>
      <h2>{props.title}</h2>
      {props.children}
    </div>
  );
}
