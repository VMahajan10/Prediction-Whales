#!/usr/bin/env tsx
/**
 * Read-only d91 identity trace — no DB writes, no hydration.
 */
import "../tests/preload-env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletLedgerEvents,
} from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  fetchPositionsSnapshot,
  probeWalletHistoryCounts,
} from "@/lib/walletLedger/fetchers";
import { resolvePolymarketHistoryIdentity } from "@/lib/walletLedger/identity";
import { discoverOnChainWalletIdentity } from "@/lib/walletLedger/onchain/identity";
import { resolveWalletForTrade } from "@/lib/resolveWhaleWallet";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import { decodeLog, orderFilledInvolvesWallet } from "@/lib/walletLedger/onchain/decode";

const WALLET = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";
const PRODUCTION_TX =
  "0x59c3aad53bf226ee382efb4b33bbaa4b43563d4298450011e06c9837e891232a";

async function main(): Promise<void> {
  const db = getDb();
  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, WALLET),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    );
  const [coverage] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, WALLET));

  const feedStats = await db.execute<{
    feed_rows: number;
    distinct_tx: number;
  }>(sql`
    SELECT
      count(*)::int AS feed_rows,
      count(distinct trade_id)::int AS distinct_tx
    FROM feed_trades
    WHERE lower(proxy_wallet) = ${WALLET}
  `);

  const txResolution = await resolveWalletForTrade(PRODUCTION_TX, {});
  const onchain = await discoverOnChainWalletIdentity({
    wallet: WALLET,
    transactionHash: PRODUCTION_TX,
  });
  const positions = await fetchPositionsSnapshot(WALLET);
  const proxyWallets = [
    ...new Set(
      positions
        .map((p) => p.proxyWallet?.trim().toLowerCase())
        .filter((p): p is string => Boolean(p))
    ),
  ];

  const historyWithTx = await resolvePolymarketHistoryIdentity({
    wallet: WALLET,
    transactionHash: PRODUCTION_TX,
  });
  const historyWithoutTx = await resolvePolymarketHistoryIdentity({
    wallet: WALLET,
  });
  const onchainRelated =
    onchain.relatedAddresses?.map((a) => a.toLowerCase()) ?? [];
  const probeAddresses = new Set<string>([
    WALLET,
    ...proxyWallets,
    ...onchainRelated,
  ]);
  if (txResolution.wallet) {
    probeAddresses.add(txResolution.wallet.toLowerCase());
  }
  const candidateProbes: Array<{
    wallet: string;
    activityCount: number;
    tradeCount: number;
    positionsCount: number;
    activityTruncated?: boolean;
    tradeTruncated?: boolean;
    persistedEventRows: number;
    persistedCredibilityDecision: boolean | null;
    persistedHistoryValidity: string | null;
  }> = [];
  for (const wallet of probeAddresses) {
    const probe = await probeWalletHistoryCounts(wallet);
    const [row] = await db
      .select({
        credibilityDecision: walletHistoricalMetrics.credibilityDecision,
        historyValidity: walletHistoricalMetrics.historyValidity,
      })
      .from(walletHistoricalMetrics)
      .where(
        and(
          eq(walletHistoricalMetrics.walletAddress, wallet),
          eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
        )
      );
    const ev = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM wallet_ledger_events
      WHERE lower(wallet_address) = ${wallet}
    `);
    candidateProbes.push({
      wallet,
      ...probe,
      persistedEventRows: ev.rows[0]?.n ?? 0,
      persistedCredibilityDecision: row?.credibilityDecision ?? null,
      persistedHistoryValidity: row?.historyValidity ?? null,
    });
  }

  const report = {
    mode: "d91_identity_trace_readonly",
    wallet: WALLET,
    productionTx: PRODUCTION_TX,
    persisted: {
      metrics: metrics
        ? {
            credibilityDecision: metrics.credibilityDecision,
            credibilityMetricsValid: metrics.credibilityMetricsValid,
            historyValidity: metrics.historyValidity,
            historyComplete: metrics.historyComplete,
            completedPositions: metrics.completedPositions,
            historyIncompleteReasons: metrics.historyIncompleteReasons,
            credibilityReasons: metrics.credibilityReasons,
            calculatedAt: metrics.calculatedAt?.toISOString(),
          }
        : null,
      coverage: coverage
        ? {
            identityComplete: coverage.identityComplete,
            eventHistoryComplete: coverage.eventHistoryComplete,
            gammaResolutionIncomplete: coverage.gammaResolutionIncomplete,
            historyValidity: coverage.historyValidity,
            lastIndexedBlock: coverage.lastIndexedBlock,
            timestampCoveragePct: coverage.timestampCoveragePct,
          }
        : null,
    },
    feed: feedStats.rows[0] ?? null,
    txResolution,
    positionsSnapshot: {
      rowCount: positions.length,
      proxyWallets,
      distinctConditionIds: [
        ...new Set(positions.map((p) => p.conditionId).filter(Boolean)),
      ].length,
    },
    resolvePolymarketHistoryIdentity: {
      withProductionTx: historyWithTx,
      withoutTx: historyWithoutTx,
    },
    discoverOnChainWalletIdentity: onchain,
    candidateProbes,
  };

  const feedTxSample = await db.execute<{
    trade_id: string;
    transaction_hash: string;
  }>(sql`
    SELECT trade_id, transaction_hash
    FROM feed_trades
    WHERE lower(proxy_wallet) = ${WALLET}
      AND transaction_hash IS NOT NULL
    ORDER BY traded_at DESC
    LIMIT 5
  `);

  const rpc = new PolygonRpcClient();
  const txSamples = [];
  for (const row of feedTxSample.rows) {
    const hash = row.transaction_hash;
    const resolved = await resolveWalletForTrade(hash, {});
    const receipt = await rpc.getTransactionReceipt(hash);
    const fills: Array<{
      maker: string;
      taker: string;
      involvesD91: boolean;
    }> = [];
    for (const log of receipt?.logs ?? []) {
      const parsed = decodeLog(log);
      if (parsed.type === "order_filled") {
        fills.push({
          maker: parsed.event.maker,
          taker: parsed.event.taker,
          involvesD91: orderFilledInvolvesWallet(parsed.event, WALLET),
        });
      }
    }
    txSamples.push({
      tradeId: row.trade_id,
      hash,
      resolved,
      orderFilled: fills,
    });
  }

  console.log(
    JSON.stringify({ ...report, feedTxSamples: txSamples }, null, 2)
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
