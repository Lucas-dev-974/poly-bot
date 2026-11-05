/**
 * Service import/export des snapshots marché — UN job à la fois :
 * upload (fichier .tmp) → analyze (dry-run, staging dans le worker) →
 * commit (merge/replace dans le worker).
 *
 * Tout le travail lourd (parsing, SQL multi-Go) vit dans un thread worker
 * better-sqlite3 (pattern src/db/db-metrics.ts) : la boucle du bot n'est
 * JAMAIS bloquée. Le worker générique (snapshot-io-worker.cjs) reçoit les
 * specs de tables via workerData — aucune colonne en dur côté worker.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SNAPSHOT_TABLE_SPECS,
  type SnapshotTableName,
  type SnapshotTableSpec,
} from "./snapshot-io-schema.js";

const WORKER_FILE = "snapshot-io-worker.cjs";
const OPTIONS_TTL_MS = 60_000;
/** Sweep des fichiers d'upload/staging orphelins (24 h). */
const IMPORTS_SWEEP_MS = 24 * 3600_000;
/** Un job actif depuis > 30 min sans avancer est considéré abandonné. */
const STALE_JOB_MS = 30 * 60_000;

export interface SnapshotExportOptionRow {
  eventSlug: string;
  title: string | null;
  rowCount: number;
  firstTs: number;
  lastTs: number;
}

export interface SnapshotTableSummary {
  name: SnapshotTableName;
  rowsTotal: number;
  invalid: number;
  examples: string[];
  distinctKeys: number;
  alreadyPresent: number;
  newRows: number;
  dedupInFile: number;
  minTs: number | null;
  maxTs: number | null;
  slugCount: number;
  error?: string;
}

export interface SnapshotAnalyzeResult {
  format: "ndjson" | "csv" | "sqlite";
  extras: number;
  tables: SnapshotTableSummary[];
  /** Lignes NDJSON sans clé _t valide (non attribuables à une table). */
  orphanLines?: number;
  /** Exemples de lignes orphelines (max 5). */
  orphanExamples?: string[];
  /** Avertissements calculés par le handler (config du bot connue seulement là). */
  warnings?: string[];
  elapsedMs?: number;
}

export interface SnapshotCommitResult {
  inserted: number;
  skipped: number;
  dedupInFile: number;
  deleted: number;
  elapsedMs: number;
  perTable: Record<string, { staged: number; inserted: number; skipped: number; dedupInFile: number; deleted: number; ms?: number }>;
  timings?: Record<string, number>;
}

export type SnapshotImportState =
  | "idle"
  | "uploading"
  | "uploaded"
  | "analyzing"
  | "analyzed"
  | "committing"
  | "done"
  | "error"
  | "cancelled";

export interface SnapshotImportProgress {
  table?: string;
  staged?: number;
  invalid?: number;
  merged?: number;
  skipped?: number;
  deleted?: number;
}

export interface SnapshotImportStatus {
  state: SnapshotImportState;
  uploadId: string | null;
  /** Chemin du fichier uploadé — INTERNE (jamais exposé par la réponse HTTP status). */
  uploadPath: string | null;
  stagePath: string | null;
  uploadBytes: number | null;
  mainDbPath: string | null;
  format: "ndjson" | "csv" | "sqlite" | null;
  summary: SnapshotAnalyzeResult | null;
  result: SnapshotCommitResult | null;
  progress: SnapshotImportProgress | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export type ImportPolicy = "merge" | "replace";

const EMPTY_STATUS: SnapshotImportStatus = {
  state: "idle",
  uploadId: null,
  uploadPath: null,
  stagePath: null,
  uploadBytes: null,
  mainDbPath: null,
  format: null,
  summary: null,
  result: null,
  progress: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

let job: SnapshotImportStatus = { ...EMPTY_STATUS };
let workerHandle: Worker | null = null;

/** Cache des options d'export (scan GROUP BY en worker, TTL 60 s). */
const optionsCache = new Map<string, { at: number; rows: SnapshotExportOptionRow[] }>();

/* ── outils ──────────────────────────────────────────────────────────── */

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function serviceError(code: number, message: string): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

function workerScriptPath(): string {
  const near = fileURLToPath(new URL(`./${WORKER_FILE}`, import.meta.url));
  if (existsSync(near)) return near;
  const fromCwd = path.resolve(process.cwd(), "src", "db", WORKER_FILE);
  if (existsSync(fromCwd)) return fromCwd;
  throw new Error(`Worker snapshot-io introuvable (${WORKER_FILE}) — reconstruisez l'arbre src/.`);
}

function specsPayload(): SnapshotTableSpec[] {
  return Object.values(SNAPSHOT_TABLE_SPECS);
}

function runWorker<T>(
  payload: Record<string, unknown>,
  onProgress?: (m: SnapshotImportProgress) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let w: Worker;
    try {
      w = new Worker(workerScriptPath(), { workerData: payload });
    } catch (e) {
      reject(serviceError(500, `Worker snapshot-io non démarré : ${toMessage(e)}`));
      return;
    }
    workerHandle = w;
    w.on("message", (m: { type?: string; result?: T; error?: string } & SnapshotImportProgress) => {
      if (m?.type === "progress") {
        const { type: _t, ...fields } = m;
        onProgress?.(fields);
        job.progress = fields;
        return;
      }
      if (m?.type === "done") {
        settled = true;
        workerHandle = null;
        if (m.error) reject(serviceError(500, m.error));
        else resolve(m.result as T);
      }
    });
    w.on("error", (e: unknown) => {
      if (!settled) {
        settled = true;
        workerHandle = null;
        reject(serviceError(500, `Worker snapshot-io : ${toMessage(e)}`));
      }
    });
    w.on("exit", (code: number) => {
      workerHandle = null;
      if (!settled) {
        settled = true;
        reject(new Error(`Worker snapshot-io terminé sans résultat (code ${code})`));
      }
    });
  });
}

