#!/usr/bin/env tsx
/**
 * Forensic: Polymarket closed-positions API vs wallet_position_lifecycles.
 */
import "../tests/preload-env";
import { sql, eq, and } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletPositionLifecycles,
} from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { fetchClosedPositions } from "@/lib/polymarket";
import { fetchPolymarketProfilePnl } from "@/lib/walletLedger/reconciliation/fetchProfilePnl";

const WALLETS = [
  "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6",
  "0x9e3ed7b661a903fc97afcf49e0f014ebe869f882",
  "0xad529df14c293d77984a0137990a1441b25211ac",
];

function lifecycleKey(assetId: string, episode: number) {
  return `${assetId}#${episode}`;
}

async function loadLedgerByAsset(wallet: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(walletPositionLifecycles)
    .where(
      and(
        sql`lower(${walletPositionLifecycles.walletAddress}) = ${wallet.toLowerCase()}`,
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    );
  const byAsset = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byAsset.get(r.assetId) ?? [];
    list.push(r);
    byAsset.set(r.assetId, list);
  }
  return { rows, byAsset };
}

async function loadCoverage(wallet: string) {
  const db = getDb();
  const [cov] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(
      sql`lower(${walletHistoryCoverage.walletAddress}) = ${wallet.toLowerCase()}`
    )
    .limit(1);
  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        sql`lower(${walletHistoricalMetrics.walletAddress}) = ${wallet.toLowerCase()}`,
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  return { cov, metrics };
}

function tsLabel(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  return new Date(sec * 1000).toISOString();
}

