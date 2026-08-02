import {
  getPrimaryProbability,
  normalizeMarket,
  type GammaMarket,
} from "@/lib/polymarket";
import {
  fetchKalshiOpenMarkets,
  kalshiYesMid,
  KALSHI_API,
  KALSHI_BATCH_DELAY_MS,
  type KalshiMarket,
} from "@/lib/kalshi";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { buildNormalizedEmbeddingText } from "@/lib/evPipeline/embeddingTextNormalize";
import type { MappingFailure, NormalizedMarketContract } from "@/lib/evPipeline/types";

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
const GAMMA_PAGE_SIZE = 100;
export const DEFAULT_PM_LIMIT = 400;
export const DEFAULT_KALSHI_MAX_PAGES = 12;
const KALSHI_MIN_VOLUME = 5;

/** Known Kalshi series used when the open-market scan returns empty or errors. */
const KALSHI_FALLBACK_SERIES = [
  "KXNFL",
  "KXNBA",
  "KXMLB",
  "KXNHL",
  "KXNFLTOTAL",
  "KXNBATOTAL",
  "KXMLBTOTAL",
  "KXNHLTOTAL",
  "KXFED",
  "KXBTC",
  "KXBTCD",
  "KXETH",
  "KXSOL",
  "KXWCGAME",
  "KXWCTOTAL",
  "KXWCSPREAD",
  "KXWCSCORE",
  "KXWC",
] as const;

/** Supplementary Gamma pass — sports derivatives + advance/moneyline props. */
const GAMMA_SPORTS_TYPES_QUERY = [
  "sports_market_types=SPORTS_MARKET_TYPE_MONEYLINE",
  "sports_market_types=SPORTS_MARKET_TYPE_TOTAL",
  "sports_market_types=SPORTS_MARKET_TYPE_SPREAD",
  "sports_market_types=SPORTS_MARKET_TYPE_PROP",
].join("&");
const GAMMA_SPORTS_SUPPLEMENT_LIMIT = 400;

/** Always merge active World Cup / cricket derivative series from Kalshi. */
const KALSHI_WC_SERIES = [
  "KXWCGAME",
  "KXWCTOTAL",
  "KXWCSPREAD",
  "KXWCSCORE",
] as const;

export interface FetchMarketsOptions {
  polymarketLimit?: number;
  kalshiMaxPages?: number;
  signal?: AbortSignal;
}

export interface FetchedMarkets {
  polymarket: NormalizedMarketContract[];
  kalshi: NormalizedMarketContract[];
  failures: MappingFailure[];
}

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function buildEmbeddingText(
  title: string,
  description: string,
  platform: NormalizedMarketContract["platform"],
  ticker?: string
): string {
  const tickerHints =
    platform === "kalshi" && ticker ? kalshiTickerEmbeddingHints(ticker) : "";
  const base = buildNormalizedEmbeddingText(title, description, platform);
  return tickerHints ? `${base}\n${tickerHints}` : base;
}

function kalshiTickerEmbeddingHints(ticker: string): string {
  const upper = ticker.toUpperCase();
  const hints: string[] = [];

  if (upper.startsWith("KXBTC") || upper.includes("BTC")) {
    hints.push("bitcoin btc crypto");
  }
  if (upper.startsWith("KXETH") || upper.includes("ETH")) {
    hints.push("ethereum eth crypto");
  }
  if (upper.includes("15M")) {
    hints.push("15 minute short term intraday");
  }
  if (upper.startsWith("KXNFL")) hints.push("nfl pro football");
  if (upper.startsWith("KXNBA")) hints.push("nba pro basketball");
  if (upper.startsWith("KXMLB")) hints.push("mlb pro baseball");
  if (upper.startsWith("KXFED") || upper.startsWith("KXFOMC")) {
    hints.push("fed fomc interest rate");
  }
  if (upper.startsWith("KXWC")) {
    hints.push(
      "world cup cricket rsa can south africa canada advance total spread over under"
    );
  }

  return hints.join(" ");
}

