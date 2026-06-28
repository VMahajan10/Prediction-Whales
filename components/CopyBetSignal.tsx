"use client";

import { useMemo } from "react";
import { trackCopyTap } from "@/lib/copyTracking";
import {
  getCopyBetButtonConfig,
  getCopySignalsAndVerdict,
  type TrackRecordCopyContext,
} from "@/lib/copyBetSignal";
import { isResolvedPipelineTradeEv } from "@/lib/evPipeline/types";
import { getPolymarketTradeUrl, type MarketSummary, type TradeSummary } from "@/lib/polymarket";
import { resolveCrossMarketEvForTrade } from "@/lib/resolveTradeCrossMarketEv";
import { useCrossMarketEvIndex } from "@/lib/useCrossMarketEvIndex";
import { usePipelineTradeEv } from "@/lib/usePipelineEvIndex";
import { useWhaleTrackRecord } from "@/lib/useWhaleTrackRecord";
import { VERDICT_BADGE_CLASSES } from "@/lib/whaleSignals";

interface CopyBetSignalProps {
  trade: TradeSummary;
  currentProbability: number | null;
  matchedMarket?: MarketSummary | null;
  proxyWallet?: string;
  walletUnavailable?: boolean;
  /** Precomputed trade EV (%); resolved from cross-market index when omitted. */
  tradeEvPercent?: number | null;
  tradeNetEv?: number | null;
  tradeEvSlug?: string;
  tradeEvTicker?: string;
  tradeEvSource?: "polymarket" | "kalshi";
  tradeEvTokenId?: string;
  platform?: "polymarket" | "kalshi";
  ctaHref?: string;
}

