#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";

const statements = [
  `ALTER TABLE wallet_api_positions ADD COLUMN IF NOT EXISTS current_price double precision`,
  `ALTER TABLE wallet_api_sync_state ADD COLUMN IF NOT EXISTS positions_sum_reconciliation double precision`,
  `ALTER TABLE wallet_api_sync_state ADD COLUMN IF NOT EXISTS full_sync_status text NOT NULL DEFAULT 'idle'`,
  `ALTER TABLE wallet_api_sync_state ADD COLUMN IF NOT EXISTS closed_positions_cached integer NOT NULL DEFAULT 0`,
];

async function main() {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const db = getDb();
  for (const s of statements) {
    console.log("Running:", s.slice(0, 60) + "…");
    await db.execute(sql.raw(s));
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
