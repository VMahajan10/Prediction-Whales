CREATE TABLE IF NOT EXISTS "policy_a_shadow_trade_observations" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "trade_id" text NOT NULL,
  "wallet_address" text NOT NULL,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "traded_at" timestamp with time zone,
  "source" text DEFAULT 'polymarket_feed' NOT NULL,
  "stake_usd" double precision,
  "trade_ev_percent" double precision,
  "translation_valid" boolean,
  "production_wallet_pass" boolean,
  "production_hydration_state" text,
  "indexed_data_validity_decision" text,
  "historical_performance_decision" text,
  "historical_performance_failure_reasons" jsonb DEFAULT '[]'::jsonb,
  "historical_performance_policy_version" text,
  "feed_visible" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "policy_a_shadow_observed_at_idx"
  ON "policy_a_shadow_trade_observations" ("observed_at" DESC);
CREATE INDEX IF NOT EXISTS "policy_a_shadow_wallet_idx"
  ON "policy_a_shadow_trade_observations" ("wallet_address");
CREATE UNIQUE INDEX IF NOT EXISTS "policy_a_shadow_trade_source_unique"
  ON "policy_a_shadow_trade_observations" ("trade_id", "source");

CREATE TABLE IF NOT EXISTS "policy_a_coverage_daily_metrics" (
  "day_key" text NOT NULL,
  "venue" text DEFAULT 'polymarket' NOT NULL,
  "trades_detected" integer DEFAULT 0 NOT NULL,
  "trade_gate_qualified" integer DEFAULT 0 NOT NULL,
  "production_wallet_qualified" integer DEFAULT 0 NOT NULL,
  "policy_a_pass" integer DEFAULT 0 NOT NULL,
  "policy_a_fail" integer DEFAULT 0 NOT NULL,
  "policy_a_unknown" integer DEFAULT 0 NOT NULL,
  "feed_visible" integer DEFAULT 0 NOT NULL,
  "feed_would_remain_policy_a" integer DEFAULT 0 NOT NULL,
  "feed_would_fail_policy_a" integer DEFAULT 0 NOT NULL,
  "feed_unknown_policy_a" integer DEFAULT 0 NOT NULL,
  "distinct_production_wallets" integer DEFAULT 0 NOT NULL,
  "distinct_policy_a_pass_wallets" integer DEFAULT 0 NOT NULL,
  "distinct_policy_a_fail_wallets" integer DEFAULT 0 NOT NULL,
  "distinct_policy_a_unknown_wallets" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "policy_a_coverage_daily_metrics_pkey" PRIMARY KEY ("day_key", "venue")
);

CREATE INDEX IF NOT EXISTS "policy_a_coverage_daily_day_idx"
  ON "policy_a_coverage_daily_metrics" ("day_key" DESC);

CREATE TABLE IF NOT EXISTS "policy_a_production_wallet_hydration" (
  "wallet_address" text PRIMARY KEY NOT NULL,
  "priority_tier" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "last_error" text,
  "completed_positions" integer,
  "history_validity" text,
  "policy_a_decision" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "policy_a_hydration_status_tier_idx"
  ON "policy_a_production_wallet_hydration" ("status", "priority_tier");
