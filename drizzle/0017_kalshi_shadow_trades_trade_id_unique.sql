-- Repair kalshi_shadow_trades so ON CONFLICT (trade_id) DO NOTHING is valid.

CREATE TABLE IF NOT EXISTS "kalshi_shadow_trades" (
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
  "raw_payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kalshi_shadow_trades" ADD COLUMN IF NOT EXISTS "taker_side" text;
--> statement-breakpoint
ALTER TABLE "kalshi_shadow_trades" ADD COLUMN IF NOT EXISTS "taker_outcome_side" text;
--> statement-breakpoint
ALTER TABLE "kalshi_shadow_trades" ADD COLUMN IF NOT EXISTS "taker_book_side" text;
--> statement-breakpoint
ALTER TABLE "kalshi_shadow_trades"
  ALTER COLUMN "size" TYPE double precision USING "size"::double precision,
  ALTER COLUMN "entry_price" TYPE double precision USING "entry_price"::double precision,
  ALTER COLUMN "usd_notional" TYPE double precision USING "usd_notional"::double precision;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kalshi_shadow_trades_trade_id_key"
  ON "kalshi_shadow_trades" ("trade_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.kalshi_shadow_trades'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE "kalshi_shadow_trades"
      ADD CONSTRAINT "kalshi_shadow_trades_pkey"
      PRIMARY KEY USING INDEX "kalshi_shadow_trades_trade_id_key";
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
