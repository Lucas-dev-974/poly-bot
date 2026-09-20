/** Ref propre : ec entry, exits OFF (hold intégral) — calibration runner. */
import { loadUniverse } from "./universe.mts";
import { runRSim, summarize, RC_REF, type RConfig } from "./open-grid4-calib.mts";

const uni = loadUniverse();
const hold: RConfig = {
  ...RC_REF,
  label: "ec hold OFFICIEL (exits off)",
  slStructFlipDist: 9,
  slStructConfirmSec: 20,
  slStructDist: 9,
  slLateAfterSec: 9999,
  slLateDist: 9,
};
const trades = runRSim(uni, hold);
const pnl = trades.reduce((s, t) => s + t.pnl, 0);
const wins = trades.filter((t) => t.pnl > 0).length;
console.log(`${hold.label} | ${summarize(trades)}`);
console.log("per-fill:", (pnl / trades.length).toFixed(3));