#!/usr/bin/env tsx
/**
 * Backfill canonical_identity on the 1610/18f0 shared-fill rows after wallet-scoped unique migration.
 */
import "./preload-env";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { sql } from "drizzle-orm";

const COLLISION_IDENTITY =
  "chain|137|0x311d50cbc0773e6b693e44855040353e84e9ece2f6d65f9dabc731b9b9027da0|1013";

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }
  const db = getDb();

  const before = await db.execute(sql`
    SELECT id, lower(wallet_address) AS wallet, canonical_identity, event_type, shares, cash_usd
    FROM wallet_ledger_events
    WHERE dedupe_key = ${COLLISION_IDENTITY}
    ORDER BY wallet_address
  `);

  const updated = await db.execute(sql`
    UPDATE wallet_ledger_events
    SET canonical_identity = dedupe_key, updated_at = now()
    WHERE dedupe_key = ${COLLISION_IDENTITY}
      AND canonical_identity IS NULL
      AND tx_hash IS NOT NULL
      AND log_index IS NOT NULL
  `);

  const after = await db.execute(sql`
    SELECT id, lower(wallet_address) AS wallet, canonical_identity, event_type, shares, cash_usd
    FROM wallet_ledger_events
    WHERE dedupe_key = ${COLLISION_IDENTITY}
       OR canonical_identity = ${COLLISION_IDENTITY}
    ORDER BY wallet_address
  `);

  const dupes = await db.execute(sql`
    SELECT wallet_address, canonical_identity, count(*)::int AS c
    FROM wallet_ledger_events
    WHERE canonical_identity IS NOT NULL
    GROUP BY wallet_address, canonical_identity
    HAVING count(*) > 1
    LIMIT 5
  `);

  console.log(
    JSON.stringify(
      {
        before: before.rows,
        rowsUpdated: Number(updated.rowCount ?? 0),
        after: after.rows,
        sameWalletCanonicalDuplicates: dupes.rows,
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
