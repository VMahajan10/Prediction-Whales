import {
  X_POST_REJECTION_REASONS,
  type XPostRejectionReason,
} from "@/lib/types/xPostRejection";

export const GATE_REJECTION_REASONS = X_POST_REJECTION_REASONS;

export type GateRejectionReason = XPostRejectionReason;

export interface TradePayload {
  source: "polymarket" | "kalshi";
  tradeId: string;
  walletAddress: string;
  stakeNotional: number;
  /** Unix epoch seconds. */
  timestamp: number;
  entryCents: number;
  nowCents: number;
  title: string;
  outcome: string;
  side: "BUY" | "SELL";
  marketSlug: string;
  slug?: string | null;
  eventSlug?: string | null;
}
