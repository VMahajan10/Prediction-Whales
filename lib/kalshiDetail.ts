import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { KALSHI_API } from "@/lib/kalshi";
import {
  formatKalshiMarketDisplayTitle,
  resolveKalshiTitle,
} from "@/lib/kalshiTitleResolver";
import type { MarketSummary } from "@/lib/polymarket";

const FETCH_TIMEOUT_MS = 8000;
const LARGE_TRADE_USD = 500;

export interface KalshiRawTradeFields {
  trade_id: string;
  ticker: string;
  created_time: string;
  count_fp: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  taker_side: "yes" | "no";
  taker_outcome_side?: "yes" | "no";
  taker_book_side?: "bid" | "ask";
  is_block_trade?: boolean;
}

export interface KalshiTradeDetail {
  tradeId: string;
  ticker: string;
  title: string;
  createdTime: string;
  timestamp: number;
  count: number;
  yesPrice: number;
  noPrice: number;
  price: number;
  usdNotional: number;
  takerSide: "yes" | "no";
  takerOutcomeSide: "yes" | "no";
  takerBookSide: "bid" | "ask";
  side: "BUY" | "SELL";
  outcome: "Yes" | "No";
  isBlockTrade: boolean;
}

export interface KalshiMarketDetail {
  ticker: string;
  title: string;
  eventTicker: string;
  seriesTicker: string;
  seriesTitle: string;
  webUrl: string;
  status: string;
  result: string;
  closeTime: string | null;
  expirationTime: string | null;
  expectedExpirationTime: string | null;
  openTime: string | null;
  rulesPrimary: string;
  rulesSecondary: string;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  lastPrice: number | null;
  volume: number;
  volume24h: number;
  openInterest: number;
  yesSubTitle: string;
  noSubTitle: string;
  marketType: string;
}

export interface KalshiOrderBookLevel {
  price: number;
  size: number;
}

export interface KalshiOrderBook {
  yes: KalshiOrderBookLevel[];
  no: KalshiOrderBookLevel[];
}

/** Highest resting bid in a Kalshi book side (API sorts ascending; best is last). */
export function bestOrderBookBid(
  levels: KalshiOrderBookLevel[]
): KalshiOrderBookLevel | null {
  if (levels.length === 0) return null;
  return levels.reduce((best, level) =>
    level.price > best.price ? level : best
  );
}

/**
 * Kalshi lists bids only. A bid on the opposite outcome at X is the same
 * liquidity as an ask on this outcome at (1 − X).
 */
export function deriveComplementAsks(
  oppositeBids: KalshiOrderBookLevel[]
): KalshiOrderBookLevel[] {
  return oppositeBids
    .map((bid) => ({ price: 1 - bid.price, size: bid.size }))
    .filter((level) => level.price > 0 && level.size > 0)
    .sort((a, b) => a.price - b.price);
}

export function sortBidsBestFirst(
  levels: KalshiOrderBookLevel[]
): KalshiOrderBookLevel[] {
  return [...levels].sort((a, b) => b.price - a.price);
}

export interface KalshiCandlestick {
  endPeriodTs: number;
  volume: number;
  openInterest: number;
  price: {
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    mean: number | null;
  };
  yesBid: {
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
  };
  yesAsk: {
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
  };
}

export interface KalshiMarketFlow {
  largeTradeCount: number;
  yesVolume: number;
  noVolume: number;
  yesPct: number;
  noPct: number;
  totalLargeVolume: number;
  minNotionalUsd: number;
  windowLabel: string;
}

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function seriesTickerFromMarketTicker(ticker: string): string {
  return ticker.split("-")[0] ?? ticker;
}

function slugifyKalshiTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the canonical Kalshi web URL for a market.
 *
 * Verified format: kalshi.com/markets/{series}/{series-title-slug}/{event}?op_market_ticker={TICKER}
 * The slug segment self-corrects on Kalshi's side, but we supply the real
 * slugified series title so the link is canonical on first load. The full API
 * market ticker is NOT a valid web path — it only works as op_market_ticker.
 */
export function kalshiWebMarketUrl(params: {
  marketTicker: string;
  eventTicker: string;
  seriesTicker?: string;
  seriesTitle?: string;
}): string {
  const series = (
    params.seriesTicker || seriesTickerFromMarketTicker(params.marketTicker)
  ).toLowerCase();
  const slug = params.seriesTitle ? slugifyKalshiTitle(params.seriesTitle) : series;
  const event = params.eventTicker.toLowerCase();
  const qs = `op_market_ticker=${encodeURIComponent(params.marketTicker)}`;
  return `https://kalshi.com/markets/${series}/${slug}/${event}?${qs}`;
}

