#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";

const W3 = "0xad529df14c293d77984a0137990a1441b25211ac";

async function main() {
  if (!isDatabaseEnabled()) return;
  const db = getDb();
  for (const cat of ["NFL", "POLITICS"]) {
    const r = await db.execute(sql`
      SELECT title, category_label, status, realized_pnl
      FROM wallet_api_positions
      WHERE lower(wallet_address) = lower(${W3})
        AND category_label = ${cat}
      ORDER BY abs(realized_pnl) DESC
      LIMIT 10
    `);
    console.log(`\n### ${cat} (${r.rows.length} shown)`);
    for (const row of r.rows as {
      title: string;
      category_label: string;
    }[]) {
      console.log(`  [${row.category_label}] ${row.title}`);
    }
  }
}

main();
