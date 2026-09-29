/**
 * Phase 0 / Task 0.1 — Confirmation de la source de résolution (A1/A2).
 * Le plan la note déjà CONFIRMÉE (2026-09-25) : "The resolution source for
 * this market is information from Chainlink, specifically the BTC/USD TWAP
 * data stream available at https://data.chain.link/streams/btc-usd-twap-60s-streams".
 * Ce script automatise la capture des citations exactes pour finaliser
 * audits/chainlink-lag/SOURCE.md (descriptions Gamma d'events live/clos).
 *
 * Pour chaque préfixe suivi : retrouver le slug de la fenêtre courante
 * (arrondi 15 min) et les 3 précédentes, fetch /events?slug=..., extraire
 * la description + détecter Chainlink / stream (twap-60s ou simple).
 *
 *   npx tsx scripts/research/chainlink-lag/00-gamma-source.mts
 *   Env: GAMMA_API_HOST (défaut https://gamma-api.polymarket.com), BACK=3
 */
import { mkdirSync, writeFileSync } from "node:fs";

const HOST = process.env.GAMMA_API_HOST ?? "https://gamma-api.polymarket.com";
const BACK = Number(process.env.BACK ?? 3);
const WINDOW_SEC = 900;
const OUT_DIR = "audits/chainlink-lag";

const PREFIXES = [
  "btc-updown-15m",
  "eth-updown-15m",
  "sol-updown-15m",
  "xrp-updown-15m",
  "doge-updown-15m",
  "hype-updown-15m",
  "bnb-updown-15m",
  "zec-updown-15m",
];

interface GammaMarket {
  question?: string;
  description?: string;
  closed?: boolean;
  outcomePrices?: string;
  outcomes?: string;
}

interface Found {
  prefix: string;
  slug: string;
  closed: boolean;
  question: string;
  description: string;
  chainlink: boolean;
  twap60: boolean;
  streamUrl: string | null;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchEvent(slug: string): Promise<GammaMarket | null> {
  const url = new URL("/events", HOST);
  url.searchParams.set("slug", slug);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const events = (await res.json()) as Array<{ markets?: GammaMarket[] }>;
    return events[0]?.markets?.[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
  const found: Found[] = [];
  const lines: string[] = [];

  for (const prefix of PREFIXES) {
    let hit: { slug: string; m: GammaMarket } | null = null;
    // fenêtre courante + BACK fenêtres précédentes (les events clos gardent
    // leur description — mieux : la description ne change pas à la clôture).
    for (let i = 0; i <= BACK && !hit; i++) {
      const startSec = currentWindow - i * WINDOW_SEC;
      const slug = `${prefix}-${startSec}`;
      const m = await fetchEvent(slug);
      if (m?.description) hit = { slug, m };
      await sleep(200);
    }
    if (!hit) {
      console.warn(`[warn] aucun event trouvé pour ${prefix} (BACK=${BACK})`);
      continue;
    }
    const desc = hit.m.description ?? "";
    const streamMatch = desc.match(/https:\/\/data\.chain\.link\/streams\/[a-z0-9-]+/i);
    found.push({
      prefix,
      slug: hit.slug,
      closed: hit.m.closed ?? false,
      question: hit.m.question ?? "",
      description: desc,
      chainlink: /chainlink/i.test(desc),
      twap60: /twap/i.test(desc),
      streamUrl: streamMatch ? streamMatch[0] : null,
    });
  }

  lines.push("# A1/A2 — Source de résolution (descriptions Gamma)");
  lines.push("");
  lines.push(`- Généré: ${new Date().toISOString()}`);
  lines.push(`- Host: ${HOST}`);
  lines.push("");
  lines.push("| Préfixe | Slug testé | Chainlink | TWAP | Stream |");
  lines.push("|---|---|---|---|---|");
  for (const f of found) {
    lines.push(`| ${f.prefix} | \`${f.slug}\` | ${f.chainlink ? "✅" : "❌"} | ${f.twap60 ? "TWAP-60s ✅" : "simple"} | ${f.streamUrl ?? "—"} |`);
  }
  lines.push("");
  lines.push("## Citations exactes (champ `description` Gamma)");
  lines.push("");
  for (const f of found) {
    lines.push(`### ${f.prefix} — \`${f.slug}\``);
    lines.push("");
    lines.push("```text");
    lines.push(f.description.trim());
    lines.push("");
    lines.push("```");
  }
  lines.push("");

  const allChainlink = found.length > 0 && found.every((f) => f.chainlink);
  const twapAssets = found.filter((f) => f.twap60).map((f) => f.prefix);
  lines.push("## Verdict A1");
  lines.push("");
  if (found.length === 0) {
    lines.push("**INDÉTERMINÉ** — aucun event récupéré (host injoignable ?).");
  } else if (allChainlink) {
    lines.push(`**CONFIRMÉ** — ${found.length}/${found.length} préfixes résolvent sur Chainlink ; TWAP-60s sur : ${twapAssets.join(", ") || "aucun"}.`);
  } else {
    const bad = found.filter((f) => !f.chainlink).map((f) => f.prefix);
    lines.push(`**PARTIEL** — sans Chainlink : ${bad.join(", ")} (vérifier manuellement).`);
  }
  lines.push("");

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now();
  writeFileSync(`audits/chainlink-lag/A1-SOURCE-${stamp}.md`, lines.join("\n"));
  writeFileSync(
    `audits/chainlink-lag/A1-SOURCE-${stamp}.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), found }, null, 2),
  );
  console.log(lines.join("\n"));
  console.log(`\nÉcrit: audits/chainlink-lag/A1-SOURCE-${stamp}.md + .json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});