import {
  meetsFeedTieredStakeThreshold,
  meetsFeedTradeEvThreshold,
  type LiveFeedQualificationTrade,
} from "@/lib/feedQualification";
import {
  diagnoseLiveFeedTradeGate,
  evaluateLiveFeedTradeGate,
  type FeedGateRejectReason,
} from "@/lib/feedGate";
import { inferCategoryBadge } from "@/lib/marketCategory";
import { logger } from "@/lib/logger";
import { normalizeFeedCategory } from "@/lib/x-agent/stakeFloor";

export type FeedFilterRejectReason =
  | FeedGateRejectReason
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

  logger.debug(
    `[Feed Filter Reject] ID: ${input.id} | Trade EV: ${tradeEv} | Stake: $${input.stakeUsd} | Category: ${category} | Reason: ${input.reason}${input.source ? ` | Source: ${input.source}` : ""}`
  );
}

export function diagnoseLiveFeedTradeRejection(
  trade: LiveFeedQualificationTrade
): FeedGateRejectReason | null {
  return diagnoseLiveFeedTradeGate(trade).reason;
}

export function logLiveFeedTradeRejection(
  trade: LiveFeedQualificationTrade & { id: string },
  source: FeedFilterRejectInput["source"] = "api"
): void {
  evaluateLiveFeedTradeGate(trade, {
    id: trade.id,
    source,
    logRejection: true,
  });
}
