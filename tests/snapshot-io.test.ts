/**
 * Tests snapshot I/O (export/import/merge) — worker générique vs registre
 * (src/db/snapshot-io-schema.ts), sur des bases sqlite temporaires.
 *
 * Lancé ciblé : `npx tsx --test tests/snapshot-io.test.ts`
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Better from "better-sqlite3";
import {
  SNAPSHOT_TABLE_SPECS,
  type SnapshotTableSpec,
} from "../src/db/snapshot-io-schema.js";
import {
  analyzeCurrentUpload,
  beginImportUpload,
  cancelCurrentImport,
  commitCurrentUpload,
  finishUpload,
} from "../src/db/snapshot-io.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const worker = require("../src/db/snapshot-io-worker.cjs") as any;

const SPECS = Object.values(SNAPSHOT_TABLE_SPECS) as SnapshotTableSpec[];

/** Accès .get() typé (better-sqlite3 renvoie unknown). */
function one<T = Record<string, unknown>>(
  db: Better.Database,
  sql: string,
  ...params: Array<string | number>
): T {
  return (params.length ? db.prepare(sql).get(...params) : db.prepare(sql).get()) as T;
}

/** Base principale de test — schéma runtime minimal (id UNIQUEMENT où le schéma en a un). */
function makeMainDb(dir: string, name = "main.db"): { path: string; db: Better.Database } {
  const p = join(dir, name);
  const db = new Better(p);
  db.exec(`
    CREATE TABLE book_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, eventSlug TEXT NOT NULL, tokenId TEXT NOT NULL,
      outcome TEXT NOT NULL, outcomeIndex INTEGER NOT NULL,
      bestBid REAL, bestAsk REAL, bestAskSize REAL, bestBidSize REAL,
      ask2 REAL, ask2Size REAL, ask3 REAL, ask3Size REAL,
      bid2 REAL, bid2Size REAL, bid3 REAL, bid3Size REAL
    );
    CREATE TABLE market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, eventSlug TEXT NOT NULL, eventTitle TEXT NOT NULL,
      conditionId TEXT NOT NULL, windowStart INTEGER NOT NULL, windowEnd INTEGER NOT NULL,
      volume REAL, volume24hr REAL, liquidity REAL, lastTradePrice REAL, spread REAL
    );
    CREATE TABLE market_resolutions (
      eventSlug TEXT PRIMARY KEY,
      winnerOutcomeIndex INTEGER NOT NULL, source TEXT NOT NULL, ts INTEGER NOT NULL
    );
  `);
  return { path: p, db };
}

interface FixtureRow {
  ts: number;
  eventSlug: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  bestBid?: number | null;
  bestAsk?: number | null;
}

