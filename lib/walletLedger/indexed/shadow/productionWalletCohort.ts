/**
 * Rolling production-wallet cohort for Policy A coverage shadow phase.
 * Not restricted to Stage C study wallets.
 */

import { gte, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  feedTrades,
  walletHistoricalMetrics,
  walletHistoryCoverage,
  xPostLog,
} from "@/lib/crossmarket/store/schema";
import {
  meetsProductFeedEvThreshold,
  meetsProductFeedStakeThreshold,
  passesPolymarketFeedTraderGate,
} from "@/lib/feedQualification";
import { qualifyWalletsForFeed } from "@/lib/feedQualificationServer";
import { resolveStrictPolymarketTranslationFromPayload } from "@/lib/feed/persistedFeedTranslation";
import { HISTORICAL_PERFORMANCE_POLICY_VERSION } from "@/lib/walletLedger/indexed/credibilityContractV2";
import {
  evaluateHistoricalPerformanceVerdict,
  type HistoricalPerformanceDecision,
} from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import type { TradePayload } from "@/lib/x-agent/gateTypes";

export const PRODUCTION_WALLET_COHORT_LOOKBACK_DAYS = 30;

export type ProductionWalletUnknownReason =
  | "insufficient_completed_positions"
  | "incomplete_indexed_history"
  | "missing_metrics"
  | "invalid_indexed_history"
  | "hydration_pending"
  | "hydration_failed"
  | "no_indexed_history"
  | "unresolved_chain_order";

export type ProductionWalletPriorityTier = 1 | 2 | 3 | 4;

export interface ProductionWalletCohortMember {
  wallet: string;
  priorityTier: ProductionWalletPriorityTier;
  inFeedTrades: boolean;
  feedVisibleTradeCount: number;
  inXPostLog: boolean;
  xPostLogTradeCount: number;
  passesProductionWalletGate: boolean;
  tradeGateQualifiedTradeCount: number;
  productionHydrationState: "pending" | "complete" | "failed" | "unknown";
  hasIndexedCoverage: boolean;
  hasIndexedMetrics: boolean;
  indexedDataValidity: boolean;
  policyADecision: HistoricalPerformanceDecision;
  policyAUnknownReason: ProductionWalletUnknownReason | null;
  completedPositions: number | null;
  realizedRoi: number | null;
  profitablePositionRate: number | null;
  historyValidity: string | null;
  historyComplete: boolean | null;
  hasValidDurableCoverage: boolean;
}

export interface ProductionWalletCohortReport {
  lookbackDays: number;
  generatedAt: string;
  policyVersion: string;
  metricVersion: string;
  totalWallets: number;
  withIndexedHistoryAvailable: number;
  policyAPass: number;
  policyAFail: number;
  policyAUnknown: number;
  unknownReasonBreakdown: Record<string, number>;
  priorityTierCounts: Record<string, number>;
  wallets: ProductionWalletCohortMember[];
}

export function classifyProductionWalletUnknownReason(input: {
  metrics: {
    credibilityMetricsValid: boolean | null;
    completedPositions: number | null;
    realizedRoi: number | null;
    profitablePositionRate: number | null;
    historyValidity: string | null;
    historyComplete?: boolean | null;
    historyIncompleteReasons?: string[] | null;
    credibilityReasons?: string[] | null;
  } | null;
  coverage: { walletAddress: string } | null;
  productionHydrationState: ProductionWalletCohortMember["productionHydrationState"];
}): ProductionWalletUnknownReason {
  const incompletenessReasons =
    input.metrics?.historyIncompleteReasons ??
    input.metrics?.credibilityReasons ??
    [];
  if (incompletenessReasons.includes("unresolved_chain_order")) {
    return "unresolved_chain_order";
  }
  if (input.productionHydrationState === "pending") {
    return "hydration_pending";
  }
  if (input.productionHydrationState === "failed") {
    return "hydration_failed";
  }
  if (!input.metrics && !input.coverage) {
    return "no_indexed_history";
  }
  if (!input.metrics) {
    return "missing_metrics";
  }
  if (
    input.metrics.historyValidity === "unusable" ||
    input.metrics.historyValidity === "partial-and-metrics-unsafe" ||
    input.metrics.historyValidity === "incomplete"
  ) {
    return "incomplete_indexed_history";
  }
  if (!input.metrics.credibilityMetricsValid) {
    return "invalid_indexed_history";
  }
  if (
    input.metrics.completedPositions == null ||
    input.metrics.completedPositions < 10
  ) {
    if (
      input.metrics.historyComplete === false ||
      input.metrics.historyValidity !== "complete"
    ) {
      return "incomplete_indexed_history";
    }
    return "insufficient_completed_positions";
  }
  if (
    input.metrics.realizedRoi == null ||
    input.metrics.profitablePositionRate == null ||
    !Number.isFinite(input.metrics.realizedRoi) ||
    !Number.isFinite(input.metrics.profitablePositionRate)
  ) {
    return "missing_metrics";
  }
  return "no_indexed_history";
}

