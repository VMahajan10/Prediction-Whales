#!/usr/bin/env tsx
import "./preload-env";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { sql } from "drizzle-orm";

const WALLET_1610 = "0x1610db79f753a80207e1d66716be9e91e627ae49";
const WALLET_18F0 = "0x18f0faf72b241dc55094ae704987e391c2a23d5e";
const COLLISION_IDENTITY =
  "chain|137|0x311d50cbc0773e6b693e44855040353e84e9ece2f6d65f9dabc731b9b9027da0|1013";

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }
  const db = getDb();

  const indexes = await db.execute(sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'wallet_ledger_events'
    ORDER BY indexname
  `);

  const constraints = await db.execute(sql`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'wallet_ledger_events'::regclass
    ORDER BY conname
  `);

  const crossWallet = await db.execute(sql`
    SELECT
      canonical_identity,
      count(DISTINCT lower(wallet_address))::int AS wallet_count,
      array_agg(DISTINCT lower(wallet_address) ORDER BY lower(wallet_address)) AS wallets
    FROM wallet_ledger_events
    WHERE canonical_identity IS NOT NULL
    GROUP BY canonical_identity
    HAVING count(DISTINCT lower(wallet_address)) > 1
    ORDER BY count(DISTINCT lower(wallet_address)) DESC, canonical_identity
    LIMIT 20
  `);

  const crossWalletStats = await db.execute(sql`
    SELECT
      count(*)::int AS shared_identity_count,
      max(wallet_count)::int AS max_wallets_per_identity
    FROM (
      SELECT canonical_identity, count(DISTINCT lower(wallet_address)) AS wallet_count
      FROM wallet_ledger_events
      WHERE canonical_identity IS NOT NULL
      GROUP BY canonical_identity
      HAVING count(DISTINCT lower(wallet_address)) > 1
    ) t
  `);

  const collisionRows = await db.execute(sql`
    SELECT id, lower(wallet_address) AS wallet_address, canonical_identity, dedupe_key,
           tx_hash, log_index, event_type, shares, cash_usd
    FROM wallet_ledger_events
    WHERE dedupe_key = ${COLLISION_IDENTITY}
       OR canonical_identity = ${COLLISION_IDENTITY}
    ORDER BY wallet_address, id
  `);

  const batch1Wallets = [
    "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66",
    WALLET_1610,
    WALLET_18F0,
    "0x5268527977f700f9bf9b6d5cd843859e4e70135d",
    "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
    "0x25db6ca5935ae858a5c1f2dcd5c62939805328de",
    "0x0346afae2603313d2bbee96b628536c8cbe352a5",
    "0x165136c0307328458726cd65681d3513b610470f",
  ];

  let batch1PolicyA: unknown[] = [];
  try {
    const policyRows = await db.execute(sql`
      SELECT lower(wallet_address) AS wallet,
             policy_a_verdict AS policy_a_decision,
             policy_a_unknown_reason,
             completed_positions,
             has_valid_durable_coverage,
             history_validity,
             updated_at
      FROM wallet_shadow_results
      WHERE lower(wallet_address) = ANY(ARRAY[${sql.join(
        batch1Wallets.map((w) => sql`${w.toLowerCase()}`),
        sql`, `
      )}])
      ORDER BY wallet_address
    `);
    batch1PolicyA = policyRows.rows;
  } catch {
    batch1PolicyA = [];
  }

  console.log(
    JSON.stringify(
      {
        indexes: indexes.rows,
        constraints: constraints.rows,
        crossWalletSharedIdentity: crossWalletStats.rows[0],
        crossWalletSamples: crossWallet.rows,
        collisionRows: collisionRows.rows,
        batch1PolicyA,
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
