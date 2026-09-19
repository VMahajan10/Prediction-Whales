import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletShadowBatchStatus,
} from "@/lib/crossmarket/store/schema";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import { STAGE_C_COHORT_PATH } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

export const STAGE_C_DURABLE_ELIGIBILITY_FLOOR = 10;

export interface StageCDurableEligibleWallet {
  wallet: string;
  completedPositions: number;
  realizedRoi: number | null;
  profitablePositionRate: number | null;
  productionDecision: boolean | null;
  historicalPerformanceDecision: "PASS" | "FAIL" | "UNKNOWN";
  historicalPerformanceFailureReasons: string[];
}

export async function loadStageCDurableEligibleWallets(input?: {
  batchId?: string;
  cohortPath?: string;
  metricVersion?: string;
}): Promise<StageCDurableEligibleWallet[]> {
  const batchId = input?.batchId ?? STAGE_C_BATCH_ID;
  const cohortPath = input?.cohortPath ?? STAGE_C_COHORT_PATH;
  const metricVersion = input?.metricVersion ?? WALLET_METRIC_VERSION;
  const cohort = JSON.parse(readFileSync(cohortPath, "utf8"));
  const wallets = cohort.wallets.map((w: { wallet: string }) =>
    w.wallet.toLowerCase()
  );
  const db = getDb();
  const statusRows = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(eq(walletShadowBatchStatus.batchId, batchId));
  const metricsRows = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      sql`${walletHistoricalMetrics.metricVersion} = ${metricVersion} AND ${walletHistoricalMetrics.walletAddress} IN (${sql.join(
        wallets.map((w: string) => sql`${w}`),
        sql`, `
      )})`
    );
  const coverageRows = await db
    .select()
    .from(walletHistoryCoverage)
    .where(
      sql`${walletHistoryCoverage.walletAddress} IN (${sql.join(
        wallets.map((w: string) => sql`${w}`),
        sql`, `
      )})`
    );
  const statusBy = new Map(
    statusRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );
  const metricsBy = new Map(
    metricsRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );
  const coverageBy = new Map(
    coverageRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );
  const productionCache = new Map<
    string,
    Awaited<ReturnType<typeof loadProductionCredibilitySnapshot>>
  >();
  const eligible: StageCDurableEligibleWallet[] = [];
  for (const wallet of wallets) {
    const status = statusBy.get(wallet);
    const metrics = metricsBy.get(wallet);
    const coverage = coverageBy.get(wallet);
    if (status?.status !== "complete" || !coverage) continue;
    if (!metrics?.credibilityMetricsValid) continue;
    if ((metrics.completedPositions ?? 0) < STAGE_C_DURABLE_ELIGIBILITY_FLOOR) {
      continue;
    }
    let production = productionCache.get(wallet);
    if (!production) {
      production = await loadProductionCredibilitySnapshot(wallet);
      productionCache.set(wallet, production);
    }
    const verdict = evaluateHistoricalPerformanceVerdict({
      indexedDataValidity: true,
      historyComplete: metrics.historyComplete ?? undefined,
      historyValidity: metrics.historyValidity,
      completedPositionCount: metrics.completedPositions,
      realizedRoi: metrics.realizedRoi,
      profitablePositionRate: metrics.profitablePositionRate,
      metricVersion: metrics.metricVersion,
    });
    eligible.push({
      wallet,
      completedPositions: metrics.completedPositions,
      realizedRoi: metrics.realizedRoi,
      profitablePositionRate: metrics.profitablePositionRate,
      productionDecision: production.productionCredible,
      historicalPerformanceDecision: verdict.historicalPerformanceDecision,
      historicalPerformanceFailureReasons:
        verdict.historicalPerformanceFailureReasons,
    });
  }
  return eligible;
}

export function summarizeProductionVsHistoricalPerformance(
  wallets: StageCDurableEligibleWallet[]
) {
  const known = wallets.filter((w) => w.productionDecision != null);
  const unknown = wallets.filter((w) => w.productionDecision == null);
  const histPass = (w: StageCDurableEligibleWallet) =>
    w.historicalPerformanceDecision === "PASS";
  return {
    eligibleN: wallets.length,
    historicalPassN: wallets.filter((w) => histPass(w)).length,
    historicalFailN: wallets.filter(
      (w) => w.historicalPerformanceDecision === "FAIL"
    ).length,
    historicalUnknownN: wallets.filter(
      (w) => w.historicalPerformanceDecision === "UNKNOWN"
    ).length,
    productionKnownN: known.length,
    productionUnknownN: unknown.length,
    productionPass_histPass: known.filter(
      (w) => w.productionDecision === true && histPass(w)
    ).length,
    productionPass_histFail: known.filter(
      (w) => w.productionDecision === true && !histPass(w)
    ).length,
    productionFail_histPass: known.filter(
      (w) => w.productionDecision === false && histPass(w)
    ).length,
    productionFail_histFail: known.filter(
      (w) => w.productionDecision === false && !histPass(w)
    ).length,
    productionUnknown_histPass: unknown.filter((w) => histPass(w)).length,
    productionUnknown_histFail: unknown.filter((w) => !histPass(w)).length,
  };
}
