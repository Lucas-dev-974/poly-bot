/**
 * Post-build — copie les assets runtime que tsc ne compile pas.
 *
 * Les workers .cjs sont chargés au runtime par node:worker_threads depuis
 * dist/db (workerScriptPath résout à côté du module compilé). Sans cette
 * copie, l'image Docker runtime (dist uniquement) ne trouve aucun worker :
 * « Worker snapshot-io introuvable (snapshot-io-worker.cjs) ».
 * db-metrics n'a pas le problème parce que son worker est un eval() embarqué.
 */
const fs = require("node:fs");
const path = require("node:path");

const srcDbDir = path.join(__dirname, "..", "src", "db");
const distDbDir = path.join(__dirname, "..", "dist", "db");

if (!fs.existsSync(distDbDir)) {
  console.error("[post-build] dist/db absent — tsc n'a pas tourné ? abort.");
  process.exit(1);
}

const workers = fs.readdirSync(srcDbDir).filter((f) => f.endsWith(".cjs"));
for (const f of workers) {
  fs.copyFileSync(path.join(srcDbDir, f), path.join(distDbDir, f));
  console.log(`[post-build] src/db/${f} → dist/db/${f}`);
}
