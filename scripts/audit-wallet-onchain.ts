#!/usr/bin/env tsx
/**
 * Phase 2C read-only on-chain wallet history diagnostic.
 *
 * Usage:
 *   npm run audit:wallet-onchain
 *   npm run audit:wallet-onchain -- --wallet 0xabc...
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import {
  estimateOnChainFeasibility,
  runOnChainWalletAudit,
} from "@/lib/walletLedger/onchain/pipeline";
import { formatPhase2cMarkdownReport } from "@/lib/walletLedger/onchain/report";

import { REPRESENTATIVE_WALLET_SPECS } from "@/lib/walletLedger/representativeWallets";

const PHASE_2C_WALLETS = [
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
  lookbackBlocks: number;
  maxBlocksToScan: number;
} {
  const wallets: Array<{ label: string; wallet: string; transactionHash?: string }> =
    [];
  let lookbackBlocks = 200_000;
  let maxBlocksToScan = 100_000;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--wallet" && argv[i + 1]) {
      wallets.push({ label: `custom_${wallets.length + 1}`, wallet: argv[++i] });
    } else if (arg === "--lookback-blocks" && argv[i + 1]) {
      lookbackBlocks = Number(argv[++i]);
    } else if (arg === "--max-blocks" && argv[i + 1]) {
      maxBlocksToScan = Number(argv[++i]);
    } else if (arg.startsWith("0x")) {
      wallets.push({ label: `custom_${wallets.length + 1}`, wallet: arg });
    }
  }
  if (wallets.length > 0) {
    return {
      wallets: wallets.map((w) => {
        const spec = REPRESENTATIVE_WALLET_SPECS.find(
          (s) => s.wallet.toLowerCase() === w.wallet.toLowerCase()
        );
        return {
          ...w,
          transactionHash: w.transactionHash ?? spec?.transactionHash,
          assetId: spec?.assetId,
        };
      }),
      lookbackBlocks,
      maxBlocksToScan,
    };
  }
  return {
    wallets: [...PHASE_2C_WALLETS],
    lookbackBlocks,
    maxBlocksToScan,
  };
}

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${(v * 100).toFixed(1)}%`;
}

function printSummary(
  result: Awaited<ReturnType<typeof runOnChainWalletAudit>>
): void {
  console.log(`\n=== ${result.label} (${result.wallet}) ===`);
  console.log(
    `Identity: related=${result.identity.relatedAddresses.join(", ") || "—"} subjects=${result.identity.canonicalHistorySubjects.join(", ") || "—"} confidence=${result.identity.confidence}`
  );
  console.log(
    `Fetch: blocks=${result.fetchStats.blocksScanned} rpc=${result.fetchStats.rpcCalls} logs=${result.fetchStats.logsReturned} txs=${result.fetchStats.uniqueTransactions} duration=${(result.fetchStats.elapsedMs / 1000).toFixed(1)}s`
  );
  console.log(
    `Coverage: apiEvents=${result.coverage.apiEventCount} chainEvents=${result.coverage.chainEventCount} additionalHistorical=${result.coverage.additionalHistoricalEvents} onChainComplete=${result.coverage.onChainHistoryComplete}`
  );
  console.log(
    `Timestamps: apiOldest=${result.coverage.apiOldestTimestamp} chainOldest=${result.coverage.chainOldestTimestamp}`
  );
  console.log(
    `Reconcile: apiTrades=${result.reconciliation.apiTradeCount} chainTrades=${result.reconciliation.chainTradeCount} matched=${result.reconciliation.matchedEvents} matchRate=${pct(result.reconciliation.matchRate)}`
  );
  const api = result.apiLedgerMetrics;
  const combined = result.combinedLedgerMetrics;
  console.log(
    `API-only: positions=${result.apiOnlyPositions} completed=${api?.completedPositionCount ?? 0} roi=${pct(api?.portfolioRealizedRoi ?? null)} credible=${api?.credibilityMetricsValid ?? false}`
  );
  console.log(
    `API+chain: positions=${result.combinedPositions} completed=${combined.completedPositionCount} roi=${pct(combined.portfolioRealizedRoi)} credible=${combined.credibilityMetricsValid}`
  );
  console.log(
    `MERGE/SPLIT: ${result.mergeSplitVerdict} — ${result.mergeSplitNotes.join("; ")}`
  );
}

async function main(): Promise<void> {
  const { wallets, lookbackBlocks, maxBlocksToScan } = parseArgs(
    process.argv.slice(2)
  );
  const results = [];

  for (const spec of wallets) {
    console.error(`[audit:wallet-onchain] auditing ${spec.label} ${spec.wallet}`);
    const result = await runOnChainWalletAudit({
      label: spec.label,
      wallet: spec.wallet,
      transactionHash: spec.transactionHash,
      lookbackBlocks,
      maxBlocksToScan,
    });
    results.push(result);
    printSummary(result);
  }

  const outputDir = join(process.cwd(), "tmp", "wallet-onchain-audit");
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(outputDir, `audit-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  const feasibility = [100, 700, 10_000].map((count) =>
    estimateOnChainFeasibility({ wallets: count })
  );

  console.log("\n=== Feasibility estimates ===");
  for (const est of feasibility) {
    console.log(
      `${est.wallets} wallets: ~${est.estimatedRpcCalls.toLocaleString()} RPC calls, ~${est.estimatedDurationMinutes.toFixed(0)} minutes`
    );
  }

  const reportMd = formatPhase2cMarkdownReport({ results, feasibility });
  const mdPath = join(outputDir, `audit-${stamp}.md`);
  writeFileSync(mdPath, reportMd);

  console.log(`\nJSON written: ${jsonPath}`);
  console.log(`Report written: ${mdPath}`);
}

void main().catch((error) => {
  console.error("[audit:wallet-onchain] failed:", error);
  process.exit(1);
});