function cleanupImportFiles(): void {
  const paths = [job.uploadPath ?? null];
  // Pour un fichier sqlite source, le staging EST le fichier uploadé (jamais doublé).
  if (job.stagePath && job.stagePath !== job.uploadPath) paths.push(job.stagePath);
  for (const p of paths) {
    if (p) rmSync(p, { force: true });
  }
}

function resetJob(): void {
  job = { ...EMPTY_STATUS };
}

/* ── job : upload → analyze → commit ────────────────────────────────── */

function assertNoActiveJob(): void {
  const active = ["uploading", "uploaded", "analyzing", "committing", "analyzed"].includes(job.state);
  if (!active) return;
  const age = Date.now() - (job.startedAt ?? 0);
  if (age > STALE_JOB_MS) {
    // Job gelé (client disparu, worker mort) : on le purge au lieu de bloquer.
    cleanupImportFiles();
    resetJob();
    return;
  }
  throw serviceError(409, `Un import est déjà en cours (état « ${job.state} ») — attendez ou annulez-le.`);
}

export function beginImportUpload(
  dbPath: string,
  maxBytes: number,
): { uploadId: string; uploadPath: string; maxBytes: number } {
  assertNoActiveJob();
  if (!dbPath) {
    throw new Error("dbPath is null or undefined — persistence may be disabled or config not loaded");
  }
  const dbAbs = path.resolve(dbPath);
  const dir = path.join(path.dirname(dbAbs), "imports");
  mkdirSync(dir, { recursive: true });
  sweepImports(dir);
  const uploadId = randomUUID();
  const uploadPath = path.join(dir, `${uploadId}.tmp`);
  job = {
    ...EMPTY_STATUS,
    state: "uploading",
    uploadId,
    mainDbPath: dbAbs,
    startedAt: Date.now(),
  };
  return { uploadId, uploadPath, maxBytes };
}

export function finishUpload(bytes: number): void {
  if (job.state !== "uploading") return;
  job = { ...job, state: "uploaded", uploadBytes: bytes };
}

export function abortCurrentUpload(reason: string | null): void {
  cleanupImportFiles();
  resetJob();
  job.error = reason;
}

export async function analyzeCurrentUpload(uploadId: string | null): Promise<SnapshotAnalyzeResult> {
  if (job.state !== "uploaded") {
    throw serviceError(409, `Analyse impossible — état de l'import : « ${job.state} » (attendu « uploaded »).`);
  }
  if (uploadId && uploadId !== job.uploadId) {
    throw serviceError(409, "uploadId inconnu — un autre import est en cours.");
  }
  job = { ...job, state: "analyzing" };
  const stagePath =
    job.uploadPath != null
      ? path.join(path.dirname(job.uploadPath), `${job.uploadId}.stage.db`)
      : null;
  try {
    const startedAt = Date.now();
    const res = await runWorker<SnapshotAnalyzeResult>(
      {
        mode: "analyze",
        uploadPath: job.uploadPath,
        stagePath,
        mainPath: job.mainDbPath,
        specs: specsPayload(),
      },
      (p) => { job.progress = p; },
    );
    const summary: SnapshotAnalyzeResult = { ...res, elapsedMs: Date.now() - startedAt };
    job = {
      ...job,
      state: "analyzed",
      format: summary.format,
      summary,
      // Source sqlite : le staging EST le fichier uploadé — pas de fichier .stage.db.
      stagePath: summary.format === "sqlite" ? job.uploadPath : (stagePath ?? null),
    };
    return summary;
  } catch (e) {
    job = { ...job, state: "error", error: toMessage(e), finishedAt: Date.now() };
    cleanupImportFiles();
    throw e;
  }
}

