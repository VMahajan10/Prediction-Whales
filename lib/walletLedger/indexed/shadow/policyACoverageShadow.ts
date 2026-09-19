/**
 * Policy A coverage shadow logging — observational only.
 * Does not affect feed admission, X-agent, or production gates.
 */

import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  policyACoverageDailyMetrics,
  policyAShadowTradeObservations,
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import { feedMetricsDayKeyUtc } from "@/lib/feedMetricsCore";
import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import {
  meetsProductFeedEvThreshold,
  meetsProductFeedStakeThreshold,
  passesPolymarketFeedTraderGate,
} from "@/lib/feedQualification";
import type { WalletFeedQualification } from "@/lib/feedQualificationServer";
import { HISTORICAL_PERFORMANCE_POLICY_VERSION } from "@/lib/walletLedger/indexed/credibilityContractV2";
import {
  evaluateHistoricalPerformanceVerdict,
  type HistoricalPerformanceDecision,
  type IndexedDataValidityVerdict,
} from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  classifyProductionWalletUnknownReason,
  type ProductionWalletUnknownReason,
} from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import type { PolymarketFeedTradeLike } from "@/lib/feedQualificationServer";

export interface PolicyAShadowTradeInput {
  tradeId: string;
  wallet: string | null | undefined;
  tradedAt?: Date | null;
  stakeUsd: number;
  tradeEvPercent: number | null;
  trade: PolymarketFeedTradeLike;
  source?: string;
}

export interface PolicyAShadowEvaluation {
  translationValid: boolean;
  productionWalletPass: boolean;
  productionHydrationState: string | null;
  indexedDataValidityDecision: IndexedDataValidityVerdict;
  historicalPerformanceDecision: HistoricalPerformanceDecision;
  historicalPerformanceFailureReasons: string[];
  historicalPerformancePolicyVersion: string;
  policyAUnknownReason: ProductionWalletUnknownReason | null;
  feedVisible: boolean;
}

type WalletPolicyAMetricsSnapshot = Awaited<
  ReturnType<typeof loadWalletPolicyAMetrics>
>;

const metricsCache = new Map<
  string,
  {
    metrics: WalletPolicyAMetricsSnapshot;
    expiresAt: number;
  }
