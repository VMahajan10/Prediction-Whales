import { kalshiWebMarketUrl } from "@/lib/kalshiDetail";

export interface PolymarketUrlInput {
  eventSlug?: string | null;
  slug?: string | null;
  conditionId?: string | null;
  title?: string | null;
  question?: string | null;
}

export interface KalshiUrlInput {
  marketTicker?: string | null;
  eventTicker?: string | null;
  seriesTicker?: string | null;
  seriesTitle?: string | null;
  webUrl?: string | null;
  title?: string | null;
}

function polymarketTitle(input: PolymarketUrlInput): string {
  return (input.title ?? input.question ?? "").trim();
}

/** Canonical Polymarket market URL — prefers API slugs/ids over title parsing. */
export function buildPolymarketMarketUrl(input: PolymarketUrlInput): string {
  const eventSlug = input.eventSlug?.trim();
  if (eventSlug) {
    return `https://polymarket.com/event/${encodeURIComponent(eventSlug)}`;
  }

  const conditionId = input.conditionId?.trim();
  if (conditionId) {
    return `https://polymarket.com/market/${encodeURIComponent(conditionId)}`;
  }

  const slug = input.slug?.trim();
  if (slug) {
    return `https://polymarket.com/event/${encodeURIComponent(slug)}`;
  }

  const title = polymarketTitle(input);
  return `https://polymarket.com/search?q=${encodeURIComponent(title)}`;
}

export function polymarketUrlFromTrade(trade: {
  eventSlug?: string | null;
  slug?: string | null;
  conditionId?: string | null;
  title?: string | null;
}): string {
  return buildPolymarketMarketUrl({
    eventSlug: trade.eventSlug,
    slug: trade.slug,
    conditionId: trade.conditionId,
    title: trade.title,
  });
}

export function polymarketUrlFromMarket(market: {
  eventSlug?: string | null;
  slug?: string | null;
  conditionId?: string | null;
  question?: string | null;
}): string {
  return buildPolymarketMarketUrl({
    eventSlug: market.eventSlug,
    slug: market.slug,
    conditionId: market.conditionId,
    question: market.question,
  });
}

function seriesTickerFromMarketTicker(ticker: string): string {
  return ticker.split("-")[0] ?? ticker;
}

/** Canonical Kalshi market URL — prefers API tickers/webUrl over title parsing. */
export function buildKalshiMarketUrl(input: KalshiUrlInput): string {
  const webUrl = input.webUrl?.trim();
  if (webUrl) return webUrl;

  const marketTicker = input.marketTicker?.trim();
  const eventTicker = input.eventTicker?.trim();
  const title = (input.title ?? "").trim();

  if (marketTicker && eventTicker) {
    return kalshiWebMarketUrl({
      marketTicker,
      eventTicker,
      seriesTicker: input.seriesTicker?.trim() || undefined,
      seriesTitle: input.seriesTitle?.trim() || undefined,
    });
  }

  if (marketTicker) {
    const series = (
      input.seriesTicker?.trim() || seriesTickerFromMarketTicker(marketTicker)
    ).toLowerCase();
    const qs = `op_market_ticker=${encodeURIComponent(marketTicker)}`;
    return `https://kalshi.com/markets/${encodeURIComponent(series)}?${qs}`;
  }

  return `https://kalshi.com/markets?query=${encodeURIComponent(title)}`;
}

export function kalshiUrlFromMarket(market: {
  id: string;
  question?: string | null;
  url?: string | null;
  eventTicker?: string | null;
  seriesTicker?: string | null;
  seriesTitle?: string | null;
}): string {
  return buildKalshiMarketUrl({
    marketTicker: market.id,
    eventTicker: market.eventTicker,
    seriesTicker: market.seriesTicker,
    seriesTitle: market.seriesTitle,
    webUrl: market.url,
    title: market.question,
  });
}

export function hasDirectPolymarketLink(trade: {
  eventSlug?: string | null;
  slug?: string | null;
  conditionId?: string | null;
}): boolean {
  return !!(trade.eventSlug?.trim() || trade.slug?.trim() || trade.conditionId?.trim());
}
