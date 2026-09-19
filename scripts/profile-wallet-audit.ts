#!/usr/bin/env tsx
/**
 * Full stage timing profile for a single wallet audit.
 */
import "./preload-env";
import { countWalletLedgerEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import { persistIndexedWalletAudit } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";

const wallet =
  process.argv[2] ?? "0x7e5972bfc25819775ee5a9d4f191919375487b8b";

async function main(): Promise<void> {
  const started = Date.now();
  const eventsBefore = await countWalletLedgerEvents(wallet);

  const prodStarted = Date.now();
  const production = await loadProductionCredibilitySnapshot(wallet);
  const productionProbeMs = Date.now() - prodStarted;

  const audit = await runIndexedWalletAudit({
    label: "profile",
    wallet,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: true,
  });

  const persistStarted = Date.now();
  const persistStats = await persistIndexedWalletAudit(audit);
  const persistTotalMs = Date.now() - persistStarted;
  const eventsAfter = await countWalletLedgerEvents(wallet);

  const stageTimings = audit.stageTimingsMs ?? {};
  const stageSum = Object.values(stageTimings).reduce((a, b) => a + b, 0);
  const totalMs = Date.now() - started;

  console.log(
    JSON.stringify(
      {
        wallet,
        totalMs,
        stageTimingsSumMs: stageSum,
        unaccountedMs: totalMs - stageSum - productionProbeMs - persistTotalMs,
        productionProbeMs,
        persistTotalMs,
        productionDecision: production.productionCredible,
        apiReconstructedDecision: audit.credibilityMetricsValidBefore,
        indexedDecision: audit.credibilityMetricsValidAfter,
        stageTimings,
        dbWrites: {
          eventsBefore,
          eventsAfter,
          delta: eventsAfter - eventsBefore,
          ...persistStats,
        },
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
