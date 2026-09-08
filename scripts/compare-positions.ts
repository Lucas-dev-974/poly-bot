/**
 * Récupère les positions Polymarket (data-api) et les compare avec les
 * positions enregistrées localement (SQLite bot-live.db).
 *
 * IMPORTANT : plusieurs rangées locales peuvent partager la même clé
 * (slug, outcomeIndex) — cheap + expensive même outcome, ou retries.
 * On somme donc les tailles locales avant de comparer avec Polymarket
 * (qui agrège tout en une seule position par conditionId:outcomeIndex).
 *
 * Usage: npx tsx scripts/compare-positions.ts
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";

const FETCH_TIMEOUT_MS = 10_000;
const ACTIVE_PAGE_SIZE = 500;
const ACTIVE_MAX_OFFSET = 10_000;
const CLOSED_PAGE_SIZE = 50;
const CLOSED_MAX_PAGES = 200;

interface ApiPosition {
  conditionId: string;
  outcomeIndex: number;
  outcome: string;
  slug: string;
  title: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  closed: boolean;
  endDate: string;
  redeemable: boolean;
}

interface LocalRow {
  id: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  kind: string;
  fillPrice: number;
  size: number;
  cost: number;
  status: string;
  windowEnd: number;
  createdAt: number;
}

interface LocalAggregate {
  pos: LocalRow;
  totalSize: number;
  totalCost: number;
  count: number;
  statuses: Set<string>;
}

async function fetchJson(url: URL): Promise<Array<Record<string, unknown>>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      console.error(`  [warn] HTTP ${response.status} pour ${url.pathname}`);
      return [];
    }
    const payload: unknown = await response.json();
    return Array.isArray(payload)
      ? (payload as Array<Record<string, unknown>>)
      : [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchActivePositions(
  funder: string,
  host: string,
): Promise<ApiPosition[]> {
  const positions: ApiPosition[] = [];
  for (let offset = 0; offset <= ACTIVE_MAX_OFFSET; offset += ACTIVE_PAGE_SIZE) {
    const url = new URL("/positions", host);
    url.searchParams.set("user", funder);
    url.searchParams.set("limit", String(ACTIVE_PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sizeThreshold", "0");
    url.searchParams.set("includeArchived", "true");
    const raw = await fetchJson(url);
    positions.push(
      ...raw.map((p) => ({
        conditionId: String(p.conditionId ?? ""),
        outcomeIndex: Number(p.outcomeIndex ?? 0),
        outcome: String(p.outcome ?? ""),
        slug: String(p.slug ?? p.eventSlug ?? ""),
        title: String(p.title ?? ""),
        size: Number(p.size ?? 0),
        avgPrice: Number(p.avgPrice ?? 0),
        currentValue: Number(p.currentValue ?? 0),
        cashPnl: Number(p.cashPnl ?? 0),
        closed: false,
        endDate: String(p.endDate ?? ""),
        redeemable: Boolean(p.redeemable ?? false),
      })),
    );
    if (raw.length < ACTIVE_PAGE_SIZE) break;
  }
  return positions;
}

async function fetchClosedPositions(
  funder: string,
  host: string,
): Promise<ApiPosition[]> {
  const positions: ApiPosition[] = [];
  for (let page = 0; page < CLOSED_MAX_PAGES; page++) {
    const url = new URL("/closed-positions", host);
    url.searchParams.set("user", funder);
    url.searchParams.set("limit", String(CLOSED_PAGE_SIZE));
    url.searchParams.set("offset", String(page * CLOSED_PAGE_SIZE));
    url.searchParams.set("sortBy", "TIMESTAMP");
    url.searchParams.set("sortDirection", "DESC");
    const raw = await fetchJson(url);
    positions.push(
      ...raw.map((p) => ({
        conditionId: String(p.conditionId ?? ""),
        outcomeIndex: Number(p.outcomeIndex ?? 0),
        outcome: String(p.outcome ?? ""),
        slug: String(p.eventSlug || p.slug || ""),
        title: String(p.title ?? ""),
        size: Number(p.totalBought ?? p.size ?? 0),
        avgPrice: Number(p.avgPrice ?? 0),
        currentValue: 0,
        cashPnl: Number(p.realizedPnl ?? p.cashPnl ?? 0),
        closed: true,
        endDate: String(p.endDate ?? ""),
        redeemable: false,
      })),
    );
    if (raw.length < CLOSED_PAGE_SIZE) break;
  }
  return positions;
}

function loadLocalRows(dbPath: string): LocalRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT id, eventSlug, outcome, outcomeIndex, kind, fillPrice, size,
                cost, status, windowEnd, createdAt
         FROM positions ORDER BY createdAt ASC`,
      )
      .all() as LocalRow[];
  } finally {
    db.close();
  }
}

/** Clé de correspondance : slug + outcomeIndex. */
function key(slug: string, outcomeIndex: number): string {
  return `${slug}:${outcomeIndex}`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const funder = config.funderAddress;
  if (!funder) {
    console.error("FUNDER_ADDRESS manquant dans .env");
    process.exit(1);
  }

  console.log("=== Récupération des positions Polymarket ===");
  console.log(`Funder: ${funder}`);
  console.log(`Data API: ${config.dataApiHost}`);
  console.log(`DB locale: ${config.dbPath}\n`);

  const [active, closed] = await Promise.all([
    fetchActivePositions(funder, config.dataApiHost),
    fetchClosedPositions(funder, config.dataApiHost),
  ]);

  const activeKeys = new Set(active.map((p) => key(p.slug, p.outcomeIndex)));
  const uniqueClosed = closed.filter(
    (p) => !activeKeys.has(key(p.slug, p.outcomeIndex)),
  );
  const apiPositions = [...active, ...uniqueClosed];

  console.log(`Positions actives (Polymarket): ${active.length}`);
  console.log(`Positions fermées (Polymarket): ${closed.length}`);
  console.log(`Total positions Polymarket: ${apiPositions.length}\n`);

  const localRows = loadLocalRows(config.dbPath);
  console.log(`Positions locales (SQLite, rangées): ${localRows.length}`);

  // Agrégation locale par (slug, outcomeIndex)
  const localByKey = new Map<string, LocalAggregate>();
  for (const r of localRows) {
    const k = key(r.eventSlug, r.outcomeIndex);
    const existing = localByKey.get(k);
    if (existing) {
      existing.totalSize += r.size;
      existing.totalCost += r.cost;
      existing.count++;
      existing.statuses.add(r.status);
    } else {
      localByKey.set(k, {
        pos: r,
        totalSize: r.size,
        totalCost: r.cost,
        count: 1,
        statuses: new Set([r.status]),
      });
    }
  }
  console.log(`Positions locales (clés uniques): ${localByKey.size}\n`);

  // --- Comparaison ---
  const apiByKey = new Map<string, ApiPosition>();
  for (const p of apiPositions) {
    const k = key(p.slug, p.outcomeIndex);
    if (!apiByKey.has(k)) apiByKey.set(k, p);
  }

  const onlyApi: ApiPosition[] = [];
  const onlyLocal: LocalAggregate[] = [];
  const matched: Array<{ api: ApiPosition; local: LocalAggregate }> = [];

  for (const [k, api] of apiByKey) {
    if (localByKey.has(k)) {
      matched.push({ api, local: localByKey.get(k)! });
    } else {
      onlyApi.push(api);
    }
  }
  for (const [k, localAgg] of localByKey) {
    if (!apiByKey.has(k)) onlyLocal.push(localAgg);
  }

  console.log("=== RÉSULTAT DE LA COMPARAISON ===");
  console.log(`Correspondances (présentes des deux côtés): ${matched.length}`);
  console.log(`Uniquement sur Polymarket (pas en local): ${onlyApi.length}`);
  console.log(`Uniquement en local (pas sur Polymarket): ${onlyLocal.length}\n`);

  // --- Détail des positions uniquement sur Polymarket ---
  if (onlyApi.length > 0) {
    console.log("--- Positions sur Polymarket ABSENTES en local ---");
    for (const p of onlyApi) {
      const tag = p.closed ? "fermée" : "active";
      console.log(
        `  [${tag}] ${p.slug || p.title} | ${p.outcome} | size=${p.size} ` +
          `avg=${p.avgPrice.toFixed(3)} | value=${fmtUsd(p.currentValue)} ` +
          `pnl=${fmtUsd(p.cashPnl)}${p.redeemable ? " | REDEEMABLE" : ""}`,
      );
    }
    console.log("");
  }

  // --- Détail des positions uniquement en local ---
  if (onlyLocal.length > 0) {
    console.log("--- Positions en local ABSENTES de Polymarket ---");
    for (const a of onlyLocal) {
      console.log(
        `  [${[...a.statuses].join(",")}] ${a.pos.eventSlug} | ${a.pos.outcome} ` +
          `| kind=${a.pos.kind} | totalSize=${a.totalSize.toFixed(2)} (${a.count} rangées)`,
      );
    }
    console.log("");
  }

  // --- Incohérences de statut sur les correspondances ---
  const statusMismatch: Array<{ api: ApiPosition; local: LocalAggregate }> = [];
  for (const m of matched) {
    const apiOpen = !m.api.closed;
    // Local est "open" si toutes les rangées sont open, sinon on prend le
    // statut majoritaire. En pratique, pour le bot, une position résolue
    // est won ou lost ; on considère local "open" si au moins une rangée
    // est open.
    const localHasOpen = m.local.statuses.has("open");
    if (apiOpen !== localHasOpen) statusMismatch.push(m);
  }

  if (statusMismatch.length > 0) {
    console.log(`--- Incohérences de statut (${statusMismatch.length}) ---`);
    for (const m of statusMismatch) {
      const apiState = m.api.closed ? "fermée" : "active";
      console.log(
        `  ${m.api.slug || m.local.pos.eventSlug} | ${m.api.outcome} | ` +
          `Polymarket=${apiState} vs Local=${[...m.local.statuses].join("/")}`,
      );
    }
    console.log("");
  }

  // --- Incohérences de taille (somme locale vs taille API) ---
  const sizeMismatch: Array<{ api: ApiPosition; local: LocalAggregate; diff: number }> = [];
  for (const m of matched) {
    const diff = m.api.size - m.local.totalSize;
    if (Math.abs(diff) > 0.01) {
      sizeMismatch.push({ ...m, diff });
    }
  }

  if (sizeMismatch.length > 0) {
    console.log(`--- Incohérences de taille (${sizeMismatch.length}) ---`);
    sizeMismatch.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    for (const m of sizeMismatch) {
      const sign = m.diff > 0 ? "+" : "";
      console.log(
        `  ${m.api.slug || m.local.pos.eventSlug} | ${m.api.outcome} | ` +
          `Polymarket=${m.api.size.toFixed(2)} vs Local=${m.local.totalSize.toFixed(2)} ` +
          `(${m.local.count} rangées) | écart=${sign}${m.diff.toFixed(2)}`,
      );
    }
    console.log("");
  }

  // --- Synthèse ---
  const apiOpenCount = active.length;
  const apiRedeemable = apiPositions.filter((p) => p.redeemable).length;
  const localOpenCount = [...localByKey.values()].filter((a) => a.statuses.has("open")).length;
  const localWon = [...localByKey.values()].filter((a) => a.statuses.has("won") && !a.statuses.has("open")).length;
  const localLost = [...localByKey.values()].filter((a) => a.statuses.has("lost") && !a.statuses.has("open")).length;

  console.log("=== SYNTHÈSE ===");
  console.log(`Polymarket — positions actives: ${apiOpenCount}`);
  console.log(`Polymarket — positions redeemable: ${apiRedeemable}`);
  console.log(`Local — clés open: ${localOpenCount}`);
  console.log(`Local — clés won: ${localWon}`);
  console.log(`Local — clés lost: ${localLost}`);
  console.log(`Local — clés total: ${localByKey.size}`);
  console.log(`Local — rangées total: ${localRows.length}`);
}

main().catch((error) => {
  console.error("Erreur:", error);
  process.exit(1);
});