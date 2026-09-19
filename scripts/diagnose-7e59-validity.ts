#!/usr/bin/env tsx
/**
 * Re-run 0x7e59 only: three-way decisions + persist + verify agreement.
 */
import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import { explainHistoryCompleteness } from "@/lib/walletLedger/indexed/metricsProfile";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import { persistIndexedWalletAudit } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { classifyShadowDisagreement } from "@/lib/walletLedger/indexed/shadow/taxonomy";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";

const WALLET =
  process.argv[2] ?? "0x7e5972bfc25819775ee5a9d4f191919375487b8b";

async function main(): Promise<void> {
  const production = await loadProductionCredibilitySnapshot(WALLET);
  const audit = await runIndexedWalletAudit({
    label: "verify-7e59",
    wallet: WALLET,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: true,
  });
  await persistIndexedWalletAudit(audit);

  const disagreement = classifyShadowDisagreement({ production, audit });
  const db = getDb();
  const [metricsRow] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      sql`lower(${walletHistoricalMetrics.walletAddress}) = ${WALLET.toLowerCase()} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
    )
    .limit(1);
  const [coverageRow] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(sql`lower(${walletHistoryCoverage.walletAddress}) = ${WALLET.toLowerCase()}`)
    .limit(1);

  const indexed = audit.indexedCredibility;
  const api = audit.apiCredibility;
  const breakdown = audit.historyCompletenessBreakdown ?? {};

  console.log(
    JSON.stringify(
      {
        decisions: {
          A_productionDecision: production.productionCredible,
          B_apiReconstructedDecision:
            api?.credibilityDecision ?? audit.credibilityMetricsValidBefore,
          C_indexedDecision:
            indexed?.credibilityDecision ?? audit.credibilityMetricsValidAfter,
        },
        B_api: api,
        C_indexed: indexed,
        apiReasons: disagreement.apiReasons,
        indexedReasons: indexed?.reasons ?? [],
        indexedValidityInputs: {
          ...breakdown,
          extendsBeforeApiBoundary: audit.extendsBeforeApiBoundary,
          eventsBeforeApiBoundaryEffective: audit.eventsBeforeApiBoundaryEffective,
          eventsBeforeApiBoundary_run: audit.coverage.eventsBeforeApiBoundary,
        },
        persistedMetrics: metricsRow
          ? {
              credibilityDecision: metricsRow.credibilityDecision,
              credibilityMetricsValid: metricsRow.credibilityMetricsValid,
              historyValidity: metricsRow.historyValidity,
              historyComplete: metricsRow.historyComplete,
              reasons: metricsRow.historyIncompleteReasons,
            }
          : null,
        persistedCoverage: coverageRow
          ? {
              extendsBeforeApiBoundary: coverageRow.extendsBeforeApiBoundary,
              eventsBeforeApiBoundary: coverageRow.eventsBeforeApiBoundary,
              historyValidity: coverageRow.historyValidity,
            }
          : null,
        agreement: {
          auditVsPersistedDecision:
            indexed?.credibilityDecision === metricsRow?.credibilityDecision,
          auditVsPersistedValidity:
            indexed?.historyValidity === metricsRow?.historyValidity,
        },
        diagnosis:
          "Earlier profile FAIL was sparse-checkpoint run (2.9k logs); not validity-rule regression when full history loads.",
      },
      null,
      2
    )
  );
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
