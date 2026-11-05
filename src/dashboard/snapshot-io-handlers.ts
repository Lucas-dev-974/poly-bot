/**
 * Handlers HTTP snapshot I/O de la page Données — routés depuis server.ts
 * (pattern market-data-handlers) :
 *
 *   GET  /api/db/snapshots/export/options   — marchés + volumes (cache 60 s)
 *   GET  /api/db/snapshots/export           — streamed CSV / NDJSON / SQLite
 *   POST /api/db/snapshots/import/upload    — raw body → imports/<uuid>.tmp
 *   POST /api/db/snapshots/import/analyze   — dry-run (worker readonly)
 *   POST /api/db/snapshots/import/commit    — merge / replace (worker)
 *   GET|DELETE /api/db/snapshots/import/status — progression / annulation
 *
 * Les POST portent la garde Origin/CSRF dans server.ts. GET /export ne porte
 * pas de garde (download direct par navigation, aligné sur les GET existants).
 * 409 explicite si la persistance est désactivée. Le CSV/NDJSON est sérialisé
 * ICI depuis le registre (snapshot-io-schema.ts) — source de vérité unique ;
 * le worker .cjs n'en a que l'usage d'import, via workerData.
 */

import { createReadStream, createWriteStream, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import {
  abortCurrentUpload,
  analyzeCurrentUpload,
  beginImportUpload,
  cancelCurrentImport,
  commitCurrentUpload,
  exportSnapshotsToSqlite,
  finishUpload,
  importStatusSnapshot,
  snapshotExportOptions,
  type ImportPolicy,
} from "../db/snapshot-io.js";
import {
  SNAPSHOT_TABLE_SPECS,
  resolveTableParam,
  type SnapshotTableName,
} from "../db/snapshot-io-schema.js";

export interface SnapshotIoHandlerCtx {
  config: BotConfig;
  repos: Repositories | undefined;
}

/** Plafond de sécurité disque (Q3 : aucun cap restrictif, garde d'abus seule). */
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 ** 3;
const EXPORT_BATCH_ROWS = 10_000;
const JSON_BODY_LIMIT = 64 * 1024;

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function persistenceActive(ctx: SnapshotIoHandlerCtx): boolean {
  return ctx.repos != null && ctx.repos.db.active;
}

function fail(res: ServerResponse, code: number, error: string): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function ok(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Petit corps JSON ({uploadId, policy}) — même convention/cap que server.readBody. */
function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > JSON_BODY_LIMIT) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** SNAPSHOT_IMPORT_MAX_BYTES (octets) — plafond de sécurité uniquement. */
function maxUploadBytes(): number {
  const env = process.env.SNAPSHOT_IMPORT_MAX_BYTES;
  if (env != null && env.trim() !== "") {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return DEFAULT_MAX_UPLOAD_BYTES;
}

const nextTick = (): Promise<void> => new Promise((done) => setImmediate(done));

/** Backpressure — drain OU close (réponse fermée pendant la pause = fin). */
function onceDrain(res: ServerResponse): Promise<void> {
  return new Promise((done) => {
    res.once("drain", () => done());
    res.once("close", () => done());
  });
}

function fmtGo(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}

/* ── sérialisation CSV / NDJSON — miroir exact du registre (hors id) ── */

function csvEscapeCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  return /["\n\r,]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function csvLine(spec: { cols: Array<{ name: string }> }, row: Record<string, unknown>): string {
  return `${spec.cols.map((c) => csvEscapeCell(row[c.name])).join(",")}\n`;
}

function headerFor(spec: { cols: Array<{ name: string }> }): string {
  return `${spec.cols.map((c) => csvEscapeCell(c.name)).join(",")}\n`;
}

function ndjsonLine(
  table: SnapshotTableName,
  spec: { cols: Array<{ name: string }> },
  row: Record<string, unknown>,
): string {
  const out: Record<string, unknown> = { _t: table };
  for (const c of spec.cols) out[c.name] = row[c.name] ?? null;
  return `${JSON.stringify(out)}\n`;
}

function exportFilename(table: SnapshotTableName, slugFilter: string | null, format: string): string {
  const short = table === "book_snapshots" ? "book" : "market";
  const slug = slugFilter ? slugFilter.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) : "all";
  const iso = new Date().toISOString().replace(/[-:T]/g, "");
  const stamp = `${iso.slice(0, 8)}-${iso.slice(8, 14)}`;
  return `${short}-snapshots-${slug}-${stamp}.${format === "sqlite" ? "db" : format}`;
}

/* ── GET /api/db/snapshots/export/options ────────────────────────────── */

export async function handleSnapshotsExportOptions(
  ctx: SnapshotIoHandlerCtx,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  if (!persistenceActive(ctx)) return fail(res, 409, "Persistance désactivée — export impossible.");
  const table = resolveTableParam(url.searchParams.get("table") ?? "");
  if (!table) return fail(res, 400, "table doit valoir book|book_snapshots|market|market_snapshots");
  try {
    const markets = await snapshotExportOptions(
      ctx.config.dbPath,
      table as "book_snapshots" | "market_snapshots",
    );
    ok(res, { table, markets });
  } catch (e) {
    fail(res, 500, toMessage(e));
  }
}

/* ── GET /api/db/snapshots/export (streaming) ────────────────────────── */

interface ExportParams {
  table: SnapshotTableName;
  format: "csv" | "ndjson" | "sqlite";
  slugFilter: string | null;
  fromMs: number | null;
  toMs: number | null;
  includeResolutions: boolean;
}

function parseExportParams(url: URL): ExportParams | string {
  const table = resolveTableParam(url.searchParams.get("table") ?? "");
  if (!table) return "table doit valoir book|book_snapshots|market|market_snapshots";
  const formatRaw = (url.searchParams.get("format") ?? "ndjson").toLowerCase();
  if (formatRaw !== "csv" && formatRaw !== "ndjson" && formatRaw !== "sqlite") {
    return "format doit valoir csv|ndjson|sqlite";
  }
  const slugRaw = (url.searchParams.get("slug") ?? "").trim();
  const slugFilter = slugRaw !== "" && slugRaw !== "all" ? slugRaw : null;
  const parseTs = (key: string): number | null => {
    const raw = url.searchParams.get(key);
    if (raw == null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : NaN;
  };
  const fromMs = parseTs("from");
  const toMs = parseTs("to");
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return "paramètres from/to invalides (epoch ms attendus)";
  }
  if (fromMs != null && toMs != null && fromMs > toMs) return "plage inversée : from > to";
  const includeResolutions = url.searchParams.get("includeResolutions") === "1";
  if (formatRaw === "csv" && includeResolutions) {
    return "Format CSV : market_resolutions non inclus — utiliser ndjson ou sqlite.";
  }
  return { table, format: formatRaw, slugFilter, fromMs, toMs, includeResolutions };
}

export async function handleSnapshotsExport(
  ctx: SnapshotIoHandlerCtx,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  if (!persistenceActive(ctx)) return fail(res, 409, "Persistance désactivée — export impossible.");
  const params = parseExportParams(url);
  if (typeof params === "string") return fail(res, 400, params);
  try {
    if (params.format === "csv" || params.format === "ndjson") {
      await streamFlat(ctx, params, res);
      return;
    }
    await exportSqliteFile(ctx, params, res);
  } catch (e) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    fail(res, 500, toMessage(e));
  }
}

