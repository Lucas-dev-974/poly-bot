/**
 * Métriques hors-boucle via la table virtuelle dbstat — exécutées dans un
 * worker thread afin de NE JAMAIS bloquer la boucle d'événements du bot
 * pendant les scans (plusieurs secondes sur une base de plusieurs Go).
 *
 * Contexte : node:sqlite est compilé SANS DBSTAT_VTAB (établi en runtime —
 * « no such table: dbstat ») ; better-sqlite3, déjà présent dans les
 * dependencies, l'a. Le worker ouvre la base en READONLY : zéro écriture,
 * zéro checkpoint, aucune interférence avec le writer node:sqlite du bot.
 * Spawné à la demande, puis terminé — pas de thread résident.
 */

import { Worker } from "node:worker_threads";

/** Code du worker (CJS via eval — require disponible) : scans dbstat uniques. */
const WORKER_CODE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const Better = require('better-sqlite3');
  try {
    const db = new Better(workerData.path, { readonly: true });
    const rows = db.prepare(
      "SELECT sm.tbl_name AS tbl, SUM(ds.pgsize) AS b " +
      "FROM dbstat ds JOIN sqlite_master sm ON sm.name = ds.name " +
      "WHERE ds.name NOT LIKE 'sqlite_%' " +
      "GROUP BY sm.tbl_name"
    ).all();
    let marketDays = null;
    try {
      marketDays = db.prepare(
        "SELECT COUNT(DISTINCT CAST(ts / 86400000 AS INTEGER)) AS d FROM market_snapshots"
      ).get().d;
    } catch (e) {
      /* market_snapshots absente (schéma ancien) : marketDays reste null */
    }
    db.close();
    parentPort.postMessage({ ok: true, rows, marketDays });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
`;

export interface TableMetricsResult {
  /** Taille (btree table + indexes) par nom de table. */
  byTable: Map<string, number>;
  /**
   * Nombre de JOURS CIVILS DISTINCTS (UTC) couverts par market_snapshots —
   * la métrique « nb de jours marché enregistrés » de la page Données.
   * null si la table/le calcul est indisponible.
   */
  marketDays: number | null;
}

const WORKER_TIMEOUT_MS = 90_000;

interface WorkerMsgOk {
  ok: true;
  rows: Array<{ tbl: string; b: number | bigint }>;
  marketDays: number | null;
}

function runWorker(path: string): Promise<WorkerMsgOk> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_CODE, { eval: true, workerData: { path } });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`dbstat : timeout après ${WORKER_TIMEOUT_MS} ms`));
    }, WORKER_TIMEOUT_MS);
    worker.on("message", (m: { ok: boolean; rows?: Array<{ tbl: string; b: number | bigint }>; marketDays?: number | null; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.ok && m.rows) {
        resolve({ ok: true, rows: m.rows, marketDays: m.marketDays ?? null });
      } else {
        reject(new Error(m.error ?? "dbstat : réponse invalide"));
      }
    });
    worker.on("error", (e) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

/**
 * Lit la taille (btree de la table + ses indexes) de chaque table de la base
 * située à `path`, PLUS le nombre de jours marché couverts par
 * market_snapshots, le tout dans un worker thread.
 */
export async function readTableMetrics(path: string): Promise<TableMetricsResult> {
  const m = await runWorker(path);
  return {
    byTable: new Map(m.rows.map((r) => [r.tbl, Number(r.b)])),
    marketDays: m.marketDays,
  };
}