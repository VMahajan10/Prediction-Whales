import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletLedgerEvents } from "@/lib/crossmarket/store/schema";
import { normalizeWalletAddress } from "@/lib/walletLedger/indexed/store/persistWalletHistory";

const wallet = process.argv[2] ?? "0x7e5972bfc25819775ee5a9d4f191919375487b8b";
const applyIndex = process.argv.includes("--apply-index");

async function explain(label: string, indexName: string | null): Promise<void> {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const blockSort = sql`COALESCE(${walletLedgerEvents.blockNumber}, 0)`;

  const result = await db.execute(sql`
    EXPLAIN (FORMAT JSON, BUFFERS)
    SELECT
      id, wallet_address, dedupe_key, tx_hash, block_number, block_timestamp,
      event_type, market_condition_id, asset_id, shares, cash_usd, price, source
    FROM wallet_ledger_events
    WHERE wallet_address = ${walletAddress}
      AND (block_number, id) > (0, 0)
    ORDER BY block_number, id
    LIMIT 5000
  `);

  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
  const plan = rows[0] ?? result;

  console.log(
    JSON.stringify(
      {
        label,
        indexName,
        plan,
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const db = getDb();
  if (applyIndex) {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS wallet_ledger_events_wallet_block_id_idx
        ON wallet_ledger_events (wallet_address, block_number, id)
    `);
    console.log("applied wallet_ledger_events_wallet_block_id_idx");
  }

  await explain("keyset_with_existing_indexes", null);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
