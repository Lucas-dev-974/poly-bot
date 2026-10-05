import type { BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import { extractWinner, extractSettlement, type GammaMarketResult } from "../position-resolver.js";
import { getMarketHistory } from "../dashboard/market-history.js";

interface WindowWinner {
  winnerOutcomeIndex: number;
  source: string;
}

function parsePrices(value: unknown): number[] | null {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch {
      return null;
    }
  }
  return null;
}

function winnerIndexFromGamma(result: GammaMarketResult): number | null {
  // Void 50/50 : les deux tokens valent 0.5 — étiqueter "Up gagnant" fausserait
  // market_resolutions (et donc le dataset ML). On persiste un verdict 2.
  const settlement = extractSettlement(result, { outcome: "Up", outcomeIndex: 0 });
  if (settlement === "void") return 2;
  if (settlement === "win") return 0;
  if (settlement === "lose") return 1;
  const prices = parsePrices(result.outcomePrices);
  if (!prices) return null;
  if (prices[0] >= 0.99) return 0;
  if (prices[0] <= 0.01) return 1;
  if (prices[1] >= 0.99) return 1;
  if (prices[1] <= 0.01) return 0;
  return null;
}

async function fetchEventMarket(
  config: BotConfig,
  eventSlug: string,
  closed?: boolean,
): Promise<GammaMarketResult | null> {
  const url = new URL("/events", config.gammaApiHost);
  url.searchParams.set("slug", eventSlug);
  if (closed === true) url.searchParams.set("closed", "true");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const events = (await response.json()) as Array<{ markets?: GammaMarketResult[] }>;
    return events[0]?.markets?.[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveWindowWinner(
  config: BotConfig,
  repos: Repositories | undefined,
  eventSlug: string,
  upTokenId: string | null,
  windowEndSec: number,
): Promise<WindowWinner | null> {
  const cached = repos?.marketResolutions.get(eventSlug);
  if (cached) {
    return { winnerOutcomeIndex: cached.winnerOutcomeIndex, source: cached.source };
  }

  const open = await fetchEventMarket(config, eventSlug);
  let idx = open ? winnerIndexFromGamma(open) : null;
  if (idx === null) {
    const closed = await fetchEventMarket(config, eventSlug, true);
    idx = closed ? winnerIndexFromGamma(closed) : null;
  }
  if (idx !== null) {
    repos?.marketResolutions.upsert({
      eventSlug,
      winnerOutcomeIndex: idx,
      source: "gamma",
      ts: Date.now(),
    });
    return { winnerOutcomeIndex: idx, source: "gamma" };
  }

  if (upTokenId) {
    try {
      const history = await getMarketHistory(config, {
        tokenId: upTokenId,
        startTs: windowEndSec,
        endTs: windowEndSec + 120,
      });
      const last = history.history.at(-1);
      if (last) {
        if (last.p >= 0.99) {
          repos?.marketResolutions.upsert({
            eventSlug,
            winnerOutcomeIndex: 0,
            source: "clob",
            ts: Date.now(),
          });
          return { winnerOutcomeIndex: 0, source: "clob" };
        }
        if (last.p <= 0.01) {
          repos?.marketResolutions.upsert({
            eventSlug,
            winnerOutcomeIndex: 1,
            source: "clob",
            ts: Date.now(),
          });
          return { winnerOutcomeIndex: 1, source: "clob" };
        }
      }
    } catch {
      /* unresolved */
    }
  }

  return null;
}
