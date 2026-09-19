import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

async function main(): Promise<void> {
  const db = getDb();
  const batchId = process.argv[2] ?? "phase2e1-full50-v2";
  const rows = await db.execute(sql`
    SELECT status, count(*)::int AS c
    FROM wallet_shadow_batch_status
    WHERE batch_id = ${batchId}
    GROUP BY status
    ORDER BY status
  `);
  console.log(`\n=== ${batchId} ===`);
  console.log(JSON.stringify(rows.rows, null, 2));
  const detail = await db.execute(sql`
    SELECT wallet_address, status, error_message
    FROM wallet_shadow_batch_status
    WHERE batch_id = ${batchId}
    ORDER BY wallet_address
  `);
  console.log("wallets:", JSON.stringify(detail.rows, null, 2));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
