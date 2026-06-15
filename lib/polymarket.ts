const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
const DATA_API_BASE = "https://data-api.polymarket.com";

/** Raw market object from Gamma API */
export interface GammaMarket {
  id: string;
  question: string | null;
  conditionId: string;
  slug: string | null;
  outcomes: string;
  outcomePrices: string;
  volume: string;
  volumeNum?: number;
  active: boolean;
  closed: boolean;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  lastTradePrice?: number;
  liquidity?: string;
  endDate?: string;
  clobTokenIds: string | string[];
  events?: Array<{ slug?: string | null }>;
}

export interface Contract {
  id: number;
  name: string;
  status: string;
  lastTradePrice: number;
  bestBuyYesCost: number;
  bestSellYesCost: number;
}

/** Normalized market for UI */
export interface MarketSummary {
  id: string;
  conditionId: string;
  question: string;
  slug?: string;
  eventSlug?: string;
  probability: number;
  volume: number;
  spread: number | null;
  active: boolean;
  clobTokenIds: string[];
  source: "polymarket" | "kalshi";
  rawContracts?: Contract[];
  url?: string;
}

export type Market = MarketSummary;

export function toPolymarketSlug(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

/** Raw trade from Data API */
export interface DataTrade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug?: string;
  icon?: string;
  eventSlug?: string;
  outcome: string;
  outcomeIndex: number;
  name: string;
  pseudonym: string;
  transactionHash: string;
}

export interface TradeSummary {
  id: string;
  title: string;
  side: "BUY" | "SELL";
  outcome: string;
  price: number;
  size: number;
  timestamp: number;
  transactionHash: string;
  proxyWallet?: string;
  assetId?: string;
  eventSlug?: string;
  slug?: string;
  conditionId?: string;
}

export interface TrackRecord {
  winRate: number | null;
  avgReturnPerBet: number | null;
  totalBets: number;
  closedCount: number;
  totalRealizedPnl: number;
  hasEnoughHistory: boolean;
  excludedEphemeralCount: number;
}

export interface WhaleTrackRecordResult {
  wallet: string | null;
  trackRecord: TrackRecord | null;
  openPositionCount: number;
  resolved: boolean;
}

export function getPolymarketTradeUrl(
  trade: Pick<TradeSummary, "eventSlug" | "slug" | "title">
): string {
  const eventSlug = trade.eventSlug ?? trade.slug;
  if (eventSlug) {
    return `https://polymarket.com/event/${eventSlug}`;
  }
  return `https://polymarket.com/markets?q=${encodeURIComponent(trade.title ?? "")}`;
}

export function hasDirectPolymarketLink(
  trade: Pick<TradeSummary, "eventSlug" | "slug">
): boolean {
  return !!(trade.eventSlug ?? trade.slug);
}

export interface TokenMarketMeta {
  title: string;
  outcome: string;
  eventSlug?: string;
  slug?: string;
  conditionId: string;
  marketId: string;
}

export interface TokenRegistry {
  tokenIds: string[];
  tokens: Record<string, TokenMarketMeta>;
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed as T[];
    }
    return [];
  } catch {
    return [];
  }
}

export function parseOutcomePrices(outcomePrices: string): number[] {
  const raw = parseJsonArray<string | number>(outcomePrices);
  return raw.map((p) => (typeof p === "string" ? parseFloat(p) : p));
}

/** Primary probability: first outcome (typically "Yes") */
export function getPrimaryProbability(outcomePrices: string): number {
  const prices = parseOutcomePrices(outcomePrices);
  if (prices.length === 0) return 0;
  return prices[0];
}

