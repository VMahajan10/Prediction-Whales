#!/usr/bin/env tsx
/**
 * Phase 2E.2 Stage A — full50 calibration from persisted Phase 2E.1 data.
 * No chain audits; no gate changes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { whaleRegistry, walletHistoricalMetrics } from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { MIN_WALLET_RESOLVED_BETS } from "@/lib/x-agent/gateMetrics";
import { productionGateToDecision } from "@/lib/walletLedger/indexed/shadow/productionReconciliation";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import {
  loadCohortSpecs,
  recoverBatchShadowObservations,
} from "@/lib/walletLedger/indexed/shadow/shadowResultRecovery";
import { CREDIBILITY_CONTRACT_V2_ID } from "@/lib/walletLedger/indexed/credibilityContractV2";

const BATCH_ID = "phase2e1-full50-v2";
const OUT_DIR = join(process.cwd(), "tmp", "wallet-history");
const EXPERIENCE_FLOORS = [5, 10, 20, 50] as const;
const MATERIAL_COUNT_DELTA = 3;

type ProductionGate = "pass" | "fail" | "unknown";

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
  return sorted[idx] ?? null;
}

function distribution(values: Array<number | null | undefined>): Distribution {
  const nums = values.filter(
    (v): v is number => v != null && Number.isFinite(v)
  );
  if (nums.length === 0) {
    return {
      n: 0,
      min: null,
      p10: null,
      p25: null,
      median: null,
      p75: null,
      p90: null,
      max: null,
    };
  }
  const sorted = [...nums].sort((a, b) => a - b);
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

function confusionMatrix(
  rows: Array<{ a: boolean | null; d: boolean }>
): {
  nKnown: number;
  passToPass: number;
  passToFail: number;
  failToPass: number;
  failToFail: number;
} {
  const known = rows.filter((r) => r.a != null);
  return {
    nKnown: known.length,
    passToPass: known.filter((r) => r.a === true && r.d).length,
    passToFail: known.filter((r) => r.a === true && !r.d).length,
    failToPass: known.filter((r) => r.a === false && r.d).length,
    failToFail: known.filter((r) => r.a === false && !r.d).length,
  };
}

function classifyCountDisagreement(input: {
  productionResolvedBets: number | null;
  indexedCompletedPositions: number | null;
  historyValidity: string;
  indexedDataValidity: boolean;
}):
  | "PRODUCTION_UNDERCOUNT"
  | "INDEXED_LOWER_COUNT"
  | "ROUGH_AGREEMENT"
  | "UNUSABLE_NOT_COMPARABLE" {
  if (
    input.historyValidity === "unusable" ||
    !input.indexedDataValidity ||
    input.productionResolvedBets == null ||
    input.indexedCompletedPositions == null
  ) {
    return "UNUSABLE_NOT_COMPARABLE";
  }
  const delta =
    input.indexedCompletedPositions - input.productionResolvedBets;
  if (Math.abs(delta) < MATERIAL_COUNT_DELTA) return "ROUGH_AGREEMENT";
  if (delta >= MATERIAL_COUNT_DELTA) return "PRODUCTION_UNDERCOUNT";
  return "INDEXED_LOWER_COUNT";
}

function explainCountDisagreement(input: {
  category: string;
  productionResolvedBets: number | null;
  indexedCompletedPositions: number | null;
  productionReasons: string[];
  indexedReasons: string[];
}): string[] {
  const reasons: string[] = [];
  const delta =
    (input.indexedCompletedPositions ?? 0) -
    (input.productionResolvedBets ?? 0);
  if (input.category === "ROUGH_AGREEMENT") {
    reasons.push("counts within material tolerance");
    return reasons;
  }
  if (input.category === "UNUSABLE_NOT_COMPARABLE") {
    reasons.push("identity/history invalid or missing production count");
    return reasons;
  }
  if (input.category === "PRODUCTION_UNDERCOUNT") {
    reasons.push(
      `indexed completed (${input.indexedCompletedPositions}) > production resolved (${input.productionResolvedBets}), delta=${delta}`
    );
    reasons.push(
      "likely causes: API truncation/closed-position window; production realizedPnl!=0 filter; ephemeral position exclusion; on-chain lifecycle discovers more completed positions"
    );
  }
  if (input.category === "INDEXED_LOWER_COUNT") {
    reasons.push(
      `production resolved (${input.productionResolvedBets}) > indexed completed (${input.indexedCompletedPositions}), delta=${delta}`
    );
    reasons.push(
      "likely causes: stricter indexed credible lifecycle filter (fully_exited or gamma-final); excluded positions; identity merge; production API may count positions indexed classifies as open/incomplete"
    );
  }
  if (input.indexedReasons.includes("gamma_resolution_incomplete")) {
    reasons.push("indexed gamma_resolution_incomplete (coverage label, not count blocker)");
  }
  if (input.productionReasons.includes("below_resolved_bets")) {
    reasons.push("production below_resolved_bets threshold");
  }
  return reasons;
}

function gateLabel(gate: ProductionGate | undefined): string {
  if (gate === "pass") return "PASS";
  if (gate === "fail") return "FAIL";
  return "UNKNOWN";
}

async function main(): Promise<void> {
  const cohort = loadCohortSpecs(BATCH_ID);
  const observations = await recoverBatchShadowObservations(BATCH_ID);
  const cohortByWallet = new Map(
    cohort.map((w) => [w.wallet.toLowerCase(), w])
  );

  const db = getDb();
  const wallets: Array<Record<string, unknown>> = [];
  const metricsSafeWallets: Array<Record<string, unknown>> = [];

  for (const obs of observations) {
    const wallet = obs.wallet.toLowerCase();
    const spec = cohortByWallet.get(wallet);
    const production = await loadProductionCredibilitySnapshot(wallet);
    const metricRows = await db
      .select()
      .from(walletHistoricalMetrics)
      .where(
        sql`lower(${walletHistoricalMetrics.walletAddress}) = ${wallet} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
      )
      .limit(1);
    const metrics = metricRows[0];
    const indexedDataValidity = obs.indexedDecision;
    const productionProxyVolume =
      production.resolvedBetsCount != null && production.avgStakeNotional != null
        ? production.resolvedBetsCount * production.avgStakeNotional
        : null;

    const row = {
      wallet,
      label: spec?.label ?? wallet.slice(0, 10),
      cohortProductionGate: spec?.productionGate ?? "unknown",
      cohortProductionReason: spec?.productionFailureReason ?? null,
      production: {
        hydrationStatus: production.hydrationStatus,
        resolvedBetsCount: production.resolvedBetsCount,
        avgEv: production.avgEv,
        avgStakeNotional: production.avgStakeNotional,
        proxyResolvedVolumeUsd: productionProxyVolume,
        productionCredibilityDecision: production.productionCredible,
        productionReasons: [production.productionGateReason],
      },
      indexed: {
        historyValidity: obs.historyValidity,
        indexedDataValidity,
        indexedMetricsSafe: obs.executionStatus === "complete",
        completedPositionCount: metrics?.completedPositions ?? null,
        portfolioRealizedRoi: metrics?.realizedRoi ?? null,
        profitablePositionRate: metrics?.profitablePositionRate ?? null,
        outcomeWinRate: metrics?.outcomeWinRate ?? null,
        totalRealizedPnl: null as number | null,
        medianCapitalAtRisk: metrics?.medianCapitalAtRisk ?? null,
        resolvedVolumeUsd: metrics?.resolvedVolumeUsd ?? null,
        indexedDataValidityReasons: obs.indexedReasons,
      },
      experience: {
        productionResolvedBets: production.resolvedBetsCount,
        indexedCompletedPositions: metrics?.completedPositions ?? null,
        delta:
          metrics?.completedPositions != null &&
          production.resolvedBetsCount != null
            ? metrics.completedPositions - production.resolvedBetsCount
            : null,
        productionDecision: production.productionCredible,
      },
      countDisagreement: (() => {
        const category = classifyCountDisagreement({
          productionResolvedBets: production.resolvedBetsCount,
          indexedCompletedPositions: metrics?.completedPositions ?? null,
          historyValidity: obs.historyValidity,
          indexedDataValidity,
        });
        return {
          category,
          explanations: explainCountDisagreement({
            category,
            productionResolvedBets: production.resolvedBetsCount,
            indexedCompletedPositions: metrics?.completedPositions ?? null,
            productionReasons: [production.productionGateReason],
            indexedReasons: obs.indexedReasons,
          }),
        };
      })(),
    };
    wallets.push(row);
    if (obs.executionStatus === "complete") {
      metricsSafeWallets.push(row);
    }
  }

  const experienceFloorSensitivity = EXPERIENCE_FLOORS.map((floor) => {
    const rows = metricsSafeWallets.map((w) => {
      const indexed = w.indexed as { indexedDataValidity: boolean; completedPositionCount: number | null };
      const production = w.production as { productionCredibilityDecision: boolean | null };
      const d =
        indexed.indexedDataValidity &&
        (indexed.completedPositionCount ?? 0) >= floor;
      return { a: production.productionCredibilityDecision, d };
    });
    return { floor, matrix: confusionMatrix(rows) };
  });

  const prodFailBelowResolved = wallets.filter(
    (w) =>
      (w.production as { productionReasons: string[] }).productionReasons[0] ===
      "below_resolved_bets"
  );

  const prodPassFailedIndexed10 = metricsSafeWallets.filter((w) => {
    const spec = cohortByWallet.get((w.wallet as string).toLowerCase());
    const gate = productionGateToDecision(spec?.productionGate);
    const indexed = w.indexed as {
      indexedDataValidity: boolean;
      completedPositionCount: number | null;
    };
    return (
      gate === true &&
      indexed.indexedDataValidity &&
      (indexed.completedPositionCount ?? 0) < 10
    );
  });

  function sliceByGate(
    gate: ProductionGate
  ): Array<Record<string, unknown>> {
    return metricsSafeWallets.filter((w) => {
      const spec = cohortByWallet.get((w.wallet as string).toLowerCase());
      return spec?.productionGate === gate;
    });
  }

  const capitalVolumeDistributions = {
    metricsSafeTotal: metricsSafeWallets.length,
    byProductionGate: {
      PASS: {
        productionAvgStakeNotional: distribution(
          sliceByGate("pass").map(
            (w) => (w.production as { avgStakeNotional: number | null }).avgStakeNotional
          )
        ),
        productionProxyResolvedVolumeUsd: distribution(
          sliceByGate("pass").map(
            (w) =>
              (w.production as { proxyResolvedVolumeUsd: number | null })
                .proxyResolvedVolumeUsd
          )
        ),
        indexedMedianCapitalAtRisk: distribution(
          sliceByGate("pass").map(
            (w) =>
              (w.indexed as { medianCapitalAtRisk: number | null })
                .medianCapitalAtRisk
          )
        ),
        indexedResolvedVolumeUsd: distribution(
          sliceByGate("pass").map(
            (w) =>
              (w.indexed as { resolvedVolumeUsd: number | null }).resolvedVolumeUsd
          )
        ),
      },
      FAIL: {
        productionAvgStakeNotional: distribution(
          sliceByGate("fail").map(
            (w) => (w.production as { avgStakeNotional: number | null }).avgStakeNotional
          )
        ),
        productionProxyResolvedVolumeUsd: distribution(
          sliceByGate("fail").map(
            (w) =>
              (w.production as { proxyResolvedVolumeUsd: number | null })
                .proxyResolvedVolumeUsd
          )
        ),
        indexedMedianCapitalAtRisk: distribution(
          sliceByGate("fail").map(
            (w) =>
              (w.indexed as { medianCapitalAtRisk: number | null })
                .medianCapitalAtRisk
          )
        ),
        indexedResolvedVolumeUsd: distribution(
          sliceByGate("fail").map(
            (w) =>
              (w.indexed as { resolvedVolumeUsd: number | null }).resolvedVolumeUsd
          )
        ),
      },
      UNKNOWN: {
        productionAvgStakeNotional: distribution(
          sliceByGate("unknown").map(
            (w) => (w.production as { avgStakeNotional: number | null }).avgStakeNotional
          )
        ),
        productionProxyResolvedVolumeUsd: distribution(
          sliceByGate("unknown").map(
            (w) =>
              (w.production as { proxyResolvedVolumeUsd: number | null })
                .proxyResolvedVolumeUsd
          )
        ),
        indexedMedianCapitalAtRisk: distribution(
          sliceByGate("unknown").map(
            (w) =>
              (w.indexed as { medianCapitalAtRisk: number | null })
                .medianCapitalAtRisk
          )
        ),
        indexedResolvedVolumeUsd: distribution(
          sliceByGate("unknown").map(
            (w) =>
              (w.indexed as { resolvedVolumeUsd: number | null }).resolvedVolumeUsd
          )
        ),
      },
    },
  };

  const profitabilityDistributions = {
    portfolioRealizedRoi: distribution(
      metricsSafeWallets.map(
        (w) => (w.indexed as { portfolioRealizedRoi: number | null }).portfolioRealizedRoi
      )
    ),
    profitablePositionRate: distribution(
      metricsSafeWallets.map(
        (w) =>
          (w.indexed as { profitablePositionRate: number | null })
            .profitablePositionRate
      )
    ),
    outcomeWinRate: distribution(
      metricsSafeWallets.map(
        (w) => (w.indexed as { outcomeWinRate: number | null }).outcomeWinRate
      )
    ),
    exploratoryThresholds: {
      label: "EXPLORATORY ONLY — not equivalent to production avg_ev >= 0.03",
      portfolioRealizedRoi_gte_0: metricsSafeWallets.filter(
        (w) =>
          ((w.indexed as { portfolioRealizedRoi: number | null }).portfolioRealizedRoi ??
            -Infinity) >= 0
      ).length,
      portfolioRealizedRoi_gte_0_03: metricsSafeWallets.filter(
        (w) =>
          ((w.indexed as { portfolioRealizedRoi: number | null }).portfolioRealizedRoi ??
            -Infinity) >= 0.03
      ).length,
      profitablePositionRate_gte_0_5: metricsSafeWallets.filter(
        (w) =>
          ((w.indexed as { profitablePositionRate: number | null })
            .profitablePositionRate ?? -Infinity) >= 0.5
      ).length,
      outcomeWinRate_gte_0_5: metricsSafeWallets.filter(
        (w) =>
          ((w.indexed as { outcomeWinRate: number | null }).outcomeWinRate ??
            -Infinity) >= 0.5
      ).length,
    },
  };

  const countDisagreementSummary = {
    PRODUCTION_UNDERCOUNT: wallets.filter(
      (w) =>
        (w.countDisagreement as { category: string }).category ===
        "PRODUCTION_UNDERCOUNT"
    ).length,
    INDEXED_LOWER_COUNT: wallets.filter(
      (w) =>
        (w.countDisagreement as { category: string }).category ===
        "INDEXED_LOWER_COUNT"
    ).length,
    ROUGH_AGREEMENT: wallets.filter(
      (w) =>
        (w.countDisagreement as { category: string }).category ===
        "ROUGH_AGREEMENT"
    ).length,
    UNUSABLE_NOT_COMPARABLE: wallets.filter(
      (w) =>
        (w.countDisagreement as { category: string }).category ===
        "UNUSABLE_NOT_COMPARABLE"
    ).length,
    materialDisagreements: wallets
      .filter((w) => {
        const c = (w.countDisagreement as { category: string }).category;
        return c === "PRODUCTION_UNDERCOUNT" || c === "INDEXED_LOWER_COUNT";
      })
      .map((w) => ({
        wallet: w.wallet,
        category: (w.countDisagreement as { category: string }).category,
        productionResolvedBets: (w.experience as { productionResolvedBets: number | null })
          .productionResolvedBets,
        indexedCompletedPositions: (w.experience as {
          indexedCompletedPositions: number | null;
        }).indexedCompletedPositions,
        delta: (w.experience as { delta: number | null }).delta,
        explanations: (w.countDisagreement as { explanations: string[] })
          .explanations,
      })),
  };

  const payload = {
    contractId: CREDIBILITY_CONTRACT_V2_ID,
    batchId: BATCH_ID,
    metricVersion: WALLET_METRIC_VERSION,
    generatedAt: new Date().toISOString(),
    semanticModel: {
      A: "productionCredibilityDecision",
      B: "apiReconstructedDecision (legacy diagnostic)",
      C: "indexedDataValidityDecision (structural validity; legacy field indexedDecision)",
      D: "indexedCredibilityCandidateDecision (Stage A definition only)",
    },
    wallets,
    summary: {
      cohortSelected: cohort.length,
      metricsSafe: metricsSafeWallets.length,
      productionFailBelowResolvedBets: prodFailBelowResolved.length,
      productionPassFailedIndexedGte10: prodPassFailedIndexed10.map((w) => ({
        wallet: w.wallet,
        completedPositionCount: (w.indexed as { completedPositionCount: number | null })
          .completedPositionCount,
        productionResolvedBets: (w.production as { resolvedBetsCount: number | null })
          .resolvedBetsCount,
      })),
      experienceFloorSensitivity,
      profitabilityDistributions,
      capitalVolumeDistributions,
      countDisagreementSummary,
      thresholdParityNote: `Production floor reference: MIN_WALLET_RESOLVED_BETS=${MIN_WALLET_RESOLVED_BETS}`,
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, "phase2e2-stageA-wallet-calibration.json");
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  const md = [
    "# Phase 2E.2 Stage A — Full50 Wallet Calibration",
    "",
    `Batch: **${BATCH_ID}** | Metric version: **${WALLET_METRIC_VERSION}**`,
    "",
    "## Semantic model",
    "",
    "| Code | Name | Meaning |",
    "|------|------|---------|",
    "| A | `productionCredibilityDecision` | Production numeric credibility |",
    "| B | `apiReconstructedDecision` | Legacy API diagnostic only |",
    "| C | `indexedDataValidityDecision` | Structural validity (`indexedDecision` legacy) |",
    "| D | `indexedCredibilityCandidateDecision` | Stage A candidate (not live) |",
    "",
    "## Experience-floor sensitivity (A vs observational D, metrics-safe)",
    "",
    ...payload.summary.experienceFloorSensitivity.map(
      (s) =>
        `- floor **${s.floor}**: nKnown=${s.matrix.nKnown} P→P=${s.matrix.passToPass} P→F=${s.matrix.passToFail} F→P=${s.matrix.failToPass} F→F=${s.matrix.failToFail}`
    ),
    "",
    "## Production FAIL below_resolved_bets (7 wallets)",
    "",
    ...prodFailBelowResolved.map((w) => {
      const exp = w.experience as {
        productionResolvedBets: number | null;
        indexedCompletedPositions: number | null;
        delta: number | null;
      };
      return `- \`${w.wallet}\` prod=${exp.productionResolvedBets} idx=${exp.indexedCompletedPositions} Δ=${exp.delta}`;
    }),
    "",
    "## Production PASS but indexed completed < 10 (metrics-safe)",
    "",
    ...payload.summary.productionPassFailedIndexedGte10.map(
      (w) =>
        `- \`${w.wallet}\` prod=${w.productionResolvedBets} idx=${w.completedPositionCount}`
    ),
    "",
    "## Count disagreement summary",
    "",
    `- PRODUCTION_UNDERCOUNT: ${countDisagreementSummary.PRODUCTION_UNDERCOUNT}`,
    `- INDEXED_LOWER_COUNT: ${countDisagreementSummary.INDEXED_LOWER_COUNT}`,
    `- ROUGH_AGREEMENT: ${countDisagreementSummary.ROUGH_AGREEMENT}`,
    `- UNUSABLE_NOT_COMPARABLE: ${countDisagreementSummary.UNUSABLE_NOT_COMPARABLE}`,
    "",
    "## Wallet table",
    "",
    "| wallet | A | prod resolved | idx completed | Δ | C validity | historyValidity | ROI |",
    "|--------|---|---------------|---------------|---|------------|-----------------|-----|",
    ...wallets.map((w) => {
      const p = w.production as {
        productionCredibilityDecision: boolean | null;
        resolvedBetsCount: number | null;
      };
      const i = w.indexed as {
        indexedDataValidity: boolean;
        completedPositionCount: number | null;
        historyValidity: string;
        portfolioRealizedRoi: number | null;
      };
      const e = w.experience as { delta: number | null };
      return `| \`${w.wallet}\` | ${p.productionCredibilityDecision} | ${p.resolvedBetsCount} | ${i.completedPositionCount} | ${e.delta} | ${i.indexedDataValidity} | ${i.historyValidity} | ${i.portfolioRealizedRoi?.toFixed(3) ?? "n/a"} |`;
    }),
    "",
  ];
  const mdPath = join(OUT_DIR, "phase2e2-stageA-wallet-calibration.md");
  writeFileSync(mdPath, md.join("\n"));

  console.log(JSON.stringify({ jsonPath, mdPath, summary: payload.summary }, null, 2));
}

void main().catch((error) => {
  console.error("[phase2e2-stageA] failed:", error);
  process.exit(1);
});
