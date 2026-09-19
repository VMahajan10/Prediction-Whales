#!/usr/bin/env tsx
/**
 * Stage C final shadow evaluation — read-only, durable DB only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./preload-env";
import { sql, eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletShadowBatchStatus,
} from "@/lib/crossmarket/store/schema";
import {
  performanceVerdictFromPolicy,
  type PerformanceExplorationPolicy,
} from "@/lib/walletLedger/indexed/credibilityCandidateV2";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import { STAGE_C_COHORT_PATH } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

const BATCH_ID = STAGE_C_BATCH_ID;
const METRIC_VERSION = WALLET_METRIC_VERSION;
const EXPERIENCE_FLOORS = [10, 20, 50] as const;

const POLICY_A: PerformanceExplorationPolicy = {
  kind: "roi_gt_and_rate_gte",
  roiThreshold: 0,
  rateThreshold: 0.5,
  label: "Policy A (REFERENCE): ROI > 0 AND profitablePositionRate >= 50%",
};
const POLICY_B: PerformanceExplorationPolicy = {
  kind: "roi_gt_and_rate_gte",
  roiThreshold: 0,
  rateThreshold: 0.4,
  label: "Policy B (RATE LOOSENED): ROI > 0 AND profitablePositionRate >= 40%",
};
const POLICY_C: PerformanceExplorationPolicy = {
  kind: "roi_gte_and_rate_gte",
  roiThreshold: 0.03,
  rateThreshold: 0.5,
  label: "Policy C (ROI TIGHTENED): ROI >= 3% AND profitablePositionRate >= 50%",
};

const POLICIES = [
  { id: "A", policy: POLICY_A },
  { id: "B", policy: POLICY_B },
  { id: "C", policy: POLICY_C },
] as const;

interface EligibleWallet {
  wallet: string;
  completedPositions: number;
  realizedRoi: number | null;
  profitablePositionRate: number | null;
  resolvedVolumeUsd: number | null;
  medianCapitalAtRisk: number | null;
  productionDecision: boolean | null;
  productionGateReason: string | null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, idx)] ?? null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

function policyPass(w: EligibleWallet, policy: PerformanceExplorationPolicy): boolean {
  return (
    performanceVerdictFromPolicy({
      portfolioRealizedRoi: w.realizedRoi,
      profitablePositionRate: w.profitablePositionRate,
      policy,
    }) === "PASS"
  );
}

function bootstrapPassRate(
  wallets: EligibleWallet[],
  policy: PerformanceExplorationPolicy,
  iterations = 1000
): { p5: number; p95: number; mean: number } {
  const n = wallets.length;
  if (n === 0) return { p5: 0, p95: 0, mean: 0 };
  const rates: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample: EligibleWallet[] = [];
    for (let j = 0; j < n; j++) {
      sample.push(wallets[Math.floor(Math.random() * n)]!);
    }
    rates.push(sample.filter((w) => policyPass(w, policy)).length / n);
  }
  rates.sort((a, b) => a - b);
  return {
    mean: rates.reduce((s, v) => s + v, 0) / rates.length,
    p5: rates[Math.floor(0.05 * rates.length)] ?? 0,
    p95: rates[Math.floor(0.95 * rates.length)] ?? 0,
  };
}

function leaveOneOutMaxSwing(
  wallets: EligibleWallet[],
  policy: PerformanceExplorationPolicy
): number {
  const n = wallets.length;
  if (n === 0) return 0;
  const fullRate = wallets.filter((w) => policyPass(w, policy)).length / n;
  let maxSwing = 0;
  for (let i = 0; i < n; i++) {
    const subset = wallets.filter((_, idx) => idx !== i);
    const rate = subset.filter((w) => policyPass(w, policy)).length / subset.length;
    maxSwing = Math.max(maxSwing, Math.abs(rate - fullRate));
  }
  return maxSwing;
}

function failReason(
  w: EligibleWallet,
  policy: PerformanceExplorationPolicy
): "negative_roi" | "rate_below_threshold" | "both" | "pass" {
  if (policyPass(w, policy)) return "pass";
  const roi = w.realizedRoi;
  const rate = w.profitablePositionRate;
  let roiFail = false;
  let rateFail = false;
  if (policy.kind === "roi_gt_and_rate_gte") {
    roiFail = roi == null || !Number.isFinite(roi) || roi <= policy.roiThreshold;
    rateFail =
      rate == null || !Number.isFinite(rate) || rate < policy.rateThreshold;
  } else if (policy.kind === "roi_gte_and_rate_gte") {
    roiFail = roi == null || !Number.isFinite(roi) || roi < policy.roiThreshold;
    rateFail =
      rate == null || !Number.isFinite(rate) || rate < policy.rateThreshold;
  }
  if (roiFail && rateFail) return "both";
  if (roiFail) return "negative_roi";
  return "rate_below_threshold";
}

async function loadEligibleWallets(): Promise<EligibleWallet[]> {
  const cohort = JSON.parse(readFileSync(STAGE_C_COHORT_PATH, "utf8"));
  const wallets = cohort.wallets.map((w: { wallet: string }) =>
    w.wallet.toLowerCase()
  );
  const db = getDb();
  const statusRows = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(eq(walletShadowBatchStatus.batchId, BATCH_ID));
  const metricsRows = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      sql`${walletHistoricalMetrics.metricVersion} = ${METRIC_VERSION} AND ${walletHistoricalMetrics.walletAddress} IN (${sql.join(
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
  const eligible: EligibleWallet[] = [];
  for (const wallet of wallets) {
    const status = statusBy.get(wallet);
    const metrics = metricsBy.get(wallet);
    const coverage = coverageBy.get(wallet);
    if (status?.status !== "complete" || !coverage) continue;
    if (!metrics?.credibilityMetricsValid) continue;
    if ((metrics.completedPositions ?? 0) < 10) continue;
    let production = productionCache.get(wallet);
    if (!production) {
      production = await loadProductionCredibilitySnapshot(wallet);
      productionCache.set(wallet, production);
    }
    eligible.push({
      wallet,
      completedPositions: metrics.completedPositions,
      realizedRoi: metrics.realizedRoi,
      profitablePositionRate: metrics.profitablePositionRate,
      resolvedVolumeUsd: metrics.resolvedVolumeUsd,
      medianCapitalAtRisk: metrics.medianCapitalAtRisk,
      productionDecision: production.productionCredible,
      productionGateReason: production.productionGateReason,
    });
  }
  return eligible;
}

function policyResults(
  wallets: EligibleWallet[],
  policy: PerformanceExplorationPolicy
) {
  const passing = wallets.filter((w) => policyPass(w, policy));
  const failing = wallets.filter((w) => !policyPass(w, policy));
  const n = wallets.length;
  const passRoi = passing
    .map((w) => w.realizedRoi)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const passRate = passing
    .map((w) => w.profitablePositionRate)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const passVol = passing
    .map((w) => w.resolvedVolumeUsd)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const passPos = passing.map((w) => w.completedPositions);
  const boot = bootstrapPassRate(wallets, policy);
  return {
    eligibleN: n,
    passN: passing.length,
    failN: failing.length,
    passRate: n > 0 ? passing.length / n : null,
    bootstrap90: { p5: boot.p5, p95: boot.p95, mean: boot.mean },
    passMedians: {
      completedPositions: median(passPos),
      realizedRoi: median(passRoi),
      profitablePositionRate: median(passRate),
      resolvedVolumeUsd: median(passVol),
    },
    leaveOneOutMaxSwingPp: leaveOneOutMaxSwing(wallets, policy) * 100,
    floorPassRates: Object.fromEntries(
      EXPERIENCE_FLOORS.map((floor) => {
        const pop = wallets.filter((w) => w.completedPositions >= floor);
        const rate =
          pop.length > 0
            ? pop.filter((w) => policyPass(w, policy)).length / pop.length
            : null;
        return [floor, { n: pop.length, passRate: rate }];
      })
    ),
    passingWallets: passing.map((w) => w.wallet),
  };
}

function productionMatrix(
  wallets: EligibleWallet[],
  policy: PerformanceExplorationPolicy
) {
  const known = wallets.filter((w) => w.productionDecision != null);
  const unknown = wallets.filter((w) => w.productionDecision == null);
  const histPass = (w: EligibleWallet) => policyPass(w, policy);
  return {
    denominators: {
      productionKnownN: known.length,
      productionUnknownN: unknown.length,
      eligibleN: wallets.length,
    },
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

function distSummary(values: number[]) {
  if (values.length === 0) return { n: 0, min: null, median: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    median: median(sorted),
    max: sorted[sorted.length - 1],
  };
}

async function main(): Promise<void> {
  const eligible = await loadEligibleWallets();
  const passMap = {
    A: new Set(eligible.filter((w) => policyPass(w, POLICY_A)).map((w) => w.wallet)),
    B: new Set(eligible.filter((w) => policyPass(w, POLICY_B)).map((w) => w.wallet)),
    C: new Set(eligible.filter((w) => policyPass(w, POLICY_C)).map((w) => w.wallet)),
  };

  const overlap = {
    passAll3: eligible.filter(
      (w) => passMap.A.has(w.wallet) && passMap.B.has(w.wallet) && passMap.C.has(w.wallet)
    ).length,
    passAB_notC: eligible.filter(
      (w) =>
        passMap.A.has(w.wallet) && passMap.B.has(w.wallet) && !passMap.C.has(w.wallet)
    ).length,
    passAC_notB: eligible.filter(
      (w) =>
        passMap.A.has(w.wallet) && !passMap.B.has(w.wallet) && passMap.C.has(w.wallet)
    ).length,
    passB_only: eligible.filter(
      (w) =>
        !passMap.A.has(w.wallet) && passMap.B.has(w.wallet) && !passMap.C.has(w.wallet)
    ).length,
    passC_only: eligible.filter(
      (w) =>
        !passMap.A.has(w.wallet) && !passMap.B.has(w.wallet) && passMap.C.has(w.wallet)
    ).length,
    failAll: eligible.filter(
      (w) =>
        !passMap.A.has(w.wallet) && !passMap.B.has(w.wallet) && !passMap.C.has(w.wallet)
    ).length,
  };

  const flipWallets = eligible
    .filter((w) => {
      const a = passMap.A.has(w.wallet);
      const b = passMap.B.has(w.wallet);
      const c = passMap.C.has(w.wallet);
      return a !== b || a !== c || b !== c;
    })
    .map((w) => ({
      wallet: w.wallet,
      policyA: passMap.A.has(w.wallet),
      policyB: passMap.B.has(w.wallet),
      policyC: passMap.C.has(w.wallet),
      completedPositions: w.completedPositions,
      realizedRoi: w.realizedRoi,
      profitablePositionRate: w.profitablePositionRate,
      resolvedVolumeUsd: w.resolvedVolumeUsd,
      productionDecision: w.productionDecision,
    }));

  const policyReports = Object.fromEntries(
    POLICIES.map(({ id, policy }) => [
      id,
      {
        label: policy.label,
        results: policyResults(eligible, policy),
        productionDisagreement: productionMatrix(eligible, policy),
        productionPassHistoricalFail: (() => {
          const group = eligible.filter(
            (w) => w.productionDecision === true && !policyPass(w, policy)
          );
          const reasons = { negative_roi: 0, rate_below_threshold: 0, both: 0 };
          for (const w of group) {
            const r = failReason(w, policy);
            if (r !== "pass") reasons[r] += 1;
          }
          return {
            n: group.length,
            failReasonCounts: reasons,
            distributions: {
              completedPositions: distSummary(
                group.map((w) => w.completedPositions)
              ),
              realizedRoi: distSummary(
                group
                  .map((w) => w.realizedRoi)
                  .filter((v): v is number => v != null && Number.isFinite(v))
              ),
              profitablePositionRate: distSummary(
                group
                  .map((w) => w.profitablePositionRate)
                  .filter((v): v is number => v != null && Number.isFinite(v))
              ),
              resolvedVolumeUsd: distSummary(
                group
                  .map((w) => w.resolvedVolumeUsd)
                  .filter((v): v is number => v != null && Number.isFinite(v))
              ),
            },
            wallets: group.map((w) => ({
              wallet: w.wallet,
              completedPositions: w.completedPositions,
              realizedRoi: w.realizedRoi,
              profitablePositionRate: w.profitablePositionRate,
              resolvedVolumeUsd: w.resolvedVolumeUsd,
              failReason: failReason(w, policy),
            })),
          };
        })(),
      },
    ])
  );

  const historicalPassRobustness = Object.fromEntries(
    POLICIES.map(({ id, policy }) => {
      const passers = eligible.filter((w) => policyPass(w, policy));
      const roi = passers
        .map((w) => w.realizedRoi)
        .filter((v): v is number => v != null);
      const sortedRoi = [...roi].sort((a, b) => a - b);
      const top3RoiShare =
        roi.length > 0
          ? sortedRoi.slice(-3).reduce((s, v) => s + v, 0) /
            roi.reduce((s, v) => s + Math.max(0, v), 0.0001)
          : null;
      const smallSample = passers.filter((w) => w.completedPositions < 20).length;
      return [
        id,
        {
          passN: passers.length,
          completedPositions: distSummary(
            passers.map((w) => w.completedPositions)
          ),
          smallSamplePassN: smallSample,
          smallSamplePassPct:
            passers.length > 0 ? smallSample / passers.length : null,
          extremePositiveRoiPassN: passers.filter(
            (w) => (w.realizedRoi ?? 0) > 0.5
          ).length,
          floorPassRates: {
            gte20: policyResults(
              eligible.filter((w) => w.completedPositions >= 20),
              policy
            ).passRate,
            gte50: policyResults(
              eligible.filter((w) => w.completedPositions >= 50),
              policy
            ).passRate,
          },
          top3PositiveRoiContributionShare: top3RoiShare,
        },
      ];
    })
  );

  const report = {
    batchId: BATCH_ID,
    metricVersion: METRIC_VERSION,
    mode: "final_shadow_evaluation",
    eligibilityCriteria: {
      batchStatus: "complete",
      walletHistoryCoverage: "present",
      credibilityMetricsValid: true,
      completedPositionsGte: 10,
    },
    eligibleN: eligible.length,
    policies: policyReports,
    overlap,
    flipWallets,
    historicalPassRobustness,
    semantics: {
      avgEvDeprecated: true,
      completedPositionsNotResolvedBets: true,
      indexedDataValidityIsTrustNotPerformance: true,
    },
  };

  const outPath = join(
    process.cwd(),
    "tmp/wallet-history/stageC-final-shadow-evaluation-20260910.json"
  );
  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error) => {
  console.error("[stageC-final-shadow-evaluation] failed:", error);
  process.exit(1);
});
