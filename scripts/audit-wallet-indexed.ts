#!/usr/bin/env tsx
/**
 * Phase 2D indexed Polygon history provider spike.
 *
 * Usage:
 *   npm run audit:wallet-indexed
 *   npm run audit:wallet-indexed -- --provider full_history_rpc --max-blocks 200000
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import {
  evaluateIndexedProviders,
  estimateIndexedFeasibility,
  runIndexedWalletAudit,
} from "@/lib/walletLedger/indexed/pipeline";
import { setAuditProgressEnabled } from "@/lib/walletLedger/indexed/auditProgress";
import { formatPhase2dMarkdownReport } from "@/lib/walletLedger/indexed/report";
import type { IndexedProviderId } from "@/lib/walletLedger/indexed/types";

const WALLETS = [
  {
    label: "buy_sell_active",
    wallet: "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66",
  },
  {
    label: "high_avg_ev_truncated",
    wallet: "0x7e5972bfc25819775ee5a9d4f191919375487b8b",
  },
  {
    label: "identity_mismatch_probe",
    wallet: "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
    transactionHash:
      "0x59c3aad53bf226ee382efb4b33bbaa4b43563d4298450011e06c9837e891232a",
  },
] as const;

function parseArgs(argv: string[]): {
  wallets: Array<{ label: string; wallet: string; transactionHash?: string }>;
  providerId?: IndexedProviderId;
  maxBlocksToScan: number;
  fullHistory: boolean;
  debug: boolean;
  resumeCheckpoint: boolean;
} {
  let providerId: IndexedProviderId | undefined;
  let maxBlocksToScan = 500_000;
  let fullHistory = false;
  let debug = false;
  let resumeCheckpoint = true;
  const wallets: Array<{ label: string; wallet: string; transactionHash?: string }> =
    [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--provider" && argv[i + 1]) {
      providerId = argv[++i] as IndexedProviderId;
    } else if (arg === "--max-blocks" && argv[i + 1]) {
      maxBlocksToScan = Number(argv[++i]);
    } else if (arg === "--full-history") {
      fullHistory = true;
    } else if (arg === "--debug") {
      debug = true;
    } else if (arg === "--no-resume") {
      resumeCheckpoint = false;
    } else if (arg === "--wallet" && argv[i + 1]) {
      wallets.push({ label: `custom_${wallets.length + 1}`, wallet: argv[++i] });
    }
  }

  return {
    wallets: wallets.length > 0 ? wallets : [...WALLETS],
    providerId,
    maxBlocksToScan,
    fullHistory,
    debug,
    resumeCheckpoint,
  };
}

function printSummary(
  result: Awaited<ReturnType<typeof runIndexedWalletAudit>>
): void {
  console.log(`\n=== ${result.label} (${result.providerId}) ===`);
  console.log(
    `Provider available: ${result.providerProbe.available} (${result.providerProbe.error ?? "ok"})`
  );
  console.log(
    `Fetch: requests=${result.fetchStats.requests} pages=${result.fetchStats.pages} rateLimitHits=${result.fetchStats.rateLimitHits} logs=${result.fetchStats.logsReturned} duration=${(result.fetchStats.elapsedMs / 1000).toFixed(1)}s errors=${result.fetchStats.errors.length}`
  );
  console.log(
    `Coverage: api=${result.coverage.apiEventCount} indexed=${result.coverage.indexedEventCount} beforeApi=${result.coverage.eventsBeforeApiBoundary} extends=${result.extendsBeforeApiBoundary}`
  );
  console.log(
    `Timestamps: apiOldest=${result.coverage.apiOldestTimestamp} indexedOldest=${result.coverage.indexedOldestTimestamp}`
  );
  console.log(
    `Metrics: credible ${result.credibilityMetricsValidBefore} → ${result.credibilityMetricsValidAfter}; historyComplete ${result.historyCompleteBefore} → ${result.historyCompleteAfter}`
  );
  if (result.historyCompletenessBreakdown) {
    const b = result.historyCompletenessBreakdown;
    console.log(
      `History completeness: event=${b.eventHistoryComplete} resolution=${b.resolutionComplete} identity=${b.identityComplete} truncation=${b.truncationDetected} openPositions=${b.openPositions} gammaIncomplete=${b.gammaResolutionIncomplete} certified=${b.certifiedHistoryComplete}`
    );
  }
  if (result.blockTimestampStats) {
    const ts = result.blockTimestampStats;
    console.log(
      `Block timestamps: unique=${ts.requestedUnique} diskLoaded=${ts.diskEntriesLoaded} hits=${ts.hits} misses=${ts.misses} logSeeded=${ts.logSeededUnique} logicalRpc=${ts.logicalRpcLookups} rpcAttempts=${ts.rpcAttempts} retries=${ts.retries} failures=${ts.failures} persisted=${ts.persistedEntries} elapsed=${(ts.elapsedMs / 1000).toFixed(1)}s`
    );
  }
  if (result.gammaPrefetchStats) {
    const g = result.gammaPrefetchStats;
    console.log(
      `Gamma prefetch: hints=${g.hintsTotal} pending=${g.pending} conditionLookups=${g.conditionLookups} backfill=${g.backfillLookups} skippedBackfill=${g.skippedBackfill} elapsed=${(g.elapsedMs / 1000).toFixed(1)}s`
    );
  }
  console.log(
    `Positions: api=${result.apiOnlyPositions}/${result.apiCompletedPositions} completed → indexed=${result.indexedPositions}/${result.indexedCompletedPositions}`
  );
}

async function main(): Promise<void> {
  const { wallets, providerId, maxBlocksToScan, fullHistory, debug, resumeCheckpoint } =
    parseArgs(process.argv.slice(2));

  if (debug || fullHistory) {
    setAuditProgressEnabled(true);
  }

  console.error("[audit:wallet-indexed] evaluating providers...");
  const providerEvaluations = await evaluateIndexedProviders();
  for (const ev of providerEvaluations) {
    const probeError =
      ev.probe.error == null
        ? "none"
        : ev.probe.error === ""
          ? "<empty string>"
          : ev.probe.error;
    console.error(
      `  ${ev.providerId}: available=${ev.probe.available} latency=${ev.probe.probeLatencyMs}ms error=${probeError}`
    );
  }

  const testingEtherscan = !providerId || providerId === "etherscan_v2";
  if (testingEtherscan) {
    const etherscan = providerEvaluations.find(
      (ev) => ev.providerId === "etherscan_v2"
    );
    if (!etherscan?.probe.available) {
      const reason =
        etherscan?.probe.error == null || etherscan.probe.error === ""
          ? "etherscan_v2_unavailable_empty_error (run npm run check:indexed-provider)"
          : etherscan.probe.error;
      console.error(
        `[audit:wallet-indexed] FAIL FAST: Etherscan V2 unavailable; not falling back to full_history_rpc. reason=${reason}`
      );
      process.exit(1);
    }
  }

  const effectiveProviderId: IndexedProviderId | undefined = testingEtherscan
    ? "etherscan_v2"
    : providerId;

  const results = [];
  for (const spec of wallets) {
    console.error(
      `[audit:wallet-indexed] auditing ${spec.label} ${spec.wallet}`
    );
    const result = await runIndexedWalletAudit({
      ...spec,
      providerId: effectiveProviderId,
      providerEvaluations,
      maxBlocksToScan,
      fullHistory,
      debug,
      resumeCheckpoint,
    });
    results.push(result);
    printSummary(result);
  }

  const feasibility = [100, 700, 10_000].map((count) =>
    estimateIndexedFeasibility({
      wallets: count,
      providerId: results[0]?.providerId ?? "etherscan_v2",
    })
  );

  const outputDir = join(process.cwd(), "tmp", "wallet-indexed-audit");
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(outputDir, `audit-${stamp}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify({ providerEvaluations, results, feasibility }, null, 2)
  );

  const reportMd = formatPhase2dMarkdownReport({
    providerEvaluations,
    results,
    feasibility,
    phase2cBaseline: { rpcCalls: 1200, elapsedSec: 9 },
  });
  const mdPath = join(outputDir, `audit-${stamp}.md`);
  writeFileSync(mdPath, reportMd);

  console.log(`\nJSON written: ${jsonPath}`);
  console.log(`Report written: ${mdPath}`);
}

void main().catch((error) => {
  console.error("[audit:wallet-indexed] failed:", error);
  process.exit(1);
});
