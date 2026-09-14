import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const dataDir = join(process.cwd(), "data");

function classifyPairs(dbPath) {
  if (!existsSync(dbPath)) {
    console.log("Missing", dbPath);
    return null;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const cols = db.prepare("PRAGMA table_info(positions)").all().map((c) => c.name);
  console.log("\n===", dbPath, "===");
  console.log("position cols:", cols.join(", "));

  const pairs = db
    .prepare("SELECT id, eventSlug, status, directional, realizedPnl FROM arb_pairs")
    .all();
  const positions = db
    .prepare("SELECT pairId, kind, status, size, fillPrice FROM positions")
    .all();

  const byPair = new Map();
  for (const p of positions) {
    if (!byPair.has(p.pairId)) byPair.set(p.pairId, []);
    byPair.get(p.pairId).push(p);
  }

  const counts = {
    pairs_total: pairs.length,
    locked_1_1: 0,
    partial: 0,
    naked_or_directional: 0,
    defended_sold: 0,
    other: 0,
  };

  for (const pair of pairs) {
    const legs = byPair.get(pair.id) ?? [];
    const cheap = legs.filter((l) => l.kind === "cheap");
    const exp = legs.filter((l) => l.kind === "expensive");
    const cheapFilled = cheap.reduce((s, l) => s + (l.size || 0), 0);
    const expFilled = exp.reduce((s, l) => s + (l.size || 0), 0);
    const cheapSold = cheap.some((l) => l.status === "sold");

    if (cheapSold) counts.defended_sold++;
    else if (pair.directional === 1 || (cheapFilled > 0 && expFilled <= 0))
      counts.naked_or_directional++;
    else if (
      cheapFilled > 0 &&
      expFilled > 0 &&
      Math.abs(cheapFilled - expFilled) < 0.01
    )
      counts.locked_1_1++;
    else if (cheapFilled > 0 && expFilled > 0 && expFilled < cheapFilled - 0.01)
      counts.partial++;
    else counts.other++;
  }

  console.log(counts);
  const withCheap =
    counts.locked_1_1 +
    counts.naked_or_directional +
    counts.partial +
    counts.defended_sold;
  if (withCheap > 0) {
    const bad = counts.naked_or_directional + counts.partial;
    console.log(
      "naked+partial / activity:",
      ((bad / withCheap) * 100).toFixed(1) + "%",
      `(no-go if >~25%; n=${withCheap})`,
    );
  }
  return counts;
}

classifyPairs(join(dataDir, "bot.db"));
