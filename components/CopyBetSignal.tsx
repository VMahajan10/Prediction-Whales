"use client";

import { trackCopyTap } from "@/lib/copyTracking";
import {
  getCopyBetButtonConfig,
  getCopySignalsAndVerdict,
  type TrackRecordCopyContext,
} from "@/lib/copyBetSignal";
import { getPolymarketTradeUrl, type MarketSummary, type TradeSummary } from "@/lib/polymarket";
import { useWhaleTrackRecord } from "@/lib/useWhaleTrackRecord";
import { VERDICT_BADGE_CLASSES } from "@/lib/whaleSignals";

interface CopyBetSignalProps {
  trade: TradeSummary;
  currentProbability: number | null;
  matchedMarket?: MarketSummary | null;
  proxyWallet?: string;
  walletUnavailable?: boolean;
}

export default function CopyBetSignal({
  trade,
  currentProbability,
  matchedMarket,
  proxyWallet,
  walletUnavailable = false,
}: CopyBetSignalProps) {
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

  const isSell = trade.side === "SELL";
  const { signals: copySignals, verdict: copyVerdict } = getCopySignalsAndVerdict(
    trade,
    currentProbability,
    matchedMarket,
    trackContext
  );
  const verdict = copyVerdict.verdict;
  const polymarketUrl = getPolymarketTradeUrl(trade);
  const buttonConfig = getCopyBetButtonConfig(verdict, trade.side);

  const cautionVerdicts = new Set([
    "Promising Bet, Unproven Trader",
    "Unproven Trader — Limited Track Record",
    "Proceed With Caution",
    "Weak Signal",
  ]);

  return (
    <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
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
        <p className="text-sm text-slate-400">
          {isSell
            ? "6 signals analyzed · This is an EXIT trade"
            : "6 signals analyzed · Trade quality + trader track record"}
        </p>
      </div>

      <div className="space-y-4">
        {copySignals.map((signal) => (
          <div
            key={signal.label}
            className="rounded-lg border border-slate-700 bg-slate-900/50 p-4"
          >
            <p className="text-sm font-bold text-white">
              {signal.emoji} {signal.label}
            </p>
            <p className="mt-1 text-sm text-slate-400">{signal.plain}</p>
          </div>
        ))}
      </div>

      <div className="mt-6">
        <a
          href={polymarketUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() =>
            trackCopyTap(trade.title ?? "", trade.size ?? 0, verdict)
          }
          className={`block w-full rounded-xl px-6 py-4 text-center text-lg font-semibold transition-colors ${buttonConfig.className}`}
        >
          {buttonConfig.text}
        </a>
        <p className="mt-2 text-center text-xs text-slate-500">
          {verdict === "Strong Copy Signal" || verdict === "Worth Considering"
            ? "You'll be taken to Polymarket to place this bet with real money. Only invest what you can afford to lose."
            : cautionVerdicts.has(verdict)
              ? "This signal is capped by trader history — research on Polymarket before copying."
              : "View the market on Polymarket to research before deciding."}
        </p>
      </div>
    </section>
  );
}
