import type { StrategyGraph } from "../strategy/graph/types.js";
import { ensureEdgeOrderAction } from "../strategy/graph/ensure-edge-order.js";
import type { Database } from "./database.js";

interface StrategyGraphRow {
  id: string;
  name: string;
  description: string | null;
  leadsWithEdge: number;
  graphJson: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface StrategyGraphMeta {
  id: string;
  name: string;
  description: string | null;
  leadsWithEdge: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export class StrategyGraphRepository {
  constructor(private readonly db: Database) {}

  list(): StrategyGraphMeta[] {
    return this.db
      .all<StrategyGraphRow>(
        `SELECT id, name, description, leadsWithEdge, version, createdAt, updatedAt
         FROM strategy_graphs ORDER BY updatedAt DESC`,
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        leadsWithEdge: row.leadsWithEdge === 1,
        version: row.version,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  }

  get(id: string): StrategyGraph | undefined {
    const row = this.db.get<StrategyGraphRow>(
      `SELECT * FROM strategy_graphs WHERE id = ?`,
      [id],
    );
    if (!row) return undefined;
    let graph: StrategyGraph;
    try {
      graph = JSON.parse(row.graphJson) as StrategyGraph;
    } catch {
      throw new Error(`Corrupt strategy graph ${id}`);
    }
    const jsonFlag = Boolean(graph.leadsWithEdge);
    if (jsonFlag !== (row.leadsWithEdge === 1)) {
      this.db.run(
        `UPDATE strategy_graphs SET leadsWithEdge = ? WHERE id = ?`,
        [jsonFlag ? 1 : 0, id],
      );
    }
    return ensureEdgeOrderAction(graph);
  }

  upsert(graph: StrategyGraph): StrategyGraph {
    graph = ensureEdgeOrderAction(graph);
    const now = Date.now();
    const existing = this.db.get<{ version: number; createdAt: number }>(
      `SELECT version, createdAt FROM strategy_graphs WHERE id = ?`,
      [graph.id],
    );
    const createdAt = existing?.createdAt ?? graph.createdAt ?? now;
    const version = (existing?.version ?? 0) + 1;
    const stored: StrategyGraph = {
      ...graph,
      createdAt,
      updatedAt: now,
      version,
    };
    this.db.run(
      `INSERT OR REPLACE INTO strategy_graphs (
        id, name, description, leadsWithEdge, graphJson, version, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.name,
        stored.description ?? null,
        stored.leadsWithEdge ? 1 : 0,
        JSON.stringify(stored),
        stored.version,
        stored.createdAt,
        stored.updatedAt,
      ],
    );
    return stored;
  }

  remove(id: string): boolean {
    const existing = this.db.get<{ id: string }>(
      `SELECT id FROM strategy_graphs WHERE id = ?`,
      [id],
    );
    if (!existing) return false;
    this.db.run(`DELETE FROM strategy_graphs WHERE id = ?`, [id]);
    return true;
  }

  getActive(strategyId: string): StrategyGraph | undefined {
    if (!strategyId.startsWith("custom:")) return undefined;
    return this.get(strategyId);
  }
}
