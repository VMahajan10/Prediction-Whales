import {
  CLV_CONSTANTS,
  mapWithConcurrency,
  resolveClosingLine,
  type ClosingLineResult,
} from "./clvPriceHistory";

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
const DATA_API_BASE = "https://data-api.polymarket.com";

export type { ClosingLineResult } from "./clvPriceHistory";

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
  /** Resolved closed positions with non-zero P&L. */
  closedWins: number;
  avgReturnPerBet: number | null;
  totalBets: number;
  closedCount: number;
  totalRealizedPnl: number;
  totalInvested: number;
  roi: number | null;
  hasEnoughHistory: boolean;
  excludedEphemeralCount: number;
}

export interface CategoryStats {
  category: string;
  bets: number;
  winRate: number;
  staked: number;
  pnl: number;
  roi: number;
  lowSample: boolean;
}

export interface ClvStats {
  avgClv: number | null;
  weightedClv: number | null;
  showWeighted: boolean;
  coverage: number;
  totalClosed: number;
  hasEnoughCoverage: boolean;
  coverageFloor: number;
  positions?: ClosingLineResult[];
}

export interface WhaleTrackRecordResult {
  wallet: string | null;
  trackRecord: TrackRecord | null;
  openPositionCount: number;
  resolved: boolean;
  categoryStats: CategoryStats[];
  clvStats: ClvStats;
}

const CATEGORY_PRIORITY = [
  "Politics",
  "Crypto",
  "Sports",
  "Esports",
  "Economy",
  "Entertainment",
];

function toBucket(tags: string[]): string {
  if (!tags?.length) return "Other";
  for (const cat of CATEGORY_PRIORITY) {
    if (tags.some((t) => t.toLowerCase() === cat.toLowerCase())) return cat;
  }
  return "Other";
}

function tagLabels(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => {
      if (typeof t === "string") return t;
      if (t && typeof t === "object" && "label" in t) {
        return String((t as { label?: string }).label ?? "");
      }
      return "";
    })
    .filter(Boolean);
}

export async function fetchEventCategories(
  slugs: string[]
): Promise<Record<string, string>> {
  if (!slugs.length) return {};
  const unique = Array.from(new Set(slugs));
  const map: Record<string, string> = {};

  try {
    const params = unique.map((s) => `slug=${encodeURIComponent(s)}`).join("&");
    const res = await fetch(
      `https://gamma-api.polymarket.com/events?${params}`,
      { next: { revalidate: 3600 } }
    );
    if (res.ok) {
      const events = await res.json();
      for (const ev of Array.isArray(events) ? events : []) {
        if (ev.slug) {
          map[ev.slug] = toBucket(tagLabels(ev.tags));
        }
      }
    }

    const missing = unique.filter((s) => !map[s]);
    if (missing.length > 0) {
      const retryParams = missing
        .map((s) => `slug=${encodeURIComponent(s)}`)
        .join("&");
      const retry = await fetch(
        `https://gamma-api.polymarket.com/events?${retryParams}&closed=false`,
        { next: { revalidate: 3600 } }
      );
      if (retry.ok) {
        const events = await retry.json();
        for (const ev of Array.isArray(events) ? events : []) {
          if (ev.slug) map[ev.slug] = toBucket(tagLabels(ev.tags));
        }
      }
    }
  } catch {
    // Fall through — unmapped slugs become Other
  }

  for (const s of unique) {
    if (!map[s]) map[s] = "Other";
  }
  return map;
}

export function computeCategoryStats(
  closedPositions: any[],
  slugToCategory: Record<string, string>
): CategoryStats[] {
  const buckets: Record<string, any[]> = {};

  for (const p of closedPositions) {
    if (p.realizedPnl === undefined || p.realizedPnl === 0) continue;
    const cat = slugToCategory[p.eventSlug] ?? "Other";
    if (!buckets[cat]) buckets[cat] = [];
    buckets[cat].push(p);
  }

  const stats: CategoryStats[] = [];
  for (const [category, positions] of Object.entries(buckets)) {
    const staked = positions.reduce((s, p) => s + (p.totalBought ?? 0), 0);
    const pnl = positions.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
    const wins = positions.filter((p) => p.realizedPnl > 0).length;
    stats.push({
      category,
      bets: positions.length,
      winRate: positions.length > 0 ? (wins / positions.length) * 100 : 0,
      staked,
      pnl,
      roi: staked > 0 ? (pnl / staked) * 100 : 0,
      lowSample: positions.length < 5,
    });
  }

  const shown = stats.filter((s) => s.bets >= 3);
  const small = stats.filter((s) => s.bets < 3);
  if (small.length > 0) {
    const otherStaked = small.reduce((s, c) => s + c.staked, 0);
    const otherPnl = small.reduce((s, c) => s + c.pnl, 0);
    const otherBets = small.reduce((s, c) => s + c.bets, 0);
    const otherWins = small.reduce(
      (s, c) => s + Math.round((c.winRate / 100) * c.bets),
      0
    );
    if (otherBets > 0) {
      shown.push({
        category: "Other",
        bets: otherBets,
        winRate: otherBets > 0 ? (otherWins / otherBets) * 100 : 0,
        staked: otherStaked,
        pnl: otherPnl,
        roi: otherStaked > 0 ? (otherPnl / otherStaked) * 100 : 0,
        lowSample: true,
      });
    }
  }

  const merged = new Map<string, CategoryStats>();
  for (const stat of shown) {
    const existing = merged.get(stat.category);
    if (existing) {
      const totalStaked = existing.staked + stat.staked;
      const totalPnl = existing.pnl + stat.pnl;
      const totalBets = existing.bets + stat.bets;
      const totalWins =
        (existing.winRate / 100) * existing.bets +
        (stat.winRate / 100) * stat.bets;
      merged.set(stat.category, {
        category: stat.category,
        bets: totalBets,
        winRate: totalBets > 0 ? (totalWins / totalBets) * 100 : 0,
        staked: totalStaked,
        pnl: totalPnl,
        roi: totalStaked > 0 ? (totalPnl / totalStaked) * 100 : 0,
        lowSample: totalBets < 5,
      });
    } else {
      merged.set(stat.category, { ...stat });
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.roi - a.roi);
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

export const TRACK_RECORD_RELIABILITY_FLOOR = 5;

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
  const totalInvested = closed.reduce(
    (sum, p) => sum + (p.totalBought ?? 0),
    0
  );
  const roi =
    totalInvested > 0 ? (totalPnl / totalInvested) * 100 : null;

  return {
    winRate:
      closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    closedWins: wins.length,
    avgReturnPerBet:
      closed.length > 0 ? totalPnl / closed.length : null,
    totalBets: eligible.length,
    closedCount: closed.length,
    totalRealizedPnl: totalPnl,
    totalInvested,
    roi,
    hasEnoughHistory: closed.length >= TRACK_RECORD_RELIABILITY_FLOOR,
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

export async function computeClvStats(
  closedPositions: any[]
): Promise<ClvStats> {
  const resolved = closedPositions.filter(
    (p) => p.curPrice === 0 || p.curPrice === 1
  );
  const totalClosed = resolved.length;
  const coverageFloor = CLV_CONSTANTS.COVERAGE_FLOOR;

  if (totalClosed === 0) {
    return {
      avgClv: null,
      weightedClv: null,
      showWeighted: false,
      coverage: 0,
      totalClosed: 0,
      hasEnoughCoverage: false,
      coverageFloor,
      positions: [],
    };
  }

  const positions = await mapWithConcurrency(
    resolved,
    CLV_CONSTANTS.FETCH_CONCURRENCY,
    async (p): Promise<ClosingLineResult> => {
      const settled = p.curPrice as 0 | 1;
      const avgPrice = p.avgPrice ?? 0;
      const asset = String(p.asset ?? "");
      const title = p.title ?? "Unknown market";
      const totalBought = p.totalBought ?? 0;

      if (!asset) {
        return {
          asset,
          title,
          totalBought,
          avgPrice,
          settlement: settled,
          closingLine: null,
          clv: null,
          freshnessHours: null,
          valid: false,
          reason: "bad_entry",
        };
      }

      const detected = await resolveClosingLine(asset, settled, avgPrice);
      return {
        asset,
        title,
        totalBought,
        ...detected,
      };
    }
  );

  const valid = positions.filter((p) => p.valid && p.clv != null);
  const coverage = valid.length;

  if (coverage === 0) {
    return {
      avgClv: null,
      weightedClv: null,
      showWeighted: false,
      coverage: 0,
      totalClosed,
      hasEnoughCoverage: false,
      coverageFloor,
      positions,
    };
  }

  const avgClv =
    valid.reduce((sum, p) => sum + (p.clv ?? 0), 0) / valid.length;

  const totalStaked = valid.reduce((sum, p) => sum + p.totalBought, 0);
  const weightedClv =
    totalStaked > 0
      ? valid.reduce(
          (sum, p) => sum + (p.clv ?? 0) * p.totalBought,
          0
        ) / totalStaked
      : null;

  const showWeighted =
    weightedClv != null &&
    Math.abs(avgClv - weightedClv) >= CLV_CONSTANTS.WEIGHTED_DIFF_THRESHOLD;

  return {
    avgClv,
    weightedClv,
    showWeighted,
    coverage,
    totalClosed,
    hasEnoughCoverage: coverage >= coverageFloor,
    coverageFloor,
    positions,
  };
}

export async function buildWhaleTrackRecord(
  wallet: string
): Promise<WhaleTrackRecordResult> {
  const [closedPositions, openPositions] = await Promise.all([
    fetchClosedPositions(wallet),
    fetchWalletPositions(wallet),
  ]);

  const eligible = closedPositions.filter(
    (p) => !isEphemeralClosedPosition(p)
  );
  const slugs = eligible
    .map((p) => p.eventSlug as string | undefined)
    .filter((s): s is string => !!s);
  const slugToCategory = await fetchEventCategories(slugs);
  const categoryStats = computeCategoryStats(eligible, slugToCategory);
  const clvStats = await computeClvStats(eligible);

  return {
    wallet,
    trackRecord: computeTrackRecord(closedPositions),
    openPositionCount: openPositions.length,
    resolved: true,
    categoryStats,
    clvStats,
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
