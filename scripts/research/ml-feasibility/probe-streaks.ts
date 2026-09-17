// Probe : patterns de séquence d'outcomes (streaks) sur les fenêtres résolues
// Question : "2 up -> down" existe-t-il dans les données ? vs hasard vs prix d'ouverture
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/bot-live.db', { readOnly: true });

const rows = db.prepare(`
  SELECT r.eventSlug, r.winnerOutcomeIndex w, MIN(m.windowStart) ws
  FROM market_resolutions r
  JOIN market_snapshots m ON m.eventSlug = r.eventSlug
  GROUP BY r.eventSlug
  ORDER BY ws
`).all();

// group per asset
const byAsset = new Map<string, { slug: string; w: number; ws: number }[]>();
for (const r of rows) {
  const asset = r.eventSlug.split('-updown')[0];
  if (!byAsset.has(asset)) byAsset.set(asset, []);
  byAsset.get(asset)!.push({ slug: r.eventSlug, w: r.w, ws: r.ws });
}

// zSum2 from power-projection (alpha .05 two-sided, power 80%)
const ZSUM2 = (1.959963985 + 0.841621234) ** 2;
const nReq = (p: number) => Math.ceil(ZSUM2 * p * (1 - p) / ((p - 0.5) ** 2));
// minimal detectable P at 80% power given n (variance at null 0.25)
const minDetectable = (n: number) => 0.5 + (1.959963985 + 0.841621234) * Math.sqrt(0.25 / n);

interface Bucket { n: number; down: number; }
const buckets: Record<string, Bucket> = {};
function bump(k: string, w: number) {
  if (!buckets[k]) buckets[k] = { n: 0, down: 0 };
  buckets[k].n++;
  if (w === 1) buckets[k].down++;
}

for (const [asset, seq] of byAsset) {
  if (asset !== 'btc') continue; // ETH: 6 windows, pas exploitable
  for (let i = 1; i < seq.length; i++) {
    const prev = seq.slice(Math.max(0, i - 3), i).map(s => s.w); // 0=Up,1=Down
    const cur = seq[i].w;
    const key = prev.map(x => (x === 0 ? 'U' : 'D')).join('') + '->' + (cur === 0 ? 'U' : 'D');
    bump(key, cur);
  }
}

console.log('=== BTC : P(Down) conditionné au PRÉFIXE (k derniers outcomes) ===');
const pref: Record<string, { n: number; down: number }> = {};
function bumpPre(pre: string, cur: number) {
  if (!pref[pre]) pref[pre] = { n: 0, down: 0 };
  pref[pre].n++;
  if (cur === 1) pref[pre].down++;
}
for (const [, seq] of byAsset) {
  if (seq.length < 2) continue;
  for (let i = 1; i < seq.length; i++) {
    const prev = seq.slice(Math.max(0, i - 3), i).map(s => s.w);
    bumpPre(prev.map(x => (x === 0 ? 'U' : 'D')).join(''), seq[i].w);
  }
}
const ZS = 1.959963985 + 0.841621234;
const minDet = (n: number) => 0.5 + ZS * Math.sqrt(0.25 / n);
for (const k of Object.keys(pref).sort()) {
  const b = pref[k];
  console.log(`${k.padEnd(4)} -> P(Down)=${(100 * b.down / b.n).toFixed(1)}%  n=${b.n}  (effet min détectable à cette taille: ${(minDet(b.n) * 100 - 50).toFixed(0)} pts vs 50%)`);
}

console.log('\nn requis pour effet p (rappel): 0.53 ->', nReq(0.53), '| 0.55 ->', nReq(0.55), '| 0.58 ->', nReq(0.58));