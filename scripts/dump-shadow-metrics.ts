import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import { SMOKE_COHORT_10 } from "@/lib/walletLedger/indexed/shadow/cohort";

async function main() {
  const db = getDb();
  for (const spec of SMOKE_COHORT_10) {
    const production = await loadProductionCredibilitySnapshot(spec.wallet);
    const metrics = await db
      .select()
      .from(walletHistoricalMetrics)
      .where(
        sql`lower(${walletHistoricalMetrics.walletAddress}) = ${spec.wallet.toLowerCase()}`
      )
      .limit(1);
    const coverage = await db
      .select()
      .from(walletHistoryCoverage)
      .where(
        sql`lower(${walletHistoryCoverage.walletAddress}) = ${spec.wallet.toLowerCase()}`
      )
      .limit(1);
    const m = metrics[0];
    const c = coverage[0];
    console.log(
      JSON.stringify({
        wallet: spec.wallet,
        label: spec.label,
        cohortReason: spec.cohortReason,
        productionCredible: production.productionCredible,
        productionResolved: production.resolvedBetsCount,
        productionAvgEv: production.avgEv,
        hydration: production.hydrationStatus,
        indexedCredible: m?.credibilityDecision ?? null,
        indexedCompleted: m?.completedPositions ?? null,
        indexedRoi: m?.realizedRoi ?? null,
        historyValidity: m?.historyValidity ?? null,
        historyComplete: m?.historyComplete ?? null,
        indexedEvents: c?.eventsBeforeApiBoundary != null ? "see coverage" : null,
        eventsBeforeApi: c?.eventsBeforeApiBoundary ?? null,
        timestampCoveragePct: c?.timestampCoveragePct ?? null,
      })
    );
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
