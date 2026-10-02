export type TabId = "story" | "arch" | "hedge" | "ui" | "ship";

export const TABS: { id: TabId; label: string }[] = [
  { id: "story", label: "Les 12 moteurs" },
  { id: "arch", label: "Architecture" },
  { id: "hedge", label: "Hedge au POST" },
  { id: "ui", label: "Moteur & presets" },
  { id: "ship", label: "Livrables" },
];
