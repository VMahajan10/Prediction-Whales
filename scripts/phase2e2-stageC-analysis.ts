#!/usr/bin/env tsx
/**
 * Phase 2E.2 Stage C — expanded calibration analysis from persisted metrics.
 * No production changes; no canonical D PASS persisted.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletPositionLifecycles,
  whaleRegistry,
} from "@/lib/crossmarket/store/schema";
import {
  evaluateIndexedCredibilityCandidateV2,
  performanceVerdictFromPolicy,
  STAGE_C_EXPERIENCE_FLOOR,
  STAGE_C_EXPERIENCE_FLOORS,
  STAGE_C_EXPLORATORY_PERFORMANCE_POLICIES,
  type IndexedCredibilityCandidateV2,
  type PerformanceExplorationPolicy,
} from "@/lib/walletLedger/indexed/credibilityCandidateV2";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import {
  loadStageCCohortFromManifest,
  stageCCohortManifestPath,
  STAGE_C_ELIGIBILITY_TARGET,
} from "@/lib/walletLedger/indexed/shadow/cohortStageC";
import {
  loadIndexedMetricsByWallet,
  recoverBatchShadowObservations,
} from "@/lib/walletLedger/indexed/shadow/shadowResultRecovery";
import {
  STAGE_C_ANALYSIS_JSON,
  STAGE_C_ANALYSIS_MD,
  STAGE_C_BATCH_ID,
  STAGE_C_CONTRACT_VERSION,
  STAGE_C_STUDY_VERSION,
} from "@/lib/walletLedger/indexed/studyVersion";

const OUT_DIR = join(process.cwd(), "tmp", "wallet-history");

interface Distribution {
  n: number;
  min: number | null;
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
  mean: number | null;
  stdDev: number | null;
}

interface WalletRow {
  wallet: string;
  metricsSafe: boolean;
  productionDecision: boolean | null;
  productionGate: string | null;
  indexedDataValidity: boolean;
  completedPositionCount: number;
  portfolioRealizedRoi: number | null;
  profitablePositionRate: number | null;
  resolvedVolumeUsd: number | null;
  medianCapitalAtRisk: number | null;
  historyValidity: string;
  productionResolvedBets: number | null;
  candidate: IndexedCredibilityCandidateV2;
}

type TraderArchetype =
  | "CONSISTENT_WINNER"
  | "HIGH_WIN_RATE_NEGATIVE_RETURN"
  | "LOW_WIN_RATE_POSITIVE_RETURN"
  | "CONSISTENT_LOSER"
  | "MIXED_OR_INSUFFICIENT";

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[idx] ?? null;
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) {
    return {
      n: 0,
      min: null,
      p10: null,
      p25: null,
      median: null,
      p75: null,
      p90: null,
      max: null,
      mean: null,
      stdDev: null,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const variance =
    sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length;
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p10: percentile(sorted, 10),
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    max: sorted[sorted.length - 1] ?? null,
    mean,
    stdDev: Math.sqrt(variance),
  };
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const vx = xs[i]! - mx;
    const vy = ys[i]! - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function rank(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  for (let r = 0; r < indexed.length; r++) {
    ranks[indexed[r]!.i] = r + 1;
  }
  return ranks;
}

function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  return pearson(rank(xs), rank(ys));
}

function classifyArchetype(
  roi: number | null,
  rate: number | null,
  rateMedian: number
): TraderArchetype {
  if (roi == null || rate == null || !Number.isFinite(roi) || !Number.isFinite(rate)) {
    return "MIXED_OR_INSUFFICIENT";
  }
  const highRate = rate >= rateMedian;
  const positiveRoi = roi > 0;
  if (positiveRoi && highRate) return "CONSISTENT_WINNER";
  if (highRate && roi < 0) return "HIGH_WIN_RATE_NEGATIVE_RETURN";
  if (!highRate && positiveRoi) return "LOW_WIN_RATE_POSITIVE_RETURN";
  if (roi < 0 && !highRate) return "CONSISTENT_LOSER";
  return "MIXED_OR_INSUFFICIENT";
}

function policyMatrix(
  wallets: WalletRow[],
  policyLabel: string,
  experienceFloor: number,
  overallPass: (w: WalletRow) => boolean
) {
  const eligible = wallets.filter(
    (w) =>
      w.metricsSafe &&
      w.indexedDataValidity &&
      w.completedPositionCount >= experienceFloor
  );
  const withKnownA = eligible.filter((w) => w.productionDecision != null);
  const unknownA = eligible.length - withKnownA.length;
  const passing = eligible.filter(overallPass);
  return {
    policy: policyLabel,
    experienceFloor,
    eligibleN: eligible.length,
    passN: passing.length,
    passPct: eligible.length > 0 ? passing.length / eligible.length : null,
    productionAKnownN: withKnownA.length,
    productionAUnknownN: unknownA,
    matrix: {
      passToPass: withKnownA.filter(
        (w) => w.productionDecision === true && overallPass(w)
      ).length,
      passToFail: withKnownA.filter(
        (w) => w.productionDecision === true && !overallPass(w)
      ).length,
      failToPass: withKnownA.filter(
        (w) => w.productionDecision === false && overallPass(w)
      ).length,
      failToFail: withKnownA.filter(
        (w) => w.productionDecision === false && !overallPass(w)
      ).length,
    },
  };
}

function evaluatePolicyPass(
  w: WalletRow,
  policy: PerformanceExplorationPolicy,
  experienceFloor: number
): boolean {
  const perf = performanceVerdictFromPolicy({
    portfolioRealizedRoi: w.portfolioRealizedRoi,
    profitablePositionRate: w.profitablePositionRate,
    policy,
  });
  const base = evaluateIndexedCredibilityCandidateV2(
    {
      indexedDataValidity: w.indexedDataValidity,
      completedPositionCount: w.completedPositionCount,
      portfolioRealizedRoi: w.portfolioRealizedRoi,
      profitablePositionRate: w.profitablePositionRate,
    },
    { historicalPerformance: perf, experienceFloor }
  );
  return base.overallDecision === "PASS";
}

async function extremeWalletReview(wallet: string) {
  const db = getDb();
  const metrics = (
    await db
      .select()
      .from(walletHistoricalMetrics)
      .where(
        sql`lower(${walletHistoricalMetrics.walletAddress}) = ${wallet.toLowerCase()} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
      )
      .limit(1)
  )[0];
  const lifecycles = await db
    .select()
    .from(walletPositionLifecycles)
    .where(
      sql`lower(${walletPositionLifecycles.walletAddress}) = ${wallet.toLowerCase()} AND ${walletPositionLifecycles.metricVersion} = ${WALLET_METRIC_VERSION}`
    );
  const completed = lifecycles.filter(
    (lc) =>
      lc.completed &&
      !lc.exclusionReason &&
      lc.realizedPnl != null &&
      (lc.completionType === "fully_exited" || lc.resolutionFinal === true)
  );
  const profitable = completed.filter((lc) => (lc.realizedPnl ?? 0) > 0);
  const totalPnl = completed.reduce((s, lc) => s + (lc.realizedPnl ?? 0), 0);
  const capitalAtRisk = completed
    .map((lc) => lc.capitalAtRisk)
    .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  const minCar = capitalAtRisk.length > 0 ? Math.min(...capitalAtRisk) : null;
  const maxCar = capitalAtRisk.length > 0 ? Math.max(...capitalAtRisk) : null;
  const onePositionJackpot =
    completed.length > 0 &&
    Math.abs(
      Math.max(...completed.map((lc) => Math.abs(lc.realizedPnl ?? 0))) /
        (Math.abs(totalPnl) || 1)
    ) > 0.8;
  return {
    wallet,
    completedPositionCount: metrics?.completedPositions ?? completed.length,
    portfolioRealizedRoi: metrics?.realizedRoi ?? null,
    resolvedVolumeUsd: metrics?.resolvedVolumeUsd ?? null,
    medianCapitalAtRisk: metrics?.medianCapitalAtRisk ?? null,
    lifecycleCompleted: completed.length,
    profitablePositions: profitable.length,
    totalRealizedPnl: totalPnl,
    minCapitalAtRiskUsd: minCar,
    maxCapitalAtRiskUsd: maxCar,
    nearZeroDenominatorRisk:
      (metrics?.resolvedVolumeUsd ?? 0) < 50 ||
      (metrics?.medianCapitalAtRisk ?? 0) < 5,
    onePositionJackpotArtifact: onePositionJackpot,
    lifecycleExclusionCount: lifecycles.filter((lc) => lc.exclusionReason).length,
    qualityFlags: [
      ...((metrics?.resolvedVolumeUsd ?? 0) < 50 ? ["low_resolved_volume"] : []),
      ...((metrics?.medianCapitalAtRisk ?? 0) < 5 ? ["low_median_car"] : []),
      ...(onePositionJackpot ? ["one_position_dominates_pnl"] : []),
      ...(lifecycles.some((lc) => lc.exclusionReason) ? ["has_excluded_lifecycles"] : []),
    ],
  };
}

function nearThresholdWallets(
  wallets: WalletRow[],
  policy: PerformanceExplorationPolicy,
  experienceFloor: number
): Array<{ wallet: string; margin: number; dimension: string }> {
  const results: Array<{ wallet: string; margin: number; dimension: string }> =
    [];
  const eligible = wallets.filter(
    (w) =>
      w.metricsSafe &&
      w.indexedDataValidity &&
      w.completedPositionCount >= experienceFloor
  );
  for (const w of eligible) {
    const roi = w.portfolioRealizedRoi;
    const rate = w.profitablePositionRate;
    if (policy.kind === "roi_gt" && roi != null) {
      const margin = roi - policy.threshold;
      if (Math.abs(margin) < 0.02) {
        results.push({ wallet: w.wallet, margin, dimension: "roi" });
      }
    }
    if (policy.kind === "roi_gte" && roi != null) {
      const margin = roi - policy.threshold;
      if (Math.abs(margin) < 0.02) {
        results.push({ wallet: w.wallet, margin, dimension: "roi" });
      }
    }
    if (policy.kind === "rate_gte" && rate != null) {
      const margin = rate - policy.threshold;
      if (Math.abs(margin) < 0.05) {
        results.push({ wallet: w.wallet, margin, dimension: "rate" });
      }
    }
  }
  return results.sort((a, b) => Math.abs(a.margin) - Math.abs(b.margin)).slice(0, 20);
}

async function main(): Promise<void> {
  const manifest =
    loadStageCCohortFromManifest() ??
    (() => {
      throw new Error(`Missing cohort manifest: ${stageCCohortManifestPath()}`);
    })();

  const observations = await recoverBatchShadowObservations(STAGE_C_BATCH_ID);
  const obsByWallet = new Map(
    observations.map((o) => [o.wallet.toLowerCase(), o])
  );
  const metricsByWallet = await loadIndexedMetricsByWallet(
    manifest.wallets.map((w) => w.wallet)
  );

  const walletRows: WalletRow[] = [];
  for (const spec of manifest.wallets) {
    const obs = obsByWallet.get(spec.wallet.toLowerCase());
    const metrics = metricsByWallet.get(spec.wallet.toLowerCase());
    const production = await loadProductionCredibilitySnapshot(spec.wallet);
    const candidate = evaluateIndexedCredibilityCandidateV2({
      indexedDataValidity:
        metrics?.credibilityDecision ?? obs?.indexedDecision ?? false,
      completedPositionCount: metrics?.completedPositions ?? 0,
      portfolioRealizedRoi: metrics?.realizedRoi ?? null,
      profitablePositionRate: metrics?.profitablePositionRate ?? null,
    });
    walletRows.push({
      wallet: spec.wallet,
      metricsSafe:
        obs?.executionStatus === "complete" ||
        metrics?.historyValidity === "metrics-safe",
      productionDecision: production.productionCredible,
      productionGate: spec.productionGate ?? null,
      indexedDataValidity: metrics?.credibilityDecision ?? false,
      completedPositionCount: metrics?.completedPositions ?? 0,
      portfolioRealizedRoi: metrics?.realizedRoi ?? null,
      profitablePositionRate: metrics?.profitablePositionRate ?? null,
      resolvedVolumeUsd: metrics?.resolvedVolumeUsd ?? null,
      medianCapitalAtRisk: metrics?.medianCapitalAtRisk ?? null,
      historyValidity: metrics?.historyValidity ?? obs?.historyValidity ?? "unknown",
      productionResolvedBets: production.resolvedBetsCount,
      candidate,
    });
  }

  const metricsSafe = walletRows.filter((w) => w.metricsSafe);
  const eligible = walletRows.filter(
    (w) =>
      w.metricsSafe &&
      w.indexedDataValidity &&
      w.completedPositionCount >= STAGE_C_EXPERIENCE_FLOOR
  );

  const roiValues = eligible
    .map((w) => w.portfolioRealizedRoi)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const rateValues = eligible
    .map((w) => w.profitablePositionRate)
    .filter((v): v is number => v != null && Number.isFinite(v));

  const rateMedian =
    rateValues.length > 0
      ? [...rateValues].sort((a, b) => a - b)[Math.floor(rateValues.length / 2)]!
      : 0.5;

  const archetypes: Record<TraderArchetype, WalletRow[]> = {
    CONSISTENT_WINNER: [],
    HIGH_WIN_RATE_NEGATIVE_RETURN: [],
    LOW_WIN_RATE_POSITIVE_RETURN: [],
    CONSISTENT_LOSER: [],
    MIXED_OR_INSUFFICIENT: [],
  };
  for (const w of eligible) {
    const archetype = classifyArchetype(
      w.portfolioRealizedRoi,
      w.profitablePositionRate,
      rateMedian
    );
    archetypes[archetype].push(w);
  }

  const performancePolicies = STAGE_C_EXPLORATORY_PERFORMANCE_POLICIES.map(
    (policy) =>
      policyMatrix(
        walletRows,
        policy.label,
        STAGE_C_EXPERIENCE_FLOOR,
        (w) => evaluatePolicyPass(w, policy, STAGE_C_EXPERIENCE_FLOOR)
      )
  );

  const robustness = STAGE_C_EXPERIENCE_FLOORS.map((floor) => ({
    experienceFloor: floor,
    eligibleN: walletRows.filter(
      (w) =>
        w.metricsSafe &&
        w.indexedDataValidity &&
        w.completedPositionCount >= floor
    ).length,
    policies: STAGE_C_EXPLORATORY_PERFORMANCE_POLICIES.map((policy) =>
      policyMatrix(walletRows, policy.label, floor, (w) =>
        evaluatePolicyPass(w, policy, floor)
      )
    ),
  }));

  const sampleSizeBuckets: Record<
    string,
    {
      n: number;
      roiDistribution: Distribution;
      rateDistribution: Distribution;
      roiRateSpearman: number | null;
    }
  > = {};
  for (const [label, min, max] of [
    ["10-19", 10, 19],
    ["20-49", 20, 49],
    ["50-99", 50, 99],
    ["100+", 100, Infinity],
  ] as const) {
    const bucket = eligible.filter(
      (w) =>
        w.completedPositionCount >= min &&
        w.completedPositionCount <= (max === Infinity ? 1e9 : max)
    );
    const broi = bucket
      .map((w) => w.portfolioRealizedRoi)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const brate = bucket
      .map((w) => w.profitablePositionRate)
      .filter((v): v is number => v != null && Number.isFinite(v));
    sampleSizeBuckets[label] = {
      n: bucket.length,
      roiDistribution: distribution(broi),
      rateDistribution: distribution(brate),
      roiRateSpearman: spearman(broi, brate),
    };
  }

  const sortedByRoi = [...eligible].sort(
    (a, b) => (b.portfolioRealizedRoi ?? 0) - (a.portfolioRealizedRoi ?? 0)
  );
  const extremeTop = await Promise.all(
    sortedByRoi.slice(0, 5).map((w) => extremeWalletReview(w.wallet))
  );
  const extremeBottom = await Promise.all(
    sortedByRoi.slice(-5).map((w) => extremeWalletReview(w.wallet))
  );

  const nearThreshold = STAGE_C_EXPLORATORY_PERFORMANCE_POLICIES.flatMap(
    (policy) =>
      nearThresholdWallets(walletRows, policy, STAGE_C_EXPERIENCE_FLOOR).map(
        (row) => ({ policy: policy.label, ...row })
      )
  ).slice(0, 30);

  const exitCriteria = {
    eligibleTargetMet: eligible.length >= STAGE_C_ELIGIBILITY_TARGET,
    eligibleCount: eligible.length,
    eligibleTarget: STAGE_C_ELIGIBILITY_TARGET,
    lifecycleStructurallyValid: metricsSafe.length > 0,
    sampleSizeBucketsInterpretable: Object.values(sampleSizeBuckets).some(
      (b) => b.n >= 20
    ),
    performanceMetricDefensible: null as boolean | null,
    thresholdNotProductionOptimized: true,
    verdict:
      eligible.length >= STAGE_C_ELIGIBILITY_TARGET
        ? ("PENDING_PRODUCT_REVIEW" as const)
        : ("NEEDS_MORE_DATA" as const),
    canFreezeD: false,
  };

  const recommendedHistoricalPerformance = {
    metric: "UNRESOLVED",
    rationale:
      eligible.length >= STAGE_C_ELIGIBILITY_TARGET
        ? "Sample size sufficient for review; lean combination (portfolioRealizedRoi + profitablePositionRate) remains exploratory until product sign-off."
        : `Only ${eligible.length} eligible wallets (target ~${STAGE_C_ELIGIBILITY_TARGET}). Insufficient for threshold freeze.`,
    threshold: "UNRESOLVED",
  };

  if (eligible.length >= STAGE_C_ELIGIBILITY_TARGET) {
    const comboPolicy = performancePolicies.find((p) =>
      p.policy.includes("ROI > 0 AND profitablePositionRate >= 0.40")
    );
    exitCriteria.performanceMetricDefensible = comboPolicy != null;
  }

  const payload = {
    studyVersion: STAGE_C_STUDY_VERSION,
    batchId: STAGE_C_BATCH_ID,
    contractVersion: STAGE_C_CONTRACT_VERSION,
    metricVersion: WALLET_METRIC_VERSION,
    generatedAt: new Date().toISOString(),
    cohort: {
      selected: manifest.composition.selected,
      composition: manifest.composition,
    },
    counts: {
      cohortSelected: manifest.wallets.length,
      metricsSafe: metricsSafe.length,
      indexedDataValidityTrue: walletRows.filter((w) => w.indexedDataValidity)
        .length,
      eligibleCompletedGte10: eligible.length,
    },
    experienceMetricValidation: {
      term: "completedPositionCount",
      definition: [
        "completed historical trading positions",
        "not excludedFromMetrics",
        "realizedPnl != null",
        "fully_exited OR resolutionFinal == true",
      ],
      notEquivalentTo: "production resolved_bets_count",
      candidateFloor: STAGE_C_EXPERIENCE_FLOOR,
      shadowOnly: true,
      avgEvDeprecation:
        "Production historical avg_ev is outcome-derived; D uses historical realized performance while trade-level qualification keeps ex-ante EV.",
    },
    profitabilityAnalysis: {
      portfolioRealizedRoi: distribution(roiValues),
      profitablePositionRate: distribution(rateValues),
      correlations: {
        roi_vs_rate_spearman: spearman(roiValues, rateValues),
        roi_vs_completed_spearman: spearman(
          eligible.map((w) => w.completedPositionCount),
          roiValues
        ),
        rate_vs_completed_spearman: spearman(
          eligible.map((w) => w.completedPositionCount),
          rateValues
        ),
        roi_vs_volume_spearman: spearman(
          eligible
            .filter((w) => w.resolvedVolumeUsd != null)
            .map((w) => w.resolvedVolumeUsd!),
          eligible
            .filter((w) => w.resolvedVolumeUsd != null)
            .map((w) => w.portfolioRealizedRoi!)
            .filter((v) => Number.isFinite(v))
        ),
        rate_vs_volume_spearman: spearman(
          eligible
            .filter((w) => w.resolvedVolumeUsd != null)
            .map((w) => w.resolvedVolumeUsd!),
          eligible
            .filter((w) => w.resolvedVolumeUsd != null)
            .map((w) => w.profitablePositionRate!)
            .filter((v) => Number.isFinite(v))
        ),
      },
      sampleSizeBuckets,
    },
    archetypes: {
      rateMedianUsed: rateMedian,
      counts: Object.fromEntries(
        Object.entries(archetypes).map(([k, v]) => [k, v.length])
      ),
      representatives: Object.fromEntries(
        Object.entries(archetypes).map(([k, v]) => [
          k,
          v.slice(0, 5).map((w) => ({
            wallet: w.wallet,
            portfolioRealizedRoi: w.portfolioRealizedRoi,
            profitablePositionRate: w.profitablePositionRate,
            completedPositionCount: w.completedPositionCount,
          })),
        ])
      ),
    },
    candidatePerformancePolicies: performancePolicies,
    robustnessAcrossExperienceFloors: robustness,
    nearThresholdWallets: nearThreshold,
    extremeWalletQualityReview: {
      topRoi: extremeTop,
      bottomRoi: extremeBottom,
    },
    capitalReportingOnly: {
      medianCapitalAtRiskRecorded: true,
      resolvedVolumeUsdRecorded: true,
      includedInD: false,
    },
    candidateComponentEvaluations: walletRows.map((w) => ({
      wallet: w.wallet,
      productionDecision: w.productionDecision,
      productionGate: w.productionGate,
      metricsSafe: w.metricsSafe,
      indexedDataValidity: w.indexedDataValidity,
      completedPositionCount: w.completedPositionCount,
      portfolioRealizedRoi: w.portfolioRealizedRoi,
      profitablePositionRate: w.profitablePositionRate,
      resolvedVolumeUsd: w.resolvedVolumeUsd,
      medianCapitalAtRisk: w.medianCapitalAtRisk,
      candidate: w.candidate,
    })),
    recommendedHistoricalPerformance,
    exitCriteria,
    proposedStageD: {
      blockedUntil: eligible.length >= STAGE_C_ELIGIBILITY_TARGET
        ? "product sign-off on performance metric + threshold"
        : "expanded cohort reaches ~100 eligible wallets",
      scope: [
        "Freeze D contract (component semantics + performance policy)",
        "48-72h live production shadow (no feed/X-agent changes)",
        "Migration readiness document",
      ],
      notInScope: [
        "Production credibility gate changes",
        "resolved_bets_count rename",
        "avg_ev reproduction in D",
      ],
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, STAGE_C_ANALYSIS_JSON);
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  const md = [
    "# Phase 2E.2 Stage C Analysis",
    "",
    `Study: **${STAGE_C_STUDY_VERSION}** | Batch: **${STAGE_C_BATCH_ID}**`,
    "",
    "## Cohort counts",
    "",
    `- Selected: **${payload.counts.cohortSelected}**`,
    `- Metrics-safe: **${payload.counts.metricsSafe}**`,
    `- indexedDataValidity=true: **${payload.counts.indexedDataValidityTrue}**`,
    `- Eligible (validity + completed≥${STAGE_C_EXPERIENCE_FLOOR}): **${payload.counts.eligibleCompletedGte10}** (target ~${STAGE_C_ELIGIBILITY_TARGET})`,
    "",
    "## Experience semantics (approved)",
    "",
    "`completedPositionCount` = completed historical trading positions (lifecycle-based).",
    "NOT equivalent to production `resolved_bets_count`. `fully_exited` before resolution counts.",
    "",
    "## ROI / rate distributions (eligible set)",
    "",
    `ROI n=${payload.profitabilityAnalysis.portfolioRealizedRoi.n} median=${payload.profitabilityAnalysis.portfolioRealizedRoi.median?.toFixed(4) ?? "n/a"}`,
    `Rate n=${payload.profitabilityAnalysis.profitablePositionRate.n} median=${payload.profitabilityAnalysis.profitablePositionRate.median?.toFixed(4) ?? "n/a"}`,
    "",
    "## Archetypes",
    "",
    ...Object.entries(payload.archetypes.counts).map(
      ([k, n]) => `- **${k}**: ${n}`
    ),
    "",
    "## Exit criteria",
    "",
    `- Eligible target met: **${exitCriteria.eligibleTargetMet}**`,
    `- Verdict: **${exitCriteria.verdict}**`,
    `- Can freeze D: **${exitCriteria.canFreezeD}**`,
    `- Recommended performance metric: **${recommendedHistoricalPerformance.metric}**`,
    `- Recommended threshold: **${recommendedHistoricalPerformance.threshold}**`,
    "",
    "## Stage D proposal (not started)",
    "",
    ...payload.proposedStageD.scope.map((s) => `- ${s}`),
    "",
  ];
  const mdPath = join(OUT_DIR, STAGE_C_ANALYSIS_MD);
  writeFileSync(mdPath, md.join("\n"));

  console.log(
    JSON.stringify(
      {
        jsonPath,
        mdPath,
        counts: payload.counts,
        exitCriteria,
        recommendedHistoricalPerformance,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[phase2e2-stageC] failed:", error);
  process.exit(1);
});
