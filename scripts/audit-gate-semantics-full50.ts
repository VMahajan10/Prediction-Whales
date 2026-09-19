#!/usr/bin/env tsx
import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  whaleRegistry,
  walletHistoricalMetrics,
  walletShadowResults,
} from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  MIN_WALLET_AVG_EV_DECIMAL,
  MIN_WALLET_RESOLVED_BETS,
} from "@/lib/x-agent/gateMetrics";
import { walletMeetsCredibilityCriteria } from "@/lib/x-agent/walletCredibility";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import {
  observationsToComparisonRows,
  recoverBatchShadowObservations,
} from "@/lib/walletLedger/indexed/shadow/shadowResultRecovery";

const FAIL_WALLETS = [
  "0xea6be1aefaaeda2d3c04dce5cea85e0bdc237fb1",
  "0xc20213ebbbc68bdecf3e712f8a1b3f7b3fb01623",
  "0x5f38747053bb642bb3ad456c5766ad9e6fb9eb70",
  "0xb6ed7b123bd7431139fefc6f24203934ee23cd23",
  "0x983f66208b937de8c190fa023ca2e29b731395e2",
  "0x6129d21da529b6d8d324131a9cf2b37b0b840807",
  "0xada100874d00e3331d00f2007a9c336a65009718",
];

const SIX_FAIL_PASS = FAIL_WALLETS.slice(0, 6);

function thresholdParityIndexedDecision(input: {
  credibilityMetricsValid: boolean;
  completedPositions: number;
}): boolean {
  return (
    input.credibilityMetricsValid && input.completedPositions >= MIN_WALLET_RESOLVED_BETS
  );
}

function buildMatrix(
  rows: Array<{
    productionDecision: boolean | null;
    indexedDecision: boolean;
  }>
) {
  const metricsSafe = rows.filter((r) => r.productionDecision != null || true);
  const withKnown = rows.filter((r) => r.productionDecision != null);
  const passToPass = withKnown.filter(
    (r) => r.productionDecision === true && r.indexedDecision
  ).length;
  const passToFail = withKnown.filter(
    (r) => r.productionDecision === true && !r.indexedDecision
  ).length;
  const failToPass = withKnown.filter(
    (r) => r.productionDecision === false && r.indexedDecision
  ).length;
  const failToFail = withKnown.filter(
    (r) => r.productionDecision === false && !r.indexedDecision
  ).length;
  return {
    nKnown: withKnown.length,
    passToPass,
    passToFail,
    failToPass,
    failToFail,
    metricsSafeTotal: metricsSafe.length,
  };
}

