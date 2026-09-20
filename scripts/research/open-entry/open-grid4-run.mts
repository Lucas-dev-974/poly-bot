/** Lanceur de la grille 4 (sim calibrée runner). */
import { loadUniverse } from "./universe.mts";
import { runRSim, summarize, RC_REF, type RConfig } from "./open-grid4-calib.mts";

const uni = loadUniverse();
console.log("universe:", uni.slugs.size);
const rows: RConfig[] = [
  RC_REF,
  { ...RC_REF, label: "ec + SL struct", slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1, slLateAfterSec: 9999 },
  { ...RC_REF, label: "ec + SL late", slStructFlipDist: 9, slStructConfirmSec: 20, slStructDist: 1, slLateAfterSec: 300, slLateDist: 0.06 },
  { ...RC_REF, label: "ec + SL struct+late", slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1, slLateAfterSec: 300, slLateDist: 0.06 },
  { ...RC_REF, label: "lean hold (runner-cal)", entryMode: "lean", slLateAfterSec: 9999, slStructFlipDist: 9, slStructDist: 9, slLateDist: 9 },
  { ...RC_REF, label: "lean + struct+late", entryMode: "lean", slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1, slLateAfterSec: 300, slLateDist: 0.06 },
  { ...RC_REF, label: "lean300 + struct+late", entryMode: "lean", entryWindowSec: 300, slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1, slLateAfterSec: 300, slLateDist: 0.06 },
];
for (const cfg of rows) {
  const tr = runRSim(uni, cfg);
  console.log(`${cfg.label} | ${summarize(tr)}`);
}