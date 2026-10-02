import { engineUsesEdge } from "../config/strategyPresets";
import type { ConfigFormState } from "./configFormTypes";

function parseNum(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} : nombre invalide`);
  }
  return parsed;
}

export function validateConfigForm(
  form: ConfigFormState,
  isBacktest: boolean,
  opts?: { leadsWithEdge?: boolean },
): string[] {
  const errors: string[] = [];
  const edge = engineUsesEdge(form.strategyId, opts?.leadsWithEdge);

  try {
    const cheapBuyMin = parseNum(form.cheapBuyMin, "Cheap min");
    const cheapBuyMax = parseNum(form.cheapBuyMax, "Cheap max");
    const expensiveBuyMin = parseNum(form.expensiveBuyMin, "Hedge min");
    const expensiveBuyMax = parseNum(form.expensiveBuyMax, "Hedge max");
    const pairLockMax = parseNum(form.pairLockMax, "Pair lock max");
    const barbellHedgeRatio = parseNum(form.barbellHedgeRatio, "Ratio hedge");
    const minutesBeforeCloseMin = parseNum(form.minutesBeforeCloseMin, "Minutes min");
    const minutesBeforeCloseMax = parseNum(form.minutesBeforeCloseMax, "Minutes max");
    const pollIntervalMs = parseNum(form.pollIntervalMs, "Poll interval");
    const maxOpenPositionsPerSide = parseNum(
      form.maxOpenPositionsPerSide,
      "Max positions",
    );
    const simFillProbability = parseNum(
      form.simFillProbabilityNonMarketable,
      "Fill probability",
    );
    const simResolveRetryIntervalMs = parseNum(
      form.simResolveRetryIntervalMs,
      "Resolve retry interval",
    );

    if (cheapBuyMin > cheapBuyMax) {
      errors.push("Cheap min doit Ãªtre â‰¤ cheap max");
    }
    if (expensiveBuyMin > expensiveBuyMax) {
      errors.push("Hedge min doit Ãªtre â‰¤ hedge max");
    }
    // Bandes cheap/hedge : arb, barbell, reverse (pas edge-lead).
    // pairLockMax : arb seulement. barbellHedgeRatio : barbell seulement.
    if (!edge) {
      if (
        form.strategyId !== "fav-band" &&
        form.strategyId !== "dip-revert" &&
        form.strategyId !== "antiflip-revert" &&
        form.strategyId !== "flip-confirm" &&
        form.strategyId !== "early-conviction" &&
        form.strategyId !== "open-entry" &&
        form.strategyId !== "probability-repricing" &&
        cheapBuyMax >= expensiveBuyMin
      ) {
        errors.push("Cheap max doit Ãªtre < hedge min");
      }
      if (form.strategyId === "arb") {
        if (pairLockMax < 0.90 || pairLockMax >= 1.00) {
          errors.push("Pair lock max doit Ãªtre entre 0.90 et 0.99");
        }
        if (!form.enableExpensiveHedge) {
          errors.push("Le hedge expensive est obligatoire pour arb (B1)");
        }
      }
      if (form.strategyId === "barbell") {
        if (!(barbellHedgeRatio > 0 && barbellHedgeRatio <= 1)) {
          errors.push("Ratio hedge doit Ãªtre dans (0, 1]");
        }
      }
    }
    if (minutesBeforeCloseMin > minutesBeforeCloseMax) {
      errors.push("Minutes min doit Ãªtre â‰¤ minutes max");
    }
    if (pollIntervalMs < 500) {
      errors.push("Poll interval doit Ãªtre â‰¥ 500 ms");
    }
    if (maxOpenPositionsPerSide < 1) {
      errors.push("Max positions par cÃ´tÃ© doit Ãªtre â‰¥ 1");
    }
    if (simFillProbability < 0 || simFillProbability > 1) {
      errors.push("Fill probability doit Ãªtre entre 0 et 1");
    }
    if (simResolveRetryIntervalMs < 500) {
      errors.push("Resolve retry interval doit Ãªtre â‰¥ 500 ms");
    }
    if (!isBacktest && form.simResolveFallback === "probabilistic") {
      errors.push("Resolve fallback probabilistic interdit en mode live");
    }
    if (form.marketSlugPrefixes.split(",").map((s) => s.trim()).filter(Boolean).length === 0) {
      errors.push("Au moins un prÃ©fixe de marchÃ© est requis");
    }

    if (form.strategyId === "fav-band") {
      const lo = Number(form.favBandAskMin);
      const hi = Number(form.favBandAskMax);
      const elapsed = Number(form.favBandMinElapsedSec);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        errors.push("Fav-band: ask min doit Ãªtre < ask max");
      }
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        errors.push("Fav-band: min elapsed entre 0 et 900");
      }
      if (form.favBandMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.favBandMaxElapsedSec);
        if (!Number.isFinite(maxE) || maxE < elapsed) {
          errors.push("Fav-band: max elapsed invalide");
        }
      }
      if (form.favBandInverseEnabled) {
        const invAsk = Number(form.favBandInverseAskMax);
        const invRatio = Number(form.favBandInverseShareRatio);
        const invBudget = Number(form.favBandInverseOrderUsdc);
        const maxPos = Number(form.maxOpenPositionsPerSide);
        if (!Number.isFinite(invAsk) || invAsk <= 0 || invAsk >= 0.5) {
          errors.push("Fav-band inverse: ask max entre 0 et 0.5");
        }
        if (!Number.isFinite(invRatio) || invRatio <= 0) {
          errors.push("Fav-band inverse: ratio doit Ãªtre > 0");
        }
        if (!Number.isFinite(invBudget) || invBudget <= 0) {
          errors.push("Fav-band inverse: budget doit Ãªtre > 0");
        } else if (Number.isFinite(invAsk) && invAsk > 0 && invAsk < 0.5) {
          const maxShares = Number(form.maxSharesPerOrder);
          const cap = Number.isFinite(maxShares) && maxShares > 0 ? maxShares : Number.MAX_SAFE_INTEGER;
          const sized = Math.floor(Math.min(invBudget / invAsk, cap) * 100) / 100;
          if (sized < 5) {
            errors.push("Fav-band inverse: budget insuffisant (min 5 shares au pire prix)");
          }
        }
        if (Number.isFinite(maxPos) && maxPos < 2) {
          errors.push("Fav-band inverse: max positions par cÃ´tÃ© doit Ãªtre â‰¥ 2");
        }
      }
      if (form.favBandExitEnabled) {
        const exDrop = Number(form.favBandExitMinLowerHighDrop);
        const exRetrace = Number(form.favBandExitRetraceRatio);
        const exConsec = Number(form.favBandExitConsecutive);
        const exLookback = Number(form.favBandExitLookbackMs);
        const exElapsed = Number(form.favBandExitMinElapsedSec);
        if (!Number.isFinite(exDrop) || exDrop <= 0) {
          errors.push("Fav-band exit: swing min d'un plus-bas doit Ãªtre > 0");
        }
        if (!Number.isFinite(exRetrace) || exRetrace < 0 || exRetrace > 1) {
          errors.push("Fav-band exit: retracement de confirmation doit Ãªtre dans [0, 1]");
        }
        if (!Number.isFinite(exConsec) || exConsec < 2) {
          errors.push("Fav-band exit: plus-bas consÃ©cutifs doit Ãªtre â‰¥ 2");
        }
        if (!Number.isFinite(exLookback) || exLookback <= 0) {
          errors.push("Fav-band exit: lookback doit Ãªtre > 0 ms");
        }
        if (!Number.isFinite(exElapsed) || exElapsed < 0) {
          errors.push("Fav-band exit: min elapsed doit Ãªtre â‰¥ 0");
        }
        if (form.favBandExitSwitchEnabled) {
          const swBudget = Number(form.favBandExitSwitchOrderUsdc);
          if (!Number.isFinite(swBudget) || swBudget <= 0) {
            errors.push("Fav-band exit switch: budget doit Ãªtre > 0");
          }
          const maxPos = Number(form.maxOpenPositionsPerSide);
          if (Number.isFinite(maxPos) && maxPos < 2) {
            errors.push("Fav-band exit switch: max positions par cÃ´tÃ© doit Ãªtre â‰¥ 2");
          }
        }
      }
    }
    if (form.strategyId === "dip-revert") {
      const lo = Number(form.dipRevertBandMin);
      const hi = Number(form.dipRevertBandMax);
      const drop = Number(form.dipRevertMinDrop);
      const lookback = Number(form.dipRevertDropLookbackMs);
      const elapsed = Number(form.dipRevertMinElapsedSec);
      const spread = Number(form.dipRevertMaxSpread);
      const budget = Number(form.dipRevertOrderUsdc);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        errors.push("Dip-revert: ask min doit Ãªtre < ask max");
      }
      if (!Number.isFinite(drop) || drop <= 0) {
        errors.push("Dip-revert: min drop doit Ãªtre > 0");
      }
      if (!Number.isFinite(lookback) || lookback <= 0) {
        errors.push("Dip-revert: lookback doit Ãªtre > 0 ms");
      }
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        errors.push("Dip-revert: min elapsed entre 0 et 900");
      }
      if (form.dipRevertMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.dipRevertMaxElapsedSec);
        if (!Number.isFinite(maxE) || maxE < elapsed) {
          errors.push("Dip-revert: max elapsed invalide");
        }
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Dip-revert: max spread doit Ãªtre >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Dip-revert: budget doit Ãªtre > 0");
      }
      if (form.dipRevertExitTakeProfitEnabled) {
        const tpAsk = Number(form.dipRevertExitWinAsk);
        if (!Number.isFinite(tpAsk) || tpAsk <= 0 || tpAsk >= 1) {
          errors.push("Dip-revert: take-profit ask entre 0 et 1");
        } else if (Number.isFinite(hi) && tpAsk <= hi) {
          errors.push("Dip-revert: take-profit ask doit Ãªtre > ask max (bande d'entrÃ©e)");
        }
      }
    }
    if (form.strategyId === "antiflip-revert") {
      const lo = Number(form.antiflipBandMin);
      const hi = Number(form.antiflipBandMax);
      const floor = Number(form.antiflipDeposedAskMin);
      const lookback = Number(form.antiflipFlipLookbackMs);
      const elapsed = Number(form.antiflipMinElapsedSec);
      const spread = Number(form.antiflipMaxSpread);
      const budget = Number(form.antiflipOrderUsdc);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        errors.push("Antiflip: ask min doit Ãªtre < ask max");
      }
      if (form.antiflipDeposedAskMin.trim() !== "" && (!Number.isFinite(floor) || floor < lo || floor > hi)) {
        errors.push("Antiflip: floor du dÃ©chu doit Ãªtre dans la bande (ou vide)");
      }
      if (!Number.isFinite(lookback) || lookback <= 0) {
        errors.push("Antiflip: lookback de flip doit Ãªtre > 0 ms");
      }
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        errors.push("Antiflip: min elapsed entre 0 et 900");
      }
      if (form.antiflipMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.antiflipMaxElapsedSec);
        if (!Number.isFinite(maxE) || maxE < elapsed) {
          errors.push("Antiflip: max elapsed invalide");
        }
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Antiflip: max spread doit Ãªtre >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Antiflip: budget doit Ãªtre > 0");
      }
      // Miroir backend (config.ts) : bounceFloor null ou dans la bande.
      if (form.antiflipBounceFloor.trim() !== "") {
        const bFloor = Number(form.antiflipBounceFloor);
        if (!Number.isFinite(bFloor) || bFloor < lo || bFloor > hi) {
          errors.push("Antiflip: bounce floor doit Ãªtre dans la bande (ou vide)");
        }
      }
    }
    if (form.strategyId === "flip-confirm") {
      const lo = Number(form.flipConfirmBandMin);
      const hi = Number(form.flipConfirmBandMax);
      const lookback = Number(form.flipConfirmFlipLookbackMs);
      const elapsed = Number(form.flipConfirmMinElapsedSec);
      const spread = Number(form.flipConfirmMaxSpread);
      const budget = Number(form.flipConfirmOrderUsdc);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        errors.push("Flip-confirm: ask min doit Ãªtre < ask max");
      }
      if (!Number.isFinite(lookback) || lookback <= 0) {
        errors.push("Flip-confirm: lookback de flip doit Ãªtre > 0 ms");
      }
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        errors.push("Flip-confirm: min elapsed entre 0 et 900");
      }
      if (form.flipConfirmMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.flipConfirmMaxElapsedSec);
        if (!Number.isFinite(maxE) || maxE < elapsed) {
          errors.push("Flip-confirm: max elapsed invalide");
        }
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Flip-confirm: max spread doit Ãªtre >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Flip-confirm: budget doit Ãªtre > 0");
      }
    }
    if (form.strategyId === "early-conviction") {
      const lo = Number(form.earlyConvictionAskMin);
      const hi = Number(form.earlyConvictionAskMax);
      const maxElapsed = Number(form.earlyConvictionMaxElapsedSec);
      const spread = Number(form.earlyConvictionMaxSpread);
      const budget = Number(form.earlyConvictionOrderUsdc);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        errors.push("Early-conviction: ask min doit Ãªtre < ask max");
      }
      if (Number.isFinite(lo) && lo < 0.5) {
        errors.push("Early-conviction: ask min doit Ãªtre >= 0.5");
      }
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        errors.push("Early-conviction: max elapsed entre 0 (exclu) et 900");
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Early-conviction: max spread doit Ãªtre >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Early-conviction: budget doit Ãªtre > 0");
      }
    }
    if (form.strategyId === "early-low") {
      const lo = Number(form.earlyLowBuyAskMin);
      const hi = Number(form.earlyLowBuyAskMax);
      const maxElapsed = Number(form.earlyLowMaxElapsedSec);
      const spread = Number(form.earlyLowMaxSpread);
      const budget = Number(form.earlyLowOrderUsdc);
      const exitAsk = Number(form.earlyLowExitAsk);
      const momentum = Number(form.earlyLowExitMomentumMin);
      if (!Number.isFinite(lo) || lo < 0) {
        errors.push("Early-low: ask min doit Ãªtre >= 0 (0 = off)");
      }
      if (!Number.isFinite(hi) || hi <= lo || hi >= 0.5) {
        errors.push("Early-low: bande max < 0.5 et > ask min (token dÃ©cotÃ©)");
      }
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        errors.push("Early-low: max elapsed entre 1 et 900 s");
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Early-low: max spread >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Early-low: budget doit Ãªtre > 0");
      }
      if (form.earlyLowExitEnabled) {
        if (!Number.isFinite(exitAsk) || exitAsk <= 0 || exitAsk >= 1) {
          errors.push("Early-low: exit ask en (0, 1)");
        }
        if (Number.isFinite(exitAsk) && Number.isFinite(hi) && exitAsk <= hi) {
          errors.push("Early-low: exit ask doit Ãªtre > bande max d'achat");
        }
        if (!Number.isFinite(momentum) || momentum < 0) {
          errors.push("Early-low: momentum min >= 0");
        }
      }
    }
    if (form.strategyId === "open-entry") {
      const lean = Number(form.openEntryLeanTrigger);
      const maxElapsed = Number(form.openEntryMaxElapsedSec);
      const fair = Number(form.openEntryFairAskSumMax);
      const spread = Number(form.openEntryMaxSpread);
      const budget = Number(form.openEntryOrderUsdc);
      const flipDist = Number(form.openEntrySlStructFlipDist);
      const confirmSec = Number(form.openEntrySlStructConfirmSec);
      const structDist = Number(form.openEntrySlStructDist);
      const lateAfter = Number(form.openEntrySlLateAfterSec);
      const lateDist = Number(form.openEntrySlLateDist);
      if (!Number.isFinite(lean) || lean <= 0 || lean > 0.5) {
        errors.push("Open-entry: lean trigger entre 0 (exclu) et 0.5");
      }
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        errors.push("Open-entry: max elapsed entre 0 (exclu) et 900");
      }
      if (!Number.isFinite(fair) || fair <= 1 || fair > 1.2) {
        errors.push("Open-entry: fair ask sum entre 1 (exclu) et 1.2");
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Open-entry: max spread doit Ãªtre >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Open-entry: budget doit Ãªtre > 0");
      }
      if (!Number.isFinite(flipDist) || flipDist <= 0 || flipDist > 1) {
        errors.push("Open-entry: SL struct flip dist entre 0 (exclu) et 1");
      }
      if (!Number.isFinite(confirmSec) || confirmSec < 0 || confirmSec > 900) {
        errors.push("Open-entry: SL struct confirm sec entre 0 et 900");
      }
      if (!Number.isFinite(structDist) || structDist <= 0 || structDist > 1) {
        errors.push("Open-entry: SL struct dist entre 0 (exclu) et 1");
      }
      if (!Number.isFinite(lateAfter) || lateAfter <= 0 || lateAfter > 900) {
        errors.push("Open-entry: SL late after sec entre 0 (exclu) et 900");
      }
      if (!Number.isFinite(lateDist) || lateDist <= 0 || lateDist > structDist) {
        errors.push("Open-entry: SL late dist doit Ãªtre <= SL struct dist (le tardif est le plus serrÃ©)");
      }
    }
    if (form.strategyId === "probability-repricing") {
      const tauMin = Number(form.repricingTauMinSec);
      const spreadMax = Number(form.repricingSpreadMax);
      const pEntryMax = Number(form.repricingPEntryMax);
      const edgeMin = Number(form.repricingEdgeMin);
      const orderUsdc = Number(form.repricingOrderUsdc);
      const targetAbs = Number(form.repricingTargetAbs);
      const targetRel = Number(form.repricingTargetRel);
      const stopAbs = Number(form.repricingStopAbs);
      const holdMax = Number(form.repricingHoldMaxSec);
      const tauForce = Number(form.repricingTauForceExitSec);
      const spreadMaxExit = Number(form.repricingSpreadMaxExit);
      const lateWindow = Number(form.repricingLateWindowSec);
      const historyMs = Number(form.repricingHistoryWindowMs);
      const dislocationMin = Number(form.repricingDislocationMin);
      const feedAge = Number(form.repricingFeedMaxAgeMs);
      const signalTtl = Number(form.repricingSignalTtlMs);
      const fees = Number(form.repricingFeesRoundtrip);
      const slipEntry = Number(form.repricingSlipEntryBuffer);
      const slipExit = Number(form.repricingSlipExitBuffer);
      const notionalMax = Number(form.repricingNotionalMaxPerMarket);
      if (!Number.isFinite(tauMin) || tauMin <= 0 || tauMin > 900) {
        errors.push("Repricing: tau min sec entre 0 (exclu) et 900");
      }
      if (!Number.isFinite(spreadMax) || spreadMax < 0) {
        errors.push("Repricing: spread max doit Ãªtre >= 0");
      }
      if (!Number.isFinite(pEntryMax) || pEntryMax <= 0 || pEntryMax > 1) {
        errors.push("Repricing: p entry max entre 0 (exclu) et 1");
      }
      if (!Number.isFinite(edgeMin) || edgeMin < 0) {
        errors.push("Repricing: edge min doit Ãªtre >= 0");
      }
      if (!Number.isFinite(orderUsdc) || orderUsdc <= 0) {
        errors.push("Repricing: order USDC doit Ãªtre > 0");
      }
      if (!Number.isFinite(targetAbs) || targetAbs <= 0 || targetAbs > 1) {
        errors.push("Repricing: target abs entre 0 (exclu) et 1");
      }
      if (!Number.isFinite(targetRel) || targetRel < 0) {
        errors.push("Repricing: target rel doit Ãªtre >= 0");
      }
      if (!Number.isFinite(stopAbs) || stopAbs <= 0 || stopAbs > 1) {
        errors.push("Repricing: stop abs entre 0 (exclu) et 1");
      }
      if (!Number.isFinite(holdMax) || holdMax <= 0) {
        errors.push("Repricing: hold max sec doit Ãªtre > 0");
      }
      if (!Number.isFinite(tauForce) || tauForce <= 0 || !(Number.isFinite(tauMin) && tauForce < tauMin)) {
        errors.push("Repricing: tau force exit doit Ãªtre dans (0, tau min)");
      }
      if (!Number.isFinite(spreadMaxExit) || (Number.isFinite(spreadMax) && spreadMaxExit < spreadMax)) {
        errors.push("Repricing: spread max exit doit Ãªtre >= spread max");
      }
      if (!Number.isFinite(lateWindow) || lateWindow <= 0) {
        errors.push("Repricing: late window sec doit Ãªtre > 0");
      }
      if (!Number.isFinite(historyMs) || historyMs < 1000) {
        errors.push("Repricing: history window ms doit Ãªtre >= 1000");
      }
      if (!Number.isFinite(dislocationMin) || dislocationMin <= 0) {
        errors.push("Repricing: dislocation min doit Ãªtre > 0");
      }
      if (!Number.isFinite(feedAge) || feedAge <= 0) {
        errors.push("Repricing: feed max age ms doit Ãªtre > 0");
      }
      if (!Number.isFinite(signalTtl) || signalTtl <= 0) {
        errors.push("Repricing: signal TTL ms doit Ãªtre > 0");
      }
      if (!Number.isFinite(fees) || fees < 0) {
        errors.push("Repricing: fees roundtrip doit Ãªtre >= 0");
      }
      if (!Number.isFinite(slipEntry) || slipEntry < 0) {
        errors.push("Repricing: slip entry buffer doit Ãªtre >= 0");
      }
      if (!Number.isFinite(slipExit) || slipExit < 0) {
        errors.push("Repricing: slip exit buffer doit Ãªtre >= 0");
      }
      if (!Number.isFinite(notionalMax) || notionalMax <= 0) {
        errors.push("Repricing: notional max per market doit Ãªtre > 0");
      }
    }
    // Edge-lead : validations dÃ©diÃ©es. Les champs arb/barbell (cheap/hedge
    // bandes, pairLockMax, barbellHedgeRatio) ne s'appliquent pas Ã  ce moteur.
    if (edge) {
      const edgeBandMin = parseNum(form.edgeBandMin, "Edge band min");
      const edgeBandMax = parseNum(form.edgeBandMax, "Edge band max");
      const edgeConfirmSamples = parseNum(form.edgeConfirmSamples, "Edge confirm samples");
      const edgeMaxDownTick = parseNum(form.edgeMaxDownTick, "Edge max down tick");
      const edgeOrderUsdc = parseNum(form.edgeOrderUsdc, "Edge order USDC");
      const maxShareEdge = parseNum(form.maxShareEdge, "Max shares edge");
      const edgeCheapOrderUsdc = parseNum(form.edgeCheapOrderUsdc, "Budget cheap");
      const edgeCheapBandMin = parseNum(form.edgeCheapBandMin, "Cheap band min");
      const edgeCheapBandMax = parseNum(form.edgeCheapBandMax, "Cheap band max");
      if (edgeBandMin >= edgeBandMax) {
        errors.push("Edge band min doit Ãªtre < edge band max");
      }
      if (edgeBandMin < 0.50 || edgeBandMax > 0.99) {
        errors.push("Edge band doit Ãªtre dans [0.50, 0.99]");
      }
      if (edgeConfirmSamples < 2) {
        errors.push("Edge confirm samples doit Ãªtre â‰¥ 2");
      }
      if (edgeMaxDownTick <= 0) {
        errors.push("Edge max down tick doit Ãªtre > 0");
      }
      if (edgeOrderUsdc <= 0) {
        errors.push("Edge order USDC doit Ãªtre > 0");
      }
      if (maxShareEdge < 1) {
        errors.push("Max shares edge doit Ãªtre â‰¥ 1");
      }
      if (edgeCheapOrderUsdc <= 0) {
        errors.push("Budget cheap doit Ãªtre > 0");
      }
      if (edgeCheapBandMin >= edgeCheapBandMax) {
        errors.push("Cheap band min doit Ãªtre < cheap band max");
      }
      if (edgeCheapBandMin < 0.01 || edgeCheapBandMax > 0.49) {
        errors.push("Cheap band doit Ãªtre dans [0.01, 0.49]");
      }
      if (
        form.edgeSizingMode !== "shares" &&
        form.edgeSizingMode !== "pusd" &&
        form.edgeSizingMode !== "dynamic"
      ) {
        errors.push("Mode de sizing doit Ãªtre shares, pusd ou dynamic");
      }
      if (form.edgeSizingMode === "shares") {
        const edgeSharesEdge = parseNum(form.edgeSharesEdge, "Shares edge");
        const edgeSharesCheap = parseNum(form.edgeSharesCheap, "Shares cheap");
        if (edgeSharesEdge < 5) {
          errors.push("Shares edge doit Ãªtre â‰¥ 5 (minimum CLOB)");
        }
        if (edgeSharesCheap < 5) {
          errors.push("Shares cheap doit Ãªtre â‰¥ 5 (minimum CLOB)");
        }
      }
      const sellAfterMin = parseNum(form.edgeSellExpensiveAfterMin, "Vente edge aprÃ¨s (min)");
      const sellLossPct = parseNum(form.edgeSellExpensiveLossPct, "Perte edge %");
      const sellLossWindowMs = parseNum(form.edgeSellExpensiveLossWindowMs, "FenÃªtre perte edge (ms)");
      if (sellAfterMin < 0) {
        errors.push("Vente edge aprÃ¨s (min) doit Ãªtre â‰¥ 0");
      }
      if (sellLossPct <= 0) {
        errors.push("Perte edge % doit Ãªtre > 0");
      }
      if (sellLossWindowMs <= 0) {
        errors.push("FenÃªtre perte edge (ms) doit Ãªtre > 0");
      }
    }
    if (form.favBandWhipsawEnabled) {
      if (form.favBandWhipsawPauseAfterLosses.trim() !== "") {
        const n = Number(form.favBandWhipsawPauseAfterLosses);
        if (!Number.isFinite(n) || n < 1) errors.push("Whipsaw: pause apres N pertes doit etre >= 1 (ou vide = off)");
      }
      const pw = Number(form.favBandWhipsawPauseWindows);
      if (!Number.isFinite(pw) || pw < 1) errors.push("Whipsaw: fenetres de pause >= 1");
      if (form.favBandWhipsawMaxScore.trim() !== "") {
        const s = Number(form.favBandWhipsawMaxScore);
        if (!Number.isFinite(s) || s < 0 || s > 100) errors.push("Whipsaw: score max dans [0, 100] (ou vide = off)");
      }
      if (form.favBandWhipsawMaxIntraFlips.trim() !== "") {
        const f = Number(form.favBandWhipsawMaxIntraFlips);
        if (!Number.isFinite(f) || f < 1) errors.push("Whipsaw: max flips >= 1 (ou vide = off)");
      }
    }
    if (form.favBandImbalanceCrossMin.trim() !== "") {
      const v = Number(form.favBandImbalanceCrossMin);
      if (!Number.isFinite(v) || v <= -1 || v >= 1) {
        errors.push("Imbalance: plancher cross dans (-1, 1) (ou vide = off)");
      }
    }
    if (form.favBandImbalanceTicks.trim() !== "") {
      const n = Number(form.favBandImbalanceTicks);
      if (!Number.isFinite(n) || n < 1) errors.push("Imbalance: ticks >= 1 (ou vide = defaut 2)");
    }
    if (form.favBandImbalanceMaxSpread.trim() !== "") {
      const s = Number(form.favBandImbalanceMaxSpread);
      if (!Number.isFinite(s) || s <= 0) errors.push("Imbalance: spread max > 0 (ou vide = off)");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return errors;
}

/**
 * Mappe les erreurs de validateConfigForm aux champs du formulaire concernÃ©s.
 * Retourne un Record<key, message> pour affichage inline dans le panel.
 */
export function fieldErrors(
  form: ConfigFormState,
  isBacktest: boolean,
  opts?: { leadsWithEdge?: boolean },
): Partial<Record<keyof ConfigFormState, string>> {
  const result: Partial<Record<keyof ConfigFormState, string>> = {};
  const edge = engineUsesEdge(form.strategyId, opts?.leadsWithEdge);

  try {
    const cheapBuyMin = Number(form.cheapBuyMin);
    const cheapBuyMax = Number(form.cheapBuyMax);
    const expensiveBuyMin = Number(form.expensiveBuyMin);
    const expensiveBuyMax = Number(form.expensiveBuyMax);
    const pairLockMax = Number(form.pairLockMax);
    const barbellHedgeRatio = Number(form.barbellHedgeRatio);
    const minutesBeforeCloseMin = Number(form.minutesBeforeCloseMin);
    const minutesBeforeCloseMax = Number(form.minutesBeforeCloseMax);
    const pollIntervalMs = Number(form.pollIntervalMs);
    const maxOpenPositionsPerSide = Number(form.maxOpenPositionsPerSide);
    const simFillProbability = Number(form.simFillProbabilityNonMarketable);
    const simResolveRetryIntervalMs = Number(form.simResolveRetryIntervalMs);

    // Parse errors (NaN)
    if (!Number.isFinite(cheapBuyMin)) result.cheapBuyMin = "Nombre invalide";
    if (!Number.isFinite(cheapBuyMax)) result.cheapBuyMax = "Nombre invalide";
    if (!Number.isFinite(expensiveBuyMin)) result.expensiveBuyMin = "Nombre invalide";
    if (!Number.isFinite(expensiveBuyMax)) result.expensiveBuyMax = "Nombre invalide";
    if (!Number.isFinite(pairLockMax)) result.pairLockMax = "Nombre invalide";
    if (!Number.isFinite(barbellHedgeRatio)) result.barbellHedgeRatio = "Nombre invalide";
    if (!Number.isFinite(minutesBeforeCloseMin)) result.minutesBeforeCloseMin = "Nombre invalide";
    if (!Number.isFinite(minutesBeforeCloseMax)) result.minutesBeforeCloseMax = "Nombre invalide";
    if (!Number.isFinite(pollIntervalMs)) result.pollIntervalMs = "Nombre invalide";
    if (!Number.isFinite(maxOpenPositionsPerSide)) result.maxOpenPositionsPerSide = "Nombre invalide";
    if (!Number.isFinite(simFillProbability)) result.simFillProbabilityNonMarketable = "Nombre invalide";
    if (!Number.isFinite(simResolveRetryIntervalMs)) result.simResolveRetryIntervalMs = "Nombre invalide";

    // Range / relation errors
    if (Number.isFinite(cheapBuyMin) && Number.isFinite(cheapBuyMax) && cheapBuyMin > cheapBuyMax) {
      result.cheapBuyMax = "Cheap max doit Ãªtre â‰¥ cheap min";
    }
    if (Number.isFinite(expensiveBuyMin) && Number.isFinite(expensiveBuyMax) && expensiveBuyMin > expensiveBuyMax) {
      result.expensiveBuyMax = "Hedge max doit Ãªtre â‰¥ hedge min";
    }
    if (!edge) {
      if (
        form.strategyId !== "fav-band" &&
        form.strategyId !== "dip-revert" &&
        form.strategyId !== "antiflip-revert" &&
        form.strategyId !== "flip-confirm" &&
        form.strategyId !== "early-conviction" &&
        form.strategyId !== "open-entry" &&
        form.strategyId !== "probability-repricing" &&
        Number.isFinite(cheapBuyMax) &&
        Number.isFinite(expensiveBuyMin) &&
        cheapBuyMax >= expensiveBuyMin
      ) {
        result.expensiveBuyMin = "Hedge min doit Ãªtre > cheap max";
      }
      if (form.strategyId === "arb") {
        if (Number.isFinite(pairLockMax) && (pairLockMax < 0.9 || pairLockMax >= 1.0)) {
          result.pairLockMax = "Entre 0.90 et 0.99";
        }
        if (form.arbAskSumMax.trim() !== "") {
          const askSum = Number(form.arbAskSumMax);
          if (!Number.isFinite(askSum)) {
            result.arbAskSumMax = "Nombre invalide";
          } else if (askSum < 0.9 || (Number.isFinite(pairLockMax) && askSum > pairLockMax)) {
            result.arbAskSumMax = "Entre 0.90 et pairLockMax";
          }
        }
        if (!form.enableExpensiveHedge) {
          result.enableExpensiveHedge = "Obligatoire pour arb";
        }
      }
      if (form.strategyId === "barbell") {
        if (Number.isFinite(barbellHedgeRatio) && !(barbellHedgeRatio > 0 && barbellHedgeRatio <= 1)) {
          result.barbellHedgeRatio = "Doit Ãªtre dans (0, 1]";
        }
      }
    }
    if (Number.isFinite(minutesBeforeCloseMin) && Number.isFinite(minutesBeforeCloseMax) && minutesBeforeCloseMin > minutesBeforeCloseMax) {
      result.minutesBeforeCloseMax = "Max doit Ãªtre â‰¥ min";
    }
    if (Number.isFinite(pollIntervalMs) && pollIntervalMs < 500) {
      result.pollIntervalMs = "â‰¥ 500 ms";
    }
    if (Number.isFinite(maxOpenPositionsPerSide) && maxOpenPositionsPerSide < 1) {
      result.maxOpenPositionsPerSide = "â‰¥ 1";
    }
    if (Number.isFinite(simFillProbability) && (simFillProbability < 0 || simFillProbability > 1)) {
      result.simFillProbabilityNonMarketable = "Entre 0 et 1";
    }
    if (Number.isFinite(simResolveRetryIntervalMs) && simResolveRetryIntervalMs < 500) {
      result.simResolveRetryIntervalMs = "â‰¥ 500 ms";
    }

    // Validation des champs sim exposÃ©s dans le panel
    const simResolveDelaySeconds = Number(form.simResolveDelaySeconds);
    const simResolveMaxRetries = Number(form.simResolveMaxRetries);
    const simMaxRetryAttempts = Number(form.simMaxRetryAttempts);
    const simulatedCapital = Number(form.simulatedCapital);
    const maxExposureUsdc = Number(form.maxExposureUsdc);
    const maxSharesPerOrder = Number(form.maxSharesPerOrder);

    if (!Number.isFinite(simResolveDelaySeconds)) result.simResolveDelaySeconds = "Nombre invalide";
    else if (simResolveDelaySeconds < 0) result.simResolveDelaySeconds = "â‰¥ 0";
    if (!Number.isFinite(simResolveMaxRetries)) result.simResolveMaxRetries = "Nombre invalide";
    else if (simResolveMaxRetries < 0) result.simResolveMaxRetries = "â‰¥ 0";
    if (!Number.isFinite(simMaxRetryAttempts)) result.simMaxRetryAttempts = "Nombre invalide";
    else if (simMaxRetryAttempts < 0) result.simMaxRetryAttempts = "â‰¥ 0";
    if (!Number.isFinite(simulatedCapital)) result.simulatedCapital = "Nombre invalide";
    else if (simulatedCapital <= 0) result.simulatedCapital = "> 0";
    if (!Number.isFinite(maxExposureUsdc)) result.maxExposureUsdc = "Nombre invalide";
    else if (maxExposureUsdc <= 0) result.maxExposureUsdc = "> 0";
    if (!Number.isFinite(maxSharesPerOrder)) result.maxSharesPerOrder = "Nombre invalide";
    else if (maxSharesPerOrder < 1) result.maxSharesPerOrder = "â‰¥ 1";
    if (!isBacktest && form.simResolveFallback === "probabilistic") {
      result.simResolveFallback = "Interdit en live";
    }
    if (form.marketSlugPrefixes.split(",").map((s) => s.trim()).filter(Boolean).length === 0) {
      result.marketSlugPrefixes = "Au moins un prÃ©fixe requis";
    }

    // Edge-lead validations
    if (edge) {
      const edgeBandMin = Number(form.edgeBandMin);
      const edgeBandMax = Number(form.edgeBandMax);
      const edgeConfirmSamples = Number(form.edgeConfirmSamples);
      const edgeMaxDownTick = Number(form.edgeMaxDownTick);
      const edgeOrderUsdc = Number(form.edgeOrderUsdc);
      const maxShareEdge = Number(form.maxShareEdge);
      const edgeCheapOrderUsdc = Number(form.edgeCheapOrderUsdc);
      const edgeCheapBandMin = Number(form.edgeCheapBandMin);
      const edgeCheapBandMax = Number(form.edgeCheapBandMax);

      if (!Number.isFinite(edgeBandMin)) result.edgeBandMin = "Nombre invalide";
      if (!Number.isFinite(edgeBandMax)) result.edgeBandMax = "Nombre invalide";
      if (Number.isFinite(edgeBandMin) && Number.isFinite(edgeBandMax)) {
        if (edgeBandMin >= edgeBandMax) result.edgeBandMax = "Max doit Ãªtre > min";
        if (edgeBandMin < 0.5 || edgeBandMax > 0.99) result.edgeBandMin = "Bande dans [0.50, 0.99]";
      }
      if (Number.isFinite(edgeConfirmSamples) && edgeConfirmSamples < 2) result.edgeConfirmSamples = "â‰¥ 2";
      if (Number.isFinite(edgeMaxDownTick) && edgeMaxDownTick <= 0) result.edgeMaxDownTick = "> 0";
      if (Number.isFinite(edgeOrderUsdc) && edgeOrderUsdc <= 0) result.edgeOrderUsdc = "> 0";
      if (Number.isFinite(maxShareEdge) && maxShareEdge < 1) result.maxShareEdge = "â‰¥ 1";
      if (Number.isFinite(edgeCheapOrderUsdc) && edgeCheapOrderUsdc <= 0) result.edgeCheapOrderUsdc = "> 0";
      if (Number.isFinite(edgeCheapBandMin) && Number.isFinite(edgeCheapBandMax)) {
        if (edgeCheapBandMin >= edgeCheapBandMax) result.edgeCheapBandMax = "Max doit Ãªtre > min";
        if (edgeCheapBandMin < 0.01 || edgeCheapBandMax > 0.49) result.edgeCheapBandMin = "Bande dans [0.01, 0.49]";
      }
      if (form.edgeSizingMode === "shares") {
        const edgeSharesEdge = Number(form.edgeSharesEdge);
        const edgeSharesCheap = Number(form.edgeSharesCheap);
        if (Number.isFinite(edgeSharesEdge) && edgeSharesEdge < 5) result.edgeSharesEdge = "â‰¥ 5 (min CLOB)";
        if (Number.isFinite(edgeSharesCheap) && edgeSharesCheap < 5) result.edgeSharesCheap = "â‰¥ 5 (min CLOB)";
      }
      const sellAfterMin = Number(form.edgeSellExpensiveAfterMin);
      const sellLossPct = Number(form.edgeSellExpensiveLossPct);
      const sellLossWindowMs = Number(form.edgeSellExpensiveLossWindowMs);
      if (Number.isFinite(sellAfterMin) && sellAfterMin < 0) result.edgeSellExpensiveAfterMin = "â‰¥ 0";
      if (Number.isFinite(sellLossPct) && sellLossPct <= 0) result.edgeSellExpensiveLossPct = "> 0";
      if (Number.isFinite(sellLossWindowMs) && sellLossWindowMs <= 0) result.edgeSellExpensiveLossWindowMs = "> 0";
    }

    if (form.strategyId === "reverse" && form.reverseMaxGridLevels.trim() !== "") {
      const maxLevels = Number(form.reverseMaxGridLevels);
      if (!Number.isFinite(maxLevels) || maxLevels < 1) {
        result.reverseMaxGridLevels = "vide ou â‰¥ 1";
      }
    }

    if (form.strategyId === "fav-band") {
      const lo = Number(form.favBandAskMin);
      const hi = Number(form.favBandAskMax);
      const elapsed = Number(form.favBandMinElapsedSec);
      if (!Number.isFinite(lo)) result.favBandAskMin = "Nombre invalide";
      if (!Number.isFinite(hi)) result.favBandAskMax = "Nombre invalide";
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= hi) {
        result.favBandAskMin = "Doit Ãªtre < ask max";
      }
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        result.favBandMinElapsedSec = "Entre 0 et 900";
      }
      if (form.favBandMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.favBandMaxElapsedSec);
        if (!Number.isFinite(maxE) || (Number.isFinite(elapsed) && maxE < elapsed)) {
          result.favBandMaxElapsedSec = "Vide ou >= min elapsed";
        }
      }
      if (form.favBandInverseEnabled) {
        const invAsk = Number(form.favBandInverseAskMax);
        const invRatio = Number(form.favBandInverseShareRatio);
        const invBudget = Number(form.favBandInverseOrderUsdc);
        const maxPos = Number(form.maxOpenPositionsPerSide);
        if (!Number.isFinite(invAsk)) {
          result.favBandInverseAskMax = "Nombre invalide";
        } else if (invAsk <= 0 || invAsk >= 0.5) {
          result.favBandInverseAskMax = "Entre 0 et 0.5";
        }
        if (!Number.isFinite(invRatio) || invRatio <= 0) {
          result.favBandInverseShareRatio = "> 0";
        }
        if (!Number.isFinite(invBudget)) {
          result.favBandInverseOrderUsdc = "Nombre invalide";
        } else if (Number.isFinite(invAsk) && invAsk > 0 && invAsk < 0.5) {
          const maxShares = Number(form.maxSharesPerOrder);
          const cap = Number.isFinite(maxShares) && maxShares > 0 ? maxShares : Number.MAX_SAFE_INTEGER;
          const sized = Math.floor(Math.min(invBudget / invAsk, cap) * 100) / 100;
          if (sized < 5) {
            result.favBandInverseOrderUsdc = `Min ${Math.ceil(5 * invAsk * 100) / 100} USDC (5 shares)`;
          }
        }
        if (Number.isFinite(maxPos) && maxPos < 2) {
          result.maxOpenPositionsPerSide = "â‰¥ 2 (jambe inverse)";
        }
      }
      if (form.favBandExitEnabled) {
        const exDrop = Number(form.favBandExitMinLowerHighDrop);
        const exRetrace = Number(form.favBandExitRetraceRatio);
        const exConsec = Number(form.favBandExitConsecutive);
        const exLookback = Number(form.favBandExitLookbackMs);
        const exElapsed = Number(form.favBandExitMinElapsedSec);
        if (!Number.isFinite(exDrop) || exDrop <= 0) {
          result.favBandExitMinLowerHighDrop = "> 0";
        }
        if (!Number.isFinite(exRetrace) || exRetrace < 0 || exRetrace > 1) {
          result.favBandExitRetraceRatio = "[0, 1]";
        }
        if (!Number.isFinite(exConsec) || exConsec < 2) {
          result.favBandExitConsecutive = "â‰¥ 2";
        }
        if (!Number.isFinite(exLookback) || exLookback <= 0) {
          result.favBandExitLookbackMs = "> 0 ms";
        }
        if (!Number.isFinite(exElapsed) || exElapsed < 0) {
          result.favBandExitMinElapsedSec = "â‰¥ 0";
        }
        if (form.favBandExitSwitchEnabled) {
          const swBudget = Number(form.favBandExitSwitchOrderUsdc);
          if (!Number.isFinite(swBudget) || swBudget <= 0) {
            result.favBandExitSwitchOrderUsdc = "> 0";
          }
          const maxPos = Number(form.maxOpenPositionsPerSide);
          if (Number.isFinite(maxPos) && maxPos < 2) {
            result.maxOpenPositionsPerSide = "â‰¥ 2 (jambe switch)";
          }
        }
      }
    }
    if (form.strategyId === "dip-revert") {
      const lo = Number(form.dipRevertBandMin);
      const hi = Number(form.dipRevertBandMax);
      const drop = Number(form.dipRevertMinDrop);
      const lookback = Number(form.dipRevertDropLookbackMs);
      const elapsed = Number(form.dipRevertMinElapsedSec);
      const spread = Number(form.dipRevertMaxSpread);
      const budget = Number(form.dipRevertOrderUsdc);
      if (!Number.isFinite(lo)) result.dipRevertBandMin = "Nombre invalide";
      if (!Number.isFinite(hi)) result.dipRevertBandMax = "Nombre invalide";
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= hi) {
        result.dipRevertBandMin = "Doit Ãªtre < ask max";
      }
      if (!Number.isFinite(drop) || drop <= 0) result.dipRevertMinDrop = "> 0";
      if (!Number.isFinite(lookback) || lookback <= 0) result.dipRevertDropLookbackMs = "> 0 ms";
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        result.dipRevertMinElapsedSec = "Entre 0 et 900";
      }
      if (form.dipRevertMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.dipRevertMaxElapsedSec);
        if (!Number.isFinite(maxE) || (Number.isFinite(elapsed) && maxE < elapsed)) {
          result.dipRevertMaxElapsedSec = "Vide ou >= min elapsed";
        }
      }
      if (!Number.isFinite(spread) || spread < 0) result.dipRevertMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.dipRevertOrderUsdc = "> 0";
    }
    if (form.strategyId === "antiflip-revert") {
      const lo = Number(form.antiflipBandMin);
      const hi = Number(form.antiflipBandMax);
      const floor = Number(form.antiflipDeposedAskMin);
      const lookback = Number(form.antiflipFlipLookbackMs);
      const elapsed = Number(form.antiflipMinElapsedSec);
      const spread = Number(form.antiflipMaxSpread);
      const budget = Number(form.antiflipOrderUsdc);
      if (!Number.isFinite(lo)) result.antiflipBandMin = "Nombre invalide";
      if (!Number.isFinite(hi)) result.antiflipBandMax = "Nombre invalide";
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= hi) {
        result.antiflipBandMin = "Doit Ãªtre < ask max";
      }
      if (form.antiflipDeposedAskMin.trim() !== "" && (!Number.isFinite(floor) || floor < lo || floor > hi)) {
        result.antiflipDeposedAskMin = "Dans la bande (ou vide)";
      }
      if (!Number.isFinite(lookback) || lookback <= 0) result.antiflipFlipLookbackMs = "> 0 ms";
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        result.antiflipMinElapsedSec = "Entre 0 et 900";
      }
      if (form.antiflipMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.antiflipMaxElapsedSec);
        if (!Number.isFinite(maxE) || (Number.isFinite(elapsed) && maxE < elapsed)) {
          result.antiflipMaxElapsedSec = "Vide ou >= min elapsed";
        }
      }
      if (!Number.isFinite(spread) || spread < 0) result.antiflipMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.antiflipOrderUsdc = "> 0";
      const tp = Number(form.antiflipTakeProfitPct);
      if (!Number.isFinite(tp) || tp < 0 || tp > 0.9) {
        result.antiflipTakeProfitPct = "Entre 0 et 0.9 (0 = hold to resolution)";
      }
      // Miroir backend (config.ts validateConfigCoherence) : bounceFloor null
      // ou dans [bandMin, bandMax] â€” sinon le backend rejette au Apply.
      if (form.antiflipBounceFloor.trim() !== "") {
        const bFloor = Number(form.antiflipBounceFloor);
        if (
          !Number.isFinite(bFloor) ||
          (Number.isFinite(lo) && bFloor < lo) ||
          (Number.isFinite(hi) && bFloor > hi)
        ) {
          result.antiflipBounceFloor = "Dans la bande (ou vide)";
        }
      }
    }
    if (form.strategyId === "flip-confirm") {
      const lo = Number(form.flipConfirmBandMin);
      const hi = Number(form.flipConfirmBandMax);
      const lookback = Number(form.flipConfirmFlipLookbackMs);
      const elapsed = Number(form.flipConfirmMinElapsedSec);
      const spread = Number(form.flipConfirmMaxSpread);
      const budget = Number(form.flipConfirmOrderUsdc);
      if (!Number.isFinite(lo)) result.flipConfirmBandMin = "Nombre invalide";
      if (!Number.isFinite(hi)) result.flipConfirmBandMax = "Nombre invalide";
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= hi) {
        result.flipConfirmBandMin = "Doit Ãªtre < ask max";
      }
      if (!Number.isFinite(lookback) || lookback <= 0) result.flipConfirmFlipLookbackMs = "> 0 ms";
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        result.flipConfirmMinElapsedSec = "Entre 0 et 900";
      }
      if (form.flipConfirmMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.flipConfirmMaxElapsedSec);
        if (!Number.isFinite(maxE) || (Number.isFinite(elapsed) && maxE < elapsed)) {
          result.flipConfirmMaxElapsedSec = "Vide ou >= min elapsed";
        }
      }
      if (!Number.isFinite(spread) || spread < 0) result.flipConfirmMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.flipConfirmOrderUsdc = "> 0";
    }
    if (form.strategyId === "early-conviction") {
      const lo = Number(form.earlyConvictionAskMin);
      const hi = Number(form.earlyConvictionAskMax);
      const maxElapsed = Number(form.earlyConvictionMaxElapsedSec);
      const spread = Number(form.earlyConvictionMaxSpread);
      const budget = Number(form.earlyConvictionOrderUsdc);
      if (!Number.isFinite(lo)) result.earlyConvictionAskMin = "Nombre invalide";
      if (!Number.isFinite(hi)) result.earlyConvictionAskMax = "Nombre invalide";
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= hi) {
        result.earlyConvictionAskMin = "Doit Ãªtre < ask max";
      }
      if (Number.isFinite(lo) && lo < 0.5) result.earlyConvictionAskMin = ">= 0.5";
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        result.earlyConvictionMaxElapsedSec = "Entre 0 (exclu) et 900";
      }
      if (!Number.isFinite(spread) || spread < 0) result.earlyConvictionMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.earlyConvictionOrderUsdc = "> 0";
    }
    if (form.strategyId === "early-low") {
      const lo = Number(form.earlyLowBuyAskMin);
      const hi = Number(form.earlyLowBuyAskMax);
      const maxElapsed = Number(form.earlyLowMaxElapsedSec);
      const spread = Number(form.earlyLowMaxSpread);
      const budget = Number(form.earlyLowOrderUsdc);
      const exitAsk = Number(form.earlyLowExitAsk);
      const momentum = Number(form.earlyLowExitMomentumMin);
      if (!Number.isFinite(lo) || lo < 0) result.earlyLowBuyAskMin = ">= 0 (0 = off)";
      if (!Number.isFinite(hi) || hi <= lo) result.earlyLowBuyAskMax = "Doit Ãªtre > ask min";
      else if (hi >= 0.5) result.earlyLowBuyAskMax = "< 0.5";
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        result.earlyLowMaxElapsedSec = "Entre 1 et 900";
      }
      if (!Number.isFinite(spread) || spread < 0) result.earlyLowMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.earlyLowOrderUsdc = "> 0";
      if (form.earlyLowExitEnabled) {
        if (!Number.isFinite(exitAsk) || exitAsk <= 0 || exitAsk >= 1) { result.earlyLowExitAsk = "En (0, 1)"; }
        else if (Number.isFinite(hi) && exitAsk <= hi) { result.earlyLowExitAsk = "> bande max d'achat"; }
        if (!Number.isFinite(momentum) || momentum < 0) result.earlyLowExitMomentumMin = ">= 0";
      }
    }
    if (form.strategyId === "open-entry") {
      const lean = Number(form.openEntryLeanTrigger);
      const maxElapsed = Number(form.openEntryMaxElapsedSec);
      const fair = Number(form.openEntryFairAskSumMax);
      const spread = Number(form.openEntryMaxSpread);
      const budget = Number(form.openEntryOrderUsdc);
      const flipDist = Number(form.openEntrySlStructFlipDist);
      const confirmSec = Number(form.openEntrySlStructConfirmSec);
      const structDist = Number(form.openEntrySlStructDist);
      const lateAfter = Number(form.openEntrySlLateAfterSec);
      const lateDist = Number(form.openEntrySlLateDist);
      if (!Number.isFinite(lean) || lean <= 0 || lean > 0.5) {
        result.openEntryLeanTrigger = "Entre 0 (exclu) et 0.5";
      }
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        result.openEntryMaxElapsedSec = "Entre 0 (exclu) et 900";
      }
      if (!Number.isFinite(fair) || fair <= 1 || fair > 1.2) {
        result.openEntryFairAskSumMax = "Entre 1 (exclu) et 1.2";
      }
      if (!Number.isFinite(spread) || spread < 0) result.openEntryMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.openEntryOrderUsdc = "> 0";
      if (!Number.isFinite(flipDist) || flipDist <= 0 || flipDist > 1) {
        result.openEntrySlStructFlipDist = "Entre 0 (exclu) et 1";
      }
      if (!Number.isFinite(confirmSec) || confirmSec < 0 || confirmSec > 900) {
        result.openEntrySlStructConfirmSec = "Entre 0 et 900";
      }
      if (!Number.isFinite(structDist) || structDist <= 0 || structDist > 1) {
        result.openEntrySlStructDist = "Entre 0 (exclu) et 1";
      }
      if (!Number.isFinite(lateAfter) || lateAfter <= 0 || lateAfter > 900) {
        result.openEntrySlLateAfterSec = "Entre 0 (exclu) et 900";
      }
      if (
        Number.isFinite(lateDist) &&
        Number.isFinite(structDist) &&
        (lateDist <= 0 || lateDist > structDist)
      ) {
        result.openEntrySlLateDist = "Doit Ãªtre <= SL struct dist";
      }
    }
    if (form.strategyId === "probability-repricing") {
      const tauMin = Number(form.repricingTauMinSec);
      const spreadMax = Number(form.repricingSpreadMax);
      const pEntryMax = Number(form.repricingPEntryMax);
      const edgeMin = Number(form.repricingEdgeMin);
      const orderUsdc = Number(form.repricingOrderUsdc);
      const targetAbs = Number(form.repricingTargetAbs);
      const targetRel = Number(form.repricingTargetRel);
      const stopAbs = Number(form.repricingStopAbs);
      const holdMax = Number(form.repricingHoldMaxSec);
      const tauForce = Number(form.repricingTauForceExitSec);
      const spreadMaxExit = Number(form.repricingSpreadMaxExit);
      const lateWindow = Number(form.repricingLateWindowSec);
      const historyMs = Number(form.repricingHistoryWindowMs);
      const dislocationMin = Number(form.repricingDislocationMin);
      const feedAge = Number(form.repricingFeedMaxAgeMs);
      const signalTtl = Number(form.repricingSignalTtlMs);
      const fees = Number(form.repricingFeesRoundtrip);
      const slipEntry = Number(form.repricingSlipEntryBuffer);
      const slipExit = Number(form.repricingSlipExitBuffer);
      const notionalMax = Number(form.repricingNotionalMaxPerMarket);
      if (!Number.isFinite(tauMin) || tauMin <= 0 || tauMin > 900) {
        result.repricingTauMinSec = "Entre 0 (exclu) et 900";
      }
      if (!Number.isFinite(spreadMax) || spreadMax < 0) result.repricingSpreadMax = ">= 0";
      if (!Number.isFinite(pEntryMax) || pEntryMax <= 0 || pEntryMax > 1) {
        result.repricingPEntryMax = "Entre 0 (exclu) et 1";
      }
      if (!Number.isFinite(edgeMin) || edgeMin < 0) result.repricingEdgeMin = ">= 0";
      if (!Number.isFinite(orderUsdc) || orderUsdc <= 0) result.repricingOrderUsdc = "> 0";
      if (!Number.isFinite(targetAbs) || targetAbs <= 0 || targetAbs > 1) {
        result.repricingTargetAbs = "Entre 0 (exclu) et 1";
      }
      if (!Number.isFinite(targetRel) || targetRel < 0) result.repricingTargetRel = ">= 0";
      if (!Number.isFinite(stopAbs) || stopAbs <= 0 || stopAbs > 1) {
        result.repricingStopAbs = "Entre 0 (exclu) et 1";
      }
      if (!Number.isFinite(holdMax) || holdMax <= 0) result.repricingHoldMaxSec = "> 0";
      if (!Number.isFinite(tauForce) || tauForce <= 0 || !(Number.isFinite(tauMin) && tauForce < tauMin)) {
        result.repricingTauForceExitSec = "Dans (0, tau min)";
      }
      if (!Number.isFinite(spreadMaxExit) || (Number.isFinite(spreadMax) && spreadMaxExit < spreadMax)) {
        result.repricingSpreadMaxExit = ">= spread max";
      }
      if (!Number.isFinite(lateWindow) || lateWindow <= 0) result.repricingLateWindowSec = "> 0";
      if (!Number.isFinite(historyMs) || historyMs < 1000) result.repricingHistoryWindowMs = ">= 1000";
      if (!Number.isFinite(dislocationMin) || dislocationMin <= 0) result.repricingDislocationMin = "> 0";
      if (!Number.isFinite(feedAge) || feedAge <= 0) result.repricingFeedMaxAgeMs = "> 0";
      if (!Number.isFinite(signalTtl) || signalTtl <= 0) result.repricingSignalTtlMs = "> 0";
      if (!Number.isFinite(fees) || fees < 0) result.repricingFeesRoundtrip = ">= 0";
      if (!Number.isFinite(slipEntry) || slipEntry < 0) result.repricingSlipEntryBuffer = ">= 0";
      if (!Number.isFinite(slipExit) || slipExit < 0) result.repricingSlipExitBuffer = ">= 0";
      if (!Number.isFinite(notionalMax) || notionalMax <= 0) result.repricingNotionalMaxPerMarket = "> 0";
    }
  } catch (error) {
    // ignore â€” validateConfigForm handles this
  }

  return result;
}
