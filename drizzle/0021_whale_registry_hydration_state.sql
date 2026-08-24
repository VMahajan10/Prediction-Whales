ALTER TABLE "whale_registry"
  ADD COLUMN IF NOT EXISTS "hydration_status" text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "hydrated_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "last_hydration_attempt_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "hydration_error" text;

--> statement-breakpoint
-- Rows with computed resolved-bet history were hydrated via the X-agent path.
-- All-default shell rows and enqueue stake hints (resolved_bets_count = 0) stay pending.
UPDATE "whale_registry"
SET
  "hydration_status" = 'complete',
  "hydrated_at" = COALESCE("updated_at", "created_at")
WHERE "hydration_status" = 'pending'
  AND "resolved_bets_count" > 0;
