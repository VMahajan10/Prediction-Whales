import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local" });
config({ path: ".env" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not configured");
  process.exit(1);
}

const sql = neon(url);

async function main() {
  const tables = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;
  console.log("public tables:", tables.map((row) => row.table_name).join(", "));

  const keyTables = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('kalshi_shadow_trades', 'feed_trades', '__drizzle_migrations')
    ORDER BY table_name
  `;
  console.log(
    "key tables:",
    keyTables.map((row) => row.table_name).join(", ") || "(none)"
  );

  const categoryCol = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'feed_trades'
      AND column_name = 'category'
  `;
  console.log("feed_trades.category:", categoryCol.length > 0 ? "yes" : "no");

  try {
    const applied = await sql`
      SELECT id, hash, created_at
      FROM __drizzle_migrations
      ORDER BY created_at
    `;
    console.log("applied migrations:", applied.length);
    for (const row of applied) {
      console.log(`  ${row.id}: ${String(row.hash).slice(0, 12)}...`);
    }
  } catch (error) {
    console.log(
      "no __drizzle_migrations:",
      error instanceof Error ? error.message : error
    );
  }
}

main().catch((error) => {
  console.error("diagnostic failed:", error);
  process.exit(1);
});
