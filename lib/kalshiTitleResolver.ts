import { Redis } from "@upstash/redis";

const TITLE_KEY_PREFIX = "kalshi:title:";
const TITLE_TTL_SEC = 60 * 60 * 24; // 24 hours
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

const MONTHS: Record<string, string> = {
  JAN: "Jan",
  FEB: "Feb",
  MAR: "Mar",
  APR: "Apr",
  MAY: "May",
  JUN: "Jun",
  JUL: "Jul",
  AUG: "Aug",
  SEP: "Sep",
  OCT: "Oct",
  NOV: "Nov",
  DEC: "Dec",
};

const SERIES_LABELS: Record<string, string> = {
  WC: "World Cup",
  WCGAME: "World Cup Game",
  WCSCORE: "World Cup Score",
  WCSPREAD: "World Cup Spread",
  WCTCORNERS: "World Cup Corners",
  WCMENTION: "World Cup Mention",
  WC1HBTTS: "World Cup 1H BTTS",
  MLB: "MLB",
  MLBGAME: "MLB Game",
  MLBHIT: "MLB Hits",
  MLBSPREAD: "MLB Spread",
  NBA: "NBA",
  NFL: "NFL",
  NHL: "NHL",
  BTC: "Bitcoin",
  BTCD: "Bitcoin Daily",
  ETH: "Ethereum",
  SOL15M: "SOL 15-Min",
  XRP15M: "XRP 15-Min",
  FED: "Fed",
  ITFWMATCH: "Tennis",
  ITFMATCH: "Tennis",
  ELONMARS: "Elon Mars",
  NEWPOPE: "New Pope",
  WARMING: "Global Warming",
  MVESPORTSMULTIGAMEEXTENDED: "Sports Combo",
  MVECROSSCATEGORY: "Cross-Category Combo",
};

const GENERIC_EVENT_TITLES = new Set([
  "combo",
  "mve",
  "parlay",
  "multivariate",
  "multigame",
]);

const RAW_TICKER_TITLE_RE =
  /^KX[A-Z0-9]+(?:-S[A-F0-9]+)+(?:-[A-F0-9]+)?$/i;

export interface KalshiMarketTitleInput {
  ticker?: string;
  title?: string | null;
  yes_sub_title?: string | null;
  no_sub_title?: string | null;
  market_type?: string | null;
  mve_selected_legs?: unknown[] | null;
}

export interface KalshiEventTitleInput {
  title?: string | null;
  sub_title?: string | null;
}

let redis: Redis | null = null;
const memoryCache = new Map<string, string>();

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

export function cleanKalshiTitle(title: string): string {
  if (!title) return title;
  return title
    .replace("Pro Basketball Finals", "NBA Finals")
    .replace("Pro Baseball Championship", "MLB World Series")
    .replace("Pro Football Championship", "NFL Super Bowl")
    .replace("Pro Hockey Championship", "NHL Stanley Cup")
    .replace("Pro Basketball", "NBA")
    .replace("Pro Baseball", "MLB");
}

function isGenericEventTitle(value: string): boolean {
  return GENERIC_EVENT_TITLES.has(value.trim().toLowerCase());
}

/** True when a title is an internal code, raw ticker, or generic placeholder. */
export function isInternalKalshiTitle(title: string, ticker?: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  if (isGenericEventTitle(trimmed)) return true;

  if (ticker && trimmed.toUpperCase() === ticker.toUpperCase()) return true;
  if (RAW_TICKER_TITLE_RE.test(trimmed)) return true;

  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(trimmed) && !trimmed.includes(" ")) {
    return true;
  }

  const compact = trimmed.replace(/\s+/g, "");
  if (/^[A-Z0-9]{14,}$/.test(compact) && !trimmed.includes(",")) {
    return true;
  }

  if (/MVE(?:SPORTS)?MULTI/i.test(trimmed) && !trimmed.includes(",")) {
    return true;
  }

  if (lower === "kalshi market") return true;

  return false;
}