function normalizeRawTrade(
  raw: KalshiRawTradeFields,
  title: string
): KalshiTradeDetail | null {
  const count = parseNum(raw.count_fp);
  const yesPrice = parseNum(raw.yes_price_dollars);
  const noPrice = parseNum(raw.no_price_dollars);
  const takerSide = raw.taker_side;
  const price = takerSide === "yes" ? yesPrice : noPrice;

  if (
    count == null ||
    count <= 0 ||
    price == null ||
    price <= 0 ||
    !raw.trade_id ||
    !raw.ticker
  ) {
    return null;
  }

  const usdNotional = price * count;
  const takerOutcomeSide = raw.taker_outcome_side ?? takerSide;
  const takerBookSide = raw.taker_book_side ?? "bid";
  const timestamp = Math.floor(Date.parse(raw.created_time) / 1000);

  return {
    tradeId: raw.trade_id,
    ticker: raw.ticker,
    title,
    createdTime: raw.created_time,
    timestamp: Number.isFinite(timestamp) ? timestamp : Math.floor(Date.now() / 1000),
    count,
    yesPrice: yesPrice ?? 0,
    noPrice: noPrice ?? 0,
    price,
    usdNotional,
    takerSide,
    takerOutcomeSide,
    takerBookSide,
    side: takerBookSide === "ask" ? "SELL" : "BUY",
    outcome: takerOutcomeSide === "yes" ? "Yes" : "No",
    isBlockTrade: raw.is_block_trade === true,
  };
}

