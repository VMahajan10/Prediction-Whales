CREATE TABLE IF NOT EXISTS "feed_daily_metrics" (
  "day_key" text NOT NULL,
  "venue" text NOT NULL,
  "trades_detected" integer DEFAULT 0 NOT NULL,
  "gate_passed_trades" integer DEFAULT 0 NOT NULL,
  "distinct_whales" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "feed_daily_metrics_day_venue_unique" UNIQUE("day_key","venue")
);

CREATE INDEX IF NOT EXISTS "feed_daily_metrics_day_key_idx"
  ON "feed_daily_metrics" ("day_key" DESC);

CREATE TABLE IF NOT EXISTS "feed_daily_qualified_whales" (
  "day_key" text NOT NULL,
  "venue" text NOT NULL,
  "wallet" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "feed_daily_qualified_whales_day_venue_wallet_unique" UNIQUE("day_key","venue","wallet")
);

CREATE INDEX IF NOT EXISTS "feed_daily_qualified_whales_day_venue_idx"
  ON "feed_daily_qualified_whales" ("day_key","venue");
