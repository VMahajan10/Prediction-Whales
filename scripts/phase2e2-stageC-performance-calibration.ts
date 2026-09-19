#!/usr/bin/env tsx
/**
 * Stage C interim performance calibration — read-only, durable DB only.
 */
import "./preload-env";
import { readFileSync } from "node:fs";
import { sql, eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletShadowBatchStatus,
} from "@/lib/crossmarket/store/schema";
import {
  performanceVerdictFromPolicy,
  STAGE_C_EXPLORATORY_PERFORMANCE_POLICIES,
  type PerformanceExplorationPolicy,
} from "@/lib/walletLedger/indexed/credibilityCandidateV2";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import { STAGE_C_COHORT_PATH } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

const BATCH_ID = STAGE_C_BATCH_ID;
const METRIC_VERSION = WALLET_METRIC_VERSION;
const EXPERIENCE_FLOORS = [10, 20, 50] as const;

interface EligibleWallet {
  wallet: string;
  completedPositions: number;
  realizedRoi: number | null;
  profitablePositionRate: number | null;
  resolvedVolumeUsd: number | null;
  medianCapitalAtRisk: number | null;
  historyValidity: string | null;
  historyComplete: boolean | null;
  productionDecision: boolean | null;
  structurallyValid: boolean;
}

interface Distribution {
  n: number;
  min: number | null;
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, idx)] ?? null;
}

function dist(values: number[]): Distribution {
  if (values.length === 0) {
    return { n: 0, min: null, p10: null, p25: null, median: null, p75: null, p90: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p10: percentile(sorted, 10),
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    max: sorted[sorted.length - 1] ?? null,
  };
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const vx = xs[i]! - mx, vy = ys[i]! - my;
    num += vx * vy; dx += vx * vx; dy += vy * vy;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rank = (values: number[]) => {
    const indexed = values.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(values.length);
    for (let r = 0; r < indexed.length; r++) ranks[indexed[r]!.i] = r + 1;
    return ranks;
  };
  return pearson(rank(xs), rank(ys));
}

function policyPass(w: EligibleWallet, policy: PerformanceExplorationPolicy): boolean {
  return performanceVerdictFromPolicy({
    portfolioRealizedRoi: w.realizedRoi,
    profitablePositionRate: w.profitablePositionRate,
    policy,
  }) === "PASS";
}

function bootstrapPassRateStability(
  wallets: EligibleWallet[],
  policy: PerformanceExplorationPolicy,
  iterations = 1000
): { mean: number; p5: number; p95: number; std: number } {
  const n = wallets.length;
  if (n === 0) return { mean: 0, p5: 0, p95: 0, std: 0 };
  const rates: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample: EligibleWallet[] = [];
    for (let j = 0; j < n; j++) {
      sample.push(wallets[Math.floor(Math.random() * n)]!);
    }
    rates.push(sample.filter((w) => policyPass(w, policy)).length / n);
  }
  rates.sort((a, b) => a - b);
  const mean = rates.reduce((s, v) => s + v, 0) / rates.length;
  const variance = rates.reduce((s, v) => s + (v - mean) ** 2, 0) / rates.length;
  return {
    mean,
    p5: rates[Math.floor(0.05 * rates.length)] ?? 0,
    p95: rates[Math.floor(0.95 * rates.length)] ?? 0,
    std: Math.sqrt(variance),
  };
}

function leaveOneOutSensitivity(
  wallets: EligibleWallet[],
  policy: PerformanceExplorationPolicy
): { maxPassRateSwing: number; medianPassRate: number } {
  const n = wallets.length;
  if (n === 0) return { maxPassRateSwing: 0, medianPassRate: 0 };
  const fullRate = wallets.filter((w) => policyPass(w, policy)).length / n;
  let maxSwing = 0;
  for (let i = 0; i < n; i++) {
    const subset = wallets.filter((_, idx) => idx !== i);
    const rate = subset.filter((w) => policyPass(w, policy)).length / subset.length;
    maxSwing = Math.max(maxSwing, Math.abs(rate - fullRate));
  }
  return { maxPassRateSwing: maxSwing, medianPassRate: fullRate };
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

  const statusByWallet = new Map(
    statusRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );
  const metricsByWallet = new Map(
    metricsRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );
  const coverageByWallet = new Map(
    coverageRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );

  const productionCache = new Map<string, Awaited<ReturnType<typeof loadProductionCredibilitySnapshot>>>();
  const eligible: EligibleWallet[] = [];
  for (const wallet of wallets) {
    const status = statusByWallet.get(wallet);
    const metrics = metricsByWallet.get(wallet);
    const coverage = coverageByWallet.get(wallet);
    if (status?.status !== "complete") continue;
    if (!coverage) continue;
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
      historyValidity: metrics.historyValidity,
      historyComplete: metrics.historyComplete,
      productionDecision: production.productionCredible,
      structurallyValid:
        metrics.credibilityMetricsValid === true &&
        coverage != null &&
        status.status === "complete",
    });
  }
  return eligible;
}

