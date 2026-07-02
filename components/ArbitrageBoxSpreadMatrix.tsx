"use client";

import { useEffect, useState } from "react";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { pipelineMappingPairKey } from "@/lib/evPipeline/crossAssetLookup";

export interface ArbitrageLeg {
  venue: "polymarket" | "kalshi";
  side: "YES" | "NO";
  contractId: string;
  askPrice: number;
}

export interface ArbitrageOpportunity {
  mappingPairKey: string;
  polymarketTokenId: string;
  kalshiTicker: string;
  strategy: "pm_yes_kalshi_no" | "kalshi_yes_pm_no";
  legs: ArbitrageLeg[];
  combinedCost: number;
  guaranteedPayout: number;
  netProfitPerUnit: number;
  netRoiPercent: number;
  pmYesAsk: number;
  pmNoAsk: number;
  kalshiYesAsk: number;
  kalshiNoAsk: number;
}

interface ArbitrageApiResponse {
  pairKey?: string;
  alert?: ArbitrageOpportunity | null;
  arbitrage?: ArbitrageOpportunity | null;
  error?: string;
}

export interface ArbitrageTradeLinks {
  eventSlug?: string;
  slug?: string;
}

export function resolveMappingPairKey(
  pipelineData: PipelineTradeEv | null | undefined
): string | null {
  if (!pipelineData) return null;
  if (pipelineData.mappingPairKey) return pipelineData.mappingPairKey;
  if (pipelineData.tokenId && pipelineData.kalshiTicker) {
    return pipelineMappingPairKey(
      pipelineData.tokenId,
      pipelineData.kalshiTicker
    );
  }
  return null;
}

export function isPairedPipelineTrade(
  pipelineData: PipelineTradeEv | null | undefined
): boolean {
  return resolveMappingPairKey(pipelineData) != null;
}