export function hasValidDurableIndexedCoverage(input: {
  metrics: {
    metricVersion: string;
    credibilityMetricsValid: boolean | null;
    historyValidity: string | null;
  } | null;
  coverage: { walletAddress: string; metricVersion: string } | null;
}): boolean {
  if (!input.metrics || !input.coverage) return false;
  if (input.metrics.metricVersion !== WALLET_METRIC_VERSION) return false;
  if (input.coverage.metricVersion !== WALLET_METRIC_VERSION) return false;
  if (!input.metrics.credibilityMetricsValid) return false;
  const validity = input.metrics.historyValidity;
  return (
    validity !== "unusable" &&
    validity !== "partial-and-metrics-unsafe" &&
    validity !== "incomplete"
  );
}

export async function buildProductionWalletCohort(input?: {
  lookbackDays?: number;
}): Promise<ProductionWalletCohortReport> {
  const lookbackDays = input?.lookbackDays ?? PRODUCTION_WALLET_COHORT_LOOKBACK_DAYS;
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const db = getDb();

  const feedRows = await db
    .select()
    .from(feedTrades)
    .where(gte(feedTrades.tradedAt, since));
  const xLogRows = await db
    .select()
    .from(xPostLog)
    .where(gte(xPostLog.createdAt, since));

  const walletStats = new Map<
    string,
    {
      inFeedTrades: boolean;
      feedVisibleTradeCount: number;
      inXPostLog: boolean;
      xPostLogTradeCount: number;
      tradeGateQualifiedTradeCount: number;
    }
  >();

  for (const row of feedRows) {
    const wallet = row.proxyWallet?.toLowerCase();
    if (!wallet) continue;
    const stats = walletStats.get(wallet) ?? {
      inFeedTrades: false,
      feedVisibleTradeCount: 0,
      inXPostLog: false,
      xPostLogTradeCount: 0,
      tradeGateQualifiedTradeCount: 0,
    };
    stats.inFeedTrades = true;
    const passesTradeGates =
      meetsProductFeedStakeThreshold(row.stakeAmount) &&
      meetsProductFeedEvThreshold(row.averageEv) &&
      resolveStrictPolymarketTranslationFromPayload(row.payload) != null;
    if (passesTradeGates) {
      stats.tradeGateQualifiedTradeCount += 1;
    }
    walletStats.set(wallet, stats);
  }

  for (const row of xLogRows) {
    const payload = row.payload as TradePayload;
    if (payload.source !== "polymarket") continue;
    const wallet = payload.walletAddress?.toLowerCase();
    if (!wallet) continue;
    const stats = walletStats.get(wallet) ?? {
      inFeedTrades: false,
      feedVisibleTradeCount: 0,
      inXPostLog: false,
      xPostLogTradeCount: 0,
      tradeGateQualifiedTradeCount: 0,
    };
    stats.inXPostLog = true;
    stats.xPostLogTradeCount += 1;
    if (meetsProductFeedStakeThreshold(payload.stakeNotional)) {
      stats.tradeGateQualifiedTradeCount += 1;
    }
    walletStats.set(wallet, stats);
  }

  const wallets = [...walletStats.keys()];
  const qualifications = await qualifyWalletsForFeed(wallets);

  const metricsRows =
    wallets.length > 0
      ? await db
          .select()
          .from(walletHistoricalMetrics)
          .where(
            sql`${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION} AND ${walletHistoricalMetrics.walletAddress} IN (${sql.join(
              wallets.map((w) => sql`${w}`),
              sql`, `
            )})`
          )
      : [];
  const coverageRows =
    wallets.length > 0
      ? await db
          .select()
          .from(walletHistoryCoverage)
          .where(
            sql`${walletHistoryCoverage.walletAddress} IN (${sql.join(
              wallets.map((w) => sql`${w}`),
              sql`, `
            )})`
          )
      : [];

  const metricsBy = new Map(
    metricsRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );
  const coverageBy = new Map(
    coverageRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );

  const members: ProductionWalletCohortMember[] = [];
  for (const wallet of wallets) {
    const stats = walletStats.get(wallet)!;
    const qualification = qualifications[wallet];
    const passesProduction = passesPolymarketFeedTraderGate(wallet, qualification);
    if (!passesProduction && stats.tradeGateQualifiedTradeCount === 0) {
      continue;
    }

    const production = await loadProductionCredibilitySnapshot(wallet);
    const hydrationState =
      production.hydrationStatus === "complete"
        ? "complete"
        : production.hydrationStatus === "failed"
          ? "failed"
          : production.hydrationStatus === "pending"
            ? "pending"
            : "unknown";

    const metrics = metricsBy.get(wallet) ?? null;
    const coverage = coverageBy.get(wallet) ?? null;
    const indexedDataValidity = Boolean(metrics?.credibilityMetricsValid);
    const verdict = evaluateHistoricalPerformanceVerdict({
      indexedDataValidity,
      historyValidity: metrics?.historyValidity,
      historyComplete: metrics?.historyComplete ?? undefined,
      completedPositionCount: metrics?.completedPositions ?? null,
      realizedRoi: metrics?.realizedRoi ?? null,
      profitablePositionRate: metrics?.profitablePositionRate ?? null,
      metricVersion: metrics?.metricVersion ?? null,
    });

    let unknownReason: ProductionWalletUnknownReason | null = null;
    if (verdict.historicalPerformanceDecision === "UNKNOWN") {
      unknownReason = classifyProductionWalletUnknownReason({
        metrics: metrics
          ? {
              ...metrics,
              historyIncompleteReasons: metrics.historyIncompleteReasons ?? [],
              credibilityReasons: metrics.credibilityReasons ?? [],
            }
          : null,
        coverage,
        productionHydrationState: hydrationState,
      });
    }

    const feedVisibleTradeCount = feedRows.filter((row) => {
      if (row.proxyWallet?.toLowerCase() !== wallet) return false;
      return (
        meetsProductFeedStakeThreshold(row.stakeAmount) &&
        meetsProductFeedEvThreshold(row.averageEv) &&
        resolveStrictPolymarketTranslationFromPayload(row.payload) != null &&
        passesProduction
      );
    }).length;
    stats.feedVisibleTradeCount = feedVisibleTradeCount;

    const priorityTier: ProductionWalletPriorityTier =
      feedVisibleTradeCount > 0
        ? 1
        : passesProduction
          ? 2
          : stats.tradeGateQualifiedTradeCount > 0
            ? 3
            : 4;

    members.push({
      wallet,
      priorityTier,
      inFeedTrades: stats.inFeedTrades,
      feedVisibleTradeCount,
      inXPostLog: stats.inXPostLog,
      xPostLogTradeCount: stats.xPostLogTradeCount,
      passesProductionWalletGate: passesProduction,
      tradeGateQualifiedTradeCount: stats.tradeGateQualifiedTradeCount,
      productionHydrationState: hydrationState,
      hasIndexedCoverage: coverage != null,
      hasIndexedMetrics: metrics != null,
      indexedDataValidity,
      policyADecision: verdict.historicalPerformanceDecision,
      policyAUnknownReason: unknownReason,
      completedPositions: metrics?.completedPositions ?? null,
      realizedRoi: metrics?.realizedRoi ?? null,
      profitablePositionRate: metrics?.profitablePositionRate ?? null,
      historyValidity: metrics?.historyValidity ?? null,
      historyComplete: metrics?.historyComplete ?? null,
      hasValidDurableCoverage: hasValidDurableIndexedCoverage({
        metrics,
        coverage,
      }),
    });
  }

  members.sort((a, b) => a.priorityTier - b.priorityTier || a.wallet.localeCompare(b.wallet));

  const unknownReasonBreakdown: Record<string, number> = {};
  const priorityTierCounts: Record<string, number> = {};
  for (const member of members) {
    priorityTierCounts[String(member.priorityTier)] =
      (priorityTierCounts[String(member.priorityTier)] ?? 0) + 1;
    if (member.policyADecision !== "UNKNOWN") continue;
    const reason = member.policyAUnknownReason ?? "no_indexed_history";
    unknownReasonBreakdown[reason] = (unknownReasonBreakdown[reason] ?? 0) + 1;
  }

  return {
    lookbackDays,
    generatedAt: new Date().toISOString(),
    policyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
    metricVersion: WALLET_METRIC_VERSION,
    totalWallets: members.length,
    withIndexedHistoryAvailable: members.filter((m) => m.hasIndexedMetrics).length,
    policyAPass: members.filter((m) => m.policyADecision === "PASS").length,
    policyAFail: members.filter((m) => m.policyADecision === "FAIL").length,
    policyAUnknown: members.filter((m) => m.policyADecision === "UNKNOWN").length,
    unknownReasonBreakdown,
    priorityTierCounts,
    wallets: members,
  };
}
