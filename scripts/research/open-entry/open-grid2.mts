/**
 * Grille 2 open-entry : combos des survivants de la grille 1.
 * slLate (after300/d0.06) + slStruct + fenêtre d'entrée + variantes
 * contextuelles du SL tardif (coupe seulement si leadership perdu).
 */
import { loadUniverse } from "./universe.mts";
import { runSim, fmtRow, HOLD_REF, type OpenConfig } from "./open-sim.mts";

const uni = loadUniverse();
console.log("universe:", uni.slugs.size, "windows — grille 2 (combos)");

const LATE = { slLate: true, slLateAfterSec: 300, slLateDist: 0.06 } as const;
const STRUCT = { slStruct: true, slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1 } as const;

const variants: OpenConfig[] = [
  HOLD_REF,
  { ...HOLD_REF, label: "LATE 300/0.06 (ref grille1)", ...LATE },
  { ...HOLD_REF, label: "LATE + STRUCT f0.20", ...LATE, ...STRUCT },
  { ...HOLD_REF, label: "LATE + STRUCT f0.15", ...LATE, ...STRUCT, slStructFlipDist: 0.15 },
  { ...HOLD_REF, label: "LATE + STRUCT f0.25", ...LATE, ...STRUCT, slStructFlipDist: 0.25 },
  // timing du LATE
  { ...HOLD_REF, label: "LATE 240/0.06", ...LATE, slLateAfterSec: 240 },
  { ...HOLD_REF, label: "LATE 360/0.06", ...LATE, slLateAfterSec: 360 },
  { ...HOLD_REF, label: "LATE 420/0.06", ...LATE, slLateAfterSec: 420 },
  { ...HOLD_REF, label: "LATE 300/0.04", ...LATE, slLateDist: 0.04 },
  { ...HOLD_REF, label: "LATE 300/0.08", ...LATE, slLateDist: 0.08 },
  { ...HOLD_REF, label: "LATE 300/0.12", ...LATE, slLateDist: 0.12 },
  // fenêtre d'entrée × LATE
  { ...HOLD_REF, label: "win60 + LATE", ...LATE, entryWindowSec: 60 },
  { ...HOLD_REF, label: "win180 + LATE", ...LATE, entryWindowSec: 180 },
  { ...HOLD_REF, label: "trig0.20 + LATE", ...LATE, leanTrigger: 0.2 },
  { ...HOLD_REF, label: "trig0.12 + LATE", ...LATE, leanTrigger: 0.12 },
];

const results = variants.map((cfg) => runSim(uni, cfg));
for (const r of results) console.log(fmtRow(r));