function gammaDescription(raw: Record<string, unknown>): string {
  const direct = raw.description;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const rules = raw.rules;
  if (typeof rules === "string" && rules.trim()) return rules.trim();
  return "";
}

function logPipelineSkipIfMissingIdentifier(market: {
  tokenId?: string | null;
  ticker?: string | null;
  title?: string | null;
  name?: string | null;
  question?: string | null;
}): void {
  const tokenId = market.tokenId?.trim() || null;
  const ticker = market.ticker?.trim() || null;
  if (!tokenId && !ticker) {
    console.log(
      `[Pipeline Skip] Missing identifier for: ${market.title || market.name || market.question || "unknown"}`
    );
  }
}

function gammaMarketLabel(raw: GammaMarket): string {
  const record = raw as unknown as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  return raw.question ?? name ?? raw.slug ?? raw.id ?? "unknown";
}

function mergeGammaMarketsById(markets: GammaMarket[]): GammaMarket[] {
  const byId = new Map<string, GammaMarket>();
  for (const market of markets) {
    byId.set(market.id, market);
  }
  return Array.from(byId.values());
}

function parseClobTokenIds(raw: GammaMarket): string[] {
  if (Array.isArray(raw.clobTokenIds)) {
    return raw.clobTokenIds.map(String);
  }
  try {
    const parsed = JSON.parse(String(raw.clobTokenIds)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function normalizePolymarketGamma(
  raw: GammaMarket
): NormalizedMarketContract | null {
  const summary = normalizeMarket(raw);
  const tokenIds = parseClobTokenIds(raw);
  const yesTokenId = tokenIds[0];
  if (!yesTokenId) return null;

  const rawRecord = raw as unknown as Record<string, unknown>;
  const description = gammaDescription(rawRecord);
  const yesBid = parseNum(raw.bestBid);
  const yesAsk = parseNum(raw.bestAsk);
  const spread =
    yesBid != null && yesAsk != null ? Math.max(0, yesAsk - yesBid) : null;

  const slugText = [summary.slug, summary.eventSlug].filter(Boolean).join(" ");
  const embeddingTitle = [summary.question, slugText].filter(Boolean).join(" ");

  return {
    platform: "polymarket",
    externalId: summary.conditionId,
    tokenOrTicker: yesTokenId,
    title: summary.question,
    slug: summary.slug ?? null,
    eventSlug: summary.eventSlug ?? null,
    description,
    expiration: typeof raw.endDate === "string" ? raw.endDate : null,
    yesBid,
    yesAsk,
    spread,
    impliedProbability: getPrimaryProbability(raw.outcomePrices),
    embeddingText: buildEmbeddingText(embeddingTitle, description, "polymarket"),
  };
}

export function normalizeKalshiMarket(raw: KalshiMarket): NormalizedMarketContract | null {
  const ticker = raw.ticker?.trim();
  if (!ticker) return null;

  const title = String(raw.title ?? ticker);
  const rulesPrimary =
    typeof raw.rules_primary === "string" ? raw.rules_primary : "";
  const rulesSecondary =
    typeof raw.rules_secondary === "string" ? raw.rules_secondary : "";
  const description = [rulesPrimary, rulesSecondary].filter(Boolean).join(" ");

  const yesBid = parseNum(raw.yes_bid_dollars);
  const yesAsk = parseNum(raw.yes_ask_dollars);
  const spread =
    yesBid != null && yesAsk != null ? Math.max(0, yesAsk - yesBid) : null;
  const impliedProbability = kalshiYesMid(raw);

  return {
    platform: "kalshi",
    externalId: ticker,
    tokenOrTicker: ticker,
    title,
    description,
    expiration:
      typeof raw.expected_expiration_time === "string"
        ? raw.expected_expiration_time
        : typeof raw.close_time === "string"
          ? raw.close_time
          : null,
    yesBid,
    yesAsk,
    spread,
    impliedProbability,
    embeddingText: buildEmbeddingText(title, description, "kalshi", ticker),
  };
}

function mergeKalshiMarketsByTicker(markets: KalshiMarket[]): KalshiMarket[] {
  const byTicker = new Map<string, KalshiMarket>();
  for (const market of markets) {
    const ticker = market.ticker?.trim();
    if (ticker) byTicker.set(ticker.toUpperCase(), market);
  }
  return Array.from(byTicker.values());
}

async function fetchKalshiSeriesMarkets(
  series: readonly string[],
  signal?: AbortSignal
): Promise<KalshiMarket[]> {
  const merged: KalshiMarket[] = [];
  for (let i = 0; i < series.length; i++) {
    if (i > 0) {
      await sleep(KALSHI_BATCH_DELAY_MS);
    }
    const seriesTicker = series[i];
    try {
      const batch = await fetchKalshiOpenMarketsWithRetry(
        { seriesTicker, maxPages: 4, limit: 200, signal },
        2
      );
      merged.push(...batch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ev/map-markets] Kalshi series ${seriesTicker} fetch failed: ${message}`
      );
    }
  }
  return merged;
}

function isKalshiStructurallyExcluded(m: KalshiMarket): boolean {
  const ticker = m.ticker ?? "";
  if (ticker.includes("KXMVE")) return true;
  if (m.title?.includes(",yes ")) return true;
  if (Array.isArray(m.mve_selected_legs) && m.mve_selected_legs.length > 0) {
    return true;
  }
  return false;
}

function isKalshiCandidate(m: KalshiMarket): boolean {
  if (isKalshiStructurallyExcluded(m)) return false;
  const volume = parseNum(m.volume_fp) ?? 0;
  return volume >= KALSHI_MIN_VOLUME;
}

function normalizeKalshiBatch(
  rawMarkets: KalshiMarket[]
): NormalizedMarketContract[] {
  const markets: NormalizedMarketContract[] = [];

  for (const raw of rawMarkets) {
    logPipelineSkipIfMissingIdentifier({
      ticker: raw.ticker,
      title: raw.title,
      name: raw.title,
    });

    const normalized = normalizeKalshiMarket(raw);
    if (!normalized) continue;
    markets.push(normalized);
  }

  return markets;
}

async function fetchWithRateLimitRetry(
  url: string,
  init: RequestInit,
  label: string,
  maxAttempts = 4
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        ...init,
        timeoutMs: 15000,
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "2");
        const delayMs = Math.min(30_000, Math.max(1000, retryAfter * 1000));
        console.warn(
          `[ev/map-markets] ${label} rate limited (429); retry in ${delayMs}ms`
        );
        await sleep(delayMs);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const delayMs = 500 * 2 ** attempt;
      console.warn(
        `[ev/map-markets] ${label} fetch failed (attempt ${attempt + 1}): ${lastError.message}`
      );
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error(`${label} fetch failed after retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGammaMarketsPaginated(
  querySuffix: string,
  targetLimit: number,
  label: string
): Promise<{ markets: GammaMarket[]; fetched: number; failed?: MappingFailure }> {
  const rawMarkets: GammaMarket[] = [];
  let offset = 0;

  while (rawMarkets.length < targetLimit) {
    const pageLimit = Math.min(GAMMA_PAGE_SIZE, targetLimit - rawMarkets.length);
    const url = `${GAMMA_API_BASE}/markets?limit=${pageLimit}&offset=${offset}&${querySuffix}`;
    const res = await fetchWithRateLimitRetry(
      url,
      { headers: { Accept: "application/json" }, cache: "no-store" },
      label
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[ev/map-markets] ${label} HTTP ${res.status} from ${url}:`,
        body.slice(0, 300)
      );
      if (rawMarkets.length === 0) {
        return {
          markets: [],
          fetched: 0,
          failed: {
            stage: "fetch_polymarket",
            message: `${label} HTTP ${res.status} (${GAMMA_API_BASE}/markets)`,
          },
        };
      }
      break;
    }

    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      if (rawMarkets.length === 0) {
        return {
          markets: [],
          fetched: 0,
          failed: {
            stage: "fetch_polymarket",
            message: `${label} returned non-array payload`,
          },
        };
      }
      break;
    }

    const page = data as GammaMarket[];
    if (page.length === 0) break;

    rawMarkets.push(...page);
    offset += page.length;
    if (page.length < pageLimit) break;
  }

  return { markets: rawMarkets, fetched: offset };
}

function normalizePolymarketBatch(
  rawMarkets: GammaMarket[]
): NormalizedMarketContract[] {
  const markets: NormalizedMarketContract[] = [];

  for (const raw of rawMarkets) {
    const tokenIds = parseClobTokenIds(raw);
    logPipelineSkipIfMissingIdentifier({
      tokenId: tokenIds[0],
      title: gammaMarketLabel(raw),
      question: raw.question,
    });

    const normalized = normalizePolymarketGamma(raw);
    if (!normalized) {
      if (tokenIds[0]) {
        console.log(
          `[Pipeline Skip] Failed normalization for: ${gammaMarketLabel(raw)} (tokenId=${tokenIds[0]})`
        );
      }
      continue;
    }

    markets.push(normalized);
  }

  return markets;
}

export async function fetchActivePolymarketMarkets(
  options: FetchMarketsOptions = {}
): Promise<{ markets: NormalizedMarketContract[]; failure?: MappingFailure }> {
  const targetLimit = options.polymarketLimit ?? DEFAULT_PM_LIMIT;
  const gammaBaseQuery =
    "active=true&closed=false&order=volume24hr&ascending=false";

  try {
    const [volumePass, sportsPass] = await Promise.all([
      fetchGammaMarketsPaginated(
        gammaBaseQuery,
        targetLimit,
        "Polymarket Gamma (volume)"
      ),
      fetchGammaMarketsPaginated(
        `${gammaBaseQuery}&${GAMMA_SPORTS_TYPES_QUERY}`,
        GAMMA_SPORTS_SUPPLEMENT_LIMIT,
        "Polymarket Gamma (sports moneyline/total/spread/prop)"
      ),
    ]);

    if (volumePass.failed && volumePass.markets.length === 0) {
      return { markets: [], failure: volumePass.failed };
    }

    const rawMarkets = mergeGammaMarketsById([
      ...volumePass.markets,
      ...sportsPass.markets,
    ]);

    const markets = normalizePolymarketBatch(rawMarkets);

    console.info(
      `[ev/map-markets] Polymarket normalized ${markets.length} contracts from Gamma (${rawMarkets.length} raw merged: volume=${volumePass.fetched}, sports=${sportsPass.fetched})`
    );
    return { markets };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Polymarket fetch failed";
    console.error("[ev/map-markets] Polymarket fetch failure:", message);
    return {
      markets: [],
      failure: {
        stage: "fetch_polymarket",
        message: `${message} (endpoint: ${GAMMA_API_BASE}/markets)`,
      },
    };
  }
}

export async function fetchActiveKalshiMarkets(
  options: FetchMarketsOptions = {}
): Promise<{ markets: NormalizedMarketContract[]; failure?: MappingFailure }> {
  const maxPages = options.kalshiMaxPages ?? DEFAULT_KALSHI_MAX_PAGES;

  try {
    let raw: KalshiMarket[] = [];
    try {
      raw = await fetchKalshiOpenMarketsWithRetry({
        maxPages,
        limit: 200,
        signal: options.signal,
      });
      const wcMarkets = await fetchKalshiSeriesMarkets(
        KALSHI_WC_SERIES,
        options.signal
      );
      if (wcMarkets.length > 0) {
        raw = mergeKalshiMarketsByTicker([...raw, ...wcMarkets]);
      }
    } catch (primaryErr) {
      const primaryMessage =
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      console.error(
        `[ev/map-markets] Kalshi open-market scan failed (${KALSHI_API}):`,
        primaryMessage
      );
      console.warn(
        "[ev/map-markets] Falling back to known Kalshi series tickers…"
      );
      raw = await fetchKalshiFallbackSeries(options.signal);
      if (raw.length === 0) {
        throw primaryErr;
      }
    }

    let markets = normalizeKalshiBatch(
      raw.filter(isKalshiCandidate)
    );

    if (markets.length === 0 && raw.length > 0) {
      console.warn(
        `[ev/map-markets] Kalshi returned ${raw.length} raw markets but 0 passed volume/filter rules — relaxing volume floor (keeping structural filters)`
      );
      markets = normalizeKalshiBatch(
        raw.filter((m) => !isKalshiStructurallyExcluded(m))
      );
    }

    if (markets.length === 0) {
      console.warn(
        "[ev/map-markets] Kalshi still empty — trying fallback series"
      );
      const fallbackRaw = await fetchKalshiFallbackSeries(options.signal);
      markets = normalizeKalshiBatch(
        fallbackRaw.filter(isKalshiCandidate)
      );
    }

    if (markets.length === 0) {
      return {
        markets: [],
        failure: {
          stage: "fetch_kalshi",
          message: `Kalshi returned no usable markets from ${KALSHI_API} (including series fallback)`,
        },
      };
    }

    console.info(
      `[ev/map-markets] Kalshi normalized ${markets.length} contracts`
    );
    return { markets };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Kalshi fetch failed";
    console.error("[ev/map-markets] Kalshi fetch failure:", message);
    return {
      markets: [],
      failure: {
        stage: "fetch_kalshi",
        message: `${message} (endpoint: ${KALSHI_API}/markets)`,
      },
    };
  }
}

async function fetchKalshiOpenMarketsWithRetry(
  options: Parameters<typeof fetchKalshiOpenMarkets>[0],
  maxAttempts = 4
): Promise<KalshiMarket[]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetchKalshiOpenMarkets(options);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const delayMs = 500 * 2 ** attempt;
      console.warn(
        `[ev/map-markets] Kalshi fetch attempt ${attempt + 1}/${maxAttempts} failed: ${lastError.message}`
      );
      if (attempt + 1 < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError ?? new Error("Kalshi fetch failed after retries");
}

async function fetchKalshiFallbackSeries(
  signal?: AbortSignal
): Promise<KalshiMarket[]> {
  const merged: KalshiMarket[] = [];
  for (let i = 0; i < KALSHI_FALLBACK_SERIES.length; i++) {
    if (i > 0) {
      await sleep(KALSHI_BATCH_DELAY_MS);
    }
    const series = KALSHI_FALLBACK_SERIES[i];
    try {
      const batch = await fetchKalshiOpenMarketsWithRetry(
        { seriesTicker: series, maxPages: 4, limit: 200, signal },
        2
      );
      if (batch.length > 0) {
        merged.push(...batch);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ev/map-markets] Kalshi fallback series ${series} failed: ${message}`
      );
    }
  }
  return merged;
}

export async function fetchAndNormalizeMarkets(
  options: FetchMarketsOptions = {}
): Promise<FetchedMarkets> {
  const failures: MappingFailure[] = [];

  const [pm, kalshi] = await Promise.all([
    fetchActivePolymarketMarkets(options),
    fetchActiveKalshiMarkets(options),
  ]);

  if (pm.failure) {
    failures.push(pm.failure);
    console.error("[ev/map-markets] Polymarket fetch failure:", pm.failure.message);
  }
  if (kalshi.failure) {
    failures.push(kalshi.failure);
    console.error("[ev/map-markets] Kalshi fetch failure:", kalshi.failure.message);
  }

  return {
    polymarket: pm.markets,
    kalshi: kalshi.markets,
    failures,
  };
}
