export type SectionId = "presets" | "markets" | "cheap" | "hedge" | "edge" | "fav" | "dip" | "antiflip" | "flipconf" | "earlyconv" | "earlylow" | "openentry" | "repricing" | "risk" | "window";

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: string;
  desc: string;
}

export const SECTIONS: SectionDef[] = [
  { id: "presets", label: "Profils", icon: "▣", desc: "Moteur et packs de paramètres" },
  { id: "markets", label: "Marchés", icon: "◉", desc: "Marchés surveillés et cadence de scan" },
  { id: "cheap", label: "Jambe cheap", icon: "▾", desc: "Bid maker underdog et verrou de paire" },
  { id: "hedge", label: "Jambe hedge", icon: "▴", desc: "Hedge après fill cheap" },
  { id: "edge", label: "Jambe edge", icon: "▴", desc: "Bande de confirmation edge-lead" },
  { id: "fav", label: "Entrée fav-band", icon: "★", desc: "FOK favori mid-band, hold résolution" },
  { id: "dip", label: "Entrée dip-revert", icon: "↶", desc: "FOK favori dip + rebond, hold résolution" },
  { id: "antiflip", label: "Entrée antiflip-revert", icon: "⇄", desc: "FOK favori déchu post-flip, hold résolution" },
  { id: "flipconf", label: "Entrée flip-confirm", icon: "⇛", desc: "FOK nouveau favori post-flip précoce" },
  { id: "earlyconv", label: "Entrée early-conviction", icon: "⚡", desc: "FOK favori déjà établi <45s" },
  { id: "earlylow", label: "Entrée early-low", icon: "⤓", desc: "FOK token < 12c dans les 2,5 premières min 15m, hold resolution" },
  { id: "openentry", label: "Entrée open-entry", icon: "⚑", desc: "FOK favori émergent <300s, SL dual-scale" },
  { id: "repricing", label: "Probability-repricing", icon: "Δ", desc: "Dislocation CLOB, exits bid (TP/stop/time)" },
  { id: "risk", label: "Risque", icon: "◆", desc: "Limites de taille, positions et exposition" },
  { id: "window", label: "Fenêtre", icon: "◷", desc: "Plage de trading avant clôture" },
];
