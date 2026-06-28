-- Phase 2: EV pipeline — market_mappings, true_probabilities, trader_ev_analytics
-- Depends on 0001_crossmarket_init (market_matches FK).

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
	"verified_at" timestamptz,
	"expires_at" timestamptz,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "market_mappings_pm_token_kalshi_unique" UNIQUE("polymarket_token_id","kalshi_ticker"),
	CONSTRAINT "market_mappings_orientation_check" CHECK ("orientation" IN ('same', 'inverted')),
	CONSTRAINT "market_mappings_match_method_check" CHECK ("match_method" IN ('deterministic', 'string', 'vector', 'llm', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "market_mappings" ADD CONSTRAINT "market_mappings_market_match_id_market_matches_id_fk" FOREIGN KEY ("market_match_id") REFERENCES "public"."market_matches"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "market_mappings_kalshi_ticker_idx" ON "market_mappings" USING btree ("kalshi_ticker");
--> statement-breakpoint
CREATE INDEX "market_mappings_confidence_idx" ON "market_mappings" USING btree ("confidence_score" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "market_mappings_expires_at_idx" ON "market_mappings" USING btree ("expires_at");
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
	"calculated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "true_probabilities_source_type_check" CHECK ("source_type" IN ('ensemble', 'llm', 'cross_market', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "true_probabilities" ADD CONSTRAINT "true_probabilities_mapping_id_market_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."market_mappings"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "true_probabilities_pm_token_calculated_idx" ON "true_probabilities" USING btree ("polymarket_token_id","calculated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "true_probabilities_mapping_calculated_idx" ON "true_probabilities" USING btree ("mapping_id","calculated_at" DESC NULLS LAST);
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
	"calculated_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "trader_ev_analytics_wallet_platform_period_unique" UNIQUE("wallet","platform","period"),
	CONSTRAINT "trader_ev_analytics_platform_check" CHECK ("platform" IN ('polymarket', 'kalshi', 'all')),
	CONSTRAINT "trader_ev_analytics_period_check" CHECK ("period" IN ('live', 'daily', 'all_time'))
);
--> statement-breakpoint
CREATE INDEX "trader_ev_analytics_wallet_updated_idx" ON "trader_ev_analytics" USING btree ("wallet","updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "trader_ev_analytics_average_ev_idx" ON "trader_ev_analytics" USING btree ("average_ev" DESC NULLS LAST);
