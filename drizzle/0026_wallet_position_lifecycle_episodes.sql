ALTER TABLE "wallet_position_lifecycles"
  ADD COLUMN IF NOT EXISTS "lifecycle_episode" integer DEFAULT 0 NOT NULL;

ALTER TABLE "wallet_position_lifecycles"
  DROP CONSTRAINT IF EXISTS "wallet_position_lifecycles_position_version_unique";

ALTER TABLE "wallet_position_lifecycles"
  ADD CONSTRAINT "wallet_position_lifecycles_position_version_unique"
  UNIQUE ("wallet_address", "condition_id", "asset_id", "metric_version", "lifecycle_episode");