function formatCents(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

function polymarketLegUrl(links: ArbitrageTradeLinks, tokenId: string): string {
  if (links.eventSlug) {
    return `https://polymarket.com/event/${links.eventSlug}`;
  }
  if (links.slug) {
    return `https://polymarket.com/event/${links.slug}`;
  }
  return `https://polymarket.com/?q=${encodeURIComponent(tokenId)}`;
}

function kalshiLegUrl(ticker: string): string {
  const series = ticker.split("-")[0]?.toLowerCase() ?? ticker.toLowerCase();
  return `https://kalshi.com/markets/${series}?op_market_ticker=${encodeURIComponent(ticker)}`;
}

function legActionUrl(leg: ArbitrageLeg, links: ArbitrageTradeLinks): string {
  if (leg.venue === "polymarket") {
    return polymarketLegUrl(links, leg.contractId);
  }
  return kalshiLegUrl(leg.contractId);
}

function strategyLabel(strategy: ArbitrageOpportunity["strategy"]): string {
  if (strategy === "pm_yes_kalshi_no") return "PM YES + Kalshi NO";
  return "Kalshi YES + PM NO";
}

export function StandaloneMarketBadge({ className = "" }: { className?: string }) {
  return (
    <section
      className={`rounded-lg border border-pulse-border bg-pulse-surface/80 px-3 py-3 ${className}`}
      data-testid="arbitrage-standalone-badge"
    >
      <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-muted">
        Cross-Venue Arbitrage
      </p>
      <p className="mt-2 text-sm leading-relaxed text-pulse-label">
        📦 Standalone Market (Single Venue Execution Tracking)
      </p>
    </section>
  );
}

interface ArbitrageBoxSpreadMatrixProps {
  arbDetails: ArbitrageOpportunity | null;
  arbLoading: boolean;
  arbError: string | null;
  tradeLinks: ArbitrageTradeLinks;
  className?: string;
}

export default function ArbitrageBoxSpreadMatrix({
  arbDetails,
  arbLoading,
  arbError,
  tradeLinks,
  className = "",
}: ArbitrageBoxSpreadMatrixProps) {
  return (
    <section
      className={`rounded-lg border border-pulse-border bg-pulse-surface/80 px-3 py-3 ${className}`}
      data-testid="arbitrage-box-spread-matrix"
    >
      <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-muted">
        Arbitrage Box Spread
      </p>

      {arbLoading ? (
        <p className="mt-2 text-sm text-zinc-500 animate-pulse">
          Recalculating cross-venue spreads...
        </p>
      ) : arbError ? (
        <div className="mt-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-400">
            Arbitrage scan error
          </p>
          <p className="mt-1 text-sm text-rose-300">{arbError}</p>
        </div>
      ) : arbDetails ? (
        <div className="mt-3 rounded-lg border border-emerald-500/40 bg-black/50 px-3 py-3 shadow-[0_0_0_1px_rgba(16,185,129,0.15)]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-400">
              Active spread
            </p>
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400">
              +{arbDetails.netRoiPercent.toFixed(1)}% ROI
            </span>
          </div>

          <p className="mb-3 text-xs font-bold uppercase tracking-wide text-white">
            {strategyLabel(arbDetails.strategy)}
          </p>

          <div className="space-y-2">
            {arbDetails.legs.map((leg) => (
              <div
                key={`${leg.venue}-${leg.side}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-pulse-surface/80 px-2.5 py-2"
              >
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-pulse-muted">
                    Buy {leg.side} ·{" "}
                    {leg.venue === "polymarket" ? "Polymarket" : "Kalshi"}
                  </p>
                  <p className="mt-0.5 text-xs font-medium text-white">
                    {leg.contractId.slice(0, 24)}
                    {leg.contractId.length > 24 ? "…" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-white">
                    {formatCents(leg.askPrice)}
                  </span>
                  <a
                    href={legActionUrl(leg, tradeLinks)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-400 transition-colors hover:bg-emerald-500/20"
                  >
                    Trade →
                  </a>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-pulse-border/60 pt-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-pulse-muted">
                Combined cost
              </p>
              <p className="text-sm font-bold text-white">
                {formatCents(arbDetails.combinedCost)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-pulse-muted">
                Locked payout
              </p>
              <p className="text-sm font-bold text-white">$1.00</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-pulse-muted">
                Net profit / $1
              </p>
              <p className="text-sm font-bold text-emerald-400">
                {formatCents(arbDetails.netProfitPerUnit)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-pulse-muted">
                Net ROI
              </p>
              <p className="text-sm font-bold text-emerald-400">
                +{arbDetails.netRoiPercent.toFixed(1)}%
              </p>
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-pulse-label">
          ⚖️ Spreads are currently efficient. (Polymarket Ask vs Kalshi Bid combo
          equals a complete consensus value of $1.00+).
        </p>
      )}
    </section>
  );
}

interface TradeArbitrageSectionProps {
  pipelineData: PipelineTradeEv | null | undefined;
  pipelineLoading?: boolean;
  tradeLinks: ArbitrageTradeLinks;
  className?: string;
  enabled?: boolean;
}

export function TradeArbitrageSection({
  pipelineData,
  pipelineLoading = false,
  tradeLinks,
  className = "",
  enabled = true,
}: TradeArbitrageSectionProps) {
  const mappingPairKey = resolveMappingPairKey(pipelineData);
  const isPaired = isPairedPipelineTrade(pipelineData);

  const [arbDetails, setArbDetails] = useState<ArbitrageOpportunity | null>(
    null
  );
  const [arbLoading, setArbLoading] = useState(false);
  const [arbError, setArbError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setArbDetails(null);
      setArbLoading(false);
      setArbError(null);
      return;
    }

    if (pipelineLoading) return;

    if (!isPaired || !mappingPairKey) {
      setArbDetails(null);
      setArbLoading(false);
      setArbError(null);
      return;
    }

    let cancelled = false;
    setArbLoading(true);
    setArbError(null);

    void (async () => {
      const url = `/api/ev/arbitrage?pairKey=${encodeURIComponent(mappingPairKey)}`;
      try {
        console.log("[TradeArbitrageSection] fetching arbitrage", {
          url,
          mappingPairKey,
          pipelineStatus: pipelineData?.status,
        });

        const res = await fetch(url);
        const data = (await res.json()) as ArbitrageApiResponse;

        if (!res.ok) {
          const message =
            data.error ?? `Arbitrage API returned HTTP ${res.status}`;
          console.error("Arbitrage fetch failed:", message, data);
          if (!cancelled) {
            setArbDetails(null);
            setArbError(message);
          }
          return;
        }

        if (!cancelled) {
          setArbDetails(data.alert ?? data.arbitrage ?? null);
          setArbError(null);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Arbitrage fetch failed";
        console.error("Arbitrage fetch failed:", err);
        if (!cancelled) {
          setArbDetails(null);
          setArbError(message);
        }
      } finally {
        if (!cancelled) setArbLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    isPaired,
    mappingPairKey,
    pipelineLoading,
    pipelineData?.status,
  ]);

  if (pipelineLoading && !pipelineData) {
    return (
      <section
        className={`rounded-lg border border-pulse-border bg-pulse-surface/80 px-3 py-3 ${className}`}
        data-testid="arbitrage-pipeline-loading"
      >
        <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-muted">
          Cross-Venue Arbitrage
        </p>
        <p className="mt-2 text-sm text-zinc-500 animate-pulse">
          Loading pipeline mapping data...
        </p>
      </section>
    );
  }

  if (!isPaired || !mappingPairKey) {
    return <StandaloneMarketBadge className={className} />;
  }

  return (
    <ArbitrageBoxSpreadMatrix
      arbDetails={arbDetails}
      arbLoading={arbLoading}
      arbError={arbError}
      tradeLinks={tradeLinks}
      className={className}
    />
  );
}
