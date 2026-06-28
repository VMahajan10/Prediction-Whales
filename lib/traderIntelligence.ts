import type { ClvStats, TrackRecord } from "@/lib/polymarket";
import type { CrossMarketEvStats } from "@/lib/crossMarketEvStats";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";

export type TraderIntelligenceSource =
  | "pipeline"
  | "cross_market"
  | "clv"
  | "estimated"
  | "unavailable";

export interface PipelineEvAnalyticsInput {
  averageEv: number | null;
  averageEvLabel: string;
  totalPortfolioEv?: number | null;
  tradeCount?: number;
}

export interface TraderIntelligence {
  averageStrategyEv: number | null;
  averageStrategyEvLabel: string;
  aiEdgeScore: number | null;
  aiEdgeScoreLabel: string;
  source: TraderIntelligenceSource;
  coverage: number;
  totalEvaluated: number;
  explain: string;
}

function clampScore(score: number): number {
  return Math.min(100, Math.max(0, Math.round(score)));
}

function clvToEvPercent(avgClv: number): number {
  return Math.round(avgClv * 1000) / 10;
}

/**
 * Resolves wallet-level strategy EV and AI edge score from historic positions.
 * Prefers cross-market EV, then closing-line value, then a conservative estimate.
 */
export function resolveTraderIntelligence(
  clvStats: ClvStats | null | undefined,
  crossMarketEvStats: CrossMarketEvStats | null | undefined,
  trackRecord: TrackRecord | null | undefined,
  pipelineEv?: PipelineEvAnalyticsInput | null
): TraderIntelligence {
  const closedCount = trackRecord?.closedCount ?? 0;

  if (pipelineEv?.averageEv != null) {
    const avgEvPct = Math.round(pipelineEv.averageEv * 1000) / 10;
    const aiEdgeScore = clampScore(
      55 + avgEvPct * 2 + (pipelineEv.averageEv > 0 ? 20 : 0)
    );

    return {
      averageStrategyEv: avgEvPct,
      averageStrategyEvLabel: pipelineEv.averageEvLabel,
      aiEdgeScore,
      aiEdgeScoreLabel: `${aiEdgeScore}`,
      source: "pipeline",
      coverage: pipelineEv.tradeCount ?? 0,
      totalEvaluated: pipelineEv.tradeCount ?? 0,
      explain:
        "Live average EV from the AI pipeline (p_true vs CLOB mids) on open mapped positions — synced from trader_ev_analytics.",
    };
  }

  const unavailable: TraderIntelligence = {
    averageStrategyEv: null,
    averageStrategyEvLabel: "—",
    aiEdgeScore: null,
    aiEdgeScoreLabel: "—",
    source: "unavailable",
    coverage: 0,
    totalEvaluated: 0,
    explain:
      closedCount === 0
        ? "Needs closed positions before we can score strategy EV or AI edge."
        : "Not enough matched markets with live fair references yet.",
  };

  if (closedCount === 0) return unavailable;

  if (
    crossMarketEvStats &&
    crossMarketEvStats.totalEvaluated > 0 &&
    crossMarketEvStats.avgEv != null
  ) {
    const avgEv = crossMarketEvStats.avgEv;
    const valid = crossMarketEvStats.positions.filter((p) => p.valid && p.ev != null);
    const positive = valid.filter((p) => (p.ev ?? 0) > 2).length;
    const positiveRatio = valid.length > 0 ? positive / valid.length : 0;
    const avgMag =
      valid.length > 0
        ? valid.reduce((sum, p) => sum + Math.abs(p.ev ?? 0), 0) / valid.length
        : 0;
    const aiEdgeScore = clampScore(
      positiveRatio * 35 + avgMag * 4 + (avgEv > 0 ? 25 : 0) + Math.min(avgEv, 10) * 2
    );

    return {
      averageStrategyEv: avgEv,
      averageStrategyEvLabel: formatEvPercent(avgEv),
      aiEdgeScore,
      aiEdgeScoreLabel: `${aiEdgeScore}`,
      source: crossMarketEvStats.hasEnoughCoverage ? "cross_market" : "estimated",
      coverage: crossMarketEvStats.coverage,
      totalEvaluated: crossMarketEvStats.totalEvaluated,
      explain:
        "Average entry edge vs matched Kalshi/Polymarket mids on the same events. AI Edge Score weights how often entries beat fair references and by how much.",
    };
  }

  if (
    clvStats &&
    clvStats.totalClosed > 0 &&
    clvStats.avgClv != null
  ) {
    const avgEvPct = clvToEvPercent(clvStats.avgClv);
    const valid = clvStats.positions?.filter((p) => p.valid && p.clv != null) ?? [];
    const positive = valid.filter((p) => (p.clv ?? 0) > 0.02).length;
    const positiveRatio = valid.length > 0 ? positive / valid.length : 0;
    const avgMag =
      valid.length > 0
        ? valid.reduce((sum, p) => sum + Math.abs(p.clv ?? 0), 0) / valid.length
        : Math.abs(clvStats.avgClv);
    const aiEdgeScore = clampScore(
      positiveRatio * 30 + avgMag * 400 + (clvStats.avgClv > 0 ? 20 : 0)
    );

    return {
      averageStrategyEv: avgEvPct,
      averageStrategyEvLabel: formatEvPercent(avgEvPct),
      aiEdgeScore,
      aiEdgeScoreLabel: `${aiEdgeScore}`,
      source: clvStats.hasEnoughCoverage ? "clv" : "estimated",
      coverage: clvStats.coverage,
      totalEvaluated: clvStats.totalClosed,
      explain:
        "Average closing-line edge on resolved positions. AI Edge Score reflects how often this wallet entered before the market moved in their favor.",
    };
  }

  const roi = trackRecord?.roi;
  if (roi != null) {
    const estimatedEv = Math.round(roi * 0.15 * 10) / 10;
    const aiEdgeScore = clampScore(40 + estimatedEv * 3 + (roi > 0 ? 15 : 0));
    return {
      averageStrategyEv: estimatedEv,
      averageStrategyEvLabel: formatEvPercent(estimatedEv),
      aiEdgeScore,
      aiEdgeScoreLabel: `${aiEdgeScore}`,
      source: "estimated",
      coverage: closedCount,
      totalEvaluated: closedCount,
      explain:
        "Estimated from ROI until more cross-market or closing-line coverage is available — treat as directional, not precise EV.",
    };
  }

  return unavailable;
}
