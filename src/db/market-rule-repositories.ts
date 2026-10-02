import type { Database } from "./database.js";

export interface MarketRuleRow {
  prefix: string;
  recordingEnabled: number; // 0|1
  tradingEnabled: number; // 0|1
  addedBy: string;
  createdAt: number;
  updatedAt: number;
}

export class MarketRuleRepository {
  constructor(private readonly db: Database) {}

  list(): MarketRuleRow[] {
    return this.db.all<MarketRuleRow>(
      "SELECT * FROM market_rules ORDER BY prefix",
    );
  }

  get(prefix: string): MarketRuleRow | undefined {
    return this.db.get<MarketRuleRow>(
      "SELECT * FROM market_rules WHERE prefix = ?",
      [prefix],
    );
  }

  /**
   * Crée ou met à jour les flags d'une famille. La ligne existante (created,
   * addedBy) est conservée via INSERT OR IGNORE + UPDATE ciblé.
   */
  setFlags(
    prefix: string,
    patch: { recordingEnabled?: boolean; tradingEnabled?: boolean },
    addedBy?: string,
  ): MarketRuleRow {
    const now = Date.now();
    this.db.run(
      `INSERT OR IGNORE INTO market_rules (prefix, recordingEnabled, tradingEnabled, addedBy, createdAt, updatedAt)
       VALUES (?, 1, 1, ?, ?, ?)`,
      [prefix, addedBy ?? "user", now, now],
    );
    const sets: string[] = ["updatedAt = ?"];
    const params: Array<number | string> = [now];
    if (patch.recordingEnabled !== undefined) {
      sets.push("recordingEnabled = ?");
      params.push(patch.recordingEnabled ? 1 : 0);
    }
    if (patch.tradingEnabled !== undefined) {
      sets.push("tradingEnabled = ?");
      params.push(patch.tradingEnabled ? 1 : 0);
    }
    if (addedBy !== undefined) {
      sets.push("addedBy = ?");
      params.push(addedBy);
    }
    params.push(prefix);
    this.db.run(
      `UPDATE market_rules SET ${sets.join(", ")} WHERE prefix = ?`,
      params,
    );
    const row = this.get(prefix);
    if (!row) {
      throw new Error(`market_rules: failed to persist flags for ${prefix}`);
    }
    return row;
  }

  /** INSERT OR IGNORE — idempotent, ne mute jamais une ligne existante. */
  ensureDefaults(prefixes: string[]): void {
    const now = Date.now();
    for (const prefix of prefixes) {
      if (!prefix) continue;
      this.db.run(
        `INSERT OR IGNORE INTO market_rules (prefix, recordingEnabled, tradingEnabled, addedBy, createdAt, updatedAt)
         VALUES (?, 1, 1, 'default', ?, ?)`,
        [prefix, now, now],
      );
    }
  }

  /** Familles vues récemment dans market_snapshots, hors préfixes configurés. */
  discovered(excludePrefixes: string[], sinceTs: number): Array<{ prefix: string; lastSeenTs: number; slugCount: number }> {
    const rows = this.db.all<{ prefix: string; lastSeenTs: number; slugCount: number }>(
      `SELECT substr(eventSlug, 1, length(eventSlug) - 11) AS prefix,
              MAX(ts) AS lastSeenTs,
              COUNT(DISTINCT eventSlug) AS slugCount
       FROM market_snapshots
       GROUP BY prefix
       HAVING lastSeenTs >= ?`,
      [sinceTs],
    );
    return rows.filter(
      (row) => row.prefix && !excludePrefixes.includes(row.prefix),
    );
  }
}
