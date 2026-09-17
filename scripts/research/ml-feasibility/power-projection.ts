// Puissance statistique + projections de collecte pour la spec next-market
// n requis (test bilatéral alpha=0.05, puissance 80%) : n = (z_a/2 + z_b)^2 * p(1-p) / (p-0.5)^2

const zAlpha = 1.959963985; // two-sided 95%
const zBeta = 0.841621234;  // power 80%
const zSum2 = (zAlpha + zBeta) ** 2;

function nRequired(p: number): number {
  return Math.ceil(zSum2 * p * (1 - p) / ((p - 0.5) ** 2));
}

console.log('=== Puissance : n requis pour détecter P(Up)=p vs 0.50 (alpha 5% bilatéral, puissance 80%) ===');
for (const p of [0.51, 0.52, 0.53, 0.54, 0.55, 0.58, 0.60]) {
  console.log(`p=${p.toFixed(2)}  n=${nRequired(p)}`);
}

// Collecte : 655 fenêtres sur 8.2 jours -> 80/jour
const rate = 655 / 8.2;
console.log('\n=== Projections de collecte (rythme mesuré:', rate.toFixed(1), 'fenêtres/jour) ===');
for (const weeks of [2, 4, 6, 8]) {
  const total = Math.round(655 + rate * weeks * 7);
  console.log(`+${weeks} semaines -> total ~${total} fenêtres`);
}

// Edge exploitable à l'entrée à l'ouverture : entrée ~0.50 + spread
// EV/share = P - prix. Prix ouverture ~ 0.505 (ask du favori post-open + spread 1-2c)
console.log('\n=== EV/share pour entrée à l\'ouverture ===');
for (const [price, p] of [[0.505, 0.53], [0.505, 0.55], [0.51, 0.53], [0.52, 0.55]] as const) {
  console.log(`entrée ${price}, P=${p} -> EV/share = ${(p - price).toFixed(3)}`);
}