async function main(): Promise<void> {
  const db = getDb();
  const observations = await recoverBatchShadowObservations("phase2e1-full50-v2");
  const rows = observationsToComparisonRows(observations);
  const metricsSafeRows = rows.filter((r) => r.status === "complete");

  const currentMatrix = {
    nKnown: 0,
    passToPass: 0,
    passToFail: 0,
    failToPass: 0,
    failToFail: 0,
  };
  for (const row of metricsSafeRows) {
    if (row.productionDecision == null) continue;
    currentMatrix.nKnown += 1;
    if (row.productionDecision && row.indexedDecision) currentMatrix.passToPass += 1;
    if (row.productionDecision && !row.indexedDecision) currentMatrix.passToFail += 1;
    if (!row.productionDecision && row.indexedDecision) currentMatrix.failToPass += 1;
    if (!row.productionDecision && !row.indexedDecision) currentMatrix.failToFail += 1;
  }

  const parityRows = metricsSafeRows.map((row) => {
    const obs = observations.find(
      (o) => o.wallet.toLowerCase() === row.wallet.toLowerCase()
    );
    const completed = Number(
      obs?.indexedMetricsSnapshot?.indexedCompletedPositions ??
        row.evidence.indexedCompletedPositions ??
        0
    );
    const credibilityMetricsValid = obs?.credibilityMetricsValid ?? false;
    return {
      wallet: row.wallet,
      productionDecision: row.productionDecision,
      thresholdParityC: thresholdParityIndexedDecision({
        credibilityMetricsValid,
        completedPositions: completed,
      }),
    };
  });

  const parityMatrix = {
    nKnown: 0,
    passToPass: 0,
    passToFail: 0,
    failToPass: 0,
    failToFail: 0,
  };
  for (const row of parityRows) {
    if (row.productionDecision == null) continue;
    parityMatrix.nKnown += 1;
    if (row.productionDecision && row.thresholdParityC) parityMatrix.passToPass += 1;
    if (row.productionDecision && !row.thresholdParityC) parityMatrix.passToFail += 1;
    if (!row.productionDecision && row.thresholdParityC) parityMatrix.failToPass += 1;
    if (!row.productionDecision && !row.thresholdParityC) parityMatrix.failToFail += 1;
  }

  const walletAudits = [];
  for (const wallet of FAIL_WALLETS) {
    const normalized = wallet.toLowerCase();
    const whaleRows = await db
      .select()
      .from(whaleRegistry)
      .where(sql`lower(${whaleRegistry.walletAddress}) = ${normalized}`)
      .limit(1);
    const metricRows = await db
      .select()
      .from(walletHistoricalMetrics)
      .where(
        sql`lower(${walletHistoricalMetrics.walletAddress}) = ${normalized} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
      )
      .limit(1);
    const shadowRows = await db
      .select()
      .from(walletShadowResults)
      .where(
        sql`${walletShadowResults.batchId} = 'phase2e1-full50-v2' AND lower(${walletShadowResults.walletAddress}) = ${normalized}`
      )
      .limit(1);

    const production = await loadProductionCredibilitySnapshot(wallet);
    const whale = whaleRows[0];
    const metrics = metricRows[0];
    const shadow = shadowRows[0];

    const prodStats = whale
      ? {
          resolvedBetsCount: whale.resolvedBetsCount,
          avgEv: whale.avgEv,
          winRate: whale.winRate,
          closedCount: whale.resolvedBetsCount,
        }
      : null;

    const thresholdParityC = metrics
      ? thresholdParityIndexedDecision({
          credibilityMetricsValid: metrics.credibilityMetricsValid,
          completedPositions: metrics.completedPositions,
        })
      : false;

    let disagreementClass:
      | "DATA_FALSE_NEGATIVE"
      | "SEMANTIC_DIFFERENCE"
      | "MIXED"
      | "UNUSABLE" = "SEMANTIC_DIFFERENCE";

    if (metrics?.historyValidity === "unusable") {
      disagreementClass = "UNUSABLE";
    } else if (
      production.resolvedBetsCount != null &&
      production.resolvedBetsCount < MIN_WALLET_RESOLVED_BETS &&
      metrics &&
      metrics.completedPositions >= MIN_WALLET_RESOLVED_BETS
    ) {
      disagreementClass = "DATA_FALSE_NEGATIVE";
    } else if (
      production.resolvedBetsCount != null &&
      production.resolvedBetsCount < MIN_WALLET_RESOLVED_BETS &&
      metrics &&
      metrics.completedPositions < MIN_WALLET_RESOLVED_BETS &&
      metrics.credibilityMetricsValid
    ) {
      disagreementClass = "SEMANTIC_DIFFERENCE";
    } else if (
      production.resolvedBetsCount != null &&
      metrics &&
      production.resolvedBetsCount < MIN_WALLET_RESOLVED_BETS &&
      metrics.completedPositions >= MIN_WALLET_RESOLVED_BETS
    ) {
      disagreementClass = "MIXED";
    }

    walletAudits.push({
      wallet,
      production: {
        resolvedBetsCount: production.resolvedBetsCount,
        resolvedBetsThreshold: MIN_WALLET_RESOLVED_BETS,
        avgEv: production.avgEv,
        avgEvThreshold: MIN_WALLET_AVG_EV_DECIMAL,
        avgStakeNotional: production.avgStakeNotional,
        hydrationStatus: production.hydrationStatus,
        gateExpression:
          "hydrationStatus==='complete' && resolvedBetsCount>=10 && avgEv>=0.03",
        meetsCriteria: prodStats
          ? walletMeetsCredibilityCriteria(prodStats)
          : null,
        productionCredible: production.productionCredible,
        productionGateReason: production.productionGateReason,
      },
      indexed: metrics
        ? {
            completedPositionCount: metrics.completedPositions,
            completedPositionFloorEnforcedByGate: false,
            medianCapitalAtRisk: metrics.medianCapitalAtRisk,
            resolvedVolumeUsd: metrics.resolvedVolumeUsd,
            portfolioRealizedRoi: metrics.realizedRoi,
            profitablePositionRate: metrics.profitablePositionRate,
            outcomeWinRate: metrics.outcomeWinRate,
            historyValidity: metrics.historyValidity,
            credibilityMetricsValid: metrics.credibilityMetricsValid,
            credibilityDecision: metrics.credibilityDecision,
            gateExpression:
              "credibilityMetricsValid (structural validity only; no count/ROI floor)",
            gateReasons: metrics.credibilityReasons,
          }
        : null,
      shadow: shadow
        ? {
            A: shadow.productionDecision,
            C: shadow.indexedDecision,
            thresholdParityC,
          }
        : null,
      delta:
        metrics && production.resolvedBetsCount != null
          ? metrics.completedPositions - production.resolvedBetsCount
          : null,
      disagreementClass,
      wouldCPassWithFloor10: thresholdParityC,
    });
  }

  console.log(
    JSON.stringify(
      {
        constants: {
          MIN_WALLET_RESOLVED_BETS,
          MIN_WALLET_AVG_EV_DECIMAL,
        },
        currentMatrix,
        parityMatrix,
        sixFailPassParity: walletAudits
          .slice(0, 6)
          .map((w) => ({
            wallet: w.wallet,
            prodResolved: w.production.resolvedBetsCount,
            indexedCompleted: w.indexed?.completedPositionCount,
            currentC: w.indexed?.credibilityDecision,
            thresholdParityC: w.wouldCPassWithFloor10,
          })),
        walletAudits,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
