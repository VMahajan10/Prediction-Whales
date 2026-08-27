#!/usr/bin/env tsx
/**
 * Phase 2B read-only wallet ledger audit.
 *
 * Usage:
 *   npm run audit:wallet-ledger
 *   npm run audit:wallet-ledger -- --wallet 0xabc...
 *   npm run audit:wallet-ledger -- --json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import { runWalletLedgerAudit } from "@/lib/walletLedger/pipeline";
import { REPRESENTATIVE_WALLET_SPECS } from "@/lib/walletLedger/representativeWallets";
import type {
  ProductionWalletMetrics,
  WalletLedgerAuditResult,
} from "@/lib/walletLedger/types";

function parseArgs(argv: string[]): {
  wallets: string[];
  json: boolean;
  delayMs: number;
} {
  const wallets: string[] = [];
  let json = false;
  let delayMs = 100;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--wallet" && argv[i + 1]) {
      wallets.push(argv[++i].toLowerCase());
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--delay-ms" && argv[i + 1]) {
      delayMs = Number(argv[++i]);
    } else if (arg.startsWith("0x")) {
      wallets.push(arg.toLowerCase());
    }
  }
  return { wallets, json, delayMs };
}

async function loadProductionMetrics(
  wallets: string[]
): Promise<Map<string, ProductionWalletMetrics>> {
  const map = new Map<string, ProductionWalletMetrics>();
  const url = process.env.DATABASE_URL?.trim();
  if (!url || wallets.length === 0) return map;

  try {
    const pg = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const result = await client.query<{
      wallet_address: string;
      resolved_bets_count: number;
      avg_ev: number;
      win_rate: number;
      avg_stake_notional: number;
    }>(
      `SELECT wallet_address, resolved_bets_count, avg_ev, win_rate, avg_stake_notional
       FROM whale_registry WHERE lower(wallet_address) = ANY($1::text[])`,
      [wallets.map((w) => w.toLowerCase())]
    );
    for (const row of result.rows) {
      map.set(row.wallet_address.toLowerCase(), {
        resolvedBetsCount: row.resolved_bets_count,
        avgEv: row.avg_ev,
        winRate: row.win_rate,
        avgStakeNotional: row.avg_stake_notional,
      });
    }
    await client.end();
  } catch (error) {
    console.warn(
      "[audit:wallet-ledger] production metrics unavailable:",
      error instanceof Error ? error.message : error
    );
  }

  return map;
}

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return `${(value * 100).toFixed(1)}%`;
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function printMetricBundle(
  label: string,
  bundle: WalletLedgerAuditResult["metrics"]["observedWindowMetrics"] | null
): void {
  if (!bundle) {
    console.log(`${label}: null (invalid)`);
    return;
  }
  console.log(
    `${label}: completed=${bundle.completedPositionCount} profitable=${pct(bundle.profitablePositionRate)} roi=${pct(bundle.portfolioRealizedRoi)} medianCar=${money(bundle.medianCapitalAtRisk)} volume=${money(bundle.resolvedVolumeUsd)}`
  );
}

function printWalletSummary(result: WalletLedgerAuditResult): void {
  const { identity, metrics, production, reconciliation } = result;
  console.log(`\n=== ${result.label} ===`);
  console.log(
    `Identity: requested=${identity.requestedWallet} history=${identity.historyWallet ?? "—"} method=${identity.resolutionMethod} confidence=${identity.confidence} mismatch=${identity.positionsOnlyMismatch}`
  );
  if (identity.alternateCandidates.length > 0) {
    console.log(`Alternate candidates: ${identity.alternateCandidates.join(", ")}`);
  }
  if (identity.evidence.notes.length > 0) {
    console.log(`Evidence: ${identity.evidence.notes.join("; ")}`);
  }
  console.log(
    `Source coverage: activity=${result.activity.rows.length}${result.activity.truncated ? " (TRUNCATED)" : ""} trades=${result.trades.rows.length}${result.trades.truncated ? " (TRUNCATED)" : ""} positions=${result.positionsCount}`
  );
  console.log(
    `Gamma coverage: found=${metrics.gammaCoverage.marketsFoundAfter}/${metrics.gammaCoverage.distinctMarkets} (${pct(metrics.gammaCoverage.marketFoundCoverageAfterPct)}) resolved before=${metrics.gammaCoverage.resolvedBefore} after=${metrics.gammaCoverage.resolvedAfter} (${pct(metrics.gammaCoverage.coverageAfterPct)})`
  );
  console.log(
    `Resolution (required only): ${metrics.resolutionCoverage.positionsSuccessfullyResolved}/${metrics.resolutionCoverage.positionsRequiringResolution} (${pct(metrics.resolutionCoverage.resolutionCoveragePct)}) unresolved=${metrics.resolutionCoverage.positionsUnresolved}`
  );
  console.log(
    `Ledger: positions=${reconciliation.distinctPositions} completed=${reconciliation.completedPositions} fullyExited=${reconciliation.fullyExitedPositions} heldThrough=${reconciliation.heldThroughResolutionPositions} (win=${reconciliation.winningHeldPositions} lose=${reconciliation.losingHeldPositions} unresolved=${reconciliation.unresolvedHeldPositions})`
  );
  console.log(
    `MERGE/SPLIT: affected=${metrics.mergeSplit.positionsWithMergeSplit} ambiguous=${metrics.mergeSplit.ambiguousMergeSplit} pctCompleted=${pct(metrics.mergeSplit.pctCompletedPositionsAffected)} recommendation=${metrics.mergeSplit.recommendation}`
  );
  console.log(
    `Validity: historyValidity=${metrics.historyValidity} metricValidity=${metrics.metricValidity} credibilityValid=${metrics.credibilityMetricsValid} reasons=${metrics.historyCompletenessReasons.join(", ") || "none"}`
  );

  printMetricBundle("observedWindowMetrics", metrics.observedWindowMetrics);
  printMetricBundle("credibilityMetrics", metrics.credibilityMetrics);

  if (production) {
    console.log("\n| Metric | Production | Observed | Credible |");
    console.log("| --- | ---: | ---: | ---: |");
    console.log(
      `| resolved_bets_count | ${production.resolvedBetsCount} | ${metrics.observedWindowMetrics.completedPositionCount} | ${metrics.credibilityMetrics?.completedPositionCount ?? "null"} |`
    );
    console.log(
      `| win_rate | ${pct(production.winRate)} | ${pct(metrics.observedWindowMetrics.profitablePositionRate)} | ${pct(metrics.credibilityMetrics?.profitablePositionRate ?? null)} |`
    );
    console.log(
      `| portfolio_roi | ${pct(production.avgEv)} | ${pct(metrics.observedWindowMetrics.portfolioRealizedRoi)} | ${pct(metrics.credibilityMetrics?.portfolioRealizedRoi ?? null)} |`
    );
  }
}

function serializeResult(result: WalletLedgerAuditResult): unknown {
  return {
    label: result.label,
    identity: result.identity,
    activity: {
      rows: result.activity.rows.length,
      truncated: result.activity.truncated,
    },
    trades: {
      rows: result.trades.rows.length,
      truncated: result.trades.truncated,
    },
    positionsCount: result.positionsCount,
    gammaResolvedCount: result.gammaResolvedCount,
    gammaTotalMarkets: result.gammaTotalMarkets,
    metrics: result.metrics,
    production: result.production,
    reconciliation: result.reconciliation,
  };
}

async function main(): Promise<void> {
  const { wallets, json, delayMs } = parseArgs(process.argv.slice(2));
  const specs =
    wallets.length > 0
      ? wallets.map((wallet, index) => ({
          label: `custom_${index + 1}`,
          wallet,
          category: "custom",
        }))
      : REPRESENTATIVE_WALLET_SPECS;

  const productionMap = await loadProductionMetrics(specs.map((s) => s.wallet));
  const results: WalletLedgerAuditResult[] = [];

  for (const spec of specs) {
    console.error(`[audit:wallet-ledger] auditing ${spec.label} ${spec.wallet}`);
    const result = await runWalletLedgerAudit({
      label: spec.label,
      wallet: spec.wallet,
      transactionHash: spec.transactionHash,
      assetId: spec.assetId,
      production: productionMap.get(spec.wallet.toLowerCase()) ?? null,
      interPageDelayMs: delayMs,
    });
    results.push(result);
    if (!json) printWalletSummary(result);
  }

  const outputDir = join(process.cwd(), "tmp", "wallet-ledger-audit");
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(outputDir, `audit-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(results.map(serializeResult), null, 2));

  const credible = results.filter((r) => r.metrics.credibilityMetricsValid).length;
  const complete = results.filter((r) => r.metrics.historyValidity === "complete").length;
  const partialSafe = results.filter(
    (r) => r.metrics.historyValidity === "partial-but-metrics-safe"
  ).length;
  const partialUnsafe = results.filter(
    (r) => r.metrics.historyValidity === "partial-and-metrics-unsafe"
  ).length;
  const unusable = results.filter(
    (r) => r.metrics.historyValidity === "unusable"
  ).length;

  console.log(`\n=== Batch summary ===`);
  console.log(`Wallets audited: ${results.length}`);
  console.log(
    `History validity: complete=${complete} partial-safe=${partialSafe} partial-unsafe=${partialUnsafe} unusable=${unusable}`
  );
  console.log(`Trustworthy credibility metrics: ${credible}/${results.length}`);
  console.log(`JSON written: ${jsonPath}`);
}

void main().catch((error) => {
  console.error("[audit:wallet-ledger] failed:", error);
  process.exit(1);
});
