import Link from "next/link";
import { getLikelihood } from "@/lib/explorer";
import type { Market } from "@/lib/polymarket";

interface PredictItCardProps {
  market: Market;
  explorerMode?: boolean;
}

const MAX_VISIBLE_CONTRACTS = 5;

function truncateName(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  return `${name.slice(0, maxLen)}…`;
}

function formatContractPct(bestBuyYesCost: number): string {
  const pct = bestBuyYesCost * 100;
  return pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1);
}

function ExplorerPredictItCard({ market }: { market: Market }) {
  const contracts = market.rawContracts ?? [];
  const top =
    contracts.length > 0
      ? [...contracts].sort((a, b) => b.bestBuyYesCost - a.bestBuyYesCost)[0]
      : null;
  const betAmount = 10;
  const topProb = top?.bestBuyYesCost ?? 0;
  const winPayout = topProb > 0 ? betAmount / topProb : 0;

  return (
    <article className="flex h-full flex-col rounded-xl border border-pulse-border border-l-4 border-l-purple-500 bg-pulse-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h3 className="flex-1 text-sm font-medium leading-snug text-white">
          {market.question}
        </h3>
        <span className="shrink-0 rounded-full bg-purple-900 px-2 py-0.5 text-xs font-medium text-purple-400">
          PredictIt
        </span>
      </div>

      <div className="mb-4 space-y-2 text-sm text-slate-300">
        {contracts.slice(0, MAX_VISIBLE_CONTRACTS).map((contract) => {
          const likelihood = getLikelihood(contract.bestBuyYesCost);
          return (
            <p key={contract.id}>
              {truncateName(contract.name, 40)} →{" "}
              {formatContractPct(contract.bestBuyYesCost)}% chance (
              {likelihood.label})
            </p>
          );
        })}
      </div>

      {top && (
        <div className="mb-4 rounded-lg bg-slate-900/60 p-3 text-xs text-slate-300">
          <p className="mb-2 text-white">
            Most likely: {truncateName(top.name, 50)} at{" "}
            {formatContractPct(top.bestBuyYesCost)}%
          </p>
          <p>Bet ${betAmount} on &apos;{truncateName(top.name, 30)}&apos;:</p>
          <p className="text-pulse-yes">
            Win → ${winPayout.toFixed(2)}
          </p>
          <p className="text-red-400">Lose → -${betAmount}</p>
        </div>
      )}

      <Link
        href={`/markets/${market.id}`}
        className="mt-auto block rounded-lg bg-purple-600 py-2 text-center text-sm font-medium text-white transition-colors hover:bg-purple-500"
      >
        Learn More & Bet
      </Link>
    </article>
  );
}

export default function PredictItCard({
  market,
  explorerMode = false,
}: PredictItCardProps) {
  if (explorerMode) {
    return <ExplorerPredictItCard market={market} />;
  }

  const contracts = market.rawContracts ?? [];
  const visible = contracts.slice(0, MAX_VISIBLE_CONTRACTS);
  const hiddenCount = contracts.length - visible.length;

  return (
    <Link
      href={`/markets/${market.id}`}
      className="block cursor-pointer rounded-xl border border-pulse-border border-l-4 border-l-purple-500 bg-pulse-card p-4 transition-colors hover:border-slate-500"
    >
      <article>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="flex-1 text-sm font-medium leading-snug text-white">
            {market.question}
          </h3>
          <span className="shrink-0 rounded-full bg-purple-900 px-2 py-0.5 text-xs font-medium text-purple-400">
            PredictIt
          </span>
        </div>

        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-pulse-muted">
            Outcome Distribution
          </p>
          <div className="space-y-2">
            {visible.map((contract) => (
              <div key={contract.id}>
                <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                  <span className="text-pulse-muted">
                    {truncateName(contract.name, 20)}
                  </span>
                  <span className="font-medium text-white">
                    {formatContractPct(contract.bestBuyYesCost)}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-700">
                  <div
                    className="h-full rounded-full bg-purple-500"
                    style={{
                      width: `${Math.min(100, Math.max(0, contract.bestBuyYesCost * 100))}%`,
                    }}
                  />
                </div>
              </div>
            ))}
            {hiddenCount > 0 && (
              <p className="text-xs text-slate-500">
                +{hiddenCount} more outcomes
              </p>
            )}
            {contracts.length === 0 && (
              <p className="text-xs text-slate-500">No open contracts</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-pulse-muted">
          <span className="text-white">
            Spread:{" "}
            {market.spread == null ? "—" : `${market.spread.toFixed(1)}¢`}
          </span>
          <span>|</span>
          <span>Vol: N/A</span>
          <span>|</span>
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${
              market.active
                ? "bg-pulse-yes/20 text-pulse-yes"
                : "bg-gray-700/50 text-pulse-muted"
            }`}
          >
            {market.active ? "Active" : "Inactive"}
          </span>
        </div>
      </article>
    </Link>
  );
}