function insertBook(db: Better.Database, r: FixtureRow): void {
  db.prepare(
    `INSERT INTO book_snapshots (ts, eventSlug, tokenId, outcome, outcomeIndex, bestBid, bestAsk)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.ts, r.eventSlug, r.tokenId, r.outcome, r.outcomeIndex, r.bestBid ?? null, r.bestAsk ?? null);
}

interface TableSummary {
  name: string;
  rowsTotal: number;
  distinctKeys: number;
  alreadyPresent: number;
  newRows: number;
  dedupInFile: number;
  invalid: number;
  examples: string[];
}

describe("snapshot-io", () => {
  it("crée un DDL de staging sans colonne id (paging par rowid)", () => {
    const sql = worker.createTableSql(SNAPSHOT_TABLE_SPECS.market_resolutions);
    assert.match(sql, /CREATE TABLE market_resolutions/);
    assert.doesNotMatch(sql, /id INTEGER/);
  });

  it("détecte les formats sqlite / ndjson / csv", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapio-"));
    const db = new Better(join(dir, "sample.db"));
    db.exec("CREATE TABLE t (a INTEGER)");
    db.close();
    const nd = join(dir, "sample.ndjson");
    writeFileSync(nd, '{"_t":"book_snapshots","ts":1}\n');
    const csv = join(dir, "sample.csv");
    writeFileSync(csv, "ts,eventSlug\n1,x\n");
    assert.equal(worker.detectFormat(join(dir, "sample.db")), "sqlite");
    assert.equal(worker.detectFormat(nd), "ndjson");
    assert.equal(worker.detectFormat(csv), "csv");
  });

  it("valide une ligne (requis, types, outcomeIndex 0/1)", () => {
    const spec = SNAPSHOT_TABLE_SPECS.book_snapshots;
    const okRow = worker.validateRow(spec, { ts: 100, eventSlug: "s", tokenId: "t", outcome: "Up", outcomeIndex: 0, junk: 4 }, "json");
    assert.equal(okRow.error, undefined);
    assert.equal(okRow.row.ts, 100);
    assert.equal(okRow.row.bestBid, null);
    assert.equal(okRow.extra, true); // clé inconnue comptée
    assert.equal(worker.validateRow(spec, { ts: "abc", eventSlug: "s" }, "csv").error, 'ts : entier attendu, reçu "abc"');
    // Le validateur remonte le PREMIER champ requis manquant (ordre du registre).
    assert.match(worker.validateRow(spec, { ts: 1 }, "json").error, /eventSlug requis/);
    assert.match(worker.validateRow(spec, { ts: 1, eventSlug: "s", tokenId: "t", outcome: "Up", outcomeIndex: 7 }, "json").error, /outcomeIndex/);
    // CSV : cellules vides → null
    const csvRow = worker.validateRow(
      spec,
      { ts: "100", eventSlug: "s", tokenId: "t", outcome: "Up", outcomeIndex: "1", bestBid: "" },
      "csv",
    );
    assert.equal(csvRow.row.bestBid, null);
    assert.equal(csvRow.row.outcomeIndex, 1);
  });

  it("analyse un ndjson (doublons fichier/main/invalides) puis merge idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snapio-"));
    const main = makeMainDb(dir);
    const S = 1_800_000_000_000;
    // pré-existant dans main (doublons attendus à l'import)
    insertBook(main.db, { ts: S, eventSlug: "btc-15m-1", tokenId: "tokA", outcome: "Up", outcomeIndex: 0, bestBid: 0.4 });
    insertBook(main.db, { ts: S, eventSlug: "btc-15m-1", tokenId: "tokB", outcome: "Down", outcomeIndex: 1, bestAsk: 0.6 });

    const rows = [
      // dup main (tokA/tokB au ts S) + dup intra-fichier
      { _t: "book_snapshots", ts: S, eventSlug: "btc-15m-1", tokenId: "tokA", outcome: "Up", outcomeIndex: 0, bestBid: 0.4 },
      { _t: "book_snapshots", ts: S, eventSlug: "btc-15m-1", tokenId: "tokA", outcome: "Up", outcomeIndex: 0, bestBid: 0.4 },
      { _t: "book_snapshots", ts: S, eventSlug: "btc-15m-1", tokenId: "tokB", outcome: "Down", outcomeIndex: 1 },
      // nouvelles lignes
      { _t: "book_snapshots", ts: S + 1000, eventSlug: "btc-15m-1", tokenId: "tokA", outcome: "Up", outcomeIndex: 0, bestBid: 0.41 },
      { _t: "book_snapshots", ts: S + 1000, eventSlug: "btc-15m-1", tokenId: "tokB", outcome: "Down", outcomeIndex: 1, bestAsk: 0.61 },
      // invalides
      { _t: "book_snapshots", ts: 0, eventSlug: "x", tokenId: "t", outcome: "Up", outcomeIndex: 0 },
      { _t: "book_snapshots", eventSlug: "x", tokenId: "t", outcome: "Up", outcomeIndex: 0 },
      { evt: "pas de _t" },
    ];
    const upload = join(dir, "in.ndjson");
    writeFileSync(upload, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const summary = await worker.analyzeUpload({
      uploadPath: upload,
      stagePath: join(dir, "stage.db"),
      mainPath: main.path,
      specs: SPECS,
      batchRows: 2,
      progressEvery: 1,
    });
    assert.equal(summary.format, "ndjson");
    const book = summary.tables.find((t: TableSummary) => t.name === "book_snapshots") as TableSummary;
    assert.equal(book.rowsTotal, 5);
    assert.equal(book.distinctKeys, 4);
    assert.equal(book.dedupInFile, 1);
    assert.equal(book.alreadyPresent, 2); // tokA + tokB au ts S
    assert.equal(book.newRows, 2);
    // 2 invalides (ts=0 et ts manquant), 1 orpheline (pas de _t)
    assert.equal(book.invalid, 2);
    assert.equal(book.examples.length, 2);
    assert.equal(summary.orphanLines, 1);
    assert.equal(summary.orphanExamples?.length, 1);
    assert.equal(summary.extras, 0);

    // commit merge → uniquement les nouvelles lignes
    const c1 = worker.commitStaging({
      mainPath: main.path,
      stagePath: join(dir, "stage.db"),
      specs: SPECS,
      policy: "merge",
      batchRows: 2,
    });
    assert.equal(c1.inserted, 2);
    assert.equal(c1.skipped, 2);
    assert.equal(c1.deleted, 0);

    // idempotence : re-commit du même staging → 0 inséré, tout skip
    const c2 = worker.commitStaging({
      mainPath: main.path,
      stagePath: join(dir, "stage.db"),
      specs: SPECS,
      policy: "merge",
      batchRows: 2,
    });
    assert.equal(c2.inserted, 0);
    assert.equal(c2.skipped, 4); // distinctKeys du fichier, tous en base
    assert.equal(one<{ n: number }>(main.db, "SELECT COUNT(*) AS n FROM book_snapshots").n, 4);

    // les ids des nouvelles lignes sont frais (l'id du fichier n'est jamais importé)
    const ids = (main.db.prepare("SELECT id FROM book_snapshots ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
    assert.deepEqual(ids, [1, 2, 3, 4]);
    main.db.close();
  });

  it("replace efface le chevauchement (range × slugs) puis réinsère", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snapio-"));
    const main = makeMainDb(dir);
    const S = 1_900_000_000_000;
    insertBook(main.db, { ts: S, eventSlug: "btc-15m-1", tokenId: "tokA", outcome: "Up", outcomeIndex: 0, bestBid: 0.9 });
    insertBook(main.db, { ts: S - 3600_000, eventSlug: "eth-15m-2", tokenId: "tokZ", outcome: "Up", outcomeIndex: 0, bestBid: 0.1 });
    const upload = join(dir, "in.ndjson");
    writeFileSync(
      upload,
      JSON.stringify({ _t: "book_snapshots", ts: S, eventSlug: "btc-15m-1", tokenId: "tokA", outcome: "Up", outcomeIndex: 0, bestBid: 0.42 }) + "\n",
    );
    await worker.analyzeUpload({ uploadPath: upload, stagePath: join(dir, "stage.db"), mainPath: main.path, specs: SPECS });
    const c = worker.commitStaging({
      mainPath: main.path,
      stagePath: join(dir, "stage.db"),
      specs: SPECS,
      policy: "replace",
      batchRows: 10,
    });
    assert.equal(c.deleted, 1); // la ligne btc-15m-1 remplacée…
    assert.equal(c.inserted, 1);
    assert.equal(one<{ b: number }>(main.db, "SELECT bestBid AS b FROM book_snapshots WHERE ts = ?", S).b, 0.42);
    // …et PAS la ligne eth-15m-2 hors du slug
    assert.equal(one<{ n: number }>(main.db, "SELECT COUNT(*) AS n FROM book_snapshots WHERE eventSlug = 'eth-15m-2'").n, 1);
    main.db.close();
  });

  it("csv : titres avec virgules/guillemets, cellules nullables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snapio-"));
    const main = makeMainDb(dir);
    const csv = [
      `ts,eventSlug,eventTitle,conditionId,windowStart,windowEnd,volume,liquidity`,
      `1800000000000,btc-15m-1,"btc ""up or down"", 3PM",0xabc,1800000000,1800000900,1250.5,4200`,
      `1800000060000,btc-flat,Titre simple,0xdef,1800060000,1800060900,,`,
    ].join("\n");
    const upload = join(dir, "in.csv");
    writeFileSync(upload, csv + "\n");
    const summary = await worker.analyzeUpload({
      uploadPath: upload,
      stagePath: join(dir, "stage.db"),
      mainPath: main.path,
      specs: SPECS,
    });
    const market = summary.tables.find((t: TableSummary) => t.name === "market_snapshots") as TableSummary;
    assert.equal(market.rowsTotal, 2);
    assert.equal(market.alreadyPresent, 0);
    const c = worker.commitStaging({
      mainPath: main.path,
      stagePath: join(dir, "stage.db"),
      specs: SPECS,
      policy: "merge",
      batchRows: 10,
    });
    assert.equal(c.inserted, 2);
    const row = one<{ eventTitle: string; volume: number }>(
      main.db,
      "SELECT eventTitle, volume FROM market_snapshots WHERE ts = 1800000000000",
    );
    assert.equal(row.eventTitle, 'btc "up or down", 3PM');
    assert.equal(row.volume, 1250.5);
    main.db.close();
  });

  it("export sqlite (filtre slug) puis réimport du fichier → tout nouveau", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snapio-"));
    const main = makeMainDb(dir);
    const S = 2_000_000_000_000;
    insertBook(main.db, { ts: S, eventSlug: "btc-15m-1", tokenId: "tokA", outcome: "Up", outcomeIndex: 0, bestBid: 0.3 });
    insertBook(main.db, { ts: S, eventSlug: "btc-15m-1", tokenId: "tokB", outcome: "Down", outcomeIndex: 1, bestBid: 0.7 });
    insertBook(main.db, { ts: S + 60_000, eventSlug: "eth-15m-2", tokenId: "tokE", outcome: "Up", outcomeIndex: 0, bestBid: 0.5 });
    main.db
      .prepare("INSERT INTO market_resolutions (eventSlug, winnerOutcomeIndex, source, ts) VALUES ('btc-15m-1', 0, 'test', ?)")
      .run(S + 900_000);

    const outPath = join(dir, "export.db");
    const exp = worker.exportSqlite({
      mainPath: main.path,
      outPath,
      table: "book_snapshots",
      slug: "btc-15m-1",
      fromTs: null,
      toTs: null,
      includeResolutions: true,
      specs: SPECS,
    });
    assert.deepEqual(exp.rows, { book_snapshots: 2, market_resolutions: 1 });
    const ex = new Better(outPath, { readonly: true });
    const exDb = ex as unknown as Better.Database;
    assert.equal(one<{ n: number }>(exDb, "SELECT COUNT(*) AS n FROM book_snapshots WHERE eventSlug='eth-15m-2'").n, 0);
    assert.equal(one<{ w: number }>(exDb, "SELECT winnerOutcomeIndex AS w FROM market_resolutions").w, 0);
    ex.close();

    // réimport dans une base NEUVE : tout est nouveau
    const fresh = makeMainDb(dir, "fresh.db");
    const summary = await worker.analyzeUpload({
      uploadPath: outPath,
      stagePath: join(dir, "unused-stage.db"),
      mainPath: fresh.path,
      specs: SPECS,
    });
    assert.equal(summary.format, "sqlite");
    const book = summary.tables.find((t: TableSummary) => t.name === "book_snapshots") as TableSummary;
    assert.equal(book.newRows, 2);
    assert.equal(book.alreadyPresent, 0);
    const c = worker.commitStaging({
      mainPath: fresh.path,
      stagePath: outPath,
      specs: SPECS,
      policy: "merge",
      batchRows: 10,
    });
    // inserted s'accumule sur les tables du staging : 2 book + 1 résolution.
    assert.equal(c.inserted, 3);
    assert.equal(c.perTable.book_snapshots.inserted, 2);
    main.db.close();
    fresh.db.close();
  });

  it("options : marchés + volumes par slug", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapio-"));
    const main = makeMainDb(dir);
    const S = 2_100_000_000_000;
    insertBook(main.db, { ts: S, eventSlug: "btc-15m-1", tokenId: "tokA", outcome: "Up", outcomeIndex: 0 });
    insertBook(main.db, { ts: S + 500, eventSlug: "btc-15m-1", tokenId: "tokB", outcome: "Down", outcomeIndex: 1 });
    main.db
      .prepare("INSERT INTO market_snapshots (ts, eventSlug, eventTitle, conditionId, windowStart, windowEnd) VALUES (?, ?, ?, ?, ?, ?)")
      .run(S, "btc-15m-1", "BTC Up/Down", "0x1", S / 1000, S / 1000 + 900);
    const bookOpts = worker.snapshotOptions({ mainPath: main.path, table: "book_snapshots" });
    assert.deepEqual(bookOpts, [{ eventSlug: "btc-15m-1", rowCount: 2, firstTs: S, lastTs: S + 500 }]);
    const marketOpts = worker.snapshotOptions({ mainPath: main.path, table: "market_snapshots" });
    assert.equal(marketOpts[0].title, "BTC Up/Down");
    assert.equal(marketOpts[0].rowCount, 1);
    main.db.close();
  });

  it("replace : les slugs absents du fichier mais présents dans main (même plage) survivent", async () => {
    // Régression A-DELETE-SCOPE : la sous-requête de deleteScopeSql doit viser
    // le STAGING (stageread) et non main — un `FROM <table>` non qualifié
    // résout vers main et effaçait les lignes des AUTRES marchés sur la plage.
    const dir = mkdtempSync(join(tmpdir(), "snapio-"));
    const main = makeMainDb(dir);
    const S = 2_200_000_000_000;
    insertBook(main.db, { ts: S, eventSlug: "btc-15m-1", tokenId: "tokA", outcome: "Up", outcomeIndex: 0, bestBid: 0.4 });
    insertBook(main.db, { ts: S, eventSlug: "eth-15m-2", tokenId: "tokZ", outcome: "Up", outcomeIndex: 0, bestBid: 0.5 });
    const upload = join(dir, "in.ndjson");
    writeFileSync(
      upload,
      JSON.stringify({ _t: "book_snapshots", ts: S, eventSlug: "btc-15m-1", tokenId: "tokA", outcome: "Up", outcomeIndex: 0, bestBid: 0.42 }) + "\n",
      // le fichier n'expédie QUE btc-15m-1 — ts identiques pour les 2 slugs de main
    );
    await worker.analyzeUpload({ uploadPath: upload, stagePath: join(dir, "stage.db"), mainPath: main.path, specs: SPECS });
    const c = worker.commitStaging({ mainPath: main.path, stagePath: join(dir, "stage.db"), specs: SPECS, policy: "replace", batchRows: 10 });
    assert.equal(c.deleted, 1); // la seule ligne btc-15m-1 remplacée
    assert.equal(one<{ n: number }>(main.db, "SELECT COUNT(*) AS n FROM book_snapshots WHERE eventSlug='eth-15m-2'").n, 1);
    assert.equal(one<{ n: number }>(main.db, "SELECT COUNT(*) AS n FROM book_snapshots").n, 2);
    main.db.close();
  });

  it("replace market_resolutions : n'efface que les eventSlug du fichier", async () => {
    // deleteScopeSql scope « key » : le DELETE doit limiter aux eventSlug du
    // STAGING — non qualifié, il effaçait TOUTES les résolutions de main.
    const dir = mkdtempSync(join(tmpdir(), "snapio-"));
    const main = makeMainDb(dir);
    const S = 2_300_000_000_000;
    main.db
      .prepare("INSERT INTO market_resolutions (eventSlug, winnerOutcomeIndex, source, ts) VALUES ('btc-15m-1', 0, 'test', ?)")
      .run(S);
    main.db
      .prepare("INSERT INTO market_resolutions (eventSlug, winnerOutcomeIndex, source, ts) VALUES ('eth-15m-2', 1, 'test', ?)")
      .run(S);
    const upload = join(dir, "in.ndjson");
    writeFileSync(
      upload,
      JSON.stringify({ _t: "market_resolutions", eventSlug: "btc-15m-1", winnerOutcomeIndex: 1, source: "replay", ts: S }) + "\n",
    );
    await worker.analyzeUpload({ uploadPath: upload, stagePath: join(dir, "stage.db"), mainPath: main.path, specs: SPECS });
    const c = worker.commitStaging({ mainPath: main.path, stagePath: join(dir, "stage.db"), specs: SPECS, policy: "replace", batchRows: 10 });
    assert.equal(c.deleted, 1); // btc-15m-1 seulement — eth-15m-2 doit survivre
    assert.equal(one<{ n: number }>(main.db, "SELECT COUNT(*) AS n FROM market_resolutions WHERE eventSlug='eth-15m-2'").n, 1);
    assert.equal(one<{ w: number }>(main.db, "SELECT winnerOutcomeIndex AS w FROM market_resolutions WHERE eventSlug='btc-15m-1'").w, 1);
    main.db.close();
  });

  it("flux service : upload → analyze → commit retrouve le fichier (uploadPath stocké dans le job)", async () => {
    // Régression R1-RÉEL : beginImportUpload doit enregistrer uploadPath dans
    // le job — sinon analyzeCurrentUpload envoie null au worker
    // (« The "path" argument … Received null ») et l'import est mort de bout en bout.
    const dir = mkdtempSync(join(tmpdir(), "snapio-"));
    const main = makeMainDb(dir, "svc-main.db");
    const S = 1_700_000_000_000;
    const handle = beginImportUpload(main.path, 1024 ** 3);
    const line = { _t: "book_snapshots", ts: S, eventSlug: "svc-1", tokenId: "tokS", outcome: "Up", outcomeIndex: 0, bestBid: 0.5 };
    writeFileSync(handle.uploadPath, JSON.stringify(line) + "\n");
    finishUpload(120);
    try {
      const summary = await analyzeCurrentUpload(handle.uploadId);
      assert.equal(summary.format, "ndjson");
      const book = summary.tables.find((t: TableSummary) => t.name === "book_snapshots") as TableSummary;
      assert.equal(book.rowsTotal, 1);
      const res = await commitCurrentUpload(handle.uploadId, "merge");
      assert.equal(res.inserted, 1);
      assert.equal(one<{ n: number }>(main.db, "SELECT COUNT(*) AS n FROM book_snapshots").n, 1);
    } finally {
      cancelCurrentImport();
      main.db.close();
    }
  });
});