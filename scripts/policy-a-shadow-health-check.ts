#!/usr/bin/env tsx
/**
 * Policy A shadow post-deploy health check — DB writes + forward perf diagnostics.
 */
import "./preload-env";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  policyACoverageDailyMetrics,
  policyAShadowTradeObservations,
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  assessBatchHydrationEligibility,
  loadBatchHydrationEligibilityContext,
} from "@/lib/walletLedger/indexed/shadow/productionWalletHydration";
import {
  buildProductionWalletCohort,
  hasValidDurableIndexedCoverage,
} from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import {
  loadShadowPeriodState,
  diagnoseForwardPerformance,
} from "@/lib/walletLedger/indexed/shadow/policyAShadowValidation";

const DEPLOY_SINCE = process.env.SHADOW_DEPLOY_SINCE ?? "2026-09-18T00:00:00.000Z";

function classifyRecoveryOutcome(input: {
  metrics: {
    credibilityMetricsValid: boolean | null;
    historyValidity: string | null;
    historyComplete: boolean | null;
    completedPositions: number | null;
    historyIncompleteReasons: string[] | null;
  };
  coverage: {
    identityComplete: boolean;
    eventHistoryComplete: boolean;
    metricVersion: string;
  };
  member: {
    policyADecision: string;
    policyAUnknownReason: string | null;
    productionHydrationState: string;
  } | null | undefined;
}): string {
  const reasons = input.metrics.historyIncompleteReasons ?? [];
  if (reasons.includes("unresolved_chain_order")) {
    return "terminal_unknown_unresolved_chain_order";
  }
  const durable = hasValidDurableIndexedCoverage({
    metrics: {
      metricVersion: input.coverage.metricVersion,
      credibilityMetricsValid: input.metrics.credibilityMetricsValid,
      historyValidity: input.metrics.historyValidity,
    },
    coverage: {
      walletAddress: "",
      metricVersion: input.coverage.metricVersion,
    },
  });
  if (
    durable &&
    input.metrics.historyValidity === "partial-but-metrics-safe" &&
    input.metrics.historyComplete === false &&
    (input.metrics.completedPositions ?? 0) < 10
  ) {
    return "terminal_unknown_insufficient_completed_positions_after_trustworthy_hydration";
  }
  if (
    reasons.some((r) =>
      ["activity_truncated", "trades_truncated", "historical_backfill_required"].includes(
        r
      )
    ) ||
    input.metrics.historyValidity === "partial-and-metrics-unsafe"
  ) {
    return "bounded_hydration_may_resolve_to_pass_or_fail";
  }
  if (reasons.includes("gamma_resolution_incomplete")) {
    return "gamma_backfill_may_resolve_without_full_rehydration";
  }
  return "classify_before_recovery";
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const db = getDb();
  const deploySince = new Date(DEPLOY_SINCE);
  const shadowState = loadShadowPeriodState();

  const [latestObs] = await db
    .select({
      observedAt: policyAShadowTradeObservations.observedAt,
      tradedAt: policyAShadowTradeObservations.tradedAt,
      tradeId: policyAShadowTradeObservations.tradeId,
      walletAddress: policyAShadowTradeObservations.walletAddress,
    })
    .from(policyAShadowTradeObservations)
    .orderBy(desc(policyAShadowTradeObservations.observedAt))
    .limit(1);

  const obsSinceDeploy = await db
    .select({
      count: sql<number>`count(*)::int`,
      distinctWallets: sql<number>`count(distinct ${policyAShadowTradeObservations.walletAddress})::int`,
      distinctTrades: sql<number>`count(distinct ${policyAShadowTradeObservations.tradeId})::int`,
      minObserved: sql<string>`min(${policyAShadowTradeObservations.observedAt})`,
      maxObserved: sql<string>`max(${policyAShadowTradeObservations.observedAt})`,
    })
    .from(policyAShadowTradeObservations)
    .where(gte(policyAShadowTradeObservations.observedAt, deploySince));

  const [latestDaily] = await db
    .select()
    .from(policyACoverageDailyMetrics)
    .orderBy(desc(policyACoverageDailyMetrics.dayKey))
    .limit(1);

  const dailySinceDeploy = await db
    .select()
    .from(policyACoverageDailyMetrics)
    .where(gte(policyACoverageDailyMetrics.dayKey, deploySince.toISOString().slice(0, 10)));

  const forwardDiag = await diagnoseForwardPerformance();

  const priorityWallets = [
    "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
    "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
  ];

  const cohort = await buildProductionWalletCohort();
  const priorityRepair = [];
  for (const wallet of priorityWallets) {
    const member = cohort.wallets.find((w) => w.wallet === wallet);
    const [metrics] = await db
      .select()
      .from(walletHistoricalMetrics)
      .where(
        and(
          eq(walletHistoricalMetrics.walletAddress, wallet),
          eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
        )
      )
      .limit(1);
    const [coverage] = await db
      .select()
      .from(walletHistoryCoverage)
      .where(eq(walletHistoryCoverage.walletAddress, wallet))
      .limit(1);

    priorityRepair.push({
      wallet,
      metrics: metrics
        ? {
            policyA: metrics.credibilityMetricsValid
              ? "indexed_valid"
              : "indexed_invalid",
            historyValidity: metrics.historyValidity,
            historyComplete: metrics.historyComplete,
            completedPositions: metrics.completedPositions,
            credibilityMetricsValid: metrics.credibilityMetricsValid,
            incompleteReasons: metrics.historyIncompleteReasons ?? [],
            credibilityReasons: metrics.credibilityReasons ?? [],
          }
        : null,
      coverage: coverage
        ? {
            identityComplete: coverage.identityComplete,
            eventHistoryComplete: coverage.eventHistoryComplete,
            metricVersion: coverage.metricVersion,
          }
        : null,
      frozenClassification: shadowState?.walletClassifications[wallet] ?? null,
      cohortMember: member ?? null,
      hydrationEligibility: member
        ? await (async () => {
            const ctx = await loadBatchHydrationEligibilityContext(wallet);
            return assessBatchHydrationEligibility({
              member,
              metricReasons: ctx.metricReasons,
              hydrationStatus: ctx.hydrationStatus,
              coverage: ctx.coverage,
            });
          })()
        : null,
      recoveryClassification:
        metrics && coverage
          ? classifyRecoveryOutcome({
              metrics,
              coverage,
              member,
            })
          : "needs_investigation_no_durable_state",
    });
  }

  const report = {
    mode: "policy_a_shadow_health_check",
    generatedAt: new Date().toISOString(),
    deploySince: DEPLOY_SINCE,
    shadowPeriodStartedAt: shadowState?.startedAt ?? null,
    liveWrites: {
      policyAShadowTradeObservations: {
        latestRow: latestObs ?? null,
        sinceDeploy: obsSinceDeploy[0] ?? null,
      },
      policyACoverageDailyMetrics: {
        latestRow: latestDaily ?? null,
        rowsSinceDeploy: dailySinceDeploy,
      },
    },
    forwardPerformanceDiagnostics: forwardDiag,
    priorityRepairAssessment: priorityRepair,
  };

  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error) => {
  console.error("[policy-a-shadow-health-check] failed:", error);
  process.exit(1);
});
