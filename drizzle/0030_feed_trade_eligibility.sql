CREATE TABLE IF NOT EXISTS "feed_trade_eligibility" (
  "trade_id" text NOT NULL,
  "product_feed_gate_version" text NOT NULL,
  "evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "traded_at" timestamp with time zone NOT NULL,
  "wallet_address" text,
  "attribution_resolver_version" text NOT NULL,
  "trade_stake_pass" boolean NOT NULL,
  "trade_ev_pass" boolean NOT NULL,
  "wallet_gate_pass" boolean NOT NULL,
  "final_eligible" boolean NOT NULL,
  "block_reason" text,
  "stake_usd" double precision NOT NULL,
  "trade_ev_pct" double precision,
  "historical_volume_usd" double precision,
  "historical_volume_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "feed_trade_eligibility_pkey" PRIMARY KEY ("trade_id", "product_feed_gate_version")
);

CREATE INDEX IF NOT EXISTS "feed_trade_eligibility_traded_at_idx"
  ON "feed_trade_eligibility" ("traded_at" DESC);

CREATE INDEX IF NOT EXISTS "feed_trade_eligibility_gate_eligible_idx"
  ON "feed_trade_eligibility" ("product_feed_gate_version", "final_eligible", "traded_at" DESC);
