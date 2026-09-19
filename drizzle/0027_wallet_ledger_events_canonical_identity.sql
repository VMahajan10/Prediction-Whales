-- Canonical-v2 chain log identity (do not mutate legacy dedupe_key).
-- Apply only after canonical-v2 cold/resume gate passes.

ALTER TABLE "wallet_ledger_events"
  ADD COLUMN IF NOT EXISTS "canonical_identity" text;

CREATE INDEX IF NOT EXISTS "wallet_ledger_events_wallet_canonical_idx"
  ON "wallet_ledger_events" ("wallet_address", "canonical_identity")
  WHERE "canonical_identity" IS NOT NULL;

-- Wallet-scoped partial unique (migration 0029); never global canonical_identity unique.
