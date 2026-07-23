import {
  isEphemeralClosedPosition,
  positionCostBasis,
  type CategoryStats,
} from "@/lib/polymarket";
import { buildPolymarketMarketUrl } from "@/lib/platformTradeUrls";

/** Polymarket closed-positions API max per request. */
export const CLOSED_POSITIONS_API_LIMIT = 500;

/** Default rows shown before "Load more". */
export const TRADER_HISTORY_PAGE_SIZE = 50;

export interface TraderClosedPosition {
  id: string;
  title: string;
  outcome: string;
  avgPrice: number;
  sizeUsd: number;
  realizedPnl: number;
  result: "won" | "lost" | "breakeven";
  resolvedAt: number | null;
  eventSlug?: string;
  slug?: string;
  category: string;
  excludedFromStats: boolean;
}

export interface TraderOpenPosition {
  id: string;
  title: string;
  outcome: string;
  avgPrice: number;
  sizeUsd: number;
  currentPrice: number;
  unrealizedPnl: number;
  percentPnl: number | null;
  eventSlug?: string;
  slug?: string;
}

function closedResult(pnl: number): TraderClosedPosition["result"] {
  if (pnl > 0) return "won";
  if (pnl < 0) return "lost";
  return "breakeven";
}

function positionId(raw: {
  asset?: string;
  conditionId?: string;
  slug?: string;
}): string {
  return String(raw.asset ?? raw.conditionId ?? raw.slug ?? "unknown");
}

export function normalizeClosedPositions(
  closedPositions: unknown[],
  slugToCategory: Record<string, string> = {}
): TraderClosedPosition[] {
  const rows: TraderClosedPosition[] = [];

  for (const raw of closedPositions) {
    const p = raw as Record<string, unknown>;
    const excluded = isEphemeralClosedPosition({
      slug: p.slug as string | undefined,
      eventSlug: p.eventSlug as string | undefined,
      title: p.title as string | undefined,
    });
    const realizedPnl = Number(p.realizedPnl ?? 0);
    const eventSlug = (p.eventSlug as string | undefined) ?? undefined;
    const timestamp = p.timestamp;
    const resolvedAt =
      typeof timestamp === "number" && Number.isFinite(timestamp)
        ? timestamp
        : null;

    rows.push({
      id: positionId(p as { asset?: string; conditionId?: string; slug?: string }),
      title: String(p.title ?? "Unknown market"),
      outcome: String(p.outcome ?? "—"),
      avgPrice: Number(p.avgPrice ?? 0),
      sizeUsd: positionCostBasis(p as Parameters<typeof positionCostBasis>[0]),
      realizedPnl,
      result: closedResult(realizedPnl),
      resolvedAt,
      eventSlug,
      slug: (p.slug as string | undefined) ?? undefined,
      category: eventSlug ? (slugToCategory[eventSlug] ?? "Other") : "Other",
      excludedFromStats: excluded,
    });
  }

  return rows.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
}

/** Active open bet — excludes redeemable / fully settled rows still in /positions. */
export function isActiveOpenPosition(raw: unknown): boolean {
  const p = raw as Record<string, unknown>;
  const size = Number(p.size ?? 0);
  const curPrice = Number(p.curPrice ?? 0);
  const redeemable = p.redeemable === true;
  if (size <= 0) return false;
  if (redeemable && curPrice <= 0) return false;
  if (curPrice <= 0 || curPrice >= 1) return false;
  return true;
}

export function normalizeOpenPositions(
  openPositions: unknown[]
): TraderOpenPosition[] {
  const rows: TraderOpenPosition[] = [];

  for (const raw of openPositions) {
    if (!isActiveOpenPosition(raw)) continue;
    const p = raw as Record<string, unknown>;
    const cashPnl = Number(p.cashPnl ?? 0);
    const percentPnlRaw = p.percentPnl;

    rows.push({
      id: positionId(p as { asset?: string; conditionId?: string; slug?: string }),
      title: String(p.title ?? "Unknown market"),
      outcome: String(p.outcome ?? "—"),
      avgPrice: Number(p.avgPrice ?? 0),
      sizeUsd: positionCostBasis(p as Parameters<typeof positionCostBasis>[0]),
      currentPrice: Number(p.curPrice ?? 0),
      unrealizedPnl: cashPnl,
      percentPnl:
        typeof percentPnlRaw === "number" && Number.isFinite(percentPnlRaw)
          ? percentPnlRaw
          : null,
      eventSlug: (p.eventSlug as string | undefined) ?? undefined,
      slug: (p.slug as string | undefined) ?? undefined,
    });
  }

  return rows.sort(
    (a, b) => Math.abs(b.unrealizedPnl) - Math.abs(a.unrealizedPnl)
  );
}

export function formatTraderPnl(n: number): string {
  const sign = n >= 0 ? "+" : "";
  if (Math.abs(n) >= 1_000_000) {
    return `${sign}$${(n / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(n) >= 1_000) {
    return `${sign}$${n.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  }
  return `${sign}$${n.toFixed(2)}`;
}

export function formatTraderPrice(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

export function formatResolvedDate(timestamp: number | null): string {
  if (!timestamp) return "—";
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function polymarketPositionUrl(position: {
  eventSlug?: string;
  slug?: string;
  conditionId?: string;
  title: string;
}): string {
  return buildPolymarketMarketUrl({
    eventSlug: position.eventSlug,
    slug: position.slug,
    conditionId: position.conditionId,
    title: position.title,
  });
}

export type { CategoryStats };
