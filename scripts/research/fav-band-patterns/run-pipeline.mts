/**
 * End-to-end fav-band patterns pipeline: extract dataset -> analyze -> report.
 * Usage (repo root): npx tsx scripts/research/fav-band-patterns/run-pipeline.mts
 * Extra args are forwarded to extract-dataset.mts (e.g. --include-backtest-run=...).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const extract = join("scripts", "research", "fav-band-patterns", "extract-dataset.mts");
const analyze = join("scripts", "research", "fav-band-patterns", "analyze-patterns.mts");
const extra = process.argv.slice(2);

function run(script: string, args: string[] = []) {
  process.stderr.write("\n>>> " + script + " " + args.join(" ") + "\n");
  const r = spawnSync("npx", ["tsx", script, ...args], {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(script + " failed with status " + r.status);
  }
}

run(extract, extra);
run(analyze);
process.stderr.write("\nPipeline done. See audits/backtest/fav-band/patterns/\n");
