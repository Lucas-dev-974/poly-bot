/**
 * Probe : chronomètre buildDataset pour localiser le blocage
 */
import { buildDataset } from './dataset.mts';
import * as path from 'path';

console.log('Probe buildDataset — démarrage');
const t0 = Date.now();
const result = buildDataset({
  dbPath: path.resolve(process.cwd(), 'data/bot-live.db'),
  elapsedPct: 0.30,
  maxElapsedPct: 0.75,
  lookbackTicks: 60,
  saxConfig: {},
});
console.log(`buildDataset: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`Contexts: ${result.contexts.length}`);
console.log(`Stats: ${JSON.stringify(result.stats)}`);
if (result.contexts.length > 0) {
  const ctx = result.contexts[0];
  console.log('Exemple contexte:', JSON.stringify({
    eventSlug: ctx.eventSlug, tickTs: ctx.tickTs, elapsedPct: +ctx.elapsedPct.toFixed(3),
    label_outcome: ctx.label_outcome, label_direction60s: ctx.label_direction60s,
    sax_favAsk: ctx.sax_favAsk, raw_favAsk_len: ctx.raw_favAsk.length,
  }));
}