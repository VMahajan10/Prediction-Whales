import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { normalizeWalletAddress } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  countPersistedWalletEvents,
  loadPersistedWalletEventsPaginated,
} from "@/lib/walletLedger/indexed/store/persistedEventLoader";

const wallet = process.argv[2] ?? "0x7e5972bfc25819775ee5a9d4f191919375487b8b";
const applyIndex = process.argv.includes("--apply-index");

async function explainKeysetQuery(
  walletAddress: string,
  label: string,
  cursor?: { blockNumber: number; id: number }
): Promise<unknown> {
  const db = getDb();

  const result = await db.execute(sql`
    EXPLAIN (FORMAT JSON)
    SELECT
      id, wallet_address, dedupe_key, tx_hash, block_number, block_timestamp,
      event_type, market_condition_id, asset_id, shares, cash_usd, price, source
    FROM wallet_ledger_events
    WHERE wallet_address = ${walletAddress}
      AND (
        COALESCE(block_number, 0) > ${cursor?.blockNumber ?? -1}
        OR (
          COALESCE(block_number, 0) = ${cursor?.blockNumber ?? -1}
          AND id > ${cursor?.id ?? -1}
        )
      )
    ORDER BY COALESCE(block_number, 0), id
    LIMIT 5000
  `);
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
  const plan = rows[0] ?? result;
  return { label, plan };
}

async function main(): Promise<void> {
  const walletAddress = normalizeWalletAddress(wallet);
  const db = getDb();

  if (applyIndex) {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS wallet_ledger_events_wallet_block_id_idx
      ON wallet_ledger_events (wallet_address, block_number, id)
    `);
    console.log("applied index wallet_ledger_events_wallet_block_id_idx");
  }

  const before = await explainKeysetQuery(walletAddress, "keyset_page_first");
  const dbCount = await countPersistedWalletEvents(walletAddress);

  const heapBeforeMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const started = Date.now();
  const { events, stats } = await loadPersistedWalletEventsPaginated(
    db,
    walletAddress
  );
  const elapsedMs = Date.now() - started;
  const heapAfterMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  console.log(
    JSON.stringify(
      {
        wallet: walletAddress,
        dbCount,
        loadedCount: events.length,
        countMatch: dbCount === events.length,
        uniqueDedupeKeys: stats.uniqueDedupeKeys,
        dedupeMatch: stats.uniqueDedupeKeys === events.length,
        explainBefore: before,
        stats,
        elapsedMs,
        heapBeforeMb,
        heapAfterMb,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("failed", error instanceof Error ? error.message : error);
  process.exit(1);
});
