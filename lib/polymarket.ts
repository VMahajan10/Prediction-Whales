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
  probability: number;
  volume: number;
  spread: number | null;
  active: boolean;
  clobTokenIds: string[];
  source: "polymarket" | "predictit";
  rawContracts?: Contract[];
  url?: string;
}

export type Market = MarketSummary;

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
  slug: string;
  icon: string;
  eventSlug: string;
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
  const url = `${GAMMA_API_BASE}/markets?limit=20&active=true&closed=false`;
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
  const url = `${DATA_API_BASE}/trades?limit=50`;
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
