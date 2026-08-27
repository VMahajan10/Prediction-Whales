import type { FeedTrade } from "@/lib/feedTradeTypes";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  MIN_FEED_TRADE_EV_PCT,
  MIN_PRODUCT_FEED_STAKE_USD,
} from "@/lib/feedQualification";
import { logger } from "@/lib/logger";

export function logKalshiPollIngested(rawCount: number): void {
  logger.routineDebug(
    `[Kalshi Poll] Ingested ${rawCount} raw trades from Kalshi API`
  );
}

export function logKalshiStakeDrop(
  trade: Pick<FeedTrade, "id" | "ticker" | "usdNotional">
): void {
  const stake = trade.usdNotional ?? 0;
  logger.routineDebug(
    `[Kalshi Gate Drop] Stake $${stake.toFixed(2)} < $${MIN_PRODUCT_FEED_STAKE_USD} threshold for ticker ${trade.ticker ?? "unknown"} (id=${trade.id})`
  );
}

export function logKalshiEvCheck(
  trade: Pick<FeedTrade, "ticker">,
  pipeline: PipelineTradeEv | null,
  netEvPercent: number | null
): void {
  logger.routineDebug(
    `[Kalshi EV Check] Ticker: ${trade.ticker ?? "unknown"} | Net EV: ${formatTraceEv(netEvPercent)} | Status: ${pipeline?.status ?? "missing"} | pipelineNetEv=${formatTraceEv(pipeline?.netEvPercent ?? null)} | pmMid=${pipeline?.pmMid ?? "n/a"} | kalshiMid=${pipeline?.kalshiMid ?? "n/a"} | pMarket=${pipeline?.pMarket ?? "n/a"}`
  );
}

export function logKalshiEvGateDrop(
  trade: Pick<FeedTrade, "ticker">,
  netEvPercent: number | null
): void {
  logger.routineDebug(
    `[Kalshi Gate Drop] EV ${formatTraceEv(netEvPercent)} < ${MIN_FEED_TRADE_EV_PCT}% threshold for ticker ${trade.ticker ?? "unknown"}`
  );
}

export function logKalshiGatePass(
  trade: Pick<FeedTrade, "ticker" | "usdNotional">,
  netEvPercent: number
): void {
  const stake = trade.usdNotional ?? 0;
  logger.routineDebug(
    `[Kalshi Gate PASS] Trade qualified for feed: ${trade.ticker ?? "unknown"} ($${stake.toFixed(2)}, ${netEvPercent.toFixed(2)}% EV)`
  );
}

export function logKalshiShadowQueued(
  trade: Pick<FeedTrade, "id" | "ticker">,
  netEvPercent: number | null
): void {
  const evLabel =
    netEvPercent != null && Number.isFinite(netEvPercent)
      ? netEvPercent.toFixed(2)
      : "null";
  logger.routineDebug(
    `[Kalshi Shadow] Queued kalshi_shadow_trades insert id=${trade.id} ticker=${trade.ticker ?? "unknown"} netEvPercent=${evLabel}`
  );
}

function formatTraceEv(evPercent: number | null): string {
  if (evPercent == null || !Number.isFinite(evPercent)) return "null";
  return `${evPercent.toFixed(2)}%`;
}
