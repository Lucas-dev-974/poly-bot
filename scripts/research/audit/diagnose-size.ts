/**
 * Diagnostic des incohérences de taille : pourquoi 249 au lieu de 10 ?
 * Affiche un échantillon détaillé des écarts de taille.
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../../../src/config.js";

const FETCH_TIMEOUT_MS = 10_000;
const ACTIVE_PAGE_SIZE = 500;
const ACTIVE_MAX_OFFSET = 10_000;
const CLOSED_PAGE_SIZE = 50;
const CLOSED_MAX_PAGES = 200;

function key(slug: string, outcomeIndex: number): string {
  return `${slug}:${outcomeIndex}`;
}

async function fetchJson(url: URL): Promise<Array<Record<string, unknown>>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    return Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchClosed(funder: string, host: string) {
  const positions: Array<Record<string, unknown>> = [];
  for (let page = 0; page < CLOSED_MAX_PAGES; page++) {
    const url = new URL("/closed-positions", host);
    url.searchParams.set("user", funder);
    url.searchParams.set("limit", String(CLOSED_PAGE_SIZE));
    url.searchParams.set("offset", String(page * CLOSED_PAGE_SIZE));
    url.searchParams.set("sortBy", "TIMESTAMP");
    url.searchParams.set("sortDirection", "DESC");
    const raw = await fetchJson(url);
    positions.push(...raw);
    if (raw.length < CLOSED_PAGE_SIZE) break;
  }
  return positions;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const funder = config.funderAddress!;

  // API closed positions: taille = totalBought (cumulé)
  const closedRaw = await fetchClosed(funder, config.dataApiHost);
  const closedByKey = new Map<string, { slug: string; outcomeIndex: number; apiSize: number; apiAvg: number }>();
  for (const p of closedRaw) {
    const slug = String(p.eventSlug || p.slug || "");
    const outcomeIndex = Number(p.outcomeIndex ?? 0);
    const k = key(slug, outcomeIndex);
    const apiSize = Number(p.totalBought ?? p.size ?? 0);
    const apiAvg = Number(p.avgPrice ?? 0);
    // Si on a déjà la clé, on additionne (plusieurs jambes)
    const existing = closedByKey.get(k);
    if (existing) {
      existing.apiSize += apiSize;
    } else {
      closedByKey.set(k, { slug, outcomeIndex, apiSize, apiAvg });
    }
  }

  // API active positions: taille = size
  const activeByKey = new Map<string, { slug: string; outcomeIndex: number; apiSize: number }>();
  for (let offset = 0; offset <= ACTIVE_MAX_OFFSET; offset += ACTIVE_PAGE_SIZE) {
    const activeUrl = new URL("/positions", config.dataApiHost);
    activeUrl.searchParams.set("user", funder);
    activeUrl.searchParams.set("limit", String(ACTIVE_PAGE_SIZE));
    activeUrl.searchParams.set("offset", String(offset));
    activeUrl.searchParams.set("sizeThreshold", "0");
    activeUrl.searchParams.set("includeArchived", "true");
    const activeRaw = await fetchJson(activeUrl);
    for (const p of activeRaw) {
      const slug = String(p.slug ?? p.eventSlug ?? "");
      const outcomeIndex = Number(p.outcomeIndex ?? 0);
      const k = key(slug, outcomeIndex);
      const apiSize = Number(p.size ?? 0);
      activeByKey.set(k, { slug, outcomeIndex, apiSize });
    }
    if (activeRaw.length < ACTIVE_PAGE_SIZE) break;
  }

  // DB local : on peut avoir PLUSIEURS rangées par (slug, outcomeIndex)
  // car cheap + expensive peuvent partager le même outcomeIndex si
  // le bot a fait plusieurs tentatives.
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const localRows = db.prepare(
    "SELECT eventSlug, outcomeIndex, outcome, kind, size, status, fillPrice FROM positions ORDER BY eventSlug, outcomeIndex, kind",
  ).all() as Array<{ eventSlug: string; outcomeIndex: number; outcome: string; kind: string; size: number; status: string; fillPrice: number }>;

  // Grouper par clé et compter + sommer
  const localByKey = new Map<string, { slug: string; outcomeIndex: number; totalSize: number; count: number; rows: Array<{ kind: string; size: number; status: string; fillPrice: number }> }>();
  for (const r of localRows) {
    const k = key(r.eventSlug, r.outcomeIndex);
    const existing = localByKey.get(k);
    if (existing) {
      existing.totalSize += r.size;
      existing.count++;
      existing.rows.push({ kind: r.kind, size: r.size, status: r.status, fillPrice: r.fillprice });
    } else {
      localByKey.set(k, { slug: r.eventSlug, outcomeIndex: r.outcomeIndex, totalSize: r.size, count: 1, rows: [{ kind: r.kind, size: r.size, status: r.status, fillPrice: r.fillPrice }] });
    }
  }

  // Comparaison : la taille API (closed = totalBought cumulé, active = size)
  // vs la SOMME des tailles locales par clé.
  let count = 0;
  let multiRow = 0;
  const samples: Array<{ slug: string; outcomeIndex: number; apiSize: number; localSize: number; localCount: number; rows: Array<{ kind: string; size: number; status: string }> }> = [];

  for (const [k, local] of localByKey) {
    const api = activeByKey.get(k) ?? closedByKey.get(k);
    if (!api) continue;
    count++;
    if (local.count > 1) multiRow++;
    if (Math.abs(api.apiSize - local.totalSize) > 0.01) {
      samples.push({
        slug: local.slug,
        outcomeIndex: local.outcomeIndex,
        apiSize: api.apiSize,
        localSize: local.totalSize,
        localCount: local.count,
        rows: local.rows.map((r) => ({ kind: r.kind, size: r.size, status: r.status })),
      });
    }
  }

  console.log(`=== Diagnostic des incohérences de taille ===\n`);
  console.log(`Clés locales avec match API: ${count}`);
  console.log(`Clés locales avec PLUSIEURS rangées: ${multiRow}\n`);
  console.log(`Écarts de taille détectés: ${samples.length}\n`);

  // Trier par écart décroissant
  samples.sort((a, b) => Math.abs(b.apiSize - b.localSize) - Math.abs(a.apiSize - a.localSize));

  console.log("--- Top 30 écarts (API vs somme locale) ---");
  for (const s of samples.slice(0, 30)) {
    const rowsInfo = s.rows.map((r) => `${r.kind}:${r.size.toFixed(2)}[${r.status}]`).join(" + ");
    console.log(
      `  ${s.slug} | idx=${s.outcomeIndex} | API=${s.apiSize.toFixed(2)} vs Local=${s.localSize.toFixed(2)} (${s.localCount} rangées: ${rowsInfo})`,
    );
  }

  // Vérifier : est-ce que les clés multi-rangées expliquent les écarts ?
  const multiRowWithGap = samples.filter((s) => s.localCount > 1).length;
  const singleRowWithGap = samples.filter((s) => s.localCount === 1).length;
  console.log(`\n--- Analyse ---`);
  console.log(`Écarts sur clés multi-rangées (cheap+expensive même outcome): ${multiRowWithGap}`);
  console.log(`Écarts sur clés single-rangée: ${singleRowWithGap}`);

  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });