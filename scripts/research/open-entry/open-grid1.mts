/**
 * Grille open-entry : charge l'univers UNE fois, balaie les configs.
 * Ligne 1 = HOLD-ref (exits off) — le delta d'une variante vs ref est la
 * seule lecture valide (piège connu : le sim ne RANK pas mieux que ±6 %,
 * on compare donc TOUJOURS au ref sur le même univers).
 */
import { loadUniverse } from "./universe.mts";
import { runSim, fmtRow, HOLD_REF, type OpenConfig } from "./open-sim.mts";

const uni = loadUniverse();
console.log("universe:", uni.slugs.size, "windows — HOLD-ref + variants");

const variants: OpenConfig[] = [
  HOLD_REF,
  // ---- SL structurel seul (contextuel : flip adverse confirmé + dégât prix)
  { ...HOLD_REF, label: "slStruct f0.20/c20/d0.10", slStruct: true },
  { ...HOLD_REF, label: "slStruct f0.15/c20/d0.10", slStruct: true, slStructFlipDist: 0.15 },
  { ...HOLD_REF, label: "slStruct f0.25/c20/d0.10", slStruct: true, slStructFlipDist: 0.25 },
  { ...HOLD_REF, label: "slStruct f0.20/c30/d0.12", slStruct: true, slStructConfirmSec: 30, slStructDist: 0.12 },
  { ...HOLD_REF, label: "slStruct f0.20/c10/d0.08", slStruct: true, slStructConfirmSec: 10, slStructDist: 0.08 },
  // ---- SL tardif seul
  { ...HOLD_REF, label: "slLate after300/d0.06", slLate: true },
  { ...HOLD_REF, label: "slLate after420/d0.05", slLate: true, slLateAfterSec: 420, slLateDist: 0.05 },
  { ...HOLD_REF, label: "slLate after300/d0.10", slLate: true, slLateDist: 0.10 },
  // ---- TP seul
  { ...HOLD_REF, label: "tp 0.85 avant600", tpLevel: 0.85 },
  { ...HOLD_REF, label: "tp 0.90 avant600", tpLevel: 0.9 },
  { ...HOLD_REF, label: "tp 0.85 avant720", tpLevel: 0.85, tpBeforeSec: 720 },
  // ---- entrée instant en plus
  { ...HOLD_REF, label: "entry instant 0.25", entries: ["instant", "momentum"] },
  { ...HOLD_REF, label: "entry instant 0.35", entries: ["instant", "momentum"], instantLeanMin: 0.35 },
  // ---- trigger d'entrée (sensibilité)
  { ...HOLD_REF, label: "trigger 0.12", leanTrigger: 0.12 },
  { ...HOLD_REF, label: "trigger 0.20", leanTrigger: 0.2 },
  { ...HOLD_REF, label: "trigger 0.25", leanTrigger: 0.25 },
  { ...HOLD_REF, label: "window 60s", entryWindowSec: 60 },
  { ...HOLD_REF, label: "window 120s", entryWindowSec: 120 },
  { ...HOLD_REF, label: "window 180s", entryWindowSec: 180 },
  { ...HOLD_REF, label: "fairMax 1.05", fairMax: 1.05 },
  { ...HOLD_REF, label: "fairMax off (1.14)", fairMax: 1.14 },
];

const results = variants.map((cfg) => runSim(uni, cfg));
for (const r of results) console.log(fmtRow(r));