export function normalizeMarket(raw: GammaMarket): MarketSummary {
  const volume =
    raw.volumeNum ?? (raw.volume ? parseFloat(raw.volume) : 0);
  const spread =
    raw.spread ??
    (raw.bestBid != null && raw.bestAsk != null
      ? raw.bestAsk - raw.bestBid
      : null);

  const clobTokenIds = Array.isArray(raw.clobTokenIds)
    ? raw.clobTokenIds.map(String)
    : parseJsonArray<string>(raw.clobTokenIds);

  return {
    id: raw.id,
    conditionId: raw.conditionId,
    clobTokenIds,
    question: raw.question ?? "Untitled market",
    slug: raw.slug ?? undefined,
    eventSlug: raw.events?.[0]?.slug ?? undefined,
    probability: getPrimaryProbability(raw.outcomePrices),
    volume: Number.isFinite(volume) ? volume : 0,
    spread:
      spread != null && Number.isFinite(spread)
        ? Math.round(spread * 100 * 10) / 10
        : null,
    active: raw.active,
    source: "polymarket",
  };
}

export function normalizeTrade(raw: DataTrade, index: number): TradeSummary {
  return {
    id: `${raw.transactionHash}-${index}`,
    title: raw.title,
    side: raw.side,
    outcome: raw.outcome,
    price: raw.price,
    size: raw.size,
    timestamp: raw.timestamp,
    transactionHash: raw.transactionHash,
    proxyWallet: raw.proxyWallet ?? undefined,
    eventSlug: raw.eventSlug || undefined,
    slug: raw.slug || undefined,
    conditionId: raw.conditionId || undefined,
  };
}

