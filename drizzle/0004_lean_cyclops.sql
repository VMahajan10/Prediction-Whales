CREATE TABLE "ev_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"polymarket_id" text NOT NULL,
	"polymarket_prob" numeric NOT NULL,
	"consensus_prob" numeric NOT NULL,
	"gap" numeric NOT NULL,
	"signal" text NOT NULL,
	"contributors" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_mappings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"polymarket_token_id" text NOT NULL,
	"polymarket_condition_id" text,
	"kalshi_ticker" text NOT NULL,
	"confidence_score" real NOT NULL,
	"match_method" text NOT NULL,
	"embedding_similarity" real,
	"pm_outcome" text,
	"kalshi_outcome" text,
	"orientation" text DEFAULT 'same' NOT NULL,
	"market_match_id" bigint,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_mappings_pm_token_kalshi_unique" UNIQUE("polymarket_token_id","kalshi_ticker")
);
--> statement-breakpoint
CREATE TABLE "market_matches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"polymarket_id" text NOT NULL,
	"normalized_id" bigint NOT NULL,
	"platform" text NOT NULL,
	"pm_outcome" text NOT NULL,
	"contributor_outcome" text NOT NULL,
	"orientation" text NOT NULL,
	"confidence_tier" text NOT NULL,
	"score" real NOT NULL,
	"match_method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "market_matches_polymarket_normalized_unique" UNIQUE("polymarket_id","normalized_id")
);
--> statement-breakpoint
CREATE TABLE "markets_normalized" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"raw_id" bigint NOT NULL,
	"canonical_title" text NOT NULL,
	"entities" text[] DEFAULT '{}'::text[] NOT NULL,
	"resolution_kind" text,
	"norm_method" text NOT NULL,
	"embedding" vector(1536),
	"normalized_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets_raw" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"tier" smallint NOT NULL,
	"title" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"yes_price" numeric,
	"volume" numeric,
	"url" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_raw_platform_external_id_unique" UNIQUE("platform","external_id")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"counts" jsonb,
	"error" text,
	"per_platform" jsonb
);
--> statement-breakpoint
CREATE TABLE "trader_ev_analytics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"platform" text NOT NULL,
	"period" text NOT NULL,
	"average_ev" numeric,
	"total_portfolio_ev" numeric,
	"trade_count" bigint DEFAULT 0 NOT NULL,
	"closed_trade_count" bigint DEFAULT 0 NOT NULL,
	"breakdown" jsonb,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trader_ev_analytics_wallet_platform_period_unique" UNIQUE("wallet","platform","period")
);
--> statement-breakpoint
CREATE TABLE "true_probabilities" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mapping_id" bigint,
	"polymarket_token_id" text NOT NULL,
	"kalshi_ticker" text,
	"p_true" numeric NOT NULL,
	"source_score" numeric,
	"variance" numeric,
	"source_type" text NOT NULL,
	"model_version" text,
	"contributors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whale_registry" (
	"wallet_address" text PRIMARY KEY NOT NULL,
	"pseudonym" text NOT NULL,
	"resolved_bets_count" integer DEFAULT 0 NOT NULL,
	"avg_ev" real DEFAULT 0 NOT NULL,
	"win_rate" real DEFAULT 0 NOT NULL,
	"avg_stake_notional" real DEFAULT 0 NOT NULL,
	"posted_count_30d" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_post_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trade_id" text NOT NULL,
	"gate_passed" boolean NOT NULL,
	"rejection_reason" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_post_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"trade_id" text NOT NULL,
	"template_family" text NOT NULL,
	"variant_id" text,
	"ev_gloss" text,
	"copy_text" text NOT NULL,
	"market_slug" text NOT NULL,
	"side" text NOT NULL,
	"entry_cents" real NOT NULL,
	"now_cents" real NOT NULL,
	"stake_notional" real NOT NULL,
	"status" text DEFAULT 'PENDING_REVIEW' NOT NULL,
	"review_token" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"x_tweet_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "x_post_queue_trade_id_unique" UNIQUE("trade_id"),
	CONSTRAINT "x_post_queue_review_token_unique" UNIQUE("review_token")
);
--> statement-breakpoint
ALTER TABLE "market_mappings" ADD CONSTRAINT "market_mappings_market_match_id_market_matches_id_fk" FOREIGN KEY ("market_match_id") REFERENCES "public"."market_matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_matches" ADD CONSTRAINT "market_matches_normalized_id_markets_normalized_id_fk" FOREIGN KEY ("normalized_id") REFERENCES "public"."markets_normalized"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets_normalized" ADD CONSTRAINT "markets_normalized_raw_id_markets_raw_id_fk" FOREIGN KEY ("raw_id") REFERENCES "public"."markets_raw"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "true_probabilities" ADD CONSTRAINT "true_probabilities_mapping_id_market_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."market_mappings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_post_queue" ADD CONSTRAINT "x_post_queue_wallet_address_whale_registry_wallet_address_fk" FOREIGN KEY ("wallet_address") REFERENCES "public"."whale_registry"("wallet_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ev_snapshots_polymarket_created_idx" ON "ev_snapshots" USING btree ("polymarket_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "market_mappings_kalshi_ticker_idx" ON "market_mappings" USING btree ("kalshi_ticker");--> statement-breakpoint
CREATE INDEX "market_mappings_confidence_idx" ON "market_mappings" USING btree ("confidence_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "market_mappings_expires_at_idx" ON "market_mappings" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "market_matches_polymarket_id_idx" ON "market_matches" USING btree ("polymarket_id");--> statement-breakpoint
CREATE INDEX "market_matches_expires_at_idx" ON "market_matches" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "markets_normalized_embedding_hnsw_idx" ON "markets_normalized" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "markets_raw_tier1_platform_ingested_idx" ON "markets_raw" USING btree ("platform","ingested_at" DESC NULLS LAST) WHERE "markets_raw"."tier" = 1;--> statement-breakpoint
CREATE INDEX "sync_runs_scope_started_idx" ON "sync_runs" USING btree ("scope","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_runs_status_idx" ON "sync_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trader_ev_analytics_wallet_updated_idx" ON "trader_ev_analytics" USING btree ("wallet","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trader_ev_analytics_average_ev_idx" ON "trader_ev_analytics" USING btree ("average_ev" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "true_probabilities_pm_token_calculated_idx" ON "true_probabilities" USING btree ("polymarket_token_id","calculated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "true_probabilities_mapping_calculated_idx" ON "true_probabilities" USING btree ("mapping_id","calculated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "x_post_log_trade_id_created_idx" ON "x_post_log" USING btree ("trade_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "x_post_log_gate_passed_created_idx" ON "x_post_log" USING btree ("gate_passed","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "x_post_queue_status_scheduled_idx" ON "x_post_queue" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "x_post_queue_wallet_created_idx" ON "x_post_queue" USING btree ("wallet_address","created_at" DESC NULLS LAST);