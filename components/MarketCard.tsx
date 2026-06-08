import Link from "next/link";
import GlossaryTooltip from "@/components/GlossaryTooltip";
import Sparkline from "@/components/Sparkline";
import {
  getLikelihood,
  getLiquidityLabel,
  getPopularityLabel,
} from "@/lib/explorer";
import type { MarketSummary } from "@/lib/polymarket";
import { formatVolumeUsd } from "@/lib/polymarket";

interface MarketCardProps {
  market: MarketSummary;
  explorerMode?: boolean;
}

const BAR_COLORS = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
};

function formatPct(probability: number): string {
  const pct = probability * 100;
  return pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1);
}

function ExplorerMarketCard({ market }: { market: MarketSummary }) {
  const prob = market.probability;
  const likelihood = getLikelihood(prob);
  const betAmount = 10;
  const winPayout = prob > 0 ? betAmount / prob : 0;
  const winProfit = winPayout - betAmount;

  return (
    <article className="flex h-full flex-col rounded-xl border border-pulse-border bg-pulse-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h3 className="line-clamp-3 flex-1 text-sm font-medium leading-snug text-white">
          {market.question}
        </h3>
        <span className="shrink-0 rounded-full bg-slate-700 px-2 py-0.5 text-xs font-medium text-slate-400">
          Polymarket
        </span>
      </div>

      <div className="mb-4">
        <p className="mb-2 text-xs text-pulse-muted">
          The crowd thinks this is:{" "}
          <span className="font-semibold uppercase text-white">
            {likelihood.label}
          </span>
        </p>
        <div className="mb-1 flex gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className={`h-3 w-3 rounded-sm ${
                i < likelihood.bars
                  ? BAR_COLORS[likelihood.color]
                  : "bg-slate-700"
              }`}
            />
          ))}
          <span className="ml-2 text-xs text-slate-400">
            {likelihood.label} ({formatPct(prob)}%)
          </span>
        </div>
      </div>

      <div className="mb-4 rounded-lg bg-slate-900/60 p-3 text-xs text-slate-300">
        <p className="mb-1 font-medium text-white">
          If you bet ${betAmount}:
        </p>
        <p className="text-pulse-yes">
          ✅ If YES: win ${winPayout.toFixed(2)} (+$
          {winProfit.toFixed(2)} profit)
        </p>
        <p className="text-red-400">❌ If NO: lose ${betAmount.toFixed(2)}</p>
      </div>

      <div className="mb-4 space-y-1 text-xs text-slate-400">
        <p>
          <GlossaryTooltip
            term="Volume"
            definition="Total money bet on this market. Higher volume = more reliable price"
          >
            {getPopularityLabel(market.volume)}
          </GlossaryTooltip>
        </p>
        <p>
          <GlossaryTooltip
            term="Spread"
            definition="The difference between buying and selling price. Lower spread = easier to trade"
          >
            {getLiquidityLabel(market.spread)}
          </GlossaryTooltip>
        </p>
      </div>

      <Link
        href={`/markets/${market.id}`}
        className="mt-auto block rounded-lg bg-pulse-accent py-2 text-center text-sm font-medium text-white transition-colors hover:bg-blue-600"
      >
        Learn More & Bet
      </Link>
    </article>
  );
}

export default function MarketCard({
  market,
  explorerMode = false,
}: MarketCardProps) {
  if (explorerMode) {
    return <ExplorerMarketCard market={market} />;
  }

  const pct = market.probability * 100;
  const display = pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1);

  return (
    <Link
      href={`/markets/${market.id}`}
      className="block cursor-pointer rounded-xl border border-pulse-border bg-pulse-card p-4 transition-colors hover:border-slate-500"
    >
      <article>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="line-clamp-2 text-sm font-medium leading-snug text-white">
            {market.question}
          </h3>
          <div className="flex shrink-0 gap-1">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                market.source === "predictit"
                  ? "bg-purple-900 text-purple-400"
                  : "bg-slate-700 text-slate-400"
              }`}
            >
              {market.source === "predictit" ? "PredictIt" : "Polymarket"}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                market.active
                  ? "bg-pulse-yes/20 text-pulse-yes"
                  : "bg-gray-700/50 text-pulse-muted"
              }`}
            >
              {market.active ? "Active" : "Inactive"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-pulse-muted">Probability</p>
            <p className="mt-0.5 text-lg font-semibold text-pulse-accent">
              {display}%
            </p>
          </div>
          <div>
            <p className="text-xs text-pulse-muted">Volume</p>
            <p className="mt-0.5 text-lg font-semibold text-white">
              {formatVolumeUsd(market.volume)}
            </p>
          </div>
          <div>
            <p className="text-xs text-pulse-muted">Spread</p>
            <p className="mt-0.5 text-lg font-semibold text-white">
              {market.spread == null ? "—" : `${market.spread.toFixed(1)}¢`}
            </p>
          </div>
        </div>

        <div className="mt-3 w-full">
          <Sparkline
            tokenId={market.clobTokenIds[0] ?? ""}
            width={280}
            height={36}
          />
        </div>
      </article>
    </Link>
  );
}
