#!/usr/bin/env tsx
import "../tests/preload-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

const sqlPath = join(
  process.cwd(),
  "drizzle/0035_wallet_api_positions.sql"
);
const raw = readFileSync(sqlPath, "utf8");
const statements = raw
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith("--"));

async function main() {
  const db = getDb();
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
    console.log("ok:", stmt.slice(0, 60).replace(/\s+/g, " "));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
