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

/** Fonction générique : lance un worker CJS eval et attend son message ok. */
function runCjsWorker<T>(code: string, workerData: Record<string, unknown>, onOk: (m: { ok: boolean; error?: string }) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(code, { eval: true, workerData });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`dbstat : timeout après ${WORKER_TIMEOUT_MS} ms`));
    }, WORKER_TIMEOUT_MS);
    worker.on("message", (m: { ok: boolean; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      try {
        resolve(onOk(m));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    worker.on("error", (e) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

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

/* ── Calendrier des snapshots (onglet « Calendrier » de la page Données) ── */

export interface DbCalendarDayRow {
  /** Jour civil UTC = ts / 86 400 000 (epoch_days). */
  day: number;
  /** Lignes market_snapshots écrites ce jour. */
  mktRows: number;
  /** Marchés DISTINCTS (eventSlug) vus ce jour. */
  markets: number;
  /** Lignes book_snapshots ce jour (0 si la table est absente). */
  bookRows: number;
  /** [MIN(ts), MAX(ts)] des captures marché du jour (ms) — null sans market. */
  coverage: [number, number] | null;
}

export interface CalendarMetricsResult {
  days: DbCalendarDayRow[];
  /** Premier/dernier jours civils enregistrés (epoch_days) — null sans données. */
  rangeStart: number | null;
  rangeEnd: number | null;
}

/** Ligne de détail d'une journée : une fenêtre marché et son volume de captures. */
export interface CalendarDayDetailRow {
  slug: string;
  /** Lignes market_snapshots pour ce slug ce jour. */
  n: number;
  /** windowStart / windowEnd (epoch s) — MAX du jour pour les fenêtres qui span. */
  ws: number;
  we: number;
}

/* Agrégats par jour civil UTC : index ts pilotant un scan ordonné (pas de tri). */
const CALENDAR_WORKER_CODE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const Better = require('better-sqlite3');
  try {
    const db = new Better(workerData.path, { readonly: true });
    const days = [];
    try {
      const mkt = db.prepare(
        "SELECT CAST(ts / 86400000 AS INTEGER) AS d, COUNT(*) AS r, " +
        "COUNT(DISTINCT eventSlug) AS m, MIN(ts) AS mn, MAX(ts) AS mx " +
        "FROM market_snapshots GROUP BY CAST(ts / 86400000 AS INTEGER) ORDER BY d"
      ).all();
      const book = db.prepare(
        "SELECT CAST(ts / 86400000 AS INTEGER) AS d, COUNT(*) AS b " +
        "FROM book_snapshots GROUP BY CAST(ts / 86400000 AS INTEGER)"
      ).all();
      const bookByDay = new Map(book.map((r) => [r.d, Number(r.b)]));
      for (const r of mkt) {
        days.push({
          day: r.d,
          mktRows: Number(r.r),
          markets: Number(r.m),
          bookRows: bookByDay.get(r.d) ?? 0,
          coverage: r.mn != null ? [Number(r.mn), Number(r.mx)] : null,
        });
      }
    } catch (e) {
      /* market_snapshots absente (schéma ancien) : calendrier vide */
    }
    db.close();
    parentPort.postMessage({ ok: true, days });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
`;

const CALENDAR_DAY_WORKER_CODE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const Better = require('better-sqlite3');
  try {
    const db = new Better(workerData.path, { readonly: true });
    const windows = [];
    try {
      const rows = db.prepare(
        "SELECT eventSlug AS slug, COUNT(*) AS n, MAX(windowStart) AS ws, MAX(windowEnd) AS we " +
        "FROM market_snapshots WHERE ts >= ? AND ts < ? GROUP BY eventSlug ORDER BY MAX(windowStart)"
      ).all(workerData.startMs, workerData.endMs);
      for (const r of rows) {
        windows.push({ slug: r.slug, n: Number(r.n), ws: Number(r.ws), we: Number(r.we) });
      }
    } catch (e) {
      /* market_snapshots absente : détail vide */
    }
    db.close();
    parentPort.postMessage({ ok: true, windows });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
`;

/**
 * Agrégats par jour civil UTC de market/book snapshots — worker readonly, ne
 * touche JAMAIS à la boucle du bot (le scan peut durer quelques secondes sur
 * une base de plusieurs Go ; il est mis en cache TTL par l'appelant).
 */
export async function readCalendarMetrics(path: string): Promise<CalendarMetricsResult> {
  const days = await runCjsWorker<
    Array<{ day: number; mktRows: number; markets: number; bookRows: number; coverage: [number, number] | null }>
  >(CALENDAR_WORKER_CODE, { path }, (m) => {
    if (!m.ok) throw new Error(m.error ?? "scan calendrier : réponse invalide");
    return (m as { days?: CalendarMetricsResult["days"] }).days ?? [];
  });
  return {
    days,
    rangeStart: days.length > 0 ? days[0].day : null,
    rangeEnd: days.length > 0 ? days[days.length - 1].day : null,
  };
}

/** Détail d'UNE journée (fenêtres marché du jour) — requête bornée par l'index ts. */
export async function readCalendarDayMetrics(
  path: string,
  startMs: number,
  endMs: number,
): Promise<CalendarDayDetailRow[]> {
  return runCjsWorker(CALENDAR_DAY_WORKER_CODE, { path, startMs, endMs }, (m) => {
    if (!m.ok) throw new Error(m.error ?? "détail journée : réponse invalide");
    return (m as { windows?: CalendarDayDetailRow[] }).windows ?? [];
  });
}