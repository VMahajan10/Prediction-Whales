CREATE TABLE IF NOT EXISTS "wallet_ledger_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "wallet_address" text NOT NULL,
  "chain_id" text DEFAULT '137' NOT NULL,
  "dedupe_key" text NOT NULL,
  "tx_hash" text,
  "log_index" text,
  "block_number" bigint,
  "block_timestamp" bigint,
  "contract_address" text,
  "event_type" text NOT NULL,
  "market_condition_id" text,
  "asset_id" text,
  "side" text,
  "shares" double precision,
  "cash_usd" double precision,
  "price" double precision,
  "source" text NOT NULL,
  "ledger_version" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_ledger_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
CREATE INDEX IF NOT EXISTS "wallet_ledger_events_wallet_idx" ON "wallet_ledger_events" ("wallet_address");
CREATE INDEX IF NOT EXISTS "wallet_ledger_events_wallet_block_idx" ON "wallet_ledger_events" ("wallet_address","block_number");

CREATE TABLE IF NOT EXISTS "wallet_position_lifecycles" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "wallet_address" text NOT NULL,
  "condition_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "metric_version" text NOT NULL,
  "completed" boolean DEFAULT false NOT NULL,
  "completion_type" text,
  "capital_at_risk" double precision DEFAULT 0 NOT NULL,
  "buy_notional" double precision DEFAULT 0 NOT NULL,
  "sell_notional" double precision DEFAULT 0 NOT NULL,
  "resolution_payout" double precision DEFAULT 0 NOT NULL,
  "realized_pnl" double precision,
  "realized_roi" double precision,
  "profitable" boolean,
  "outcome_win" boolean,
  "opened_at" bigint,
  "completed_at" bigint,
  "exclusion_reason" text,
  "resolution_source" text,
  "resolution_final" boolean,
  "calculated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_position_lifecycles_position_version_unique" UNIQUE("wallet_address","condition_id","asset_id","metric_version")
);
CREATE INDEX IF NOT EXISTS "wallet_position_lifecycles_wallet_idx" ON "wallet_position_lifecycles" ("wallet_address");

CREATE TABLE IF NOT EXISTS "wallet_historical_metrics" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "wallet_address" text NOT NULL,
  "metric_version" text NOT NULL,
  "completed_positions" integer DEFAULT 0 NOT NULL,
  "median_capital_at_risk" double precision,
  "resolved_volume_usd" double precision,
  "profitable_position_rate" double precision,
  "outcome_win_rate" double precision,
  "realized_roi" double precision,
  "credibility_metrics_valid" boolean DEFAULT false NOT NULL,
  "credibility_decision" boolean DEFAULT false NOT NULL,
  "history_validity" text NOT NULL,
  "history_complete" boolean DEFAULT false NOT NULL,
  "credibility_reasons" jsonb DEFAULT '[]'::jsonb,
  "history_incomplete_reasons" jsonb DEFAULT '[]'::jsonb,
  "through_block" bigint,
  "calculated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_historical_metrics_wallet_version_unique" UNIQUE("wallet_address","metric_version")
);
CREATE INDEX IF NOT EXISTS "wallet_historical_metrics_wallet_idx" ON "wallet_historical_metrics" ("wallet_address");

CREATE TABLE IF NOT EXISTS "wallet_history_coverage" (
  "wallet_address" text PRIMARY KEY NOT NULL,
  "chain_id" text DEFAULT '137' NOT NULL,
  "provider" text NOT NULL,
  "from_block" bigint NOT NULL,
  "last_indexed_block" bigint NOT NULL,
  "last_reconstructed_block" bigint NOT NULL,
  "api_oldest_timestamp" bigint,
  "indexed_oldest_timestamp" bigint,
  "extends_before_api_boundary" boolean DEFAULT false NOT NULL,
  "events_before_api_boundary" integer DEFAULT 0 NOT NULL,
  "event_history_complete" boolean DEFAULT false NOT NULL,
  "identity_complete" boolean DEFAULT false NOT NULL,
  "resolution_complete" boolean DEFAULT false NOT NULL,
  "history_complete" boolean DEFAULT false NOT NULL,
  "history_validity" text NOT NULL,
  "timestamp_coverage_pct" double precision,
  "timestamp_missing_blocks" integer,
  "gamma_resolution_incomplete" boolean DEFAULT false NOT NULL,
  "merge_split_unresolved" boolean DEFAULT false NOT NULL,
  "metric_version" text NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "wallet_shadow_batch_status" (
  "batch_id" text NOT NULL,
  "wallet_address" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "cohort_reason" text,
  "error_message" text,
  "performance" jsonb,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_shadow_batch_status_batch_wallet_unique" UNIQUE("batch_id","wallet_address")
);
CREATE INDEX IF NOT EXISTS "wallet_shadow_batch_status_batch_idx" ON "wallet_shadow_batch_status" ("batch_id");
