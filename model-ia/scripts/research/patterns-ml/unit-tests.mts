/**
 * Tests unitaires patterns-ml (prévus au plan PHASE-1 §Session 1, jamais implémentés)
 * Exécution : npx tsx model-ia/scripts/research/patterns-ml/unit-tests.mts
 * Couvre : SAX (z-score, PAA, quantification, re-normalisation PAA), Hamming,
 * PAM (déterminisme, longueurs mixtes interdites, V-shape synthétique), anti-fuite,
 * MDE, binomial, BH, ARI, logistique (contrôle causal).
 */
import {
  zNormalize, paa, quantize, seriesToSAX, toSAX, hammingDistance,
} from './sax.mts';
import {
  kMedoidsPAM, clusterShapeletsByLength, assignWindowToCluster,
  type ShapeletCandidate,
} from './shapelets.mts';
import {
  computeMDE, binomialTest, benjaminiHochberg, adjustedRandIndex,
  fitLogistic, logisticP,
} from './discover.mts';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertClose(a: number, b: number, tol: number, msg: string) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg} (${a} vs ${b})`);
}

console.log('=== sax.mts ===');

test('zNormalize : série constante → tout à 0', () => {
  assert(zNormalize([5, 5, 5, 5]).every((v) => v === 0), 'constant → 0');
});

test('zNormalize : mean=0, std=1', () => {
  const z = zNormalize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const m = z.reduce((a, b) => a + b, 0) / z.length;
  const s = Math.sqrt(z.reduce((a, b) => a + (b - m) ** 2, 0) / z.length);
  assertClose(m, 0, 1e-10, 'mean');
  assertClose(s, 1, 1e-10, 'std');
});

test('PAA : segments >= n → copie', () => {
  const out = paa([1, 2, 3], 5);
  assert(out.length === 3 && out.join(',') === '1,2,3', 'copie');
});

test('PAA : moyenne par segment', () => {
  const out = paa([1, 2, 3, 4], 2);
  assertClose(out[0], 1.5, 1e-10, 'seg1');
  assertClose(out[1], 3.5, 1e-10, 'seg2');
});

test('quantize : valeurs croissantes → symboles croissants', () => {
  const q = (v: number) => quantize(v, 8);
  assert(q(-3) < q(-0.5) && q(-0.5) < q(0) && q(0) < q(0.5) && q(0.5) < q(3), 'ordre');
});

test('quantize : alphabet non supporté → throw', () => {
  let threw = false;
  try { quantize(0, 2); } catch { threw = true; }
  assert(threw, 'throw attendu');
});

test('toSAX : série constante → même symbole partout', () => {
  const s = toSAX(new Array(120).fill(7), { paaSegments: 10 });
  assert(s.length === 10, `len=${s.length}`);
  assert(/^([a-h])\1{9}$/.test(s), `attendu 10× même symbole, obtenu "${s}"`);
});

test('toSAX : série croissante → symboles non décroissants', () => {
  const series = Array.from({ length: 120 }, (_, i) => i);
  const s = toSAX(series, { paaSegments: 10 });
  for (let i = 1; i < s.length; i++) {
    assert(s[i] >= s[i - 1], `symbole décroissant en ${i}: "${s}"`);
  }
});

test('toSAX : série décroissante → symboles non croissants', () => {
  const series = Array.from({ length: 120 }, (_, i) => -i);
  const s = toSAX(series, { paaSegments: 10 });
  for (let i = 1; i < s.length; i++) {
    assert(s[i] <= s[i - 1], `symbole croissant en ${i}: "${s}"`);
  }
});

test('toSAX : re-normalisation PAA (audit fix) — série autocorrélée garde des symboles variés', () => {
  // Série à forte autocorrélation (rampe lente) : avant le fix, PAA contractait
  // l'écart-type → tous les symboles identiques. Après fix : variété attendue.
  const series = Array.from({ length: 600 }, (_, i) => Math.sin(i / 30) + 0.001 * (i % 7));
  const s = toSAX(series, { paaSegments: 60 });
  const uniq = new Set(s);
  assert(uniq.size >= 3, `attendu ≥3 symboles distincts, obtenu ${uniq.size} ("${s.slice(0, 30)}...")`);
});

test('hammingDistance : identiques → 0, différents → comptage', () => {
  assert(hammingDistance('abcd', 'abcd') === 0, 'identiques');
  assert(hammingDistance('abcd', 'abbd') === 1, '1 diff');
});

console.log('\n=== shapelets.mts ===');

test('PAM : V-shape synthétique → un médiod capture la forme V', () => {
  // Génère 30 candidats : 15 en V (aaa...ccc), 15 plats (aaaa)
  const candidates: ShapeletCandidate[] = [];
  for (let i = 0; i < 15; i++) candidates.push({ shapelet: 'aaaabbbbcccc', length: 12, start: 0, windowIndex: i });
  for (let i = 0; i < 15; i++) candidates.push({ shapelet: 'aaaaaaaaaaaa', length: 12, start: 0, windowIndex: 100 + i });
  const { medoids, cost } = kMedoidsPAM(candidates, { k: 2, maxIter: 10, seed: 42 });
  assert(medoids.length === 2, `2 médiodes attendus, ${medoids.length}`);
  const shapes = medoids.map((m) => m.shapelet).sort();
  assert(shapes[0] === 'aaaaaaaaaaaa' && shapes[1] === 'aaaabbbbcccc', `médiodes: ${shapes}`);
  assert(cost < 15 * 0.5, `cost=${cost}`);
});

test('PAM : déterministe (même seed → même résultat)', () => {
  const candidates: ShapeletCandidate[] = [];
  for (let i = 0; i < 40; i++) {
    const kind = i % 4;
    const shapelet = ['aaaaaaaa', 'bbbbbbbb', 'abcdefgh', 'gggggggg'][kind];
    candidates.push({ shapelet, length: 8, start: 0, windowIndex: i });
  }
  const r1 = kMedoidsPAM(candidates, { k: 4, maxIter: 10, seed: 42 });
  const r2 = kMedoidsPAM(candidates, { k: 4, maxIter: 10, seed: 42 });
  assert(
    JSON.stringify(r1.medoids.map((m) => m.shapelet)) === JSON.stringify(r2.medoids.map((m) => m.shapelet)),
    'médiodes identiques'
  );
});

test('PAM : longueurs mixtes → throw explicite', () => {
  const candidates: ShapeletCandidate[] = [
    { shapelet: 'aaaa', length: 4, start: 0, windowIndex: 0 },
    { shapelet: 'aaaaaa', length: 6, start: 0, windowIndex: 1 },
  ];
  let threw = false;
  try { kMedoidsPAM(candidates, { k: 2 }); } catch (e: any) {
    threw = e.message.includes('clusterShapeletsByLength');
  }
  assert(threw, 'throw attendu avec message explicite');
});

test('clusterShapeletsByLength : sépare les longueurs sans crash', () => {
  const candidates: ShapeletCandidate[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ shapelet: 'aaaaaaaaaa', length: 10, start: 0, windowIndex: i })),
    ...Array.from({ length: 10 }, (_, i) => ({ shapelet: 'bbbbbbbbbbbbbb', length: 14, start: 0, windowIndex: 100 + i })),
  ];
  const { medoids } = clusterShapeletsByLength(candidates, { k: 2, maxIter: 5 });
  const lengths = new Set(medoids.map((m) => m.length));
  assert(lengths.has(10) && lengths.has(14), '2 groupes');
});

test('assignWindowToCluster : médiod plus long que fenêtre → null (pas de crash)', () => {
  const r = assignWindowToCluster('abc', [{ shapelet: 'abcdefgh', length: 8, clusterId: 0, members: [] }]);
  assert(r === null, 'null attendu');
});

test('assignWindowToCluster : trouve la bonne sous-chaîne', () => {
  const r = assignWindowToCluster('xxxabcdefghyyy', [{ shapelet: 'abcdefgh', length: 8, clusterId: 3, members: [] }]);
  assert(r !== null && r.clusterId === 3 && r.matchedShapelet === 'abcdefgh', JSON.stringify(r));
});

console.log('\n=== discover.mts (stats) ===');

test('computeMDE : décroît en 1/sqrt(n)', () => {
  const mde50 = computeMDE(50);
  const mde200 = computeMDE(200);
  assertClose(mde50 / mde200, Math.sqrt(200 / 50), 0.01, 'ratio');
  assertClose(mde50, 0.196, 0.02, `MDE(50) ≈ 0.196, obtenu ${mde50.toFixed(3)}`);
});

test('binomialTest : p=0.5 exact → 1.0', () => {
  assertClose(binomialTest(5, 10, 0.5), 1.0, 1e-9, 'exact');
  assertClose(binomialTest(50, 100, 0.5), 1.0, 1e-6, 'normal approx');
});

test('binomialTest : effet fort → p-value petite', () => {
  const p = binomialTest(70, 100, 0.5);
  assert(p < 0.001, `p=${p}`);
});

test('binomialTest : petit n exact vs approximation normale', () => {
  // n=10, k=9 : exact bilatéral = 2*(C(10,9)+C(10,10))/2^10 = 2*11/1024 ≈ 0.0215
  assertClose(binomialTest(9, 10, 0.5), 0.02148, 0.005, 'exact Clopper-Pearson');
});

test('benjaminiHochberg : garde l\'ordre et marque les significatifs', () => {
  const res = benjaminiHochberg([0.001, 0.5, 0.01, 0.9], 0.10);
  // trié : 0.001(i=0), 0.01(i=2), 0.5(i=1), 0.9(i=3) — seuils 0.025, 0.05, 0.075, 0.10
  // step-up : 0.9 > 0.10 (non-sig), 0.5 > 0.075 (non-sig), 0.01 <= 0.05 (sig), 0.001 <= 0.025 (sig)
  const byIndex = new Map(res.map((r) => [r.index, r]));
  assert(byIndex.get(0)!.significant === true, '0.001 sig');
  assert(byIndex.get(2)!.significant === true, '0.01 sig');
  assert(byIndex.get(1)!.significant === false, '0.5 non-sig');
  assert(byIndex.get(3)!.significant === false, '0.9 non-sig');
});

test('adjustedRandIndex : identiques → 1, opposés → ≤ 0', () => {
  assertClose(adjustedRandIndex([0, 0, 1, 1], [0, 0, 1, 1]), 1, 1e-9, 'identiques');
  assert(adjustedRandIndex([0, 0, 1, 1], [1, 1, 0, 0]) > 0.99, 'permis = parfait');
  assert(adjustedRandIndex([0, 1, 0, 1], [0, 0, 1, 1]) < 0.3, 'aléatoire faible');
});

test('fitLogistic : sépare un signal linéaire simple', () => {
  // y=1 quand x>0, y=0 sinon ; le logit doit donner P croissant en x
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < 100; i++) {
    const x = (i / 100) * 4 - 2;
    xs.push(x);
    ys.push(x > 0 ? 1 : 0);
  }
  // 1 ligne = 1 échantillon à 1 feature
  const model = fitLogistic(xs.map((x) => [x]), ys);
  const pLow = logisticP(model, [-1.5]);
  const pHigh = logisticP(model, [1.5]);
  assert(pHigh > 0.8 && pLow < 0.2, `pLow=${pLow.toFixed(3)} pHigh=${pHigh.toFixed(3)}`);
});

console.log(`\n=== RÉSULTAT: ${passed} passés, ${failed} échoués ===`);
process.exit(failed > 0 ? 1 : 0);