#!/usr/bin/env tsx
/**
 * Re-validate 0x0562 authoritative DB+delta reconstruction after Phase 2E.1 fixes.
 */
import "./preload-env";

import {
  evaluateIndexedProviders,
  runIndexedWalletAudit,
} from "@/lib/walletLedger/indexed/pipeline";
import {
  countWalletLedgerEvents,
  loadPersistedCoverageSnapshot,
  persistIndexedWalletAudit,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";

async function main(): Promise<void> {
  const dbBefore = await countWalletLedgerEvents(WALLET);
  const coverageBefore = await loadPersistedCoverageSnapshot(WALLET);

  const audit = await runIndexedWalletAudit({
    label: "buy_sell_active",
    wallet: WALLET,
    providerId: "etherscan_v2",
    providerEvaluations: await evaluateIndexedProviders(),
    fullHistory: true,
    resumeCheckpoint: true,
  });

  await persistIndexedWalletAudit(audit);

  const dbAfter = await countWalletLedgerEvents(WALLET);
  const stats = audit.authoritativeEventStats;
  const indexed = audit.indexedCredibility;

  console.log(
    JSON.stringify(
      {
        wallet: WALLET,
        dbPersistedEventCountBefore: dbBefore,
        dbPersistedEventCountAfter: dbAfter,
        checkpointDeltaEventCount: audit.indexedEvents?.length ?? 0,
        authoritativeIndexedEventCount:
          audit.authoritativeIndexedEvents?.length ?? 0,
        authoritativeEventStats: stats,
        eventsBeforeApiBoundary:
          audit.eventsBeforeApiBoundaryEffective ??
          audit.coverage.eventsBeforeApiBoundary,
        indexedOldestTimestamp: audit.coverage.indexedOldestTimestamp,
        extendsBeforeApiBoundary: audit.extendsBeforeApiBoundary,
        historyValidity: indexed?.historyValidity,
        credibilityMetricsValid: indexed?.credibilityMetricsValid,
        indexedDecision: indexed?.credibilityDecision,
        reasons: indexed?.reasons ?? [],
        historicalBackfillRequired: audit.historicalBackfillRequired ?? false,
        coverageBefore,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[revalidate-0562] failed:", error);
  process.exit(1);
});
