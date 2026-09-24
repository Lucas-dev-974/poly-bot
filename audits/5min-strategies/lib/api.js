// Client API réutilisable pour les scripts 5min-strategies.
// Sources : Gamma (events/marchés), CLOB (books), data-api (trades).
// Autonome : aucune dépendance au code src/ du bot.

const GAMMA_HOST = "https://gamma-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API_HOST = "https://data-api.polymarket.com";
const TIMEOUT_MS = 15_000;

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const GATEWAY = {
  GAMMA_HOST,
  CLOB_HOST,
  DATA_API_HOST,

  /**
   * Événement Gamma par slug (fenêtre 5m fermée incluse avec closed=true).
   * @returns {Promise<object|null>} { slug, title, markets[0]: { outcomes, outcomePrices, clobTokenIds, conditionId, closed, umaResolutionStatus } }
   */
  async eventBySlug(slug) {
    for (const closed of [false, true]) {
      const url = new URL("/events", GAMMA_HOST);
      url.searchParams.set("slug", slug);
      if (closed) url.searchParams.set("closed", "true");
      try {
        const events = await fetchJson(url);
        if (events.length > 0) return events[0];
      } catch {
        /* retry with closed=true */
      }
    }
    return null;
  },

  /**
   * Liste les fenêtres 5m BTC récentes (fenêtre courante + suivantes).
   * Gamma tag "5M" contient toutes les durées 5 minutes ; on filtre par slug.
   */
  async liveBtc5mEvents(limit = 100) {
    const url = new URL("/events", GAMMA_HOST);
    url.searchParams.set("tag_slug", "5M");
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(limit));
    const events = await fetchJson(url);
    return events.filter((e) => e.slug?.startsWith("btc-updown-5m-"));
  },

  /** Parse les listes JSON-sérialisées de Gamma (outcomes, clobTokenIds, outcomePrices). */
  parseGammaList(value) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === "string" && value.length > 0) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        /* ignore */
      }
    }
    return [];
  },

  /**
   * Livre d'ordres CLOB d'un token.
   * @returns {Promise<{bids:Array,asks:Array,tick_size:string}>} bids/asks = [{price,size}] (prix string)
   */
  async book(tokenId) {
    const url = new URL("/book", CLOB_HOST);
    url.searchParams.set("token_id", tokenId);
    return fetchJson(url);
  },

  /**
   * Trades d'un marché (data-api), paginé. Trié du plus récent au plus ancien.
   * @returns {Promise<Array<{side,asset,conditionId,size,price,timestamp,outcome,outcomeIndex,eventSlug}>>}
   */
  async allTrades(conditionId, { maxPages = 40, pageSize = 500, onProgress } = {}) {
    const out = [];
    for (let page = 0; page < maxPages; page++) {
      const url = new URL("/trades", DATA_API_HOST);
      url.searchParams.set("market", conditionId);
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(page * pageSize));
      let batch;
      try {
        batch = await fetchJson(url);
      } catch (error) {
        console.warn(`  trades page ${page} failed: ${error.message}`);
        break;
      }
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      onProgress?.(out.length);
      if (batch.length < pageSize) break;
      await sleep(350); // rate limit
    }
    return out;
  },

  /**
   * Résolution d'une fenêtre 5m depuis Gamma : winnerIndex (0=Up, 1=Down) ou null.
   * Settlement = outcomePrices 1/0 (ou 0.9995/0.0005), fallback umaResolutionStatus=resolved.
   */
  async resolution(slug) {
    const ev = await this.eventBySlug(slug);
    const market = ev?.markets?.[0];
    if (!market) return null;
    const outcomes = this.parseGammaList(market.outcomes);
    const prices = this.parseGammaList(market.outcomePrices);
    const resolved =
      market.umaResolutionStatus === "resolved" ||
      (prices.length === 2 && (Number(prices[0]) >= 0.99 || Number(prices[0]) <= 0.01));
    if (!resolved || prices.length < 2 || outcomes.length < 2) return null;
    const p0 = Number(prices[0]);
    let winnerIndex;
    if (p0 >= 0.99) winnerIndex = 0;
    else if (p0 <= 0.01) winnerIndex = 1;
    else if (market.umaResolutionStatus === "resolved") winnerIndex = p0 >= 0.5 ? 0 : 1;
    else return null;
    return {
      slug,
      winnerIndex,
      winner: outcomes[winnerIndex],
      conditionId: market.conditionId ?? null,
      clobTokenIds: this.parseGammaList(market.clobTokenIds),
      closed: market.closed === true,
    };
  },

  sleep,
};