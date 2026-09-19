#!/usr/bin/env tsx
import "../tests/preload-env";
import { fetchTradeHistory } from "@/lib/walletLedger/fetchers";
import {
  oldestTradeRowsForVerification,
  verifyOldestTradeTxHashes,
} from "@/lib/walletLedger/indexed/adaptiveStartBlock";

const WALLET = "0xd27cc742d023d06ef633a4c880cf1ff1836ec081";

async function main() {
  const trades = await fetchTradeHistory(WALLET);
  const oldest = oldestTradeRowsForVerification(trades.rows, 10);
  const evidence = await verifyOldestTradeTxHashes(trades.rows, 10);
  console.log(
    JSON.stringify(
      {
        wallet: WALLET,
        tradesRowCount: trades.rows.length,
        tradesTruncated: trades.truncated,
        oldestTradeSamples: oldest.map((row) => ({
          timestamp: row.timestamp,
          iso:
            row.timestamp != null
              ? new Date(Number(row.timestamp) * 1000).toISOString()
              : null,
          transactionHash: row.transactionHash,
        })),
        verification: evidence,
        verifiedCount: evidence.filter((row) => row.verifiedOnPolygon).length,
        unverifiedCount: evidence.filter(
          (row) => !row.verifiedOnPolygon
        ).length,
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