>();
const METRICS_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadWalletPolicyAMetrics(wallet: string) {
  const db = getDb();
  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      sql`${walletHistoricalMetrics.walletAddress} = ${wallet} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
    )
    .limit(1);
  const [coverage] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(sql`${walletHistoryCoverage.walletAddress} = ${wallet}`)
    .limit(1);
  return { metrics: metrics ?? null, coverage: coverage ?? null };
}

async function getWalletPolicyAMetrics(
  wallet: string
): Promise<WalletPolicyAMetricsSnapshot> {
  const cached = metricsCache.get(wallet);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.metrics;
  }
  const loaded = await loadWalletPolicyAMetrics(wallet);
  metricsCache.set(wallet, {
    metrics: loaded,
    expiresAt: Date.now() + METRICS_CACHE_TTL_MS,
  });
  return loaded;
}

export async function evaluatePolicyAShadowForTrade(
  trade: PolicyAShadowTradeInput,
  qualification: WalletFeedQualification | undefined
): Promise<PolicyAShadowEvaluation> {
  const wallet = trade.wallet?.trim().toLowerCase() ?? null;
  const translationValid = translateWhaleTradeMarket(trade.trade) != null;
  const productionWalletPass = passesPolymarketFeedTraderGate(wallet, qualification);
  const productionHydrationState = qualification?.hydrationState ?? null;

  let indexedDataValidityDecision: IndexedDataValidityVerdict = "FAIL";
  let historicalPerformanceDecision: HistoricalPerformanceDecision = "UNKNOWN";
  let historicalPerformanceFailureReasons: string[] = [];
  let policyAUnknownReason: ProductionWalletUnknownReason | null =
    "no_indexed_history";

  if (wallet) {
    const { metrics, coverage } = await getWalletPolicyAMetrics(wallet);
    const indexedDataValidity = Boolean(metrics?.credibilityMetricsValid);
    indexedDataValidityDecision = indexedDataValidity ? "PASS" : "FAIL";
    const verdict = evaluateHistoricalPerformanceVerdict({
      indexedDataValidity,
      historyValidity: metrics?.historyValidity,
      historyComplete: metrics?.historyComplete ?? undefined,
      completedPositionCount: metrics?.completedPositions ?? null,
      realizedRoi: metrics?.realizedRoi ?? null,
      profitablePositionRate: metrics?.profitablePositionRate ?? null,
      metricVersion: metrics?.metricVersion ?? null,
    });
    historicalPerformanceDecision = verdict.historicalPerformanceDecision;
    historicalPerformanceFailureReasons =
      verdict.historicalPerformanceFailureReasons;
    if (historicalPerformanceDecision === "UNKNOWN") {
      policyAUnknownReason = classifyProductionWalletUnknownReason({
        metrics,
        coverage,
        productionHydrationState:
          productionHydrationState === "pending"
            ? "pending"
            : productionHydrationState === "failed"
              ? "failed"
              : productionHydrationState === "complete"
                ? "complete"
                : "unknown",
      });
    } else {
      policyAUnknownReason = null;
    }
  }

  const feedVisible =
    translationValid &&
    productionWalletPass &&
    meetsProductFeedStakeThreshold(trade.stakeUsd) &&
    meetsProductFeedEvThreshold(trade.tradeEvPercent);

  return {
    translationValid,
    productionWalletPass,
    productionHydrationState,
    indexedDataValidityDecision,
    historicalPerformanceDecision,
    historicalPerformanceFailureReasons,
    historicalPerformancePolicyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
    policyAUnknownReason,
    feedVisible,
  };
}

export async function persistPolicyAShadowObservation(
  trade: PolicyAShadowTradeInput,
  evaluation: PolicyAShadowEvaluation
): Promise<void> {
  if (!isDatabaseEnabled()) return;
  const wallet = trade.wallet?.trim().toLowerCase();
  if (!wallet) return;

  const db = getDb();
  await db
    .insert(policyAShadowTradeObservations)
    .values({
      tradeId: trade.tradeId,
      walletAddress: wallet,
      tradedAt: trade.tradedAt ?? null,
      source: trade.source ?? "polymarket_feed",
      stakeUsd: trade.stakeUsd,
      tradeEvPercent: trade.tradeEvPercent,
      translationValid: evaluation.translationValid,
      productionWalletPass: evaluation.productionWalletPass,
      productionHydrationState: evaluation.productionHydrationState,
      indexedDataValidityDecision: evaluation.indexedDataValidityDecision,
      historicalPerformanceDecision: evaluation.historicalPerformanceDecision,
      historicalPerformanceFailureReasons:
        evaluation.historicalPerformanceFailureReasons,
      historicalPerformancePolicyVersion:
        evaluation.historicalPerformancePolicyVersion,
      feedVisible: evaluation.feedVisible,
    })
    .onConflictDoUpdate({
      target: [
        policyAShadowTradeObservations.tradeId,
        policyAShadowTradeObservations.source,
      ],
      set: {
        observedAt: sql`now()`,
        stakeUsd: sql`excluded.stake_usd`,
        tradeEvPercent: sql`excluded.trade_ev_percent`,
        translationValid: sql`excluded.translation_valid`,
        productionWalletPass: sql`excluded.production_wallet_pass`,
        productionHydrationState: sql`excluded.production_hydration_state`,
        indexedDataValidityDecision: sql`excluded.indexed_data_validity_decision`,
        historicalPerformanceDecision: sql`excluded.historical_performance_decision`,
        historicalPerformanceFailureReasons:
          sql`excluded.historical_performance_failure_reasons`,
        historicalPerformancePolicyVersion:
          sql`excluded.historical_performance_policy_version`,
        feedVisible: sql`excluded.feed_visible`,
      },
    });
}

export async function recordPolicyAShadowForTradeGateQualifiedTrades<
  T extends PolymarketFeedTradeLike & {
    netEvPercent?: number | null;
    averageEv?: number | null;
  },
>(
  trades: T[],
  qualifications: Record<string, WalletFeedQualification>,
  input?: { tradesDetected?: number }
): Promise<void> {
  if (!isDatabaseEnabled() || trades.length === 0) return;

  const rollupObservations: RollupObservation[] = [];
  for (const trade of trades) {
    const wallet = trade.proxyWallet?.trim().toLowerCase();
    const qualification = wallet ? qualifications[wallet] : undefined;
    const tradeEvPercent = trade.netEvPercent ?? trade.averageEv ?? null;
    const shadowInput = {
      tradeId: trade.id,
      wallet,
      stakeUsd: trade.size * trade.price,
      tradeEvPercent,
      trade,
    };
    const evaluation = await evaluatePolicyAShadowForTrade(
      shadowInput,
      qualification
    );
    await persistPolicyAShadowObservation(shadowInput, evaluation);
    rollupObservations.push({
      wallet: wallet ?? "",
      productionPass: evaluation.productionWalletPass,
      feedVisible: evaluation.feedVisible,
      policyA: evaluation.historicalPerformanceDecision,
    });
  }

  void rollupPolicyACoverageDailyFromShadow({
    tradesDetected: input?.tradesDetected ?? trades.length,
    tradeGateQualified: trades.length,
    observations: rollupObservations,
  }).catch((error) => {
    console.warn(
      "[policyACoverageShadow] daily rollup failed (non-fatal)",
      error instanceof Error ? error.message : error
    );
  });
}

export function schedulePolicyAShadowForTradeGateQualifiedTrades<
  T extends PolymarketFeedTradeLike & {
    netEvPercent?: number | null;
    averageEv?: number | null;
  },
>(
  trades: T[],
  qualifications: Record<string, WalletFeedQualification>,
  input?: { tradesDetected?: number }
): void {
  if (!isDatabaseEnabled() || trades.length === 0) return;
  void recordPolicyAShadowForTradeGateQualifiedTrades(
    trades,
    qualifications,
    input
  ).catch((error) => {
    console.warn(
      "[policyACoverageShadow] shadow observation failed (non-fatal)",
      error instanceof Error ? error.message : error
    );
  });
}

interface RollupObservation {
  wallet: string;
  productionPass: boolean;
  feedVisible: boolean;
  policyA: HistoricalPerformanceDecision;
}

export async function rollupPolicyACoverageDailyFromShadow(input: {
  dayKey?: string;
  tradesDetected: number;
  tradeGateQualified: number;
  observations: RollupObservation[];
}): Promise<void> {
  if (!isDatabaseEnabled()) return;
  const dayKey = input.dayKey ?? feedMetricsDayKeyUtc();
  const productionQualified = input.observations.filter((o) => o.productionPass);
  const pass = productionQualified.filter((o) => o.policyA === "PASS");
  const fail = productionQualified.filter((o) => o.policyA === "FAIL");
  const unknown = productionQualified.filter((o) => o.policyA === "UNKNOWN");
  const feedVisible = input.observations.filter((o) => o.feedVisible);
  const feedRemain = feedVisible.filter((o) => o.policyA === "PASS");
  const feedFail = feedVisible.filter((o) => o.policyA === "FAIL");
  const feedUnknown = feedVisible.filter((o) => o.policyA === "UNKNOWN");

  const db = getDb();
  await db
    .insert(policyACoverageDailyMetrics)
    .values({
      dayKey,
      venue: "polymarket",
      tradesDetected: input.tradesDetected,
      tradeGateQualified: input.tradeGateQualified,
      productionWalletQualified: productionQualified.length,
      policyAPass: pass.length,
      policyAFail: fail.length,
      policyAUnknown: unknown.length,
      feedVisible: feedVisible.length,
      feedWouldRemainPolicyA: feedRemain.length,
      feedWouldFailPolicyA: feedFail.length,
      feedUnknownPolicyA: feedUnknown.length,
      distinctProductionWallets: new Set(
        productionQualified.map((o) => o.wallet).filter(Boolean)
      ).size,
      distinctPolicyAPassWallets: new Set(
        pass.map((o) => o.wallet).filter(Boolean)
      ).size,
      distinctPolicyAFailWallets: new Set(
        fail.map((o) => o.wallet).filter(Boolean)
      ).size,
      distinctPolicyAUnknownWallets: new Set(
        unknown.map((o) => o.wallet).filter(Boolean)
      ).size,
    })
    .onConflictDoUpdate({
      target: [
        policyACoverageDailyMetrics.dayKey,
        policyACoverageDailyMetrics.venue,
      ],
      set: {
        tradesDetected: sql`${policyACoverageDailyMetrics.tradesDetected} + ${input.tradesDetected}`,
        tradeGateQualified: sql`${policyACoverageDailyMetrics.tradeGateQualified} + ${input.tradeGateQualified}`,
        productionWalletQualified: sql`${policyACoverageDailyMetrics.productionWalletQualified} + ${productionQualified.length}`,
        policyAPass: sql`${policyACoverageDailyMetrics.policyAPass} + ${pass.length}`,
        policyAFail: sql`${policyACoverageDailyMetrics.policyAFail} + ${fail.length}`,
        policyAUnknown: sql`${policyACoverageDailyMetrics.policyAUnknown} + ${unknown.length}`,
        feedVisible: sql`${policyACoverageDailyMetrics.feedVisible} + ${feedVisible.length}`,
        feedWouldRemainPolicyA: sql`${policyACoverageDailyMetrics.feedWouldRemainPolicyA} + ${feedRemain.length}`,
        feedWouldFailPolicyA: sql`${policyACoverageDailyMetrics.feedWouldFailPolicyA} + ${feedFail.length}`,
        feedUnknownPolicyA: sql`${policyACoverageDailyMetrics.feedUnknownPolicyA} + ${feedUnknown.length}`,
        updatedAt: sql`now()`,
      },
    });
}
