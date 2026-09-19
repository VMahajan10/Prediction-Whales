#!/usr/bin/env tsx
/**
 * Daily Policy A coverage shadow metrics report (14+ day window).
 */
import "./preload-env";
import { desc, gte } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { policyACoverageDailyMetrics } from "@/lib/crossmarket/store/schema";

const MIN_OBSERVATION_DAYS = 14;

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const sinceDay = new Date(Date.now() - MIN_OBSERVATION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const db = getDb();
  const rows = await db
    .select()
    .from(policyACoverageDailyMetrics)
    .where(gte(policyACoverageDailyMetrics.dayKey, sinceDay))
    .orderBy(desc(policyACoverageDailyMetrics.dayKey));

  const totals = rows.reduce(
    (acc, row) => {
      acc.tradesDetected += row.tradesDetected;
      acc.tradeGateQualified += row.tradeGateQualified;
      acc.productionWalletQualified += row.productionWalletQualified;
      acc.policyAPass += row.policyAPass;
      acc.policyAFail += row.policyAFail;
      acc.policyAUnknown += row.policyAUnknown;
      acc.feedVisible += row.feedVisible;
      acc.feedWouldRemainPolicyA += row.feedWouldRemainPolicyA;
      acc.feedWouldFailPolicyA += row.feedWouldFailPolicyA;
      acc.feedUnknownPolicyA += row.feedUnknownPolicyA;
      return acc;
    },
    {
      tradesDetected: 0,
      tradeGateQualified: 0,
      productionWalletQualified: 0,
      policyAPass: 0,
      policyAFail: 0,
      policyAUnknown: 0,
      feedVisible: 0,
      feedWouldRemainPolicyA: 0,
      feedWouldFailPolicyA: 0,
      feedUnknownPolicyA: 0,
    }
  );

  const productionQualified = totals.productionWalletQualified;
  const report = {
    mode: "policy_a_coverage_daily_report",
    minObservationDays: MIN_OBSERVATION_DAYS,
    daysObserved: rows.length,
    sinceDay,
    dailyRows: rows,
    totals,
    shares: {
      policyAPassPct:
        productionQualified > 0
          ? (totals.policyAPass / productionQualified) * 100
          : null,
      policyAFailPct:
        productionQualified > 0
          ? (totals.policyAFail / productionQualified) * 100
          : null,
      policyAUnknownPct:
        productionQualified > 0
          ? (totals.policyAUnknown / productionQualified) * 100
          : null,
      projectedFeedReductionPct:
        totals.feedVisible > 0
          ? ((totals.feedVisible - totals.feedWouldRemainPolicyA) /
              totals.feedVisible) *
            100
          : null,
    },
    recommendation:
      rows.length < MIN_OBSERVATION_DAYS
        ? "MORE_COVERAGE_NEEDED"
        : totals.policyAUnknown > totals.policyAPass + totals.policyAFail
          ? "MORE_COVERAGE_NEEDED"
          : totals.feedVisible > 0 &&
              (totals.feedVisible - totals.feedWouldRemainPolicyA) /
                totals.feedVisible >
                0.6
            ? "POLICY_TOO_AGGRESSIVE"
            : "READY_FOR_LIMITED_ROLLOUT",
  };

  const outDir = join(process.cwd(), "tmp/wallet-history");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(
    outDir,
    `policy-a-coverage-daily-${new Date().toISOString().slice(0, 10)}.json`
  );
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`\n[wrote] ${outPath}`);
}

void main().catch((error) => {
  console.error("[policy-a-coverage-daily-report] failed:", error);
  process.exit(1);
});
