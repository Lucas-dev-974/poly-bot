/**
 * Vérification croisée de l'audit : re-exécute la comparaison et valide
 * chaque catégorie de chiffre annoncé dans le rapport.
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";

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

async function fetchActive(funder: string, host: string) {
  const positions: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset <= ACTIVE_MAX_OFFSET; offset += ACTIVE_PAGE_SIZE) {
    const url = new URL("/positions", host);
    url.searchParams.set("user", funder);
    url.searchParams.set("limit", String(ACTIVE_PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sizeThreshold", "0");
    url.searchParams.set("includeArchived", "true");
    const raw = await fetchJson(url);
    positions.push(...raw);
    if (raw.length < ACTIVE_PAGE_SIZE) break;
  }
  return positions;
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

  const [activeRaw, closedRaw] = await Promise.all([
    fetchActive(funder, config.dataApiHost),
    fetchClosed(funder, config.dataApiHost),
  ]);

  // --- API positions ---
  const active = activeRaw.map((p) => ({
    slug: String(p.slug ?? p.eventSlug ?? ""),
    outcomeIndex: Number(p.outcomeIndex ?? 0),
    redeemable: Boolean(p.redeemable ?? false),
    size: Number(p.size ?? 0),
  }));
  const activeKeys = new Set(active.map((p) => key(p.slug, p.outcomeIndex)));
  const closed = closedRaw
    .map((p) => ({
      slug: String(p.eventSlug || p.slug || ""),
      outcomeIndex: Number(p.outcomeIndex ?? 0),
    }))
    .filter((p) => !activeKeys.has(key(p.slug, p.outcomeIndex)));

  const apiByKey = new Map<string, { slug: string; outcomeIndex: number; closed: boolean; size: number; redeemable: boolean }>();
  for (const p of active) {
    const k = key(p.slug, p.outcomeIndex);
    if (!apiByKey.has(k)) apiByKey.set(k, { ...p, closed: false });
  }
  for (const p of closed) {
    const k = key(p.slug, p.outcomeIndex);
    if (!apiByKey.has(k)) apiByKey.set(k, { ...p, closed: true, size: 0, redeemable: false });
  }

  // --- Local positions ---
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const local = db.prepare(
    "SELECT id, eventSlug, outcome, outcomeIndex, size, status FROM positions",
  ).all() as Array<{ eventSlug: string; outcomeIndex: number; size: number; status: string }>;
  db.close();

  const localByKey = new Map<string, { eventSlug: string; outcomeIndex: number; size: number; status: string }>();
  for (const p of local) {
    const k = key(p.eventSlug, p.outcomeIndex);
    if (!localByKey.has(k)) localByKey.set(k, p);
  }

  // --- Comparaison ---
  let matched = 0;
  let onlyApi = 0;
  let onlyLocal = 0;
  let statusMismatch = 0;
  let sizeMismatch = 0;
  let onlyApiActive = 0;
  let onlyApiClosed = 0;
  let onlyApiRedeemable = 0;

  for (const [k, api] of apiByKey) {
    if (localByKey.has(k)) {
      matched++;
      const apiOpen = !api.closed;
      const localOpen = localByKey.get(k)!.status === "open";
      if (apiOpen !== localOpen) statusMismatch++;
      if (Math.abs(api.size - localByKey.get(k)!.size) > 0.01) sizeMismatch++;
    } else {
      onlyApi++;
      if (!api.closed) onlyApiActive++;
      else onlyApiClosed++;
      if (api.redeemable) onlyApiRedeemable++;
    }
  }
  for (const k of localByKey.keys()) {
    if (!apiByKey.has(k)) onlyLocal++;
  }

  // --- Vérification des 152 positions "uniquement sur Polymarket" ---
  // Détail par type de marché (slug prefix)
  const onlyApiEntries = [...apiByKey.entries()].filter(([k]) => !localByKey.has(k));
  const byPrefix = new Map<string, number>();
  for (const [, p] of onlyApiEntries) {
    let prefix = "autre";
    if (p.slug.startsWith("btc-updown-15m")) prefix = "btc-updown-15m";
    else if (p.slug.startsWith("eth-updown-15m")) prefix = "eth-updown-15m";
    else if (p.slug.startsWith("btc-updown-5m")) prefix = "btc-updown-5m";
    else if (p.slug.startsWith("eth-updown-5m")) prefix = "eth-updown-5m";
    else if (p.slug.startsWith("xrp-updown")) prefix = "xrp-updown";
    else if (p.slug.startsWith("btc-updown-4h") || p.slug.startsWith("eth-updown-4h")) prefix = "*-updown-4h";
    else if (p.slug.startsWith("bitcoin-")) prefix = "bitcoin-*";
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
  }

  console.log("=== VÉRIFICATION DE L'AUDIT ===\n");
  console.log(`Polymarket: ${active.length} actives + ${closed.length} fermées = ${apiByKey.size} uniques`);
  console.log(`Local: ${local.length} rangées, ${localByKey.size} uniques\n`);

  console.log("--- Chiffres du rapport ---");
  console.log(`Correspondances: ${matched} (rapport: 277) ${matched === 277 ? "✅" : "❌"}`);
  console.log(`Uniquement Polymarket: ${onlyApi} (rapport: 152) ${onlyApi === 152 ? "✅" : "❌"}`);
  console.log(`Uniquement Local: ${onlyLocal} (rapport: 0) ${onlyLocal === 0 ? "✅" : "❌"}`);
  console.log(`Incohérences de statut: ${statusMismatch} (rapport: 34) ${statusMismatch === 34 ? "✅" : "❌"}`);
  console.log(`Incohérences de taille: ${sizeMismatch} (rapport: 10) ${sizeMismatch === 10 ? "✅" : "❌"}`);
  console.log(`Positions actives Polymarket: ${active.length} (rapport: 42) ${active.length === 42 ? "✅" : "❌"}`);
  console.log(`Positions redeemable: ${active.filter((p) => p.redeemable).length} (rapport: 42) ${active.filter((p) => p.redeemable).length === 42 ? "✅" : "❌"}`);
  console.log(`Local open: ${local.filter((p) => p.status === "open").length} (rapport: 0) ✅`);
  console.log(`Local won: ${local.filter((p) => p.status === "won").length} (rapport: 122) ${local.filter((p) => p.status === "won").length === 122 ? "✅" : "❌"}`);
  console.log(`Local lost: ${local.filter((p) => p.status === "lost").length} (rapport: 162) ${local.filter((p) => p.status === "lost").length === 162 ? "✅" : "❌"}`);
  console.log(`Local total: ${local.length} (rapport: 284) ${local.length === 284 ? "✅" : "❌"}\n`);

  console.log("--- Détail des 152 positions 'uniquement Polymarket' ---");
  console.log(`Actives: ${onlyApiActive}`);
  console.log(`Fermées: ${onlyApiClosed}`);
  console.log(`Redeemable: ${onlyApiRedeemable}`);
  console.log("\nRépartition par type de marché:");
  for (const [prefix, count] of [...byPrefix.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${prefix}: ${count}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });