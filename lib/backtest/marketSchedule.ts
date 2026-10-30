import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { mergeOutboundHeaders } from "@/lib/outboundHttp";
import { isSportsMarketProbe } from "@/lib/evPipeline/sportsSlugParse";
import { POLYMARKET_GAMMA_API_BASE } from "@/lib/walletLedger/constants";
import type { MarketResolution } from "@/lib/backtest/types";

const JSON_HEADERS = mergeOutboundHeaders({ Accept: "application/json" });

export interface MarketSchedule {
  conditionId: string;
  isSports: boolean;
  /** Last timestamp eligible for closing-line trades (exclusive upper bound for tape). */
  closingCutoffUnix: number | null;
  tradingEndsAtUnix: number | null;
  gameStartUnix: number | null;
  eventSlug: string | null;
  marketSlug: string | null;
}

export interface ClosingLinePolicyConfig {
  /** Hours before trading ends (non-sports). Default 1. */
  preTradingEndHours: number;
  vwapTradeCount: number;
  minTapeTrades: number;
}

export const DEFAULT_CLOSING_LINE_POLICY: ClosingLinePolicyConfig = {
  preTradingEndHours: 1,
  vwapTradeCount: 10,
  minTapeTrades: 3,
};

interface GammaScheduleRow {
  conditionId?: string;
  slug?: string;
  endDate?: string | null;
  closedTime?: string | null;
  gameStartTime?: string | null;
  events?: Array<{ slug?: string; startTime?: string }>;
}

function parseUnix(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

async function fetchGammaBySlug(slug: string): Promise<GammaScheduleRow | null> {
  const params = new URLSearchParams({ slug, limit: "3" });
  const url = `${POLYMARKET_GAMMA_API_BASE}/markets?${params.toString()}`;
  try {
    const res = await fetchWithTimeout(url, { headers: JSON_HEADERS });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data) || data.length === 0) return null;
    return data[0] as GammaScheduleRow;
  } catch {
    return null;
  }
}

async function fetchGammaScheduleRow(
  conditionId: string,
  marketSlug?: string | null
): Promise<GammaScheduleRow | null> {
  const params = new URLSearchParams({
    condition_ids: conditionId,
    limit: "5",
  });
  const url = `${POLYMARKET_GAMMA_API_BASE}/markets?${params.toString()}`;
  try {
    const res = await fetchWithTimeout(url, { headers: JSON_HEADERS });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data) || data.length === 0) return null;
    const row = data.find(
      (m: GammaScheduleRow) =>
        m.conditionId?.toLowerCase() === conditionId.toLowerCase()
    ) as GammaScheduleRow | undefined;
    const picked = row ?? (data[0] as GammaScheduleRow);
    if (picked?.conditionId || picked?.endDate) return picked;
  } catch {
    // fall through
  }
  if (marketSlug) {
    return fetchGammaBySlug(marketSlug);
  }
  return null;
}

async function fetchEventStart(eventSlug: string): Promise<number | null> {
  const url = `${POLYMARKET_GAMMA_API_BASE}/events?slug=${encodeURIComponent(eventSlug)}&limit=1`;
  try {
    const res = await fetchWithTimeout(url, { headers: JSON_HEADERS });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ startTime?: string }>;
    return parseUnix(data[0]?.startTime ?? null);
  } catch {
    return null;
  }
}

export async function resolveMarketSchedule(
  resolution: MarketResolution,
  hints: { eventSlug?: string | null; marketSlug?: string | null },
  policy: ClosingLinePolicyConfig = DEFAULT_CLOSING_LINE_POLICY
): Promise<MarketSchedule> {
  const conditionId = resolution.conditionId;
  const row = await fetchGammaScheduleRow(
    conditionId,
    hints.marketSlug ?? null
  );
  const marketSlug = hints.marketSlug ?? row?.slug ?? null;
  const title = resolution.marketTitle ?? "";
  const isSports = isSportsMarketProbe(marketSlug, title);

  const tradingEndsAtUnix =
    parseUnix(row?.closedTime) ??
    parseUnix(row?.endDate) ??
    resolution.resolvedAt;

  let gameStartUnix =
    parseUnix(row?.gameStartTime) ?? null;
  const eventSlug = hints.eventSlug ?? null;
  if (isSports && eventSlug && !gameStartUnix) {
    gameStartUnix = await fetchEventStart(eventSlug);
  }

  let closingCutoffUnix: number | null = null;
  if (isSports) {
    closingCutoffUnix = gameStartUnix;
  } else if (tradingEndsAtUnix != null) {
    closingCutoffUnix =
      tradingEndsAtUnix - policy.preTradingEndHours * 3600;
  }

  return {
    conditionId,
    isSports,
    closingCutoffUnix,
    tradingEndsAtUnix,
    gameStartUnix,
    eventSlug,
    marketSlug,
  };
}
