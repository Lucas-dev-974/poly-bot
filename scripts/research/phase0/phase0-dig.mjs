import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const dataDir = join(process.cwd(), "data");

function dig(dbPath) {
  if (!existsSync(dbPath)) {
    console.log("Missing", dbPath);
    return;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  console.log("\n########", dbPath, "########");
  try {
    const strat = db.prepare("SELECT strategyId, COUNT(*) c FROM positions GROUP BY strategyId").all();
    console.log("by strategyId:", strat);
  } catch (e) {
    console.log("no strategyId col");
  }
  const kinds = db.prepare("SELECT kind, status, COUNT(*) c FROM positions GROUP BY kind, status").all();
  console.log("kind/status:", kinds);
  const sample = db.prepare(`
    SELECT p.id, p.status, p.directional, p.realizedPnl,
      (SELECT COUNT(*) FROM positions x WHERE x.pairId=p.id AND x.kind='cheap') cheapN,
      (SELECT IFNULL(SUM(size),0) FROM positions x WHERE x.pairId=p.id AND x.kind='cheap') cheapSz,
      (SELECT IFNULL(SUM(size),0) FROM positions x WHERE x.pairId=p.id AND x.kind='expensive') expSz,
      (SELECT GROUP_CONCAT(DISTINCT status) FROM positions x WHERE x.pairId=p.id) statuses
    FROM arb_pairs p LIMIT 15
  `).all();
  console.log("sample pairs:", JSON.stringify(sample, null, 2));
  const dir = db.prepare("SELECT directional, COUNT(*) c FROM arb_pairs GROUP BY directional").all();
  console.log("directional:", dir);
}

dig(join(dataDir, "bot.db"));
dig(join(dataDir, "bot-live.db"));
