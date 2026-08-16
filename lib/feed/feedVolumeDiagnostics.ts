import {
  FEED_ALLOW_MISSING_EV,
  getProductFeedMinEvPercentForLog,
  meetsProductFeedEvThreshold,
  passesPolymarketFeedTraderGate,
} from "@/lib/feedQualification";
import { resolveFeedFilterCategoryLabel } from "@/lib/feedFilterDiagnostics";
import { diagnoseKalshiFeedTradeGate } from "@/lib/feed/kalshiFeedTrades";
import { diagnoseLiveFeedTradeGate } from "@/lib/feedGate";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import { pipelineEvKeyForWhale } from "@/lib/pipelineEvClient";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import type { WalletQualification } from "@/lib/useQualifiedWalletFilter";
import type { WhaleTrade } from "@/lib/whaleTrades";

export type FeedVolumeDropCounts = {
  incomingPolymarket: number;
  incomingKalshi: number;
  admittedPolymarket: number;
  admittedKalshi: number;
  stakeFloor: number;
  evGate: number;
  walletCredibility: number;
  marketTranslation: number;
  unmappedTicker: number;
};

function classifyPolymarketTradeDrop(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  walletQualifications: ReadonlyMap<string, WalletQualification>
): keyof FeedVolumeDropCounts | "admitted" {
  const pipelineKey = pipelineEvKeyForWhale(trade);
  const pipeline = pipelineKey ? pipelineEvIndex.get(pipelineKey) : undefined;
  const tradeEvPercent = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    pipeline
  );

  const gate = diagnoseLiveFeedTradeGate({
    stakeUsd: trade.usdNotional,
    title: trade.title,
    slug: trade.slug,
    eventSlug: trade.eventSlug,
    category: resolveFeedFilterCategoryLabel(trade),
    tradeEvPercent,
  });

  if (gate.reason === "stake_floor") return "stakeFloor";
  if (
    gate.reason === "missing_trade_ev" ||
    gate.reason === "trade_ev" ||
    !meetsProductFeedEvThreshold(tradeEvPercent)
  ) {
    return "evGate";
  }
  if (translateWhaleTradeMarket(trade) == null) return "marketTranslation";

  const wallet = trade.proxyWallet?.trim().toLowerCase();
  if (
    !passesPolymarketFeedTraderGate(
      wallet,
      wallet ? walletQualifications.get(wallet) : undefined,
      true
    )
  ) {
    return "walletCredibility";
  }

  return "admitted";
}

function classifyKalshiTradeDrop(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): keyof FeedVolumeDropCounts | "admitted" {
  const gate = diagnoseKalshiFeedTradeGate(trade, pipelineEvIndex);
  if (gate.reason === "stake_floor") return "stakeFloor";
  if (gate.reason === "unmapped_ticker") return "unmappedTicker";
  if (gate.reason === "missing_trade_ev" || gate.reason === "trade_ev") {
    return "evGate";
  }
  if (gate.passed) return "admitted";
  return "evGate";
}

export function summarizeFeedVolumeDrops(input: {
  polymarketWhales: WhaleTrade[];
  kalshiWhales: WhaleTrade[];
  pipelineEvIndex: Map<string, PipelineTradeEv>;
  walletQualifications: ReadonlyMap<string, WalletQualification>;
}): FeedVolumeDropCounts {
  const counts: FeedVolumeDropCounts = {
    incomingPolymarket: input.polymarketWhales.length,
    incomingKalshi: input.kalshiWhales.length,
    admittedPolymarket: 0,
    admittedKalshi: 0,
    stakeFloor: 0,
    evGate: 0,
    walletCredibility: 0,
    marketTranslation: 0,
    unmappedTicker: 0,
  };

  for (const trade of input.polymarketWhales) {
    const outcome = classifyPolymarketTradeDrop(
      trade,
      input.pipelineEvIndex,
      input.walletQualifications
    );
    if (outcome === "admitted") {
      counts.admittedPolymarket += 1;
    } else {
      counts[outcome] += 1;
    }
  }

  for (const trade of input.kalshiWhales) {
    const outcome = classifyKalshiTradeDrop(trade, input.pipelineEvIndex);
    if (outcome === "admitted") {
      counts.admittedKalshi += 1;
    } else {
      counts[outcome] += 1;
    }
  }

  return counts;
}

/** One-line aggregate of feed gate drops for volume debugging. */
export function logFeedVolumeDiagnostics(counts: FeedVolumeDropCounts): void {
  const minEv = getProductFeedMinEvPercentForLog();
  const evLabel =
    minEv == null
      ? "EV disabled (missing allowed)"
      : `EV>=${minEv}%${FEED_ALLOW_MISSING_EV ? " (missing allowed)" : ""}`;

  console.log(
    `[Feed Volume] incoming pm=${counts.incomingPolymarket} kalshi=${counts.incomingKalshi} | admitted pm=${counts.admittedPolymarket} kalshi=${counts.admittedKalshi} | rejected stake=${counts.stakeFloor} ev=${counts.evGate} wallet=${counts.walletCredibility} translation=${counts.marketTranslation} unmappedTicker=${counts.unmappedTicker} | mode=${evLabel}`
  );
}