function identifyOutliers(wallets: EligibleWallet[]) {
  const roiValues = wallets.map((w) => w.realizedRoi).filter((v): v is number => v != null && Number.isFinite(v));
  const rateValues = wallets.map((w) => w.profitablePositionRate).filter((v): v is number => v != null && Number.isFinite(v));
  const posDist = dist(roiValues);
  const rateDist = dist(rateValues);
  const posP10 = posDist.p10 ?? 0;
  const posP90 = posDist.p90 ?? 0;
  const rateP10 = rateDist.p10 ?? 0;
  const rateP90 = rateDist.p90 ?? 0;

  const flags: Array<{
    wallet: string;
    flags: string[];
    completedPositions: number;
    realizedRoi: number | null;
    profitablePositionRate: number | null;
    resolvedVolumeUsd: number | null;
    structurallyValid: boolean;
  }> = [];

  for (const w of wallets) {
    const f: string[] = [];
    const roi = w.realizedRoi;
    const rate = w.profitablePositionRate;
    if (roi != null && roi > posP90) f.push("extreme_positive_roi");
    if (roi != null && roi < posP10) f.push("extreme_negative_roi");
    if (rate != null && rate > rateP90) f.push("unusually_high_profitable_rate");
    if (roi != null && roi > 0.15 && w.completedPositions < 20) f.push("high_roi_small_sample");
    if (w.completedPositions >= 200) f.push("very_large_completed_positions");
    if ((w.resolvedVolumeUsd ?? 0) > 500_000) f.push("very_large_resolved_volume");
    if ((w.medianCapitalAtRisk ?? 0) > 50_000) f.push("very_large_median_capital");
    if (f.length > 0) {
      flags.push({
        wallet: w.wallet,
        flags: f,
        completedPositions: w.completedPositions,
        realizedRoi: w.realizedRoi,
        profitablePositionRate: w.profitablePositionRate,
        resolvedVolumeUsd: w.resolvedVolumeUsd,
        structurallyValid: w.structurallyValid,
      });
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const allEligible = await loadEligibleWallets();

  const floorPopulations = Object.fromEntries(
    EXPERIENCE_FLOORS.map((floor) => [
      floor,
      allEligible.filter((w) => w.completedPositions >= floor),
    ])
  ) as Record<10 | 20 | 50, EligibleWallet[]>;

  const base = floorPopulations[10]!;
  const roiValues = base.map((w) => w.realizedRoi).filter((v): v is number => v != null && Number.isFinite(v));
  const rateValues = base.map((w) => w.profitablePositionRate).filter((v): v is number => v != null && Number.isFinite(v));
  const volValues = base.map((w) => w.resolvedVolumeUsd).filter((v): v is number => v != null && Number.isFinite(v));
  const capValues = base.map((w) => w.medianCapitalAtRisk).filter((v): v is number => v != null && Number.isFinite(v));
  const posCounts = base.map((w) => w.completedPositions);

  const floorSensitivity = EXPERIENCE_FLOORS.map((floor) => {
    const pop = floorPopulations[floor]!;
    const froi = pop.map((w) => w.realizedRoi).filter((v): v is number => v != null && Number.isFinite(v));
    const frate = pop.map((w) => w.profitablePositionRate).filter((v): v is number => v != null && Number.isFinite(v));
    return {
      floor,
      n: pop.length,
      realizedRoi: dist(froi),
      profitablePositionRate: dist(frate),
    };
  });

  const policyGrid = EXPERIENCE_FLOORS.flatMap((floor) => {
    const pop = floorPopulations[floor]!;
    return STAGE_C_EXPLORATORY_PERFORMANCE_POLICIES.map((policy) => {
      const passing = pop.filter((w) => policyPass(w, policy));
      const withProd = pop.filter((w) => w.productionDecision != null);
      return {
        experienceFloor: floor,
        policy: policy.label,
        policyKind: policy.kind,
        eligibleN: pop.length,
        passN: passing.length,
        passPct: pop.length > 0 ? passing.length / pop.length : null,
        productionMatrix: {
          passToPass: withProd.filter((w) => w.productionDecision === true && policyPass(w, policy)).length,
          passToFail: withProd.filter((w) => w.productionDecision === true && !policyPass(w, policy)).length,
          failToPass: withProd.filter((w) => w.productionDecision === false && policyPass(w, policy)).length,
          failToFail: withProd.filter((w) => w.productionDecision === false && !policyPass(w, policy)).length,
          productionKnownN: withProd.length,
        },
      };
    });
  });

  const referencePolicy = STAGE_C_EXPLORATORY_PERFORMANCE_POLICIES.find((p) =>
    p.label.includes("ROI > 0 AND profitablePositionRate >= 0.50")
  )!;
  const bootstrap = bootstrapPassRateStability(base, referencePolicy);
  const loo = leaveOneOutSensitivity(base, referencePolicy);

  const medianRoi = dist(roiValues).median ?? 0;
  const medianRate = dist(rateValues).median ?? 0;
  const bootstrapMedianRoi = (() => {
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const s = base.map(() => base[Math.floor(Math.random() * base.length)]!);
      const vals = s.map((w) => w.realizedRoi).filter((v): v is number => v != null);
      samples.push(dist(vals).median ?? 0);
    }
    samples.sort((a, b) => a - b);
    return { p5: samples[50], p95: samples[950], current: medianRoi };
  })();

  let stabilityVerdict: "ENOUGH_TO_CALIBRATE" | "PROMISING_BUT_MORE_DATA_NEEDED" | "TOO_SMALL";
  if (base.length >= 80) stabilityVerdict = "ENOUGH_TO_CALIBRATE";
  else if (base.length >= 40 && bootstrap.std < 0.08 && loo.maxPassRateSwing < 0.06) {
    stabilityVerdict = "PROMISING_BUT_MORE_DATA_NEEDED";
  } else if (base.length < 30) {
    stabilityVerdict = "TOO_SMALL";
  } else {
    stabilityVerdict = "PROMISING_BUT_MORE_DATA_NEEDED";
  }

  const walletsNeeded =
    stabilityVerdict === "ENOUGH_TO_CALIBRATE"
      ? 0
      : Math.max(0, 80 - base.length);

  const report = {
    batchId: BATCH_ID,
    metricVersion: METRIC_VERSION,
    eligibilityCriteria: {
      batchStatus: "complete",
      walletHistoryCoverage: "present",
      credibilityMetricsValid: true,
      completedPositionsGte: 10,
    },
    exactEligibleN: base.length,
    floorCounts: {
      gte10: floorPopulations[10]!.length,
      gte20: floorPopulations[20]!.length,
      gte50: floorPopulations[50]!.length,
    },
    completedPositionDistribution: dist(posCounts),
    realizedRoiDistribution: dist(roiValues),
    profitablePositionRateDistribution: dist(rateValues),
    reportingOnly: {
      resolvedVolumeUsd: dist(volValues),
      medianCapitalAtRisk: dist(capValues),
    },
    correlations: {
      completed_vs_roi_pearson: pearson(posCounts, roiValues),
      completed_vs_rate_pearson: pearson(posCounts, rateValues),
      roi_vs_rate_spearman: spearman(roiValues, rateValues),
      roi_vs_volume_spearman: spearman(
        base.filter((w) => w.resolvedVolumeUsd != null).map((w) => w.resolvedVolumeUsd!),
        base.filter((w) => w.realizedRoi != null).map((w) => w.realizedRoi!)
      ),
      rate_vs_capital_spearman: spearman(
        base.filter((w) => w.medianCapitalAtRisk != null).map((w) => w.medianCapitalAtRisk!),
        base.filter((w) => w.profitablePositionRate != null).map((w) => w.profitablePositionRate!)
      ),
    },
    experienceFloorSensitivity: floorSensitivity,
    outliers: identifyOutliers(base),
    policyGrid,
    stability: {
      referencePolicy: referencePolicy.label,
      bootstrapPassRate: bootstrap,
      leaveOneOut: loo,
      bootstrapMedianRoi,
      verdict: stabilityVerdict,
      walletsNeededApprox: walletsNeeded,
      note:
        "Adding 15-25 structurally valid wallets would shift bootstrap pass-rate CI by ~±" +
        `${(bootstrap.std * Math.sqrt(base.length / (base.length + 20)) * 100).toFixed(1)}pp if new wallets resemble current sample.`,
    },
    productionComparison: {
      note: "Informational only — production unchanged",
      indexedDataValidityIsTrustNotPerformance: true,
      forReferencePolicy: (() => {
        const withProd = base.filter((w) => w.productionDecision != null);
        return {
          policy: referencePolicy.label,
          passToPass: withProd.filter((w) => w.productionDecision === true && policyPass(w, referencePolicy)).length,
          passToFail: withProd.filter((w) => w.productionDecision === true && !policyPass(w, referencePolicy)).length,
          failToPass: withProd.filter((w) => w.productionDecision === false && policyPass(w, referencePolicy)).length,
          failToFail: withProd.filter((w) => w.productionDecision === false && !policyPass(w, referencePolicy)).length,
          productionKnownN: withProd.length,
        };
      })(),
    },
    recommendedNextAction:
      stabilityVerdict === "ENOUGH_TO_CALIBRATE"
        ? "Proceed to product review of candidate performance policies; no additional Pass A required for floor-10 calibration."
        : stabilityVerdict === "PROMISING_BUT_MORE_DATA_NEEDED"
          ? `Continue Pass A until ~${Math.min(80, base.length + 25)} structurally valid wallets (need ~${walletsNeeded}-${Math.max(walletsNeeded, 25)} more at current completion rate).`
          : "Pause threshold selection; expand durable complete+valid wallet count before calibration.",
  };

  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error) => {
  console.error("[stageC-performance-calibration] failed:", error);
  process.exit(1);
});
