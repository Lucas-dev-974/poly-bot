# Audit: move-only refactor bot.ts → src/bot/* (P1–P4)

**Date:** 2026-09-10 (PT)  
**Repo:** `polymarket-reverse-arbitrage-bot`  
**Baseline:** `git show HEAD:src/bot.ts` → `%TEMP%\bot-audit\bot-old.ts`  
**New modules:** `src/bot.ts` (re-export), `reverse-bot.ts`, `live-order-lifecycle.ts`, `resting-manager.ts`, `balance-guard.ts`, `opportunity-executor.ts`, `order-type.ts`, `tick-snapshots.ts`  
**Verdict:** **SAFE WITH NITS**

No definite logic bugs found. Remaining deltas are intentional structural indirection (helpers / `deps` / `lifecycle` / `BalanceGuard`) with equivalent behavior. No code changes made.

---

## Build / tests

| Command | Result |
|---------|--------|
| `npm run build` (`tsc`) | **PASS** (exit 0) |
| `npm test` | **PASS** — **260** tests, **55** suites, **0** fail |

---

## Checklist

### 1. orderTypeFor — PASS
New `order-type.ts` export matches old private method:
`expensive && expensiveOrderType === "FOK" && !leadsWithEdge → FOK else GTC`.

### 2. manageLiveResting edge-lead order — PASS
`resting-manager.ts` `manageLiveResting`:
- leadsWithEdge: `manageRestingEdgeLead` → `replaceMarketableCheap` → `sellExpensiveEdgeIfNeeded`
- else: `replaceMarketableCheap` → `defendUncoveredPairs`  
Matches old inline block in `processEvent`.

### 3. executeOpportunity guard order — PASS
Order identical: close → backoff → readonly → C2 → confirmCheap → `broker && ledger` sim → useFOK/cost → balance/exposure → hedgeAtPostTime/defendPair → recheck → place → catch balance rejection.  
Sim gate remains `broker && ledger` (not `dryRun`).  
Catch path: old inlined consecutive-rejection/backoff; new calls `BalanceGuard.noteBalanceRejection()` / `noteBalanceOk()` with the same thresholds (3 rejects → 60s).

### 4. defendPair inject + clearCheapMissing — PASS
Executor deps: `defendPair: (pairId) => this.resting.defendPair(pairId)`.  
After successful FOK SELL: `this.deps.lifecycle.clearCheapMissing(pairId)` (same Map as before, not a second Map).

### 5. finalizeLiveOrder / ghost / re-read after cancel — PASS
Normalized body of `finalizeLiveOrder`, `cancelStaleOrders`, `pollOrderFills`, `confirmCheapTokensForHedge` match HEAD (modulo `this.deps.`).  
“Re-read the order status AFTER cancel…” comment preserved in lifecycle `cancelStaleOrders`. Ghost / fillConfirm retry logic preserved.

### 6. cancelOrphanHedgesIfNeeded skips leadsWithEdge — PASS
`if (this.strategy.leadsWithEdge) return;` present; body otherwise identical.

### 7. setStrategy wiring — PASS
On `strategyId` change in `reverse-bot.onRuntimeSettingsChanged`: `lifecycle`, `resting`, `executor` all get `setStrategy`. BalanceGuard has no strategy (correct).

### 8. totalAttempts / onAttempt / TOTAL_ATTEMPTS_KEY — PASS
Key still `"totalAttempts"`. Three old `totalAttempts++` + persist sites → three `onAttempt()` calls in executor; reverse-bot increments + persists in the callback. Init/reset persistence unchanged.

### 9. ReverseBot.reset vs BalanceGuard — PASS
`reset()` identical to old; does **not** call `balance.reset()` (old also did not clear backoff). `BalanceGuard.reset` exists with an explicit move-only comment — intentional unused API.

### 10. pruneData / emitStats / computeStats / snapshots — PASS
Bodies match after normalizing `deps` / `totalAttempts` param.  
Insert fields field-for-field equal for market / book / opportunity snapshots.

### 11. No duplicate Maps — PASS
`orderStatusFailures` / `fillConfirmFailures` / `cheapMissingFailures` declared only on `LiveOrderLifecycle`.

### 12. Imports — PASS
`src/index.ts` still `import { ReverseBot } from "./bot.js"`.  
`src/bot.ts` → `export { ReverseBot } from "./bot/reverse-bot.js"`. Build clean.

### 13. Accidental regressions search — PASS
- No `dryRun` used as sim gate instead of `broker && ledger`
- No `this.tracker` vs `this.deps.tracker` mixups in deps modules
- No missing `setStrategy` on strategy holders
- No suspicious missing `await` on critical async calls

---

## NITS / residual risks (not behavior bugs)

1. **useFOK expression style** (`opportunity-executor.ts` ~160): old inlined the FOK predicate; new uses `orderTypeFor(...) === "FOK"`. Semantically identical to the private method / export.
2. **BalanceGuard.reset unused:** documented intentional; if a future “hard reset” is desired, wire it explicitly — do not treat as a silent regression.
3. **Strategy staleness:** mitigated by setStrategy on all three holders; residual risk only if a new strategy-consuming collaborator is added without wiring.
4. **Cross-module surface:** `defendPair` / lifecycle helpers are now public on modules (were private on the monolith). Call graph from reverse-bot is still the only production entry; no extra callers found in this audit.

---

## FAIL items

None (no definite logic / phantom / inconsistency vs HEAD that changes behavior).

---

## Issues list (for parent)

| Item | File:line | Real behavior change? |
|------|-----------|----------------------|
| useFOK via `orderTypeFor` vs inlined predicate | `opportunity-executor.ts:160` vs old ~1159 | **No** (equivalent) |
| Balance rejection via `noteBalanceRejection` | `opportunity-executor.ts:303` / `balance-guard.ts:45` | **No** (equivalent) |
| `BalanceGuard.reset` present but unused | `balance-guard.ts:58-64` | **No** (intentional) |

---

## Method

- Extracted / compared critical method bodies OLD vs NEW with Python (normalized `this.deps.` / lifecycle / BalanceGuard / onAttempt).
- Manual reads for guard order, Maps, setStrategy, re-export.
- `rg` for regression patterns.
- `npm run build` + `npm test`.
