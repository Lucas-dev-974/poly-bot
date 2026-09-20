/**
 * Grille 3 open-entry : combo finale (STRUCT + LATE + fenêtre d'entrée) +
 * SL tardif contextuel (needLead) + balayage fin du couple fenêtre/trigger.
 */
import { loadUniverse } from "./universe.mts";
import { runSim, fmtRow, HOLD_REF, type OpenConfig } from "./open-sim.mts";

const uni = loadUniverse();
console.log("universe:", uni.slugs.size, "windows — grille 3 (combo finale)");

const LATE = { slLate: true, slLateAfterSec: 300, slLateDist: 0.06 } as const;
const STRUCT = { slStruct: true, slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1 } as const;

const variants: OpenConfig[] = [
  HOLD_REF,
  { ...HOLD_REF, label: "COMBO win90 STRUCT+LATE", ...LATE, ...STRUCT },
  { ...HOLD_REF, label: "COMBO win180 STRUCT+LATE", ...LATE, ...STRUCT, entryWindowSec: 180 },
  { ...HOLD_REF, label: "COMBO win300 STRUCT+LATE", ...LATE, ...STRUCT, entryWindowSec: 300 },
  { ...HOLD_REF, label: "COMBO win180 LATE needLead", ...LATE, slLateNeedLead: true, entryWindowSec: 180 },
  { ...HOLD_REF, label: "COMBO win300 LATE needLead", ...LATE, slLateNeedLead: true, entryWindowSec: 300 },
  { ...HOLD_REF, label: "COMBO win300 STRUCT+LATE needLead", ...LATE, ...STRUCT, slLateNeedLead: true, entryWindowSec: 300 },
  // fenêtre d'entrée large : la détection porte l'info, tester jusqu'où ça tient
  { ...HOLD_REF, label: "win300 exits-off (diagnostic)", entryWindowSec: 300 },
  { ...HOLD_REF, label: "win450 exits-off (diagnostic)", entryWindowSec: 450 },
  { ...HOLD_REF, label: "COMBO win450 STRUCT+LATE", ...LATE, ...STRUCT, entryWindowSec: 450 },
  // triggers sur la meilleure fenêtre
  { ...HOLD_REF, label: "COMBO win180 trig0.20", ...LATE, ...STRUCT, entryWindowSec: 180, leanTrigger: 0.2 },
  { ...HOLD_REF, label: "COMBO win180 trig0.12", ...LATE, ...STRUCT, entryWindowSec: 180, leanTrigger: 0.12 },
  { ...HOLD_REF, label: "COMBO win180 fairMax1.05", ...LATE, ...STRUCT, entryWindowSec: 180, fairMax: 1.05 },
  { ...HOLD_REF, label: "COMBO win180 fairMax off", ...LATE, ...STRUCT, entryWindowSec: 180, fairMax: 1.14 },
];

const results = variants.map((cfg) => runSim(uni, cfg));
for (const r of results) console.log(fmtRow(r));