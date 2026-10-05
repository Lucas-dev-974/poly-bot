# fav-band-patterns

Extract book-derived features for fav-band winning vs losing positions, then
compare them statistically and write a French Markdown report.

## Data sources

- **Primary:** live resolved positions in `data/bot-live.db`
  (`strategyId='fav-band'`, status `won`/`lost`/`sold`).
- **Ticks:** `book_snapshots` (same DB / same source as other fav-band research).
- **Cap50 JSON** (`audits/backtest/fav-band/fav-band-opt-cap50-*.json`): summary
  only (no per-position rows) — referenced in dataset meta, not joined.
- **Optional:** `--include-backtest-run=<runId>` adds `backtest_positions` rows.

## Run

```bash
# from repo root
npx tsx scripts/research/fav-band-patterns/run-pipeline.mts

# extract only / analyze only
npx tsx scripts/research/fav-band-patterns/extract-dataset.mts
npx tsx scripts/research/fav-band-patterns/analyze-patterns.mts
```

## Outputs

All under `audits/backtest/fav-band/patterns/`:

- `dataset-latest.json` / `.csv` — labeled feature rows
- `stats-latest.json` — means, Cohen's d, filter lifts, buckets
- `RAPPORT-patterns-fav-band-YYYY-MM-DD.md` (+ `-latest.md`)
