import {
  MIN_FEED_TRADE_EV_PCT,
  MIN_PRODUCT_FEED_STAKE_USD,
} from "@/lib/feedQualification";

/** Product feed fallback row cap. */
export const FALLBACK_LIMIT = 20;

export interface FeedTradeHistoryInput {
  id: string;
  transactionHash?: string | null;
  proxyWallet?: string | null;
  title: string;
  /** Unix seconds. */
  timestamp: number;
  stakeAmountUsd: number;
  averageEvPercent: number;
  payload: unknown;
}

export function buildFeedTradeRow(input: FeedTradeHistoryInput) {
  return {
    tradeId: input.id,
    transactionHash: input.transactionHash ?? null,
    proxyWallet: input.proxyWallet?.trim().toLowerCase() ?? null,
    title: input.title,
    stakeAmount: input.stakeAmountUsd,
    averageEv: input.averageEvPercent,
    tradedAt: new Date(input.timestamp * 1000),
    payload: input.payload,
    updatedAt: new Date(),
  };
}

export function isRecordableFeedTrade(input: FeedTradeHistoryInput): boolean {
  return (
    Number.isFinite(input.stakeAmountUsd) &&
    input.stakeAmountUsd >= MIN_PRODUCT_FEED_STAKE_USD &&
    Number.isFinite(input.averageEvPercent) &&
    input.averageEvPercent >= MIN_FEED_TRADE_EV_PCT &&
    Number.isFinite(input.timestamp) &&
    input.timestamp > 0
  );
}