export async function fetchClosedPositions(
  wallet: string
): Promise<any[]> {
  try {
    const res = await fetch(
      `https://data-api.polymarket.com/closed-positions?user=${wallet}&limit=500`,
      { next: { revalidate: 300 } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function fetchWalletPositions(
  wallet: string
): Promise<any[]> {
  try {
    const res = await fetch(
      `https://data-api.polymarket.com/positions?user=${wallet}`,
      { next: { revalidate: 5 } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function computeTrackRecord(
  closedPositions: any[]
): TrackRecord {
  const eligible = closedPositions.filter(
    (p) => !isEphemeralClosedPosition(p)
  );
  const excludedEphemeralCount = closedPositions.length - eligible.length;

  const closed = eligible.filter(
    (p) => p.realizedPnl !== undefined && p.realizedPnl !== 0
  );

  const wins = closed.filter((p) => p.realizedPnl > 0);
  const totalPnl = closed.reduce(
    (sum, p) => sum + (p.realizedPnl ?? 0),
    0
  );

  return {
    winRate:
      closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    avgReturnPerBet:
      closed.length > 0 ? totalPnl / closed.length : null,
    totalBets: eligible.length,
    closedCount: closed.length,
    totalRealizedPnl: totalPnl,
    hasEnoughHistory: closed.length >= 5,
    excludedEphemeralCount,
  };
}

/** Short-term crypto up/down bots skew win-rate stats — exclude from track record. */
export function isEphemeralClosedPosition(position: {
  slug?: string;
  eventSlug?: string;
  title?: string;
}): boolean {
  const text = [position.slug, position.eventSlug, position.title]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!text) return false;

  if (
    /btc[- ]?up[- ]?down|bitcoin up or down|eth[- ]?up[- ]?down|ethereum up or down|sol[- ]?up[- ]?down/.test(
      text
    )
  ) {
    return true;
  }

  if (
    /up[- ]?or[- ]?down/.test(text) &&
    /\d{1,2}:\d{2}\s*(am|pm)?\s*[-–]\s*\d{1,2}:\d{2}/.test(text)
  ) {
    return true;
  }

  if (/updown[-_]?\d+m|\d+m[-_]updown|updown[-_]?\d+min/.test(text)) {
    return true;
  }

  return false;
}

/** Resolve proxyWallet for a trade hash via the Data API (CDN-cached). */
export async function resolveWalletByTradeHash(
  hash: string,
  assetId?: string
): Promise<string | null> {
  const normalized = hash.toLowerCase();

  if (assetId) {
    try {
      const res = await fetch(
        `${DATA_API_BASE}/trades?asset=${encodeURIComponent(assetId)}&limit=100&sortBy=timestamp`,
        { headers: { Accept: "application/json" }, next: { revalidate: 0 } }
      );
      if (res.ok) {
        const data: unknown = await res.json();
        if (Array.isArray(data)) {
          const match = (data as DataTrade[]).find(
            (t) => t.transactionHash?.toLowerCase() === normalized
          );
          if (match?.proxyWallet) return match.proxyWallet.toLowerCase();
        }
      }
    } catch {
      // Fall through to global scan
    }
  }

  const urls = [
    `${DATA_API_BASE}/trades?limit=500&sortBy=timestamp`,
    `${DATA_API_BASE}/trades?limit=200`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        next: { revalidate: 0 },
      });
      if (!res.ok) continue;

      const data: unknown = await res.json();
      if (!Array.isArray(data)) continue;

      const match = (data as DataTrade[]).find(
        (t) => t.transactionHash?.toLowerCase() === normalized
      );
      if (match?.proxyWallet) return match.proxyWallet.toLowerCase();
    } catch {
      continue;
    }
  }

  return null;
}

export async function buildWhaleTrackRecord(
  wallet: string
): Promise<WhaleTrackRecordResult> {
  const [closedPositions, openPositions] = await Promise.all([
    fetchClosedPositions(wallet),
    fetchWalletPositions(wallet),
  ]);

  return {
    wallet,
    trackRecord: computeTrackRecord(closedPositions),
    openPositionCount: openPositions.length,
    resolved: true,
  };
}

export function formatVolumeUsd(volume: number): string {
  if (volume >= 1_000_000) {
    return `$${(volume / 1_000_000).toFixed(1)}M`;
  }
  if (volume >= 1_000) {
    return `$${Math.round(volume / 1_000)}k`;
  }
  return `$${Math.round(volume)}`;
}

export function formatProbability(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

export function formatSpread(spread: number | null): string {
  if (spread == null) return "—";
  return `${(spread * 100).toFixed(1)}¢`;
}

export async function fetchMarkets(): Promise<MarketSummary[]> {
  const url = `${GAMMA_API_BASE}/markets?limit=100&active=true&closed=false`;
  console.log("Fetching markets from:", url);
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    throw new Error(`Gamma API error: ${res.status} ${res.statusText}`);
  }

  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("Gamma API returned invalid markets payload");
  }

  return (data as GammaMarket[]).map(normalizeMarket);
}

export async function fetchTrades(): Promise<TradeSummary[]> {
  const url = `${DATA_API_BASE}/trades?limit=200`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    throw new Error(`Data API error: ${res.status} ${res.statusText}`);
  }

  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("Data API returned invalid trades payload");
  }

  return (data as DataTrade[]).map((trade, i) => normalizeTrade(trade, i));
}

export async function fetchWhaleBackfill(): Promise<TradeSummary[]> {
  const url = `${DATA_API_BASE}/trades?limit=100&filterType=CASH&filterAmount=500`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    throw new Error(`Data API error: ${res.status} ${res.statusText}`);
  }

  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("Data API returned invalid trades payload");
  }

  return (data as DataTrade[]).map((trade, i) => normalizeTrade(trade, i));
}

export async function fetchTokenRegistry(): Promise<TokenRegistry> {
  const url = `${GAMMA_API_BASE}/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    throw new Error(`Gamma API error: ${res.status} ${res.statusText}`);
  }

  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("Gamma API returned invalid markets payload");
  }

  const tokenIds: string[] = [];
  const tokens: Record<string, TokenMarketMeta> = {};

  for (const raw of data as GammaMarket[]) {
    const market = normalizeMarket(raw);
    const outcomes = parseJsonArray<string>(raw.outcomes);
    const ids = market.clobTokenIds;

    ids.forEach((tokenId, index) => {
      if (!tokenId || tokens[tokenId]) return;
      tokenIds.push(tokenId);
      tokens[tokenId] = {
        title: market.question,
        outcome: outcomes[index] ?? `Outcome ${index + 1}`,
        eventSlug: market.eventSlug,
        slug: market.slug,
        conditionId: market.conditionId,
        marketId: market.id,
      };
    });
  }

  return { tokenIds, tokens };
}
