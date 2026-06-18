-- Cross-Market EV initial schema (Phase 1)
-- Requires Neon Postgres with pgvector enabled.
-- Run via drizzle-kit migrate in CI — never at request time.

CREATE EXTENSION IF NOT EXISTS vector;
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
	"ingested_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "markets_raw_platform_external_id_unique" UNIQUE("platform","external_id")
);
--> statement-breakpoint
CREATE INDEX "markets_raw_tier1_platform_ingested_idx" ON "markets_raw" USING btree ("platform","ingested_at" DESC NULLS LAST) WHERE tier = 1;
--> statement-breakpoint
CREATE TABLE "markets_normalized" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"raw_id" bigint NOT NULL,
	"canonical_title" text NOT NULL,
	"entities" text[] DEFAULT '{}'::text[] NOT NULL,
	"resolution_kind" text,
	"norm_method" text NOT NULL,
	"embedding" vector(1536),
	"normalized_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "markets_normalized" ADD CONSTRAINT "markets_normalized_raw_id_markets_raw_id_fk" FOREIGN KEY ("raw_id") REFERENCES "public"."markets_raw"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "markets_normalized_embedding_hnsw_idx" ON "markets_normalized" USING hnsw ("embedding" vector_cosine_ops);
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
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"expires_at" timestamptz,
	CONSTRAINT "market_matches_polymarket_normalized_unique" UNIQUE("polymarket_id","normalized_id"),
	CONSTRAINT "market_matches_orientation_check" CHECK ("orientation" IN ('same', 'inverted'))
);
--> statement-breakpoint
ALTER TABLE "market_matches" ADD CONSTRAINT "market_matches_normalized_id_markets_normalized_id_fk" FOREIGN KEY ("normalized_id") REFERENCES "public"."markets_normalized"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "market_matches_polymarket_id_idx" ON "market_matches" USING btree ("polymarket_id");
--> statement-breakpoint
CREATE INDEX "market_matches_expires_at_idx" ON "market_matches" USING btree ("expires_at");
--> statement-breakpoint
-- ev_snapshots: no FK to market_matches / markets_normalized — polymarket_id
-- text only, so historical EV survives underlying match/normalized row deletes.
CREATE TABLE "ev_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"polymarket_id" text NOT NULL,
	"polymarket_prob" numeric NOT NULL,
	"consensus_prob" numeric NOT NULL,
	"gap" numeric NOT NULL,
	"signal" text NOT NULL,
	"contributors" jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ev_snapshots_polymarket_created_idx" ON "ev_snapshots" USING btree ("polymarket_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"started_at" timestamptz DEFAULT now() NOT NULL,
	"finished_at" timestamptz,
	"status" text NOT NULL,
	"counts" jsonb,
	"error" text,
	"per_platform" jsonb,
	CONSTRAINT "sync_runs_scope_check" CHECK ("scope" IN ('tier1', 'matches', 'all')),
	CONSTRAINT "sync_runs_status_check" CHECK ("status" IN ('running', 'ok', 'error'))
);
--> statement-breakpoint
CREATE INDEX "sync_runs_scope_started_idx" ON "sync_runs" USING btree ("scope","started_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "sync_runs_status_idx" ON "sync_runs" USING btree ("status");