interface FlatFilters {
  eventSlug: string | null;
  fromTs: number | null;
  toTs: number | null;
}

async function streamFlat(
  ctx: SnapshotIoHandlerCtx,
  params: ExportParams,
  res: ServerResponse,
): Promise<void> {
  const repos = ctx.repos!;
  const table = params.table;
  const spec = SNAPSHOT_TABLE_SPECS[table];
  const filters: FlatFilters = {
    eventSlug: params.slugFilter,
    fromTs: params.fromMs,
    toTs: params.toMs,
  };
  const startedAt = Date.now();
  res.writeHead(200, {
    "Content-Type":
      params.format === "csv"
        ? "text/csv; charset=utf-8"
        : "application/x-ndjson",
    "Content-Disposition": `attachment; filename="${exportFilename(table, params.slugFilter, params.format)}"`,
    "Cache-Control": "no-store",
  });
  if (params.format === "csv") res.write(headerFor(spec));

  let count = 0;
  let last = 0;
  for (;;) {
    const rows =
      table === "book_snapshots"
        ? repos.bookSnapshots.pageAfter(last, EXPORT_BATCH_ROWS, filters)
        : repos.marketSnapshots.pageAfter(last, EXPORT_BATCH_ROWS, filters);
    if (rows.length === 0) break;
    last = rows[rows.length - 1].id;
    let chunk = "";
    for (const r of rows) {
      const record = r as unknown as Record<string, unknown>;
      chunk += params.format === "csv" ? csvLine(spec, record) : ndjsonLine(table, spec, record);
    }
    count += rows.length;
    if (!res.write(chunk)) {
      await onceDrain(res);
      if (res.destroyed) return;
    }
    await nextTick();
    if (res.destroyed) return;
  }

  // Annexe market_resolutions : uniquement en NDJSON (discriminant _t).
  if (params.format === "ndjson" && params.includeResolutions) {
    const resolutions = params.slugFilter
      ? repos.marketResolutions.bySlug(params.slugFilter)
      : repos.marketResolutions.all();
    for (const r of resolutions) {
      res.write(
        ndjsonLine(
          "market_resolutions",
          SNAPSHOT_TABLE_SPECS.market_resolutions,
          r as unknown as Record<string, unknown>,
        ),
      );
    }
    count += resolutions.length;
  }

  res.end();
  console.log(
    `[snapshot-io] export ${table} (${params.format}) → ${count} lignes en ${Date.now() - startedAt} ms`,
  );
}

