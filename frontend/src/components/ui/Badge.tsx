import type { JSX } from "solid-js";

type BadgeVariant =
  | "dry"
  | "live"
  | "cheap"
  | "expensive"
  | "manual"
  | "underdog"
  | "favorite"
  | "couvert"
  | "partiel";

const VARIANTS: Record<BadgeVariant, string> = {
  dry: "badge dry",
  live: "badge live",
  cheap: "badge cheap",
  expensive: "badge expensive",
  manual: "badge manual",
  underdog: "badge underdog",
  favorite: "badge favorite",
  couvert: "badge couvert",
  partiel: "badge partiel",
};

export function Badge(props: {
  variant: BadgeVariant;
  children: JSX.Element;
}): JSX.Element {
  return <span class={VARIANTS[props.variant]}>{props.children}</span>;
}