export function formatComboLegTitle(raw: string): string {
  return raw
    .replace(/,(?!\s)/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isComboMarket(market: KalshiMarketTitleInput): boolean {
  const ticker = market.ticker ?? "";
  return (
    (Array.isArray(market.mve_selected_legs) &&
      market.mve_selected_legs.length > 0) ||
    ticker.includes("KXMVE") ||
    ticker.includes("MVESPORT")
  );
}

/**
 * Prefer market subtitles over generic event titles (e.g. MVE "Combo").
 * Returns null when no human-readable label is available.
 */
export function formatKalshiMarketDisplayTitle(
  market: KalshiMarketTitleInput,
  event?: KalshiEventTitleInput | null
): string | null {
  const ticker = market.ticker ?? "";
  const yesSub = market.yes_sub_title?.trim() ?? "";
  const marketTitle = market.title?.trim() ?? "";
  const noSub = market.no_sub_title?.trim() ?? "";
  const combo = isComboMarket(market);

  const polish = (raw: string) =>
    cleanKalshiTitle(combo ? formatComboLegTitle(raw) : raw);

  for (const raw of [yesSub, marketTitle, noSub]) {
    if (!raw || isInternalKalshiTitle(raw, ticker)) continue;
    return polish(raw);
  }

  const eventTitle = event?.title?.trim() ?? "";
  const eventSub = event?.sub_title?.trim() ?? "";
  const subtitle = yesSub || marketTitle || noSub;

  const eventLabel =
    eventTitle && !isGenericEventTitle(eventTitle)
      ? eventTitle
      : eventSub && !isGenericEventTitle(eventSub)
        ? eventSub
        : "";

  if (eventLabel && subtitle && !isInternalKalshiTitle(subtitle, ticker)) {
    return polish(`${eventLabel}: ${subtitle}`);
  }

  if (eventLabel && !subtitle) {
    return cleanKalshiTitle(eventLabel);
  }

  return null;
}

function labelSeries(raw: string): string {
  const key = raw.replace(/^KX/, "");
  if (SERIES_LABELS[key]) return SERIES_LABELS[key];
  if (key.length <= 4) return key;
  return key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function formatTeamPair(token: string): string | null {
  if (token.length < 6 || token.length > 12) return null;
  if (!/^[A-Z0-9]+$/.test(token)) return null;
  const mid = Math.floor(token.length / 2);
  const a = token.slice(0, mid);
  const b = token.slice(mid);
  if (a.length < 2 || b.length < 2) return null;
  return `${a} vs ${b}`;
}

function parseMiddleToken(token: string): string[] {
  const out: string[] = [];
  const m = token.match(/^(\d{2})([A-Z]{3})(\d{2})(.*)$/);
  if (!m) return [token];

  const month = MONTHS[m[2]];
  if (month) out.push(`${month} ${parseInt(m[3], 10)}`);

  let rest = m[4];
  if (/^\d{4}$/.test(rest)) {
    const hh = parseInt(rest.slice(0, 2), 10);
    const mm = parseInt(rest.slice(2, 4), 10);
    if (hh <= 23 && mm <= 59) {
      out.push(`${hh}:${mm.toString().padStart(2, "0")}`);
      rest = "";
    }
  } else if (/^\d{4}/.test(rest) && rest.length > 4) {
    const time = rest.slice(0, 4);
    const hh = parseInt(time.slice(0, 2), 10);
    const mm = parseInt(time.slice(2, 4), 10);
    if (hh <= 23 && mm <= 59) {
      out.push(`${hh}:${mm.toString().padStart(2, "0")}`);
      rest = rest.slice(4);
    }
  } else if (/^\d{2}$/.test(rest)) {
    out.push(`${parseInt(rest, 10)}:00`);
    rest = "";
  }

  if (rest) {
    const teams = formatTeamPair(rest);
    out.push(teams ?? rest);
  }

  return out;
}

function formatSuffix(part: string): string | null {
  if (/^T\d/.test(part)) {
    const strike = part.slice(1);
    const num = parseFloat(strike);
    if (Number.isFinite(num)) {
      return num >= 1000 ? `$${num.toLocaleString("en-US")}` : `$${strike}`;
    }
  }
  if (/^\d+$/.test(part) && part.length <= 3) return `line ${part}`;
  const score = part.match(/^([A-Z]{3})(\d)([A-Z]{3})(\d)$/);
  if (score) return `${score[1]} ${score[2]}–${score[4]} ${score[3]}`;
  if (part.length <= 8) return part;
  return null;
}

/** Readable fallback when Redis / API title is unavailable. */
export function humanizeKalshiTicker(ticker: string): string {
  if (!ticker) return "Kalshi market";

  const parts = ticker.split("-").filter(Boolean);
  if (parts.length === 0) return ticker;

  const segments: string[] = [labelSeries(parts[0])];

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (i === 1 && /^\d{2}[A-Z]{3}\d{2}/.test(part)) {
      segments.push(...parseMiddleToken(part));
      continue;
    }
    if (/^S\d{4}/i.test(part)) continue;
    if (/^[A-F0-9]{8,}$/i.test(part)) continue;
    const suffix = formatSuffix(part);
    if (suffix) segments.push(suffix);
    else if (part.length <= 12) segments.push(part);
  }

  const label = segments.filter(Boolean).join(" · ");
  return label || ticker;
}

function rememberTitle(ticker: string, title: string): void {
  if (!ticker || !title) return;
  memoryCache.set(ticker, title);
}

export async function getCachedKalshiTitle(
  ticker: string
): Promise<string | null> {
  const mem = memoryCache.get(ticker);
  if (mem && !isInternalKalshiTitle(mem, ticker)) return mem;

  const client = getRedis();
  if (!client) return null;
  try {
    const cached = await client.get<string>(`${TITLE_KEY_PREFIX}${ticker}`);
    if (cached && !isInternalKalshiTitle(cached, ticker)) {
      rememberTitle(ticker, cached);
      return cached;
    }
    return null;
  } catch {
    return null;
  }
}

export async function cacheKalshiTitle(
  ticker: string,
  title: string
): Promise<void> {
  if (!ticker || !title || isInternalKalshiTitle(title, ticker)) return;
  rememberTitle(ticker, title);
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(`${TITLE_KEY_PREFIX}${ticker}`, title, {
      ex: TITLE_TTL_SEC,
    });
  } catch {
    // no-op
  }
}

export async function cacheKalshiTitlesFromMarkets(
  markets: Array<{ id?: string; question?: string; ticker?: string }>
): Promise<void> {
  for (const m of markets) {
    const ticker = m.id ?? m.ticker;
    const title = m.question;
    if (ticker && title && !isInternalKalshiTitle(title, ticker)) {
      await cacheKalshiTitle(ticker, cleanKalshiTitle(title));
    }
  }
}

async function fetchKalshiEvent(
  eventTicker: string
): Promise<KalshiEventTitleInput | null> {
  try {
    const res = await fetch(
      `${KALSHI_API}/events/${encodeURIComponent(eventTicker)}`,
      { headers: { Accept: "application/json" }, next: { revalidate: 3600 } }
    );
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const event =
      data && typeof data === "object" && "event" in data
        ? (data as { event?: KalshiEventTitleInput }).event
        : null;
    return event ?? null;
  } catch {
    return null;
  }
}

function marketRecordFromApi(
  market: Record<string, unknown>,
  ticker: string
): KalshiMarketTitleInput {
  return {
    ticker: String(market.ticker ?? ticker),
    title: typeof market.title === "string" ? market.title : null,
    yes_sub_title:
      typeof market.yes_sub_title === "string" ? market.yes_sub_title : null,
    no_sub_title:
      typeof market.no_sub_title === "string" ? market.no_sub_title : null,
    market_type:
      typeof market.market_type === "string" ? market.market_type : null,
    mve_selected_legs: Array.isArray(market.mve_selected_legs)
      ? market.mve_selected_legs
      : null,
  };
}

async function fetchKalshiMarketTitle(ticker: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${KALSHI_API}/markets/${encodeURIComponent(ticker)}`,
      { headers: { Accept: "application/json" }, next: { revalidate: 3600 } }
    );
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const market =
      data && typeof data === "object" && "market" in data
        ? (data as { market?: Record<string, unknown> }).market
        : null;
    if (!market) return null;

    const input = marketRecordFromApi(market, ticker);
    let title = formatKalshiMarketDisplayTitle(input, null);
    if (title) return title;

    const eventTicker =
      typeof market.event_ticker === "string" ? market.event_ticker : "";
    if (eventTicker) {
      const event = await fetchKalshiEvent(eventTicker);
      title = formatKalshiMarketDisplayTitle(input, event);
      if (title) return title;
    }

    return null;
  } catch {
    return null;
  }
}

const pendingLookups = new Set<string>();

export function scheduleKalshiTitleLookup(ticker: string): void {
  if (!ticker || pendingLookups.has(ticker)) return;
  pendingLookups.add(ticker);
  void (async () => {
    try {
      const title = await fetchKalshiMarketTitle(ticker);
      if (title) await cacheKalshiTitle(ticker, title);
    } finally {
      pendingLookups.delete(ticker);
    }
  })();
}

export async function resolveKalshiTitle(ticker: string): Promise<string> {
  const cached = await getCachedKalshiTitle(ticker);
  if (cached) return cached;

  const fetched = await fetchKalshiMarketTitle(ticker);
  if (fetched) {
    await cacheKalshiTitle(ticker, fetched);
    return fetched;
  }

  return humanizeKalshiTicker(ticker);
}

/** Resolve many tickers in parallel (deduped), preferring API subtitles over ticker fallbacks. */
export async function resolveKalshiTitles(
  tickers: string[],
  concurrency = 8
): Promise<Map<string, string>> {
  const unique = [...new Set(tickers.filter(Boolean))];
  const result = new Map<string, string>();
  const toFetch: string[] = [];

  for (const ticker of unique) {
    const cached = await getCachedKalshiTitle(ticker);
    if (cached) {
      result.set(ticker, cached);
      continue;
    }
    toFetch.push(ticker);
  }

  let index = 0;
  async function worker(): Promise<void> {
    while (index < toFetch.length) {
      const ticker = toFetch[index++];
      const fetched = await fetchKalshiMarketTitle(ticker);
      const title = fetched ?? humanizeKalshiTicker(ticker);
      result.set(ticker, title);
      if (fetched) await cacheKalshiTitle(ticker, fetched);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, toFetch.length) },
    () => worker()
  );
  await Promise.all(workers);

  return result;
}
