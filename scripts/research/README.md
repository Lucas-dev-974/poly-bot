# Research scripts

Offline digs, grids, and probes. **Not** production entrypoints — run from the
**repo root**. Outputs land in `audits/backtest/<strategy>/`.

## Layout (one folder per strategy)

| Folder | Contents |
|--------|----------|
| `phase0/` | Early coverage / Policy A digs and post-A backtests (historical) |
| `ask-lock/` | Dual-FOK ask-lock param grid (`ask-lock-param-grid.mts`) |
| `edge-lead/` | Edge-lead reject digs and gate/improve grids |
| `fav-band/` | Fav-band param grid |
| `dip-revert-research/` | dip-revert: standalone sim (`dip-sim.mts`), official-runner recheck (`recheck-official.mts`), TP wiring checks (`verify-tp.mts`) |
| `mean-rev-probes/` | Mean-reversion / scalp probes that produced dip-revert (momentum exploration, dip-confirmed, scalp measures) |
| `compare/` | Cross-strategy / long-universe compares |
| `probes/` | CLOB / market probes (`probe-ask-lock.mts`, `probe-markets.mts`) |
| `backtests/` | Official-runner backtests (arb presets, dip-revert, new strats) |
| `audit/` | Data-coverage audit and live trade/position diagnostics |

One-shot patchers (`_patch-*`, `fix-*`, `wire-*`) were deleted after being
applied — the changes they made live in `src/` now.

## Keep at `scripts/` root (tracked)

Ops tools only: `check-quota.ts`, `redeem-all.ts`.

Reusable one-offs live under `scripts/research/`:

- `probes/` - `probe-ask-lock.mts`, `probe-markets.mts`
- `backtests/` - `arb-audit-backtest.mts`, `backtest-dip-revert.mts`, `backtest-dip-revert-axes.mts`, `backtest-new-strats.mts`
- `audit/` - `audit-data-coverage.mts`, `verify-audit.ts`, `diagnose-size.ts`, `compare-positions.ts`

## How to run

```bash
npx tsx scripts/research/fav-band/fav-band-param-grid.mts
npx tsx scripts/research/compare/long-universe-compare.mts
npx tsx scripts/research/ask-lock/ask-lock-param-grid.mts
npx tsx scripts/research/dip-revert-research/recheck-official.mts
```

Imports use `../../../src/...` (three levels up to the repo root).

## Audit outputs

`audits/backtest/` has one sub-folder per strategy (`arb/`, `ask-lock/`,
`edge-lead/`, `fav-band/`, `dip-revert/`, `momentum/`, `compare/`) plus
`coverage/` for the shared data-coverage universe reports. Only the **newest**
run of each identical config is kept.

## Live bot

Do not apply research presets to `data/bot-settings.json` while live
`tsx watch` is running unless you intend to.