import { fitLogistic, logisticP, type LogisticModel } from './discover.mts';

const xs: number[] = [];
const ys: number[] = [];
for (let i = 0; i < 100; i++) {
  const x = (i / 100) * 4 - 2;
  xs.push(x);
  ys.push(x > 0 ? 1 : 0);
}
const model: LogisticModel = fitLogistic([xs], ys, { iters: 15, l2: 1e-3 });
console.log('w:', model.w.map((v) => v.toFixed(4)));
console.log('means:', model.means, 'stds:', model.stds);
console.log('p(-1.5):', logisticP(model, [-1.5]).toFixed(6));
console.log('p(-0.5):', logisticP(model, [-0.5]).toFixed(6));
console.log('p(+0.5):', logisticP(model, [0.5]).toFixed(6));
console.log('p(+1.5):', logisticP(model, [1.5]).toFixed(6));

// itérations réduites pour voir la convergence
for (const iters of [1, 3, 5, 8]) {
  const m = fitLogistic([xs], ys, { iters, l2: 1e-3 });
  console.log(`iters=${iters}: w=[${m.w.map((v) => v.toFixed(3))}] p(+1.5)=${logisticP(m, [1.5]).toFixed(4)} p(-1.5)=${logisticP(m, [-1.5]).toFixed(4)}`);
}