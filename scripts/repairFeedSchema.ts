/**
 * Idempotent DDL repair for feed tables missing from push-provisioned Neon DBs.
 * Safe to run multiple times — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 *
 * `npm run db:migrate` cannot apply 0014/0015/0019 when they are absent from the
 * drizzle journal on a DB that was originally provisioned via `db:push`.
 */
import { neon } from "@neondatabase/serverless";
import { loadEnvFiles } from "./loadEnv";

loadEnvFiles();

const STATEMENTS: Array<[string, string]> = [
  [
    "create kalshi_shadow_trades",
    `CREATE TABLE IF NOT EXISTS "kalshi_shadow_trades" (
       "trade_id" text PRIMARY KEY NOT NULL,
       "ticker" text NOT NULL,
       "size" double precision NOT NULL,
       "traded_at" timestamp with time zone NOT NULL,
       "entry_price" double precision NOT NULL,
       "taker_side" text,
       "taker_outcome_side" text,
       "taker_book_side" text,
       "is_block_trade" boolean DEFAULT false NOT NULL,
       "usd_notional" double precision,
       "category" text,
       "raw_payload" jsonb,
       "created_at" timestamp with time zone DEFAULT now() NOT NULL
     )`,
  ],
  [
    "kalshi ticker idx",
    `CREATE INDEX IF NOT EXISTS "kalshi_shadow_trades_ticker_traded_at_idx"
       ON "kalshi_shadow_trades" ("ticker", "traded_at" DESC)`,
  ],
  [
    "create feed_trades",
    `CREATE TABLE IF NOT EXISTS "feed_trades" (
       "trade_id" text PRIMARY KEY NOT NULL,
       "transaction_hash" text,
       "proxy_wallet" text,
       "title" text NOT NULL,
       "stake_amount" double precision NOT NULL,
       "average_ev" double precision NOT NULL,
       "category" text,
       "traded_at" timestamp with time zone NOT NULL,
       "payload" jsonb NOT NULL,
       "created_at" timestamp with time zone DEFAULT now() NOT NULL,
       "updated_at" timestamp with time zone DEFAULT now() NOT NULL
     )`,
  ],
  [
    "feed_trades fallback idx",
    `CREATE INDEX IF NOT EXISTS "feed_trades_fallback_idx"
       ON "feed_trades" ("stake_amount", "average_ev", "traded_at" DESC)`,
  ],
  [
    "feed_trades category column",
    `ALTER TABLE "feed_trades" ADD COLUMN IF NOT EXISTS "category" text`,
  ],
  [
    "feed_trades category idx",
    `CREATE INDEX IF NOT EXISTS "feed_trades_category_traded_at_idx"
       ON "feed_trades" ("category", "traded_at" DESC)`,
  ],
  [
    "kalshi direction columns",
    `ALTER TABLE "kalshi_shadow_trades" ADD COLUMN IF NOT EXISTS "taker_side" text`,
  ],
  [
    "kalshi taker_outcome_side",
    `ALTER TABLE "kalshi_shadow_trades" ADD COLUMN IF NOT EXISTS "taker_outcome_side" text`,
  ],
  [
    "kalshi taker_book_side",
    `ALTER TABLE "kalshi_shadow_trades" ADD COLUMN IF NOT EXISTS "taker_book_side" text`,
  ],
  [
    "kalshi category column",
    `ALTER TABLE "kalshi_shadow_trades" ADD COLUMN IF NOT EXISTS "category" text`,
  ],
  [
    "kalshi category idx",
    `CREATE INDEX IF NOT EXISTS "kalshi_shadow_trades_category_traded_at_idx"
       ON "kalshi_shadow_trades" ("category", "traded_at" DESC)`,
  ],
  [
    "kalshi stored-EV idx",
    `CREATE INDEX IF NOT EXISTS "kalshi_shadow_trades_ev_traded_at_idx"
       ON "kalshi_shadow_trades" ("usd_notional", "traded_at" DESC)
       WHERE ("raw_payload" ->> 'netEvPercent') IS NOT NULL`,
  ],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  const sql = neon(process.env.DATABASE_URL);

  for (const [label, statement] of STATEMENTS) {
    await sql.query(statement);
    console.log(`✓ ${label}`);
  }

  console.log("Feed schema repair complete.");
}

main().catch((error) => {
  console.error("✗ schema repair failed", error);
  process.exit(1);
});
