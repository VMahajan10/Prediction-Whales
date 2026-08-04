CREATE TABLE IF NOT EXISTS "feed_trades" (
  "trade_id" text PRIMARY KEY NOT NULL,
  "transaction_hash" text,
  "proxy_wallet" text,
  "title" text NOT NULL,
  "stake_amount" double precision NOT NULL,
  "average_ev" double precision NOT NULL,
  "traded_at" timestamp with time zone NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "feed_trades_fallback_idx"
  ON "feed_trades" ("stake_amount", "average_ev", "traded_at" DESC);
