/**
 * Probe : état réel des premières secondes des fenêtres BTC 15m BTC.
 *
 * Questions auxquelles il répond :
 *  1. À quel âge (tick − windowStart) arrive le PREMIER tick avec les deux
 *     côtés quotés ?
 *  2. Que vaut la somme des asks (up.ask + down.ask) à ce premier tick
 *     (excès liquidité initiale, arbs)?
 *  3. spread ask-bid par côté à t0 (exécutabilité d'un FOK immédiat)?
 *  4. profondeur niveau 1 (askSize) disponible à t0?
 *  5. vitesse de fixation du favori : âge auquel la différence |up−down|
 *     des asks atteint pour la première fois 0.10 / 0.20 / 0.30.
 */
import { loadUniverse } from "./universe.mts";

const uni = loadUniverse();
const stats = {
  windows: 0,
  firstTickAge: [] as number[],
  ageBucketCounts: new Map<string, number>(),
  askSumAtFirst: [] as number[],
  spreadUp: [] as number[],
  spreadDown: [] as number[],
  askSizeUp: [] as number[],
  askSizeDown: [] as number[],
  noTwoSided: 0,
  // fixation du favori
  diffReach: new Map<string, number[]>(), // "0.10" -> [ages] (null si jamais)
  neverReach: new Map<string, number>(),
};

for (const [slug, ticks] of uni.slugs) {
  stats.windows++;
  const wsSec = uni.wsMap.get(slug)!;
  const first = ticks[0];
  const ageMs = first.ts - wsSec * 1000;
  const ageSec = ageMs / 1000;
  stats.firstTickAge.push(ageSec);

  const bucket =
    ageSec <= 1 ? "0-1s" : ageSec <= 2 ? "1-2s" : ageSec <= 5 ? "2-5s" : ageSec <= 10 ? "5-10s" : ageSec <= 30 ? "10-30s" : ">30s";
  stats.ageBucketCounts.set(bucket, (stats.ageBucketCounts.get(bucket) ?? 0) + 1);

  if (first.up.ask != null && first.down.ask != null) {
    const sum = first.up.ask + first.down.ask;
    stats.askSumAtFirst.push(sum);
    if (first.up.bid != null) stats.spreadUp.push(first.up.ask - first.up.bid);
    if (first.down.bid != null) stats.spreadDown.push(first.down.ask - first.down.bid);
    if (first.up.askSize != null) stats.askSizeUp.push(first.up.askSize);
    if (first.down.askSize != null) stats.askSizeDown.push(first.down.askSize);
  } else {
    stats.noTwoSided++;
    continue; // les stats "premier tick" ne portent que les ticks deux-côtés
  }

  // vitesse de fixation du favori : |askUp − askDown| atteint X
  for (const target of [0.1, 0.2, 0.3]) {
    const key = target.toFixed(2);
    if (!stats.diffReach.has(key)) stats.diffReach.set(key, []);
    let reached: number | null = null;
    for (const t of ticks) {
      if (t.up.ask == null || t.down.ask == null) continue;
      const d = Math.abs(t.up.ask - t.down.ask);
      if (d >= target) {
        reached = (t.ts - wsSec * 1000) / 1000;
        break;
      }
    }
    if (reached != null) stats.diffReach.get(key)!.push(reached);
    else stats.neverReach.set(key, (stats.neverReach.get(key) ?? 0) + 1);
  }
}

function q(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)));
  return s[idx];
}

function summarize(name: string, arr: number[], unit = ""): string {
  if (arr.length === 0) return `${name}: (vide)`;
  return `${name}: n=${arr.length} mean=${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)} p50=${q(arr, 0.5).toFixed(2)} p90=${q(arr, 0.9).toFixed(2)} p99=${q(arr, 0.99).toFixed(2)} max=${Math.max(...arr).toFixed(2)}${unit}`;
}

console.log("=== Premier tick deux-côtés ===");
console.log(summarize("âge (s)", stats.firstTickAge));
const buckets = [...stats.ageBucketCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log("buckets âge:", buckets.map(([k, v]) => `${k}: ${v}`).join(" | "));
console.log("windows:", stats.windows, "noTwoSided au 1er tick:", stats.noTwoSided);

console.log("\n=== Somme des asks au premier tick ===");
console.log(summarize("askSum", stats.askSumAtFirst));
const sumHist = { "<0.98": 0, "0.98-1.02": 0, "1.02-1.10": 0, ">1.10": 0 };
for (const s of stats.askSumAtFirst) {
  if (s < 0.98) sumHist["<0.98"]++;
  else if (s <= 1.02) sumHist["0.98-1.02"]++;
  else if (s <= 1.10) sumHist["1.02-1.10"]++;
  else sumHist[">1.10"]++;
}
console.log(sumHist);

console.log("\n=== Spread au premier tick ===");
console.log(summarize("spread UP", stats.spreadUp));
console.log(summarize("spread DOWN", stats.spreadDown));

console.log("\n=== Profondeur niveau 1 au premier tick ===");
console.log(summarize("askSize UP", stats.askSizeUp));
console.log(summarize("askSize DOWN", stats.askSizeDown));

console.log("\n=== Fixation du favori (âge où |askUp−askDown| >= X, s) ===");
for (const [key, arr] of [...stats.diffReach.entries()].sort()) {
  console.log(summarize(`diff>=${key}`, arr));
  console.log(`  jamais atteint: ${stats.neverReach.get(key) ?? 0}/${stats.windows}`);
}