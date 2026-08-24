import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import {
  mergePipelineEvOntoWhale,
  stampWhaleFeedAdmissionEv,
  whaleHasStampedFeedEv,
} from "@/lib/whaleCardEv";
import { meetsProductFeedEvThreshold } from "@/lib/feedQualification";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import {
  isVisibleInClientFeed,
  passesPolymarketClientFeedAdmissionGate,
  resolvePolymarketWalletQualificationState,
  type PolymarketWalletQualificationState,
} from "@/lib/whaleFeedClientQualification";
import {
  pipelineEvKeyForWhale,
  resolvePipelineEvForWhale,
} from "@/lib/pipelineEvClient";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import type { WalletQualification } from "@/lib/useQualifiedWalletFilter";
import type { WhaleTrade } from "@/lib/whaleTrades";

export type WalletQualificationMap = ReadonlyMap<string, WalletQualification>;

export function whaleKeyForTrade(trade: WhaleTrade): string {
  return trade.source === "kalshi"
    ? `kalshi:${trade.id}`
    : trade.transactionHash || trade.id;
}

export function stampWhaleForFeedAdmission(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): WhaleTrade | null {
  if (whaleHasStampedFeedEv(trade)) {
    return meetsProductFeedEvThreshold(trade.netEvPercent) ? trade : null;
  }
  const pipeline = resolvePipelineEvForWhale(pipelineEvIndex, trade);
  const tradeEvPercent = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    pipeline
  );
  if (tradeEvPercent == null || !Number.isFinite(tradeEvPercent)) return null;
  if (!meetsProductFeedEvThreshold(tradeEvPercent)) return null;
  return stampWhaleFeedAdmissionEv(trade, tradeEvPercent);
}

export function attachWhaleIdentity(
  trade: WhaleTrade,
  qualification: WalletQualification | undefined
): WhaleTrade {
  const marketTranslation = translateWhaleTradeMarket(trade) ?? undefined;
  const withIdentity =
    trade.whaleIdentity || !qualification?.identity
      ? trade
      : { ...trade, whaleIdentity: qualification.identity };

  if (!marketTranslation) return withIdentity;
  return { ...withIdentity, marketTranslation };
}

export function buildQualifiedPolymarketWhales(
  polymarketWhales: WhaleTrade[],
  walletQualifications: WalletQualificationMap,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  loggedRejects?: Set<string>
): WhaleTrade[] {
  return polymarketWhales
    .filter((trade) =>
      passesPolymarketClientFeedAdmissionGate(
        trade,
        walletQualifications,
        pipelineEvIndex,
        loggedRejects
      )
    )
    .map((trade) => {
      const pipelineKey = pipelineEvKeyForWhale(trade);
      const wallet = trade.proxyWallet?.trim().toLowerCase();
      const withIdentity = attachWhaleIdentity(
        trade,
        wallet ? walletQualifications.get(wallet) : undefined
      );
      return mergePipelineEvOntoWhale(
        withIdentity,
        pipelineKey ? pipelineEvIndex.get(pipelineKey) : undefined
      );
    });
}

export function admitPolymarketWhalesToBuffer(
  qualifiedWhales: WhaleTrade[],
  seenKeys: Set<string>,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): WhaleTrade[] {
  const incoming: WhaleTrade[] = [];

  for (const whale of qualifiedWhales) {
    const key = whaleKeyForTrade(whale);
    if (!key || seenKeys.has(key)) continue;

    const admitted = stampWhaleForFeedAdmission(whale, pipelineEvIndex);
    if (!admitted) continue;

    seenKeys.add(key);
    incoming.push(admitted);
  }

  return incoming;
}

/** Drop invisible rows and release their seen-keys so they can be re-admitted later. */
export function pruneWhaleBufferForVisibility(
  buffer: WhaleTrade[],
  seenKeys: Set<string>,
  walletQualifications: WalletQualificationMap,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  loggedRejects?: Set<string>
): WhaleTrade[] {
  const visible = buffer.filter((trade) =>
    isVisibleInClientFeed(
      trade,
      walletQualifications,
      pipelineEvIndex,
      loggedRejects
    )
  );

  if (visible.length === buffer.length) {
    return buffer;
  }

  const visibleKeySet = new Set(
    visible.map((trade) => whaleKeyForTrade(trade)).filter(Boolean)
  );

  for (const key of Array.from(seenKeys)) {
    if (!visibleKeySet.has(key)) {
      seenKeys.delete(key);
    }
  }

  return visible;
}

export function filterVisibleWhales(
  buffer: WhaleTrade[],
  walletQualifications: WalletQualificationMap,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  loggedRejects?: Set<string>
): WhaleTrade[] {
  return buffer.filter((trade) =>
    isVisibleInClientFeed(
      trade,
      walletQualifications,
      pipelineEvIndex,
      loggedRejects
    )
  );
}

export type PolymarketFeedFunnelStage =
  | "recentSeedHydrated"
  | "qualifiedPolymarketWhales"
  | "admittedToBuffer"
  | "afterPrune"
  | "finalWhales";

export function countPolymarketAtWalletQualStage(
  trades: WhaleTrade[],
  walletQualifications: WalletQualificationMap
): Record<PolymarketWalletQualificationState, number> {
  const counts: Record<PolymarketWalletQualificationState, number> = {
    pending: 0,
    pass: 0,
    fail: 0,
  };

  for (const trade of trades) {
    if (trade.source !== "polymarket") continue;
    const state = resolvePolymarketWalletQualificationState(
      trade.proxyWallet,
      walletQualifications
    );
    counts[state] += 1;
  }

  return counts;
}
