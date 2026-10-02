/**
 * Parse la fenêtre temporelle d'un marché up/down depuis son slug.
 * Format: {asset}-updown-{durée}-{unix_start_ts}
 * Ex: btc-updown-15m-1788287400 → start=1788287400, end=1788288300 (15 min)
 *     btc-updown-5m-1781178900  → start=1781178900, end=1781179200 (5 min)
 *     btc-updown-4h-...         → 4 heures
 */
export interface MarketWindow {
  start: number; // secondes Unix
  end: number; // secondes Unix
}

const DURATION_SECONDS: Record<string, number> = {
  m: 60,
  h: 3600,
};

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

export function parseSlugWindow(slug: string): MarketWindow | null {
  const match = slug.match(/-(\d+)([mh])-(\d{10})$/);
  if (!match) return null;
  const duration = Number(match[1]) * (DURATION_SECONDS[match[2]] ?? 60);
  const start = Number(match[3]);
  if (!Number.isFinite(duration) || !Number.isFinite(start) || duration <= 0) {
    return null;
  }
  return { start, end: start + duration };
}

/**
 * Date/heure de début du créneau telle qu'affichée dans le titre.
 * Ex: "Bitcoin Up or Down - September 7, 10:30PM-10:45PM ET"
 * Ne pas utiliser `timestamp` API : c'est l'heure de redeem, pas le marché.
 */
export function parseTitleWindowMs(title: string, endDate?: string): number {
  const match = title.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i,
  );
  if (!match) return 0;
  const month = MONTHS[match[1].toLowerCase()];
  if (month == null) return 0;
  const day = Number(match[2]);
  let hour = Number(match[3]) % 12;
  if (match[5].toUpperCase() === "PM") hour += 12;
  const minute = Number(match[4]);
  const yearMatch = String(endDate ?? "").match(/^(\d{4})/);
  const year = yearMatch ? Number(yearMatch[1]) : new Date().getUTCFullYear();
  const ms = Date.UTC(year, month, day, hour, minute, 0);
  return Number.isFinite(ms) ? ms : 0;
}

/** Instant de référence du créneau marché (pas l'heure de redeem). */
export function marketRecencyMs(position: {
  slug: string;
  title?: string;
  endDate?: string;
}): number {
  const window = parseSlugWindow(position.slug);
  if (window) return window.start * 1000;
  const slugTs = position.slug.match(/(\d{10})$/);
  if (slugTs) return Number(slugTs[1]) * 1000;
  const fromTitle = parseTitleWindowMs(position.title ?? "", position.endDate);
  if (fromTitle > 0) return fromTitle;
  const fromEnd = Date.parse(position.endDate ?? "");
  if (Number.isFinite(fromEnd) && fromEnd > 0) return fromEnd;
  return 0;
}

export function l1Spread(
  bid: number | null | undefined,
  ask: number | null | undefined,
): number | null {
  if (bid == null || ask == null) return null;
  const spread = ask - bid;
  return Number.isFinite(spread) ? spread : null;
}

/**
 * Slug family (prefix): slug always ends with -<epoch-sec 10 digits>.
 * Mirror of src/utils/market.ts (backend).
 */
export function prefixOfSlug(slug: string): string {
  return slug.replace(/-\d{10}$/, "");
}

/** Countdown urgency thresholds (ms). */
const HOT_MS = 5 * 60 * 1000;
const WARM_MS = 15 * 60 * 1000;

/**
 * Countdown urgency CSS class.
 * - With base (e.g. "am-countdown"): returns "am-countdown am-countdown--hot" etc.
 * - Without base: returns only the modifier ("am-countdown--hot") or "".
 */
export function countdownClass(windowEnd: number, now: number, base = ""): string {
  const left = windowEnd * 1000 - now;
  const mod =
    left <= HOT_MS ? "am-countdown--hot" : left <= WARM_MS ? "am-countdown--warm" : "";
  if (!base) return mod;
  return mod ? `${base} ${mod}` : base;
}
