#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

const WALLET = "0x18f0faf72b241dc55094ae704987e391c2a23d5e";

async function main() {
  const db = getDb();
  const w = WALLET.toLowerCase();

  const counts = await db.execute(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE canonical_identity IS NULL)::int AS no_canon,
      count(*) FILTER (WHERE dedupe_key LIKE 'chain|137|%')::int AS canon_dedupe,
      count(*) FILTER (WHERE dedupe_key LIKE 'chain|137|%' AND canonical_identity IS NULL)::int AS canon_dedupe_no_identity,
      count(*) FILTER (WHERE dedupe_key LIKE 'chain|137|%' AND tx_hash IS NULL)::int AS canon_dedupe_no_tx,
      count(*) FILTER (WHERE dedupe_key LIKE 'chain|137|%' AND log_index IS NULL)::int AS canon_dedupe_no_log_index
    FROM wallet_ledger_events
    WHERE lower(wallet_address) = ${w}
  `);

  const partial = await db.execute(sql`
    SELECT id, dedupe_key, canonical_identity, tx_hash, log_index, block_number,
           event_type, asset_id, shares, cash_usd, source, block_timestamp
    FROM wallet_ledger_events
    WHERE lower(wallet_address) = ${w}
      AND dedupe_key = ${"chain|137|0x311d50cbc0773e6b693e44855040353e84e9ece2f6d65f9dabc731b9b9027da0|1013"}
    LIMIT 5
  `);

  const globalDedupe = await db.execute(sql`
    SELECT id, wallet_address, dedupe_key, canonical_identity, tx_hash, log_index
    FROM wallet_ledger_events
    WHERE dedupe_key = ${"chain|137|0x311d50cbc0773e6b693e44855040353e84e9ece2f6d65f9dabc731b9b9027da0|1013"}
    LIMIT 10
  `);

  const sampleCanonGap = await db.execute(sql`
    SELECT id, dedupe_key, canonical_identity, tx_hash, log_index, block_number,
           event_type, asset_id, shares, cash_usd
    FROM wallet_ledger_events
    WHERE lower(wallet_address) = ${w}
      AND dedupe_key LIKE 'chain|137|%'
      AND canonical_identity IS NULL
    LIMIT 5
  `);

  console.log(
    JSON.stringify(
      {
        walletCounts: counts.rows?.[0],
        targetByWallet: partial.rows,
        targetGlobal: globalDedupe.rows,
        sampleCanonGapRows: sampleCanonGap.rows,
      },
      null,
      2
    )
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