export default function CopyBetSignal({
  trade,
  currentProbability,
  matchedMarket,
  proxyWallet,
  walletUnavailable = false,
  tradeEvPercent: tradeEvPercentProp,
  tradeNetEv,
  tradeEvSlug,
  tradeEvTicker,
  tradeEvSource,
  tradeEvTokenId,
  platform = "polymarket",
  ctaHref,
}: CopyBetSignalProps) {
  const { index: evIndex } = useCrossMarketEvIndex();
  const pipelineSource = tradeEvSource ?? platform;
  const { ev: pipelineEv } = usePipelineTradeEv({
    source: pipelineSource,
    tokenId:
      tradeEvTokenId ??
      (pipelineSource === "polymarket" ? trade.assetId : undefined),
    kalshiTicker: tradeEvTicker,
    tradePrice: trade.price,
    enabled: pipelineSource === "polymarket" || pipelineSource === "kalshi",
  });
  const { trackRecord, loading: trackLoading, error: trackError } =
    useWhaleTrackRecord(proxyWallet);

  const trackContext: TrackRecordCopyContext = {
    proxyWallet,
    loading: !!proxyWallet && trackLoading && !trackRecord,
    unavailable: walletUnavailable || (!!proxyWallet && !!trackError),
    closedCount: trackRecord?.closedCount,
    hasEnoughHistory: trackRecord?.hasEnoughHistory,
    winRate: trackRecord?.winRate,
    roi: trackRecord?.roi,
  };

  const resolvedTradeEvPercent = useMemo(() => {
    if (tradeEvPercentProp != null) return tradeEvPercentProp;
    if (isResolvedPipelineTradeEv(pipelineEv)) return pipelineEv.netEvPercent;
    const source = tradeEvSource ?? "polymarket";
    const slug = tradeEvSlug ?? trade.slug;
    const ticker = tradeEvTicker;
    if (source === "polymarket" && !slug) return null;
    if (source === "kalshi" && !ticker) return null;
    if (evIndex.size === 0) return null;

    const result = resolveCrossMarketEvForTrade(
      {
        source,
        price: trade.price,
        slug: source === "polymarket" ? slug : undefined,
        ticker: source === "kalshi" ? ticker : undefined,
      },
      evIndex
    );
    return result.reason === "ok" ? result.ev : null;
  }, [
    tradeEvPercentProp,
    pipelineEv?.netEvPercent,
    tradeEvSource,
    tradeEvSlug,
    trade.slug,
    tradeEvTicker,
    trade.price,
    evIndex,
  ]);

  const effectiveNetEv =
    tradeNetEv ??
    (isResolvedPipelineTradeEv(pipelineEv) ? pipelineEv.netEv : null);

  const isSell = trade.side === "SELL";
  const { signals: copySignals, verdict: copyVerdict } = getCopySignalsAndVerdict(
    trade,
    currentProbability,
    matchedMarket,
    trackContext,
    tradeEvPercentProp ?? resolvedTradeEvPercent,
    effectiveNetEv
  );
  const verdict = copyVerdict.verdict;
  const actionHref =
    ctaHref ??
    (platform === "kalshi" && tradeEvTicker
      ? `https://kalshi.com/markets/${tradeEvTicker.split("-")[0]?.toLowerCase() ?? ""}`
      : getPolymarketTradeUrl(trade));
  const buttonConfig = getCopyBetButtonConfig(verdict, trade.side);

  const cautionVerdicts = new Set([
    "Promising Bet, Unproven Trader",
    "Unproven Trader — Limited Track Record",
    "Proceed With Caution",
    "Weak Signal",
  ]);

  return (
    <section className="pulse-card mb-8 border border-pulse-border p-6">
      {isSell && (
        <div className="mb-6 rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300">
          ⚠️ This whale is SELLING — they&apos;re exiting a position, not opening
          one. Exit signals are harder to copy directly.
        </div>
      )}
      <div
        className={`mb-6 rounded-xl border px-4 py-3 text-center ${VERDICT_BADGE_CLASSES[copyVerdict.verdictColor]}`}
      >
        <p className="text-2xl font-bold">
          {copyVerdict.verdictEmoji} {copyVerdict.verdict}
        </p>
      </div>

      <div className="mb-6">
        <h2 className="text-lg font-semibold text-white">
          {isSell
            ? "🎯 Should You Follow This Exit?"
            : "🎯 Should You Copy This Bet?"}
        </h2>
        <p className="text-sm text-pulse-muted">
          {isSell
            ? "7 signals analyzed · This is an EXIT trade"
            : "7 signals analyzed · Trade EV, quality + track record"}
        </p>
      </div>

      <div className="space-y-4">
        {copySignals.map((signal) => (
          <div
            key={signal.label}
            className="rounded-lg border border-pulse-border bg-pulse-surface p-4"
          >
            <p className="text-sm font-bold text-white">
              {signal.emoji} {signal.label}
            </p>
            <p className="mt-1 text-sm text-pulse-muted">{signal.plain}</p>
          </div>
        ))}
      </div>

      <div className="mt-6">
        <a
          href={actionHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() =>
            trackCopyTap(trade.title ?? "", trade.size ?? 0, verdict)
          }
          className={`block w-full rounded-xl px-6 py-4 text-center text-lg font-semibold transition-colors ${buttonConfig.className}`}
        >
          {platform === "kalshi" ? "View This Market on Kalshi →" : buttonConfig.text}
        </a>
        <p className="mt-2 text-center text-xs text-pulse-muted">
          {verdict === "Strong Copy Signal" || verdict === "Worth Considering"
            ? platform === "kalshi"
              ? "Strong signals require +2% trade EV, proven track record (≥5 bets, ≥50% win rate), and positive trade quality."
              : "You'll be taken to Polymarket to place this bet with real money. Only invest what you can afford to lose."
            : cautionVerdicts.has(verdict)
              ? "This signal is capped by trader history or EV — research before copying."
              : platform === "kalshi"
                ? "View the market on Kalshi to research before deciding."
                : "View the market on Polymarket to research before deciding."}
        </p>
      </div>
    </section>
  );
}
