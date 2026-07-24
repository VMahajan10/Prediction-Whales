-- X Detection Engine: whale_registry, x_post_queue, x_post_log

CREATE TABLE "whale_registry" (
	"wallet_address" text PRIMARY KEY NOT NULL,
	"pseudonym" text NOT NULL,
	"resolved_bets_count" integer DEFAULT 0 NOT NULL,
	"avg_ev" real DEFAULT 0 NOT NULL,
	"win_rate" real DEFAULT 0 NOT NULL,
	"avg_stake_notional" real DEFAULT 0 NOT NULL,
	"posted_count_30d" integer DEFAULT 0 NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_post_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"trade_id" text NOT NULL,
	"template_family" text NOT NULL,
	"copy_text" text NOT NULL,
	"market_slug" text NOT NULL,
	"side" text NOT NULL,
	"entry_cents" real NOT NULL,
	"now_cents" real NOT NULL,
	"stake_notional" real NOT NULL,
	"status" text DEFAULT 'PENDING_REVIEW' NOT NULL,
	"review_token" text NOT NULL,
	"scheduled_for" timestamptz,
	"dispatched_at" timestamptz,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "x_post_queue_trade_id_unique" UNIQUE("trade_id"),
	CONSTRAINT "x_post_queue_review_token_unique" UNIQUE("review_token"),
	CONSTRAINT "x_post_queue_status_check" CHECK ("status" IN ('PENDING_REVIEW', 'APPROVED', 'EDITED', 'KILLED', 'DISPATCHED', 'EXPIRED'))
);
--> statement-breakpoint
ALTER TABLE "x_post_queue" ADD CONSTRAINT "x_post_queue_wallet_address_whale_registry_wallet_address_fk" FOREIGN KEY ("wallet_address") REFERENCES "public"."whale_registry"("wallet_address") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "x_post_queue_status_scheduled_idx" ON "x_post_queue" USING btree ("status","scheduled_for");
--> statement-breakpoint
CREATE INDEX "x_post_queue_wallet_created_idx" ON "x_post_queue" USING btree ("wallet_address","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE TABLE "x_post_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trade_id" text NOT NULL,
	"gate_passed" boolean NOT NULL,
	"rejection_reason" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "x_post_log_trade_id_created_idx" ON "x_post_log" USING btree ("trade_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "x_post_log_gate_passed_created_idx" ON "x_post_log" USING btree ("gate_passed","created_at" DESC NULLS LAST);