async function kalshiGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetchWithTimeout(`${KALSHI_API}${path}`, {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: { Accept: "application/json", "User-Agent": "MarketPulse/1.0" },
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchKalshiSeriesTitle(series: string): Promise<string | null> {
  const data = await kalshiGet<{ series?: { title?: string } }>(
    `/series/${encodeURIComponent(series)}`
  );
  const title = data?.series?.title;
  return typeof title === "string" && title ? title : null;
}

export async function fetchKalshiMarketDetail(
  ticker: string
): Promise<KalshiMarketDetail | null> {
  const seriesTicker = seriesTickerFromMarketTicker(ticker);
  const [data, seriesTitle] = await Promise.all([
    kalshiGet<{ market?: Record<string, unknown> }>(
      `/markets/${encodeURIComponent(ticker)}`
    ),
    fetchKalshiSeriesTitle(seriesTicker),
  ]);
  const m = data?.market;
  if (!m) return null;

  const title =
    formatKalshiMarketDisplayTitle(
      {
        ticker: String(m.ticker ?? ticker),
        title: typeof m.title === "string" ? m.title : null,
        yes_sub_title:
          typeof m.yes_sub_title === "string" ? m.yes_sub_title : null,
        no_sub_title:
          typeof m.no_sub_title === "string" ? m.no_sub_title : null,
        market_type:
          typeof m.market_type === "string" ? m.market_type : null,
        mve_selected_legs: Array.isArray(m.mve_selected_legs)
          ? m.mve_selected_legs
          : null,
      },
      null
    ) ?? (await resolveKalshiTitle(ticker));
  const eventTicker = String(m.event_ticker ?? "");
  const resolvedSeriesTitle = seriesTitle ?? "";

  return {
    ticker: String(m.ticker ?? ticker),
    title,
    eventTicker,
    seriesTicker,
    seriesTitle: resolvedSeriesTitle,
    webUrl: kalshiWebMarketUrl({
      marketTicker: String(m.ticker ?? ticker),
      eventTicker,
      seriesTicker,
      seriesTitle: resolvedSeriesTitle || undefined,
    }),
    status: String(m.status ?? ""),
    result: String(m.result ?? ""),
    closeTime: typeof m.close_time === "string" ? m.close_time : null,
    expirationTime:
      typeof m.expiration_time === "string" ? m.expiration_time : null,
    expectedExpirationTime:
      typeof m.expected_expiration_time === "string"
        ? m.expected_expiration_time
        : null,
    openTime: typeof m.open_time === "string" ? m.open_time : null,
    rulesPrimary: String(m.rules_primary ?? ""),
    rulesSecondary: String(m.rules_secondary ?? ""),
    yesBid: parseNum(m.yes_bid_dollars),
    yesAsk: parseNum(m.yes_ask_dollars),
    noBid: parseNum(m.no_bid_dollars),
    noAsk: parseNum(m.no_ask_dollars),
    lastPrice: parseNum(m.last_price_dollars),
    volume: parseNum(m.volume_fp) ?? 0,
    volume24h: parseNum(m.volume_24h_fp) ?? 0,
    openInterest: parseNum(m.open_interest_fp) ?? 0,
    yesSubTitle: String(m.yes_sub_title ?? "Yes"),
    noSubTitle: String(m.no_sub_title ?? "No"),
    marketType: String(m.market_type ?? "binary"),
  };
}

export async function fetchKalshiOrderBook(
  ticker: string,
  depth = 8
): Promise<KalshiOrderBook | null> {
  const data = await kalshiGet<{
    orderbook_fp?: {
      yes_dollars?: [string, string][];
      no_dollars?: [string, string][];
    };
  }>(`/markets/${encodeURIComponent(ticker)}/orderbook?depth=${depth}`);

  const book = data?.orderbook_fp;
  if (!book) return null;

  const parseLevels = (rows?: [string, string][]): KalshiOrderBookLevel[] =>
    (rows ?? [])
      .map(([price, size]) => ({
        price: parseNum(price) ?? 0,
        size: parseNum(size) ?? 0,
      }))
      .filter((l) => l.price > 0 && l.size > 0);

  return {
    yes: parseLevels(book.yes_dollars),
    no: parseLevels(book.no_dollars),
  };
}

function parseCandlePrice(
  obj?: Record<string, string>
): KalshiCandlestick["price"] {
  if (!obj) {
    return { open: null, high: null, low: null, close: null, mean: null };
  }
  return {
    open: parseNum(obj.open_dollars),
    high: parseNum(obj.high_dollars),
    low: parseNum(obj.low_dollars),
    close: parseNum(obj.close_dollars),
    mean: parseNum(obj.mean_dollars),
  };
}

function parseCandleSide(
  obj?: Record<string, string>
): KalshiCandlestick["yesBid"] {
  if (!obj) {
    return { open: null, high: null, low: null, close: null };
  }
  return {
    open: parseNum(obj.open_dollars),
    high: parseNum(obj.high_dollars),
    low: parseNum(obj.low_dollars),
    close: parseNum(obj.close_dollars),
  };
}

export async function fetchKalshiCandlesticks(
  ticker: string,
  periodMinutes = 60,
  lookbackHours = 72
): Promise<KalshiCandlestick[]> {
  const series = seriesTickerFromMarketTicker(ticker);
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - lookbackHours * 3600;

  const data = await kalshiGet<{
    candlesticks?: Array<Record<string, unknown>>;
  }>(
    `/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodMinutes}`
  );

  return (data?.candlesticks ?? []).map((c) => ({
    endPeriodTs: Number(c.end_period_ts ?? 0),
    volume: parseNum(c.volume_fp) ?? 0,
    openInterest: parseNum(c.open_interest_fp) ?? 0,
    price: parseCandlePrice(c.price as Record<string, string> | undefined),
    yesBid: parseCandleSide(c.yes_bid as Record<string, string> | undefined),
    yesAsk: parseCandleSide(c.yes_ask as Record<string, string> | undefined),
  }));
}

export async function fetchKalshiTradesForTicker(
  ticker: string,
  limit = 100
): Promise<KalshiTradeDetail[]> {
  const data = await kalshiGet<{ trades?: KalshiRawTradeFields[] }>(
    `/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`
  );
  const title = await resolveKalshiTitle(ticker);
  return (data?.trades ?? [])
    .map((raw) => normalizeRawTrade(raw, title))
    .filter((t): t is KalshiTradeDetail => t != null);
}

export async function findKalshiTradeById(
  tradeId: string,
  ticker?: string
): Promise<KalshiTradeDetail | null> {
  if (ticker) {
    const trades = await fetchKalshiTradesForTicker(ticker, 200);
    const found = trades.find((t) => t.tradeId === tradeId);
    if (found) return found;
  }

  const data = await kalshiGet<{ trades?: KalshiRawTradeFields[] }>(
    `/markets/trades?limit=200`
  );
  const raw = (data?.trades ?? []).find((t) => t.trade_id === tradeId);
  if (!raw) return null;
  const title = await resolveKalshiTitle(raw.ticker);
  return normalizeRawTrade(raw, title);
}

export function computeKalshiMarketFlow(
  trades: KalshiTradeDetail[],
  minNotionalUsd = LARGE_TRADE_USD
): KalshiMarketFlow {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayStart = Math.floor(startOfDay.getTime() / 1000);

  const largeToday = trades.filter(
    (t) => t.timestamp >= dayStart && t.usdNotional >= minNotionalUsd
  );

  let yesVolume = 0;
  let noVolume = 0;
  for (const t of largeToday) {
    if (t.takerOutcomeSide === "yes") yesVolume += t.usdNotional;
    else noVolume += t.usdNotional;
  }

  const totalLargeVolume = yesVolume + noVolume;
  const yesPct =
    totalLargeVolume > 0 ? (yesVolume / totalLargeVolume) * 100 : 0;
  const noPct = totalLargeVolume > 0 ? (noVolume / totalLargeVolume) * 100 : 0;

  return {
    largeTradeCount: largeToday.length,
    yesVolume,
    noVolume,
    yesPct,
    noPct,
    totalLargeVolume,
    minNotionalUsd,
    windowLabel: `large trades today (≥ $${minNotionalUsd.toLocaleString()})`,
  };
}

export function formatKalshiContractCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return count.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Best Yes-probability estimate from a single candlestick. */
export function candlestickYesClose(c: KalshiCandlestick): number | null {
  if (c.price.close != null && c.price.close > 0) return c.price.close;
  if (c.yesBid.close != null && c.yesAsk.close != null) {
    return (c.yesBid.close + c.yesAsk.close) / 2;
  }
  if (c.yesBid.close != null && c.yesBid.close > 0) return c.yesBid.close;
  if (c.yesAsk.close != null && c.yesAsk.close > 0) return c.yesAsk.close;
  if (c.price.mean != null && c.price.mean > 0) return c.price.mean;
  return null;
}

export function kalshiYesMidFromMarket(m: KalshiMarketDetail): number | null {
  if (m.lastPrice != null && m.lastPrice > 0) return m.lastPrice;
  if (m.yesBid != null && m.yesAsk != null && m.yesBid > 0 && m.yesAsk > 0) {
    return (m.yesBid + m.yesAsk) / 2;
  }
  if (m.yesBid != null && m.yesBid > 0) return m.yesBid;
  return null;
}

/** Kalshi market tickers (e.g. KXMLBGAME-25JUN22-BOS) — not Polymarket condition IDs. */
export function isKalshiMarketTicker(id: string): boolean {
  return /^KX[A-Z0-9-]+$/i.test(id.trim());
}

export function kalshiMarketDetailToSummary(
  detail: KalshiMarketDetail
): MarketSummary {
  const probability = kalshiYesMidFromMarket(detail) ?? 0;
  const spread =
    detail.yesBid != null && detail.yesAsk != null
      ? Math.round((detail.yesAsk - detail.yesBid) * 100 * 10) / 10
      : null;

  return {
    id: detail.ticker,
    conditionId: detail.ticker,
    question: detail.title,
    probability,
    volume: detail.volume,
    spread,
    active: detail.status === "active" || detail.status === "open",
    clobTokenIds: [],
    source: "kalshi",
    rawContracts: [],
    url: detail.webUrl,
  };
}

export function feedTradeToKalshiDetail(trade: {
  id: string;
  ticker?: string;
  title: string;
  outcome: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  usdNotional: number;
  timestamp: number;
  isBlockTrade?: boolean;
}): KalshiTradeDetail | null {
  if (!trade.ticker) return null;
  const outcomeSide = trade.outcome === "Yes" ? "yes" : "no";
  const yesPrice = outcomeSide === "yes" ? trade.price : 1 - trade.price;
  const noPrice = 1 - yesPrice;

  return {
    tradeId: trade.id,
    ticker: trade.ticker,
    title: trade.title,
    createdTime: new Date(trade.timestamp * 1000).toISOString(),
    timestamp: trade.timestamp,
    count: trade.size,
    yesPrice,
    noPrice,
    price: trade.price,
    usdNotional: trade.usdNotional,
    takerSide: outcomeSide,
    takerOutcomeSide: outcomeSide,
    takerBookSide: trade.side === "SELL" ? "ask" : "bid",
    side: trade.side,
    outcome: trade.outcome as "Yes" | "No",
    isBlockTrade: trade.isBlockTrade === true,
  };
}