export async function commitCurrentUpload(
  uploadId: string | null,
  policy: ImportPolicy,
): Promise<SnapshotCommitResult> {
  if (job.state !== "analyzed") {
    throw serviceError(409, `Commit impossible — état de l'import : « ${job.state} » (attendu « analyzed »).`);
  }
  if (uploadId && uploadId !== job.uploadId) {
    throw serviceError(409, "uploadId inconnu — un autre import est en cours.");
  }
  if (policy === "replace") {
    // Destructif : DELETE du chevauchement — le choix explicite vient de l'UI.
    if (!job.summary?.tables.some((t) => t.rowsTotal > 0)) {
      throw serviceError(400, "Rien à importer (fichier vide) — replace inutile.");
    }
  }
  job = { ...job, state: "committing" };
  try {
    const res = await runWorker<SnapshotCommitResult>(
      {
        mode: "commit",
        mainPath: job.mainDbPath,
        stagePath: job.stagePath ?? job.uploadPath,
        specs: specsPayload(),
        policy,
      },
      (p) => { job.progress = p; },
    );
    job = { ...job, state: "done", result: res, finishedAt: Date.now() };
    cleanupImportFiles();
    return res;
  } catch (e) {
    job = { ...job, state: "error", error: toMessage(e), finishedAt: Date.now() };
    cleanupImportFiles();
    throw e;
  }
}

export function cancelCurrentImport(): SnapshotImportStatus {
  if (workerHandle) {
    workerHandle.terminate();
    workerHandle = null;
  }
  cleanupImportFiles();
  resetJob();
  return importStatusSnapshot();
}

export function importStatusSnapshot(): SnapshotImportStatus {
  return { ...job };
}

/** Nettoyage des fichiers d'imports orphelins (> 24 h). */
function sweepImports(dir: string): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.includes(".")) continue;
      const full = path.join(dir, name);
      try {
        const st = statSync(full);
        if (now - st.mtimeMs > IMPORTS_SWEEP_MS) rmSync(full, { force: true });
      } catch {
        /* fichier disparu entre temps */
      }
    }
  } catch {
    /* dir absent ou non listable */
  }
}

/* ── options d'export (cache 60 s) + export sqlite ──────────────────── */

export async function snapshotExportOptions(
  mainPath: string,
  table: "book_snapshots" | "market_snapshots",
): Promise<SnapshotExportOptionRow[]> {
  const cacheKey = `${table}:${mainPath}`;
  const hit = optionsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < OPTIONS_TTL_MS) return hit.rows;
  if (!mainPath || !existsSync(mainPath)) {
    throw serviceError(503, "Base principale absente — persistance inactive ou démarrage en cours.");
  }
  const rows = await runWorker<SnapshotExportOptionRow[]>({ mode: "options", mainPath, table });
  optionsCache.set(cacheKey, { at: Date.now(), rows });
  return rows;
}

export interface SqliteExportArgs {
  table: SnapshotTableName;
  slug: string | null;
  fromTs: number | null;
  toTs: number | null;
  includeResolutions: boolean;
}

export async function exportSnapshotsToSqlite(
  mainPath: string,
  args: SqliteExportArgs,
): Promise<{ outPath: string; rows: Record<string, number>; elapsedMs: number }> {
  if (!mainPath) {
    throw serviceError(503, "dbPath is null or undefined — persistence may be disabled or config not loaded");
  }
  const dir = path.join(path.dirname(mainPath), "imports");
  mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `export-${args.table}-${Date.now()}-${randomUUID().slice(0, 8)}.db`);
  const res = await runWorker<{ rows: Record<string, number>; elapsedMs: number }>(
    {
      mode: "export-sqlite",
      mainPath,
      outPath,
      table: args.table,
      slug: args.slug,
      fromTs: args.fromTs,
      toTs: args.toTs,
      includeResolutions: args.includeResolutions,
      specs: specsPayload(),
    },
  );
  return { outPath, rows: res.rows, elapsedMs: res.elapsedMs };
}