async function analyzeWallet(wallet: string) {
  console.log("\n" + "=".repeat(80));
  console.log(`WALLET ${wallet}`);
  console.log("=".repeat(80));

  const closed = await fetchClosedPositions(wallet);
  console.log(`\nPolymarket closed-positions API: ${closed.length} rows returned`);

  const apiSum = closed.reduce(
    (s, p) => s + Number(p.realizedPnl ?? 0),
    0
  );
  console.log(`API sum(realizedPnl) over returned rows: $${apiSum.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

  const top10 = [...closed]
    .sort(
      (a, b) =>
        Math.abs(Number(b.realizedPnl ?? 0)) -
        Math.abs(Number(a.realizedPnl ?? 0))
    )
    .slice(0, 10);

  if (!isDatabaseEnabled()) {
    console.log("DATABASE_URL not set — skipping ledger compare");
    return;
  }

  const { rows: ledgerRows, byAsset } = await loadLedgerByAsset(wallet);
  const completed = ledgerRows.filter((r) => r.completed && r.realizedPnl != null);
  const ledgerGp = completed.reduce(
    (s, r) => s + (r.realizedPnl! > 0 ? r.realizedPnl! : 0),
    0
  );
  const ledgerGl = completed.reduce(
    (s, r) => s + (r.realizedPnl! < 0 ? Math.abs(r.realizedPnl!) : 0),
    0
  );
  console.log(
    `\nLedger lifecycles: ${ledgerRows.length} rows, ${completed.length} completed w/ PnL`
  );
  console.log(
    `Ledger gross profit: $${ledgerGp.toFixed(2)} | gross loss: $${ledgerGl.toFixed(2)} | net: $${(ledgerGp - ledgerGl).toFixed(2)}`
  );

  const { cov, metrics } = await loadCoverage(wallet);
  if (cov) {
    console.log("\nIndexing coverage (wallet_history_coverage):");
    console.log(
      `  provider=${cov.provider} chain=${cov.chainId} from_block=${cov.fromBlock} last_indexed_block=${cov.lastIndexedBlock}`
    );
    console.log(
      `  updated_at=${cov.updatedAt?.toISOString?.() ?? cov.updatedAt}`
    );
  } else {
    console.log("\nNo wallet_history_coverage row.");
  }
  if (metrics) {
    console.log("\nwallet_historical_metrics:");
    console.log(
      `  completed_positions=${metrics.completedPositions} realized_roi=${metrics.realizedRoi} credibility_valid=${metrics.credibilityMetricsValid} history_complete=${metrics.historyComplete}`
    );
    console.log(
      `  through_block=${metrics.throughBlock} calculated_at=${metrics.calculatedAt?.toISOString?.() ?? metrics.calculatedAt}`
    );
    if (metrics.historyIncompleteReasons?.length) {
      console.log(
        `  history_incomplete_reasons: ${JSON.stringify(metrics.historyIncompleteReasons)}`
      );
    }
  }

  const profile = await fetchPolymarketProfilePnl(wallet);
  console.log(
    `\nPolymarket profile/leaderboard PnL: ${profile.pnl != null ? "$" + profile.pnl.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "not found"} (${profile.source})`
  );

  console.log("\n--- Top 10 API closed positions vs ledger (match on assetId) ---\n");

  for (const [i, p] of top10.entries()) {
    const asset = String(p.asset ?? "");
    const apiPnl = Number(p.realizedPnl ?? 0);
    const ledgerForAsset = byAsset.get(asset) ?? [];
    const ledgerCompleted = ledgerForAsset.filter(
      (r) => r.completed && r.realizedPnl != null && !r.exclusionReason
    );
    const ledgerPnlSum = ledgerCompleted.reduce(
      (s, r) => s + (r.realizedPnl ?? 0),
      0
    );
    const ledgerEpisodes = ledgerForAsset.map((r) => ({
      episode: r.lifecycleEpisode,
      completed: r.completed,
      pnl: r.realizedPnl,
      completion: r.completionType,
      opened: tsLabel(r.openedAt),
      completedAt: tsLabel(r.completedAt),
      exclusion: r.exclusionReason,
      buy: r.buyNotional,
      sell: r.sellNotional,
      redeem: r.resolutionPayout,
    }));

    let status: string;
    let hypothesis: string;
    if (ledgerForAsset.length === 0) {
      status = "MISSING_IN_LEDGER";
      hypothesis =
        "No lifecycle row for this asset — outside indexed block range, never ingested, or asset ID / wallet identity mismatch (proxy vs funder).";
    } else if (Math.abs(apiPnl - ledgerPnlSum) > Math.max(1, Math.abs(apiPnl) * 0.05)) {
      status = "PNL_MISMATCH";
      const ratio = ledgerPnlSum !== 0 ? apiPnl / ledgerPnlSum : Infinity;
      if (Math.abs(ratio) > 100 || Math.abs(ratio) < 0.01) {
        hypothesis =
          "Scale/units mismatch likely — API may report position-level cumulative realizedPnl in USDC notional while ledger episodes are split, partial, or cash flows under-counted (merge/split/redeem).";
      } else if (ledgerCompleted.length > 1) {
        hypothesis =
          "Multiple lifecycle episodes for same asset — API aggregates one closed row; ledger sums episodes.";
      } else {
        hypothesis =
          "Accounting divergence — check redemption payout, sell notional, merge/split, or incomplete gamma resolution on held positions.";
      }
    } else {
      status = "MATCH";
      hypothesis = "Within ~5% tolerance.";
    }

    console.log(`${i + 1}. [${status}] ${String(p.title ?? "").slice(0, 70)}`);
    console.log(`   asset=${asset.slice(0, 20)}… conditionId=${p.conditionId}`);
    console.log(`   API realizedPnl=$${apiPnl.toFixed(2)} | API timestamp=${tsLabel(Number(p.timestamp))} | totalBought=$${Number(p.totalBought ?? 0).toFixed(2)}`);
    console.log(
      `   Ledger: ${ledgerForAsset.length} row(s), completed PnL sum=$${ledgerPnlSum.toFixed(2)}`
    );
    if (ledgerEpisodes.length > 0) {
      console.log(`   Ledger episodes: ${JSON.stringify(ledgerEpisodes, null, 0).slice(0, 500)}`);
    }
    console.log(`   Likely cause: ${hypothesis}\n`);
  }

  // Assets in API but not in ledger at all
  const apiAssets = new Set(closed.map((p) => String(p.asset ?? "")));
  const ledgerAssets = new Set(ledgerRows.map((r) => r.assetId));
  let missingCount = 0;
  for (const a of apiAssets) {
    if (a && !ledgerAssets.has(a)) missingCount++;
  }
  console.log(
    `API assets with no ledger row: ${missingCount} / ${apiAssets.size} unique assets in API response`
  );
}

async function main() {
  for (const w of WALLETS) {
    await analyzeWallet(w);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
