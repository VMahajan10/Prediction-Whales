CREATE TABLE IF NOT EXISTS "kalshi_shadow_trades" (
  "trade_id" text PRIMARY KEY NOT NULL,
  "ticker" text NOT NULL,
  "size" real NOT NULL,
  "traded_at" timestamp with time zone NOT NULL,
  "entry_price" real NOT NULL,
  "taker_side" text,
  "taker_outcome_side" text,
  "taker_book_side" text,
  "is_block_trade" boolean DEFAULT false NOT NULL,
  "usd_notional" real,
  "raw_payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kalshi_shadow_trades_ticker_traded_at_idx" ON "kalshi_shadow_trades" ("ticker", "traded_at" DESC);
