/**
 * Worker snapshot I/O — générique : les specs de tables lui parviennent via
 * workerData (src/db/snapshot-io-schema.ts). Aucune colonne en dur ici.
 *
 * Modes (payload.mode) :
 *  - "options"       : GROUP BY eventSlug d'un snapshot (lecture, 60 s de cache côté service)
 *  - "analyze"       : staging du fichier uploadé + compteurs dry-run vs main (readonly)
 *  - "commit"        : merge/replace du staging vers la base principale (écriture)
 *  - "export-sqlite" : copie filtrée d'une table vers un .db neuf
 *
 * Les fonctions sont exportées pour les tests (node --test) : appelées avec
 * le même payload que le dispatch worker. En mode worker (parentPort),
 * le dispatch s'exécute et publie {type:"progress"}/{type:"done"}.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Better = require("better-sqlite3");
const wt = require("node:worker_threads");

const SQLITE_MAGIC = "SQLite format 3" + String.fromCharCode(0);
const KEY_SEP = "\u0000";
const SQLITE_HEADER_SQLITE = 16;

/* ── utilitaires génériques ──────────────────────────────────────────── */

function escSqlPath(p) {
  return String(p).replace(/'/g, "''");
}

function keyOf(spec, row) {
  return spec.dedupeKey.map((k) => (typeof row[k] === "string" ? JSON.stringify(row[k]) : String(row[k]))).join(KEY_SEP);
}

/** DDL de staging (sans colonne id — le paging utilise rowid). */
function createTableSql(spec) {
  const cols = spec.cols
    .map((c) => `${c.name} ${c.type.toUpperCase()}${c.required ? " NOT NULL" : ""}`)
    .join(", ");
  return `CREATE TABLE ${spec.name} (${cols})`;
}

function tableExists(db, qualified, name) {
  const row = db.prepare(`SELECT 1 AS ok FROM ${qualified}.sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  return row != null;
}

function tableColumns(db, schema, name) {
  return db.prepare(`PRAGMA ${schema}.table_info(${name})`).all().map((c) => c.name);
}

/** Projection : colonnes du registre présentes, sinon NULL AS <col>. */
function projectionFor(spec, present) {
  return spec.cols
    .map((c) => (present.has(c.name) ? c.name : `NULL AS ${c.name}`))
    .join(", ");
}

/* ── détection de format ─────────────────────────────────────────────── */

function detectFormat(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(SQLITE_HEADER_SQLITE);
    fs.readSync(fd, head, 0, SQLITE_HEADER_SQLITE, 0);
    if (head.toString("latin1").startsWith(SQLITE_MAGIC)) return "sqlite";
    const sample = Buffer.alloc(8192);
    const n = fs.readSync(fd, sample, 0, sample.length, 0);
    const text = sample.toString("utf8", 0, n).replace(/^\uFEFF/, "");
    const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    if (firstLine.trimStart().startsWith("{")) {
      try {
        JSON.parse(firstLine.trim());
        return "ndjson";
      } catch {
        /* pas du json ligne 1 → on tente csv */
      }
    }
    if (firstLine.includes(",")) return "csv";
  } finally {
    fs.closeSync(fd);
  }
  throw new Error("Format de fichier non reconnu (attendu : ndjson, csv ou sqlite)");
}

/* ── CSV (RFC4180, guillemets/virgules/retours, BOM strippé) ─────────── */

function createCsvSplitter(onRow) {
  let field = "";
  let row = [];
  let inQuotes = false;
  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (inQuotes) {
          if (c === '"') {
            if (chunk[i + 1] === '"') {
              field += '"';
              i++;
            } else {
              inQuotes = false;
            }
          } else if (c !== "\r") {
            field += c;
          }
        } else if (c === '"') {
          inQuotes = true;
        } else if (c === ",") {
          row.push(field);
          field = "";
        } else if (c === "\n") {
          row.push(field);
          field = "";
          onRow(row);
          row = [];
        } else if (c !== "\r") {
          field += c;
        }
      }
    },
    end() {
      if (inQuotes) {
        throw new Error("CSV invalide — guillemet non refermé en fin de fichier");
      }
      if (field !== "" || row.length > 0) {
        row.push(field);
        onRow(row);
      }
    },
  };
}

function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  return /["\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function iterCsvFile(filePath, onHeader, onRow) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, "utf8");
    let headerSent = false;
    const splitter = createCsvSplitter((cells) => {
      if (!headerSent) {
        headerSent = true;
        onHeader(cells.map((c) => c.replace(/^\uFEFF/, "").trim()));
        return;
      }
      if (cells.length === 1 && cells[0].trim() === "") return; // ligne vide
      onRow(cells);
    });
    stream.on("data", (chunk) => {
      try {
        splitter.push(chunk);
      } catch (e) {
        stream.destroy();
        reject(e);
      }
    });
    stream.on("end", () => {
      try {
        splitter.end();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    stream.on("error", reject);
  });
}

function matchTableByHeader(header, specs) {
  const hset = new Set(header);
  const score = (s) => s.cols.filter((c) => hset.has(c.name)).length;
  const matches = specs.filter((s) => s.cols.filter((c) => c.required).every((c) => hset.has(c.name)));
  if (matches.length === 0) {
    throw new Error(`Header CSV non reconnu — aucune table du registre ne couvre ces colonnes (${header.join(", ")})`);
  }
  matches.sort((a, b) => score(b) - score(a));
  if (matches.length === 1) return matches[0];
  if (score(matches[0]) > score(matches[1])) return matches[0];
  throw new Error(`Header CSV ambigu entre tables : ${matches.map((m) => m.name).join(" / ")}`);
}

/* ── NDJSON ──────────────────────────────────────────────────────────── */

function iterNdjsonFile(filePath, onRow) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, "utf8");
    let buffer = "";
    let first = true;
    stream.on("data", (chunk) => {
      buffer += first ? chunk.replace(/^\uFEFF/, "") : chunk;
      first = false;
      let idx = buffer.lastIndexOf("\n");
      if (idx === -1) return;
      const lines = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      for (const line of lines.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          onRow(JSON.parse(trimmed));
        } catch (e) {
          stream.destroy();
          reject(new Error(`NDJSON invalide : ${e instanceof Error ? e.message : String(e)}`));
          return;
        }
      }
    });
    stream.on("end", () => {
      const trimmed = buffer.trim();
      if (trimmed) {
        try {
          onRow(JSON.parse(trimmed));
        } catch (e) {
          reject(new Error(`NDJSON invalide : ${e instanceof Error ? e.message : String(e)}`));
          return;
        }
      }
      resolve();
    });
    stream.on("error", reject);
  });
}

/* ── validation / coercition d'une ligne ─────────────────────────────── */

function coerceRowValue(col, raw, fmt) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (fmt === "csv" && typeof raw === "string" && raw === "") return { ok: true, value: null };
  if (col.type === "integer") {
    const v = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      return { ok: false, why: `entier attendu, reçu ${JSON.stringify(raw)}` };
    }
    return { ok: true, value: v };
  }
  if (col.type === "real") {
    const v = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isFinite(v)) {
      return { ok: false, why: `nombre attendu, reçu ${JSON.stringify(raw)}` };
    }
    return { ok: true, value: v };
  }
  const v = typeof raw === "string" ? raw : fmt === "csv" ? String(raw) : String(raw);
  return { ok: true, value: v };
}

/**
 * Valide une ligne brute (objet) contre une spec.
 * Retour : {row, extra} ou {error}.
 */
function validateRow(spec, raw, fmt) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "ligne non-objet" };
  }
  const row = {};
  let extra = false;
  for (const col of spec.cols) {
    const r = coerceRowValue(col, raw[col.name], fmt);
    if (!r.ok) return { error: `${col.name} : ${r.why}` };
    if (r.value == null && col.required) {
      return { error: `${col.name} requis (absent ou vide)` };
    }
    if (col.name === "ts" && r.value != null && r.value <= 0) {
      return { error: "ts doit être positif (epoch ms)" };
    }
    row[col.name] = r.value;
  }
  const known = new Set([...spec.cols.map((c) => c.name), "_t", "id"]);
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) extra = true;
  }
  if (spec.name === "book_snapshots" && row.outcomeIndex !== 0 && row.outcomeIndex !== 1) {
    return { error: `outcomeIndex doit valoir 0 ou 1 (reçu ${JSON.stringify(raw.outcomeIndex)})` };
  }
  if (spec.name === "market_resolutions" && row.winnerOutcomeIndex !== 0 && row.winnerOutcomeIndex !== 1) {
    return { error: `winnerOutcomeIndex doit valoir 0 ou 1 (reçu ${JSON.stringify(raw.winnerOutcomeIndex)})` };
  }
  return { row, extra };
}

/* ── analyze : staging ndjson/csv ou lecture directe sqlite ──────────── */

function newCounters() {
  return { rowsTotal: 0, invalid: 0, examples: [], minTs: null, maxTs: null };
}

async function stageRowsFromFlatFile(args, stage) {
  const { uploadPath, format, specs, batchRows = 5000, progressEvery = 200000 } = args;
  const counts = new Map(specs.map((s) => [s.name, newCounters()]));
  const insertStmts = new Map();
  let txPending = 0;
  let extras = 0;

  const insertRow = (spec, row) => {
    let stmt = insertStmts.get(spec.name);
    if (!stmt) {
      stmt = stage.prepare(
        `INSERT INTO ${spec.name} (${spec.cols.map((c) => c.name).join(", ")}) VALUES (${spec.cols.map(() => "?").join(", ")})`,
      );
      insertStmts.set(spec.name, stmt);
    }
    if (txPending === 0) stage.exec("BEGIN");
    stmt.run(...spec.cols.map((c) => row[c.name]));
    txPending++;
    if (txPending >= batchRows) {
      stage.exec("COMMIT");
      txPending = 0;
    }
  };

  const handleRaw = (spec, raw, fmt, lineno) => {
    const c = counts.get(spec.name);
    const v = validateRow(spec, raw, fmt);
    if (v.error) {
      c.invalid++;
      if (c.examples.length < 5) c.examples.push(`ligne ${lineno} : ${v.error}`);
      return;
    }
    if (v.extra) extras++;
    c.rowsTotal++;
    if (c.minTs == null || v.row.ts < c.minTs) c.minTs = v.row.ts;
    if (c.maxTs == null || v.row.ts > c.maxTs) c.maxTs = v.row.ts;
    if (c.rowsTotal % progressEvery === 0) progress({ staged: c.rowsTotal, invalid: c.invalid, table: spec.name });
    insertRow(spec, v.row);
  };

  let lineno = 0;
  if (format === "ndjson") {
    await iterNdjsonFile(uploadPath, (obj) => {
      lineno++;
      const target = typeof obj._t === "string" ? specs.find((s) => s.name === obj._t) : null;
      if (!target) {
        const c = counts.get("book_snapshots");
        c.invalid++;
        if (c.examples.length < 5) c.examples.push(`ligne ${lineno} : clé _t absente ou inconnue — table ambiguë`);
        return;
      }
      handleRaw(target, obj, "json", lineno);
    });
  } else {
    // CSV : le header (ligne 1) choisit la table ; les lignes suivantes la remplissent.
    let csvSpec = null;
    let csvHeader = null;
    await iterCsvFile(
      uploadPath,
      (header) => {
        csvSpec = matchTableByHeader(header, specs);
        csvHeader = header;
      },
      (cells) => {
        if (!csvSpec || !csvHeader) return;
        if (cells.length !== csvHeader.length) {
          const c = counts.get(csvSpec.name);
          c.invalid++;
          if (c.examples.length < 5) c.examples.push(`ligne : ${cells.length} cellules pour ${csvHeader.length} colonnes`);
          return;
        }
        lineno++;
        const raw = {};
        csvHeader.forEach((h, i) => {
          raw[h] = cells[i];
        });
        handleRaw(csvSpec, raw, "csv", lineno);
      },
    );
    if (csvSpec == null) {
      throw new Error("Header CSV non reconnu — voir l'exemple d'erreur ci-dessus.");
    }
  }

  if (txPending > 0) stage.exec("COMMIT");
  return { counts, extras };
}

function post(message) {
  if (wt.parentPort) wt.parentPort.postMessage(message);
}

function progress(fields) {
  post({ type: "progress", ...fields });
}

function summarizeTable(stage, mainPath, spec, counters) {
  const key = spec.dedupeKey.join(", ");
  const keyWhere = spec.dedupeKey.map((k) => `m.${k} = s.${k}`).join(" AND ");
  const c = counters;
  const out = {
    name: spec.name,
    rowsTotal: c.rowsTotal,
    invalid: c.invalid,
    examples: c.examples,
    distinctKeys: 0,
    alreadyPresent: 0,
    newRows: 0,
    dedupInFile: 0,
    minTs: c.minTs,
    maxTs: c.maxTs,
    slugCount: 0,
  };
  if (c.rowsTotal === 0) return out;
  out.distinctKeys = stage
    .prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${key} FROM ${spec.name})`)
    .get().n;
  out.dedupInFile = c.rowsTotal - out.distinctKeys;
  out.slugCount = stage
    .prepare(`SELECT COUNT(DISTINCT eventSlug) AS n FROM ${spec.name}`)
    .get().n;
  if (mainPath != null) {
    let mainAvailable = true;
    try {
      stage.exec(`ATTACH DATABASE '${escSqlPath(mainPath)}' AS mainro`);
    } catch (e) {
      mainAvailable = false;
      out.error = `Base principale non attachable : ${e instanceof Error ? e.message : String(e)}`;
    }
    if (mainAvailable) {
      if (tableExists(stage, "mainro", spec.name)) {
        out.newRows = stage
          .prepare(
            `SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${key} FROM ${spec.name} s WHERE NOT EXISTS (SELECT 1 FROM mainro.${spec.name} m WHERE ${keyWhere}))`,
          )
          .get().n;
      } else {
        out.newRows = out.distinctKeys;
      }
    } else {
      // Base principale absente : tout le contenu du fichier compte comme nouveau.
      out.newRows = out.distinctKeys;
    }
    out.alreadyPresent = out.distinctKeys - out.newRows;
  }
  return out;
}

async function analyzeSqliteSource(args) {
  const { uploadPath, mainPath, specs } = args;
  const stage = new Better(uploadPath);
  const tables = [];
  try {
    stage.exec(`ATTACH DATABASE '${escSqlPath(mainPath)}' AS mainro`);
    for (const spec of specs) {
      const present = new Set(stage.prepare(`PRAGMA main.table_info(${spec.name})`).all().map((c) => c.name));
      if (present.size === 0) {
        tables.push({ name: spec.name, rowsTotal: 0, invalid: 0, examples: [], distinctKeys: 0, alreadyPresent: 0, newRows: 0, dedupInFile: 0, minTs: null, maxTs: null, slugCount: 0 });
        continue;
      }
      const missing = spec.cols.filter((c) => c.required && !present.has(c.name));
      if (missing.length > 0) {
        tables.push({
          name: spec.name,
          rowsTotal: 0,
          invalid: 0,
          examples: [`colonnes requises absentes du fichier : ${missing.map((m) => m.name).join(", ")}`],
          distinctKeys: 0,
          alreadyPresent: 0,
          newRows: 0,
          dedupInFile: 0,
          minTs: null,
          maxTs: null,
          slugCount: 0,
        });
        continue;
      }
      const rowsTotal = stage.prepare(`SELECT COUNT(*) AS n FROM ${spec.name}`).get().n;
      tables.push(summarizeTable(stage, mainPath, spec, { ...newCounters(), rowsTotal }));
      if (rowsTotal % 200000 === 0 && rowsTotal > 0) progress({ staged: rowsTotal, invalid: 0, table: spec.name });
    }
  } finally {
    stage.close();
  }
  return { format: "sqlite", extras: 0, tables };
}

async function analyzeUpload(args) {
  const { uploadPath } = args;
  const format = detectFormat(uploadPath);
  if (format === "sqlite") return analyzeSqliteSource(args);

  const { stagePath, mainPath, specs } = args;
  fs.rmSync(stagePath, { force: true });
  const stage = new Better(stagePath);
  try {
    for (const spec of specs) stage.exec(createTableSql(spec));
    const { counts, extras } = await stageRowsFromFlatFile({ ...args, format }, stage);
    const tables = [];
    for (const spec of specs) {
      tables.push(summarizeTable(stage, mainPath, spec, counts.get(spec.name)));
    }
    return { format, extras, tables };
  } finally {
    stage.close();
  }
}

/* ── commit : merge / replace du staging vers la base principale ─────── */

function deleteScopeSql(stage, spec) {
  if (spec.replaceScope === "key") {
    return {
      sql: `DELETE FROM main.${spec.name} WHERE ${spec.dedupeKey[0]} IN (SELECT DISTINCT ${spec.dedupeKey[0]} FROM ${spec.name})`,
      rows: stage.prepare(`SELECT COUNT(DISTINCT ${spec.dedupeKey[0]}) AS n FROM ${spec.name}`).get().n,
    };
  }
  const bounds = stage.prepare(`SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM ${spec.name}`).get();
  return {
    sql: `DELETE FROM main.${spec.name} WHERE ts BETWEEN ${bounds.lo ?? 0} AND ${bounds.hi ?? 0} AND eventSlug IN (SELECT DISTINCT eventSlug FROM ${spec.name})`,
    rows: bounds.lo == null ? 0 : 1,
  };
}

function commitStaging(args) {
  const { mainPath, stagePath, specs, policy, batchRows = 5000 } = args;
  if (!fs.existsSync(stagePath)) {
    throw new Error("Staging introuvable — relancez l'analyse de l'import.");
  }
  const startedAt = Date.now();
  if (path.resolve(stagePath) === path.resolve(mainPath)) {
    throw new Error("Le fichier importé EST la base principale — import inutile.");
  }
  const db = new Better(mainPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`ATTACH DATABASE '${escSqlPath(stagePath)}' AS stageread`);
  const stage = new Better(stagePath, { readonly: true });
  const perTable = {};
  const out = { inserted: 0, skipped: 0, dedupInFile: 0, deleted: 0, elapsedMs: 0, perTable };
  const timings = {};
  try {
    // Créer l'index helper AVANT toute opération DELETE/INSERT pour préserver l'atomicité.
    // L'index est construit SEULEMENT s'il existe au moins une ligne nouvelle dans book_snapshots.
    const bookSpec = specs.find((s) => s.name === "book_snapshots");
    if (bookSpec && tableExists(stage, "main", bookSpec.name)) {
      const keyEqs = bookSpec.dedupeKey.map((k) => `m.${k} = s.${k}`).join(" AND ");
      const anyNew = db
        .prepare(`SELECT 1 FROM stageread.${bookSpec.name} s WHERE NOT EXISTS (SELECT 1 FROM main.${bookSpec.name} m WHERE ${keyEqs}) LIMIT 1`)
        .get();
      if (anyNew) {
        const i0 = Date.now();
        db.exec("CREATE INDEX IF NOT EXISTS idx_book_snapshots_token_ts ON book_snapshots(tokenId, ts)");
        timings.indexBookTokenTsMs = Date.now() - i0;
      }
    }

    for (const spec of specs) {
      if (!tableExists(stage, "main", spec.name)) continue;
      const staged = stage.prepare(`SELECT COUNT(*) AS n FROM ${spec.name}`).get().n;
      if (staged === 0) continue;
      if (!tableExists(db, "main", spec.name)) {
        throw new Error(`Table ${spec.name} absente de la base principale — démarrez le bot (init du schéma) puis réessayez.`);
      }
      const t = { staged, inserted: 0, skipped: 0, dedupInFile: 0, deleted: 0 };
      const t0 = Date.now();
      if (policy === "replace") {
        const scope = deleteScopeSql(stage, spec);
        const info = db.prepare(scope.sql).run(); // { changes } — DELETE unique, pas de transaction implicite
        t.deleted = info.changes;
        out.deleted += t.deleted;
      }
      const present = new Set(stage.prepare(`PRAGMA main.table_info(${spec.name})`).all().map((c) => c.name));
      const selectCols = `rowid AS __rid, ${projectionFor(spec, present)}`;
      const fetchBatch = stage.prepare(`SELECT ${selectCols} FROM ${spec.name} WHERE rowid > ? ORDER BY rowid LIMIT ${Number(batchRows)}`);
      const probe = db.prepare(`SELECT 1 FROM main.${spec.name} WHERE ${spec.dedupeKey.map((k) => `${k} = ?`).join(" AND ")} LIMIT 1`);
      const insert = db.prepare(
        `INSERT INTO main.${spec.name} (${spec.cols.map((c) => c.name).join(", ")}) VALUES (${spec.cols.map(() => "?").join(", ")})`,
      );
      let lastRowId = 0;
      for (;;) {
        const rows = fetchBatch.all(lastRowId);
        if (rows.length === 0) break;
        lastRowId = rows[rows.length - 1].__rid;
        db.exec("BEGIN");
        const batchKeys = new Set();
        for (const r of rows) {
          const k = keyOf(spec, r);
          if (batchKeys.has(k)) {
            t.dedupInFile++;
            continue;
          }
          batchKeys.add(k);
          const keyVals = spec.dedupeKey.map((c) => r[c]);
          if (probe.get(...keyVals)) {
            t.skipped++;
            continue;
          }
          insert.run(...spec.cols.map((c) => r[c.name]));
          t.inserted++;
        }
        db.exec("COMMIT");
        progress({ phase: "commit", table: spec.name, merged: t.inserted, skipped: t.skipped, deleted: t.deleted });
      }
      t.ms = Date.now() - t0;
      perTable[spec.name] = t;
      out.inserted += t.inserted;
      out.skipped += t.skipped;
      out.dedupInFile += t.dedupInFile;
    }
  } finally {
    db.close();
    stage.close();
  }
  out.elapsedMs = Date.now() - startedAt;
  if (Object.keys(timings).length > 0) out.timings = timings;
  return out;
}

/* ── export sqlite + options ─────────────────────────────────────────── */

function exportSqlite(args) {
  const { mainPath, outPath, table, slug, fromTs, toTs, includeResolutions, specs } = args;
  const spec = specs.find((s) => s.name === table);
  if (!spec) throw new Error(`Table inconnue : ${table}`);
  const startedAt = Date.now();
  fs.rmSync(outPath, { force: true });
  const out = new Better(outPath);
  try {
    out.exec(`ATTACH DATABASE '${escSqlPath(mainPath)}' AS src`);
    const targets = [spec];
    if (includeResolutions && spec.name !== "market_resolutions") {
      targets.push(specs.find((s) => s.name === "market_resolutions"));
    }
    const rows = {};
    for (const t of targets) {
      if (!t) continue;
      if (!tableExists(out, "src", t.name)) {
        rows[t.name] = 0;
        continue;
      }
      out.exec(createTableSql(t));
      const present = new Set(out.prepare(`PRAGMA src.table_info(${t.name})`).all().map((c) => c.name));
      const selectCols = projectionFor(t, present);
      const where = [];
      const params = [];
      if (t.name !== "market_resolutions") {
        if (slug && slug !== "all") {
          where.push("eventSlug = ?");
          params.push(slug);
        }
        if (fromTs != null) {
          where.push("ts >= ?");
          params.push(fromTs);
        }
        if (toTs != null) {
          where.push("ts <= ?");
          params.push(toTs);
        }
      }
      let sql = `INSERT INTO main.${t.name} (${t.cols.map((c) => c.name).join(", ")}) SELECT ${selectCols} FROM src.${t.name}`;
      if (t.name === "market_resolutions" && slug && slug !== "all") {
        // Résolutions limitées aux marchés de la sélection.
        sql += ` WHERE eventSlug = ?`;
        params.push(slug);
      } else if (where.length > 0) {
        sql += ` WHERE ${where.join(" AND ")}`;
      }
      rows[t.name] = out.prepare(sql).run(...params).changes;
    }
    return { rows, elapsedMs: Date.now() - startedAt };
  } finally {
    out.close();
  }
}

function snapshotOptions(args) {
  const { mainPath, table } = args;
  const db = new Better(mainPath, { readonly: true });
  try {
    if (table === "market_snapshots") {
      return db
        .prepare("SELECT eventSlug, MAX(eventTitle) AS title, COUNT(*) AS rowCount, MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM market_snapshots GROUP BY eventSlug ORDER BY eventSlug")
        .all();
    }
    return db
      .prepare("SELECT eventSlug, COUNT(*) AS rowCount, MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM book_snapshots GROUP BY eventSlug ORDER BY eventSlug")
      .all();
  } finally {
    db.close();
  }
}

/* ── dispatch worker / exports tests ─────────────────────────────────── */

async function dispatch(payload) {
  switch (payload.mode) {
    case "options":
      return snapshotOptions(payload);
    case "analyze":
      return analyzeUpload(payload);
    case "commit":
      return commitStaging(payload);
    case "export-sqlite":
      return exportSqlite(payload);
    default:
      throw new Error(`Mode worker inconnu : ${payload.mode}`);
  }
}

if (wt.parentPort && wt.workerData) {
  dispatch(wt.workerData)
    .then((result) => wt.parentPort.postMessage({ type: "done", result }))
    .catch((e) => wt.parentPort.postMessage({ type: "done", error: e instanceof Error ? e.message : String(e) }));
}

module.exports = {
  createTableSql,
  createCsvSplitter,
  csvEscape,
  detectFormat,
  iterCsvFile,
  iterNdjsonFile,
  matchTableByHeader,
  coerceRowValue,
  validateRow,
  analyzeUpload,
  commitStaging,
  exportSqlite,
  snapshotOptions,
  keyOf,
};