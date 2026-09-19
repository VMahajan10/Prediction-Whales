#!/usr/bin/env tsx
/**
 * Phase 2E.2 Stage B — design + shadow evaluation from persisted metrics.
 * No production/C changes; no chain re-audits.
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
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { fetchClosedPositions, isEphemeralClosedPosition } from "@/lib/polymarket";
import { closedPositionsToResolvedBets } from "@/lib/x-agent/walletCredibility";
import {
  evaluateIndexedCredibilityCandidateV2,
  performanceVerdictFromPolicy,
  STAGE_B_EXPLORATORY_PERFORMANCE_POLICIES,
  STAGE_B_EXPERIENCE_FLOOR,
  type ComponentVerdict,
  type IndexedCredibilityCandidateV2,
} from "@/lib/walletLedger/indexed/credibilityCandidateV2";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import {
  loadCohortSpecs,
  recoverBatchShadowObservations,
} from "@/lib/walletLedger/indexed/shadow/shadowResultRecovery";

const BATCH_ID = "phase2e1-full50-v2";
const OUT_DIR = join(process.cwd(), "tmp", "wallet-history");
const STAGE_A_JSON = join(OUT_DIR, "phase2e2-stageA-wallet-calibration.json");

const DEEP_REVIEW_WALLETS = {
  productionUndercount: [
    "0x7e5972bfc25819775ee5a9d4f191919375487b8b",
    "0xdc41c39b95453c943174f369926018f6963bdd7e",
    "0x6129d21da529b6d8d324131a9cf2b37b0b840807",
    "0xb6ed7b123bd7431139fefc6f24203934ee23cd23",
  ],
  indexedLowerCount: [
    "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
    "0x443bcce588e26763987e9ae44b6b7845f09fe8bb",
    "0x962eb33ed55b3fc35bf8b55d0e38658c6a3f1d75",
    "0x3679e05be57e5d3e3c9f7a83a7d30d10670f492e",
    "0xc2e5359b204c4296b7e1a07603fe0b657486b3a5",
  ],
};

interface Distribution {
  n: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
  stdDev: number | null;
}

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
      p25: null,
      median: null,
      p75: null,
      max: null,
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
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    max: sorted[sorted.length - 1] ?? null,
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

function isCredibleCompleted(row: {
  completed: boolean;
  exclusionReason: string | null;
  realizedPnl: number | null;
  completionType: string | null;
  resolutionFinal: boolean | null;
}): boolean {
  return (
    row.completed &&
    !row.exclusionReason &&
    row.realizedPnl != null &&
    (row.completionType === "fully_exited" ||
      row.resolutionFinal === true)
  );
}

async function summarizeProductionClosedPositions(wallet: string) {
  const closedPositions = await fetchClosedPositions(wallet);
  let ephemeral = 0;
  let badEntry = 0;
  let zeroPnl = 0;
  let included = 0;
  for (const raw of closedPositions) {
    const position = raw as Record<string, unknown>;
    if (
      isEphemeralClosedPosition({
        slug: position.slug as string | undefined,
        eventSlug: position.eventSlug as string | undefined,
        title: position.title as string | undefined,
      })
    ) {
      ephemeral += 1;
      continue;
    }
    const entryPrice = Number(position.avgPrice);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      badEntry += 1;
      continue;
    }
    const realizedPnl = Number(position.realizedPnl ?? 0);
    if (!Number.isFinite(realizedPnl) || realizedPnl === 0) {
      zeroPnl += 1;
      continue;
    }
    included += 1;
  }
  const resolvedBets = closedPositionsToResolvedBets(closedPositions);
  return {
    apiClosedPositionRows: closedPositions.length,
    ephemeralExcluded: ephemeral,
    invalidEntryExcluded: badEntry,
    zeroRealizedPnlExcluded: zeroPnl,
    resolvedBetsAfterFilters: resolvedBets.length,
    registryResolvedBetsCount: (
      await loadProductionCredibilitySnapshot(wallet)
    ).resolvedBetsCount,
  };
}

async function summarizeIndexedLifecycles(wallet: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(walletPositionLifecycles)
    .where(
      sql`lower(${walletPositionLifecycles.walletAddress}) = ${wallet.toLowerCase()} AND ${walletPositionLifecycles.metricVersion} = ${WALLET_METRIC_VERSION}`
    );
  const distinctPositionCount = rows.length;
  const completed = rows.filter((r) => r.completed);
  const credibleCompleted = rows.filter((r) => isCredibleCompleted(r));
  const fullyExited = rows.filter(
    (r) => r.completed && r.completionType === "fully_exited"
  );
  const fullyExitedBeforeResolution = rows.filter(
    (r) =>
      r.completed &&
      r.completionType === "fully_exited" &&
      r.resolutionFinal !== true
  );
  const resolutionFinal = rows.filter(
    (r) => r.completed && r.resolutionFinal === true
  );
  const excludedFromMetrics = rows.filter((r) => r.exclusionReason != null);
  const openIncomplete = rows.filter((r) => !r.completed);
  const completedWithPnl = rows.filter(
    (r) => r.completed && r.realizedPnl != null
  );
  return {
    distinctPositionCount,
    completedPositionCount: credibleCompleted.length,
    completedAny: completed.length,
    fullyExitedCount: fullyExited.length,
    fullyExitedBeforeResolutionCount: fullyExitedBeforeResolution.length,
    resolutionFinalCount: resolutionFinal.length,
    excludedFromMetricsCount: excludedFromMetrics.length,
    openOrIncompleteCount: openIncomplete.length,
    completedWithRealizedPnlCount: completedWithPnl.length,
    persistedMetricsCompleted: (
      await db
        .select()
        .from(walletHistoricalMetrics)
        .where(
          sql`lower(${walletHistoricalMetrics.walletAddress}) = ${wallet.toLowerCase()} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
        )
        .limit(1)
    )[0]?.completedPositions,
  };
}

function explainCountDelta(input: {
  production: Awaited<ReturnType<typeof summarizeProductionClosedPositions>>;
  indexed: Awaited<ReturnType<typeof summarizeIndexedLifecycles>>;
}): { categories: string[]; narrative: string } {
  const categories: string[] = [];
  const delta =
    input.indexed.completedPositionCount -
    input.production.resolvedBetsAfterFilters;
  if (input.production.apiClosedPositionRows <= 60) {
    categories.push("API_TRUNCATION_OR_WINDOW");
  }
  if (input.production.zeroRealizedPnlExcluded > 0) {
    categories.push("PRODUCTION_REALIZED_PNL_NONZERO_FILTER");
  }
  if (input.production.ephemeralExcluded > 0) {
    categories.push("EPHEMERAL_POSITION_EXCLUSION");
  }
  if (input.indexed.fullyExitedBeforeResolutionCount > 0) {
    categories.push("FULLY_EXITED_BEFORE_RESOLUTION_COUNTS_INDEXED");
  }
  if (
    input.indexed.distinctPositionCount >
    input.production.resolvedBetsAfterFilters * 2
  ) {
    categories.push("LIFECYCLE_GROUPING_VS_API_ROWS");
  }
  if (input.indexed.excludedFromMetricsCount > 0) {
    categories.push("INDEXED_EXCLUSIONS");
  }
  if (input.indexed.openOrIncompleteCount > input.indexed.completedAny) {
    categories.push("OPEN_INCOMPLETE_LIFECYCLES");
  }
  const narrative =
    delta >= 0
      ? `Indexed credible completed (${input.indexed.completedPositionCount}) exceeds production resolved bets (${input.production.resolvedBetsAfterFilters}) by ${delta}.`
      : `Production resolved bets (${input.production.resolvedBetsAfterFilters}) exceeds indexed credible completed (${input.indexed.completedPositionCount}) by ${-delta}.`;
  return { categories: [...new Set(categories)], narrative };
}

interface WalletRow {
  wallet: string;
  metricsSafe: boolean;
  productionDecision: boolean | null;
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

function policyMatrix(
  wallets: WalletRow[],
  policyLabel: string,
  overallPass: (w: WalletRow) => boolean
) {
  const eligible = wallets.filter(
    (w) =>
      w.metricsSafe &&
      w.indexedDataValidity &&
      w.completedPositionCount >= STAGE_B_EXPERIENCE_FLOOR &&
      w.productionDecision != null
  );
  const passing = eligible.filter(overallPass);
  const changes = eligible
    .filter((w) => {
      const dPass = overallPass(w);
      const aPass = w.productionDecision === true;
      return dPass !== aPass;
    })
    .map((w) => ({
      wallet: w.wallet,
      productionDecision: w.productionDecision,
      exploratoryPass: overallPass(w),
      completedPositionCount: w.completedPositionCount,
      portfolioRealizedRoi: w.portfolioRealizedRoi,
      profitablePositionRate: w.profitablePositionRate,
    }));
  return {
    policy: policyLabel,
    walletsPassing: passing.length,
    eligible: eligible.length,
    matrix: {
      passToPass: eligible.filter(
        (w) => w.productionDecision === true && overallPass(w)
      ).length,
      passToFail: eligible.filter(
        (w) => w.productionDecision === true && !overallPass(w)
      ).length,
      failToPass: eligible.filter(
        (w) => w.productionDecision === false && overallPass(w)
      ).length,
      failToFail: eligible.filter(
        (w) => w.productionDecision === false && !overallPass(w)
      ).length,
    },
    changedWallets: changes,
  };
}

async function main(): Promise<void> {
  const cohort = loadCohortSpecs(BATCH_ID);
  const observations = await recoverBatchShadowObservations(BATCH_ID);
  const cohortByWallet = new Map(
    cohort.map((w) => [w.wallet.toLowerCase(), w])
  );

  const walletRows: WalletRow[] = [];
  for (const obs of observations) {
    const production = await loadProductionCredibilitySnapshot(obs.wallet);
    const db = getDb();
    const metrics = (
      await db
        .select()
        .from(walletHistoricalMetrics)
        .where(
          sql`lower(${walletHistoricalMetrics.walletAddress}) = ${obs.wallet.toLowerCase()} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
        )
        .limit(1)
    )[0];
    const candidate = evaluateIndexedCredibilityCandidateV2({
      indexedDataValidity: obs.indexedDecision,
      completedPositionCount: metrics?.completedPositions ?? 0,
      portfolioRealizedRoi: metrics?.realizedRoi ?? null,
      profitablePositionRate: metrics?.profitablePositionRate ?? null,
    });
    walletRows.push({
      wallet: obs.wallet,
      metricsSafe: obs.executionStatus === "complete",
      productionDecision: production.productionCredible,
      indexedDataValidity: obs.indexedDecision,
      completedPositionCount: metrics?.completedPositions ?? 0,
      portfolioRealizedRoi: metrics?.realizedRoi ?? null,
      profitablePositionRate: metrics?.profitablePositionRate ?? null,
      resolvedVolumeUsd: metrics?.resolvedVolumeUsd ?? null,
      medianCapitalAtRisk: metrics?.medianCapitalAtRisk ?? null,
      historyValidity: obs.historyValidity,
      productionResolvedBets: production.resolvedBetsCount,
      candidate,
    });
  }

  const metricsSafe = walletRows.filter((w) => w.metricsSafe);
  const metricsSafeWithRoi = metricsSafe.filter(
    (w) => w.portfolioRealizedRoi != null && Number.isFinite(w.portfolioRealizedRoi)
  );
  const metricsSafeWithRate = metricsSafe.filter(
    (w) =>
      w.profitablePositionRate != null &&
      Number.isFinite(w.profitablePositionRate)
  );

  const roiValues = metricsSafeWithRoi.map((w) => w.portfolioRealizedRoi!);
  const rateValues = metricsSafeWithRate.map((w) => w.profitablePositionRate!);
  const completedValues = metricsSafe.map((w) => w.completedPositionCount);
  const volumeValues = metricsSafe
    .map((w) => w.resolvedVolumeUsd)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const carValues = metricsSafe
    .map((w) => w.medianCapitalAtRisk)
    .filter((v): v is number => v != null && Number.isFinite(v));

  const highRateNegativeRoi = metricsSafe.filter(
    (w) =>
      w.profitablePositionRate != null &&
      w.profitablePositionRate >= 0.5 &&
      w.portfolioRealizedRoi != null &&
      w.portfolioRealizedRoi < 0
  );
  const lowRatePositiveRoi = metricsSafe.filter(
    (w) =>
      w.profitablePositionRate != null &&
      w.profitablePositionRate < 0.5 &&
      w.portfolioRealizedRoi != null &&
      w.portfolioRealizedRoi > 0
  );

  const performancePolicies = STAGE_B_EXPLORATORY_PERFORMANCE_POLICIES.map(
    (policy) =>
      policyMatrix(metricsSafe, `EXPLORATORY: ${policy.label}`, (w) => {
        const perf = performanceVerdictFromPolicy({
          portfolioRealizedRoi: w.portfolioRealizedRoi,
          profitablePositionRate: w.profitablePositionRate,
          policy,
        });
        const base = evaluateIndexedCredibilityCandidateV2(
          {
            indexedDataValidity: w.indexedDataValidity,
            completedPositionCount: w.completedPositionCount,
          },
          { historicalPerformance: perf }
        );
        return base.overallDecision === "PASS";
      })
  );

  const buckets: Record<string, WalletRow[]> = {
    "10-19": [],
    "20-49": [],
    "50-99": [],
    "100+": [],
  };
  for (const w of metricsSafe.filter(
    (row) => row.completedPositionCount >= STAGE_B_EXPERIENCE_FLOOR
  )) {
    const c = w.completedPositionCount;
    if (c < 20) buckets["10-19"]!.push(w);
    else if (c < 50) buckets["20-49"]!.push(w);
    else if (c < 100) buckets["50-99"]!.push(w);
    else buckets["100+"]!.push(w);
  }

  const sampleSizeStability = Object.fromEntries(
    Object.entries(buckets).map(([label, rows]) => [
      label,
      {
        n: rows.length,
        portfolioRealizedRoi: distribution(
          rows
            .map((w) => w.portfolioRealizedRoi)
            .filter((v): v is number => v != null && Number.isFinite(v))
        ),
        profitablePositionRate: distribution(
          rows
            .map((w) => w.profitablePositionRate)
            .filter((v): v is number => v != null && Number.isFinite(v))
        ),
        note:
          rows.length < 5
            ? "sample too small for stable inference"
            : "interpret with caution",
      },
    ])
  );

  const deepReviews: Record<string, unknown> = {};
  for (const [group, wallets] of Object.entries(DEEP_REVIEW_WALLETS)) {
    deepReviews[group] = [];
    for (const wallet of wallets) {
      const production = await summarizeProductionClosedPositions(wallet);
      const indexed = await summarizeIndexedLifecycles(wallet);
      const explanation = explainCountDelta({ production, indexed });
      (deepReviews[group] as unknown[]).push({
        wallet,
        production,
        indexed,
        delta: indexed.completedPositionCount - production.resolvedBetsAfterFilters,
        explanation,
        betEquivalentVerdict:
          indexed.completedPositionCount >= production.resolvedBetsAfterFilters
            ? "POSITION_LIFECYCLE_MEASURE_DIFFERS"
            : "INDEXED_STRICTER_THAN_PRODUCTION",
      });
    }
  }

  const capitalRedundancy = {
    completed_vs_volume: pearson(
      metricsSafe.map((w) => w.completedPositionCount),
      metricsSafe.map((w) => w.resolvedVolumeUsd ?? 0)
    ),
    completed_vs_medianCar: pearson(
      metricsSafe.map((w) => w.completedPositionCount),
      metricsSafe.map((w) => w.medianCapitalAtRisk ?? 0)
    ),
    volume_vs_medianCar: pearson(
      volumeValues,
      carValues.length === volumeValues.length ? carValues : []
    ),
    interpretation:
      "High positive correlation suggests capital metrics may be redundant with experience count for wallet gate purposes.",
  };

  const stageBDecisions = {
    A_experience: {
      recommendation: "NEEDS_MORE_VALIDATION",
      rationale:
        "completedPositionCount is a POSITION-lifecycle measure, not BET-equivalent. Large PRODUCTION_UNDERCOUNT and INDEXED_LOWER_COUNT cases show API truncation, zero-PnL filter, and fully-exited-before-resolution semantics diverge materially. Approve as shadow candidate floor only until lifecycle semantics are product-signed.",
      approvedCandidateFloor: STAGE_B_EXPERIENCE_FLOOR,
      lifecycleDefinition: {
        completed: true,
        excludedFromMetrics: false,
        realizedPnl: "!= null",
        completion:
          "completionType === fully_exited OR resolutionFinal === true",
        openQuestion:
          "Should fully_exited before market resolution count as equivalent to production resolved bet?",
      },
    },
    B_performanceMetric: {
      recommendation: "needs_more_validation",
      options: {
        option1_profitabilityMagnitude: {
          metric: "portfolioRealizedRoi",
          median: distribution(roiValues).median,
          weakness: "outlier-sensitive; median negative in full50 metrics-safe",
        },
        option2_consistency: {
          metric: "profitablePositionRate",
          median: distribution(rateValues).median,
          weakness: "ignores magnitude; high-rate/negative-ROI wallets exist",
        },
        option3_combination: {
          metric: "ROI > 0 AND profitablePositionRate >= 0.50",
          exploratoryPassCount: performancePolicies.find((p) =>
            p.policy.includes("ROI > 0 AND")
          )?.walletsPassing,
          weakness: "more parameters; small sample",
        },
      },
      highRateNegativeRoi: highRateNegativeRoi.map((w) => w.wallet),
      lowRatePositiveRoi: lowRatePositiveRoi.map((w) => w.wallet),
    },
    C_performanceThreshold: "UNRESOLVED",
    D_avgEv: {
      recommendation: "DEPRECATE",
      rationale:
        "Production avg_ev is outcome-derived mean((payout-entry)/entry), not ex-ante EV. Indexed has no equivalent and Stage B exploratory policies show weak alignment with production A. Maintain trade-level ex-ante EV separately.",
      action: "rename in docs to outcomeDerivedRoiMean; remove from wallet gate in future migration",
    },
    E_capital: {
      recommendation: "optional/reporting-only",
      rationale: `Production avgStakeNotional often zero while indexed CAR/volume populated. Correlation completed vs volume=${capitalRedundancy.completed_vs_volume?.toFixed(3) ?? "n/a"}. Experience count likely sufficient for depth; capital not independent trust signal at Stage B.`,
    },
  };

  const proposedDContract = {
    version: "credibility-metric-contract-v2-stageB",
    components: {
      dataValidity: "indexedDataValidity (frozen = C)",
      historicalEvidence: `completedPositionCount >= ${STAGE_B_EXPERIENCE_FLOOR} (candidate)`,
      historicalPerformance: "UNRESOLVED — must not collapse to boolean yet",
      capitalQualification: "NOT_USED",
    },
    overallDecisionRule:
      "PASS only when all required components approved; Stage B leaves overall UNKNOWN",
    notEquivalentTo:
      "production resolved_bets_count or avg_ev",
  };

  const stageCProposal = {
    scope: [
      "Freeze D contract version after product sign-off on experience + performance",
      "Persist D component shadow decisions to wallet_shadow_results extension",
      "Run A vs D on full50 + expanded cohort without re-audit",
      "48-72h live shadow on candidate wallets (no feed/X-agent changes)",
      "Migration/readiness decision document",
    ],
    blockedOn: [
      "Product answer on fully_exited before resolution",
      "Performance metric + threshold selection",
      "avg_ev deprecation plan",
    ],
  };

  const payload = {
    batchId: BATCH_ID,
    metricVersion: WALLET_METRIC_VERSION,
    generatedAt: new Date().toISOString(),
    lifecycleSemantics: {
      credibleCompletedPositionDefinition: [
        "completed",
        "!excludedFromMetrics",
        "realizedPnl != null",
        "fully_exited OR resolutionFinal",
      ],
      productQuestion:
        "fully_exited before resolution vs production resolved bet equivalence",
      verdict:
        "completedPositionCount is a POSITION-lifecycle experience measure, not BET-equivalent",
    },
    countSemanticReconciliation: deepReviews,
    profitabilityAnalysis: {
      portfolioRealizedRoi: {
        distribution: distribution(roiValues),
        sampleSize: roiValues.length,
      },
      profitablePositionRate: {
        distribution: distribution(rateValues),
        sampleSize: rateValues.length,
      },
      correlations: {
        roi_vs_rate_spearman: spearman(roiValues, rateValues),
        roi_vs_completed: pearson(
          metricsSafeWithRoi.map((w) => w.completedPositionCount),
          roiValues
        ),
        rate_vs_completed: pearson(
          metricsSafeWithRate.map((w) => w.completedPositionCount),
          rateValues
        ),
        roi_vs_volume: pearson(
          metricsSafeWithRoi.map((w) => w.resolvedVolumeUsd ?? 0),
          roiValues
        ),
        rate_vs_volume: pearson(
          metricsSafeWithRate.map((w) => w.resolvedVolumeUsd ?? 0),
          rateValues
        ),
      },
      highRateNegativeRoi,
      lowRatePositiveRoi,
    },
    candidateComponentEvaluations: walletRows.map((w) => ({
      wallet: w.wallet,
      productionDecision: w.productionDecision,
      candidate: w.candidate,
    })),
    exploratoryPerformancePolicies: performancePolicies,
    sampleSizeStability,
    capitalRedundancy,
    stageBDecisions,
    proposedDContract,
    stageCProposal,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, "phase2e2-stageB-analysis.json");
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  const md = [
    "# Phase 2E.2 Stage B Analysis",
    "",
    `Batch: **${BATCH_ID}** | Metrics-safe: **${metricsSafe.length}**`,
    "",
    "## Lifecycle verdict",
    "",
    "**`completedPositionCount` is a POSITION-lifecycle measure, not BET-equivalent to production `resolved_bets_count`.**",
    "",
    "Open product question: should `fully_exited` before market resolution count as historical experience equivalent to a production resolved bet?",
    "",
    "## Component D (Stage B default)",
    "",
    "All wallets: `historicalPerformance=UNKNOWN` → `overallDecision=UNKNOWN` (intentional — no collapsed boolean credibility).",
    "",
    "## Experience candidate (floor 10)",
    "",
    ...walletRows
      .filter((w) => w.metricsSafe)
      .map(
        (w) =>
          `- \`${w.wallet}\` evidence=${w.candidate.historicalEvidence} completed=${w.completedPositionCount} overall=${w.candidate.overallDecision}`
      ),
    "",
    "## Deep count reviews",
    "",
    ...Object.entries(deepReviews).flatMap(([group, rows]) => [
      `### ${group}`,
      "",
      ...(rows as Array<{ wallet: string; delta: number; explanation: { narrative: string; categories: string[] } }>).map(
        (r) =>
          `- \`${r.wallet}\` Δ=${r.delta}: ${r.explanation.narrative} [${r.explanation.categories.join(", ")}]`
      ),
      "",
    ]),
    "",
    "## Exploratory performance policies (validity + completed≥10)",
    "",
    ...performancePolicies.map(
      (p) =>
        `- **${p.policy}**: pass=${p.walletsPassing}/${p.eligible} P→P=${p.matrix.passToPass} P→F=${p.matrix.passToFail} F→P=${p.matrix.failToPass} F→F=${p.matrix.failToFail}`
    ),
    "",
    "## Stage B decisions",
    "",
    `- **Experience:** ${stageBDecisions.A_experience.recommendation}`,
    `- **Performance metric:** ${stageBDecisions.B_performanceMetric.recommendation}`,
    `- **Performance threshold:** ${stageBDecisions.C_performanceThreshold}`,
    `- **avg_ev:** ${stageBDecisions.D_avgEv.recommendation}`,
    `- **Capital:** ${stageBDecisions.E_capital.recommendation}`,
    "",
    "## Stage C proposal (not started)",
    "",
    ...stageCProposal.scope.map((s) => `- ${s}`),
    "",
  ];
  const mdPath = join(OUT_DIR, "phase2e2-stageB-analysis.md");
  writeFileSync(mdPath, md.join("\n"));

  console.log(JSON.stringify({ jsonPath, mdPath, stageBDecisions }, null, 2));
}

void main().catch((error) => {
  console.error("[phase2e2-stageB] failed:", error);
  process.exit(1);
});
