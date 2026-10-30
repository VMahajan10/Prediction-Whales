#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";

const WALLET = process.env.WALLET ?? "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";

async function main() {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const db = getDb();
  const sample = await db.execute(sql`
    select dedupe_key from wallet_ledger_events
    where wallet_address = ${WALLET.toLowerCase()}
      and block_timestamp is null
    limit 3
  `);
  const keys = (sample.rows as { dedupe_key: string }[]).map((r) => r.dedupe_key);
  if (keys.length === 0) {
    console.log("No rows with null block_timestamp for wallet");
    return;
  }
  const explain = await db.execute(sql`
    EXPLAIN (FORMAT TEXT)
    UPDATE wallet_ledger_events AS w
    SET block_timestamp = patch_data.block_timestamp, updated_at = NOW()
    FROM (
      VALUES (${keys[0]}::text, 1700000000::bigint)
    ) AS patch_data(dedupe_key, block_timestamp)
    WHERE w.wallet_address = ${WALLET.toLowerCase()}
      AND w.dedupe_key = patch_data.dedupe_key
      AND w.block_timestamp IS NULL
  `);
  console.log(
    (explain.rows as { "QUERY PLAN": string }[])
      .map((r) => r["QUERY PLAN"])
      .join("\n")
  );
}

void main();