async function exportSqliteFile(
  ctx: SnapshotIoHandlerCtx,
  params: ExportParams,
  res: ServerResponse,
): Promise<void> {
  const result = await exportSnapshotsToSqlite(ctx.config.dbPath, {
    table: params.table,
    slug: params.slugFilter,
    fromTs: params.fromMs,
    toTs: params.toMs,
    includeResolutions: params.includeResolutions,
  });
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${exportFilename(params.table, params.slugFilter, "sqlite")}"`,
    "Cache-Control": "no-store",
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const rs = createReadStream(result.outPath);
    const finish = (e?: unknown): void => {
      if (settled) return;
      settled = true;
      rs.destroy();
      if (e != null && !res.destroyed) reject(e);
      else resolve();
    };
    res.on("close", () => finish());
    rs.on("error", (e) => finish(e));
    rs.on("data", (chunk) => {
      if (settled) return;
      if (!res.write(chunk)) {
        rs.pause();
        res.once("drain", () => rs.resume());
      }
    });
    rs.on("end", () => finish());
  });
  if (!res.destroyed) res.end();
  rmSync(result.outPath, { force: true });
  const total = Object.values(result.rows).reduce((s, n) => s + n, 0);
  console.log(`[snapshot-io] export sqlite ${params.table} → ${total} lignes (${result.elapsedMs} ms build)`);
}

/* ── POST /api/db/snapshots/import/upload (raw body → fichier) ───────── */

function writeIncomingToFile(
  req: IncomingMessage,
  dest: string,
  maxBytes: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let received = 0;
    let settled = false;
    const out = createWriteStream(dest);
    const err = (e: unknown, tooLarge = false): void => {
      if (settled) return;
      settled = true;
      if (tooLarge) {
        const wrapped = new Error(`Fichier trop volumineux — maximum ${fmtGo(maxBytes)}.`);
        (wrapped as Error & { tooLarge?: boolean }).tooLarge = true;
        reject(wrapped);
      } else {
        reject(e);
      }
      req.destroy();
      out.destroy();
    };
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) err(new Error("too large"), true);
    });
    req.on("error", (e) => err(e));
    out.on("error", (e) => err(e));
    out.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve(received);
    });
    req.pipe(out);
  });
}

