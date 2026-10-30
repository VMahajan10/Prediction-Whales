#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

async function main() {
  const db = getDb();
  const r = await db!.execute(sql`
    SELECT conname, pg_get_constraintdef(oid) as def
    FROM pg_constraint
    WHERE conrelid = 'wallet_position_lifecycles'::regclass AND contype = 'u'
  `);
  console.log(JSON.stringify(r.rows, null, 2));
}

void main();
