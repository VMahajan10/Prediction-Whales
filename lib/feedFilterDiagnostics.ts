import {
  meetsFeedTieredStakeThreshold,
  meetsFeedTradeEvThreshold,
  type LiveFeedQualificationTrade,
} from "@/lib/feedQualification";
import { inferCategoryBadge } from "@/lib/marketCategory";
import { normalizeFeedCategory } from "@/lib/x-agent/stakeFloor";

export type FeedFilterRejectReason =
  | "stake_floor"
  | "trade_ev"
  | "missing_trade_ev"
  | "wallet_avg_ev"
  | "resolved_bets"
  | "missing_wallet"
  | "not_translatable"
  | "missing_asset";

export interface FeedFilterRejectInput {
  id: string;
  stakeUsd: number;
  /** Trade-level EV at entry — NOT wallet historical avg. */
  tradeEvPercent?: number | null;
  title?: string | null;
  slug?: string | null;
  eventSlug?: string | null;
  category?: string | null;
  reason: FeedFilterRejectReason;
  source?: "api" | "socket" | "client";
}

/** Case-insensitive feed category label for logs and stake tiers. */
export function resolveFeedFilterCategoryLabel(input: {
  title?: string | null;
  category?: string | null;
}): string {
  const normalized = normalizeFeedCategory(input.category);
  if (normalized) return normalized;
  return inferCategoryBadge(input.title ?? "").label.toLowerCase();
}

/** Temporary diagnostic — why a trade failed feed qualification. */
export function logFeedFilterReject(input: FeedFilterRejectInput): void {
  const category = resolveFeedFilterCategoryLabel(input);
  const tradeEv =
    input.tradeEvPercent != null && Number.isFinite(input.tradeEvPercent)
      ? `${input.tradeEvPercent}%`
      : "N/A";

  console.log(
    `[Feed Filter Reject] ID: ${input.id} | Trade EV: ${tradeEv} | Stake: $${input.stakeUsd} | Category: ${category} | Reason: ${input.reason}${input.source ? ` | Source: ${input.source}` : ""}`
  );
}

export function diagnoseLiveFeedTradeRejection(
  trade: LiveFeedQualificationTrade
): FeedFilterRejectReason | null {
  if (
    !meetsFeedTieredStakeThreshold({
      stakeUsd: trade.stakeUsd,
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
      category: trade.category,
    })
  ) {
    return "stake_floor";
  }

  if (trade.tradeEvPercent == null || !Number.isFinite(trade.tradeEvPercent)) {
    return "missing_trade_ev";
  }

  if (!meetsFeedTradeEvThreshold(trade.tradeEvPercent)) {
    return "trade_ev";
  }

  return null;
}

export function logLiveFeedTradeRejection(
  trade: LiveFeedQualificationTrade & { id: string },
  source: FeedFilterRejectInput["source"] = "api"
): void {
  const reason = diagnoseLiveFeedTradeRejection(trade);
  if (!reason) return;

  logFeedFilterReject({
    id: trade.id,
    stakeUsd: trade.stakeUsd,
    tradeEvPercent: trade.tradeEvPercent,
    title: trade.title,
    slug: trade.slug,
    eventSlug: trade.eventSlug,
    category: trade.category ?? resolveFeedFilterCategoryLabel(trade),
    reason,
    source,
  });
}