export async function handleSnapshotsImportUpload(
  ctx: SnapshotIoHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!persistenceActive(ctx)) return fail(res, 409, "Persistance désactivée — import impossible.");
  const maxBytes = maxUploadBytes();
  let handle: { uploadId: string; uploadPath: string };
  try {
    handle = beginImportUpload(ctx.config.dbPath, maxBytes);
  } catch (e) {
    return fail(res, 409, toMessage(e));
  }
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    abortCurrentUpload("upload refusé (Content-Length au-delà du plafond)");
    return fail(res, 413, `Fichier trop volumineux (${fmtGo(contentLength)}) — maximum ${fmtGo(maxBytes)}.`);
  }
  try {
    const received = await writeIncomingToFile(req, handle.uploadPath, maxBytes);
    finishUpload(received);
    ok(res, { uploadId: handle.uploadId, bytes: received });
  } catch (e) {
    abortCurrentUpload(toMessage(e));
    const tooLarge = (e as Error & { tooLarge?: boolean }).tooLarge === true;
    fail(res, tooLarge ? 413 : 500, toMessage(e));
  }
}

/* ── POST analyze / commit + status ──────────────────────────────────── */

export async function handleSnapshotsImportAnalyze(
  ctx: SnapshotIoHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!persistenceActive(ctx)) return fail(res, 409, "Persistance désactivée — import impossible.");
  let body: { uploadId?: string };
  try {
    body = JSON.parse((await readJsonBody(req)) || "{}") as { uploadId?: string };
  } catch {
    return fail(res, 400, "Corps JSON invalide.");
  }
  try {
    const summary = await analyzeCurrentUpload(body.uploadId ?? null);
    // Avertissements calculés côté serveur (config connue ici seulement) :
    if (summary.tables.some((t) => t.rowsTotal > 0)) {
      const warnings: string[] = [];
      if ((ctx.config.marketSnapshotRetentionMs ?? 0) > 0) {
        warnings.push(
          `Rétention active sur market_snapshots (${Math.round(ctx.config.marketSnapshotRetentionMs / 86_400_000)} j) — les données importées plus anciennes seront purgées au prochain tick.`,
        );
      }
      if ((ctx.config.bookSnapshotRetentionMs ?? 0) > 0) {
        warnings.push(
          `Rétention active sur book_snapshots (${Math.round(ctx.config.bookSnapshotRetentionMs / 86_400_000)} j) — les données importées plus anciennes seront purgées au prochain tick.`,
        );
      }
      if (warnings.length > 0) summary.warnings = warnings;
    }
    ok(res, summary);
  } catch (e) {
    fail(res, (e as Error & { code?: number }).code ?? 500, toMessage(e));
  }
}

export async function handleSnapshotsImportCommit(
  ctx: SnapshotIoHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!persistenceActive(ctx)) return fail(res, 409, "Persistance désactivée — import impossible.");
  let body: { uploadId?: string; policy?: string };
  try {
    body = JSON.parse((await readJsonBody(req)) || "{}") as { uploadId?: string; policy?: string };
  } catch {
    return fail(res, 400, "Corps JSON invalide.");
  }
  const policy: ImportPolicy | null =
    body.policy === "replace" ? "replace" : body.policy === "merge" ? "merge" : null;
  if (!policy) return fail(res, 400, "policy doit valoir merge|replace.");
  try {
    const result = await commitCurrentUpload(body.uploadId ?? null, policy);
    ok(res, result);
  } catch (e) {
    fail(res, (e as Error & { code?: number }).code ?? 500, toMessage(e));
  }
}

export function handleSnapshotsImportStatus(
  ctx: SnapshotIoHandlerCtx,
  res: ServerResponse,
): void {
  const s = importStatusSnapshot();
  // Les chemins internes (upload/stage) ne quittent PAS le serveur.
  ok(res, {
    state: s.state,
    uploadId: s.uploadId,
    bytes: s.uploadBytes,
    format: s.format,
    summary: s.summary,
    result: s.result,
    progress: s.progress,
    error: s.error,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    persistence: persistenceActive(ctx),
  });
}

export async function handleSnapshotsImportCancel(
  ctx: SnapshotIoHandlerCtx,
  res: ServerResponse,
): Promise<void> {
  cancelCurrentImport();
  ok(res, { ok: true, status: importStatusSnapshot() });
}