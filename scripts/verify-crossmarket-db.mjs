/**
 * One-off schema verification after drizzle migrate.
 * Usage: node scripts/verify-crossmarket-db.mjs
 */
import { neon } from "@neondatabase/serverless";
import fs from "node:fs";

function loadDatabaseUrl() {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  const local = fs.readFileSync(".env.local", "utf8");
  const line = local.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not found");
  return line.slice("DATABASE_URL=".length);
}

const sql = neon(loadDatabaseUrl());

const extensions = await sql`
  SELECT extname, extversion
  FROM pg_extension
  WHERE extname = 'vector'
`;

const tables = await sql`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name
`;

const migrations = await sql`
  SELECT id, hash, created_at
  FROM drizzle.__drizzle_migrations
  ORDER BY created_at
`;

const hnswIndexes = await sql`
  SELECT indexname, tablename, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexdef ILIKE '%hnsw%'
  ORDER BY tablename, indexname
`;

const expectedTables = [
  "markets_raw",
  "markets_normalized",
  "market_matches",
  "ev_snapshots",
  "sync_runs",
];

const tableNames = tables.map((r) => r.table_name);
const missing = expectedTables.filter((t) => !tableNames.includes(t));

console.log("=== Cross-Market DB verification ===\n");
console.log("pgvector extension:", extensions.length ? extensions[0] : "NOT FOUND");
console.log("\nPublic tables:", tableNames.join(", "));
console.log("Missing expected tables:", missing.length ? missing.join(", ") : "(none)");
console.log("\nApplied migrations:", migrations.length);
for (const m of migrations) {
  console.log(`  - ${m.id} @ ${m.created_at}`);
}
console.log("\nHNSW indexes:");
for (const idx of hnswIndexes) {
  console.log(`  - ${idx.tablename}.${idx.indexname}`);
  console.log(`    ${idx.indexdef}`);
}

if (!extensions.length || missing.length || !hnswIndexes.length) {
  process.exit(1);
}
